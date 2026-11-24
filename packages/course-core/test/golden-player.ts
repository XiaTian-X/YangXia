// 跨端黄金测试集生成器：生成 contracts/fixtures/golden-player.json，
// 供 Node（@yangxia/course-core/player）、纯净 node:vm（dist/player-runtime.js）和 Android（quickjs-kt + Kotlin 帧插值）共用。
// 运行：node packages/course-core/test/golden-player.ts write
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildPlayerPlan,
  buildPlayerSession,
  liveFrame,
  motionAt,
  motionProgress,
  type PlayerPlanResult,
} from "../src/player.ts";
import type { Course, MotionsData, PlaybackSettings } from "../src/index.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
export const GOLDEN_PATH = join(ROOT, "contracts", "fixtures", "golden-player.json");

function loadCourseFixture(name: string): Course {
  return JSON.parse(readFileSync(join(ROOT, "contracts", "fixtures", "courses", name), "utf8")) as Course;
}

function loadMotionFixture(): MotionsData {
  return JSON.parse(readFileSync(join(ROOT, "contracts", "fixtures", "data", "motions.json"), "utf8")) as MotionsData;
}

export interface GoldenFrameSample {
  idx: number;
  t: number;
  frame: ReturnType<typeof liveFrame>;
  motion: { clip: string; frame: number; progress: number; note: string; perSide: boolean; itemIndex: number } | null;
}

export interface GoldenCase {
  id: string;
  description: string;
  course: Course;
  devicePrefs?: Partial<PlaybackSettings>;
  userPatch?: Partial<PlaybackSettings>;
  expected: {
    floor: "pluck" | null;
    effectiveSettings: PlaybackSettings;
    units: ("组" | "轮")[];
    totalDuration: number;
    eventCount: number;
    stageCount: number;
    /** 抽样关键事件（开头、准备、动作、休息、换边、末尾）供跨端逐字段核对。 */
    sampleEvents: { index: number; event: PlayerPlanResult["timeline"]["events"][number] }[];
    frameSamples: GoldenFrameSample[];
    sessionCheck?: {
      playedIndices: number[];
      startedAt: string;
      endedAt: string;
      feeling: "轻松" | "正好" | "吃力";
      symptoms: { pain: boolean; dizzy: boolean; chest: boolean };
      note?: string;
      edited?: boolean;
      expectedSession: Record<string, unknown>;
    };
  };
}

export interface GoldenFixtureFile {
  schema: "yangxia.golden-player/1";
  voiceDurationMode: "estimateVoiceSeconds";
  cases: GoldenCase[];
}

function sampleEventIndices(n: number): number[] {
  if (n <= 0) return [];
  const raw = [0, 1, 2, 3, Math.floor(n * 0.2), Math.floor(n * 0.4), Math.floor(n * 0.5), Math.floor(n * 0.75), n - 3, n - 2, n - 1];
  return [...new Set(raw.filter((i) => i >= 0 && i < n))].sort((a, b) => a - b);
}

function buildCase(
  id: string,
  description: string,
  course: Course,
  clips: MotionsData["clips"],
  opts: {
    devicePrefs?: Partial<PlaybackSettings>;
    userPatch?: Partial<PlaybackSettings>;
    extraSampleIdx?: (plan: PlayerPlanResult) => number[];
    sessionInput?: {
      playedIndices: (plan: PlayerPlanResult) => number[];
      note?: string;
      edited?: boolean;
      feeling?: "轻松" | "正好" | "吃力";
      symptoms?: { pain: boolean; dizzy: boolean; chest: boolean };
    };
  } = {},
): GoldenCase {
  const plan = buildPlayerPlan(course, opts.devicePrefs, opts.userPatch);
  const events = plan.timeline.events;
  const indices = [...new Set([...sampleEventIndices(events.length), ...(opts.extraSampleIdx?.(plan) ?? [])])]
    .filter((i) => i >= 0 && i < events.length)
    .sort((a, b) => a - b);

  const sampleEvents = indices.map((index) => ({ index, event: events[index] }));
  const frameSamples: GoldenFrameSample[] = indices.map((idx) => {
    const ev = events[idx];
    const next = events[idx + 1];
    // 取这一拍中间点（测试倒数平滑进度与动图循环折返）
    const t = next ? Number((ev.time + Math.min(0.45, Math.max(0, (next.time - ev.time) * 0.5))).toFixed(3)) : ev.time;
    const frame = liveFrame(course, plan.timeline, idx, t);
    const m = motionAt(plan.timeline, course, clips, t);
    const clip = m ? clips[m.clip] : undefined;
    const motion = m && clip
      ? {
          clip: m.clip,
          frame: Number(m.frame.toFixed(4)),
          progress: Number(motionProgress(clip, m.frame).toFixed(6)),
          note: m.note,
          perSide: m.perSide,
          itemIndex: m.itemIndex,
        }
      : null;
    return { idx, t, frame, motion };
  });

  let sessionCheck: GoldenCase["expected"]["sessionCheck"];
  if (opts.sessionInput) {
    const playedIndices = opts.sessionInput.playedIndices(plan);
    const startedAt = "2026-11-24T01:00:00.000Z";
    const endedAt = "2026-11-24T01:15:00.000Z";
    const feeling = opts.sessionInput.feeling ?? "正好";
    const symptoms = opts.sessionInput.symptoms ?? { pain: false, dizzy: false, chest: false };
    const expectedSession = buildPlayerSession(course, plan.timeline, playedIndices, {
      startedAt,
      endedAt,
      feeling,
      symptoms,
      note: opts.sessionInput.note,
      edited: opts.sessionInput.edited,
    });
    sessionCheck = {
      playedIndices,
      startedAt,
      endedAt,
      feeling,
      symptoms,
      ...(opts.sessionInput.note !== undefined ? { note: opts.sessionInput.note } : {}),
      ...(opts.sessionInput.edited !== undefined ? { edited: opts.sessionInput.edited } : {}),
      expectedSession,
    };
  }

  return {
    id,
    description,
    course,
    ...(opts.devicePrefs ? { devicePrefs: opts.devicePrefs } : {}),
    ...(opts.userPatch ? { userPatch: opts.userPatch } : {}),
    expected: {
      floor: plan.floor,
      effectiveSettings: plan.effectiveSettings,
      units: plan.units,
      totalDuration: Number(plan.timeline.totalDuration.toFixed(4)),
      eventCount: events.length,
      stageCount: plan.timeline.stages.length,
      sampleEvents,
      frameSamples,
      ...(sessionCheck ? { sessionCheck } : {}),
    },
  };
}

export function buildGoldenFixture(): GoldenFixtureFile {
  const { clips } = loadMotionFixture();
  const homeA = loadCourseFixture("ok-a18-home-w1-a.json");
  const homeCoaching = loadCourseFixture("ok-a18-home-w1-a-coaching.json");
  const circuit = loadCourseFixture("ok-a18-home-w1-d-circuit.json");
  const senior = loadCourseFixture("ok-a65-chair-w1.json");

  // 合成综合边界课程：先下放含停顿 + 动图 wrap(squat) + 静撑(plank) + 连续循环(gym-farmer-walk) + 每侧计时(两侧做完) + 无效 figure(null)
  const motionAndSideCourse: Course = {
    schema: "yangxia.course/1",
    id: "c_golden001",
    name: "黄金边界：动图折返、静撑、循环与每侧计时",
    age: "a18",
    source: { product: "18-39岁-居家版", week: 1, day: "A", plan: "yangxia.plans/1" },
    blocks: [
      {
        kind: "sets",
        items: [
          {
            exercise: "squat",
            name: "徒手深蹲",
            mode: "reps",
            sets: 2,
            reps: 4,
            rest: 20,
            tempo: { start: "down", down: 2, bottom: 1, up: 1, top: 1 },
            quote: ["2 组 × 4 次，下 2 秒停 1 秒起 1 秒停 1 秒，休 20 秒"],
            figure: "squat",
          },
          {
            exercise: "plank",
            name: "平板支撑",
            mode: "timed",
            sets: 1,
            duration: 8,
            rest: 15,
            quote: ["1 组 × 8 秒，休 15 秒"],
            figure: "plank",
          },
          {
            exercise: "side-plank",
            name: "侧平板支撑",
            mode: "timed",
            perSide: true,
            sets: 1,
            duration: 6,
            rest: 15,
            quote: ["每侧 6 秒，休 15 秒"],
            figure: "non-existent-clip-id",
          },
          {
            exercise: "gym-farmer-walk",
            name: "农夫行走",
            mode: "timed",
            sets: 1,
            duration: 6,
            rest: 0,
            quote: ["1 组 × 6 秒"],
            figure: "gym-farmer-walk",
          },
        ],
      },
    ],
  };

  // 先发力动作 + 半量标记
  const upFirstHalfCourse: Course = {
    schema: "yangxia.course/1",
    id: "c_golden002",
    name: "黄金边界：先发力与半量课",
    age: "a18",
    source: { product: "18-39岁-纯徒手版", week: 1, day: "B", half: true },
    blocks: [
      {
        kind: "sets",
        items: [
          {
            exercise: "row",
            name: "哑铃划船",
            mode: "reps",
            perSide: true,
            sets: 1,
            reps: 3,
            rest: 15,
            tempo: { start: "up", up: 1, top: 1, down: 2, bottom: 0 },
            quote: ["每侧 1 组 × 3 次，拉起 1 秒顶停 1 秒下放 2 秒"],
          },
        ],
      },
    ],
  };

  // 含 505 个码点（带 Emoji 代理对）的备注，用于锁死 Unicode 码点截断 500 字
  const emojiNote = "  " + "💪".repeat(505) + "  ";

  const cases: GoldenCase[] = [
    buildCase("home-default-on-up", "默认开始时报数(on-up) + 领2次提示音", homeA, clips, {
      sessionInput: {
        // 模拟倒退重复播放同一完成拍下标 + 跳过后半部分：验证去重与跳段不计
        playedIndices: (plan) => {
          const finalIdxs = plan.timeline.events
            .map((e, i) => (e.isSetFinalRep && e.cueType === "rep" ? i : -1))
            .filter((i) => i >= 0);
          return finalIdxs.length ? [0, finalIdxs[0], finalIdxs[0], 1] : [0];
        },
        note: emojiNote,
      },
    }),
    buildCase("home-on-rep-quiet", "做完时报数(on-rep) + 领1次后安静（无下限成人）", homeA, clips, {
      devicePrefs: { countTiming: "on-rep", breathLead: 1, breathAfter: "quiet" },
    }),
    buildCase("hypertension-floor-blocks-quiet", "高血压下限(coaching.floor=pluck)：设备/用户改安静仍强制提示音", homeCoaching, clips, {
      devicePrefs: { breathLead: 1, breathAfter: "quiet", breathVolume: 10 },
      userPatch: { breathAfter: "quiet" },
    }),
    buildCase("floor-voice-off-forces-pluck", "有下限 + 关闭语音报数：强制退回领0次提示音且提示音量>=15", homeCoaching, clips, {
      userPatch: { voiceBake: false, breathLead: "all", breathAfter: "quiet", breathVolume: 5 },
    }),
    buildCase("senior-a65-implicit-floor", "65岁以上即使无coaching字段也隐含提示音下限且停顿不写憋气", senior, clips, {
      userPatch: { breathLead: 0, breathAfter: "quiet", breathVolume: 10 },
    }),
    buildCase("circuit-rounds-and-switch", "循环块：单位为轮、轮中换项休与每轮结束休息", circuit, clips, {
      extraSampleIdx: (plan) => {
        const restIdx = plan.timeline.events.findIndex((e) => e.state === "rest");
        const prepAfterRest = plan.timeline.events.findIndex((e, i) => i > restIdx && e.state === "prep");
        return [restIdx, prepAfterRest].filter((i) => i >= 0);
      },
      sessionInput: {
        playedIndices: (plan) => plan.timeline.events.map((_, i) => i),
        edited: true,
        feeling: "吃力",
        symptoms: { pain: true, dizzy: false, chest: false },
      },
    }),
    buildCase("motions-wrap-hold-loop-perside", "动图 wrap 折返(squat)、静撑(plank)、循环(walk)、每侧计时(两侧做完)与无效 figure(null)", motionAndSideCourse, clips, {
      extraSampleIdx: (plan) => {
        const squatTop = plan.timeline.events.findIndex((e) => e.itemIndex === 0 && /顶点/.test(e.label));
        const plankAction = plan.timeline.events.findIndex((e) => e.itemIndex === 1 && e.state === "action");
        const sidePlankAction = plan.timeline.events.findIndex((e) => e.itemIndex === 2 && e.state === "action");
        const walkAction = plan.timeline.events.findIndex((e) => e.itemIndex === 3 && e.state === "action");
        const swap = plan.timeline.events.findIndex((e) => /^(左侧|右侧)$/.test(e.display));
        const timedDone = plan.timeline.events.findIndex((e) => e.isTimedMode && /✓/.test(e.display));
        const rest321 = plan.timeline.events.findIndex((e) => e.state === "rest" && e.display === "3");
        return [squatTop, plankAction, sidePlankAction, walkAction, swap, timedDone, rest321].filter((i) => i >= 0);
      },
    }),
    buildCase("up-first-half-perside-reps", "先发力(start=up) + 每侧按次换边 + 半量标记", upFirstHalfCourse, clips, {
      devicePrefs: { breathLead: "all" },
      extraSampleIdx: (plan) => {
        const swap = plan.timeline.events.findIndex((e) => /^(左侧|右侧)$/.test(e.display));
        return swap >= 0 ? [swap] : [];
      },
    }),
  ];

  return {
    schema: "yangxia.golden-player/1",
    voiceDurationMode: "estimateVoiceSeconds",
    cases,
  };
}

if (process.argv[2] === "write") {
  const data = buildGoldenFixture();
  writeFileSync(GOLDEN_PATH, JSON.stringify(data, null, 2) + "\n");
  console.log(`已生成黄金测试集：${GOLDEN_PATH}（${data.cases.length} 组用例）`);
}
