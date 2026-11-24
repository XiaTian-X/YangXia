// 养夏课程核心库：课程格式、节奏、时间轴、字幕、课程检查、规则引擎与跟练显示模型。
// 零运行时依赖，浏览器、Node、QuickJS 都能用。
// 注意：package.ts（含嵌入块字面量）和 node.ts（含 node:fs）严禁从这里导出，均仅从 @yangxia/course-core/node 导出。
export type * from "./types.ts";
export { addDays, DAY_MS, dateInZone, dayNumber, daysBetween, hhmmInZone, isValidTimeZone, resolveTimeZone, YMD_RE } from "./date.ts";
export { applyFloor, breathFloor, DEFAULT_SETTINGS, LEGACY_BREATH, mergeSettings, normalizeSettings, SETTING_CHECKS, settingsOf } from "./settings.ts";
export { ATOMIC_TOKENS, RECORD_WORDS, TOKEN_SYLLABLES, canSpeak, estimateVoiceSeconds, numberTokens, recordUnits, voiceTokens, type RecordUnits } from "./voice.ts";
export { repBeats, holdBreathText, type Beat } from "./tempo.ts";
export { buildTimeline, itemSpec, type CueType, type Stage, type Timeline, type TimelineEvent, type TimelineOptions } from "./timeline.ts";
export { buildSrt, srtCues, srtTimecode, type SrtCue } from "./srt.ts";
export { courseClips, courseItems, motionAt, MOTIONS_FORMAT, spanAt, usableClip, type FigureFrame, type MotionClip, type MotionNote, type MotionSpan, type MotionsData } from "./figure-motion.ts";
export { barTarget, duckWindows, isPrimaryCue, isSubCue, type DuckWindow } from "./motion.ts";
export { redlineHits, failedRedlineCases, type RedlineRules, type RedlineCase } from "./redlines.ts";
export { SOURCE_KEYS, sourceIssues, validateCourse } from "./validate.ts";
export { checkCourse, numbersBefore, type CheckContext } from "./check.ts";
export { MANIFEST_FORMAT, productCode, type Manifest, type ManifestExercise, type ManifestProduct } from "./manifest.ts";
export { checkDeclaration, checkNotes, DECLARATION, PROFILE_FORMAT, SESSION_FORMAT, validateProfile, validateSession, type ValidateProfileOptions } from "./profile.ts";
export { bedtimeFor, checkProfileWithTemplates, notCoveredItems, screeningFor } from "./intake.ts";
export { checkProgress, checkProgressLog, FEELS, localDate, progressOn, REVIEW_FORMAT, reviewDataName, reviewName, trainingDates, validateProgressShape, validateReview, validateSegments, type SegmentEntry, type SessionFile } from "./progress.ts";
export { addOnDefs, addOnsFromLog, allowedLevels, baseTempo, checkPlanCourse, conditionValue, courseIdFor, currentSegment, dayRows, exportCourse, figureFor, habitPassWeeks, isStartCourse, maxWeek, PLANS_FORMAT, planType, progressRow, ROUND_WEEKS, roundOf, roundWeek, RULES_FORMAT, ruleValue, stableParam, startLevel, type AddOnDef, type ExportInput, type ExportResult, type LadderLevel, type PlanRow, type PlansData, type ProductPlan, type RulesData } from "./plan.ts";
export { buildSession, setsDoneFromPlayed, type Feeling, type ItemNote, type SessionInput, type Symptoms } from "./session.ts";
export { ASSESS_FORMAT, ageAt, assessRules, balanceHold, bmiOf, cardioMode, checkAssessments, checkRecord, cycleEnd, doctorEvents, doctorNeed, entryHeight, fallRiskList, gap, KINDS, latestFallRisk, param, productInfo, REASONS, recordConclusion, segmentEnd, validateAssessFields, validateAssessment, type AssessContext, type AssessFile, type AssessRules, type DoctorEvent, type FallRiskEntry, type HabitRule, type NextRule } from "./assess.ts";
export { fallRiskConclusion, fallRiskIssues, fallRiskRules, FRAIL, GENERAL, officialLevel, SELF_ONLY, SEVERITY, SKIPPED, UNTESTED, validateFallRisk, validateOfficial, type FallRiskRules, type Level } from "./fallrisk.ts";
export { bodySheetLines, bodyStateOn, clearValid, cycleGoals, goalCardioHint, goalIssues, goalParam, goalRules, GOALS, goalSheetLines, lastWeighed, severeObese, validateGoalFields, validateGoalRecord, validateGoalReview, weekGoal, type Goal, type GoalRules } from "./goals.ts";
export { activeAddOns, addOnIssues, addOnSheetLines, validateAddFields } from "./senior.ts";
export { buildSheet, checkSheet, progressDate, sheetFile, sheetMark } from "./sheet.ts";
export { breathOf, fmtClock, liveFrame, parseStage, segTitle, stageSpan, unitsOf, type LiveBreath, type LiveFrame, type LiveSeg, type StageInfo } from "./live-view.ts";
export {
  auditProfileBundle,
  buildAssessContext,
  collectArchiveIssues,
  collectCourseIssues,
  collectDocumentIssues,
  collectProgressIssues,
  collectRecordIssues,
  DELIVERY_FORMAT,
  detectInvalidatedCourses,
  diffSessionFields,
  evaluateAssessment,
  exportProfileCourse,
  generateProfileSheet,
  inspectEndSummary,
  normalizeSession,
  preExportErrors,
  prepareSessionImport,
  sameJson,
  SYMPTOM_NAMES,
  type CourseDeliveryEnvelope,
  type ExportProfileCourseInput,
  type ExportProfileCourseResult,
  type InvalidatedCourse,
  type PrepareSessionImportOptions,
  type PrepareSessionImportResult,
  type ProfileBundle,
  type ProfileCourseItem,
  type ProfileDocItem,
  type TemplateBundle,
} from "./engine.ts";
