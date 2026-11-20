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

const isInt = (v: unknown, lo: number, hi: number) => Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi;
const oneOf = (...xs: unknown[]) => (v: unknown) => xs.includes(v);
const bool = (v: unknown) => typeof v === "boolean";

/** 每一项能取的值（范围和编排器设置界面一致）。和安全有关的是 breathLead、breathAfter。 */
export const SETTING_CHECKS: Record<keyof PlaybackSettings, (v: unknown) => boolean> = {
  bpm: (v) => isInt(v, 40, 110),
  sound: oneOf("woodblock", "marimba", "perc"),
  preCountdown: bool,
  lastThreeBoost: bool,
  breathLead: (v) => v === "all" || isInt(v, 0, 60),
  breathAfter: oneOf("quiet", "pluck"),
  breathVolume: (v) => isInt(v, 15, 100),
  countTiming: oneOf("on-rep", "on-up"),
  voiceTimbre: oneOf("female", "male", "warm"),
  voiceEngine: oneOf("tts", "embedded"),
  voiceVolume: (v) => isInt(v, 20, 100),
  voiceBake: bool,
  music: oneOf("groove", "beat", "file", "none"),
  musicVolume: (v) => isInt(v, 0, 100),
  duckDepth: (v) => isInt(v, 0, 100),
  duckSubBeats: bool,
  background: oneOf("dark", "green", "magenta", "black"),
  layout: oneOf("overlay", "center"),
  motionFigure: bool,
};
export const SAFETY_SETTINGS = ["breathLead", "breathAfter"] as const;

/** 旧的四档呼吸提示（方案库、课程文件里可能还有）对应到两个新设置。 */
export const LEGACY_BREATH: Record<string, Pick<PlaybackSettings, "breathLead" | "breathAfter">> = {
  coach: { breathLead: 2, breathAfter: "pluck" },
  "full-voice": { breathLead: "all", breathAfter: "pluck" },
  pluck: { breathLead: 0, breathAfter: "pluck" },
  off: { breathLead: 0, breathAfter: "quiet" },
};

/**
 * 一份设置换成新写法、洗干净：旧的 breath 照对应读（新设置已经写了的不动）；
 * 取值不对、不认识的项一律丢掉（编排器按默认值播）。课程、本机偏好、方案库读进来的都走这里。
 */
export function normalizeSettings(raw: unknown = {}): Partial<PlaybackSettings> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  const { breath, ...rest } = raw as Record<string, unknown>;
  const legacy = typeof breath === "string" ? LEGACY_BREATH[breath] : undefined;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries({ ...(legacy ?? {}), ...rest })) {
    const check = SETTING_CHECKS[k as keyof PlaybackSettings];
    if (check?.(v)) out[k] = v;
  }
  return out as Partial<PlaybackSettings>;
}

/** 这节课呼吸提示的下限：课程写的，或者 65 岁以上的课（旧课程没有 coaching 也照样）。 */
export function breathFloor(course: Pick<Course, "age" | "coaching">): BreathFloor | null {
  return course.coaching?.floor ?? (course.age === "a65" ? "pluck" : null);
}

/** 下限要求的最低提示音量（设置界面的最低值）。 */
const FLOOR_BREATH_VOLUME = 15;

/**
 * 不低于下限。下限是"提示音"时：
 * - 领完以后不能安静（"全程"也算满足，领的那几拍有口令）；
 * - 关掉了语音报数，口令说不出来，就改成每个换气的拍都响提示音（领 0 次 + 提示音）；
 * - 提示音量不低于设置界面的最低值。
 */
export function applyFloor(st: PlaybackSettings, floor: BreathFloor | null): PlaybackSettings {
  if (floor !== "pluck") return st;
  const out = { ...st, breathVolume: Math.max(st.breathVolume, FLOOR_BREATH_VOLUME) };
  if (!out.voiceBake) return { ...out, breathLead: 0, breathAfter: "pluck" };
  if (out.breathLead !== "all" && out.breathAfter === "quiet") return { ...out, breathAfter: "pluck" };
  return out;
}

/** 默认 ← 课程的 presentation ← 档案里的播放偏好（coaching.prefs）← override，不套下限。 */
export function mergeSettings(course: Pick<Course, "presentation" | "coaching">, override: unknown = {}): PlaybackSettings {
  return { ...DEFAULT_SETTINGS, ...normalizeSettings(course.presentation?.sequencer), ...normalizeSettings(course.coaching?.prefs), ...normalizeSettings(override) };
}

/**
 * 这节课实际怎么播：mergeSettings 再套下限。
 * override 是编排器这次的设置；编排器载入课程时把本机偏好放在档案偏好之前（档案优先），见 apps/sequencer。
 */
export function settingsOf(course: Pick<Course, "presentation" | "age" | "coaching">, override: unknown = {}): PlaybackSettings {
  return applyFloor(mergeSettings(course, override), breathFloor(course));
}
