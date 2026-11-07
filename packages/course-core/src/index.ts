// 养夏课程核心库：课程格式、节奏、时间轴、字幕、课程检查。零运行时依赖，浏览器、Node、小程序都能用。
export type * from "./types.ts";
export { DEFAULT_SETTINGS, settingsOf } from "./settings.ts";
export { ATOMIC_TOKENS, TOKEN_SYLLABLES, canSpeak, estimateVoiceSeconds, numberTokens, voiceTokens } from "./voice.ts";
export { repBeats, holdBreathText, type Beat } from "./tempo.ts";
export { buildTimeline, itemSpec, type CueType, type Stage, type Timeline, type TimelineEvent, type TimelineOptions } from "./timeline.ts";
export { buildSrt, srtCues, srtTimecode, type SrtCue } from "./srt.ts";
export { barTarget, duckWindows, isPrimaryCue, isSubCue, type DuckWindow } from "./motion.ts";
export { redlineHits, failedRedlineCases, type RedlineRules, type RedlineCase } from "./redlines.ts";
export { validateCourse } from "./validate.ts";
export { checkCourse, numbersBefore, type CheckContext } from "./check.ts";
export { MANIFEST_FORMAT, productCode, type Manifest, type ManifestExercise, type ManifestProduct } from "./manifest.ts";
export { checkNotes, PROFILE_FORMAT, SESSION_FORMAT, validateProfile, validateSession } from "./profile.ts";
