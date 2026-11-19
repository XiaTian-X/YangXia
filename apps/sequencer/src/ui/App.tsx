// 养夏 · 跟练编排器：导入课程 → 预览、跟练 → 导出 WAV / SRT / 视频 → 练完导出练习记录。
import {
  buildTimeline, courseClips, DEFAULT_SETTINGS, FEELS, itemSpec, setsDoneFromPlayed, settingsOf, validateCourse,
  type Course, type Issue, type ItemNote, type MotionClip, type PlaybackSettings, type Timeline, type TimelineEvent,
} from "@yangxia/course-core";
import { notices } from "virtual:yangxia-figures";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import sample from "../../../../contracts/fixtures/courses/ok-a18-home-w1-a.json";
import { LivePlayer } from "../audio/live.ts";
import { decodeAndResampleTo44100 } from "../audio/sounds.ts";
import { VoiceBank } from "../audio/voice-bank.ts";
import { download, exportName, exportSrt, exportWav, exportWebm, sessionRecord, type Feeling } from "../export/exporters.ts";
import { anchorAt, anchorTime, type FigureAnchor } from "../figure/anchor.ts";
import { loadClips } from "../figure/assets.ts";
import { hudFigure } from "../figure/hud.ts";
import { FigurePlayer } from "../figure/player.ts";
import { applyEvent, drawHud, HUD_HEIGHT, HUD_WIDTH, initialHud, stepHud } from "../hud/draw.ts";
import { Editor } from "./Editor.tsx";
import { Library, type Scheme } from "./Library.tsx";
import { Recorder } from "./Recorder.tsx";
import { Settings } from "./Settings.tsx";

type Tab = "course" | "sound" | "screen" | "library" | "voice";
/** 一次跟练：练的是哪份课程（开始时的快照）、开始结束时间、有没有练完、每个动作实际完成了几组（核心库 setsDoneFromPlayed 算）。 */
type Session = { course: Course; edited: boolean; startedAt: Date; endedAt: Date; completed: boolean; setsDone: Record<number, number> };
/** 本地日期 YYYY-MM-DD（toISOString 是 UTC，北京时间凌晨会差一天）。 */
const localDate = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
/** 本地时分 HHMM：一天练两次，文件名也不会重名。 */
const localTime = (d: Date) => `${String(d.getHours()).padStart(2, "0")}${String(d.getMinutes()).padStart(2, "0")}`;
const mmss = (s: number) => `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(Math.round(s % 60)).padStart(2, "0")}`;
const READY_TEXT = "点\"开始跟练\"，或导出音频、字幕、视频";
/** 课程里有没有从训练单导出的动作示意。 */
const hasFigure = (c: Course) => !!c.source.plan && c.blocks.some((b) => b.items.some((i) => i.figure));

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
  const [session, setSession] = useState<Session | null>(null);
  const [clips, setClips] = useState<Record<string, MotionClip>>({});
  // 动图数据解不开（整份没有）和个别片段预载失败分开记：载入新课程只会刷新后一种
  const [unpackIssue, setUnpackIssue] = useState("");
  const [prepareIssue, setPrepareIssue] = useState("");
  const figureIssue = unpackIssue || prepareIssue;

  const canvas = useRef<HTMLCanvasElement>(null);
  const figures = useRef(new FigurePlayer());
  // 跟练用开始时的课程和时间轴（声音也是），中途改设置不会让图和报数错开
  const liveRun = useRef<{ course: Course; timeline: Timeline } | null>(null);
  const figureTime = useRef(0);          // 动作示意这一帧画的是第几秒
  // 没在跟练时图停在哪（预览的那一段、停下或练完的时刻），按段记，时间轴变了也对得上
  const figureAnchor = useRef<FigureAnchor>({ kind: "start" });
  const hud = useRef(initialHud());
  const player = useRef<LivePlayer | null>(null);
  const curIdx = useRef(-1);
  const played = useRef(new Set<number>());   // 这次跟练实际播到的事件（跳过的不算）
  const startedAt = useRef(new Date());
  const abort = useRef<AbortController | null>(null);

  const bank = useMemo(() => new VoiceBank(settings.voiceTimbre, settings.bpm), [settings.voiceTimbre, settings.bpm]);
  const timeline = useMemo(
    () => (course ? buildTimeline(course, { settings, voiceDuration: bank.seconds }) : null),
    [course, settings, bank, voiceVersion],
  );
  const input = () => ({ timeline: timeline!, settings, bank, music: music?.buffer ?? null });
  const spoken = useMemo(() => timeline?.events.map((e) => e.voice) ?? [], [timeline]);   // 录报数声列这节课要说的话
  const figureState = useRef({ course, clips, on: true });
  figureState.current = { course, clips, on: settings.motionFigure !== false };

  // 动作示意：解开内嵌的动图，预载这节课用到的片段。失败只是不显示，不影响跟练和导出
  useEffect(() => {
    loadClips().then(setClips).catch(() => setUnpackIssue("动作示意加载失败：这次不显示动图，跟练和导出不受影响。"));
  }, []);
  useEffect(() => {
    if (!course) return;
    void figures.current.prepare(courseClips(course, clips), clips).then((failed) => {
      setPrepareIssue(failed.length ? "有的动作示意加载失败：这些动作不显示动图，跟练和导出不受影响。" : "");
    });
  }, [course, clips]);

  // 没在跟练时改了课程或设置：预览的那一段还在就刷新文字，没了就回到开头
  useEffect(() => {
    const a = figureAnchor.current;
    if (!timeline || player.current?.running || a.kind !== "stage") return;
    const ev = timeline.events.find((e) => e.phaseGroup === a.stage);
    if (ev && anchorTime(timeline, a) !== null) {
      if (a.preview) {
        applyEvent(hud.current, ev);
        hud.current.phaseText = `预览：${ev.label}`;
      }
      return;
    }
    figureAnchor.current = { kind: "start" };
    setActiveStage(null);
    if (a.preview) {
      hud.current.repText = "READY";
      hud.current.phaseText = READY_TEXT;
    }
  }, [timeline]);

  useEffect(() => {
    hud.current.bgMode = settings.background;
    hud.current.layoutMode = settings.layout;
  }, [settings.background, settings.layout]);

  // e2e：按某一时刻重画一帧，和导出的视频对比
  useEffect(() => {
    if (import.meta.env.MODE !== "e2e") return;
    (window as unknown as { __hudAt?: (t: number) => OffscreenCanvas }).__hudAt = (t) => {
      const c = new OffscreenCanvas(HUD_WIDTH, HUD_HEIGHT);
      const f = figureState.current;
      drawHud(c.getContext("2d") as unknown as CanvasRenderingContext2D, { ...initialHud(), bgMode: "magenta", layoutMode: settings.layout }, HUD_WIDTH, HUD_HEIGHT,
        f.course && timeline ? hudFigure(f.course, timeline, f.clips, figures.current, t) : null);
      return c;
    };
  }, [timeline, settings.layout]);

  // 画面：每帧平滑一次再画
  useEffect(() => {
    let raf = 0;
    const frame = () => {
      const ctx = canvas.current?.getContext("2d");
      if (ctx) {
        const p = player.current;
        const run = p?.running ? liveRun.current : null;
        const tl = run?.timeline ?? timeline;
        const events = tl?.events ?? [];
        figureTime.current = run ? p!.elapsed() : tl ? anchorTime(tl, figureAnchor.current) ?? 0 : 0;
        if (run && curIdx.current >= 0) stepHud(hud.current, events[curIdx.current], events[curIdx.current + 1], figureTime.current);
        else stepHud(hud.current);
        const f = figureState.current;
        const c = run?.course ?? f.course;
        const figure = f.on && c && tl ? hudFigure(c, tl, f.clips, figures.current, figureTime.current) : null;
        drawHud(ctx, hud.current, HUD_WIDTH, HUD_HEIGHT, figure);
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [timeline]);

  const load = (raw: unknown, from: string) => {
    if (player.current?.running) {
      setNotice("跟练中不能换课程：先停止跟练（练习记录按这次练的课程记）。");
      return;
    }
    const { course: c, issues: is } = validateCourse(raw);
    setIssues(is);
    if (!c) {
      setNotice(`${from}不是合格的课程，见下面的错误。`);
      return;
    }
    setCourse(c);
    setSettings(settingsOf(c));
    figureAnchor.current = { kind: "start" };
    setActiveStage(null);
    setEdited(false);
    setSession(null);
    setNotice(`已载入：${c.name}`);
    const h = hud.current;
    h.tagText = c.name;
    h.repText = "READY";
    h.phaseText = READY_TEXT;
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
    const tl = timeline;
    const snapshot = { course, edited };
    await stop();
    curIdx.current = -1;
    played.current = new Set();
    startedAt.current = new Date();
    setSession(null);
    liveRun.current = { course, timeline: tl };
    figureTime.current = 0;
    const p = new LivePlayer(input(), {
      onEvent: (ev: TimelineEvent, i: number) => {
        curIdx.current = i;
        played.current.add(i);
        applyEvent(hud.current, ev);
        hud.current.voiceText = settings.voiceBake && ev.voice ? ev.voice : "";
        setActiveStage(ev.phaseGroup);
        setPlayingItem(ev.itemIndex);
      },
      onEnd: (completed) => {
        liveRun.current = null;
        figureAnchor.current = completed ? { kind: "end" } : anchorAt(tl, figureTime.current);
        setPlaying(false);
        setPlayingItem(-1);
        setSession({ ...snapshot, startedAt: startedAt.current, endedAt: new Date(), completed, setsDone: setsDoneFromPlayed(tl.events, played.current) });
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
    let done = `已导出 ${kind.toUpperCase()}`;
    // 导出用自己的动图播放器：中途换课程、改动作不影响正在导出的视频
    const exportFigures = kind === "webm" && settings.motionFigure !== false ? new FigurePlayer() : null;
    try {
      if (kind === "srt") download(exportSrt(timeline), exportName(course, "srt"));
      else if (kind === "wav") download(await exportWav(input()), exportName(course, "wav"));
      else {
        abort.current = new AbortController();
        const bgMode = settings.background === "dark" ? "magenta" : settings.background;
        // 导出前等动图加载完，视频里不会缺图；加载失败的动作只是不显示
        const failed = exportFigures ? await exportFigures.prepare(courseClips(course, clips), clips, abort.current.signal) : [];
        if (failed.length) done += `（有 ${failed.length} 段动作示意没加载成功，视频里不显示）`;
        else if (exportFigures && unpackIssue && hasFigure(course)) done += "（动作示意没加载成功，视频里不显示）";
        const blob = await exportWebm(input(), { hud: { bgMode, layoutMode: settings.layout }, signal: abort.current.signal,
          figure: exportFigures ? (t) => hudFigure(course, timeline, clips, exportFigures, t) : undefined,
          onProgress: (stage, pct) => setProgress(stage === "audio" ? 2 : pct) });
        download(blob, exportName(course, "webm"));
      }
      setNotice(done);
    } catch (e) {
      setNotice((e as Error).name === "AbortError" ? "已取消导出" : `导出失败：${(e as Error).message}`);
    } finally {
      exportFigures?.dispose();
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
    // 跟练中按开始时的时间轴跳（中途改了倒数，段会多出或少掉）
    const tl = liveRun.current?.timeline;
    if (!tl || !player.current?.running) return;
    const i = tl.stages.findIndex((st) => st.id === stageRef.current);
    const j = Math.min(tl.stages.length - 1, Math.max(0, i + d));
    player.current.jumpTo(tl.stages[j].id);
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
      figureAnchor.current = { kind: "stage", stage: id, offset: 0, preview: true };
      applyEvent(hud.current, ev);
      hud.current.phaseText = `预览：${ev.label}`;
      setActiveStage(id);
    }
  };

  const totalItems = course ? course.blocks.reduce((n, b) => n + b.items.length, 0) : 0;
  // 路线图：跟练中显示开始时的时间轴，和声音、跳段一致
  const routeTl = (playing && liveRun.current?.timeline) || timeline;
  return (
    <div class="shell" onDragOver={(e) => { e.preventDefault(); setDragOver(true); }} onDragLeave={() => setDragOver(false)}
      onDrop={(e) => { e.preventDefault(); setDragOver(false); const f = e.dataTransfer?.files[0]; if (f) void readFile(f); }}>
      <div class="top">
        <div>
          <h1>养夏 · 跟练编排器</h1>
          <div class="sub">把一天的训练编成带语音报数、呼吸提示的跟练音频、视频和字幕。课程按未经专业审核的计划模板生成，不是医学建议；练的时候疼、头晕、胸闷，马上停下。</div>
        </div>
        <span class={`status ${playing ? "live" : ""}`}>{playing ? "跟练中" : busy ? `正在导出 ${busy.toUpperCase()}…` : course ? "就绪" : "等待课程"}</span>
      </div>

      <div class="grid">
        <div class="card">
          <canvas class="hud" ref={canvas} width={HUD_WIDTH} height={HUD_HEIGHT} />
          {routeTl && (
            <div class="chips" aria-label="路线图">
              {routeTl.stages.map((st) => (
                <button key={st.id} data-stage={st.id} class={`chip ${st.isRest ? "rest" : ""} ${activeStage === st.id ? "active" : ""}`}
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
          {figureIssue && <p class="note" role="status" data-figure-issue>{figureIssue}</p>}
          {session && <SessionForm session={session} onDone={() => setSession(null)} />}
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
              {playing && <p class="note">跟练中不能修改课程，先停止。</p>}
              {course && (
                <fieldset disabled={playing} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
                  <Editor course={course} playingItem={playingItem} onChange={(c) => {
                    const r = validateCourse(c);
                    setIssues(r.issues);
                    setEdited(true);
                    if (r.course) setCourse(r.course);
                  }} />
                </fieldset>
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
          {tab === "voice" && <Recorder bank={bank} phrases={spoken} onChanged={() => setVoiceVersion((v) => v + 1)} />}
        </div>
      </div>
      <details class="note" style={{ marginTop: 12 }} data-notices>
        <summary>第三方授权</summary>
        <pre style={{ whiteSpace: "pre-wrap", maxHeight: 320, overflow: "auto" }}>{notices}</pre>
      </details>
    </div>
  );
}

function SessionForm({ session, onDone }: { session: Session; onDone: () => void }) {
  const [feeling, setFeeling] = useState<Feeling>("正好");
  const [symptoms, setSymptoms] = useState({ pain: false, dizzy: false, chest: false });
  const [note, setNote] = useState("");
  const [perItem, setPerItem] = useState<Record<number, ItemNote>>({});
  const anySymptom = symptoms.pain || symptoms.dizzy || symptoms.chest;
  // 动作顺序和时间轴的 itemIndex 一致：按 blocks、items 的先后展开
  const items = session.course.blocks.flatMap((b) => b.items);
  const gym = /健身房/.test(session.course.source.product);
  const set = (i: number, patch: Partial<ItemNote>) => setPerItem({ ...perItem, [i]: { ...perItem[i], ...patch } });
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
      <details style={{ marginBottom: 8 }}>
        <summary>每个动作（可不填）：找级的感受{gym ? "、还能做几下" : ""}、当场退回</summary>
        <p class="note">第 1–2 周找级，照计划原话选这一组的感受，下次训练按它调一级；升级后做不到下限，勾"当场退回"，下次用原来那一级。</p>
        {items.map((it, i) => (
          <div class="row" key={i} data-item={i} style={{ marginBottom: 4, flexWrap: "wrap" }}>
            <span style={{ minWidth: 120 }}>{it.name}</span>
            <select aria-label={`${it.name} 的感受`} value={perItem[i]?.feel ?? ""} onChange={(e) => set(i, { feel: (e.currentTarget.value || undefined) as ItemNote["feel"] })}>
              <option value="">感受（不填）</option>
              {FEELS.map((f) => <option key={f} value={f}>{f}</option>)}
            </select>
            {gym && (
              <input aria-label={`${it.name} 还能做几下`} type="number" min={0} max={30} placeholder="还能做几下" style={{ width: 90 }}
                value={perItem[i]?.spare ?? ""} onInput={(e) => set(i, { spare: e.currentTarget.value === "" ? undefined : Math.max(0, Math.min(30, Math.round(Number(e.currentTarget.value)))) })} />
            )}
            <label class="check" style={{ marginBottom: 0 }}>
              <input type="checkbox" aria-label={`${it.name} 当场退回`} checked={!!perItem[i]?.reverted} onChange={(e) => set(i, { reverted: e.currentTarget.checked })} />当场退回
            </label>
          </div>
        ))}
      </details>
      <textarea rows={2} maxLength={500} placeholder="备注（可不填）" value={note} onInput={(e) => setNote(e.currentTarget.value)} />
      <div class="row" style={{ marginTop: 8 }}>
        <button class="btn primary" onClick={() => {
          download(sessionRecord(session.course, { ...session, feeling, symptoms, note, perItem }),
            `养夏_练习记录_${localDate(session.startedAt)}_${localTime(session.startedAt)}.json`);
          onDone();
        }}>导出练习记录</button>
        <button class="btn" onClick={onDone}>不记录</button>
      </div>
    </div>
  );
}
