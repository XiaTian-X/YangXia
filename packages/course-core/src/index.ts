// 养夏课程核心库：课程格式、节奏、时间轴、字幕、课程检查。零运行时依赖，浏览器、Node、小程序都能用。
export type * from "./types.ts";
export { DEFAULT_SETTINGS, settingsOf } from "./settings.ts";
export { ATOMIC_TOKENS, RECORD_WORDS, TOKEN_SYLLABLES, canSpeak, estimateVoiceSeconds, numberTokens, recordUnits, voiceTokens, type RecordUnits } from "./voice.ts";
export { repBeats, holdBreathText, type Beat } from "./tempo.ts";
export { buildTimeline, itemSpec, type CueType, type Stage, type Timeline, type TimelineEvent, type TimelineOptions } from "./timeline.ts";
export { buildSrt, srtCues, srtTimecode, type SrtCue } from "./srt.ts";
export { courseClips, courseItems, motionAt, MOTIONS_FORMAT, spanAt, usableClip, type FigureFrame, type MotionClip, type MotionNote, type MotionSpan, type MotionsData } from "./figure-motion.ts";
export { barTarget, duckWindows, isPrimaryCue, isSubCue, type DuckWindow } from "./motion.ts";
export { redlineHits, failedRedlineCases, type RedlineRules, type RedlineCase } from "./redlines.ts";
export { validateCourse } from "./validate.ts";
export { checkCourse, numbersBefore, type CheckContext } from "./check.ts";
export { MANIFEST_FORMAT, productCode, type Manifest, type ManifestExercise, type ManifestProduct } from "./manifest.ts";
export { checkNotes, PROFILE_FORMAT, SESSION_FORMAT, validateProfile, validateSession } from "./profile.ts";
export { bedtimeFor, checkProfileWithTemplates, notCoveredItems, screeningFor } from "./intake.ts";
export { checkProgress, checkProgressLog, FEELS, REVIEW_FORMAT, reviewDataName, reviewName, validateProgressShape, validateReview, validateSegments, type SegmentEntry, type SessionFile } from "./progress.ts";
export { allowedLevels, baseTempo, checkPlanCourse, conditionValue, currentSegment, roundOf, dayRows, exportCourse, figureFor, isStartCourse, PLANS_FORMAT, RULES_FORMAT, type ExportInput, type ExportResult, type LadderLevel, type PlanRow, type PlansData, type ProductPlan, type RulesData } from "./plan.ts";
export { buildSession, setsDoneFromPlayed, type Feeling, type ItemNote, type SessionInput, type Symptoms } from "./session.ts";
