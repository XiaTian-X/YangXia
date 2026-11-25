import { describe, expect, it } from "vitest";
import { buildSrt, srtCues, srtTimecode } from "../src/srt.ts";
import { repBeats } from "../src/tempo.ts";
import { buildTimeline } from "../src/timeline.ts";
import type { Course, CourseItem } from "../src/types.ts";
import { canSpeak, numberTokens, voiceTokens } from "../src/voice.ts";
import { clone, okCourse } from "./helpers.ts";

const sig = (t: Parameters<typeof repBeats>[0]) => repBeats(t, "a18").map((b) => `${b.type}:${b.breath}`).join(" ");

describe("节奏：和原版四种写法一一对应（60 BPM、从发力开始）", () => {
  it("1-1", () => expect(sig({ start: "up", up: 1, down: 1 })).toBe("up:exhale rep:inhale"));
  it("1-2", () => expect(sig({ start: "up", up: 1, down: 2 })).toBe("up:exhale sub:inhale rep:none"));
  it("1-1-2", () => expect(sig({ start: "up", up: 1, top: 1, down: 2 })).toBe("up:exhale hold:none sub:inhale rep:none"));
  it("2-2", () => expect(sig({ start: "up", up: 2, down: 2 })).toBe("up:exhale sub:none sub:inhale rep:none"));
  it("下放 3 秒、从下放开始（深蹲）", () =>
    expect(sig({ start: "down", down: 3, up: 1 })).toBe("sub:inhale sub:none sub:none rep:exhale"));
  it("半秒停顿", () => expect(repBeats({ start: "up", up: 1, top: 0.5, down: 2 }, "a18").map((b) => b.dur)).toEqual([1, 0.5, 1, 1]));
  it("65 岁以上的停顿提示是\"别把气停住\"", () => {
    const hold = repBeats({ start: "up", up: 1, top: 1, down: 2 }, "a65").find((b) => b.type === "hold")!;
    expect(hold.breathText).toContain("别把气停住");
    expect(hold.breathText).not.toContain("憋气");
  });
});

function course(items: CourseItem[], extra: Partial<Course> = {}): Course {
  return { schema: "yangxia.course/1", id: "c_testtest", name: "测试", age: "a18",
    source: { product: "18-39岁-居家版", week: 1 }, blocks: [{ kind: "sets", items }], ...extra };
}
const item = (o: Partial<CourseItem> = {}): CourseItem => ({ exercise: "squat", name: "徒手深蹲", mode: "reps", sets: 2, reps: 3,
  tempo: { start: "up", up: 1, down: 2 }, rest: 10, quote: ["x"], ...o });

describe("时间轴：计时规则照原版", () => {
  it("报数时刻（开头倒数 1.45 + 3×1.08 + 0.75 + 0.85 秒后起拍，每次 3 拍）", () => {
    const tl = buildTimeline(course([item()]), { settings: { countTiming: "on-rep" } });
    const reps = tl.events.filter((e) => e.cueType === "rep").slice(0, 3).map((e) => +e.time.toFixed(2));
    expect(reps).toEqual([8.37, 11.37, 14.37]);
    expect(tl.events.find((e) => e.cueType === "rep")!.voice).toBe("最后三次");
  });
  it("最后一组后没有休息，最后一次报\"全部完成\"", () => {
    const tl = buildTimeline(course([item()]), { settings: { countTiming: "on-rep" } });
    const last = tl.events.filter((e) => e.cueType === "rep").at(-1)!;
    expect(last.voice).toBe("3，全部完成");
    expect(tl.events.filter((e) => e.state === "rest").length).toBe(10);
  });
  it("每侧：左右各做一遍，中间换边不休息", () => {
    const tl = buildTimeline(course([item({ perSide: true, sets: 1 })]));
    expect(tl.events.filter((e) => e.cueType === "side-switch").length).toBe(1);
    expect(tl.events.filter((e) => e.cueType === "rep").length).toBe(6);
  });
  it("循环：按轮换动作，轮间休息用 restBetweenRounds", () => {
    const c = course([], { blocks: [{ kind: "circuit", rounds: 2, restBetweenRounds: 20,
      items: [item({ sets: 1, rest: 0 }), item({ exercise: "pushup", name: "俯卧撑", sets: 1, rest: 0 })] }] });
    const tl = buildTimeline(c);
    const restRuns = tl.stages.filter((s) => s.isRest).length;
    expect(restRuns).toBe(1);
    expect(tl.events.filter((e) => e.state === "rest").length).toBe(20);
  });
  it("计时动作：每秒一拍，开头报秒数，最后报完成", () => {
    const tl = buildTimeline(course([item({ mode: "timed", duration: 20, reps: undefined, tempo: undefined, sets: 1 })]));
    const action = tl.events.filter((e) => e.state === "action");
    expect(action[0].voice).toBe("20秒");
    expect(action.at(-1)!.voice).toBe("全部完成");
  });
  it("所有语音都在内置词表里", () => {
    for (const name of ["ok-a18-home-w1-a.json", "ok-a18-home-w1-d-circuit.json"]) {
      for (const e of buildTimeline(okCourse(name)).events) if (e.voice) expect(canSpeak(e.voice), e.voice).toBe(true);
    }
  });
  it("65 岁以上课程的字幕和画面里没有\"憋气\"", () => {
    const c = clone(okCourse("ok-a18-home-w1-a.json"));
    c.age = "a65";
    const all = buildTimeline(c).events.flatMap((e) => [e.tag, e.label, e.breathText, e.srtText ?? ""]).join("\n");
    expect(all).not.toContain("憋气");
  });
});

describe("时间轴事件的 view：跟练画面只读结构化字段", () => {
  it("准备倒数、按次的第几次和节奏段、休息倒数和总秒数", () => {
    const tl = buildTimeline(course([item({ tempo: { start: "down", down: 2, up: 1, bottom: 1 } })]), { settings: { countTiming: "on-rep" } });
    const ev = tl.events;
    expect(ev.filter((e) => e.cueType === "count-321" && e.state === "prep").slice(0, 3).map((e) => e.view.count)).toEqual([3, 2, 1]);
    const firstRep = ev.filter((e) => e.state === "action").slice(0, 4);
    expect(firstRep.map((e) => e.view.tempo)).toEqual(["down", "down", "bottom", null]);
    expect(firstRep.map((e) => e.view.rep)).toEqual([{ n: 0, of: 3 }, { n: 0, of: 3 }, { n: 0, of: 3 }, { n: 1, of: 3 }]);
    expect(firstRep[0].view.breath).toBe("inhale");
    const rest = ev.filter((e) => e.state === "rest");
    expect(rest[0].view).toMatchObject({ secLeft: 10, restTotal: 10, count: null });
    expect(rest.at(-1)!.view).toMatchObject({ secLeft: null, count: 1 });
  });
  it("每侧动作的左右侧、换边那一拍；计时动作的倒数和做完那一拍；领呼", () => {
    const tl = buildTimeline(course([item({ exercise: "plank", name: "平板支撑", mode: "timed", duration: 20, perSide: true, tempo: undefined, sets: 1 })]),
      { settings: { breathLead: "all" } });
    const act = tl.events.filter((e) => e.state === "action");
    expect(act[0].view).toMatchObject({ side: "左侧", secLeft: 20, sideSwitch: false });
    const sw = act.find((e) => e.view.sideSwitch)!;
    expect(sw.view.side).toBe("右侧");
    const done = act.find((e) => e.view.done)!;
    expect(done.view).toMatchObject({ secLeft: 0, side: null });
    const lead = act.find((e) => e.view.lead)!;
    expect(lead.breathText).toMatch(/领呼/);
    expect(lead.view.breath).not.toBeNull();
  });
});

describe("语音词表和字幕", () => {
  it("数字读法", () => {
    expect(numberTokens(15)).toEqual(["10_short", "5"]);
    expect(numberTokens(90)).toEqual(["9", "10"]);
    expect(numberTokens(105)).toEqual(["1", "百", "0", "5"]);
    expect(voiceTokens("休息 90 秒")).toEqual(["休息", "9", "10", "秒"]);
    expect(voiceTokens("别把气停住")).toBeNull();
  });
  it("SRT 时间码和格式", () => {
    expect(srtTimecode(3725.5)).toBe("01:02:05,500");
    const tl = buildTimeline(course([item()]));
    const cues = srtCues(tl.events, tl.totalDuration);
    expect(cues.every((c) => c.end > c.start && c.end - c.start <= 3.8)).toBe(true);
    expect(buildSrt(tl.events, tl.totalDuration).startsWith("1\r\n00:00:00,080 --> ")).toBe(true);
  });
});
