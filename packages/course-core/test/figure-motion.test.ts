// 动作示意动图：时间轴的 motion、motionAt 算帧、导出时写不写 figure、课程检查。只用离线样例。
import { describe, expect, it } from "vitest";
import { checkCourse } from "../src/check.ts";
import { courseClips, motionAt, spanAt, usableClip, type MotionClip, type MotionSpan } from "../src/figure-motion.ts";
import { checkPlanCourse, exportCourse, figureFor, type LadderLevel } from "../src/plan.ts";
import { buildTimeline } from "../src/timeline.ts";
import type { Course, CourseItem, Tempo } from "../src/types.ts";
import { validateCourse } from "../src/validate.ts";
import { FIX, clone, fitAge, fixtureManifest, fixtureMotions, fixturePlans, fixtureReadProduct, fixtureRules, okCourse, readJson } from "./helpers.ts";

const manifest = fixtureManifest();
const plans = fixturePlans();
const rules = fixtureRules();

const CLIP: MotionClip = { exercises: ["squat"], frames: 48, dur: 4, w: 420, h: 270,
  phases: { down: [6, 24], bottom: [30, 5], up: [35, 12], top: [47, 7] } };
const HOLD: MotionClip = { exercises: ["plank"], frames: 60, dur: 5, w: 420, h: 270, hold: 20 };
const LOOP: MotionClip = { exercises: ["walk"], frames: 14, dur: 1, w: 420, h: 270, loop: true };
const clips = { squat: CLIP, plank: HOLD, walk: LOOP };

const reps = (o: Partial<CourseItem> = {}, tempo: Tempo = { start: "down", down: 2, up: 1 }): CourseItem => ({
  exercise: "squat", name: "深蹲", mode: "reps", sets: 2, reps: 2, tempo, rest: 5, quote: ["样例原文"], figure: "squat", ...o });
const timed = (o: Partial<CourseItem> = {}): CourseItem => ({
  exercise: "plank", name: "平板", mode: "timed", sets: 1, duration: 6, rest: 5, quote: ["样例原文"], figure: "plank", ...o });
const course = (items: CourseItem[], extra: Partial<Course> = {}): Course => ({
  schema: "yangxia.course/1", id: "c_motiontest", name: "测试", age: "a18",
  source: { product: "18-39岁-居家版", week: 1, plan: "yangxia.plans/1" }, blocks: [{ kind: "sets", items }], ...extra });
const NO_PREP = { settings: { preCountdown: false } };
const kinds = (ss: MotionSpan[]) => ss.map((s) => (s.kind === "phase" ? s.phase : s.kind === "pose" ? `${s.pose}:${s.note}` : `timed:${s.note}`));

function expectContinuous(spans: MotionSpan[], total: number) {
  expect(spans[0].start).toBe(0);
  spans.forEach((s, i) => {
    expect(s.end).toBeGreaterThan(s.start);
    if (i) expect(s.start).toBeCloseTo(spans[i - 1].end, 9);
  });
  expect(spans[spans.length - 1].end).toBeCloseTo(total, 9);
}

describe("时间轴 motion：每一秒都有归属", () => {
  it("按次动作：准备、相位、每组最后的等待、组间休息、结尾", () => {
    const tl = buildTimeline(course([reps({ reps: 1 })]));
    expectContinuous(tl.motion, tl.totalDuration);
    expect(kinds(tl.motion)).toEqual([
      "start:ready", "down", "up", "last:doing", "start:next-set", "down", "up", "last:doing", "last:done",
    ]);
  });
  it("同一相位的多拍合并成一段，时长等于节奏", () => {
    const tl = buildTimeline(course([reps({ reps: 1, sets: 1 }, { start: "up", up: 2, top: 1, down: 3, bottom: 1 })]), NO_PREP);
    const parts = tl.motion.filter((s) => s.kind === "phase").map((s) => [(s as { phase: string }).phase, s.end - s.start]);
    expect(parts.map((p) => p[0])).toEqual(["up", "top", "down", "bottom"]);
    expect(parts.slice(0, 3).map((p) => p[1])).toEqual([2, 1, 3]);
  });
  it("不带开头倒数时，开头也有起始姿势", () => {
    const tl = buildTimeline(course([reps({ sets: 1, reps: 1 })]), NO_PREP);
    expect(kinds(tl.motion)[0]).toBe("start:ready");
    expectContinuous(tl.motion, tl.totalDuration);
  });
  it("每侧动作：中间换边 2 秒", () => {
    const tl = buildTimeline(course([reps({ sets: 1, reps: 1, perSide: true })]), NO_PREP);
    const sw = tl.motion.find((s) => s.note === "switch-side")!;
    expect(sw.end - sw.start).toBeCloseTo(2, 9);
    expect(sw.kind).toBe("pose");
    expectContinuous(tl.motion, tl.totalDuration);
  });
  it("计时动作：撑住，完成后 1.85 秒停在原姿势", () => {
    const tl = buildTimeline(course([timed()]), NO_PREP);
    const i = tl.motion.findIndex((s) => s.kind === "timed");
    expect(tl.motion[i].end - tl.motion[i].start).toBeCloseTo(6, 9);
    expect(tl.motion[i + 1]).toMatchObject({ kind: "pose", pose: "last", note: "doing" });
    expect(tl.motion[i + 1].end - tl.motion[i + 1].start).toBeCloseTo(1.85, 9);
  });
  it("换动作的休息归到下一个动作，写\"下一个\"", () => {
    const tl = buildTimeline(course([reps({ sets: 1, reps: 1 }), timed()]), NO_PREP);
    expect(tl.motion.find((s) => s.note === "next-item")).toMatchObject({ itemIndex: 1, pose: "start" });
  });
  it("循环：每个动作的 itemIndex 和动作表一致", () => {
    const c = course([], { blocks: [{ kind: "circuit", rounds: 2, restBetweenRounds: 5, items: [reps({ sets: undefined, reps: 1, rest: 0 }), timed({ sets: undefined, rest: 0 })] }] });
    const tl = buildTimeline(c);
    expectContinuous(tl.motion, tl.totalDuration);
    expect(new Set(tl.motion.map((s) => s.itemIndex))).toEqual(new Set([0, 1]));
  });
  it("样例课程：不管有没有 figure，事件都不变", () => {
    const c = okCourse("ok-a13-bw-w1-a.json");
    const marked = clone(c);
    marked.blocks.forEach((b) => b.items.forEach((x) => { x.figure = x.exercise; }));
    expect(buildTimeline(marked).events).toEqual(buildTimeline(c).events);
  });
  it("spanAt：结束以后还是最后一段，开始之前没有", () => {
    const tl = buildTimeline(course([timed()]));
    expect(spanAt(tl.motion, 1e6)).toBe(tl.motion[tl.motion.length - 1]);
    expect(spanAt(tl.motion, -1)).toBeNull();
  });
});

describe("motionAt：定到第几帧", () => {
  const span = (tl: ReturnType<typeof buildTimeline>, pred: (s: MotionSpan) => boolean) => tl.motion.find(pred)!;
  const isPhase = (p: string) => (s: MotionSpan) => s.kind === "phase" && s.phase === p;

  it("下放进度映射到片段的下放段，课程秒数不同也伸缩", () => {
    const c = course([reps({ sets: 1, reps: 1 }, { start: "down", down: 3, up: 1 })]);
    const tl = buildTimeline(c, NO_PREP);
    const s = span(tl, isPhase("down"));
    expect(motionAt(tl, c, clips, s.start)!.frame).toBeCloseTo(6, 6);
    expect(motionAt(tl, c, clips, s.start + 1.5)!.frame).toBeCloseTo(18, 6);
    expect(motionAt(tl, c, clips, s.end - 1e-6)!.frame).toBeCloseTo(30, 3);
  });
  it("发力段跨过循环点时帧号绕回", () => {
    const wrapClip: MotionClip = { ...CLIP, phases: { down: [10, 20], up: [40, 18] } };
    const c = course([reps({ sets: 1, reps: 1 }, { start: "up", up: 1, down: 1 })]);
    const tl = buildTimeline(c, NO_PREP);
    const s = span(tl, isPhase("up"));
    expect(motionAt(tl, c, { squat: wrapClip }, s.start + 0.5)!.frame).toBeCloseTo(1, 6);
  });
  it("课程有停顿、片段没有：停在分界那一帧", () => {
    const bare: MotionClip = { ...CLIP, phases: { down: [6, 24], up: [35, 12] } };
    const c = course([reps({ sets: 1, reps: 1 }, { start: "down", down: 1, bottom: 2, up: 1, top: 1 })]);
    const tl = buildTimeline(c, NO_PREP);
    const b = span(tl, isPhase("bottom"));
    const t = span(tl, isPhase("top"));
    expect(motionAt(tl, c, { squat: bare }, b.start + 0.5)!.frame).toBe(30);
    expect(motionAt(tl, c, { squat: bare }, t.start + 0.2)!.frame).toBe(47);
  });
  it("片段有停顿、课程没有：直接从下放接到发力", () => {
    const c = course([reps({ sets: 1, reps: 1 })]);
    const tl = buildTimeline(c, NO_PREP);
    expect(tl.motion.some(isPhase("bottom"))).toBe(false);
    expect(motionAt(tl, c, clips, span(tl, isPhase("up")).start)!.frame).toBe(35);
  });
  it("准备、休息显示起始姿势；每组结束停在这一次的终点", () => {
    const c = course([reps({ reps: 1 })]);
    const tl = buildTimeline(c);
    const at = (s: MotionSpan) => motionAt(tl, c, clips, s.start + 0.01)!;
    expect(at(span(tl, (s) => s.note === "ready"))).toMatchObject({ frame: 6, note: "ready" });
    expect(at(span(tl, (s) => s.note === "next-set"))).toMatchObject({ frame: 6, note: "next-set" });
    expect(at(span(tl, (s) => s.kind === "pose" && s.pose === "last"))).toMatchObject({ frame: 47, note: "doing" });
  });
  it("从发力开始的动作：起始姿势在发力起点，结束在下放终点", () => {
    const c = course([reps({ sets: 1, reps: 1 }, { start: "up", up: 1, down: 1 })]);
    const tl = buildTimeline(c);
    expect(motionAt(tl, c, clips, 0.1)!.frame).toBe(35);
    expect(motionAt(tl, c, clips, tl.totalDuration)!).toMatchObject({ frame: 30, note: "done" });
  });
  it("计时动作：全程停在撑住帧；连续动作原速循环", () => {
    const c = course([timed()]);
    const tl = buildTimeline(c, NO_PREP);
    const s = span(tl, (x) => x.kind === "timed");
    expect(motionAt(tl, c, clips, s.start + 3)!.frame).toBe(20);
    expect(motionAt(tl, c, clips, 0)!.frame).toBe(20);
    const w = course([timed({ exercise: "walk", figure: "walk" })]);
    const wl = buildTimeline(w, NO_PREP);
    const ws = span(wl, (x) => x.kind === "timed");
    expect(motionAt(wl, w, clips, ws.start + 0.5)!.frame).toBeCloseTo(7, 6);
    expect(motionAt(wl, w, clips, ws.start + 1.25)!.frame).toBeCloseTo(3.5, 6);
    expect(motionAt(wl, w, clips, 0)!.frame).toBe(0);
  });
  it("每侧动作带上标记", () => {
    const c = course([reps({ sets: 1, reps: 1, perSide: true })]);
    const tl = buildTimeline(c, NO_PREP);
    expect(motionAt(tl, c, clips, span(tl, isPhase("down")).start)!.perSide).toBe(true);
  });
  it("不显示的情况", () => {
    const check = (c: Course, cl: Record<string, MotionClip> = clips) => motionAt(buildTimeline(c), c, cl, 0.5);
    expect(check(course([reps()]))).not.toBeNull();
    expect(check(course([reps()], { source: { product: "x", week: 1 } })), "手写课程").toBeNull();
    expect(check(course([reps({ figure: undefined })])), "没有 figure").toBeNull();
    expect(check(course([reps({ figure: "no-clip" })])), "片段不存在").toBeNull();
    expect(check(course([reps({ figure: "constructor" })])), "原型上的名字").toBeNull();
    expect(check(course([reps({ figure: "plank" })])), "图号和动作对不上").toBeNull();
    expect(check(course([reps()]), { squat: { ...CLIP, phases: undefined } }), "按次动作没有节拍段").toBeNull();
    expect(check(course([reps()]), { squat: { ...CLIP, phases: { up: [0, 1] } } }), "只有发力段").toBeNull();
    expect(check(course([timed()]), { plank: { ...HOLD, hold: undefined } }), "计时动作没有撑住帧").toBeNull();
  });
  it("courseClips 只列能用的，去重", () => {
    const c = course([reps(), reps({ name: "再来" }), timed(), reps({ figure: "plank" }), reps({ figure: undefined })]);
    expect(courseClips(c, clips).sort()).toEqual(["plank", "squat"]);
    expect(usableClip(c, undefined, clips)).toBeNull();
  });
  it("离线样例的片段能用", () => {
    const data = fixtureMotions();
    expect(data.format).toBe("yangxia.motions/1");
    const c = course([reps(), timed()]);
    const tl = buildTimeline(c);
    expect(motionAt(tl, c, data.clips, 0.5)).toMatchObject({ clip: "squat" });
    expect(courseClips(c, data.clips).sort()).toEqual(["plank", "squat"]);
  });
});

describe("导出：写不写 figure", () => {
  const ex = (id: string) => manifest.exercises.find((e) => e.id === id)!;
  const ladder = (product: string, move: string) => plans.products[product].ladders[move];
  const level = (l: LadderLevel[], n: number) => l.find((x) => x.level === n)!;
  const P = "18-39岁-纯徒手版";
  const none = { condition: null };

  it("没有共用图的动作用自己的图", () => expect(figureFor(rules, "a18·bw", ex("glute-bridge"), "glute-bridge", null, null, none)).toBe("glute-bridge"));
  it("共用图的级：登记了才有", () => {
    const l = ladder(P, "squat");
    expect(figureFor(rules, "a18·bw", ex("squat"), "squat", level(l, 1), l, none)).toBe("squat");
    expect(figureFor(rules, "a18·bw", ex("squat"), "squat", level(l, 4), l, none), "1.5 次深蹲").toBeNull();
  });
  it("俯卧撑各级用阶梯图自己那一级", () => {
    const l = ladder(P, "pushup");
    expect(figureFor(rules, "a18·bw", ex("pushup"), "pushup", level(l, 1), l, none)).toBe("pushup-ladder#1");
    expect(figureFor(rules, "a18·bw", ex("pushup"), "pushup", level(l, 6), l, none)).toBe("pushup-ladder#6");
  });
  it("级名变了就不认（级号错位时不给错图）", () => {
    const l = clone(ladder(P, "squat"));
    level(l, 1).name = "别的做法";
    expect(figureFor(rules, "a18·bw", ex("squat"), "squat", level(l, 1), l, none)).toBeNull();
  });
  it("有自己动作的级直接用自己的图", () => {
    const l = ladder(P, "split-squat");
    expect(figureFor(rules, "a18·bw", ex("bss"), "split-squat", level(l, 3), l, none)).toBe("bss");
  });
  it("条件变体：登记了才有，正文那一边不用登记", () => {
    expect(figureFor(rules, "a18·bw", ex("plank"), "plank", null, null, { condition: { name: "高血压", value: true } })).toBe("plank");
    expect(figureFor(rules, "a18·bw", ex("plank"), "plank", null, null, { condition: { name: "高血压", value: false } })).toBe("plank");
    expect(figureFor(rules, "a18·bw", ex("glute-bridge"), "glute-bridge", null, null, { condition: { name: "高血压", value: true } })).toBeNull();
  });
  it("不生成的动作、没有 motion 的旧模板都不写", () => {
    expect(figureFor({ ...rules, motion: { ...rules.motion!, skip: ["squat"] } }, "a18·bw", ex("glute-bridge"), "glute-bridge", null, null, none)).toBe("glute-bridge");
    expect(figureFor({ ...rules, motion: { ...rules.motion!, skip: ["glute-bridge"] } }, "a18·bw", ex("glute-bridge"), "glute-bridge", null, null, none)).toBeNull();
    const { motion: _drop, ...old } = rules;
    expect(figureFor(old, "a18·bw", ex("glute-bridge"), "glute-bridge", null, null, none)).toBeNull();
  });
});

describe("课程检查：figure", () => {
  const DATE = "2026-10-12";
  function profile() {
    const product = "18-39岁-纯徒手版";
    const prod = manifest.products.find((x) => x.name === product)!;
    const p = readJson<Record<string, any>>(`${FIX}profiles/ok-a18-home.json`);
    Object.assign(p, { age: prod.age, stage: "18–39 岁", product, venue: prod.venue, startDate: DATE });
    delete p.wake;
    delete p.bedtime;
    p.screening = { answers: manifest.intake.screening.find((s) => s.age === prod.age)!.items.map((item) => ({ item, answer: "否" })), doctorCleared: true, date: DATE, doctorDate: DATE };
    fitAge(p, prod.age);
    p.segments = [{ n: 1, type: "标准", week: 1, start: DATE, product }];
    p.conditions = Object.fromEntries(Object.entries(rules.conditions).map(([k, v]) => [k, v.text]));
    p.choices = ["table-row", "door-row", "a13-bar-row"];
    return p;
  }
  const p = profile();
  const exported = () => {
    const r = exportCourse({ plans, rules, manifest, profile: p, week: 1, day: "A" });
    expect(r.course).not.toBeNull();
    return r.course!;
  };
  const figured = (c: Course) => c.blocks.flatMap((b) => b.items).find((x) => x.figure)!;
  const figureIssues = (c: Course) => checkPlanCourse(c, plans, rules, manifest, p).filter((i) => i.path.endsWith(".figure"));

  it("导出的课程写了 figure，核对 0 问题", () => {
    const c = exported();
    expect(figured(c)).toBeTruthy();
    expect(figureIssues(c)).toEqual([]);
  });
  it("写错报错", () => {
    const c = exported();
    figured(c).figure = "plank";
    expect(figureIssues(c)).toMatchObject([{ level: "error" }]);
  });
  it("同一版模板导出的课程被删了 figure：报错", () => {
    const c = exported();
    delete figured(c).figure;
    expect(figureIssues(c)).toMatchObject([{ level: "error" }]);
  });
  it("旧模板导出的课程没有 figure：只提醒，照常能用", () => {
    const c = exported();
    c.blocks.forEach((b) => b.items.forEach((x) => delete x.figure));
    c.source.templates = "v3.3";
    const got = figureIssues(c);
    expect(got.length).toBeGreaterThan(0);
    expect(got.every((i) => i.level === "warning")).toBe(true);
  });
  it("手写课程写了 figure：报错", () => {
    const c = clone(okCourse("ok-a13-bw-w1-a.json"));
    delete c.source.plan;
    c.blocks[0].items[0].figure = "squat";
    const msgs = checkCourse(c, { manifest, readProduct: fixtureReadProduct }).filter((i) => i.level === "error").map((i) => i.message);
    expect(msgs.some((m) => m.includes("figure"))).toBe(true);
  });
  it("格式：只认片段号的写法", () => {
    const c = clone(okCourse("ok-a13-bw-w1-a.json"));
    c.blocks[0].items[0].figure = "pushup-ladder#3";
    expect(validateCourse(c).course).not.toBeNull();
    c.blocks[0].items[0].figure = "../x";
    expect(validateCourse(c).issues.some((i) => i.path.endsWith(".figure") && i.level === "error")).toBe(true);
  });
});
