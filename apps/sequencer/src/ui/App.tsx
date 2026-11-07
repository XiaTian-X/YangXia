// 养夏 · 跟练编排器：导入课程 → 预览、跟练 → 导出 WAV / SRT / 视频 → 练完导出练习记录。
import {
  buildTimeline, DEFAULT_SETTINGS, itemSpec, settingsOf, validateCourse,
  type Course, type Issue, type PlaybackSettings, type TimelineEvent,
} from "@yangxia/course-core";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import sample from "../../../../contracts/fixtures/courses/ok-a18-home-w1-a.json";
import { LivePlayer } from "../audio/live.ts";
import { decodeAndResampleTo44100 } from "../audio/sounds.ts";
import { VoiceBank } from "../audio/voice-bank.ts";
import { download, exportName, exportSrt, exportWav, exportWebm, sessionRecord, type Feeling } from "../export/exporters.ts";
import { applyEvent, drawHud, HUD_HEIGHT, HUD_WIDTH, initialHud, stepHud } from "../hud/draw.ts";
import { Editor } from "./Editor.tsx";
import { Library, type Scheme } from "./Library.tsx";
import { Recorder } from "./Recorder.tsx";
import { Settings } from "./Settings.tsx";

type Tab = "course" | "sound" | "screen" | "library" | "voice";
/** 本地日期 YYYY-MM-DD（toISOString 是 UTC，北京时间凌晨会差一天）。 */
const localDate = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const mmss = (s: number) => `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(Math.round(s % 60)).padStart(2, "0")}`;

export function App() {
  const [course, setCourse] = useState<Course | null>(null);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [edited, setEdited] = useState(false);
  const [settings, setSettings] = useState<PlaybackSettings>(DEFAULT_SETTINGS);
  const [tab, setTab] = useState<Tab>("course");
  const [ttsVoice, setTtsVoice] = useState<string | null>(null);
  const [music, setMusic] = useState<{ name: string; buffer: AudioBuffer } | null>(null);
  const [voiceVersion, setVoiceVersion] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [activeStage, setActiveStage] = useState<string | null>(null);
  const [playingItem, setPlayingItem] = useState(-1);
  const [busy, setBusy] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [notice, setNotice] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const [session, setSession] = useState<{ startedAt: Date; endedAt: Date; completed: boolean; maxIdx: number } | null>(null);

  const canvas = useRef<HTMLCanvasElement>(null);
  const hud = useRef(initialHud());
  const player = useRef<LivePlayer | null>(null);
  const curIdx = useRef(-1);
  const maxIdx = useRef(-1);
  const startedAt = useRef(new Date());
  const abort = useRef<AbortController | null>(null);

  const bank = useMemo(() => new VoiceBank(settings.voiceTimbre, settings.bpm), [settings.voiceTimbre, settings.bpm]);
  const timeline = useMemo(
    () => (course ? buildTimeline(course, { settings, voiceDuration: bank.seconds }) : null),
    [course, settings, bank, voiceVersion],
  );
  const input = () => ({ timeline: timeline!, settings, bank, music: music?.buffer ?? null });

  useEffect(() => {
    hud.current.bgMode = settings.background;
    hud.current.layoutMode = settings.layout;
  }, [settings.background, settings.layout]);

  // 画面：每帧平滑一次再画
  useEffect(() => {
    let raf = 0;
    const frame = () => {
      const ctx = canvas.current?.getContext("2d");
      if (ctx) {
        const p = player.current;
        const events = timeline?.events ?? [];
        if (p?.running && curIdx.current >= 0) stepHud(hud.current, events[curIdx.current], events[curIdx.current + 1], p.elapsed());
        else stepHud(hud.current);
        drawHud(ctx, hud.current);
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [timeline]);

  const load = (raw: unknown, from: string) => {
    const { course: c, issues: is } = validateCourse(raw);
    setIssues(is);
    if (!c) {
      setNotice(`${from}不是合格的课程，见下面的错误。`);
      return;
    }
    void stop();
    setCourse(c);
    setSettings(settingsOf(c));
    setEdited(false);
    setSession(null);
    setNotice(`已载入：${c.name}`);
    const h = hud.current;
    h.tagText = c.name;
    h.repText = "READY";
    h.phaseText = "点\"开始跟练\"，或导出音频、字幕、视频";
  };

  const readFile = async (f: File) => {
    try {
      load(JSON.parse(await f.text()), `「${f.name}」`);
    } catch {
      setNotice(`「${f.name}」不是 JSON 文件。`);
    }
  };

  const stop = async () => {
    if (player.current?.running) await player.current.stop(false);
  };

  const start = async () => {
    if (!timeline || !course) return;
    await stop();
    curIdx.current = -1;
    maxIdx.current = -1;
    startedAt.current = new Date();
    setSession(null);
    const p = new LivePlayer(input(), {
      onEvent: (ev: TimelineEvent, i: number) => {
        curIdx.current = i;
        maxIdx.current = Math.max(maxIdx.current, i);
        applyEvent(hud.current, ev);
        hud.current.voiceText = settings.voiceBake && ev.voice ? ev.voice : "";
        setActiveStage(ev.phaseGroup);
        setPlayingItem(ev.itemIndex);
      },
      onEnd: (completed) => {
        setPlaying(false);
        setPlayingItem(-1);
        setSession({ startedAt: startedAt.current, endedAt: new Date(), completed, maxIdx: maxIdx.current });
        hud.current.repText = completed ? "完成" : "已停止";
        hud.current.phaseText = completed ? "整套课程完成了，填一下下面的练习记录" : "已停止，可以继续调整或重新开始";
      },
    }, ttsVoice);
    player.current = p;
    setPlaying(true);
    await p.start();
  };

  const runExport = async (kind: "wav" | "srt" | "webm") => {
    if (!timeline || !course) return;
    await stop();
    setBusy(kind);
    setProgress(0);
    try {
      if (kind === "srt") download(exportSrt(timeline), exportName(course, "srt"));
      else if (kind === "wav") download(await exportWav(input()), exportName(course, "wav"));
      else {
        abort.current = new AbortController();
        const bgMode = settings.background === "dark" ? "magenta" : settings.background;
        const blob = await exportWebm(input(), { hud: { bgMode, layoutMode: settings.layout }, signal: abort.current.signal,
          onProgress: (stage, pct) => setProgress(stage === "audio" ? 2 : pct) });
        download(blob, exportName(course, "webm"));
      }
      setNotice(`已导出 ${kind.toUpperCase()}`);
    } catch (e) {
      setNotice((e as Error).name === "AbortError" ? "已取消导出" : `导出失败：${(e as Error).message}`);
    } finally {
      setBusy(null);
      abort.current = null;
    }
  };

  const onMusicFile = async (f: File | null) => {
    if (!f) return setMusic(null);
    try {
      setMusic({ name: f.name, buffer: await decodeAndResampleTo44100(await f.arrayBuffer()) });
    } catch {
      setNotice("这个音频文件解不开，换一个 MP3 或 WAV 试试。");
    }
  };

  // 跟练时跳段：上一段 / 下一段（原版的"上一段""跳过"按钮和 ← → 快捷键）
  const stageRef = useRef<string | null>(null);
  stageRef.current = activeStage;
  const jumpRel = (d: number) => {
    if (!timeline || !player.current?.running) return;
    const i = timeline.stages.findIndex((st) => st.id === stageRef.current);
    const j = Math.min(timeline.stages.length - 1, Math.max(0, i + d));
    player.current.jumpTo(timeline.stages[j].id);
  };
  const keys = useRef({ start, stop, jumpRel, playing });
  keys.current = { start, stop, jumpRel, playing };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName ?? "";
      if (["INPUT", "TEXTAREA", "SELECT"].includes(tag)) return;
      const k = keys.current;
      if (e.code === "Space") {
        e.preventDefault();
        void (k.playing ? k.stop() : k.start());
      } else if (e.code === "ArrowRight" && k.playing) {
        e.preventDefault();
        k.jumpRel(1);
      } else if (e.code === "ArrowLeft" && k.playing) {
        e.preventDefault();
        k.jumpRel(-1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const previewStage = (id: string) => {
    if (player.current?.running) return player.current.jumpTo(id);
    const ev = timeline?.events.find((e) => e.phaseGroup === id);
    if (ev) {
      applyEvent(hud.current, ev);
      hud.current.phaseText = `预览：${ev.label}`;
      setActiveStage(id);
    }
  };

  const totalItems = course ? course.blocks.reduce((n, b) => n + b.items.length, 0) : 0;
  return (
    <div class="shell" onDragOver={(e) => { e.preventDefault(); setDragOver(true); }} onDragLeave={() => setDragOver(false)}
      onDrop={(e) => { e.preventDefault(); setDragOver(false); const f = e.dataTransfer?.files[0]; if (f) void readFile(f); }}>
      <div class="top">
        <div>
          <h1>养夏 · 跟练编排器</h1>
          <div class="sub">把一天的训练编成带语音报数、呼吸提示的跟练音频、视频和字幕。不是医学建议；练的时候疼、头晕、胸闷，马上停下。</div>
        </div>
        <span class={`status ${playing ? "live" : ""}`}>{playing ? "跟练中" : busy ? `正在导出 ${busy.toUpperCase()}…` : course ? "就绪" : "等待课程"}</span>
      </div>

      <div class="grid">
        <div class="card">
          <canvas class="hud" ref={canvas} width={HUD_WIDTH} height={HUD_HEIGHT} />
          {timeline && (
            <div class="chips" aria-label="路线图">
              {timeline.stages.map((st) => (
                <button key={st.id} class={`chip ${st.isRest ? "rest" : ""} ${activeStage === st.id ? "active" : ""}`}
                  onClick={() => previewStage(st.id)}>{st.label}</button>
              ))}
            </div>
          )}
          <div class="row" style={{ marginTop: 10 }}>
            {playing
              ? <>
                  <button class="btn primary" onClick={() => void stop()}>停止</button>
                  <button class="btn" title="快捷键 ←" onClick={() => jumpRel(-1)}>上一段</button>
                  <button class="btn" title="快捷键 →" onClick={() => jumpRel(1)}>下一段</button>
                </>
              : <button class="btn primary" title="快捷键 空格" disabled={!timeline || !!busy} onClick={() => void start()}>开始跟练</button>}
            <button class="btn" disabled={!timeline || !!busy || playing} onClick={() => void runExport("wav")} data-export="wav">导出音频 WAV</button>
            <button class="btn" disabled={!timeline || !!busy || playing} onClick={() => void runExport("srt")} data-export="srt">导出字幕 SRT</button>
            <button class="btn" disabled={!timeline || !!busy || playing} onClick={() => void runExport("webm")} data-export="webm">导出视频 WebM</button>
            {busy === "webm" && <button class="btn danger" onClick={() => abort.current?.abort()}>取消</button>}
          </div>
          {busy === "webm" && <div class="progress" style={{ marginTop: 8 }}><div style={{ width: `${progress}%` }} /></div>}
          {timeline && course && (
            <p class="note" style={{ marginTop: 10 }}>
              {course.name}：{totalItems} 个动作，总时长约 {mmss(timeline.totalDuration)}
              {course.source.product && `（出自「${course.source.product}」第 ${course.source.week} 周）`}
            </p>
          )}
          {notice && <p class="note" role="status">{notice}</p>}
          {session && course && <SessionForm course={course} timeline={timeline!} session={session} onDone={() => setSession(null)} />}
        </div>

        <div class="card">
          <div class="tabs" role="tablist">
            {([["course", "课程"], ["sound", "声音"], ["screen", "画面"], ["library", "方案库"], ["voice", "录报数声"]] as [Tab, string][]).map(([k, t]) => (
              <button key={k} class={`tab ${tab === k ? "active" : ""}`} onClick={() => setTab(k)}>{t}</button>
            ))}
          </div>
          {tab === "course" && (
            <div>
              <div class={`drop ${dragOver ? "over" : ""}`}>
                把课程 JSON 拖到这里，或者
                <label class="btn small" style={{ marginLeft: 6 }}>选择文件
                  <input type="file" accept=".json,application/json" style={{ display: "none" }} data-input="course"
                    onChange={(e) => { const f = e.currentTarget.files?.[0]; if (f) void readFile(f); }} />
                </label>
                <button class="btn small" style={{ marginLeft: 6 }} onClick={() => load(sample, "样例")}>载入样例课程</button>
              </div>
              <p class="note">课程一般由 agent 从养夏计划模板导出（npm run course -- check 检查过）。在这里改过之后，就不再保证和成品原文一致。</p>
              {edited && <div class="issue warning">已手动修改：和成品原文可能不一致，交给 agent 前请重新检查。</div>}
              {issues.map((i, k) => <div key={k} class={`issue ${i.level}`}>{i.path || "课程"}：{i.message}</div>)}
              {course && (
                <Editor course={course} playingItem={playingItem} onChange={(c) => {
                  const r = validateCourse(c);
                  setIssues(r.issues);
                  setEdited(true);
                  if (r.course) setCourse(r.course);
                }} />
              )}
              {course && <p class="note">{course.blocks.flatMap((b) => b.items.map((it) => `${it.name} ${itemSpec(it, b.kind === "circuit" ? b.rounds : it.sets ?? 1)}`)).join("；")}</p>}
            </div>
          )}
          {(tab === "sound" || tab === "screen") && (
            <Settings section={tab} settings={settings} onChange={setSettings} ttsVoice={ttsVoice} onTtsVoice={setTtsVoice}
              musicName={music?.name ?? null} onMusicFile={(f) => void onMusicFile(f)} />
          )}
          {tab === "library" && (
            <Library course={course} settings={settings}
              onLoad={(s: Scheme) => { load(s.course, `方案「${s.name}」`); setSettings(s.settings); }}
              onExportCourse={() => course && download(new Blob([JSON.stringify({ ...course, presentation: { ...course.presentation, sequencer: settings } }, null, 2) + "\n"],
                { type: "application/json" }), exportName(course, "json"))} />
          )}
          {tab === "voice" && <Recorder bank={bank} onChanged={() => setVoiceVersion((v) => v + 1)} />}
        </div>
      </div>
    </div>
  );
}

function SessionForm({ course, timeline, session, onDone }: {
  course: Course; timeline: NonNullable<ReturnType<typeof buildTimeline>>;
  session: { startedAt: Date; endedAt: Date; completed: boolean; maxIdx: number }; onDone: () => void;
}) {
  const [feeling, setFeeling] = useState<Feeling>("正好");
  const [symptoms, setSymptoms] = useState({ pain: false, dizzy: false, chest: false });
  const [note, setNote] = useState("");
  const setsDone: Record<number, number> = {};
  timeline.events.forEach((e, i) => {
    if (i <= session.maxIdx && e.isSetFinalRep) setsDone[e.itemIndex] = (setsDone[e.itemIndex] ?? 0) + 1;
  });
  const anySymptom = symptoms.pain || symptoms.dizzy || symptoms.chest;
  return (
    <div class="item" style={{ marginTop: 12 }}>
      <b>练习记录</b>
      <p class="note">导出后放进 profiles/&lt;代号&gt;/打卡/，周复盘会读它。记录只保存在你自己的电脑上。</p>
      <div class="row" style={{ marginBottom: 8 }}>
        感觉：{(["轻松", "正好", "吃力"] as Feeling[]).map((f) => (
          <label class="check" key={f} style={{ marginBottom: 0 }}><input type="radio" name="feeling" checked={feeling === f} onChange={() => setFeeling(f)} />{f}</label>
        ))}
      </div>
      <div class="row" style={{ marginBottom: 8 }}>
        {([["pain", "关节疼"], ["dizzy", "头晕、眼前发黑"], ["chest", "胸痛、胸闷、心慌"]] as const).map(([k, t]) => (
          <label class="check" key={k} style={{ marginBottom: 0 }}>
            <input type="checkbox" checked={symptoms[k]} onChange={(e) => setSymptoms({ ...symptoms, [k]: e.currentTarget.checked })} />{t}
          </label>
        ))}
      </div>
      {anySymptom && <div class="issue">有不适：下周先不加量，按计划里"疼了怎么办"处理；胸痛、胸闷、头晕站不稳要尽快就医。</div>}
      <textarea rows={2} maxLength={500} placeholder="备注（可不填）" value={note} onInput={(e) => setNote(e.currentTarget.value)} />
      <div class="row" style={{ marginTop: 8 }}>
        <button class="btn primary" onClick={() => {
          download(sessionRecord(course, { ...session, feeling, symptoms, note, setsDone }),
            `养夏_练习记录_${localDate(session.startedAt)}.json`);
          onDone();
        }}>导出练习记录</button>
        <button class="btn" onClick={onDone}>不记录</button>
      </div>
    </div>
  );
}
