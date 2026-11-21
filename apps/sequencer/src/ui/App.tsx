// 养夏 · 跟练：导入课程 → 今天的课 → 跟练（全屏，可暂停）→ 练完填练习记录；设置；更多里是导出、编辑、方案库、录报数声。
// 界面照设计画布"养夏跟练界面设计"（v4 阶段 8b）。手机导航在底部，平板在顶部，电脑在左边；跟练页盖住整个屏幕。
import {
  breathFloor, buildTimeline, courseClips, DEFAULT_SETTINGS, mergeSettings, normalizeSettings, setsDoneFromPlayed, settingsOf, validateCourse,
  type Course, type Issue, type MotionClip, type PlaybackSettings, type Timeline, type TimelineEvent,
} from "@yangxia/course-core";
import { notices } from "virtual:yangxia-figures";
import type { JSX } from "preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import sample from "../../../../contracts/fixtures/courses/ok-a18-home-w1-a.json";
import { LivePlayer } from "../audio/live.ts";
import { decodeAndResampleTo44100 } from "../audio/sounds.ts";
import { unlockTts } from "../audio/tts.ts";
import { VoiceBank } from "../audio/voice-bank.ts";
import { download, exportName, exportSrt, exportWav, exportWebm } from "../export/exporters.ts";
import { anchorAt, anchorTime, type FigureAnchor } from "../figure/anchor.ts";
import { loadClips } from "../figure/assets.ts";
import { hudFigure } from "../figure/hud.ts";
import { FigurePlayer } from "../figure/player.ts";
import { applyEvent, drawHud, HUD_HEIGHT, HUD_WIDTH, initialHud, stepHud } from "../hud/draw.ts";
import { KeepAwake } from "../live/keepAwake.ts";
import { liveFrame } from "../live/view.ts";
import { DoneView, type Session } from "./DoneView.tsx";
import { Editor } from "./Editor.tsx";
import { Dots, Gear, Leaf } from "./icons.tsx";
import { Library, type Scheme } from "./Library.tsx";
import { LiveView } from "./LiveView.tsx";
import { MoreView, type MoreSub } from "./MoreView.tsx";
import { loadPrefs, savePrefs } from "./prefs.ts";
import { Recorder } from "./Recorder.tsx";
import { Settings } from "./Settings.tsx";
import { Today } from "./Today.tsx";

type View = "today" | "settings" | "more";
const READY_TEXT = "点\"开始跟练\"，或导出音频、字幕、视频";
/** 课程里有没有从训练单导出的动作示意。 */
const hasFigure = (c: Course) => !!c.source.plan && c.blocks.some((b) => b.items.some((i) => i.figure));
const fullscreenOk = () => typeof document !== "undefined" && !!document.fullscreenEnabled && !!document.documentElement.requestFullscreen;

export function App() {
  const [course, setCourse] = useState<Course | null>(null);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [edited, setEdited] = useState(false);
  // 用户选的设置（没载入课程时：默认值加本机偏好）；实际怎么播还要套这节课的下限，见下面的 eff
  const [settings, setSettings] = useState<PlaybackSettings>(() => ({ ...DEFAULT_SETTINGS, ...loadPrefs() }));
  const [view, setView] = useState<View>("today");
  const [moreSub, setMoreSub] = useState<MoreSub | null>(null);
  const [ttsVoice, setTtsVoice] = useState<string | null>(null);
  const [music, setMusic] = useState<{ name: string; buffer: AudioBuffer } | null>(null);
  const [voiceVersion, setVoiceVersion] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [paused, setPaused] = useState(false);
  const [liveIdx, setLiveIdx] = useState(0);
  const [liveT, setLiveT] = useState(0);
  const [activeStage, setActiveStage] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [notice, setNotice] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const [session, setSession] = useState<Session | null>(null);
  const [clips, setClips] = useState<Record<string, MotionClip>>({});
  const [figuresReady, setFiguresReady] = useState(0);
  // 动图数据解不开（整份没有）和个别片段预载失败分开记：载入新课程只会刷新后一种
  const [unpackIssue, setUnpackIssue] = useState("");
  const [prepareIssue, setPrepareIssue] = useState("");
  const figureIssue = unpackIssue || prepareIssue;

  const canvas = useRef<HTMLCanvasElement>(null);        // 导出页的画面预览（和导出的视频同一套画法）
  const liveCanvas = useRef<HTMLCanvasElement>(null);    // 跟练页的动作示意
  const liveFigureWrap = useRef<HTMLDivElement>(null);
  const liveCaption = useRef<HTMLSpanElement>(null);
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
  const keepAwake = useRef(new KeepAwake());
  const liveStage = useRef<string | null>(null);   // 跟练中现在在哪一段（跳段按它算）
  const wentFullscreen = useRef(false);

  // 实际生效的设置：套上这节课呼吸提示的下限（65 岁以上、高血压或没确认的）
  const eff = useMemo(() => (course ? settingsOf(course, settings) : settings), [course, settings]);
  const bank = useMemo(() => new VoiceBank(eff.voiceTimbre, eff.bpm), [eff.voiceTimbre, eff.bpm]);
  const timeline = useMemo(
    () => (course ? buildTimeline(course, { settings: eff, voiceDuration: bank.seconds }) : null),
    [course, eff, bank, voiceVersion],
  );
  const input = () => ({ timeline: timeline!, settings: eff, bank, music: music?.buffer ?? null });
  const spoken = useMemo(() => timeline?.events.map((e) => e.voice) ?? [], [timeline]);   // 录报数声列这节课要说的话
  const figureState = useRef({ course, clips, on: true });
  figureState.current = { course, clips, on: eff.motionFigure !== false };

  // 动作示意：解开内嵌的动图，预载这节课用到的片段。失败只是不显示，不影响跟练和导出
  useEffect(() => {
    loadClips().then(setClips).catch(() => setUnpackIssue("动作示意加载失败：这次不显示动图，跟练和导出不受影响。"));
  }, []);
  useEffect(() => {
    if (!course) return;
    void figures.current.prepare(courseClips(course, clips), clips).then((failed) => {
      setPrepareIssue(failed.length ? "有的动作示意加载失败：这些动作不显示动图，跟练和导出不受影响。" : "");
      setFiguresReady((n) => n + 1);
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
    hud.current.bgMode = eff.background;
    hud.current.layoutMode = eff.layout;
  }, [eff.background, eff.layout]);

  // e2e：按某一时刻重画一帧，和导出的视频对比
  useEffect(() => {
    if (import.meta.env.MODE !== "e2e") return;
    (window as unknown as { __hudAt?: (t: number) => OffscreenCanvas }).__hudAt = (t) => {
      const c = new OffscreenCanvas(HUD_WIDTH, HUD_HEIGHT);
      const f = figureState.current;
      drawHud(c.getContext("2d") as unknown as CanvasRenderingContext2D, { ...initialHud(), bgMode: "magenta", layoutMode: eff.layout }, HUD_WIDTH, HUD_HEIGHT,
        f.course && timeline ? hudFigure(f.course, timeline, f.clips, figures.current, t) : null);
      return c;
    };
  }, [timeline, eff.layout]);

  // 画面：每帧平滑一次再画。导出页的预览画整个画面；跟练页只画动作示意
  useEffect(() => {
    let raf = 0;
    const frame = () => {
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
      const ctx = canvas.current?.getContext("2d");
      if (ctx) drawHud(ctx, hud.current, HUD_WIDTH, HUD_HEIGHT, figure);
      const lc = liveCanvas.current;
      const lg = run ? lc?.getContext("2d") : null;
      if (lc && lg) {
        lg.clearRect(0, 0, lc.width, lc.height);
        if (figure) {
          // 动图是浅底深线条，跟练页深色：画在一块圆角浅色底上（和视频里的图卡同色）
          const k = Math.min(lc.width / figure.width, lc.height / figure.height);
          const [w, h] = [figure.width * k, figure.height * k];
          const [x, y] = [(lc.width - w) / 2, (lc.height - h) / 2];
          lg.save();
          lg.beginPath();
          if (lg.roundRect) lg.roundRect(x, y, w, h, 28);
          else lg.rect(x, y, w, h);
          lg.clip();
          lg.fillStyle = "#F9FAFB";
          lg.fillRect(x, y, w, h);
          lg.drawImage(figure.image, x, y, w, h);
          lg.restore();
        }
        const wrap = liveFigureWrap.current;
        if (wrap && wrap.dataset.fig !== (figure ? "1" : "0")) wrap.dataset.fig = figure ? "1" : "0";
        const cap = liveCaption.current;
        if (cap && cap.textContent !== (figure?.label ?? "")) cap.textContent = figure?.label ?? "";
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [timeline]);

  // 跟练页的数字、环、进度：每 0.1 秒按课程时间刷新一次（暂停时时间不走，也就不重画）
  useEffect(() => {
    if (!playing) return;
    const id = setInterval(() => {
      const p = player.current;
      if (p?.running) setLiveT(p.elapsed());
    }, 100);
    return () => clearInterval(id);
  }, [playing]);

  /** 载入课程；载入成功返回 true。 */
  const load = (raw: unknown, from: string): boolean => {
    if (player.current?.running) {
      setNotice("跟练中不能换课程：先结束跟练（练习记录按这次练的课程记）。");
      return false;
    }
    const { course: c, issues: is } = validateCourse(raw);
    setIssues(is);
    if (!c) {
      setNotice(`${from}不是合格的课程，见下面的错误。`);
      return false;
    }
    setCourse(c);
    // 默认 ← 课程的 presentation ← 本机偏好 ← 档案里的播放偏好（档案优先于本机，方案第十节第 14 条）；下限在 eff 里套
    setSettings(mergeSettings(c, { ...loadPrefs(), ...normalizeSettings(c.coaching?.prefs) }));
    figureAnchor.current = { kind: "start" };
    setActiveStage(null);
    setEdited(false);
    setSession(null);
    setNotice(`已载入：${c.name}`);
    const h = hud.current;
    h.tagText = c.name;
    h.repText = "READY";
    h.phaseText = READY_TEXT;
    return true;
  };

  const readFile = async (f: File) => {
    try {
      if (load(JSON.parse(await f.text()), `「${f.name}」`)) setView("today");
    } catch {
      setNotice(`「${f.name}」不是 JSON 文件。`);
    }
  };

  const stop = async () => {
    if (player.current?.running) await player.current.stop(false);
  };

  const exitFullscreen = () => {
    if (wentFullscreen.current && document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    wentFullscreen.current = false;
  };

  const start = async () => {
    if (!timeline || !course || busy) return;
    // 在点按钮的这一刻解锁系统语音、屏幕常亮（有的浏览器只在用户操作里放行）
    unlockTts();
    void keepAwake.current.start();
    const tl = timeline;
    const snapshot = { course, edited };
    await stop();
    curIdx.current = -1;
    played.current = new Set();
    startedAt.current = new Date();
    setSession(null);
    liveRun.current = { course, timeline: tl };
    liveStage.current = tl.stages[0]?.id ?? null;
    figureTime.current = 0;
    setLiveIdx(0);
    setLiveT(0);
    setPaused(false);
    const p = new LivePlayer(input(), {
      onEvent: (ev: TimelineEvent, i: number) => {
        curIdx.current = i;
        played.current.add(i);
        applyEvent(hud.current, ev);
        hud.current.voiceText = eff.voiceBake && ev.voice ? ev.voice : "";
        liveStage.current = ev.phaseGroup;
        setActiveStage(ev.phaseGroup);
        setLiveIdx(i);
      },
      onEnd: (completed) => {
        liveRun.current = null;
        figureAnchor.current = completed ? { kind: "end" } : anchorAt(tl, figureTime.current);
        setPlaying(false);
        setPaused(false);
        void keepAwake.current.stop();
        exitFullscreen();
        setSession({ ...snapshot, startedAt: startedAt.current, endedAt: new Date(), completed, setsDone: setsDoneFromPlayed(tl.events, played.current) });
        setView("today");
        hud.current.repText = completed ? "完成" : "已停止";
        hud.current.phaseText = completed ? "整套课程完成了" : "已停止，可以继续调整或重新开始";
      },
    }, ttsVoice);
    player.current = p;
    setPlaying(true);
    await p.start();
  };

  const pause = async (why = "") => {
    const p = player.current;
    if (!p?.running || p.paused) return;
    await p.pause();
    setPaused(true);
    if (why) setNotice(why);
  };
  const resume = async () => {
    const p = player.current;
    if (!p?.running || !p.paused) return;
    await p.resume();
    setPaused(false);
    void keepAwake.current.start();
  };

  // 切到后台（锁屏、切应用）自动暂停：回来以后点"继续"接着练
  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState === "hidden") void pause("切到后台时自动暂停了，点\"继续\"接着练。");
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);

  const toggleFullscreen = () => {
    if (document.fullscreenElement) {
      wentFullscreen.current = false;
      void document.exitFullscreen().catch(() => undefined);
    } else {
      wentFullscreen.current = true;
      void document.documentElement.requestFullscreen().catch(() => { wentFullscreen.current = false; });
    }
  };

  const runExport = async (kind: "wav" | "srt" | "webm") => {
    if (!timeline || !course) return;
    await stop();
    setBusy(kind);
    setProgress(0);
    let done = `已导出 ${kind.toUpperCase()}`;
    // 导出用自己的动图播放器：中途换课程、改动作不影响正在导出的视频
    const exportFigures = kind === "webm" && eff.motionFigure !== false ? new FigurePlayer() : null;
    try {
      if (kind === "srt") download(exportSrt(timeline), exportName(course, "srt"));
      else if (kind === "wav") download(await exportWav(input()), exportName(course, "wav"));
      else {
        abort.current = new AbortController();
        const bgMode = eff.background === "dark" ? "magenta" : eff.background;
        // 导出前等动图加载完，视频里不会缺图；加载失败的动作只是不显示
        const failed = exportFigures ? await exportFigures.prepare(courseClips(course, clips), clips, abort.current.signal) : [];
        if (failed.length) done += `（有 ${failed.length} 段动作示意没加载成功，视频里不显示）`;
        else if (exportFigures && unpackIssue && hasFigure(course)) done += "（动作示意没加载成功，视频里不显示）";
        const blob = await exportWebm(input(), { hud: { bgMode, layoutMode: eff.layout }, signal: abort.current.signal,
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

  // 跟练时跳段：按开始时的时间轴跳（中途改了倒数，段会多出或少掉）。暂停中跳过去，画面先换到那一段
  const jumpTo = (id: string) => {
    const tl = liveRun.current?.timeline;
    const p = player.current;
    if (!tl || !p?.running) return;
    p.jumpTo(id);
    liveStage.current = id;   // 马上记下：连按两次 → 时第二次从这一段算
    const idx = tl.events.findIndex((e) => e.phaseGroup === id);
    if (idx >= 0) {
      setLiveIdx(idx);
      setLiveT(tl.events[idx].time);
      setActiveStage(id);
    }
  };
  const jumpRel = (d: number) => {
    const tl = liveRun.current?.timeline;
    if (!tl || !player.current?.running) return;
    const i = tl.stages.findIndex((st) => st.id === liveStage.current);
    const j = Math.min(tl.stages.length - 1, Math.max(0, i + d));
    jumpTo(tl.stages[j].id);
  };

  const keys = useRef({ start, pause, resume, jumpRel, playing, paused, canStart: false });
  keys.current = { start, pause, resume, jumpRel, playing, paused, canStart: view === "today" && !!timeline && !busy && !session };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (["INPUT", "TEXTAREA", "SELECT"].includes(el?.tagName ?? "") || el?.isContentEditable) return;
      const k = keys.current;
      if (e.code === "Space") {
        if (!k.playing && !k.canStart) return;
        e.preventDefault();
        // 焦点在按钮上时松开空格会再点一次那个按钮：先把焦点拿开
        if (el?.tagName === "BUTTON") el.blur();
        void (k.playing ? (k.paused ? k.resume() : k.pause()) : k.start());
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
    const ev = timeline?.events.find((e) => e.phaseGroup === id);
    if (ev) {
      figureAnchor.current = { kind: "stage", stage: id, offset: 0, preview: true };
      applyEvent(hud.current, ev);
      hud.current.phaseText = `预览：${ev.label}`;
      setActiveStage(id);
    }
  };

  const go = (v: View) => {
    setView(v);
    if (v === "more") setMoreSub(null);
    window.scrollTo({ top: 0 });
  };
  const openMore = (s: MoreSub) => {
    setView("more");
    setMoreSub(s);
    window.scrollTo({ top: 0 });
  };

  const run = liveRun.current;
  const frame = playing && run ? liveFrame(run.course, run.timeline, liveIdx, liveT) : null;

  const exportPanel = course && timeline && (
    <div class="card" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <canvas class="hud" ref={canvas} width={HUD_WIDTH} height={HUD_HEIGHT} aria-label="视频画面预览" />
      <div class="chips" aria-label="点一段看那一段的画面">
        {timeline.stages.map((st) => (
          <button key={st.id} data-stage={st.id} class={`chip ${st.isRest ? "rest" : ""} ${activeStage === st.id ? "active" : ""}`}
            onClick={() => previewStage(st.id)}>{st.label}</button>
        ))}
      </div>
      <div class="export-menu">
        <button class="btn" disabled={!!busy} onClick={() => void runExport("webm")} data-export="webm">导出视频 WebM（带画面和声音）</button>
        <button class="btn" disabled={!!busy} onClick={() => void runExport("wav")} data-export="wav">导出音频 WAV</button>
        <button class="btn" disabled={!!busy} onClick={() => void runExport("srt")} data-export="srt">导出字幕 SRT</button>
      </div>
      {busy === "webm" && (
        <div class="row" style={{ flexWrap: "nowrap" }}>
          <div class="progress" style={{ flex: 1 }}><div style={{ width: `${progress}%` }} /></div>
          <button class="btn small danger" onClick={() => abort.current?.abort()}>取消</button>
        </div>
      )}
      {busy && <p class="note" role="status" style={{ margin: 0 }}>正在导出 {busy.toUpperCase()}…</p>}
      {notice && !busy && <p class="note" role="status" style={{ margin: 0 }}>{notice}</p>}
      <p class="note" style={{ margin: 0 }}>导出的音频、视频用内置语音（系统语音录不进去）。背景、布局、动作示意在"设置 → 视频导出"里改。</p>
    </div>
  );

  const moreContent = (() => {
    switch (moreSub) {
      case "export": return exportPanel;
      case "editor": return course && (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <p class="note" style={{ margin: 0 }}>课程一般由 agent 从养夏计划模板导出（npm run course -- check 检查过）。在这里改过之后，就不再保证和成品原文一致。</p>
          {edited && <p class="issue warning">已手动修改：和成品原文可能不一致，交给 agent 前请重新检查。</p>}
          {issues.map((i, k) => <p key={k} class={`issue ${i.level}`}>{i.path || "课程"}：{i.message}</p>)}
          <Editor course={course} playingItem={-1} onChange={(c) => {
            const r = validateCourse(c);
            setIssues(r.issues);
            setEdited(true);
            if (r.course) setCourse(r.course);
          }} />
        </div>
      );
      case "library": return (
        <div class="card">
          <Library course={course} settings={settings}
            onLoad={(s: Scheme) => {
              // 载入成功才换设置；方案里存的整份设置之上，档案里的播放偏好仍然优先
              if (load(s.course, `方案「${s.name}」`)) {
                setSettings(mergeSettings(s.course, { ...normalizeSettings(s.settings), ...normalizeSettings(s.course.coaching?.prefs) }));
                go("today");
              }
            }}
            onExportCourse={() => course && download(new Blob([JSON.stringify({ ...course, presentation: { ...course.presentation, sequencer: settings } }, null, 2) + "\n"],
              { type: "application/json" }), exportName(course, "json"))} />
        </div>
      );
      case "voice": return <div class="card"><Recorder bank={bank} phrases={spoken} onChanged={() => setVoiceVersion((v) => v + 1)} /></div>;
      case "notices": return (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }} data-notices>
          <p style={{ margin: 0, lineHeight: 1.7 }}>养夏跟练把养夏计划模板导出的一天训练编成带语音报数、呼吸提示的跟练，也能导出音频、视频和字幕。
            计划未经专业审核，不是医学建议，不能替代医生的判断；练的时候疼、头晕、胸闷，马上停下。</p>
          <p class="note" style={{ margin: 0 }}>整个编排器是一个离线文件：不联网、不上传，设置和方案只存在这台设备的浏览器里。</p>
          <h2 class="h2">第三方授权</h2>
          <pre class="notices">{notices}</pre>
        </div>
      );
      default: return null;
    }
  })();

  const navItems: [View, string, (p: { size?: number }) => JSX.Element][] = [["today", "今天", Leaf], ["settings", "设置", Gear], ["more", "更多", Dots]];

  return (
    <div class="app" onDragOver={(e) => { e.preventDefault(); setDragOver(true); }} onDragLeave={() => setDragOver(false)}
      onDrop={(e) => { e.preventDefault(); setDragOver(false); const f = e.dataTransfer?.files[0]; if (f) void readFile(f); }}>
      <nav class="nav" aria-label="主导航">
        <div class="brand"><Leaf size={22} color="var(--accent)" /><span>养夏 · 跟练</span></div>
        {navItems.map(([v, t, Icon]) => (
          <button key={v} class={`nav-btn ${view === v ? "on" : ""}`} aria-current={view === v ? "page" : undefined} data-nav={v} onClick={() => go(v)}>
            <Icon size={22} />{t}
          </button>
        ))}
      </nav>

      <main>
        {view === "today" && (session
          ? <DoneView session={session} onNotice={setNotice} onDone={() => setSession(null)} />
          : <Today course={course} timeline={timeline} clips={clips} figures={figures.current} figuresReady={figuresReady}
              issues={issues} notice={notice} figureIssue={figureIssue} edited={edited} dragOver={dragOver} busy={!!busy}
              onStart={() => void start()} onExport={() => openMore("export")} onReadFile={(f) => void readFile(f)}
              onSample={() => load(sample, "样例")} onLibrary={() => openMore("library")} />)}
        {view === "settings" && (
          <div class="page">
            <h1 class="h1" style={{ fontSize: 30 }}>设置</h1>
            <Settings settings={eff} ttsVoice={ttsVoice} onTtsVoice={setTtsVoice}
              floor={!!course && breathFloor(course) === "pluck"} fromProfile={!!course?.coaching?.prefs}
              onChange={(next) => {
                // 只记这次改了的项（和界面上显示的比），记进本机偏好；实际怎么播再套下限
                const changed = (Object.keys(next) as (keyof PlaybackSettings)[]).filter((k) => next[k] !== eff[k]);
                savePrefs(eff, next);
                setSettings((cur) => ({ ...cur, ...Object.fromEntries(changed.map((k) => [k, next[k]])) }));
              }}
              musicName={music?.name ?? null} onMusicFile={(f) => void onMusicFile(f)} />
          </div>
        )}
        {view === "more" && <MoreView sub={moreSub} onSub={setMoreSub} hasCourse={!!course}>{moreContent}</MoreView>}
      </main>

      {frame && run && (
        <LiveView course={run.course} timeline={run.timeline} frame={frame} elapsed={liveT} paused={paused}
          figureRef={liveCanvas} figureWrapRef={liveFigureWrap} captionRef={liveCaption}
          onPause={() => void pause()} onResume={() => void resume()} onPrev={() => jumpRel(-1)} onNext={() => jumpRel(1)}
          onEnd={() => void stop()} onJump={jumpTo} onFullscreen={fullscreenOk() ? toggleFullscreen : null}
          hasFigure={eff.motionFigure !== false && hasFigure(run.course) && !unpackIssue} />
      )}
    </div>
  );
}
