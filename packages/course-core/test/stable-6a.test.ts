// v4 阶段 6a：13–17 岁稳定期（进稳定期要往上那一条、没降级、习惯目标为空；不设直接进入；周期末 24 练、两项习惯各 9 周；
// 满 18 岁在轮的边界换版；学段和这一轮开始那天比），和 6–12 岁升初中的两处缺口（CROSS_FAMILY_RESET）。只用 contracts/fixtures/。
import { describe, expect, it } from "vitest";
import { ASSESS_FORMAT, type AssessContext, assessRules, checkAssessments, cycleEnd, segmentEnd } from "../src/assess.ts";
import { exportCourse } from "../src/plan.ts";
import { checkProgressLog, FEELS, REVIEW_FORMAT } from "../src/progress.ts";
import { SESSION_FORMAT } from "../src/profile.ts";
import { buildSheet } from "../src/sheet.ts";
import { FIX, fixtureManifest, fixturePlans, fixtureRules, readJson } from "./helpers.ts";

const manifest = fixtureManifest();
const plans = fixturePlans();
const rules = fixtureRules();
const ar = assessRules(rules)!;
const T = "13-17岁-纯徒手版";
const TS = "13-17岁-纯徒手版（稳定期）";
const A06 = "6-12岁-户外与游戏版（家长版）";
const plus = (d: string, n: number) => new Date(new Date(`${d}T12:00:00Z`).getTime() + n * 86_400_000).toISOString().slice(0, 10);
type Obj = Record<string, any>;
type Seg = [n: number, week: number, product: string, type?: string];
type Rv = [string, Obj];

/** 13–17 岁（初中）档案：segs 每项隔 7 天，从 start 起。 */
function profile(segs: Seg[], start = "2026-01-05", extra: Obj = {}) {
  const p = readJson<Obj>(`${FIX}profiles/ok-a18-home.json`);
  for (const k of ["wake", "bedtime", "birth", "body", "habitBase", "choices"]) delete p[k];
  p.segments = segs.map(([n, week, product, type], i) => ({
    n, ...(product.endsWith("（稳定期）") ? { phase: "稳定" } : {}), type: type ?? "标准", week, start: plus(start, 7 * i), product,
  }));
  const last = p.segments[p.segments.length - 1];
  Object.assign(p, { age: "a13", stage: "初中", product: last.product, venue: "bw", startDate: start, school: { stage: "初中", entry: 2025 } });
  const items = manifest.intake.screening.find((s) => s.age === "a13")!.items;
  p.screening = { answers: items.map((item) => ({ item, answer: "否" })), doctorCleared: false, date: start };
  p.conditions = { 没地方跳: false, 家长在旁边: true };
  p.choices = ["table-row"];
  return Object.assign(p, extra);
}
const review = (p: Obj, i: number, fields: Obj = {}): Rv => {
  const s = p.segments[i];
  return [`${s.start}-第${s.week}周.json`, { schema: REVIEW_FORMAT, start: s.start, week: s.week, trainings: 3, checkinDays: 6, symptoms: false, moves: [],
    habits: { 动够60分钟: 5, 按时上床: 5 }, ...fields }];
};
const rec = (date: string, kind: string, fields: Obj = {}) => ({ name: `评估/${date}-${kind}.json`, raw: { schema: ASSESS_FORMAT, date, kind, conclusion: {}, ...fields } });
function ctx(p: Obj, rv: Rv[], assessments: { name: string; raw: Obj }[], now?: string): AssessContext {
  const last = p.segments[p.segments.length - 1].start;
  return { profile: p, manifest, plans, rules, sessions: [], reviewData: Object.fromEntries(rv), assessments, now: new Date(`${now ?? plus(last, 2)}T12:00:00`) };
}
const errs = (c: AssessContext) => checkAssessments(c).filter((i) => i.level === "error").map((i) => `${i.path}：${i.message}`).join("\n");
/** 起始期 4 周 + 下一段第 1 周；each 给每一周复盘的字段；段末照重算的写。 */
function starterThen(next: Seg, each: (i: number) => Obj = () => ({})) {
  const p = profile([[1, 1, T], [1, 2, T], [1, 3, T], [1, 4, T], next]);
  const rv = [0, 1, 2, 3].map((i) => review(p, i, each(i)));
  const e: any = segmentEnd(p, 1, Object.fromEntries(rv), ar, "a13·bw");
  if (Object.keys(e.habitTargets ?? {}).length) p.segments[4].habitTargets = e.habitTargets;
  const end = rec(plus(p.segments[3].start, 6), "段末", { segment: 1, conclusion: { result: e.result, next: e.next, ...(e.extras.length ? { extras: e.extras } : {}),
    ...(Object.keys(e.habitTargets ?? {}).length ? { habitTargets: e.habitTargets } : {}) } });
  return { p, rv, e, A: [rec(p.segments[0].start, "入门", { base: 0 }), end] };
}

describe("13–17 岁进稳定期", () => {
  it("≥ 10 练、没有不适、习惯都达标：可以进", () => {
    const { p, rv, A, e } = starterThen([2, 1, TS]);
    expect(e).toMatchObject({ result: "原样", upward: true });
    expect(errs(ctx(p, rv, A))).toBe("");
  });
  it("完成 8–9 练（结论也是原样，往上是否）：不能进", () => {
    const { p, rv, A } = starterThen([2, 1, TS], (i) => ({ trainings: i < 3 ? 2 : 3 }));
    expect(errs(ctx(p, rv, A))).toMatch(/不是往上那一条/);
  });
  it("这一段有不适（降级）：不能进", () => {
    const { p, rv, A } = starterThen([2, 1, TS], (i) => ({ symptoms: i === 1 }));
    expect(errs(ctx(p, rv, A))).toMatch(/有不适，降级了/);
  });
  it("有一周动够 60 分钟没达标（下一段要降到每周 4 天）：不能进，先带着目标再跑一段起始期", () => {
    const bad = starterThen([2, 1, TS], (i) => (i === 2 ? { habits: { 动够60分钟: 3, 按时上床: 5 } } : {}));
    expect(errs(ctx(bad.p, bad.rv, bad.A))).toMatch(/降过的习惯目标都改回来.*STABLE_ENTRY_HABITS/);
    const ok = starterThen([2, 1, T], (i) => (i === 2 ? { habits: { 动够60分钟: 3, 按时上床: 5 } } : {}));
    expect(errs(ctx(ok.p, ok.rv, ok.A))).toBe("");
  });
  it("建档时直接进稳定期：拦下（不设直接进入）", () => {
    const p = profile([[1, 1, TS]]);
    expect(errs(ctx(p, [], [rec(p.segments[0].start, "入门", { base: 2 })]))).toMatch(/不设直接进入/);
  });
});

describe("13–17 岁稳定期的课程和计划单", () => {
  it("第 5 周（第 2 轮第 1 周）每天都能导出，计划单写第 2 轮第 1 周、没有有氧那一行", () => {
    const { p, rv, A } = starterThen([2, 1, TS]);
    for (let w = 2; w <= 5; w++) p.segments.push({ n: 2, phase: "稳定", type: "标准", week: w, start: plus(p.segments[p.segments.length - 1].start, 7), product: TS });
    const rv2 = [...rv, ...[4, 5, 6, 7].map((i) => review(p, i))];
    for (const day of ["A", "B", "C"]) {
      const r = exportCourse({ plans, rules, manifest, profile: p, week: 5, day });
      expect(r.issues.filter((i) => i.level === "error").map((i) => `${day} ${i.path} ${i.message}`)).toEqual([]);
    }
    const s = buildSheet(ctx(p, rv2, A));
    expect(s.text).toMatch(/第 2 轮 · 第 1 周/);
    expect(s.text).not.toMatch(/有氧：这一周做/);
  });
});

describe("13–17 岁稳定期的进度规则", () => {
  const plog = (p: Obj, rv: Rv[], sessions: any[] = [], A: any[] = []) =>
    checkProgressLog(p, plans, rules, sessions, Object.fromEntries(rv), new Date(`${plus(p.segments[p.segments.length - 1].start, 2)}T12:00:00`), A)
      .filter((i) => i.level === "error").map((i) => i.message).join("\n");
  /** 起始期 4 周 + 稳定期 wk 周，最后一周开始那天把俯卧撑从起始级升到第 2 级，依据是上一周的复盘。 */
  const run = (wk: number, each: (k: number) => Obj = () => ({})) => {
    const p = profile([[1, 1, T], [1, 2, T], [1, 3, T], [1, 4, T], ...Array.from({ length: wk }, (_, w) => [2, w + 1, TS] as Seg)], "2026-01-05",
      { progress: { pushup: { level: 2, reps: 8 } } });
    const i = p.segments.length - 1;
    p.progressLog = [{ date: p.segments[i].start, move: "pushup", field: "level", to: 2, rule: "升级", evidence: `复盘/${p.segments[i - 1].start}-第${p.segments[i - 1].week}周.json` }];
    const rv = p.segments.slice(0, -1).map((_: unknown, k: number) => review(p, k, { ...(k === i - 1 ? { moves: [{ move: "pushup", allAtTop: true, spare: 2 }] } : {}), ...each(k) }));
    return plog(p, rv);
  };
  it("升级：每一轮第 4 周（第 4、8 周）；第 5、7 周拦下", () => {
    expect(run(4)).toBe("");
    expect(run(8)).toBe("");
    expect(run(5)).toMatch(/不能升级/);
    expect(run(7)).toMatch(/不能升级/);
  });
  it("这一轮里有不适：这一轮第 4 周不升", () => {
    expect(run(4, (k) => (k === 5 ? { symptoms: true } : {}))).toMatch(/这一轮（4 周）里/);
  });
  it("从起始期升上来的人第 1–2 周不能往上找级（只给中断回来的人）", () => {
    const p = profile([[1, 1, T], [1, 2, T], [1, 3, T], [1, 4, T], [2, 1, TS]], "2026-01-05", { progress: { pushup: { level: 2 } } });
    const d = p.segments[4].start;
    p.progressLog = [{ date: d, move: "pushup", field: "level", to: 3, rule: "找级", evidence: `打卡/${d}.json` }];
    const s = { name: `打卡/${d}.json`, raw: { schema: SESSION_FORMAT, course: { id: "c", name: "x", source: {} }, startedAt: `${d}T19:00:00`, feeling: "正好",
      items: [{ exercise: "pushup", setsPlanned: 3, setsDone: 3, feel: FEELS[2] }], symptoms: { pain: false, dizzy: false, chest: false } } };
    expect(plog(p, p.segments.slice(0, 4).map((_: unknown, k: number) => review(p, k)), [s])).toMatch(/稳定期的找级只给/);
  });
});

describe("13–17 岁周期末", () => {
  const cycle = (each: (i: number) => Obj = () => ({})) => {
    const p = profile(Array.from({ length: 12 }, (_, i) => [1, i + 1, TS] as Seg));
    return { p, rv: p.segments.map((_: unknown, i: number) => review(p, i, each(i))) };
  };
  it("12 周 ≥ 24 练、两项习惯各 ≥ 9 周：达标；训练 23 练：回起始期减量段；一项习惯 8 周：下一周期第一轮不升级", () => {
    const pass = cycle(() => ({ trainings: 2 }));
    expect(cycleEnd(ctx(pass.p, pass.rv, []), 1)).toMatchObject({ result: "达标", next: { phase: "稳定" }, trainings: 24 });
    const low = cycle((i) => ({ trainings: i === 0 ? 1 : 2 }));
    expect(cycleEnd(ctx(low.p, low.rv, []), 1)).toMatchObject({ result: "训练没达标", next: { phase: "起始", type: "减量" }, trainings: 23 });
    const habit = cycle((i) => (i < 4 ? { habits: { 动够60分钟: 5, 按时上床: 4 } } : {}));
    expect(cycleEnd(ctx(habit.p, habit.rv, []), 1)).toMatchObject({ result: "习惯没达标", next: { phase: "稳定", hold: true }, habitWeeks: { 动够60分钟: 12, 按时上床: 8 } });
  });
  it("每周最多算 3 次训练；用的是 13–17 岁自己那张表（原句是 24 次）", () => {
    const { p, rv } = cycle(() => ({ trainings: 5 }));
    const c: any = cycleEnd(ctx(p, rv, []), 1);
    expect(c.trainings).toBe(36);
    expect(c.quotes.join()).toMatch(/难度级和次数接着用/);
    const low = cycle(() => ({ trainings: 1 }));
    expect((cycleEnd(ctx(low.p, low.rv, []), 1) as any).quotes.join()).toMatch(/12 周训练不到 24 次/);
  });
});

describe("13–17 岁稳定期的升学、满 18 岁", () => {
  it("初中升高中：稳定期里和这一轮开始那天比，这一轮还没练完不报", () => {
    // 2023 年入学的初中，2026-09-01 起是高中；稳定期第 1 轮从 08-17 开始
    const segs: Seg[] = [[1, 1, T], [1, 2, T], [1, 3, T], [1, 4, T], [2, 1, TS], [2, 2, TS], [2, 3, TS], [2, 4, TS]];
    const p = profile(segs, "2026-07-20", { school: { stage: "初中", entry: 2023 } });
    const stageErr = (q: Obj) => errs(ctx(q, [], [])).split("\n").filter((x) => x.includes("档案.json stage")).join();
    expect(stageErr(p)).toBe("");                                   // 第 4 周（09-07）还在第 1 轮，按 08-17 那天算初中
    const q = profile([...segs, [2, 5, TS]], "2026-07-20", { school: { stage: "初中", entry: 2023 } });
    expect(stageErr(q)).toMatch(/这一轮开始那天推算是高中/);       // 第 2 轮 09-14 开始：改 stage
  });
  it("稳定期一轮没练完就换成人版：拦下（满 18 岁在轮的边界换）", () => {
    const p = profile([[1, 1, TS], [1, 2, TS], [1, 3, TS], [1, 4, TS], [1, 5, TS], [1, 6, TS], [2, 1, "18-39岁-纯徒手版"]]);
    expect(errs(ctx(p, [], []))).toMatch(/满 18 岁在轮的边界换版：这一轮（4 周）练完再换，上一段才到第 6 周/);
  });
  it("换到成人版不能直接进成人稳定期", () => {
    const p = profile([[1, 1, TS], [1, 2, TS], [1, 3, TS], [1, 4, TS], [2, 1, "18-39岁-纯徒手版（稳定期）"]]);
    expect(errs(ctx(p, [], []))).toMatch(/换场地、换成品不能直接进稳定期/);
  });
});

describe("6–12 岁升初中（CROSS_FAMILY_RESET）", () => {
  /** 小学版 4 周（动够 60 分钟有一周没达标 → 下一段那一条成功线降到 16 天），9 月 1 日起换 13–17 岁版。 */
  function graduate(targets?: Obj) {
    const p = readJson<Obj>(`${FIX}profiles/ok-a18-home.json`);
    for (const k of ["wake", "bedtime", "birth", "body", "habitBase", "choices"]) delete p[k];
    Object.assign(p, { age: "a13", stage: "初中", product: T, venue: "bw", startDate: "2026-08-03", school: { stage: "小学", entry: 2020 } });
    const items = manifest.intake.screening.find((s) => s.age === "a13")!.items;
    p.screening = { answers: items.map((item) => ({ item, answer: "否" })), doctorCleared: true, date: "2026-09-01", doctorDate: "2026-09-01" };
    p.conditions = { 没地方跳: false, 家长在旁边: true };
    const weeks = ["2026-08-03", "2026-08-10", "2026-08-17", "2026-08-24"];
    p.segments = [...weeks.map((start, i) => ({ n: 1, type: "标准", week: i + 1, start, product: A06 })),
      { n: 2, type: "标准", week: 1, start: "2026-09-01", product: T, ...(targets ? { habitTargets: targets } : {}) }];
    const rv: Rv[] = weeks.map((start, i) => [`${start}-第${i + 1}周.json`, { schema: REVIEW_FORMAT, start, week: i + 1, trainings: 0, checkinDays: 6, symptoms: false, moves: [],
      habits: { 动够60分钟: 4, 按时上床: 6, 视屏少于2小时: 6 }, sickDays: 0 }]);
    const e: any = segmentEnd(p, 1, Object.fromEntries(rv), ar, "a06·play");
    const A = [rec("2026-08-03", "入门"), rec("2026-08-30", "段末", { segment: 1, conclusion: { result: e.result, next: e.next, habitTargets: e.habitTargets } }),
      rec("2026-08-31", "触发", { reasons: ["跨段"], product: T, base: 0 })];
    return { p, rv, e, c: ctx(p, rv, A, "2026-09-03") };
  }
  it("6–12 岁降过的成功线不带进 13–17 岁版；写了反而报", () => {
    const ok = graduate();
    expect(ok.e.habitTargets).toEqual({ 动够60分钟: { line: 16 } });
    expect(errs(ok.c)).not.toMatch(/habitTargets/);
    expect(errs(ok.c)).toBe("");
    expect(errs(graduate({ 动够60分钟: { line: 16 } }).c)).toMatch(/habitTargets：换到别的家族的成品，上一段的习惯目标不带过去/);
  });
  it("换版当天不误报中断、不出\"这一周没有训练\"的提醒", () => {
    const { c } = graduate();
    const all = checkAssessments(c).map((i) => i.message).join("\n");
    expect(all).not.toMatch(/断了 \d+ 天/);
    expect(all).not.toMatch(/这一周没有训练/);
  });
});
