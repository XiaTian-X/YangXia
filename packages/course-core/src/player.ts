// 纯移动端播放子集入口（@yangxia/course-core/player）：
// 零 Node 依赖、零 DOM 依赖，打包成单文件 es2020 IIFE（dist/player-runtime.js，挂载全局 YangXiaPlayer）
// 供 Android QuickJS 运行时直接调用，保证与核心库 0 逻辑漂移。
import { courseClips, courseItems, motionAt, spanAt, usableClip, type MotionClip } from "./figure-motion.ts";
import { breathOf, fmtClock, liveFrame, parseStage, segTitle, stageSpan, unitsOf } from "./live-view.ts";
import { buildSession, setsDoneFromPlayed, type SessionInput } from "./session.ts";
import { applyFloor, breathFloor, DEFAULT_SETTINGS, mergeSettings, normalizeSettings, settingsOf } from "./settings.ts";
import { buildTimeline, itemSpec, type Timeline, type TimelineEvent } from "./timeline.ts";
import type { Course, PlaybackSettings } from "./types.ts";
import { validateCourse } from "./validate.ts";
import { canSpeak, estimateVoiceSeconds, voiceTokens } from "./voice.ts";

export interface PlayerTimelineEvent extends TimelineEvent {
  /** 离线兜底语音词元列表（直接来自 voiceTokens，移动端不重写中文数字读法）。 */
  voiceTokens: string[] | null;
}

export interface PlayerTimeline extends Omit<Timeline, "events"> {
  events: PlayerTimelineEvent[];
}

export interface PlayerPlanResult {
  course: Course;
  effectiveSettings: PlaybackSettings;
  floor: "pluck" | null;
  timeline: PlayerTimeline;
  units: ("组" | "轮")[];
}

/**
 * 一次性为移动端计算生效设置、完整时间轴（附带每拍 voiceTokens）与组/轮单位。
 * 优先级：安全下限 > userPatch > 档案偏好(course.coaching.prefs) > 设备偏好(devicePrefs) > 课程 presentation > 默认值。
 */
export function buildPlayerPlan(
  course: Course,
  devicePrefs?: Partial<PlaybackSettings>,
  userPatch?: Partial<PlaybackSettings>,
): PlayerPlanResult {
  const merged: PlaybackSettings = {
    ...DEFAULT_SETTINGS,
    ...normalizeSettings(course.presentation?.sequencer),
    ...normalizeSettings(devicePrefs),
    ...normalizeSettings(course.coaching?.prefs),
    ...normalizeSettings(userPatch),
  };
  const floor = breathFloor(course);
  const effectiveSettings = applyFloor(merged, floor);
  const tl = buildTimeline(course, { settings: effectiveSettings, voiceDuration: estimateVoiceSeconds });
  const events: PlayerTimelineEvent[] = tl.events.map((ev) => ({
    ...ev,
    voiceTokens: ev.voice ? voiceTokens(ev.voice) : null,
  }));
  return {
    course,
    effectiveSettings,
    floor,
    timeline: { ...tl, events },
    units: unitsOf(course),
  };
}

export interface PlayerSessionInput extends Omit<SessionInput, "setsDone" | "startedAt" | "endedAt"> {
  startedAt: Date | string;
  endedAt: Date | string;
}

/** 供 Android QuickJS 一次性生成练习记录 JSON 对象（配合 setsDoneFromPlayed，接受 Date 或 ISO 字符串）。 */
export function buildPlayerSession(
  course: Course,
  tl: Pick<Timeline, "events"> | TimelineEvent[],
  playedIndices: number[],
  input: PlayerSessionInput,
) {
  const events = Array.isArray(tl) ? tl : tl.events;
  const setsDone = setsDoneFromPlayed(events, playedIndices);
  return buildSession(course, {
    ...input,
    startedAt: input.startedAt instanceof Date ? input.startedAt : new Date(input.startedAt),
    endedAt: input.endedAt instanceof Date ? input.endedAt : new Date(input.endedAt),
    setsDone,
  });
}

/** 计算动图浮点进度（0–1），正确按 (frame - ip) / (op - ip) 映射适配 op = frames + 1。 */
export function motionProgress(clip: MotionClip, frame: number): number {
  const lottie = clip.lottie as { ip?: number; op?: number };
  const ip = typeof lottie?.ip === "number" ? lottie.ip : 0;
  const op = typeof lottie?.op === "number" ? lottie.op : clip.frames;
  const span = Math.max(1e-6, op - ip);
  return Math.max(0, Math.min(1, (frame - ip) / span));
}

export {
  applyFloor,
  breathFloor,
  breathOf,
  buildSession,
  buildTimeline,
  canSpeak,
  courseClips,
  courseItems,
  DEFAULT_SETTINGS,
  estimateVoiceSeconds,
  fmtClock,
  itemSpec,
  liveFrame,
  mergeSettings,
  motionAt,
  normalizeSettings,
  parseStage,
  segTitle,
  setsDoneFromPlayed,
  settingsOf,
  spanAt,
  stageSpan,
  unitsOf,
  usableClip,
  validateCourse,
  voiceTokens,
};
