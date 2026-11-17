// 成人稳定期的目标（v4 阶段 4）：谁能选、中途退回、减脂的有氧台阶、周期末下一周期能选什么、计划单。
// 每条规则有拦下 / 放行用例。只用 contracts/fixtures/。
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";
import { ASSESS_FORMAT, type AssessContext, validateAssessment } from "../src/assess.ts";
import { bmrTwo, bodyStateOn, cutCardio, cycleGoals, goalCardioHint, goalGate, goalIssues, goalSheetLines, validateGoalFields } from "../src/goals.ts";
import { checkNotes } from "../src/profile.ts";
import { REVIEW_FORMAT, validateReview } from "../src/progress.ts";
import { CONTRACTS, FIX, fitAge, fixtureManifest, fixturePlans, fixtureRules, readJson } from "./helpers.ts";

const manifest = fixtureManifest();
const plans = fixturePlans();
const rules = fixtureRules();
const STARTER = "18-39岁-纯徒手版";
const STABLE = "18-39岁-纯徒手版（稳定期）";
const STABLE40 = "40-64岁-纯徒手版（稳定期）";
const START = "2026-01-05";
const plus = (d: string, n: number) => new Date(new Date(`${d}T12:00:00Z`).getTime() + n * 86_400_000).toISOString().slice(0, 10);
type Obj = Record<string, any>;

/** 起始期 4 周（第 1 段），之后稳定期第 2 段 stableWeeks 周（每项隔 7 天）。 */
function profile(stableWeeks: number, goal: string | ((w: number) => string) = "减脂", extra: Obj = {}) {
  const p = readJson<Obj>(`${FIX}profiles/ok-a18-home.json`);
  const segs: Obj[] = [];
  for (let w = 1; w <= 4; w++) segs.push({ n: 1, type: "标准", week: w, start: plus(START, 7 * (w - 1)), product: STARTER });
  for (let w = 1; w <= stableWeeks; w++) {
    const g = typeof goal === "function" ? goal(w) : goal;
    segs.push({ n: 2, phase: "稳定", type: "标准", week: w, start: plus(START, 7 * (3 + w)), product: STABLE, ...(g !== "保持" ? { goal: g } : {}) });
  }
  p.segments = segs;
  const prod = manifest.products.find((x) => x.name === STABLE)!;
  Object.assign(p, { age: "a18", stage: "18–39 岁", product: STABLE, venue: prod.venue, startDate: START, birth: "1996-03", body: "记" });
  delete p.wake;
  delete p.bedtime;
  const items = manifest.intake.screening.find((s) => s.age === "a18")!.items;
  p.screening = { answers: items.map((item) => ({ item, answer: "否" })), doctorCleared: false, date: START };
  fitAge(p, "a18");
  p.birth = "1996-03";
  p.conditions = { 高血压: false };
  return Object.assign(p, extra);
}
const stableStart = plus(START, 28);
const rec = (date: string, kind: string, fields: Obj = {}): { name: string; raw: Obj } => ({ name: `评估/${date}-${kind}.json`, raw: { schema: ASSESS_FORMAT, date, kind, conclusion: {}, ...fields } });
/** 入门（身高 170）和第 1 段段末（开稳定期，带体重腰围）。 */
const recs = (body: Obj = { weight: 75, waist: 88 }, open: Obj = { goal: "减脂", eatingCheck: "问过" }) => [
  rec(START, "入门", { body: { height: 170, weight: 76, waist: 89 } }),
  rec(plus(stableStart, -1), "段末", { segment: 1, body, ...open }),
];
const review = (p: Obj, i: number, fields: Obj = {}): [string, Obj] => {
  const s = p.segments[i];
  return [`${s.start}-第${s.week}周.json`, { schema: REVIEW_FORMAT, start: s.start, week: s.week, trainings: 4, symptoms: false, moves: [], ...fields }];
};
const ctx = (p: Obj, assessments: any[], rv: [string, Obj][] = []): AssessContext =>
  ({ profile: p, manifest, plans, rules, sessions: [], reviewData: Object.fromEntries(rv), assessments, now: new Date(`${plus(p.segments[p.segments.length - 1].start, 2)}T12:00:00`) });
const errs = (c: AssessContext) => goalIssues(c).filter((i) => i.level === "error").map((i) => `${i.path}：${i.message}`).join("\n");
const firstStable = 4;

describe("写法", () => {
  it("goal 只能是保持、减脂、增肌；bodyLog 要和 body、bodyStopDate 对得上；cardioClear 只记日期", () => {
    const p = profile(1);
    expect(validateGoalFields(p)).toEqual([]);
    p.segments[4].goal = "塑形";
    expect(validateGoalFields(p).map((i) => i.message).join()).toMatch(/goal 只能是/);
    const q = profile(1, "保持", { body: "停记", bodyStopDate: "2026-03-01", bodyLog: [{ date: START, body: "记" }, { date: "2026-02-01", body: "停记" }] });
    expect(validateGoalFields(q).map((i) => i.message).join()).toMatch(/最后一次停记是 2026-02-01/);
    q.bodyLog[1].date = "2026-03-01";
    expect(validateGoalFields(q)).toEqual([]);
    expect(validateGoalFields(profile(1, "保持", { cardioClear: { date: START, note: "医生说可以" } })).map((i) => i.message).join()).toMatch(/cardioClear 是 \{ date \}/);
  });
  it("评估：选减脂、增肌要问过进食困扰；答了有只能保持", () => {
    const v = (x: Obj) => validateAssessment({ schema: ASSESS_FORMAT, date: START, kind: "段末", segment: 1, conclusion: {}, ...x }).map((i) => i.message).join();
    expect(v({ goal: "减脂" })).toMatch(/进食困扰/);
    expect(v({ goal: "减脂", eatingCheck: "只能保持" })).toMatch(/只能选保持/);
    expect(v({ goal: "保持", eatingCheck: "只能保持" })).toBe("");
    expect(v({ goal: "减脂", eatingCheck: "问过" })).toBe("");
  });
  it("复盘：体重一位小数、有氧分钟整数、没力气是 / 否", () => {
    const base = { schema: REVIEW_FORMAT, start: START, week: 1, trainings: 3, symptoms: false, moves: [] };
    expect(validateReview({ ...base, weight: 70.25 }).map((i) => i.message).join()).toMatch(/一位小数/);
    expect(validateReview({ ...base, weight: 70.2, cardioMinutes: 120, tired: false })).toEqual([]);
    expect(validateReview({ ...base, cardioMinutes: 12.5 }).map((i) => i.message).join()).toMatch(/cardioMinutes/);
  });
  it("JSON Schema 认得目标的字段", () => {
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    addFormats(ajv);
    const sch = (f: string) => ajv.compile(readJson(`${CONTRACTS}${f}`) as object);
    const prof = sch("profile.schema.json");
    const p = profile(1, "减脂", { cardioClear: { date: START }, bodyLog: [{ date: START, body: "记" }] });
    expect(prof(p)).toBe(true);
    expect(prof({ ...p, cardioClear: { date: START, by: "医生" } })).toBe(false);
    const rv = sch("review.schema.json");
    expect(rv({ schema: REVIEW_FORMAT, start: START, week: 1, trainings: 3, symptoms: false, moves: [], weight: 70.2, cardioMinutes: 120, tired: false })).toBe(true);
    const as = sch("assessment.schema.json");
    expect(as({ schema: ASSESS_FORMAT, date: START, kind: "段末", segment: 1, goal: "减脂", eatingCheck: "问过", conclusion: {} })).toBe(true);
    expect(as({ schema: ASSESS_FORMAT, date: START, kind: "段末", segment: 1, goal: "塑形", conclusion: {} })).toBe(false);
  });
  it("没有 bodyLog 的老档案：停记那天以前按记", () => {
    const p = profile(1, "保持", { body: "停记", bodyStopDate: "2026-03-01" });
    expect(bodyStateOn(p, "2026-02-28")).toBe("记");
    expect(bodyStateOn(p, "2026-03-01")).toBe("停记");
  });
});

describe("谁能选", () => {
  const gate = (body: Obj, extra: Obj = {}, open: Obj = { goal: "减脂", eatingCheck: "问过" }) => goalGate(ctx(profile(1, "保持", extra), recs(body, open)), firstStable);
  it("BMI 和腰围：超重能减脂不能增肌；正常腰围细能增肌；腰围 85–89 都不选；腰围 90 以上能减脂；肥胖只保持", () => {
    expect(gate({ weight: 75, waist: 80 }).allowed).toEqual(["保持", "减脂"]);           // BMI 26
    expect(gate({ weight: 63, waist: 80 }).allowed).toEqual(["保持", "增肌"]);           // BMI 21.8
    expect(gate({ weight: 63, waist: 87 }).allowed).toEqual(["保持"]);
    expect(gate({ weight: 63, waist: 91 }).allowed).toEqual(["保持", "减脂"]);
    expect(gate({ weight: 82, waist: 95 }).allowed).toEqual(["保持"]);                  // BMI 28.4
  });
  it("BMI 不到 18.5：增肌要医生或营养师同意（记在开周期的评估）", () => {
    expect(gate({ weight: 52, waist: 70 }).allowed).toEqual(["保持"]);
    expect(gate({ weight: 52, waist: 70 }, {}, { goal: "增肌", eatingCheck: "问过", goalConsent: { date: plus(stableStart, -3) } }).allowed).toEqual(["保持", "增肌"]);
  });
  it("没选记、停记、进食困扰答了有、身体数据超过 28 天、12 周里满 40 岁：只保持", () => {
    expect(gate({ weight: 75, waist: 80 }, { body: "不记" }).allowed).toEqual(["保持"]);
    expect(gate({ weight: 75, waist: 80 }, {}, { goal: "保持", eatingCheck: "只能保持" }).allowed).toEqual(["保持"]);
    const old = goalGate(ctx(profile(1, "保持"), [rec(plus(START, -1), "入门", { body: { height: 170, weight: 76, waist: 89 } })]), firstStable);
    expect(old.why.join()).toMatch(/28 天以内没有量过/);
    expect(gate({ weight: 75, waist: 80 }, { birth: "1986-04" }).why.join()).toMatch(/满 40 岁或 65 岁/);
  });
  it("起始期不分目标；选了不能选的目标、开周期的评估和档案不一致：拦下", () => {
    const p = profile(1);
    p.segments[0].goal = "减脂";
    expect(errs(ctx(p, recs()))).toMatch(/起始期不分目标/);
    expect(errs(ctx(profile(1, "增肌"), recs({ weight: 75, waist: 80 }, { goal: "增肌", eatingCheck: "问过" })))).toMatch(/只能选 保持、减脂/);
    expect(errs(ctx(profile(1), recs({ weight: 75, waist: 80 }, { goal: "保持" })))).toMatch(/写的目标是保持/);
    expect(errs(ctx(profile(1), recs({ weight: 75, waist: 80 })))).toBe("");
  });
});

describe("中途退回保持", () => {
  it("一个周期里只能往保持退，退了不能改回去，也不能换成另一个目标", () => {
    expect(errs(ctx(profile(3, (w) => (w === 1 ? "减脂" : "保持")), recs({ weight: 75, waist: 80 })))).toBe("");
    expect(errs(ctx(profile(3, (w) => (w === 2 ? "保持" : "减脂")), recs({ weight: 75, waist: 80 })))).toMatch(/不能退回以后再改回去/);
    expect(errs(ctx(profile(2, (w) => (w === 1 ? "减脂" : "增肌")), recs({ weight: 75, waist: 80 })))).toMatch(/不能换成增肌/);
  });
  it("停记那一周起要退回保持", () => {
    const stop = plus(stableStart, 9);                 // 第 2 周里
    const p = profile(3, "减脂", { body: "停记", bodyStopDate: stop });
    expect(errs(ctx(p, recs({ weight: 75, waist: 80 })))).toMatch(/segments\[5\]\.goal：.*起不记（或停记）/);
    const q = profile(3, (w) => (w === 1 ? "减脂" : "保持"), { body: "停记", bodyStopDate: stop });
    expect(errs(ctx(q, recs({ weight: 75, waist: 80 })))).toBe("");
  });
  it("减脂第 3 周以后连着 4 次称重平均每周掉超过 1 kg：下一周起退回；头两周掉得快不算", () => {
    const p = profile(8);
    const ws = [74, 72.5, 73, 71.8, 70.6, 69.4, 68.2];   // 第 3–6 周每周掉 1.2
    const rv = ws.map((w, k) => review(p, firstStable + k, { weight: w, cardioMinutes: 100 }));
    expect(errs(ctx(p, recs({ weight: 75, waist: 80 }), rv))).toMatch(/segments\[11\]\.goal：连着 4 次称重平均每周掉了 1\.2 kg/);
    const slow = [74, 72, 72, 71.6, 71.2, 70.8, 70.4].map((w, k) => review(p, firstStable + k, { weight: w }));
    expect(errs(ctx(p, recs({ weight: 75, waist: 80 }), slow))).toBe("");
  });
  it("体重、有氧分钟只给这一周按减脂的人", () => {
    const p = profile(2, "保持");
    expect(errs(ctx(p, recs({ weight: 75, waist: 80 }, { goal: "保持" }), [review(p, firstStable, { weight: 74 })]))).toMatch(/weight 只给这一周按减脂的人/);
  });
});

describe("减脂的有氧台阶", () => {
  const steps = (p: Obj, rv: [string, Obj][], a = recs({ weight: 75, waist: 80 })) => p.segments.map((_: unknown, i: number) => cutCardio(ctx(p, a, rv), i)?.minutes ?? null);
  it("18–39 岁：连着两周做到、每档至少 2 周才升；没做到不升", () => {
    const p = profile(7);
    const did = (m: number[]) => m.map((x, k) => review(p, firstStable + k, { cardioMinutes: x }));
    expect(steps(p, did([100, 100, 150, 150, 200, 200]))).toEqual([null, null, null, null, 100, 100, 150, 150, 200, 200, 250]);
    expect(steps(p, did([100, 80, 100, 100, 150, 150]))).toEqual([null, null, null, null, 100, 100, 100, 100, 150, 150, 200]);
  });
  it("这一轮有疼痛、头晕、胸闷：这一轮不升；下一轮先有一整周没有不适", () => {
    const p = profile(7);
    const rv = [100, 100, 150, 150, 150, 150].map((x, k) => review(p, firstStable + k, { cardioMinutes: x, symptoms: k === 1 }));
    // 第 2 周不适：第 1 轮不升；第 2 轮第 1 周（第 5 周）没有不适以后，第 6 周才升
    expect(steps(p, rv)).toEqual([null, null, null, null, 100, 100, 100, 100, 100, 150, 150]);
  });
  it("40–64 岁：每档至少 4 周", () => {
    const p = profile(7, "减脂", { birth: "1980-03", age: "a40", stage: "40–64 岁" });
    p.segments.forEach((s: Obj) => { s.product = s.phase === "稳定" ? STABLE40 : "40-64岁-纯徒手版"; });
    p.product = STABLE40;
    const rv = [100, 100, 100, 100, 150, 150].map((x, k) => review(p, firstStable + k, { cardioMinutes: x }));
    expect(steps(p, rv).slice(4)).toEqual([100, 100, 100, 100, 150, 150, 150]);
  });
  it("有高血压（或没确认）的：没有带日期的医生同意就照保持的量；同意早于最近一次筛查也不算", () => {
    const p = profile(2, "减脂", { conditions: { 高血压: true } });
    const c = cutCardio(ctx(p, recs({ weight: 75, waist: 80 })), firstStable);
    expect(c?.doctor).toMatch(/先问医生/);
    p.cardioClear = { date: plus(START, -10) };
    expect(cutCardio(ctx(p, recs({ weight: 75, waist: 80 })), firstStable)?.doctor).toMatch(/要在 2026-01-05 之后/);
    p.cardioClear = { date: plus(stableStart, -2) };
    expect(cutCardio(ctx(p, recs({ weight: 75, waist: 80 })), firstStable)).toMatchObject({ minutes: 100, step: 1 });
  });
  it("中断回来（触发评估：中断）：回到第一档", () => {
    const p = profile(5);
    const rv = [100, 100, 150, 150].map((x, k) => review(p, firstStable + k, { cardioMinutes: x }));
    const back = rec(plus(p.segments[8].start, -1), "触发", { reasons: ["中断"] });
    expect(cutCardio(ctx(p, [...recs({ weight: 75, waist: 80 }), back], rv), 8)?.minutes).toBe(100);
  });
});

describe("周期末下一周期能选什么", () => {
  const cycle = (goal: string, endBody: Obj, start: Obj = { weight: 75, waist: 80 }, rvf?: (k: number) => Obj) => {
    const p = profile(12, goal);
    const rv = rvf ? Array.from({ length: 12 }, (_, k) => review(p, firstStable + k, rvf(k))) : [];
    const end = rec(plus(p.segments[15].start, 6), "周期末", { segment: 2, body: endBody });
    return cycleGoals(ctx(p, [...recs(start, { goal, eatingCheck: "问过" }), end], rv), 2, end);
  };
  it("减脂：到了 BMI 24 以下、腰围 90 以下 → 保持；没到 → 可以接着", () => {
    expect(cycle("减脂", { weight: 68, waist: 80 })?.goals).toEqual(["保持"]);
    expect(cycle("减脂", { weight: 72, waist: 80 })?.goals).toEqual(["保持", "减脂"]);
  });
  it("增肌：12 周体重涨超过 3% → 保持；腰围到 85 → 保持", () => {
    expect(cycle("增肌", { weight: 66, waist: 80 }, { weight: 63, waist: 80 })?.goals).toEqual(["保持"]);
    expect(cycle("增肌", { weight: 64, waist: 85 }, { weight: 63, waist: 80 })?.goals).toEqual(["保持"]);
    expect(cycle("增肌", { weight: 64, waist: 81 }, { weight: 63, waist: 80 })?.goals).toEqual(["保持", "增肌"]);
  });
  it("保持的周期：按周期末量的 BMI、腰围过一遍那张表；没量的照谁能选", () => {
    expect(cycle("保持", { weight: 72, waist: 80 })?.goals).toEqual(["保持", "减脂"]);     // BMI 24.9
    expect(cycle("保持", { weight: 62, waist: 80 })?.goals).toEqual(["保持", "增肌"]);     // BMI 21.5
    expect(cycle("保持", { weight: 62, waist: 87 })?.goals).toEqual(["保持"]);
  });
});

describe("计划单和导出提示", () => {
  it("减脂：写有氧分钟、基础代谢男女两栏、称体重；筛查第 3 项\"是\"的吃照医生；保持的不写", () => {
    const p = profile(1);
    const c = ctx(p, recs({ weight: 75, waist: 80 }));
    const text = goalSheetLines(c, firstStable).join("\n");
    expect(text).toMatch(/这一周合计 \*\*100 分钟\*\*/);
    const b = bmrTwo(c, stableStart)!;
    expect(b).toMatchObject({ height: 170, weight: 75 });
    expect(text).toContain(`男约 ${b.male} kcal、女约 ${b.female} kcal`);
    expect(goalCardioHint(c, firstStable)).toMatch(/100 分钟/);
    p.screening.answers = p.screening.answers.map((a: Obj) => (/糖尿病/.test(a.item) ? { ...a, answer: "是" } : a));
    expect(goalSheetLines(ctx(p, recs({ weight: 75, waist: 80 })), firstStable).join("\n")).toMatch(/吃：照医生的意见/);
    expect(goalSheetLines(ctx(profile(1, "保持"), recs()), firstStable)).toEqual([]);
  });
  it("这一轮有过不适或练完没力气：吃回到保持", () => {
    const p = profile(2);
    const text = goalSheetLines(ctx(p, recs({ weight: 75, waist: 80 }), [review(p, firstStable, { tired: true, cardioMinutes: 100 })]), firstStable + 1).join("\n");
    expect(text).toMatch(/吃回到保持/);
  });
});

describe("菜单（4b）", () => {
  it("选了目标的成年人，菜单上只写份量：写了减脂、增肌、千卡的拦下", () => {
    const menu = (t: string) => checkNotes(manifest.redlines, ["fam", "a18"], "菜单/第1周.md", t).map((i) => i.message).join();
    expect(menu("你那一份肉少盛一些、主食少半个馒头")).toBe("");
    expect(menu("你那一份主食多半个馒头")).toBe("");
    expect(menu("增肌的那一份主食多盛")).toMatch(/增肌/);
    expect(menu("减脂期间少吃 300 千卡")).toMatch(/减脂|千卡/);
  });
});


describe("实施审查的修订", () => {
  const ok = { weight: 75, waist: 80 };
  /** 再接一段稳定期（第 3 段）weeks 周。 */
  const addSeg = (p: Obj, weeks: number, goal: string) => {
    const last = p.segments[p.segments.length - 1];
    for (let w = 1; w <= weeks; w++) p.segments.push({ n: 3, phase: "稳定", type: "标准", week: w, start: plus(last.start, 7 * w), product: STABLE, ...(goal !== "保持" ? { goal } : {}) });
    return p;
  };
  it("M1 没有医生同意的那几周不算进升档：同意以后从第一档开始", () => {
    const p = profile(8, "减脂", { conditions: { 高血压: true } });
    const rv = [110, 150, 160, 210, 210, 210].map((x, k) => review(p, firstStable + k, { cardioMinutes: x }));
    p.cardioClear = { date: plus(p.segments[10].start, -1) };
    expect(cutCardio(ctx(p, recs(ok), rv), 10)).toMatchObject({ minutes: 100, step: 1 });
    p.screening.date = plus(p.segments[10].start, 1);        // 之后重做了筛查：同意要重新问
    expect(cutCardio(ctx(p, recs(ok), rv), 11)?.doctor).toMatch(/先问医生/);
  });
  it("M2 BMI 一律用最早那份身高：段末里写别的身高不改结论，还报错", async () => {
    const { checkRecord } = await import("../src/assess.ts");
    const r = recs({ height: 160, weight: 68, waist: 80 });
    expect(goalGate(ctx(profile(1, "保持"), r), firstStable).allowed).toEqual(["保持", "增肌"]);    // 170 cm 算 23.5
    expect(checkRecord(ctx(profile(1, "保持"), r), r[1], STARTER, false).map((i) => i.message).join()).toMatch(/身高记在入门/);
  });
  it("M3 开周期的评估按位置认：第二个减脂周期的周期末没问进食困扰，不能拿上一份顶替", () => {
    const p = addSeg(profile(12, "减脂"), 1, "减脂");
    const end = rec(plus(p.segments[15].start, 6), "周期末", { segment: 2, body: { weight: 73, waist: 80 } });
    expect(errs(ctx(p, [...recs(ok), end]))).toMatch(/写的目标是（没写）/);
    end.raw.goal = "减脂";
    expect(errs(ctx(p, [...recs(ok), end]))).toMatch(/没问进食困扰/);
    end.raw.eatingCheck = "问过";
    expect(errs(ctx(p, [...recs(ok), end]))).not.toMatch(/进食困扰|写的目标/);
  });
  it("M4 改过记不记却没有 bodyLog：拦下", () => {
    expect(errs(ctx(profile(1, "保持", { body: "记", bodyStopDate: "2026-01-20" }), recs(ok, { goal: "保持" })))).toMatch(/停记以后又改回了记，要写 bodyLog/);
    expect(errs(ctx(profile(1, "保持", { body: "不记" }), recs(ok, { goal: "保持" })))).toMatch(/以前记过体重腰围/);
    const q = profile(1, "保持", { body: "不记", bodyLog: [{ date: START, body: "记" }, { date: plus(stableStart, 2), body: "不记" }] });
    expect(errs(ctx(q, recs(ok, { goal: "保持" })))).not.toMatch(/bodyLog/);
  });
  it("M5 评估里的身体数据按记录那天：以前记的不报，停记那段时间记的报", async () => {
    const { checkRecord } = await import("../src/assess.ts");
    const q = profile(1, "保持", { body: "不记", bodyLog: [{ date: START, body: "记" }, { date: plus(stableStart, 2), body: "不记" }] });
    const r = recs(ok, { goal: "保持" });
    expect(checkRecord(ctx(q, r), r[0], STARTER, true).map((i) => i.message).join()).not.toMatch(/不能有身体数据/);
    const s = profile(1, "保持", { bodyLog: [{ date: START, body: "记" }, { date: plus(START, 3), body: "停记" }, { date: plus(stableStart, 2), body: "记" }], body: "记" });
    expect(checkRecord(ctx(s, r), r[1], STARTER, false).map((i) => i.message).join()).toMatch(/那天档案是"停记"/);
  });
  it("M6 上一周期\"第 1 轮不升级\"：新的减脂周期第 1 轮有氧也不升档", () => {
    const p = addSeg(profile(12, "保持"), 6, "减脂");
    const end = rec(plus(p.segments[15].start, 6), "周期末", { segment: 2, body: ok, goal: "减脂", eatingCheck: "问过", conclusion: { result: "习惯没达标", next: { phase: "稳定", hold: true } } });
    const rv = [100, 100, 100, 100, 150].map((x, k) => review(p, 16 + k, { cardioMinutes: x }));
    const at = (i: number) => cutCardio(ctx(p, [...recs(ok, { goal: "保持" }), end], rv), i)?.minutes;
    expect([at(18), at(19), at(20)]).toEqual([100, 100, 150]);
  });
  it("M8 计划单的基础代谢只用这一周开始以前的体重（以前几周的单子不会因为后来记了体重对不上）", () => {
    const p = profile(2);
    const c = ctx(p, recs(ok), [review(p, firstStable, { weight: 74.2, cardioMinutes: 100 })]);
    expect(bmrTwo(c, p.segments[firstStable].start)?.weight).toBe(75);
    expect(bmrTwo(c, p.segments[firstStable + 1].start)?.weight).toBe(74.2);
  });
  it("减脂中途 BMI 掉到 18.5 以下：下一周起退回", () => {
    const p = profile(3);
    expect(errs(ctx(p, recs(ok), [review(p, firstStable, { weight: 53 })]))).toMatch(/segments\[5\]\.goal：.*BMI 不到 18\.5/);
  });
  it("增肌中途：中断回来的触发评估量到腰围 85，之后的周退回", () => {
    const p = profile(4, "增肌");
    const back = rec(plus(p.segments[6].start, -1), "触发", { reasons: ["中断"], body: { weight: 64, waist: 86 } });
    expect(errs(ctx(p, [...recs({ weight: 63, waist: 80 }, { goal: "增肌", eatingCheck: "问过" }), back]))).toMatch(/segments\[6\]\.goal：.*腰围到了 85/);
  });
  it("周期末：减脂因为掉太快退回过 → 下一周期只能保持；自己说不减的照常选", () => {
    const fast = profile(12, (w) => (w <= 7 ? "减脂" : "保持"));
    const ws = [74, 73, 72, 70.8, 69.6, 68.4, 67.2];
    const rv = ws.map((w, k) => review(fast, firstStable + k, { weight: w }));
    const end = rec(plus(fast.segments[15].start, 6), "周期末", { segment: 2, body: { weight: 70, waist: 80 } });
    expect(cycleGoals(ctx(fast, [...recs(ok), end], rv), 2, end)?.goals).toEqual(["保持"]);
    const quit = profile(12, (w) => (w <= 4 ? "减脂" : "保持"));
    const end2 = rec(plus(quit.segments[15].start, 6), "周期末", { segment: 2, body: { weight: 74, waist: 80 } });
    expect(cycleGoals(ctx(quit, [...recs(ok), end2]), 2, end2)?.goals).toEqual(["保持", "减脂"]);
  });
  it("停记以后：要先完整练一个保持周期才能再选减脂", () => {
    const p = profile(1, "保持", { body: "记", bodyLog: [{ date: START, body: "记" }, { date: plus(START, 3), body: "停记" }, { date: plus(START, 20), body: "记" }] });
    expect(goalGate(ctx(p, recs(ok, { goal: "减脂", eatingCheck: "问过" })), firstStable).why.join()).toMatch(/停记过体重：先完整练一个保持周期/);
  });
  it("周期末那一周：复盘的体重和周期末评估的体重只算一次", () => {
    const p = profile(12);
    const end = rec(plus(p.segments[15].start, 6), "周期末", { segment: 2, body: { weight: 72, waist: 80 } });
    expect(errs(ctx(p, [...recs(ok), end], [review(p, 15, { weight: 72 })]))).toMatch(/已经记在 评估\//);
  });
  it("S4 没真的断够 28 天的\"中断\"触发评估：不能记身体数据", async () => {
    const { checkAssessments } = await import("../src/assess.ts");
    const p = profile(3, "保持");
    const rv = p.segments.slice(0, -1).map((_: unknown, i: number) => review(p, i));
    const fake = rec(plus(p.segments[6].start, 1), "触发", { reasons: ["中断"], body: { weight: 74, waist: 80 } });
    expect(checkAssessments(ctx(p, [...recs(ok, { goal: "保持" }), fake], rv)).map((i) => i.message).join()).toMatch(/不能记身体数据/);
  });
  it("直接进稳定期：第 1 轮按保持（计划单标题写第 2 轮起），掉太快从第 2 轮开始数", () => {
    const p = profile(1);
    p.segments = Array.from({ length: 9 }, (_, k) => ({ n: 1, phase: "稳定", type: "标准", week: k + 1, start: plus(START, 7 * k), product: STABLE, goal: "减脂" }));
    const entryRec = rec(START, "入门", { body: { height: 170, weight: 75, waist: 80 }, goal: "减脂", eatingCheck: "问过", base: 2 });
    expect(goalSheetLines(ctx(p, [entryRec]), 0)[0]).toBe("## 目标：减脂（第 2 轮起）");
    expect(cutCardio(ctx(p, [entryRec]), 3)).toBeNull();
    const rv = [75, 75, 75, 75, 73.5, 72.3, 71.1, 69.9].map((w, k) => review(p, k, { weight: w }));
    // 第 5、6 周（生效的头两周）掉得快不算；第 7 周起才数
    expect(errs(ctx(p, [entryRec], rv.filter((_, k) => k >= 4).map(([n, r]) => [n, r]) as any))).not.toMatch(/掉了/);
  });
});
