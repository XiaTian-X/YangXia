// 跟练页每一刻显示什么（live/view.ts 的纯函数）：按次、计时、休息、准备几种状态，接下来、分段进度。
import { buildTimeline, validateCourse, type Course } from "@yangxia/course-core";
import { describe, expect, it } from "vitest";
import { breathOf, liveFrame, parseStage, segTitle } from "../src/live/view.ts";

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
    expect(segTitle(course, tl, "ex-0-rest-1")).toBe("休息");
  });
});
