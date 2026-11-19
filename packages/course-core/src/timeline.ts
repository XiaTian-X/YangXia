// 时间轴：课程 → 一串带时间的事件（打点、报数、领呼、字幕、画面文字）。
// 计时规则照原版编排器的 buildTimeline 移植（开头倒数、组间休息、换项、最后三次、计时动作的 4 秒呼吸循环），
// 不读页面，只吃课程数据和播放设置。新增：每侧、循环、按人群的提示语、以秒为单位的节奏。
import type { MotionSpan } from "./figure-motion.ts";
import { settingsOf } from "./settings.ts";
import { repBeats } from "./tempo.ts";
import type { Age, Course, CourseItem, PlaybackSettings } from "./types.ts";
import { estimateVoiceSeconds } from "./voice.ts";

export type CueType = "intro-cue" | "count-321" | "count-go" | "up" | "sub" | "hold" | "rep" | "rest-tick" | "side-switch" | "none";

export interface TimelineEvent {
  time: number;
  beatDur: number;
  bpm: number;
  cueType: CueType;
  style: PlaybackSettings["sound"];
  state: "prep" | "action" | "rest";
  display: string;
  tag: string;
  label: string;
  breathText: string;
  srtText: string | null;
  voice: string | null;
  voiceVolScale: number;
  voiceOffset: number;
  breathPluck: { direction: "inhale" | "exhale"; isRestPhase: boolean } | null;
  isLastThree: boolean;
  isSetFinalRep: boolean;
  isCountJumpBeat: boolean;
  isTimedMode?: boolean;
  timedProgressRatio?: number;
  timedNextRatio?: number;
  dotIdx: number;
  totalDots: number;
  barProgress: number;
  setProgress: number;
  actionBeatIdx?: number;
  phaseGroup: string;
  itemIndex: number;
}

export interface Stage {
  id: string;
  label: string;
  isRest: boolean;
  firstEventIdx: number;
}

export interface Timeline {
  events: TimelineEvent[];
  stages: Stage[];
  totalDuration: number;
  /** 动作示意动图：每段时间显示什么，从 0 秒连到结束，不影响 events。 */
  motion: MotionSpan[];
}

export interface TimelineOptions {
  settings?: Partial<PlaybackSettings>;
  /** 一句语音的真实时长（秒）；编排器传合成波形的长度，不传就估算。 */
  voiceDuration?: (text: string) => number;
}

interface Segment {
  item: CourseItem;
  itemIndex: number;
  set: number;
  setTotal: number;
  circuit: boolean;
  restAfter: number;
}

export function itemSpec(item: CourseItem, setTotal: number): string {
  const side = item.perSide ? "每侧" : "";
  return item.mode === "timed" ? `${setTotal}组×${side}${item.duration}秒` : `${setTotal}组×${side}${item.reps}次`;
}

function segmentsOf(course: Course): { segments: Segment[]; items: CourseItem[] } {
  const items: CourseItem[] = [];
  const segments: Segment[] = [];
  for (const block of course.blocks) {
    if (block.kind === "sets") {
      for (const item of block.items) {
        const itemIndex = items.push(item) - 1;
        const total = item.sets ?? 1;
        for (let s = 1; s <= total; s++) segments.push({ item, itemIndex, set: s, setTotal: total, circuit: false, restAfter: item.rest });
      }
    } else {
      const base = items.length;
      items.push(...block.items);
      for (let r = 1; r <= block.rounds; r++) {
        block.items.forEach((item, k) => {
          const lastOfRound = k === block.items.length - 1;
          const restAfter = lastOfRound && r < block.rounds ? (block.restBetweenRounds ?? item.rest) : item.rest;
          segments.push({ item, itemIndex: base + k, set: r, setTotal: block.rounds, circuit: true, restAfter });
        });
      }
    }
  }
  if (segments.length) segments[segments.length - 1] = { ...segments[segments.length - 1], restAfter: 0 };
  return { segments, items };
}

export function buildTimeline(course: Course, opts: TimelineOptions = {}): Timeline {
  const st = settingsOf(course, opts.settings);
  const voiceDur = opts.voiceDuration ?? estimateVoiceSeconds;
  const age: Age = course.age;
  const { segments, items } = segmentsOf(course);
  const totalItems = items.length;
  const style = st.sound;
  const bpm = st.bpm;
  const beatDur = 60 / bpm;
  const countdownStepDur = Math.max(beatDur, 1.08);
  const bVol = st.breathVolume / 100;
  const unit = (seg: Segment) => (seg.circuit ? "轮" : "组");

  const events: TimelineEvent[] = [];
  const stages: Stage[] = [];
  let t = 0.08;
  let actionBeatCounter = 0;

  const push = (ev: Omit<TimelineEvent, "setProgress" | "style" | "bpm"> & { bpm?: number }) => {
    events.push({ style, bpm, setProgress: 0, ...ev } as TimelineEvent);
  };
  const motion: MotionSpan[] = [];
  const addMotion = (span: MotionSpan) => {
    if (span.end <= span.start) return;
    const last = motion[motion.length - 1];
    if (last?.kind === "phase" && span.kind === "phase" && last.phase === span.phase && last.itemIndex === span.itemIndex && last.end === span.start) last.end = span.end;
    else motion.push(span);
  };

  segments.forEach((seg, segIdx) => {
    const { item, itemIndex } = seg;
    const exName = item.name;
    const exPrefix = totalItems > 1 ? `动作 ${itemIndex + 1}/${totalItems} · ${exName}` : exName;
    const isTimed = item.mode === "timed";
    const duration = item.duration ?? 30;
    const reps = item.reps ?? 1;
    const s = seg.set;
    const total = seg.setTotal;
    const u = unit(seg);
    const isVeryLast = segIdx === segments.length - 1;
    const spec = itemSpec(item, total);

    // ---- 整套课程开头的预备倒计时 ----
    if (segIdx === 0 && st.preCountdown) {
      const group = `ex-${itemIndex}-prep`;
      const prepStart = t;
      stages.push({ id: group, label: "准备", isRest: false, firstEventIdx: events.length });
      push({ time: t, beatDur, cueType: "intro-cue", state: "prep", display: "PREP", tag: `${exPrefix} (第 1/${total} ${u}准备)`,
        label: `即将开始：${exName} (${spec})`, breathText: "🌬️ 自然呼吸", srtText: `【${exPrefix}】调整起始姿势 · 即将开始第 1/${total} ${u} (${spec})`,
        voice: "准备", voiceVolScale: 1, voiceOffset: 0.005, breathPluck: null, isLastThree: false, isSetFinalRep: false,
        isCountJumpBeat: true, dotIdx: 0, totalDots: 4, barProgress: 18, phaseGroup: group, itemIndex });
      t += 1.45;
      ["3", "2", "1"].forEach((num, idx) => {
        push({ time: t, beatDur, cueType: "count-321", state: "prep", display: num, tag: `${exPrefix} (倒计时)`,
          label: "收紧核心，倒计时准备", breathText: idx === 0 ? "🌬️ 吸气准备" : "⚡ 准备开始", srtText: `⏳ ${exName} · 倒计时 ${num}`,
          voice: num, voiceVolScale: 1, voiceOffset: -0.01, breathPluck: null, isLastThree: false, isSetFinalRep: false,
          isCountJumpBeat: true, dotIdx: idx, totalDots: 4, barProgress: (idx + 1) * 25, phaseGroup: group, itemIndex });
        t += countdownStepDur;
      });
      push({ time: t, beatDur, cueType: "count-go", state: "prep", display: "开始", tag: `${exPrefix} (开始)`,
        label: "开始", breathText: "🌬️ 吸气准备", srtText: `▶ ${exName} · 第 1 ${u}开始`, voice: "开始", voiceVolScale: 1, voiceOffset: 0,
        breathPluck: null, isLastThree: false, isSetFinalRep: false, isCountJumpBeat: true, dotIdx: 3, totalDots: 4, barProgress: 100,
        phaseGroup: group, itemIndex });
      t += 0.75;
      push({ time: t, beatDur, cueType: "none", state: "prep", display: isTimed ? `${duration}s` : `0 / ${reps}`, tag: `${exPrefix} (即将起拍)`,
        label: isTimed ? `马上开始 ${duration} 秒计时` : "马上开始第 1 次", breathText: "💨 准备呼气", srtText: null, voice: null,
        voiceVolScale: 1, voiceOffset: 0, breathPluck: null, isLastThree: false, isSetFinalRep: false, isCountJumpBeat: false,
        dotIdx: 3, totalDots: 4, barProgress: isTimed ? 100 : 0, phaseGroup: group, itemIndex });
      t += 0.85;
      addMotion({ kind: "pose", pose: "start", itemIndex, start: prepStart, end: t, note: "ready" });
    }

    const stageId = `ex-${itemIndex}-set-${s}`;
    stages.push({ id: stageId, label: totalItems > 1 ? `${itemIndex + 1}.${exName.slice(0, 2)}${isTimed ? "⏱" : "S"}${s}` : `第${s}${u}`,
      isRest: false, firstEventIdx: events.length });

    const sides: (string | null)[] = item.perSide ? ["左侧", "右侧"] : [null];
    sides.forEach((side, sideIdx) => {
      const lastSide = sideIdx === sides.length - 1;
      const sideTxt = side ? ` · ${side}` : "";
      const setPrefix = `【${exPrefix} · 第${s}/${total}${u}${sideTxt}】`;
      if (sideIdx > 0) {
        push({ time: t, beatDur, cueType: "side-switch", state: "action", display: side!, tag: `${exPrefix} (换${side})`,
          label: `换${side}，不休息`, breathText: "🌬️ 自然呼吸", srtText: `${setPrefix}换${side}`, voice: null, voiceVolScale: 1, voiceOffset: 0,
          breathPluck: null, isLastThree: false, isSetFinalRep: false, isCountJumpBeat: true, dotIdx: 0, totalDots: 4, barProgress: 100,
          phaseGroup: stageId, itemIndex });
        addMotion({ kind: "pose", pose: "start", itemIndex, start: t, end: t + 2.0, note: "switch-side" });
        t += 2.0;
      }

      if (isTimed) {
        const halfSec = Math.floor(duration / 2);
        const timedStart = t;
        for (let secLeft = duration; secLeft >= 1; secLeft--) {
          const elapsed = duration - secLeft;
          const isLastFive = secLeft <= 5;
          const isLastThree = st.lastThreeBoost && secLeft <= 3;
          const isHalfway = duration >= 16 && secLeft === halfSec && secLeft > 5;
          const nearHalfway = duration >= 16 && Math.abs(secLeft - halfSec) <= 3 && halfSec > 5;
          const isTenMilestone = duration - secLeft >= 4 && secLeft >= 10 && secLeft % 10 === 0 && !isHalfway && !nearHalfway;
          const cueType: CueType = isLastThree ? "count-321" : isHalfway ? "rep" : elapsed === 0 || elapsed % 4 === 0 ? "up" : "sub";
          let mainVoice: string | null = null;
          if (secLeft === duration) mainVoice = `${duration}秒`;
          else if (isHalfway) mainVoice = `${halfSec}秒`;
          else if (isTenMilestone) mainVoice = `${secLeft}秒`;
          else if (isLastFive) mainVoice = `${secLeft}`;
          // 撑住时 4 秒一个呼吸循环：2 秒呼、2 秒吸（成品原文"吸约 2 秒、呼约 2 秒"）
          const cycle = elapsed % 4;
          const dir = cycle === 0 ? "exhale" : cycle === 2 ? "inhale" : "none";
          const breathLabel = cycle < 2 ? "💨 呼气 2 秒" : "🌬️ 吸气 2 秒";
          let breathVoice: string | null = null;
          let pluck: "inhale" | "exhale" | null = null;
          if (st.breath !== "off" && dir !== "none") {
            const spoken = st.breath === "full-voice" || (st.breath === "coach" && elapsed > 0 && elapsed <= 5);
            if (spoken && !mainVoice) breathVoice = dir === "exhale" ? "呼" : "吸";
            else pluck = dir;
          }
          const voice = mainVoice ?? breathVoice;
          let srt: string;
          let label: string;
          if (secLeft === duration) {
            label = `⏱️ 计时开始 · ${exName}${sideTxt} (${secLeft}秒)`;
            srt = `${setPrefix}⏱️ ${duration}秒计时开始 (${breathLabel})`;
          } else if (isHalfway) {
            label = `🔔 已经过半，还剩 ${secLeft} 秒`;
            srt = `${setPrefix}🔔 已经过半，还剩 ${secLeft} 秒 (${breathLabel})`;
          } else if (isLastThree) {
            label = `最后 ${secLeft} 秒`;
            srt = `${setPrefix}最后 ${secLeft} 秒`;
          } else {
            label = `⏱️ ${exName}${sideTxt} · 还剩 ${secLeft} 秒`;
            srt = `${setPrefix}⏱️ ${secLeft}s / ${duration}s · ${breathLabel}`;
          }
          push({ time: t, beatDur: 1, cueType, state: "action", display: isLastThree ? `${secLeft}` : `${secLeft}s`,
            tag: `${exPrefix} (第 ${s}/${total} ${u}${sideTxt} · 计时)`, label, breathText: breathVoice ? `🗣️ 领呼"${breathVoice}"` : breathLabel,
            srtText: srt, voice, voiceVolScale: mainVoice ? 1 : Math.min(0.85, bVol * 0.95), voiceOffset: -0.01,
            breathPluck: pluck ? { direction: pluck, isRestPhase: false } : null, isLastThree, isSetFinalRep: false,
            isCountJumpBeat: secLeft === duration || isHalfway || isTenMilestone || isLastFive, isTimedMode: true,
            timedProgressRatio: secLeft / duration, timedNextRatio: (secLeft - 1) / duration, dotIdx: elapsed % 4, totalDots: 4,
            barProgress: Math.max(5, Math.round((secLeft / duration) * 100)), actionBeatIdx: actionBeatCounter++, phaseGroup: stageId, itemIndex });
          t += 1;
        }
        addMotion({ kind: "timed", itemIndex, start: timedStart, end: t, note: "doing" });
        if (lastSide) {
          const done = isVeryLast ? "全部完成" : "本组完成";
          push({ time: t, beatDur: 1, cueType: "rep", state: "action", display: "0s ✓", tag: `${exPrefix} (第 ${s}/${total} ${u}完成)`,
            label: `🎉 ${exName} ${duration} 秒完成`, breathText: "💨 放松呼气",
            srtText: isVeryLast ? `🏆 全部完成！(${exName} ${duration}秒)` : `🎉 ${exName} · 第 ${s}/${total} ${u} (${duration}秒) 完成`,
            voice: done, voiceVolScale: 1, voiceOffset: -0.01, breathPluck: null, isLastThree: false, isSetFinalRep: true, isCountJumpBeat: true,
            isTimedMode: true, timedProgressRatio: 1, timedNextRatio: 1, dotIdx: 3, totalDots: 4, barProgress: 100,
            actionBeatIdx: actionBeatCounter++, phaseGroup: stageId, itemIndex });
          addMotion({ kind: "pose", pose: "last", itemIndex, start: t, end: t + 1.85, note: "doing" });
          t += 1.85;
        }
      } else {
        const beats = repBeats(item.tempo!, age);
        for (let r = 1; r <= reps; r++) {
          const isLastThree = st.lastThreeBoost && reps - r < 3;
          const isThirdFromLast = st.lastThreeBoost && r === reps - 2;
          const isFinalRep = r === reps;
          const isSetFinalRep = isFinalRep && lastSide;
          beats.forEach((beat, idx) => {
            let mainVoice: string | null = null;
            let display = `${r} / ${reps}`;
            let isCountJumpBeat = false;
            if (st.countTiming === "on-up") {
              if (idx === 0) {
                isCountJumpBeat = true;
                mainVoice = isThirdFromLast ? "最后三次" : `${r}`;
              } else if (beat.type === "rep" && isSetFinalRep) {
                mainVoice = isVeryLast ? "全部完成" : "本组完成";
              }
            } else if (beat.type === "rep") {
              isCountJumpBeat = true;
              if (isSetFinalRep) mainVoice = isVeryLast ? `${r}，全部完成` : `${r}，本组完成`;
              else if (isThirdFromLast) mainVoice = "最后三次";
              else mainVoice = `${r}`;
            } else {
              display = `${r - 1} / ${reps}`;
            }
            let breathVoice: string | null = null;
            let pluck: "inhale" | "exhale" | null = null;
            if (st.breath !== "off" && beat.breath !== "none") {
              const spoken = st.breath === "full-voice" || (st.breath === "coach" && r <= 2);
              if (spoken && !mainVoice && beat.dur >= 0.72) breathVoice = beat.breath === "exhale" ? "呼" : "吸";
              else pluck = beat.breath;
            }
            const voice = mainVoice ?? breathVoice;
            let srt: string;
            if (beat.type === "rep") {
              if (isSetFinalRep) srt = isVeryLast ? `🏆 全部完成！(${exName} ${r}/${reps})` : `🎉 ${exName} · 第 ${s}/${total} ${u}完成 (${r}/${reps})`;
              else if (isFinalRep) srt = `${setPrefix}完成 ${r}/${reps}`;
              else if (isThirdFromLast) srt = `${setPrefix}🔥 最后三次！完成第 ${r}/${reps} 次`;
              else srt = `${setPrefix}🔔 完成第 ${r}/${reps} 次`;
            } else if (beat.type === "hold") {
              srt = `${setPrefix}第 ${r} 次 · ${beat.label} (${beat.breathText})`;
            } else {
              srt = `${setPrefix}第 ${r} 次 · ${beat.label} (${beat.breathText})`;
            }
            push({ time: t, beatDur: beat.dur, cueType: beat.type, state: "action", display, tag: `${exPrefix} (第 ${s}/${total} ${u}${sideTxt})`,
              label: beat.type === "rep" ? `🔔 第 ${r} 次完成` : `${isLastThree ? "🔥 " : ""}第 ${r} 次 · ${beat.label}`,
              breathText: breathVoice ? `🗣️ 领呼"${breathVoice}"` : beat.breathText, srtText: srt, voice,
              voiceVolScale: mainVoice ? 1 : Math.min(0.85, bVol * 0.95), voiceOffset: -0.015,
              breathPluck: pluck ? { direction: pluck, isRestPhase: false } : null, isLastThree, isSetFinalRep, isCountJumpBeat,
              dotIdx: idx, totalDots: beats.length, barProgress: beat.progress, actionBeatIdx: actionBeatCounter++, phaseGroup: stageId, itemIndex });
            const step = beat.type === "rep" && isSetFinalRep ? Math.max(beat.dur, 1.95) : beat.dur;
            addMotion({ kind: "phase", phase: beat.phase, itemIndex, start: t, end: t + beat.dur, note: "doing" });
            // 每组最后一次报完数多等的时间：停在这一次结束的姿势
            addMotion({ kind: "pose", pose: "last", itemIndex, start: t + beat.dur, end: t + step, note: "doing" });
            t += step;
          });
        }
      }
    });

    // ---- 组间 / 换项 / 轮间休息 ----
    const restSeconds = seg.restAfter;
    if (!isVeryLast && restSeconds > 0) {
      const next = segments[segIdx + 1];
      const toNextItem = next.itemIndex !== itemIndex;
      const nextSpec = itemSpec(next.item, next.setTotal);
      const restId = `ex-${itemIndex}-rest-${s}`;
      const restStart = t;
      stages.push({ id: restId, label: toNextItem ? "换项休" : `休${s}`, isRest: true, firstEventIdx: events.length });
      const window = Math.max(0, restSeconds - 3 - 2);
      const maxBreathElapsed = 2 + Math.floor(window / 4) * 4;
      for (let secLeft = restSeconds; secLeft >= 1; secLeft--) {
        const elapsed = restSeconds - secLeft;
        const last3 = secLeft <= 3;
        let mainVoice: string | null = null;
        if (secLeft === restSeconds) mainVoice = `休息 ${restSeconds} 秒`;
        else if (secLeft === 6 && restSeconds >= 10) mainVoice = toNextItem ? "准备下一项" : "准备下一组";
        else if (last3) mainVoice = `${secLeft}`;
        let restVoice: string | null = null;
        let pluck: TimelineEvent["breathPluck"] = null;
        let breathLabel = "🌬️ 均匀呼吸";
        if (elapsed >= 2 && elapsed < maxBreathElapsed) {
          const pos = (elapsed - 2) % 4;
          const inhale = pos < 2;
          breathLabel = inhale ? "🌬️ 深吸气 2 秒" : "💨 慢呼气 2 秒";
          if ((pos === 0 || pos === 2) && st.breath !== "off" && !mainVoice) {
            pluck = { direction: inhale ? "inhale" : "exhale", isRestPhase: true };
            if (st.breath === "coach" || st.breath === "full-voice") restVoice = inhale ? "深吸气" : "慢呼气";
          }
        }
        const voice = mainVoice ?? restVoice;
        const nextNo = next.set;
        let srt = toNextItem ? `⏭ 换项休息 ${secLeft}s · 下一项：${next.item.name} (${nextSpec})` : `☕ ${u === "轮" ? "轮间" : "组间"}休息 ${secLeft}s · ${breathLabel}`;
        if (last3) srt = `⚡ 即将开始：${next.item.name} · 倒计时 ${secLeft}`;
        push({ time: t, beatDur, cueType: last3 ? "count-321" : "rest-tick", state: "rest", display: last3 ? `${secLeft}` : `${secLeft}s`,
          tag: toNextItem ? `⏭ 换项休息 · 下一项：${next.item.name} (${nextSpec})` : `☕ 休息 · 接下来 ${exName} 第 ${nextNo}/${next.setTotal} ${unit(next)}`,
          label: toNextItem ? `⏭ 接下来：${next.item.name} (${secLeft}秒)` : last3 ? `⚡ 准备第 ${nextNo} ${unit(next)}` : `休息 (${secLeft}秒)`,
          breathText: last3 ? "⚡ 准备开始" : breathLabel, srtText: srt, voice, voiceVolScale: mainVoice ? 1 : Math.min(0.88, bVol),
          voiceOffset: -0.01, breathPluck: pluck, isLastThree: false, isSetFinalRep: false, isCountJumpBeat: last3,
          dotIdx: elapsed % 4, totalDots: 4, barProgress: Math.round((secLeft / restSeconds) * 100), phaseGroup: restId, itemIndex });
        t += last3 ? countdownStepDur : 1;
      }
      const nextPrefix = totalItems > 1 ? `动作 ${next.itemIndex + 1}/${totalItems} · ${next.item.name}` : next.item.name;
      const nextTimed = next.item.mode === "timed";
      push({ time: t, beatDur, cueType: "count-go", state: "prep", display: "开始", tag: `${nextPrefix} · 开始`, label: "开始",
        breathText: "🌬️ 吸气准备", srtText: `▶ ${next.item.name} · 开始`, voice: "开始", voiceVolScale: 1, voiceOffset: 0, breathPluck: null,
        isLastThree: false, isSetFinalRep: false, isCountJumpBeat: true, dotIdx: 3, totalDots: 4, barProgress: 100, phaseGroup: restId, itemIndex });
      t += 0.75;
      push({ time: t, beatDur, cueType: "none", state: "prep", display: nextTimed ? `${next.item.duration}s` : `0 / ${next.item.reps}`,
        tag: `${nextPrefix} · 即将起拍`, label: nextTimed ? `马上开始 ${next.item.duration} 秒计时` : `马上开始 ${next.item.name}`,
        breathText: "💨 准备呼气", srtText: null, voice: null, voiceVolScale: 1, voiceOffset: 0, breathPluck: null, isLastThree: false,
        isSetFinalRep: false, isCountJumpBeat: false, dotIdx: 3, totalDots: 4, barProgress: nextTimed ? 100 : 0, phaseGroup: restId, itemIndex });
      t += 0.85;
      addMotion({ kind: "pose", pose: "start", itemIndex: next.itemIndex, start: restStart, end: t, note: toNextItem ? "next-item" : "next-set" });
    }
  });

  let maxEnd = t;
  for (const ev of events) {
    const v = ev.voice ? voiceDur(ev.voice) : 0;
    const end = ev.time + Math.max(v, ev.isSetFinalRep ? 1.25 : 0.35);
    if (end > maxEnd) maxEnd = end;
  }
  const totalDuration = Math.max(t + 1.2, maxEnd + 0.9);
  for (const ev of events) ev.setProgress = Math.min(100, Math.round((ev.time / t) * 100));
  if (motion.length) {
    const first = motion[0];
    if (first.kind === "pose") first.start = 0;
    else if (first.start > 0) motion.unshift({ kind: "pose", pose: "start", itemIndex: first.itemIndex, start: 0, end: first.start, note: "ready" });
    const last = motion[motion.length - 1];
    addMotion({ kind: "pose", pose: "last", itemIndex: last.itemIndex, start: last.end, end: totalDuration, note: "done" });
  }
  return { events, stages, totalDuration, motion };
}
