import type { Course, PlaybackSettings } from "./types.ts";

/** 原版编排器的默认值（只把带 Keep 的名字换成了描述性的名字）。 */
export const DEFAULT_SETTINGS: PlaybackSettings = {
  bpm: 60,
  sound: "woodblock",
  preCountdown: true,
  lastThreeBoost: true,
  breath: "coach",
  breathVolume: 65,
  countTiming: "on-rep",
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

export function settingsOf(course: Pick<Course, "presentation">, override: Partial<PlaybackSettings> = {}): PlaybackSettings {
  return { ...DEFAULT_SETTINGS, ...(course.presentation?.sequencer ?? {}), ...override };
}
