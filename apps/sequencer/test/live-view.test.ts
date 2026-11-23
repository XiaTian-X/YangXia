// 跟练页每一刻显示什么（live/view.ts 的纯函数）：按次、计时、休息、准备几种状态，接下来、分段进度。
import { buildTimeline, validateCourse, type Course } from "@yangxia/course-core";
import { describe, expect, it } from "vitest";
import { breathOf, liveFrame, parseStage, segTitle, unitsOf } from "../src/live/view.ts";

const COURSE = {
  schema: "yangxia.course/1", id: "c_liveview01", name: "跟练页", age: "a18",
  source: { product: "18-39岁-居家版", week: 1 },
  blocks: [{ kind: "sets", items: [
    { exercise: "squat", name: "徒手深蹲", mode: "reps", sets: 2, reps: 5, tempo: { start: "down", down: 2, up: 1 }, rest: 30, quote: ["样例原文"] },
    { exercise: "plank", name: "平板支撑", mode: "timed", sets: 1, duration: 20, rest: 0, quote: ["样例原文"] },
  ] }],
} as unknown as Course;

const course = validateCourse(COURSE).course!;
const tl = buildTimeline(course, { voiceDuration: () => 0.5 });
const at = (pred: (i: number) => boolean) => {
  const i = tl.events.findIndex((_, k) => pred(k));
  expect(i).toBeGreaterThanOrEqual(0);
  return i;
};

describe("跟练页显示", () => {
  it("段落编号和呼吸文字", () => {
    expect(parseStage("ex-0-set-2")).toEqual({ kind: "set", itemIndex: 0, set: 2 });
    expect(parseStage("ex-1-prep")).toEqual({ kind: "prep", itemIndex: 1, set: 0 });
    expect(parseStage("ex-0-rest-1")).toEqual({ kind: "rest", itemIndex: 0, set: 1 });
    expect(breathOf("🌬️ 继续吸气")).toBe("inhale");
    expect(breathOf("💨 发力呼气")).toBe("exhale");
    expect(breathOf("🌬️ 均匀呼吸")).toBeNull();
    // 领呼："领呼"本身带"呼"，按引号里的字算
    expect(breathOf('🗣️ 领呼"吸"')).toBe("inhale");
    expect(breathOf('🗣️ 领呼"呼"')).toBe("exhale");
    expect(breathOf("🌬️ 自然呼吸，别把气停住")).toBeNull();
    expect(breathOf("💨 呼气 2 秒")).toBe("exhale");
    expect(breathOf("🌬️ 吸气 2 秒")).toBe("inhale");
  });

  it("按次：大字是第几次，环按次数走，接下来是休息", () => {
    const i = at((k) => tl.events[k].state === "action" && tl.events[k].phaseGroup === "ex-0-set-1" && /^3 \/ 5$/.test(tl.events[k].display));
    const f = liveFrame(course, tl, i, tl.events[i].time);
    expect(f.mode).toBe("action");
    expect(f.big).toBe("3");
    expect(f.small).toBe("/ 5");
    expect(f.ring).toBeCloseTo(0.6);
    expect(f.sub).toBe("1 / 2 · 第 1 / 2 组");
    expect(f.next).toBe("休息 30 秒，然后第 2 组");
    expect(f.segs.find((s) => s.now)?.id).toBe("ex-0-set-1");
    expect(f.segs.some((s) => s.id.endsWith("-prep"))).toBe(false);
  });

  it("休息：按课程写的秒数倒数，预告下一组", () => {
    const i = at((k) => tl.events[k].phaseGroup === "ex-0-rest-1" && tl.events[k].display === "30s");
    const f = liveFrame(course, tl, i, tl.events[i].time + 0.4);
    expect(f.mode).toBe("rest");
    expect(f.big).toBe("30");
    expect(f.small).toBe("秒，共 30 秒");
    expect(f.ring).toBeCloseTo(29.6 / 30);
    expect(f.nextItem).toMatchObject({ name: "徒手深蹲", set: "第 2 / 2 组" });
    expect(f.segs.find((s) => s.id === "ex-0-rest-1")?.seconds).toBe(30);
    const j = at((k) => tl.events[k].phaseGroup === "ex-0-rest-1" && tl.events[k].display === "10s");
    expect(liveFrame(course, tl, j, tl.events[j].time + 0.5).big).toBe("10");
  });

  it("休息末尾的 3、2、1：大字是倒数，上面写准备第几组", () => {
    const i = at((k) => tl.events[k].phaseGroup === "ex-0-rest-1" && tl.events[k].state === "rest" && tl.events[k].display === "3");
    const f = liveFrame(course, tl, i, tl.events[i].time);
    expect(f.big).toBe("3");
    expect(f.over).toContain("准备第 2 组");
  });

  it("计时：大字是还剩几秒，最后一段说做完就练完了", () => {
    const i = at((k) => tl.events[k].state === "action" && tl.events[k].isTimedMode === true);
    const f = liveFrame(course, tl, i, tl.events[i].time);
    expect(f.small).toBe("秒");
    expect(Number(f.big)).toBeGreaterThan(0);
    expect(f.title).toBe("平板支撑");
    expect(f.next).toBe("最后一段，做完就练完了");
  });

  it("整节课列表的名字", () => {
    expect(segTitle(course, tl, "ex-0-set-2")).toBe("徒手深蹲 · 第 2 组");
    expect(segTitle(course, tl, "ex-0-rest-1")).toBe("组间休息");
  });
});

describe("跟练页显示：领呼、每侧、循环、休息末尾、计时做完", () => {
  const MORE = validateCourse({
    schema: "yangxia.course/1", id: "c_liveview02", name: "跟练页二", age: "a18",
    source: { product: "18-39岁-居家版", week: 1 },
    blocks: [
      { kind: "sets", items: [
        { exercise: "split-squat", name: "原地分腿蹲", mode: "reps", sets: 1, reps: 2, perSide: true, tempo: { start: "down", down: 2, up: 1 }, rest: 10, quote: ["样例原文"] },
        { exercise: "side-plank", name: "侧撑", mode: "timed", sets: 1, duration: 5, perSide: true, rest: 10, quote: ["样例原文"] },
      ] },
      { kind: "circuit", rounds: 2, restBetweenRounds: 20, items: [
        { exercise: "squat", name: "深蹲", mode: "reps", reps: 2, tempo: { start: "up", up: 1, down: 2 }, rest: 0, quote: ["样例原文"] },
        { exercise: "plank", name: "平板", mode: "timed", duration: 5, rest: 0, quote: ["样例原文"] },
      ] },
    ],
  });
  const c = MORE.course!;
  const t2 = buildTimeline(c, { voiceDuration: () => 0.5 });
  const find = (pred: (e: (typeof t2.events)[number]) => boolean) => {
    const i = t2.events.findIndex(pred);
    expect(i).toBeGreaterThanOrEqual(0);
    return i;
  };
  const frameAt = (i: number) => liveFrame(c, t2, i, t2.events[i].time);

  it("课程合格", () => expect(MORE.issues.filter((x) => x.level === "error")).toEqual([]));

  it("领呼的那几次：口令写吸气、环心按吸气变色", () => {
    const i = find((e) => e.breathText === '🗣️ 领呼"吸"' && !e.isTimedMode && e.state === "action");
    const f = frameAt(i);
    expect(f.breath).toBe("inhale");
    expect(f.phase).toContain("吸气");
  });

  it("每侧：写出左侧、右侧；中间换边不显示 0 / 0", () => {
    const l = find((e) => e.phaseGroup === "ex-0-set-1" && /左侧/.test(e.tag) && e.state === "action");
    expect(frameAt(l).sub).toContain("左侧");
    const r = find((e) => e.phaseGroup === "ex-0-set-1" && /· 右侧/.test(e.tag));
    expect(frameAt(r).sub).toContain("右侧");
    const sw = find((e) => e.display === "右侧" && e.itemIndex === 1);
    const f = frameAt(sw);
    expect(f.big).toBe("右侧");
    expect(f.over).toBe("换边");
    expect(f.small).not.toContain("/");
    const timedRight = find((e) => e.isTimedMode === true && e.itemIndex === 1 && /右侧/.test(e.tag) && !/✓/.test(e.display));
    expect(frameAt(timedRight).sub).toContain("右侧");
    const timedDone = find((e) => e.isTimedMode === true && e.itemIndex === 1 && /✓/.test(e.display));
    expect(frameAt(timedDone).sub).toContain("两侧做完");
  });

  it("计时做完那一拍环是满的；计时口令照时间轴说，不写撑住", () => {
    const d = find((e) => e.isTimedMode === true && /✓/.test(e.display));
    expect(frameAt(d).ring).toBe(1);
    const h = find((e) => e.isTimedMode === true && /还剩/.test(e.label));
    expect(frameAt(h).phase).not.toContain("撑住");
    expect(frameAt(h).phase).toMatch(/[呼吸]气/);
  });

  it("循环里的动作按轮数，列表和休息也写轮", () => {
    expect(unitsOf(c)).toEqual(["组", "组", "轮", "轮"]);
    const i = find((e) => e.phaseGroup === "ex-2-set-1" && e.state === "action");
    expect(frameAt(i).sub).toContain("第 1 / 2 轮");
    expect(segTitle(c, t2, "ex-2-set-2")).toBe("深蹲 · 第 2 轮");
  });

  it("换项休末尾的准备：标题已经是下一个动作", () => {
    const i = find((e) => e.phaseGroup === "ex-0-rest-1" && e.state === "prep");
    const f = frameAt(i);
    expect(f.title).toBe("侧撑");
    expect(f.mode).toBe("prep");
    expect(f.next).toContain("侧撑");
  });

  it("手写的循环课程轮中间换动作：不说这一轮做完了", () => {
    const hand = validateCourse({
      schema: "yangxia.course/1", id: "c_liveview03", name: "手写循环", age: "a18", source: { product: "18-39岁-居家版", week: 1 },
      blocks: [{ kind: "circuit", rounds: 2, items: [
        { exercise: "squat", name: "深蹲", mode: "reps", reps: 2, tempo: { start: "down", down: 2, up: 1 }, rest: 10, quote: ["样例原文"] },
        { exercise: "plank", name: "平板", mode: "timed", duration: 5, rest: 10, quote: ["样例原文"] },
      ] }],
    }).course!;
    const t3 = buildTimeline(hand, { voiceDuration: () => 0.5 });
    const st = t3.stages.find((x) => x.isRest && x.id.startsWith("ex-0-rest"))!;
    const f = liveFrame(hand, t3, st.firstEventIdx, t3.events[st.firstEventIdx].time);
    expect(st.label).toBe("换项休");
    expect(f.sub).toContain("这一轮的深蹲做完了");
    expect(f.sub).not.toMatch(/第 1 轮做完了/);
  });

  it("空时间轴不报错", () => {
    const f = liveFrame(c, { events: [], stages: [], totalDuration: 0, motion: [] }, 0, 0);
    expect(f.segs).toEqual([]);
  });
});
