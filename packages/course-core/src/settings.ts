import type { BreathFloor, Course, PlaybackSettings } from "./types.ts";

/** 默认值：沿用原版编排器（只把带 Keep 的名字换成了描述性的名字），报数改成每次开始时报（v4 阶段 8）。 */
export const DEFAULT_SETTINGS: PlaybackSettings = {
  bpm: 60,
  sound: "woodblock",
  preCountdown: true,
  lastThreeBoost: true,
  // 等于原来的"领呼"：每组前 2 次说"呼、吸"，之后响提示音。"之后安静"由模板规则经 course export 写进课程
  breathLead: 2,
  breathAfter: "pluck",
  breathVolume: 65,
  countTiming: "on-up",
  voiceTimbre: "female",
  voiceEngine: "tts",
  voiceVolume: 92,
  voiceBake: true,
  music: "groove",
  musicVolume: 45,
  duckDepth: 76,
  duckSubBeats: false,
  background: "dark",
  layout: "overlay",
  motionFigure: true,
};

/** 旧的四档呼吸提示（方案库、课程文件里可能还有）对应到两个新设置。 */
export const LEGACY_BREATH: Record<string, Pick<PlaybackSettings, "breathLead" | "breathAfter">> = {
  coach: { breathLead: 2, breathAfter: "pluck" },
  "full-voice": { breathLead: "all", breathAfter: "pluck" },
  pluck: { breathLead: 0, breathAfter: "pluck" },
  off: { breathLead: 0, breathAfter: "quiet" },
};

/** 一份设置（可能带旧的 breath）换成新写法：新设置已经写了的不动。 */
export function normalizeSettings(raw: Partial<PlaybackSettings> & { breath?: unknown } = {}): Partial<PlaybackSettings> {
  const { breath, ...rest } = raw;
  const legacy = typeof breath === "string" ? LEGACY_BREATH[breath] : undefined;
  return legacy ? { ...legacy, ...rest } : rest;
}

/** 这节课呼吸提示的下限：课程写的，或者 65 岁以上的课（旧课程没有 coaching 也照样）。 */
export function breathFloor(course: Pick<Course, "age" | "coaching">): BreathFloor | null {
  return course.coaching?.floor ?? (course.age === "a65" ? "pluck" : null);
}

/** 不低于下限：下限是"提示音"时，"全程"或"之后提示音"都满足，只有"之后安静"不满足。 */
export function applyFloor(st: PlaybackSettings, floor: BreathFloor | null): PlaybackSettings {
  if (floor === "pluck" && st.breathLead !== "all" && st.breathAfter === "quiet") return { ...st, breathAfter: "pluck" };
  return st;
}

/**
 * 这节课实际怎么播：默认 ← 课程的 presentation ← 档案里的播放偏好（coaching.prefs）← override ← 下限。
 * override 是编排器这次的设置；编排器载入课程时把本机偏好放在档案偏好之前（档案优先），见 apps/sequencer。
 */
export function settingsOf(course: Pick<Course, "presentation" | "age" | "coaching">, override: Partial<PlaybackSettings> = {}): PlaybackSettings {
  const st = { ...DEFAULT_SETTINGS, ...normalizeSettings(course.presentation?.sequencer), ...(course.coaching?.prefs ?? {}), ...normalizeSettings(override) };
  return applyFloor(st, breathFloor(course));
}
