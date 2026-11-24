// 跟练页每一刻显示什么：核心实现已迁入 @yangxia/course-core（live-view.ts），这里按名重导出以兼容现有引用。
export {
  breathOf,
  fmtClock,
  itemSpec,
  liveFrame,
  parseStage,
  segTitle,
  stageSpan,
  unitsOf,
  type LiveBreath as Breath,
  type LiveFrame,
  type LiveSeg,
  type StageInfo,
} from "@yangxia/course-core";
