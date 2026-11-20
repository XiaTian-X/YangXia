// 养夏课程核心库的类型。课程格式的唯一定义是 contracts/course.schema.json，这里和它保持一致
// （由 test/conformance.test.ts 用同一批样例核对两边判断一致）。

export type Age = "a13" | "a18" | "a40" | "a65";

/** 一次动作的节奏，单位秒。start：从发力（up）开始，还是从下放（down）开始。 */
export interface Tempo {
  start: "up" | "down";
  up: number;
  top?: number;
  down: number;
  bottom?: number;
}

export interface CourseItem {
  exercise: string;
  name: string;
  mode: "reps" | "timed";
  sets?: number;
  reps?: number;
  duration?: number;
  perSide?: boolean;
  tempo?: Tempo;
  rest: number;
  quote: string[];
  /** 动作示意动图的片段号（course export 写，这一级有合适的动图才有；手写课程不用）。 */
  figure?: string;
}

export interface SetsBlock {
  kind: "sets";
  items: CourseItem[];
}

export interface CircuitBlock {
  kind: "circuit";
  rounds: number;
  restBetweenRounds?: number;
  items: CourseItem[];
}

export type Block = SetsBlock | CircuitBlock;

export interface CourseSource {
  product: string;
  templates?: string;
  week: number;
  day?: string;
  /** 由 course export 从训练单导出时写 "yangxia.plans/1"；课程检查按训练单和档案进度逐项核对。 */
  plan?: string;
  /** 第几段（起始期 4 周一段）。 */
  segment?: number;
  /** 段型：标准 / 减量。 */
  type?: string;
  /** 阶段：起始（稳定期在 v4 阶段 3 加）。 */
  phase?: string;
  /** 轮换组这一次做的是哪个：{组名: 动作 ID}。 */
  picks?: Record<string, string>;
  /** 半量课（中断、生病回来的第一次）：组数、轮数减半向上取整，不当加量依据。 */
  half?: true;
}

export interface Course {
  schema: "yangxia.course/1";
  id: string;
  name: string;
  age: Age;
  source: CourseSource;
  blocks: Block[];
  presentation?: { sequencer?: Partial<PlaybackSettings> } & Record<string, unknown>;
  /** 由 course export 写：档案里本人的播放偏好、呼吸提示的下限。不写病情。阶段 9 培训期再加别的项。 */
  coaching?: Coaching;
}

/** 呼吸提示的下限："pluck" = 领完以后至少响提示音（"全程"也算满足）。 */
export type BreathFloor = "pluck";

export interface Coaching {
  floor?: BreathFloor;
  /** 档案里本人的播放偏好（只记选择）；编排器里优先于本机偏好。 */
  prefs?: Partial<Pick<PlaybackSettings, "breathLead" | "breathAfter" | "countTiming">>;
}

/** 编排器怎么播。默认值见 settings.ts 的 DEFAULT_SETTINGS（沿用原版编排器的默认值）。 */
export interface PlaybackSettings {
  bpm: number;
  sound: "woodblock" | "marimba" | "perc";
  preCountdown: boolean;
  lastThreeBoost: boolean;
  /** 每组领几次"呼、吸"：0、1、2……，"all" 是全程。撑住类按开始后的换气点数，组间休息见 timeline.ts。 */
  breathLead: number | "all";
  /** 领完以后：安静，或者在换气的拍响提示音。 */
  breathAfter: "quiet" | "pluck";
  breathVolume: number;
  /** on-up：每次开始时报数（第一拍）；on-rep：每次做完时报数（最后一拍）。 */
  countTiming: "on-rep" | "on-up";
  voiceTimbre: "female" | "male" | "warm";
  voiceEngine: "tts" | "embedded";
  voiceVolume: number;
  voiceBake: boolean;
  music: "groove" | "beat" | "file" | "none";
  musicVolume: number;
  duckDepth: number;
  duckSubBeats: boolean;
  background: "dark" | "green" | "magenta" | "black";
  layout: "overlay" | "center";
  /** 显示动作示意动图（跟练和导出都算）；没写的（旧方案）按开。 */
  motionFigure?: boolean;
}

export interface Issue {
  level: "error" | "warning";
  path: string;
  message: string;
}
