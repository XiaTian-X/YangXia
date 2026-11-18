// v4 阶段 6b：65 岁以上稳定期——每周照第 4 周、进稳定期（≥ 10 练、没有摔倒头晕、习惯目标为空）、加一项（一轮第 1 周、上一轮 ≥ 10 练、
// 没有摔倒头晕不适、医生同意、一轮一项、二选一、要条件）、一轮里摔倒头晕的轮末处理、周期末第 0 行和达标线、断了超过 28 天。只用 contracts/fixtures/。
import { describe, expect, it } from "vitest";
import { ASSESS_FORMAT, type AssessContext, assessRules, checkAssessments, cycleEnd, segmentEnd } from "../src/assess.ts";
import { fallRiskConclusion, fallRiskRules } from "../src/fallrisk.ts";
import { exportCourse } from "../src/plan.ts";
import { REVIEW_FORMAT } from "../src/progress.ts";
import { activeAddOns, addOnIssues, validateAddFields } from "../src/senior.ts";
import { buildSheet } from "../src/sheet.ts";
import { FIX, fitAge, fixtureManifest, fixturePlans, fixtureRules, readJson } from "./helpers.ts";

const manifest = fixtureManifest();
const plans = fixturePlans();
const rules = fixtureRules();
const ar = assessRules(rules)!;
const rr = fallRiskRules(rules)!;
const C = "65岁以上-椅子辅助版";
const CS = "65岁以上-椅子辅助版（稳定期）";
const START = "2026-11-23";
const plus = (d: string, n: number) => new Date(new Date(`${d}T12:00:00Z`).getTime() + n * 86_400_000).toISOString().slice(0, 10);
type Obj = Record<string, any>;
type Seg = [n: number, week: number, product: string, type?: string];
type Rv = [string, Obj];

function profile(segs: Seg[], extra: Obj = {}) {
  const p = readJson<Obj>(`${FIX}profiles/ok-a18-home.json`);
  for (const k of ["wake", "bedtime", "choices"]) delete p[k];
  p.segments = segs.map(([n, week, product, type], i) => ({ n, ...(product === CS ? { phase: "稳定" } : {}), type: type ?? "标准", week, start: plus(START, 7 * i), product }));
  const last = p.segments[p.segments.length - 1];
  Object.assign(p, { age: "a65", stage: "65 岁以上", product: last.product, venue: "chair", startDate: START });
  const items = manifest.intake.screening.find((s) => s.age === "a65")!.items;
  p.screening = { answers: items.map((item) => ({ item, answer: "否" })), doctorCleared: true, date: START, doctorDate: START };
  fitAge(p, "a65");
  p.progress = {};
  p.progressLog = [];
  p.conditions = { 家里没有别人: false };
  return Object.assign(p, extra);
}
const review = (p: Obj, i: number, fields: Obj = {}): Rv => {
  const s = p.segments[i];
  return [`${s.start}-第${s.week}周.json`, { schema: REVIEW_FORMAT, start: s.start, week: s.week, trainings: 3, checkinDays: 6, symptoms: false, moves: [],
    habits: { 散步: 5, 放松: 5 }, falls: 0, nearFalls: 0, dizzy: 0, ...fields }];
};
const rec = (date: string, kind: string, fields: Obj = {}) => ({ name: `评估/${date}-${kind}.json`, raw: { schema: ASSESS_FORMAT, date, kind, conclusion: {}, ...fields } });
const fr = { askedOn: START, general: { fell: false, unsteady: false, fear: false }, needsSupport: false, hardToStand: false, dizzy: false,
  walk4m: { seconds: 3.5, cane: false, siteOk: true, testedOn: START }, tug: { seconds: 9, cane: false, siteOk: true, chairOk: true, testedOn: START } };
const entry = () => rec(START, "入门", { tests: [{ id: "chair-stand-30s", value: 10, hands: "扶椅子", done: true }], companion: true, doctorCleared: true, doctorDate: START,
  fallRisk: fr, conclusion: { fallRisk: fallRiskConclusion(fr, rr, {}) } });
function ctx(p: Obj, rv: Rv[], assessments: { name: string; raw: Obj }[], now?: string): AssessContext {
  const last = p.segments[p.segments.length - 1].start;
  return { profile: p, manifest, plans, rules, sessions: [], reviewData: Object.fromEntries(rv), assessments, now: new Date(`${now ?? plus(last, 2)}T12:00:00`) };
}
const errs = (c: AssessContext) => checkAssessments(c).filter((i) => i.level === "error").map((i) => `${i.path}：${i.message}`).join("\n");
/** 起始期 4 周 + 稳定期 n 周（第 2 段）；段末照重算的写。 */
function path(stableWeeks: number, each: (i: number) => Obj = () => ({}), extra: Obj = {}) {
  const segs: Seg[] = [[1, 1, C], [1, 2, C], [1, 3, C], [1, 4, C], ...Array.from({ length: stableWeeks }, (_, w) => [2, w + 1, CS] as Seg)];
  const p = profile(segs, extra);
  const rv = p.segments.map((_: unknown, i: number) => review(p, i, each(i)));
  const e: any = segmentEnd(p, 1, Object.fromEntries(rv.slice(0, 4)), ar, "a65·chair");
  const end = rec(plus(p.segments[3].start, 6), "段末", { segment: 1, tests: [{ id: "chair-stand-30s", value: 11, hands: "扶椅子", done: true }], companion: true,
    conclusion: { result: e.result, next: e.next, ...(e.extras.length ? { extras: e.extras } : {}), ...(Object.keys(e.habitTargets).length ? { habitTargets: e.habitTargets } : {}) } });
  if (Object.keys(e.habitTargets).length) p.segments[4].habitTargets = e.habitTargets;
  return { p, rv, e, A: [entry(), end] };
}
const consent = (date: string, items = ["sit12", "sit3sets", "stance30", "step"]) => [{ date, items }];

describe("65 岁以上进稳定期", () => {
  it("≥ 10 练、没有摔倒头晕、习惯都达标：可以进", () => {
    const { p, rv, A, e } = path(1);
    expect(e).toMatchObject({ result: "加一项", upward: true });
    expect(errs(ctx(p, rv, A))).not.toMatch(/进稳定期|稳定期/);
  });
  it("这一段差点摔倒过（先看医生）：不能进", () => {
    const { p, rv, A } = path(1, (i) => (i === 1 ? { nearFalls: 1 } : {}));
    expect(errs(ctx(p, rv, A))).toMatch(/才能进稳定期/);
  });
  it("散步降过的时长还没加回来（下一段有习惯目标）：不能进", () => {
    const { p, rv, A } = path(1, (i) => (i === 2 ? { habits: { 散步: 3, 放松: 5 } } : {}));
    expect(errs(ctx(p, rv, A))).toMatch(/STABLE_ENTRY_HABITS/);
  });
});

describe("65 岁以上稳定期：每周照第 4 周", () => {
  it("第 1 周就是 2 组、坐站起照第 4 周；计划单写每周照第 4 周", () => {
    const { p, rv, A } = path(1);
    const r = exportCourse({ plans, rules, manifest, profile: p, week: 1, day: "A" });
    expect(r.issues.filter((i) => i.level === "error")).toEqual([]);
    expect(r.course!.blocks.flatMap((b) => b.items).find((x) => x.exercise === "a65-01-sit-to-stand")).toMatchObject({ sets: 2, reps: 8 });
    const s = buildSheet(ctx(p, rv, A));
    expect(s.text).toMatch(/每周都照第五章训练单第 4 周那一列练/);
    expect(s.text).toMatch(/## 加一项/);
  });
});

describe("加一项", () => {
  /** 稳定期 5 周（第 2 轮第 1 周 = 第 5 周），第 5 周开始那天加 item。 */
  const add = (item: string, opts: { each?: (i: number) => Obj; extra?: Obj; date?: (p: Obj) => string; clear?: string } = {}) => {
    const r = path(6, opts.each, { addClear: consent(opts.clear ?? START), ...(opts.extra ?? {}) });
    r.p.addOnLog = [{ date: (opts.date ?? ((q: Obj) => q.segments[8].start))(r.p), item, action: "加", why: "上一轮 12 练、没有不适" }];
    return { ...r, c: ctx(r.p, r.rv, r.A) };
  };
  const addErr = (c: AssessContext) => addOnIssues(c).map((i) => i.message).join("\n");
  it("写法：addClear 要有日期和项，addOnLog 要有加 / 减和理由", () => {
    expect(validateAddFields({ addClear: [{ date: START }] }).map((i) => i.message).join()).toMatch(/addClear 是/);
    expect(validateAddFields({ addOnLog: [{ date: START, item: "sit12", action: "加" }] }).map((i) => i.message).join()).toMatch(/addOnLog 是/);
    expect(validateAddFields({ addClear: consent(START), addOnLog: [{ date: START, item: "sit12", action: "加", why: "x" }] })).toEqual([]);
  });
  it("一轮第 1 周、上一轮 12 练、医生同意过：放行；导出坐站起上限到 12 / 组数到 3", () => {
    const a = add("sit12");
    expect(addErr(a.c)).toBe("");
    expect(activeAddOns(a.c, a.p.segments[8].start)).toEqual(["sit12"]);
    a.p.progress = { "a65-01-sit-to-stand": { reps: 12 } };
    const r = exportCourse({ plans, rules, manifest, profile: a.p, week: 5, day: "A", addOns: ["sit12"] });
    expect(r.course!.blocks.flatMap((b) => b.items).find((x) => x.exercise === "a65-01-sit-to-stand")).toMatchObject({ reps: 12 });
    const s3 = exportCourse({ plans, rules, manifest, profile: a.p, week: 5, day: "A", addOns: ["sit3sets"] });
    expect(s3.course!.blocks.flatMap((b) => b.items).find((x) => x.exercise === "a65-01-sit-to-stand")).toMatchObject({ sets: 3, reps: 10 });
    expect(s3.notes.join()).toMatch(/这一周按 10 次做/);
  });
  it("不在一轮第 1 周、没有医生同意、同意里没有这一项：拦下", () => {
    expect(addErr(add("sit12", { date: (q) => q.segments[9].start }).c)).toMatch(/只在一轮的第 1 周加/);
    expect(addErr(add("sit12", { extra: { addClear: undefined } }).c)).toMatch(/没有有效的医生同意/);
    const only = add("stance30");
    only.p.addClear = consent(START, ["sit12"]);
    expect(addErr(ctx(only.p, only.rv, only.A))).toMatch(/没有有效的医生同意/);
  });
  it("上一轮只练 9 次、上一轮头晕过：拦下", () => {
    expect(addErr(add("sit12", { each: (i) => (i >= 4 && i <= 7 ? { trainings: i === 4 ? 0 : 3 } : {}) }).c)).toMatch(/上一轮只练了 9 次/);
    expect(addErr(add("sit12", { each: (i) => (i === 6 ? { dizzy: 1 } : {}) }).c)).toMatch(/这一轮不加项/);
  });
  it("一轮加两项、坐站起两种都加、上下台阶给家里没确认的：拦下", () => {
    const two = add("sit12");
    two.p.addOnLog.push({ date: two.p.segments[8].start, item: "stance30", action: "加", why: "x" });
    expect(addErr(ctx(two.p, two.rv, two.A))).toMatch(/一轮最多加 1 项/);
    const both = path(9, undefined, { addClear: consent(START) });
    both.p.addOnLog = [{ date: both.p.segments[8].start, item: "sit12", action: "加", why: "x" }, { date: both.p.segments[12].start, item: "sit3sets", action: "加", why: "x" }];
    expect(addErr(ctx(both.p, both.rv, both.A))).toMatch(/只能选一种/);
    expect(addErr(add("step", { extra: { conditions: {} } }).c)).toMatch(/要条件「家里没有别人」记了"否"/);
  });
  it("医生同意过期（看了医生没续）：已加的项那一周起去掉", () => {
    const r = path(8, undefined, { addClear: consent(plus(START, -300)) });       // START + 65 天到期
    r.p.addOnLog = [{ date: r.p.segments[8].start, item: "sit12", action: "加", why: "x" }];
    Object.assign(r.p.screening, { date: plus(START, -300), doctorDate: plus(START, -300) });   // 同意和筛查是同一次看医生
    const c = ctx(r.p, r.rv, r.A);
    expect(addOnIssues(c)).toEqual([]);
    expect(activeAddOns(c, r.p.segments[9].start)).toEqual(["sit12"]);            // START + 63
    expect(activeAddOns(c, r.p.segments[10].start)).toEqual([]);                  // START + 70：过期了
  });
});

describe("一轮里摔倒、差点摔倒、头晕（A65_STABLE_FALL）", () => {
  const fallRound = () => path(5, (i) => (i === 5 ? { nearFalls: 1 } : {}));
  const doc = (p: Obj, extra: Obj = {}) => rec(plus(p.segments[7].start, 6), "触发", { reasons: ["看完医生回来"], doctorCleared: true, doctorDate: plus(p.segments[7].start, 6), ...extra });
  it("轮末没看医生就开下一轮：拦下", () => {
    const { p, rv, A } = fallRound();
    expect(errs(ctx(p, rv, A))).toMatch(/这一轮练完先不开下一轮，先看医生/);
  });
  it("看完医生说接着练（doctorRestart false）：放行；没写：报错，而且要回起始期", () => {
    const { p, rv, A } = fallRound();
    expect(errs(ctx(p, rv, [...A, doc(p, { doctorRestart: false })]))).not.toMatch(/先看医生|doctorRestart|回起始期/);
    const e = errs(ctx(p, rv, [...A, doc(p)]));
    expect(e).toMatch(/写明 doctorRestart/);
    expect(e).toMatch(/回起始期那一份，从标准段第 1 周开始/);
  });
  it("医生让从头来：周期中途回起始期标准段，放行", () => {
    const r = path(4, (i) => (i === 5 ? { nearFalls: 1 } : {}));
    r.p.segments.push({ n: 3, type: "标准", week: 1, start: plus(r.p.segments[7].start, 7), product: C });
    const e = errs(ctx(r.p, r.rv, [...r.A, doc(r.p, { doctorRestart: true })]));
    expect(e).not.toMatch(/一个周期没练完就回起始期|先看医生/);
  });
});

describe("65 岁以上周期末", () => {
  const cycle = (each: (i: number) => Obj = () => ({})) => {
    const p = profile(Array.from({ length: 12 }, (_, i) => [1, i + 1, CS] as Seg));
    return { p, rv: p.segments.map((_: unknown, i: number) => review(p, i, each(i))) };
  };
  it("24 练、散步 9 周、放松 7 周：达标；放松 6 周：习惯没达标", () => {
    const pass = cycle((i) => ({ trainings: 2, ...(i === 1 || i === 5 ? { habits: { 散步: 5, 放松: 3 } } : {}) }));
    expect(cycleEnd(ctx(pass.p, pass.rv, []), 1)).toMatchObject({ result: "达标", trainings: 24, habitWeeks: { 散步: 12, 放松: 7 } });
    const miss = cycle((i) => (i === 1 || i === 5 || i === 9 ? { habits: { 散步: 5, 放松: 3 } } : {}));
    expect(cycleEnd(ctx(miss.p, miss.rv, []), 1)).toMatchObject({ result: "习惯没达标", habitWeeks: { 放松: 6 } });
  });
  it("最后一轮头晕过：先看医生（不开）；医生说接着练以后照后面几条（训练 < 24 → 回减量段）", () => {
    const { p, rv } = cycle((i) => ({ trainings: 1, ...(i === 10 ? { dizzy: 1 } : {}) }));
    expect(cycleEnd(ctx(p, rv, []), 1)).toMatchObject({ result: "先看医生", next: { phase: "不开" } });
    expect(cycleEnd(ctx(p, rv, []), 1, { afterDoctor: true })).toMatchObject({ result: "训练没达标", next: { phase: "起始", type: "减量" } });
  });
});

describe("65 岁以上稳定期断了超过 28 天", () => {
  it("回起始期第 1 周（超过 28 天就报）", () => {
    const { p, rv, A } = path(3);
    const e = errs(ctx(p, rv.slice(0, 5), A, plus(p.segments[5].start, 30)));
    expect(e).toMatch(/超过 28 天/);
  });
});
