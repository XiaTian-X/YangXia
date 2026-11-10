// 评估（v4 阶段 2）：年龄段推算、段末结论重算、评估记录和档案目录的核对。每条规则有拦下 / 放行用例。
// 只用 contracts/fixtures/（规则参数是模板 rules.json 的离线样例），模板仓库不在也会跑。
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";
import { ASSESS_FORMAT, type AssessContext, ageAt, assessRules, bmiCuts, checkAssessments, doctorNeed, gap, segmentEnd, validateAssessment } from "../src/assess.ts";
import { exportCourse, checkPlanCourse } from "../src/plan.ts";
import { REVIEW_FORMAT, checkProgressLog } from "../src/progress.ts";
import { validateProfile } from "../src/profile.ts";
import { CONTRACTS, FIX, fitAge, fixtureManifest, fixturePlans, fixtureRules, readJson } from "./helpers.ts";

const manifest = fixtureManifest();
const plans = fixturePlans();
const rules = fixtureRules();
const ar = assessRules(rules)!;
const STAGE: Record<string, string> = { a06: "小学", a13: "初中", a18: "18–39 岁", a40: "40–64 岁", a65: "65 岁以上" };
const DAY = 86_400_000;
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
const plus = (d: string, n: number) => iso(new Date(`${d}T12:00:00Z`).getTime() + n * DAY);
const START = "2026-06-01";

/** 某份成品的档案，segments 按 weeks 列出（[n, week, type?]），每项相隔 7 天。 */
function profile(product: string, weeks: [number, number, string?][] = [[1, 1]], extra: Record<string, any> = {}) {
  const p = readJson<Record<string, any>>(`${FIX}profiles/ok-a18-home.json`);
  const prod = manifest.products.find((x) => x.name === product)!;
  Object.assign(p, { age: prod.age, stage: STAGE[prod.age], product, venue: prod.venue, startDate: START });
  delete p.wake;
  delete p.bedtime;
  const items = manifest.intake.screening.find((s) => s.age === prod.age)?.items ?? ["（无）"];
  p.screening = { answers: items.map((item) => ({ item, answer: "否" })), doctorCleared: true, date: START, doctorDate: START };
  p.segments = weeks.map(([n, week, type], i) => ({ n, type: type ?? "标准", week, start: plus(START, 7 * i), product }));
  fitAge(p, prod.age);
  if (prod.age === "a18" || prod.age === "a40") p.body = "不记";
  return Object.assign(p, extra);
}
/** 每个年龄段周复盘要问的打卡项和次数（全部达标、没摔倒、没生病）。 */
const DEFAULTS: Record<string, Record<string, any>> = {
  a18: { habits: { 散步: 5, 冥想: 5 } }, a40: { habits: { 散步: 5, 冥想: 5 } },
  a13: { habits: { 动够60分钟: 5, 按时上床: 5 } },
  a65: { habits: { 散步: 5, 放松: 5 }, falls: 0, nearFalls: 0, dizzy: 0 },
  a06: { habits: { 动够60分钟: 6, 按时上床: 6, 视屏少于2小时: 6 }, sickDays: 0 },
};
type Rv = [string, Record<string, any>];
const review = (p: Record<string, any>, i: number, fields: Record<string, any> = {}): Rv => {
  const s = p.segments[i];
  const age = manifest.products.find((x) => x.name === s.product)!.age;
  return [`${s.start}-第${s.week}周.json`, { schema: REVIEW_FORMAT, start: s.start, week: s.week, trainings: 4, checkinDays: 6, symptoms: false, moves: [], ...DEFAULTS[age], ...fields }];
};
const rec = (date: string, kind: string, fields: Record<string, any> = {}): { name: string; raw: Record<string, any> } => ({ name: `评估/${date}-${kind}.json`, raw: { schema: ASSESS_FORMAT, date, kind, ...fields } });
const entry = (p: Record<string, any>, fields: Record<string, any> = {}) => rec(p.segments[0].start, "入门", fields);
function ctx(p: Record<string, any>, reviews: [string, Record<string, any>][], assessments: { name: string; raw: Record<string, any> }[], now?: string): AssessContext {
  const last = p.segments[p.segments.length - 1].start;
  return { profile: p, manifest, plans, rules, sessions: [], reviewData: Object.fromEntries(reviews), assessments, now: new Date(`${now ?? plus(last, 3)}T12:00:00`) };
}
const errs = (c: AssessContext) => checkAssessments(c).filter((i) => i.level === "error").map((i) => `${i.path}：${i.message}`);
const warns = (c: AssessContext) => checkAssessments(c).filter((i) => i.level === "warning").map((i) => i.message);
const fullSeg = (n: number, type?: string): [number, number, string?][] => [1, 2, 3, 4].map((w) => [n, w, type]);
/** 第 1 段四周 + 第 2 段第 1 周，复盘每周 trainings 次。 */
function twoSegs(product: string, trainings: number | number[], fields: Record<string, any> = {}, type2 = "标准") {
  const p = profile(product, [...fullSeg(1), [2, 1, type2]]);
  const t = Array.isArray(trainings) ? trainings : [trainings, trainings, trainings, trainings];
  const rv = [0, 1, 2, 3].map((i) => review(p, i, { trainings: t[i], ...(typeof fields[i] === "object" ? fields[i] : fields.all ?? {}) })) as [string, Record<string, any>][];
  return { p, rv };
}
const endRec = (p: Record<string, any>, n: number, conclusion: Record<string, any>, more: Record<string, any> = {}) =>
  rec(plus(p.segments.filter((s: any) => s.n === n).at(-1).start, 6), "段末", { segment: n, conclusion, ...more });

describe("年龄段、学段推算", () => {
  const p = (x: Record<string, any>) => ({ age: "a18", ...x });
  it("成年人按出生月份的 1 日算：满 40、满 65 当月起换", () => {
    expect(ageAt(p({ birth: "1986-12" }), "2026-11-30", ar.assess).age).toBe("a18");
    expect(ageAt(p({ birth: "1986-12" }), "2026-12-01", ar.assess).age).toBe("a40");
    expect(ageAt(p({ birth: "1961-12" }), "2026-12-01", ar.assess).age).toBe("a65");
  });
  it("在校按 9 月 1 日升学：六三制、五四制", () => {
    const s63 = { school: { stage: "小学", entry: 2020 } };
    expect(ageAt(p(s63), "2026-08-31", ar.assess)).toMatchObject({ age: "a06", stage: "小学" });
    expect(ageAt(p(s63), "2026-09-01", ar.assess)).toMatchObject({ age: "a13", stage: "初中" });
    const s54 = { school: { stage: "小学", entry: 2021, system: "54" } };
    expect(ageAt(p(s54), "2026-09-01", ar.assess)).toMatchObject({ age: "a13", stage: "初中" });
    expect(ageAt(p({ school: { stage: "初中", entry: 2023 } }), "2026-09-01", ar.assess)).toMatchObject({ stage: "高中" });
  });
  it("高中毕业：满 18 岁才换成人版；没记出生年月要补", () => {
    const g = { school: { stage: "高中", entry: 2023 } };
    expect(ageAt(p(g), "2026-09-01", ar.assess).problem).toMatch(/补记出生年月/);
    expect(ageAt(p({ ...g, birth: "2009-03" }), "2026-09-01", ar.assess)).toMatchObject({ age: "a13", stage: "高中" });
    expect(ageAt(p({ ...g, birth: "2008-05" }), "2026-09-01", ar.assess)).toMatchObject({ age: "a18" });
  });
  it("不在校的 13–17 岁按年龄：13–15 初中、16–17 高中", () => {
    expect(ageAt(p({ birth: "2012-01" }), "2026-11-01", ar.assess)).toMatchObject({ age: "a13", stage: "初中" });
    expect(ageAt(p({ birth: "2010-01" }), "2026-11-01", ar.assess)).toMatchObject({ age: "a13", stage: "高中" });
    expect(ageAt(p({ birth: "2016-01" }), "2026-11-01", ar.assess).problem).toMatch(/学段/);
  });
});

describe("档案字段", () => {
  const msgs = (x: Record<string, any>) => validateProfile(x).filter((i) => i.level === "error").map((i) => i.message).join("；");
  it("合格", () => expect(msgs(profile("18-39岁-纯徒手版"))).toBe(""));
  it("成年人没记出生年月、筛查没日期、医生同意没日期：拦下", () => {
    const p = profile("18-39岁-纯徒手版");
    delete p.birth;
    delete p.screening.date;
    delete p.screening.doctorDate;
    expect(msgs(p)).toMatch(/出生年月.*筛查要记日期.*医生同意要记日期/s);
  });
  it("13–17 岁记体重：拦下", () => expect(msgs(profile("13-17岁-纯徒手版", [[1, 1]], { body: "记" }))).toMatch(/18–64 岁/));
});

describe("段末结论（下一轮的方向）", () => {
  const end = (p: Record<string, any>, rv: [string, Record<string, any>][], n = 1) => {
    const code = `${manifest.products.find((x) => x.name === p.segments[0].product)!.age}·${manifest.products.find((x) => x.name === p.segments[0].product)!.venue}`;
    return segmentEnd(p, n, Object.fromEntries(rv), ar, code) as any;
  };
  it("成人 ≥14 添装备、12–13 原样、<12 减量", () => {
    expect(end(...Object.values(twoSegs("18-39岁-纯徒手版", 4)) as [any, any])).toMatchObject({ result: "添装备", next: "标准" });
    expect(end(...Object.values(twoSegs("18-39岁-纯徒手版", [4, 3, 3, 3])) as [any, any])).toMatchObject({ result: "原样", next: "标准" });
    expect(end(...Object.values(twoSegs("18-39岁-纯徒手版", 2)) as [any, any])).toMatchObject({ result: "减量", next: "减量" });
    expect(end(...Object.values(twoSegs("18-39岁-健身房版", 4)) as [any, any])).toMatchObject({ result: "进入下一阶段", next: "标准" });
  });
  it("每周训练数不超过排的次数（写了 6 次也只算 4 次）", () => {
    expect(end(...Object.values(twoSegs("18-39岁-纯徒手版", [6, 6, 1, 0])) as [any, any]).numbers.trainings).toBe(9);
  });
  it("重复的周只取最后一份复盘", () => {
    const p = profile("18-39岁-纯徒手版", [[1, 1], [1, 2], [1, 2], [1, 3], [1, 4]]);
    const rv = [review(p, 0), review(p, 1, { trainings: 0 }), review(p, 2), review(p, 3), review(p, 4)] as [string, Record<string, any>][];
    expect(end(p, rv).numbers.trainings).toBe(16);
  });
  it("这一段有不适：往上的结论降为原样", () => {
    const { p, rv } = twoSegs("18-39岁-纯徒手版", 4, { 1: { symptoms: true } });
    expect(end(p, rv)).toMatchObject({ result: "原样", downgraded: true, upward: false });
  });
  it("65 岁以上摔倒、头晕：先看医生，不开下一段", () => {
    const { p, rv } = twoSegs("65岁以上-椅子辅助版", 3, { 2: { nearFalls: 1 } });
    expect(end(p, rv)).toMatchObject({ result: "先看医生", next: "不开" });
  });
  it("13–17 岁动够 60 分钟有一周没达标：那一项降到每周 4 天（只降一次）", () => {
    const habits = { 动够60分钟: 5, 按时上床: 5 };
    const { p, rv } = twoSegs("13-17岁-纯徒手版", 3, { all: { habits }, 2: { habits: { ...habits, 动够60分钟: 3 } } });
    expect(end(p, rv).habitTargets).toEqual({ 动够60分钟: { days: 4 } });
  });
  it("65 岁以上散步没达标：减 5 分钟，最少 5 分钟；做到了加回来", () => {
    const habits = { 散步: 5, 放松: 5 };
    const { p, rv } = twoSegs("65岁以上-椅子辅助版", 3, { all: { habits }, 1: { habits: { 散步: 2, 放松: 5 } } });
    p.habitBase = { 散步: 20 };
    expect(end(p, rv).habitTargets).toEqual({ 散步: { minutes: 15 } });
    const ok = twoSegs("65岁以上-椅子辅助版", 3, { all: { habits } });
    ok.p.habitBase = { 散步: 20 };
    ok.p.segments.slice(0, 4).forEach((s: any) => (s.habitTargets = { 散步: { minutes: 10 } }));
    expect(end(ok.p, ok.rv).habitTargets).toEqual({ 散步: { minutes: 15 } });
  });
  it("6–12 岁：成功线按生病天数折算；有一条没到，成功线降到 16 天", () => {
    const habits = { 动够60分钟: 7, 按时上床: 5, 视屏少于2小时: 5 };
    const { p, rv } = twoSegs("6-12岁-户外与游戏版（家长版）", 0, { all: { habits } });
    expect(end(p, rv)).toMatchObject({ result: "原样" });
    const low = twoSegs("6-12岁-户外与游戏版（家长版）", 0, { all: { habits: { ...habits, 按时上床: 4 } } });
    expect(end(low.p, low.rv)).toMatchObject({ result: "降那一项", habitTargets: { 按时上床: { line: 16 } } });
    const sick = twoSegs("6-12岁-户外与游戏版（家长版）", 0, { all: { habits, sickDays: 2 } });
    expect(end(sick.p, sick.rv)).toMatchObject({ result: "不评重来", next: "重来" });
  });
  it("减量段：达到减量段的成功线回到标准段（REDUCED_END）", () => {
    const p = profile("18-39岁-纯徒手版", [...fullSeg(1, "减量"), [2, 1, "标准"]]);
    const rv = [0, 1, 2, 3].map((i) => review(p, i, { trainings: 3 })) as [string, Record<string, any>][];
    expect(end(p, rv)).toMatchObject({ result: "回标准段", next: "标准" });
    const rv2 = [0, 1, 2, 3].map((i) => review(p, i, { trainings: 2 })) as [string, Record<string, any>][];
    expect(end(p, rv2)).toMatchObject({ result: "减量", next: "减量" });
  });
  it("缺复盘数据：算不出来", () => {
    const { p, rv } = twoSegs("18-39岁-纯徒手版", 4);
    expect(end(p, rv.slice(0, 3))).toMatchObject({ error: expect.stringMatching(/缺 第 4 周/) });
  });
});

describe("档案目录的评估核对", () => {
  const bw = () => profile("18-39岁-纯徒手版");
  const bwEntry = (p: Record<string, any>, more: Record<string, any> = {}) => entry(p, {
    tests: [{ id: "pushup-test", level: 2, value: 12 }, { id: "wallsit-test", value: 30, depth: "大腿和地面平行" }], conclusion: {}, ...more });
  it("入门评估齐全：通过", () => expect(errs(ctx(bw(), [], [bwEntry(bw())]))).toEqual([]));
  it("没有入门评估：拦下", () => expect(errs(ctx(bw(), [], [])).join()).toMatch(/入门评估/));
  it("入门少了第〇章的测试：拦下", () => expect(errs(ctx(bw(), [], [entry(bw(), { tests: [{ id: "pushup-test", level: 2, value: 12 }], conclusion: {} })])).join()).toMatch(/wallsit-test/));
  it("测试项不属于这份成品：拦下", () => {
    const p = bw();
    expect(errs(ctx(p, [], [bwEntry(p, { tests: [{ id: "pushup-test", level: 2, value: 12 }, { id: "wallsit-test", value: 30 }, { id: "chair-stand-30s", value: 10 }] })])).join()).toMatch(/不属于/);
  });
  it("有高血压或没确认：静蹲超过 30 秒拦下", () => {
    const p = bw();
    delete p.conditions;
    expect(errs(ctx(p, [], [bwEntry(p, { tests: [{ id: "pushup-test", level: 2, value: 12 }, { id: "wallsit-test", value: 60 }] })])).join()).toMatch(/最多 30 秒/);
    p.conditions = { 高血压: false };
    expect(errs(ctx(p, [], [bwEntry(p, { tests: [{ id: "pushup-test", level: 2, value: 12 }, { id: "wallsit-test", value: 60 }] })]))).toEqual([]);
  });
  it("身体数据：不记的人有数据拦下；记的人算 BMI，结论要对；BMI ≥ 28 而筛查答否拦下", () => {
    const p = bw();
    const body = { height: 170, weight: 70, waist: 80 };
    expect(errs(ctx(p, [], [bwEntry(p, { body })])).join()).toMatch(/不记体重腰围/);
    p.body = "记";
    expect(errs(ctx(p, [], [bwEntry(p, { body })])).join()).toMatch(/结论/);
    expect(errs(ctx(p, [], [bwEntry(p, { body, conclusion: { bmi: 24.2, bmiClass: "超重" } })]))).toEqual([]);
    expect(errs(ctx(p, [], [bwEntry(p, { body: { height: 170, weight: 85, waist: 95 }, conclusion: { bmi: 29.4, bmiClass: "肥胖" } })])).join()).toMatch(/BMI 29.4/);
    expect(bmiCuts(manifest)).toEqual({ low: 18.5, over: 24, obese: 28 });
  });
  it("6–17 岁的评估出现身高体重：拦下", () => {
    const p = profile("13-17岁-纯徒手版");
    expect(errs(ctx(p, [], [entry(p, { body: { height: 160, weight: 50 }, conclusion: {} })])).join()).toMatch(/6–17 岁不记/);
  });
  it("40–64 岁开工前提：缺了拦下；有一项否，结论要先问医生", () => {
    const p = profile("40-64岁-纯徒手版");
    const t = [{ id: "pushup-test", level: 2, value: 10 }, { id: "wallsit-test", value: 30 }];
    expect(errs(ctx(p, [], [entry(p, { tests: t, conclusion: { needDoctor: false } })])).join()).toMatch(/checkup/);
    p.screening.doctorCleared = false;
    delete p.screening.doctorDate;
    const no = entry(p, { tests: t, prereqs: { checkup: false, bpOk: true }, conclusion: { needDoctor: true } });
    expect(errs(ctx(p, [], [no]))).toEqual([]);
    expect(doctorNeed(ctx(p, [], [no]))).toMatchObject({ needed: true, ok: false });
  });
  it("65 岁以上：测试没人在旁边、医生没同意之前测，拦下", () => {
    const p = profile("65岁以上-椅子辅助版");
    const t = [{ id: "chair-stand-30s", value: 10, hands: "扶椅子", done: true }];
    const dr = { doctorCleared: true, doctorDate: START };
    expect(errs(ctx(p, [], [entry(p, { tests: t, ...dr, conclusion: {} })])).join()).toMatch(/家人在场/);
    expect(errs(ctx(p, [], [entry(p, { tests: t, companion: true, ...dr, conclusion: {} })]))).toEqual([]);
    expect(errs(ctx(p, [], [entry(p, { tests: t, companion: true, doctorCleared: true, doctorDate: plus(START, 1), conclusion: {} })])).join()).toMatch(/医生同意之后/);
    expect(errs(ctx(p, [], [entry(p, { tests: t, companion: true, conclusion: {} })])).join()).toMatch(/医生同意之后/);
  });
  it("段末结论和重算对得上、下一段段型照结论：通过；写错结论、段型不对：拦下", () => {
    const { p, rv } = twoSegs("18-39岁-纯徒手版", 2, {}, "减量");
    const good = endRec(p, 1, { result: "减量", next: "减量" }, { tests: [{ id: "pushup-test", level: 2, value: 14 }, { id: "wallsit-test", value: 30 }] });
    expect(errs(ctx(p, rv, [bwEntry(p), good]))).toEqual([]);
    const lie = endRec(p, 1, { result: "原样", next: "标准" }, { tests: good.raw.tests });
    expect(errs(ctx(p, rv, [bwEntry(p), lie])).join()).toMatch(/重算的不一致/);
    p.segments[4].type = "标准";
    expect(errs(ctx(p, rv, [bwEntry(p), good])).join()).toMatch(/下一段要是减量段/);
  });
  it("段末没做就开下一段：拦下", () => {
    const { p, rv } = twoSegs("18-39岁-纯徒手版", 4);
    expect(errs(ctx(p, rv, [bwEntry(p)])).join()).toMatch(/段末评估/);
  });
  it("习惯目标不是上一段结论给的：拦下", () => {
    const habits = { 动够60分钟: 5, 按时上床: 5 };
    const { p, rv } = twoSegs("13-17岁-纯徒手版", 3, { all: { habits } });
    const e = endRec(p, 1, { result: "原样", next: "标准" });
    expect(errs(ctx(p, rv, [entry(p, { conclusion: {} }), e]))).toEqual([]);
    p.segments[4].habitTargets = { 按时上床: { days: 4 } };
    expect(errs(ctx(p, rv, [entry(p, { conclusion: {} }), e])).join()).toMatch(/习惯目标/);
  });
  it("65 岁以上先看医生：没有看完医生回来的触发评估就开下一段，拦下", () => {
    const a65 = { habits: { 散步: 5, 放松: 5 }, falls: 0, nearFalls: 0, dizzy: 0 };
    const { p, rv } = twoSegs("65岁以上-椅子辅助版", 3, { all: a65, 1: { ...a65, falls: 1 } });
    const t = [{ id: "chair-stand-30s", value: 10, hands: "扶椅子", done: true }];
    const dr = { doctorCleared: true, doctorDate: START };
    const e0 = entry(p, { tests: t, companion: true, ...dr, conclusion: {} });
    // 这一段摔倒过：段末不测坐站（医生同意之前不测）
    const e = endRec(p, 1, { result: "先看医生", next: "不开" });
    p.screening.answers.find((a: any) => /摔倒/.test(a.item)).answer = "是";
    p.screening.date = p.segments[2].start;
    p.screening.doctorDate = p.segments[2].start;
    expect(errs(ctx(p, rv, [e0, e])).join()).toMatch(/看完医生回来/);
    const back = rec(p.segments[4].start, "触发", { reasons: ["看完医生回来"], doctorCleared: true, doctorDate: p.segments[4].start, conclusion: {} });
    expect(errs(ctx(p, rv, [e0, e, back])).join()).toMatch(/同步改/);
    p.screening.doctorDate = p.segments[4].start;
    expect(errs(ctx(p, rv, [e0, e, back]))).toEqual([]);
    // 摔倒以后段末还拿旧的医生同意去测：拦下
    const e2 = endRec(p, 1, { result: "先看医生", next: "不开" }, { tests: t, companion: true, ...dr });
    expect(errs(ctx(p, rv, [e0, e2, back])).join()).toMatch(/这次测试用的医生同意/);
  });
  it("65 岁以上摔倒以后：要重做筛查、医生同意在摔倒之后", () => {
    const p = profile("65岁以上-椅子辅助版", [[1, 1], [1, 2]]);
    const t = [{ id: "chair-stand-30s", value: 10, hands: "扶椅子", done: true }];
    const rv = [review(p, 0, { trainings: 3, falls: 1 })] as [string, Record<string, any>][];
    const c = ctx(p, rv, [entry(p, { tests: t, companion: true, doctorCleared: true, doctorDate: START, conclusion: {} })]);
    expect(errs(c).join()).toMatch(/重做安全筛查/);
    expect(doctorNeed(c)).toMatchObject({ ok: false });
  });
  it("换成品：要有触发评估（跨段或换场地）和新成品的入门项目", () => {
    const p = profile("18-39岁-纯徒手版", [[1, 1], [1, 2], [2, 1]]);
    p.segments[2].product = "18-39岁-居家版";
    p.product = "18-39岁-居家版";
    const rv = [review(p, 0), review(p, 1)] as [string, Record<string, any>][];
    expect(errs(ctx(p, rv, [bwEntry(p)])).join()).toMatch(/触发评估/);
    const sw = rec(p.segments[2].start, "触发", { reasons: ["换场地"], product: "18-39岁-居家版", conclusion: {} });
    expect(errs(ctx(p, rv, [bwEntry(p), sw])).join()).toMatch(/pushup-test/);
    sw.raw.tests = [{ id: "pushup-test", level: 2, value: 12 }];
    expect(errs(ctx(p, rv, [bwEntry(p), sw]))).toEqual([]);
  });
  it("一段中途从第 1 周重来：要 restart 和对应原因的触发评估", () => {
    const p = profile("65岁以上-椅子辅助版", [[1, 1], [1, 2], [2, 1]]);
    const t = [{ id: "chair-stand-30s", value: 10, hands: "扶椅子", done: true }];
    const rv = [review(p, 0, { trainings: 3 }), review(p, 1, { trainings: 3 })] as [string, Record<string, any>][];
    const e0 = entry(p, { tests: t, companion: true, doctorCleared: true, doctorDate: START, conclusion: {} });
    expect(validateProfile(p).map((i) => i.message).join()).toMatch(/restart/);
    const tr = rec(p.segments[2].start, "触发", { reasons: ["生病住院"], eventDate: p.segments[1].start, doctorCleared: true, doctorDate: p.segments[2].start, conclusion: {} });
    p.screening.doctorDate = p.segments[2].start;
    p.segments[2].restart = tr.name;
    expect(validateProfile(p).filter((i) => i.level === "error")).toEqual([]);
    expect(errs(ctx(p, rv, [e0]))).not.toEqual([]);
    expect(errs(ctx(p, rv, [e0, tr]))).toEqual([]);
  });
  it("跨段：段开始那天年龄段和成品对不上拦下；满 65 岁当月起就拦", () => {
    const p = bw();
    p.birth = "1980-01";   // 46 岁，用的是 18–39 岁版
    expect(errs(ctx(p, [], [bwEntry(p)])).join()).toMatch(/推算是40–64 岁/);
    const q = profile("40-64岁-纯徒手版", [[1, 1]]);
    q.birth = "1961-07";   // 2026-07 满 65
    const qe = entry(q, { tests: [{ id: "pushup-test", level: 2, value: 10 }, { id: "wallsit-test", value: 30 }], prereqs: { checkup: true, bpOk: true }, conclusion: { needDoctor: false } });
    expect(errs(ctx(q, [], [qe], "2026-06-05"))).toEqual([]);
    expect(errs(ctx(q, [], [qe], "2026-07-02")).join()).toMatch(/满 65 岁/);
  });
  it("初中升高中：stage 没改拦下", () => {
    const p = profile("13-17岁-纯徒手版");
    p.school = { stage: "初中", entry: 2023 };
    p.startDate = "2026-09-07";
    p.segments[0].start = "2026-09-07";
    p.screening.date = p.screening.doctorDate = "2026-09-07";
    expect(errs(ctx(p, [], [rec("2026-09-07", "入门", { conclusion: {} })])).join()).toMatch(/改 stage/);
    p.stage = "高中";
    expect(errs(ctx(p, [], [rec("2026-09-07", "入门", { conclusion: {} })]))).toEqual([]);
  });
  it("筛查超过一年：拦下", () => {
    const p = bw();
    expect(errs(ctx(p, [], [bwEntry(p)], plus(START, 367))).join()).toMatch(/超过 365 天/);
  });
  it("中断：超过 5 天提醒、超过 28 天拦下（做了触发评估就放行）；按练习记录和周复盘里较晚的算", () => {
    const p = profile("18-39岁-纯徒手版", [[1, 1], [1, 2]]);
    const rv = [review(p, 0)] as [string, Record<string, any>][];
    const c = (now: string, more: any[] = []) => ctx(p, rv, [bwEntry(p), ...more], now);
    expect(gap(c(plus(START, 10)), "a18·bw", plus(START, 10))).toMatchObject({ last: plus(START, 6), days: 4 });
    expect(warns(c(plus(START, 13))).join()).toMatch(/一半的量/);
    expect(errs(c(plus(START, 40))).join()).toMatch(/断了 34 天/);
    expect(errs(c(plus(START, 40), [rec(plus(START, 40), "触发", { reasons: ["中断"], conclusion: {} })])).join()).not.toMatch(/断了/);
  });
  it("周期末评估：阶段 3 才有", async () => {
    const { validateAssessment } = await import("../src/assess.ts");
    expect(validateAssessment({ schema: ASSESS_FORMAT, date: "2026-06-01", kind: "周期末" }).map((i) => i.message).join()).toMatch(/阶段 3/);
  });
});

describe("半量课和进度依据", () => {
  const product = "18-39岁-纯徒手版";
  const p = () => {
    const x = profile(product);
    x.conditions = Object.fromEntries(Object.entries(rules.conditions).map(([k, v]) => [k, v.text]));
    x.choices = ["table-row", "door-row"];
    return x;
  };
  it("--half：组数减半向上取整，课程检查按半量核对", () => {
    const full = exportCourse({ plans, rules, manifest, profile: p(), week: 1, day: "A" }).course!;
    const half = exportCourse({ plans, rules, manifest, profile: p(), week: 1, day: "A", half: true }).course!;
    expect(half.source.half).toBe(true);
    const sets = (c: typeof full) => c.blocks.flatMap((b) => b.kind === "sets" ? b.items.map((i) => i.sets ?? 1) : [b.rounds]);
    expect(sets(half)).toEqual(sets(full).map((n) => Math.ceil(n / 2)));
    expect(checkPlanCourse(half, plans, rules, manifest, p()).filter((i) => i.level === "error")).toEqual([]);
    expect(checkPlanCourse({ ...half, source: { ...half.source, half: undefined } } as any, plans, rules, manifest, p()).some((i) => i.level === "error")).toBe(true);
  });
  it("半量课的练习记录不当找级依据", () => {
    const x = p();
    const course = exportCourse({ plans, rules, manifest, profile: x, week: 1, day: "A", half: true }).course!;
    const sess = { name: "打卡/a.json", raw: { course: { id: course.id, name: course.name, source: course.source }, startedAt: `${START}T19:00:00`, items: [{ exercise: "pushup", setsPlanned: 1, setsDone: 1, feel: "做到上限还很轻松" }], feeling: "轻松", symptoms: { pain: false, dizzy: false, chest: false } } };
    x.progress = { pushup: { level: 2 } };
    x.progressLog = [{ date: START, move: "pushup", field: "level", to: 1, rule: "建档" }, { date: plus(START, 1), move: "pushup", field: "level", to: 2, rule: "找级", evidence: "打卡/a.json" }];
    x.progress = { pushup: { level: 2 } };
    expect(checkProgressLog(x, plans, rules, [sess], {}, new Date(`${plus(START, 2)}T12:00:00`)).map((i) => i.message).join()).toMatch(/半量课/);
  });
});

describe("评估记录的 schema 和核心库判断一致", () => {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  const schema = ajv.compile(readJson(`${CONTRACTS}assessment.schema.json`) as object);
  const ok = [
    { schema: ASSESS_FORMAT, date: "2026-06-01", kind: "入门", base: 2, tests: [{ id: "pushup-test", level: 2, value: 9 }], conclusion: {} },
    { schema: ASSESS_FORMAT, date: "2026-06-29", kind: "段末", segment: 1, tests: [{ id: "chair-stand-30s", value: 6, hands: "扶椅子", done: false, stopReason: "头晕" }], companion: true },
    { schema: ASSESS_FORMAT, date: "2026-07-01", kind: "触发", reasons: ["换场地"], product: "18-39岁-居家版", prereqs: { checkup: true } },
  ];
  const bad = [
    { schema: ASSESS_FORMAT, date: "2026-06-01", kind: "周期末" },
    { schema: ASSESS_FORMAT, date: "2026-06-01", kind: "触发", reasons: ["想换就换"] },
    { schema: ASSESS_FORMAT, date: "2026-06-01", kind: "入门", tests: [{ id: "chair-stand-30s", hands: "单手" }] },
    { schema: ASSESS_FORMAT, date: "2026-06-01", kind: "入门", body: { weight: 70, bmi: 24 } },
  ];
  it.each(ok.map((x, i) => [i, x]))("合格 %i", (_, x) => {
    expect(schema(x)).toBe(true);
    expect(validateAssessment(x)).toEqual([]);
  });
  it.each(bad.map((x, i) => [i, x]))("不合格 %i", (_, x) => {
    expect(schema(x)).toBe(false);
    expect(validateAssessment(x).length).toBeGreaterThan(0);
  });
});

describe("实施审查后的修订（拦下 / 放行）", () => {
  const t65 = [{ id: "chair-stand-30s", value: 10, hands: "扶椅子", done: true }];
  const e65 = (p: Record<string, any>, more: Record<string, any> = {}) => entry(p, { tests: t65, companion: true, doctorCleared: true, doctorDate: START, conclusion: {}, ...more });
  const bwT = [{ id: "pushup-test", level: 2, value: 12 }, { id: "wallsit-test", value: 30 }];
  it("restart 不能绕过段末评估：上一段练完了照样要段末", () => {
    const p = profile("65岁以上-椅子辅助版", [...fullSeg(1), [2, 1]]);
    const rv = [0, 1, 2, 3].map((i) => review(p, i, { trainings: 3 }));
    const tr = rec(p.segments[4].start, "触发", { reasons: ["生病住院"], eventDate: p.segments[3].start, doctorCleared: true, doctorDate: p.segments[4].start, conclusion: {} });
    p.segments[4].restart = tr.name;
    p.screening.doctorDate = p.segments[4].start;
    expect(errs(ctx(p, rv, [e65(p), tr])).join()).toMatch(/段末评估/);
  });
  it("中途重来：段型、习惯目标照被中断的那一段", () => {
    const p = profile("65岁以上-椅子辅助版", [[1, 1, "减量"], [1, 2, "减量"], [2, 1, "标准"]]);
    const rv = [review(p, 0, { trainings: 2 }), review(p, 1, { trainings: 2 })];
    const tr = rec(p.segments[2].start, "触发", { reasons: ["生病住院"], eventDate: p.segments[1].start, doctorCleared: true, doctorDate: p.segments[2].start, conclusion: {} });
    p.segments[2].restart = tr.name;
    p.segments[2].habitTargets = { 散步: { minutes: 60 } };
    p.screening.doctorDate = p.segments[2].start;
    const out = errs(ctx(p, rv, [e65(p), tr])).join();
    expect(out).toMatch(/段型照被中断/);
    expect(out).toMatch(/习惯目标照被中断/);
  });
  it("生病住院的触发评估没写那天：拦下", () => {
    expect(validateAssessment({ schema: ASSESS_FORMAT, date: START, kind: "触发", reasons: ["生病住院"] }).map((i) => i.message).join()).toMatch(/eventDate/);
  });
  it("日期写成将来：拦下", () => {
    const p = profile("18-39岁-纯徒手版");
    p.screening.date = "2099-01-01";
    expect(errs(ctx(p, [], [entry(p, { tests: bwT, conclusion: {} })])).join()).toMatch(/还没到/);
  });
  it("重做筛查后没重新问医生：错误（不只是警告）", () => {
    const p = profile("65岁以上-椅子辅助版", [[1, 1], [1, 2]]);
    p.screening.date = p.segments[1].start;   // 重做了筛查，医生同意还是建档那天的
    expect(errs(ctx(p, [review(p, 0, { trainings: 3 })], [e65(p)])).join()).toMatch(/重新问医生/);
  });
  it("触发评估里的摔倒也算：暂停平衡、医生同意要在摔倒之后", async () => {
    const { balanceHold } = await import("../src/assess.ts");
    const p = profile("65岁以上-椅子辅助版", [[1, 1], [1, 2]]);
    const fall = rec(p.segments[1].start, "触发", { reasons: ["摔倒"], eventDate: p.segments[1].start, conclusion: {} });
    const c = ctx(p, [review(p, 0, { trainings: 3 })], [e65(p), fall]);
    expect(balanceHold(c)).toBe(true);
    expect(doctorNeed(c)).toMatchObject({ ok: false });
  });
  it("换年龄段要重新筛查", () => {
    const p = profile("40-64岁-纯徒手版", [[1, 1], [1, 2], [2, 1]]);
    p.segments[2].product = "65岁以上-椅子辅助版";
    p.product = "65岁以上-椅子辅助版";
    Object.assign(p, { age: "a65", stage: "65 岁以上", venue: "chair", birth: "1961-07", habitBase: { 散步: 20 } });
    p.segments[2].start = "2026-07-06";   // 2026-07 满 65 岁
    delete p.body;
    p.screening.answers = manifest.intake.screening.find((s) => s.age === "a65")!.items.map((item) => ({ item, answer: "否" }));
    const e40 = entry(p, { tests: bwT, prereqs: { checkup: true, bpOk: true }, conclusion: { needDoctor: false } });
    const sw = rec(p.segments[2].start, "触发", { reasons: ["跨段"], product: "65岁以上-椅子辅助版", tests: t65, companion: true, doctorCleared: true, doctorDate: p.segments[2].start, conclusion: {} });
    const rv = [review(p, 0), review(p, 1)];
    expect(errs(ctx(p, rv, [e40, sw])).join()).toMatch(/重新做安全筛查/);
    p.screening.date = p.screening.doctorDate = p.segments[2].start;
    expect(errs(ctx(p, rv, [e40, sw]))).toEqual([]);
  });
  it("评估记录顶层多写体重、BMI：拦下", () => {
    expect(validateAssessment({ schema: ASSESS_FORMAT, date: START, kind: "入门", weight: 52, bmi: 19.5 }).map((i) => i.message).join()).toMatch(/只能有这些字段/);
  });
  it("选了记体重腰围：入门少了身高拦下", () => {
    const p = profile("18-39岁-纯徒手版");
    p.body = "记";
    expect(errs(ctx(p, [], [entry(p, { tests: bwT, body: { weight: 110, waist: 110 }, conclusion: {} })])).join()).toMatch(/少了 height/);
  });
  it("BMI 只看最新一份：降下来以后不再报", () => {
    const p = profile("18-39岁-纯徒手版", [...fullSeg(1), [2, 1]]);
    p.body = "记";
    const rv = [0, 1, 2, 3].map((i) => review(p, i));
    const e0 = entry(p, { tests: bwT, body: { height: 170, weight: 84, waist: 95 }, conclusion: { bmi: 29.1, bmiClass: "肥胖" } });
    const e1 = endRec(p, 1, { bmi: 27, bmiClass: "超重", result: "添装备", next: "标准" }, { tests: bwT, body: { weight: 78, waist: 90 } });
    expect(errs(ctx(p, rv, [e0, e1]))).toEqual([]);
    expect(errs(ctx(p, rv, [e0])).join()).toMatch(/BMI 29.1/);
  });
  it("65 岁以上体重明显下降：要重做筛查；生病换药：提醒做触发评估", () => {
    const p = profile("65岁以上-椅子辅助版", [[1, 1], [1, 2]]);
    const c = ctx(p, [review(p, 0, { trainings: 3 }), review(p, 1, { trainings: 3, weightDrop: true, sickOrMeds: true })], [e65(p)]);
    expect(errs(c).join()).toMatch(/体重明显下降/);
    expect(warns(c).join()).toMatch(/生病或换了药/);
  });
  it("65 岁以上没记散步时长：拦下；复盘里打卡项写错名字：拦下", () => {
    const p = profile("65岁以上-椅子辅助版");
    delete p.habitBase;
    expect(validateProfile(p).map((i) => i.message).join()).toMatch(/散步时长/);
    const q = profile("18-39岁-纯徒手版", [[1, 1], [1, 2]]);
    expect(errs(ctx(q, [review(q, 0, { habits: { 散布: 5 } })], [entry(q, { tests: bwT, conclusion: {} })])).join()).toMatch(/不是这份成品/);
  });
  it("6–12 岁这一轮不评：习惯目标保持原样", () => {
    const habits = { 动够60分钟: 6, 按时上床: 6, 视屏少于2小时: 6 };
    const { p, rv } = twoSegs("6-12岁-户外与游戏版（家长版）", 0, { all: { habits, sickDays: 3 } });
    p.segments.slice(0, 4).forEach((s: any) => (s.habitTargets = { 按时上床: { line: 16 } }));
    const e: any = segmentEnd(p, 1, Object.fromEntries(rv), ar, "a06·play");
    expect(e).toMatchObject({ result: "不评重来", habitTargets: { 按时上床: { line: 16 } } });
  });
});

describe("复核后的修订（拦下 / 放行）", () => {
  const bwT = [{ id: "pushup-test", level: 2, value: 12 }, { id: "wallsit-test", value: 30 }];
  const t65 = [{ id: "chair-stand-30s", value: 10, hands: "扶椅子", done: true }];
  it("第 4 周换成品：段型照段末结论，习惯目标只留新成品也有的", () => {
    const { p, rv } = twoSegs("18-39岁-纯徒手版", 2, {}, "标准");
    p.segments[4].product = "18-39岁-居家版";
    p.product = "18-39岁-居家版";
    const end = endRec(p, 1, { result: "减量", next: "减量" }, { tests: bwT });
    const sw = rec(p.segments[4].start, "触发", { reasons: ["换场地"], product: "18-39岁-居家版", tests: [{ id: "pushup-test", level: 2, value: 12 }], conclusion: {} });
    expect(errs(ctx(p, rv, [entry(p, { tests: bwT, conclusion: {} }), end, sw])).join()).toMatch(/下一段要是减量段/);
    p.segments[4].type = "减量";
    p.segments[4].habitTargets = { 散步: { days: 1 } };
    expect(errs(ctx(p, rv, [entry(p, { tests: bwT, conclusion: {} }), end, sw])).join()).toMatch(/习惯目标应该是 \{\}/);
  });
  it("拖长的周：没有练习记录时按开始后第 7 天算最后一次训练，长时间中断照样报", () => {
    const p = profile("18-39岁-纯徒手版", [[1, 1], [1, 2]]);
    p.segments[1].start = "2026-08-03";
    p.segments.push({ n: 1, type: "标准", week: 3, start: "2026-11-10", product: p.product });
    const rv = [review(p, 0), review(p, 1, { trainings: 2 })];
    expect(errs(ctx(p, rv, [entry(p, { tests: bwT, conclusion: {} })], "2026-11-10")).join()).toMatch(/断了 \d+ 天/);
  });
  it("入学年份写成将来：拦下", () => {
    const p = profile("13-17岁-纯徒手版");
    p.school = { stage: "初中", entry: 2027 };
    expect(errs(ctx(p, [], [entry(p, { conclusion: {} })])).join()).toMatch(/入学年份 2027 还没到/);
  });
  it("满 65 岁换版的正常顺序（先重做筛查、再看医生、再做换段评估和坐站测试）：放行", () => {
    const p = profile("40-64岁-纯徒手版", [[1, 1], [1, 2], [2, 1]]);
    p.segments[2].start = "2026-07-06";
    p.segments[2].product = "65岁以上-椅子辅助版";
    Object.assign(p, { product: "65岁以上-椅子辅助版", age: "a65", stage: "65 岁以上", venue: "chair", birth: "1961-07", habitBase: { 散步: 20 } });
    delete p.body;
    p.screening = { answers: manifest.intake.screening.find((s) => s.age === "a65")!.items.map((item) => ({ item, answer: "否" })), doctorCleared: true, date: "2026-07-01", doctorDate: "2026-07-02" };
    const e40 = entry(p, { tests: bwT, prereqs: { checkup: true, bpOk: true }, conclusion: { needDoctor: false } });
    const sw = rec("2026-07-03", "触发", { reasons: ["跨段"], product: "65岁以上-椅子辅助版", tests: t65, companion: true, doctorCleared: true, doctorDate: "2026-07-02", conclusion: {} });
    expect(errs(ctx(p, [review(p, 0), review(p, 1)], [e40, sw]))).toEqual([]);
    p.screening.date = "2026-06-20";   // 还没满 65 岁时做的筛查：要重做
    expect(errs(ctx(p, [review(p, 0), review(p, 1)], [e40, sw])).join()).toMatch(/重新做安全筛查/);
  });
  it("体重下降只算一年内的；一周摔了两次只记了一次：按那一周最后一天算", () => {
    const p = profile("65岁以上-椅子辅助版", [[1, 1], [1, 2]]);
    const e0 = entry(p, { tests: t65, companion: true, doctorCleared: true, doctorDate: START, conclusion: {} });
    const old = rec("2025-06-01", "段末", { segment: 9, weightDrop: true });
    expect(errs(ctx(p, [review(p, 0, { trainings: 3 })], [e0, old])).join()).not.toMatch(/体重明显下降/);
    const fall = rec(p.segments[0].start, "触发", { reasons: ["摔倒"], eventDate: p.segments[0].start, conclusion: {} });
    p.screening.answers.find((a: any) => /摔倒/.test(a.item)).answer = "是";
    p.screening.date = p.screening.doctorDate = plus(START, 2);
    const c = ctx(p, [review(p, 0, { trainings: 3, falls: 2 })], [e0, fall]);
    expect(doctorNeed(c)).toMatchObject({ ok: false, after: plus(START, 6) });
  });
  it("65 岁以上减量段的复盘记了放松：不报错（照做不考核）", () => {
    const p = profile("65岁以上-椅子辅助版", [[1, 1, "减量"], [1, 2, "减量"]]);
    const e0 = entry(p, { tests: t65, companion: true, doctorCleared: true, doctorDate: START, conclusion: {} });
    expect(errs(ctx(p, [review(p, 0, { trainings: 2 })], [e0])).join()).not.toMatch(/打卡项/);
  });
});

describe("用户定的 5 条（细化方案第十三节）", () => {
  const bwT = [{ id: "pushup-test", level: 2, value: 12 }, { id: "wallsit-test", value: 30 }];
  const t65 = [{ id: "chair-stand-30s", value: 10, hands: "扶椅子", done: true }];
  it("1：65 岁以上先看医生、医生同意以后照后面几条走：训练 < 8 下一段要是减量段", () => {
    const a65 = { habits: { 散步: 5, 放松: 5 }, falls: 0, nearFalls: 0, dizzy: 0 };
    const { p, rv } = twoSegs("65岁以上-椅子辅助版", 1, { all: a65, 1: { ...a65, nearFalls: 1 } });
    const dr = { doctorCleared: true, doctorDate: START };
    const e0 = entry(p, { tests: t65, companion: true, ...dr, conclusion: {} });
    const e = endRec(p, 1, { result: "先看医生", next: "不开" });
    const back = rec(p.segments[4].start, "触发", { reasons: ["看完医生回来"], doctorCleared: true, doctorDate: p.segments[4].start, conclusion: {} });
    p.screening.doctorDate = p.segments[4].start;
    expect(errs(ctx(p, rv, [e0, e, back])).join()).toMatch(/医生同意以后照后面几条走.*下一段要是减量段/);
    p.segments[4].type = "减量";
    expect(errs(ctx(p, rv, [e0, e, back]))).toEqual([]);
    // ≥ 10 练：只给"原样"，不给"加一项"
    const end: any = segmentEnd(twoSegs("65岁以上-椅子辅助版", 3, { all: a65 }).p, 1, Object.fromEntries(twoSegs("65岁以上-椅子辅助版", 3, { all: a65 }).rv), ar, "a65·chair", { afterDoctor: true });
    expect(end).toMatchObject({ result: "原样", downgraded: true });
  });
  it("2：停记以前记的身体数据保留，之后的新记录拦下；停记要写日期", () => {
    const p = profile("18-39岁-纯徒手版", [...fullSeg(1), [2, 1]]);
    const rv = [0, 1, 2, 3].map((i) => review(p, i));
    p.body = "停记";
    expect(validateProfile(p).map((i) => i.message).join()).toMatch(/bodyStopDate/);
    p.bodyStopDate = p.segments[2].start;
    const e0 = entry(p, { tests: bwT, body: { height: 170, weight: 70, waist: 80 }, conclusion: { bmi: 24.2, bmiClass: "超重" } });
    const e1 = endRec(p, 1, { result: "添装备", next: "标准" }, { tests: bwT });
    expect(errs(ctx(p, rv, [e0, e1]))).toEqual([]);
    const e2 = endRec(p, 1, { bmi: 23.5, bmiClass: "正常", result: "添装备", next: "标准" }, { tests: bwT, body: { weight: 68, waist: 78 } });
    expect(errs(ctx(p, rv, [e0, e2])).join()).toMatch(/停记/);
  });
  it("4：减量段里有过不适，回标准段算往上：再来一段减量段", () => {
    const p = profile("18-39岁-纯徒手版", [...fullSeg(1, "减量"), [2, 1, "减量"]]);
    const rv = [0, 1, 2, 3].map((i) => review(p, i, { trainings: 3, ...(i === 1 ? { symptoms: true } : {}) }));
    const end: any = segmentEnd(p, 1, Object.fromEntries(rv), ar, "a18·bw");
    expect(end).toMatchObject({ result: "减量", next: "减量", downgraded: true });
  });
  it("5：减量段一段中间换场地，新的一段还是减量段", () => {
    const p = profile("18-39岁-纯徒手版", [[1, 1, "减量"], [1, 2, "减量"], [2, 1, "标准"]]);
    p.segments[2].product = p.product = "18-39岁-居家版";
    const rv = [review(p, 0, { trainings: 3 }), review(p, 1, { trainings: 3 })];
    const sw = rec(p.segments[2].start, "触发", { reasons: ["换场地"], product: "18-39岁-居家版", tests: [{ id: "pushup-test", level: 2, value: 12 }], conclusion: {} });
    const e0 = entry(p, { tests: bwT, conclusion: {} });
    expect(errs(ctx(p, rv, [e0, sw])).join()).toMatch(/段型照原来那一段（减量段）/);
    p.segments[2].type = "减量";
    expect(errs(ctx(p, rv, [e0, sw]))).toEqual([]);
  });
});
