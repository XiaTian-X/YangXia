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
}

/** 编排器怎么播。默认值见 settings.ts 的 DEFAULT_SETTINGS（沿用原版编排器的默认值）。 */
export interface PlaybackSettings {
  bpm: number;
  sound: "woodblock" | "marimba" | "perc";
  preCountdown: boolean;
  lastThreeBoost: boolean;
  breath: "coach" | "full-voice" | "pluck" | "off";
  breathVolume: number;
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
}

export interface Issue {
  level: "error" | "warning";
  path: string;
  message: string;
}
