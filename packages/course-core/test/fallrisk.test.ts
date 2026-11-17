// 65 岁以上的跌倒风险自查（v4 阶段 3c）：结论重算（标准等级、未定、留余量、正式评估）、记录的矛盾、
// 档案目录里的要求（时机、先问医生、正式评估、到期复查）、按人的年龄的保护。每条规则有拦下 / 放行用例。只用 contracts/fixtures/。
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";
import { ASSESS_FORMAT, type AssessContext, balanceHold, checkAssessments, doctorNeed, validateAssessment } from "../src/assess.ts";
import { fallRiskConclusion, fallRiskIssues, fallRiskRules } from "../src/fallrisk.ts";
import { buildSheet } from "../src/sheet.ts";
import { REVIEW_FORMAT } from "../src/progress.ts";
import { CONTRACTS, FIX, fitAge, fixtureManifest, fixturePlans, fixtureRules, readJson } from "./helpers.ts";

const manifest = fixtureManifest();
const plans = fixturePlans();
const rules = fixtureRules();
const rr = fallRiskRules(rules)!;
const CHAIR = "65岁以上-椅子辅助版";
const START = "2026-12-01";
const NOW = "2026-12-03";
const plus = (d: string, n: number) => new Date(new Date(`${d}T12:00:00Z`).getTime() + n * 86_400_000).toISOString().slice(0, 10);

const general = (fell = false, unsteady: boolean | null = false, fear: boolean | null = false) => ({ fell, unsteady, fear });
const sevNo = { twoPlus: false, medical: false, helpUp: false, syncope: false };
const frailNo = { fatigue: false, stairs: false, walk: false, illness: false, weightLoss: false };
const walk = (seconds: number, extra: Record<string, unknown> = {}) => ({ seconds, cane: false, siteOk: true, testedOn: START, ...extra });
const tug = (seconds: number, extra: Record<string, unknown> = {}) => ({ seconds, cane: false, siteOk: true, chairOk: true, testedOn: START, ...extra });
const untested = (reason = "椅子不合要求") => ({ result: "没测成", reason });
const skipped = (reason: string) => ({ result: "按规则不测", reason });
/** 一份自查：默认一般性 3 问都"否"、两项步态都在线内。 */
const fr = (x: Record<string, unknown> = {}) => ({ askedOn: START, general: general(), needsSupport: false, hardToStand: false, dizzy: false, walk4m: walk(3.5), tug: tug(9), ...x });
const pos = (x: Record<string, unknown> = {}) => fr({ general: general(false, true), severity: sevNo, frail: frailNo, ...x });
const concl = (f: Record<string, unknown>, opts = {}) => fallRiskConclusion(f, rr, opts);

describe("结论：标准等级照 5.1.4、5.2.1 算", () => {
  it("一般性 3 问都\"否\"：低风险（步态照样测，A65_GAIT_ALWAYS）", () => {
    expect(concl(fr())).toMatchObject({ level: "低", effective: "低", doctorFirst: false, reassessBy: null });
  });
  it("一般性有阳性、严重程度有阳性：高风险，先问医生", () => {
    const c = concl(pos({ severity: { ...sevNo, syncope: true }, walk4m: skipped("高风险"), tug: skipped("高风险") }));
    expect(c).toMatchObject({ level: "高", doctorFirst: true, officialNeeded: false });
  });
  it("衰弱 5 条里 3 条：严重程度阳性（高风险）；2 条不算", () => {
    const three = { ...frailNo, fatigue: true, stairs: true, walk: true };
    expect(concl(pos({ frail: three, walk4m: skipped("高风险"), tug: skipped("高风险") })).level).toBe("高");
    expect(concl(pos({ frail: { ...frailNo, fatigue: true, stairs: true } })).level).toBe("低");
  });
  it("一般性有阳性、严重程度全阴性：步态任一项阳性是中风险（6 个月再查），两项都阴性是低风险", () => {
    expect(concl(pos({ walk4m: walk(5.1) }))).toMatchObject({ level: "中", gaitOfficial: true, reassessBy: plus(START, 182) });
    expect(concl(pos({ tug: tug(15.1) })).level).toBe("中");
    expect(concl(pos())).toMatchObject({ level: "低", reassessBy: null });
  });
  it("过去 12 个月跌倒过：先问医生、先做正式评估；步态按规则不测，等级照问卷能定多少定多少", () => {
    const c = concl(fr({ general: general(true), severity: sevNo, frail: frailNo, walk4m: skipped("跌倒过"), tug: skipped("跌倒过") }));
    expect(c).toMatchObject({ level: "未定", worst: "中", doctorFirst: true, officialNeeded: true, gaitIncomplete: false, reassessBy: null });
  });
});

describe("结论：判定线的边界和留余量（A65_TIMING_MARGIN）", () => {
  const w = (s: number) => concl(pos({ walk4m: walk(s) }));
  const t = (s: number) => concl(pos({ tug: tug(s) }));
  it("4 m：4.4 秒阴性；4.5 秒按余量阳性（等级仍低，6 个月再查）；5.0 秒官方线上仍阴性；5.1 秒阳性", () => {
    expect(w(4.4)).toMatchObject({ level: "低", gaitMargin: false, reassessBy: null });
    expect(w(4.5)).toMatchObject({ level: "低", gaitMargin: true, reassessBy: plus(START, 182) });
    expect(w(5.0)).toMatchObject({ level: "低", gaitMargin: true, gaitOfficial: false });
    expect(w(5.1)).toMatchObject({ level: "中", gaitOfficial: true, gaitMargin: false });
  });
  it("起立行走：13.9 / 14.0 / 15.0 / 15.1 秒", () => {
    expect(t(13.9)).toMatchObject({ level: "低", gaitMargin: false });
    expect(t(14.0)).toMatchObject({ level: "低", gaitMargin: true });
    expect(t(15.0)).toMatchObject({ level: "低", gaitMargin: true });
    expect(t(15.1)).toMatchObject({ level: "中", gaitOfficial: true });
  });
  it("一般性全阴性的人步态按官方线阳性：标准等级仍是低风险，6 个月再查", () => {
    expect(concl(fr({ walk4m: walk(5.5) }))).toMatchObject({ level: "低", gaitOfficial: true, reassessBy: plus(START, 182) });
  });
  it("秒数最多一位小数（往大里取）：5.04 这样的写法被拦", () => {
    expect(validateAssessment({ schema: ASSESS_FORMAT, date: START, kind: "入门", fallRisk: fr({ walk4m: walk(5.04) }) }).map((i) => i.message).join()).toMatch(/最多一位小数/);
  });
});

describe("结论：未定（A65_UNDETERMINED）", () => {
  it("4 m 阴性、起立行走没测成：未定，按中处理（6 个月），记 gaitIncomplete", () => {
    expect(concl(pos({ tug: untested() }))).toMatchObject({ level: "未定", worst: "中", effective: "中", gaitIncomplete: true, reassessBy: plus(START, 182) });
  });
  it("任一项按官方线阳性：中风险（定得了），另一项没测也一样", () => {
    expect(concl(pos({ walk4m: walk(5.3), tug: untested() })).level).toBe("中");
  });
  it("场地、椅子不合要求的那一项按没测成", () => {
    expect(concl(pos({ tug: tug(9, { chairOk: false }) }))).toMatchObject({ level: "未定", gaitIncomplete: true });
  });
  it("第 2 问老人说不清、严重程度有阳性：未定（可能低、可能高），按高处理：先问医生", () => {
    const c = concl(fr({ general: general(false, null, false), severity: { ...sevNo, medical: true }, frail: frailNo, walk4m: skipped("高风险"), tug: skipped("高风险") }));
    expect(c).toMatchObject({ level: "未定", worst: "高", effective: "高", doctorFirst: true });
  });
  it("一般性全阴性的人没测成：标准到问卷就结束了，仍是低风险", () => {
    expect(concl(fr({ tug: untested() }))).toMatchObject({ level: "低", gaitIncomplete: false });
  });
});

describe("结论：和正式评估合", () => {
  const off = (level: string) => ({ date: START, afterFall: false, level });
  it("自查未定的照正式评估；两边都定得了的取高的", () => {
    expect(concl(pos({ tug: untested() }), { official: off("低") }).effective).toBe("低");
    expect(concl(pos(), { official: off("高") })).toMatchObject({ level: "低", effective: "高", doctorFirst: true });
    expect(concl(pos({ walk4m: walk(5.5) }), { official: off("低") }).effective).toBe("中");
  });
  it("正式评估只在自查前后 90 天以内的才并进等级（A65_OFFICIAL_RECENT）", () => {
    expect(concl(pos({ tug: untested() }), { official: { date: plus(START, -91), afterFall: false, level: "低" } }).effective).toBe("中");
    expect(concl(pos({ tug: untested() }), { official: { date: plus(START, -90), afterFall: false, level: "低" } }).effective).toBe("低");
  });
});

describe("记录本身的矛盾", () => {
  const issues = (f: Record<string, unknown>, opts = {}) => fallRiskIssues(f, rr, opts).map((i) => i.message).join("\n");
  it("一般性有阳性却没问严重程度；一般性全阴性却写了严重程度", () => {
    expect(issues(fr({ general: general(false, true) }))).toMatch(/接着问严重程度/);
    expect(issues(fr({ severity: sevNo, frail: frailNo }))).toMatch(/不写严重程度/);
  });
  it("第 1 问说没跌倒过，严重程度却有\"是\"", () => {
    expect(issues(pos({ severity: { ...sevNo, helpUp: true }, walk4m: skipped("高风险"), tug: skipped("高风险") }))).toMatch(/前后对不上/);
  });
  it("跌倒过、高风险、走路要扶、站起困难、经常头晕的不在家测：记了秒数拦下；按规则不测的写法也要对", () => {
    expect(issues(fr({ general: general(true), severity: sevNo, frail: frailNo }))).toMatch(/不在家测步态（跌倒过）/);
    expect(issues(fr({ needsSupport: true }))).toMatch(/不在家测步态（走路要扶）/);
    expect(issues(fr({ dizzy: true }))).toMatch(/不在家测步态（经常头晕）/);
    expect(issues(fr({ walk4m: skipped("跌倒过") }))).toMatch(/不属于按规则不在家测/);
    expect(issues(fr({ tug: undefined }))).toMatch(/要测计时起立行走/);
    expect(issues(fr({ needsSupport: true, walk4m: skipped("走路要扶"), tug: skipped("走路要扶") }))).toBe("");
  });
  it("正式评估说高风险：之后不在家测步态；正式评估以前测的不算错", () => {
    const off = (date: string) => ({ official: { date, afterFall: false, level: "高" } });
    expect(issues(pos(), off(START))).toMatch(/正式评估（2026-12-01）说高风险：之后不在家测步态/);
    expect(issues(pos(), off(plus(START, 5)))).toBe("");
    expect(issues(pos({ walk4m: undefined, tug: skipped("高风险") }), off(START))).toMatch(/写 \{ result: "按规则不测", reason: "高风险" \}/);
    expect(issues(pos({ walk4m: skipped("高风险"), tug: skipped("高风险") }), off(START))).toBe("");
  });
  it("步态中途头晕停下：提醒告诉医生（警告）", () => {
    const w = fallRiskIssues(pos({ tug: { result: "没测成", reason: "中途停下", stopReason: "头晕", testedOn: START } }), rr);
    expect(w.map((i) => `${i.level}:${i.message}`).join()).toMatch(/^warning:步态测试中途头晕停下/);
  });
  it("只问本人的两问不能写成别的值；病名、体重数字没地方记", () => {
    const v = (f: unknown) => validateAssessment({ schema: ASSESS_FORMAT, date: START, kind: "入门", fallRisk: f }).map((i) => i.message).join();
    expect(v(fr({ general: { fell: false, unsteady: "家人说有点", fear: false } }))).toMatch(/只问老人本人/);
    expect(v(fr({ diseases: ["高血压"] }))).toMatch(/不记病名/);
    expect(v(fr({ dizzy: undefined }))).toMatch(/dizzy（经常头晕，或者站起来时眼前发黑：问卷时另外问/);
  });
  it("JSON Schema 和代码校验一致", () => {
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    addFormats(ajv);
    const schema = ajv.compile(readJson(`${CONTRACTS}assessment.schema.json`) as object);
    const rec = (f: unknown) => ({ schema: ASSESS_FORMAT, date: START, kind: "入门", fallRisk: f });
    for (const ok of [fr(), pos({ tug: untested() }), fr({ needsSupport: true, walk4m: skipped("走路要扶"), tug: skipped("走路要扶") })]) {
      expect(schema(rec(ok))).toBe(true);
      expect(validateAssessment(rec(ok))).toEqual([]);
    }
    for (const bad of [fr({ general: { fell: "否" } }), fr({ walk4m: { result: "没测成", reason: "懒得测" } }), fr({ weight: 60 }), fr({ dizzy: undefined }),
      pos({ tug: { result: "没测成", reason: "中途停下" } }), fr({ tug: { seconds: 9, cane: false, siteOk: true, testedOn: START } }),
      fr({ walk4m: walk(3.5, { chairOk: true }) })]) {
      expect(schema(rec(bad))).toBe(false);
      expect(validateAssessment(rec(bad)).length).toBeGreaterThan(0);
    }
  });
});

// ---------- 档案目录 ----------

/** 65 岁以上椅子版的档案，第 1 段第 1 周从 START 开始（生效日期之后）。 */
function profile(extra: Record<string, any> = {}) {
  const p = readJson<Record<string, any>>(`${FIX}profiles/ok-a18-home.json`);
  const prod = manifest.products.find((x) => x.name === CHAIR)!;
  Object.assign(p, { age: "a65", stage: "65 岁以上", product: CHAIR, venue: prod.venue, startDate: START });
  delete p.wake;
  delete p.bedtime;
  const items = manifest.intake.screening.find((s) => s.age === "a65")!.items;
  p.screening = { answers: items.map((item) => ({ item, answer: "否" })), doctorCleared: true, date: START, doctorDate: START };
  p.segments = [{ n: 1, type: "标准", week: 1, start: START, product: CHAIR }];
  fitAge(p, "a65");
  p.progress = {};
  p.progressLog = [];
  return Object.assign(p, extra);
}
const chair = [{ id: "chair-stand-30s", value: 10, hands: "扶椅子", done: true }];
const entry = (f: Record<string, unknown> | undefined, extra: Record<string, unknown> = {}) => {
  const raw: Record<string, any> = { schema: ASSESS_FORMAT, date: START, kind: "入门", tests: chair, companion: true, doctorCleared: true, doctorDate: START, ...extra };
  if (f) raw.fallRisk = f;
  raw.conclusion = f ? { fallRisk: fallRiskConclusion(f, rr, { official: extra.official as any }) } : {};
  return { name: `评估/${START}-入门.json`, raw };
};
const ctx = (p: Record<string, any>, assessments: any[], now = NOW, reviewData: Record<string, any> = {}): AssessContext =>
  ({ profile: p, manifest, plans, rules, sessions: [], reviewData, assessments, now: new Date(`${now}T12:00:00`) });
const trig = (date: string, reasons: string[], f: Record<string, unknown> | undefined, extra: Record<string, unknown> = {}) => {
  const raw: Record<string, any> = { schema: ASSESS_FORMAT, date, kind: "触发", reasons, ...extra };
  if (f) raw.fallRisk = f;
  raw.conclusion = f ? { fallRisk: fallRiskConclusion(f, rr, { official: extra.official as any }) } : {};
  return { name: `评估/${date}-触发-${reasons.join("")}.json`, raw };
};
const errs = (c: AssessContext) => checkAssessments(c).filter((i) => i.level === "error").map((i) => `${i.path}：${i.message}`).join("\n");
const warns = (c: AssessContext) => checkAssessments(c).filter((i) => i.level === "warning").map((i) => i.message).join("\n");

describe("档案目录：什么时候要做", () => {
  it("65 岁以上建档（生效日期之后）没做自查：拦下；做了：放行", () => {
    expect(errs(ctx(profile(), [entry(undefined)]))).toMatch(/65 岁以上建档要做跌倒风险自查/);
    expect(errs(ctx(profile(), [entry(fr())]))).toBe("");
  });
  it("生效日期之前的记录免查（已经在用椅子版的档案不会一上线就卡住）", () => {
    const old = "2026-06-01";
    const p = profile({ startDate: old });
    p.segments[0].start = old;
    p.screening.date = old;
    p.screening.doctorDate = old;
    const e = entry(undefined);
    Object.assign(e.raw, { date: old, doctorDate: old });
    e.name = `评估/${old}-入门.json`;
    expect(errs(ctx(p, [e], "2026-06-03"))).not.toMatch(/跌倒风险自查/);
  });
  it("摔倒的触发评估、满一年复筛也要带自查", () => {
    const p = profile();
    const fall = { name: `评估/${plus(START, 1)}-触发.json`, raw: { schema: ASSESS_FORMAT, date: plus(START, 1), kind: "触发", reasons: ["摔倒"], eventDate: START, conclusion: {} } };
    expect(errs(ctx(p, [entry(fr()), fall]))).toMatch(/65 岁以上摔倒要做跌倒风险自查/);
  });
});

describe("档案目录：先问医生、正式评估、到期", () => {
  // 没摔过的高风险：站立行走感到不稳、衰弱 3 条
  const high = pos({ frail: { ...frailNo, fatigue: true, stairs: true, walk: true }, walk4m: skipped("高风险"), tug: skipped("高风险") });
  it("高风险：没有医生看过结果（fallRiskSeen）拦下；医生同意早于问卷拦下；都对放行", () => {
    const p = profile();
    expect(errs(ctx(p, [entry(high)]))).toMatch(/先带着结果问医生/);
    const seen = entry(high, { fallRiskSeen: true });
    expect(doctorNeed(ctx(p, [seen])).ok).toBe(true);                  // 同一天：不早于问卷就算
    const q = profile();
    q.screening.doctorDate = plus(START, -1);
    q.screening.date = plus(START, -2);
    expect(doctorNeed(ctx(q, [seen])).ok).toBe(false);
    expect(errs(ctx(p, [seen]))).toBe("");
  });
  it("问卷超过 30 天才拿去换医生同意：拦下", () => {
    const p = profile();
    const late = plus(START, 40);
    p.screening.doctorDate = late;
    const back = trig(late, ["看完医生回来"], undefined, { fallRiskSeen: true, doctorCleared: true, doctorDate: late });
    expect(errs(ctx(p, [entry(high), back], plus(late, 1)))).toMatch(/医生看结果、同意练要在那之后 30 天以内/);
  });
  it("合规放行以后又因为别的事看了一次医生：不拿档案最新的同意日期去比 30 天", () => {
    const p = profile();
    const later = plus(START, 40);
    p.screening.doctorDate = later;
    const back = trig(later, ["看完医生回来"], undefined, { doctorCleared: true, doctorDate: later });
    expect(errs(ctx(p, [entry(high, { fallRiskSeen: true }), back], plus(later, 1)))).not.toMatch(/30 天以内|先带着结果问医生/);
  });
  it("一份新问卷盖不掉旧问卷：一年内每一份分别核对", () => {
    const p = profile();
    const fell = fr({ general: general(true), severity: sevNo, frail: frailNo, walk4m: skipped("跌倒过"), tug: skipped("跌倒过") });
    p.screening.answers = p.screening.answers.map((a: any) => (/最近一年摔倒过/.test(a.item) ? { ...a, answer: "是" } : a));
    const d2 = plus(START, 2);
    const newer = trig(d2, ["身体变化"], fr({ askedOn: d2, walk4m: walk(3.5, { testedOn: d2 }), tug: tug(9, { testedOn: d2 }) }), { companion: true, doctorCleared: true, doctorDate: START });
    const e1 = errs(ctx(p, [entry(fell, { fallRiskSeen: true }), newer], plus(START, 3)));
    expect(e1).toMatch(/正式的跌倒风险评估/);
    expect(warns(ctx(p, [entry(fell, { fallRiskSeen: true }), newer], plus(START, 3)))).toMatch(/那份自查说过去 12 个月跌倒过，这一份却说没有/);
    const q = profile();
    expect(errs(ctx(q, [entry(high), newer], plus(START, 3)))).toMatch(/先带着结果问医生/);
  });
  it("过去 12 个月跌倒过：要有摔倒之后的正式评估（afterFall）", () => {
    const fell = fr({ general: general(true), severity: sevNo, frail: frailNo, walk4m: skipped("跌倒过"), tug: skipped("跌倒过") });
    const p = profile();
    p.screening.answers = p.screening.answers.map((a: any) => (/最近一年摔倒过/.test(a.item) ? { ...a, answer: "是" } : a));
    expect(errs(ctx(p, [entry(fell, { fallRiskSeen: true })]))).toMatch(/正式的跌倒风险评估/);
    expect(errs(ctx(p, [entry(fell, { fallRiskSeen: true, official: { date: START, afterFall: false } })]))).toMatch(/正式的跌倒风险评估/);
    expect(errs(ctx(p, [entry(fell, { fallRiskSeen: true, official: { date: START, afterFall: true } })]))).toBe("");
  });
  it("跌倒过却说筛查\"最近一年摔倒过\"是\"否\"：拦下", () => {
    const fell = fr({ general: general(true), severity: sevNo, frail: frailNo, walk4m: skipped("跌倒过"), tug: skipped("跌倒过") });
    expect(errs(ctx(profile(), [entry(fell, { fallRiskSeen: true, official: { date: START, afterFall: true } })]))).toMatch(/照实重做筛查/);
  });
  it("6 个月复查到期没做：拦下", () => {
    const mid = pos({ walk4m: walk(5.5) });
    expect(errs(ctx(profile(), [entry(mid)], plus(START, 183)))).toMatch(/跌倒自查到期/);
    expect(errs(ctx(profile(), [entry(mid)], plus(START, 100)))).not.toMatch(/跌倒自查到期/);
  });
  it("高风险过了 30 天还没有正式随访：只提醒", () => {
    const p = profile();
    expect(warns(ctx(p, [entry(high, { fallRiskSeen: true })], plus(START, 35)))).toMatch(/1～3 个月后随访一次/);
  });
  it("摔倒的触发评估要在摔倒之后重新做问卷：照抄之前那份、写成摔倒以前的都拦下", () => {
    const p = profile();
    const ev = plus(START, 5);
    const fellQ = (askedOn: string) => fr({ askedOn, general: general(true), severity: sevNo, frail: frailNo, walk4m: skipped("跌倒过"), tug: skipped("跌倒过") });
    const copy = trig(plus(START, 6), ["摔倒"], fr(), { eventDate: ev });
    expect(errs(ctx(p, [entry(fr()), copy], plus(START, 7)))).toMatch(/摔倒要重新做一次问卷：这份问卷和 评估\/2026-12-01-入门.json 那份是同一天/);
    const early = trig(plus(START, 6), ["摔倒"], fellQ(plus(START, 4)), { eventDate: ev });
    expect(errs(ctx(p, [entry(fr()), early], plus(START, 7)))).toMatch(/摔倒（2026-12-06）之后要重新做一次问卷/);
    const ok = trig(plus(START, 6), ["摔倒"], fellQ(ev), { eventDate: ev });
    expect(errs(ctx(p, [entry(fr()), ok], plus(START, 7)))).not.toMatch(/重新做一次问卷/);
  });
  it("复盘记了摔倒、之后没重做自查：拦下", () => {
    const p = profile();
    const rv = { [`${START}-第1周.json`]: { schema: REVIEW_FORMAT, start: START, week: 1, trainings: 2, symptoms: false, moves: [], falls: 1 } };
    expect(errs(ctx(p, [entry(fr())], plus(START, 8), rv))).toMatch(/2026-12-07 摔倒过，之后还没做跌倒风险自查/);
  });
  it("同一次摔倒复盘记了、触发评估也记了：只算一次（\"大于等于 2 次\"照实答\"否\"不拦）", () => {
    const p = profile();
    p.screening.answers = p.screening.answers.map((a: any) => (/最近一年摔倒过/.test(a.item) ? { ...a, answer: "是" } : a));
    // 第 3 天摔了，第 8 天（这一周复盘之后）做的问卷
    const ev = plus(START, 2);
    const asked = plus(START, 7);
    const q = fr({ askedOn: asked, general: general(true), severity: sevNo, frail: frailNo, walk4m: skipped("跌倒过"), tug: skipped("跌倒过") });
    const t = trig(asked, ["摔倒"], q, { eventDate: ev, fallRiskSeen: true, doctorCleared: true, doctorDate: asked, official: { date: asked, afterFall: true } });
    const rv = (falls: number) => ({ [`${START}-第1周.json`]: { schema: REVIEW_FORMAT, start: START, week: 1, trainings: 2, symptoms: false, moves: [], falls } });
    expect(errs(ctx(p, [entry(fr()), t], plus(START, 8), rv(1)))).not.toMatch(/大于等于 2 次/);
    // 复盘记了 2 次、触发评估只记了 1 次：另一次也算
    expect(errs(ctx(p, [entry(fr()), t], plus(START, 8), rv(2)))).toMatch(/摔倒过 2 次，"跌倒的次数是否大于等于 2 次"却答了"否"/);
  });
  it("每年一次从最近一份问卷算：筛查因为别的事重做过也不往后挪", () => {
    const p = profile();
    const now = plus(START, 400);
    p.screening.date = plus(START, 210);
    p.screening.doctorDate = plus(START, 210);
    expect(errs(ctx(p, [entry(fr())], now))).toMatch(/跌倒风险自查是 2026-12-01 做的，已经超过一年/);
  });
  it("入门记录写在生效日期之前、第一段却在生效以后开始：照样要做", () => {
    const p = profile();
    const e = entry(undefined);
    const d = plus(rr.effective, -1);
    Object.assign(e.raw, { date: d, doctorDate: d });
    p.screening.date = d;
    p.screening.doctorDate = d;
    expect(errs(ctx(p, [e]))).toMatch(/65 岁以上建档要做跌倒风险自查/);
  });
  it("自查说在家走路也要扶墙，筛查\"……走路要扶东西、用拐杖\"却是\"否\"：拦下", () => {
    const f = fr({ needsSupport: true, walk4m: skipped("走路要扶"), tug: skipped("走路要扶") });
    expect(errs(ctx(profile(), [entry(f)]))).toMatch(/在家走路也要扶墙或用助行器，安全筛查/);
  });
  it("头晕照问卷那天的筛查：以后重做筛查答了\"是\"，以前合规测的步态不算错；那天就头晕却写了没有：拦下", () => {
    const p = profile();
    const later = plus(START, 100);
    p.screening.date = later;
    p.screening.doctorDate = later;
    p.screening.answers = p.screening.answers.map((a: any) => (/经常头晕/.test(a.item) ? { ...a, answer: "是" } : a));
    expect(errs(ctx(p, [entry(fr())], plus(later, 1)))).not.toMatch(/不在家测步态|dizzy/);
    const q = profile();
    q.screening.answers = q.screening.answers.map((a: any) => (/经常头晕/.test(a.item) ? { ...a, answer: "是" } : a));
    expect(errs(ctx(q, [entry(fr())]))).toMatch(/问卷却说不经常头晕：照实答/);
  });
  it("问卷在重做筛查之前、步态在之后：按测的那天有效的筛查查头晕", () => {
    const p = profile();
    const d1 = plus(START, 1);
    Object.assign(p.screening, { date: d1, doctorDate: d1 });
    p.screening.answers = p.screening.answers.map((a: any) => (/经常头晕/.test(a.item) ? { ...a, answer: "是" } : a));
    const e = entry(fr({ walk4m: walk(3.5, { testedOn: d1 }), tug: tug(9, { testedOn: d1 }) }), { date: d1, doctorDate: d1 });
    expect(errs(ctx(p, [e], plus(START, 2)))).toMatch(/测的那天（2026-12-02）有效的安全筛查（2026-12-02）"经常头晕，或者站起来时眼前发黑"是"是"/);
  });
  it("问卷当天后来摔了一跤：旧问卷不追溯，之后那份照实写跌倒过就行", () => {
    const p = profile();
    const d1 = plus(START, 1), d2 = plus(START, 2);
    Object.assign(p.screening, { date: d2, doctorDate: d2 });
    p.screening.answers = p.screening.answers.map((a: any) => (/最近一年摔倒过/.test(a.item) ? { ...a, answer: "是" } : a));
    const q = fr({ askedOn: d1, general: general(true), severity: sevNo, frail: frailNo, walk4m: skipped("跌倒过"), tug: skipped("跌倒过") });
    const t = trig(d2, ["摔倒"], q, { eventDate: START, fallRiskSeen: true, doctorCleared: true, doctorDate: d2, official: { date: d2, afterFall: true } });
    expect(errs(ctx(p, [entry(fr()), t], plus(START, 3)))).toBe("");
    // 那天摔了、又没有之后的问卷：要做摔倒的触发评估
    expect(errs(ctx(p, [entry(fr()), { ...t, raw: { ...t.raw, reasons: ["生病住院"], fallRisk: undefined, conclusion: {} } }], plus(START, 3)))).not.toMatch(/你是否跌倒过？"却答了"否"/);
  });
  it("一周摔了两次：一份\"摔倒\"触发评估把两次的日期都写进 eventDates，不按周日另算一次", () => {
    const p = profile();
    const mon = plus(START, 1), tue = plus(START, 2), wed = plus(START, 3), thu = plus(START, 4);
    Object.assign(p.screening, { date: thu, doctorDate: thu });
    p.screening.answers = p.screening.answers.map((a: any) => (/最近一年摔倒过/.test(a.item) ? { ...a, answer: "是" } : a));
    const q = fr({ askedOn: wed, general: general(true), severity: { ...sevNo, twoPlus: true }, frail: frailNo, walk4m: skipped("跌倒过"), tug: skipped("跌倒过") });
    const t = (extra: Record<string, unknown>) => trig(wed, ["摔倒"], q, { fallRiskSeen: true, doctorCleared: true, doctorDate: thu, official: { date: thu, afterFall: true }, ...extra });
    // 记录写在周三，正式评估、医生在周四：记录日期要不早于它们
    const rec = (extra: Record<string, unknown>) => { const x = t(extra); x.raw.date = thu; x.name = `评估/${thu}-触发-摔倒.json`; return x; };
    const rv = { [`${START}-第1周.json`]: { schema: REVIEW_FORMAT, start: START, week: 1, trainings: 2, symptoms: true, moves: [], falls: 2 } };
    expect(errs(ctx(p, [entry(fr()), rec({ eventDate: tue, eventDates: [mon, tue] })], plus(START, 8), rv))).toBe("");
    expect(errs(ctx(p, [entry(fr()), rec({ eventDate: mon })], plus(START, 8), rv))).toMatch(/2026-12-07 摔倒过/);
  });
  it("eventDates 的写法：只给摔倒、包含 eventDate 而且它是最近的、不晚于记录", () => {
    const v = (x: Record<string, unknown>) => validateAssessment({ schema: ASSESS_FORMAT, date: plus(START, 3), kind: "触发", reasons: ["摔倒"], eventDate: plus(START, 2), conclusion: {}, ...x }).map((i) => i.message).join();
    expect(v({ eventDates: [START, plus(START, 2)] })).toBe("");
    expect(v({ eventDates: [START, plus(START, 1)] })).toMatch(/eventDate 是最近的那一次/);
    expect(v({ eventDates: [START, plus(START, 2), plus(START, 4)], eventDate: plus(START, 4) })).toMatch(/不能晚于这份评估的日期/);
    expect(v({ reasons: ["生病住院"], eventDates: [plus(START, 2)] })).toMatch(/eventDates 只给"摔倒"/);
  });
  it("记录写得晚不算照抄：问卷日期不一样就行", () => {
    const p = profile();
    const fallDay = plus(START, 6);
    Object.assign(p.screening, { date: plus(START, 30), doctorDate: plus(START, 30) });
    p.screening.answers = p.screening.answers.map((a: any) => (/最近一年摔倒过/.test(a.item) ? { ...a, answer: "是" } : a));
    const sick = trig(plus(START, 22), ["生病住院"], fr({ askedOn: plus(START, 21), general: general(true), severity: sevNo, frail: frailNo, walk4m: skipped("跌倒过"), tug: skipped("跌倒过") }), { eventDate: plus(START, 20) });
    const fall = trig(plus(START, 30), ["摔倒"], fr({ askedOn: fallDay, general: general(true), severity: sevNo, frail: frailNo, walk4m: skipped("跌倒过"), tug: skipped("跌倒过") }), { eventDate: fallDay });
    expect(errs(ctx(p, [entry(fr()), sick, fall], plus(START, 31)))).not.toMatch(/不能照抄/);
  });
  it("问卷之后单独重做的筛查不倒过来追溯\"跌倒过、走路要扶\"", () => {
    const p = profile();
    const later = plus(START, 100);
    Object.assign(p.screening, { date: later, doctorDate: later });
    const f = fr({ needsSupport: true, walk4m: skipped("走路要扶"), tug: skipped("走路要扶") });
    expect(errs(ctx(p, [entry(f)], plus(later, 1)))).not.toMatch(/照实重做筛查/);
  });
  it("正式评估的日期不能晚于记录的日期", () => {
    expect(errs(ctx(profile(), [entry(fr(), { official: { date: plus(START, 1), afterFall: false } })]))).toMatch(/正式评估的日期不能晚于这份评估的日期/);
  });
  it("计划单的下次评估写跌倒风险自查的日期", () => {
    const text = (f: Record<string, unknown>) => buildSheet(ctx(profile(), [entry(f)])).text ?? "";
    expect(text(pos({ walk4m: walk(5.5) }))).toMatch(`跌倒风险自查：${plus(START, 182)} 之前重做一次`);
    expect(text(fr())).toMatch(`跌倒风险自查：${plus(START, 365)} 之前重做一次`);
  });
  it("档案里一年内摔倒过，问卷却答\"没跌倒过\"：拦下", () => {
    const p = profile();
    const fall = { name: `评估/${plus(START, -10)}-触发.json`, raw: { schema: ASSESS_FORMAT, date: plus(START, -10), kind: "触发", reasons: ["摔倒"], eventDate: plus(START, -10), conclusion: {} } };
    expect(errs(ctx(p, [entry(fr()), fall]))).toMatch(/你是否跌倒过？"却答了"否"/);
  });
  it("测了步态却不是家人在场、或者医生同意晚于测的那天：拦下", () => {
    expect(errs(ctx(profile(), [entry(fr(), { companion: false })]))).toMatch(/家人在场/);
    const late = entry(fr(), { doctorDate: plus(START, 1) });
    expect(errs(ctx(profile(), [late], plus(START, 2)))).toMatch(/步态测试要在医生同意之后做/);
  });
});

describe("65 岁以上的保护按人的年龄", () => {
  const BW40 = "40-64岁-纯徒手版";
  /** 40–64 岁版的档案，人在 2026-12 满 65 岁。 */
  const turning = () => {
    const p = readJson<Record<string, any>>(`${FIX}profiles/ok-a18-home.json`);
    const prod = manifest.products.find((x) => x.name === BW40)!;
    const s0 = "2026-11-24";
    Object.assign(p, { age: "a40", stage: "40–64 岁", product: BW40, venue: prod.venue, startDate: s0, birth: "1961-12", body: "记" });
    delete p.wake;
    delete p.bedtime;
    const items = manifest.intake.screening.find((s) => s.age === "a40")!.items;
    p.screening = { answers: items.map((item) => ({ item, answer: "否" })), doctorCleared: false, date: s0 };
    p.segments = [{ n: 1, type: "标准", week: 1, start: s0, product: BW40 }];
    return p;
  };
  it("满 65 岁当月起要医生同意（不等换成品）", () => {
    expect(doctorNeed(ctx(turning(), [])).needed).toBe(true);
  });
  it("满 65 岁当月起的新评估不能记身高体重腰围", () => {
    const p = turning();
    const rec = { name: `评估/${START}-触发.json`, raw: { schema: ASSESS_FORMAT, date: START, kind: "触发", reasons: ["身体变化"], body: { weight: 60, waist: 80 }, conclusion: {} } };
    expect(errs(ctx(p, [rec]))).toMatch(/满 65 岁当月起不记身高、体重、腰围/);
  });
  it("满 65 岁以后摔倒过：暂停平衡（按人的年龄判断）", () => {
    const p = turning();
    const fall = { name: `评估/${START}-触发.json`, raw: { schema: ASSESS_FORMAT, date: START, kind: "触发", reasons: ["摔倒"], eventDate: START, conclusion: {} } };
    expect(balanceHold(ctx(p, [fall]))).toBe(true);
  });
  it("复盘的 weightDrop：满 65 岁那一周起可以记", () => {
    const p = turning();
    p.segments.push({ n: 1, type: "标准", week: 2, start: START, product: BW40 }, { n: 1, type: "标准", week: 3, start: plus(START, 7), product: BW40 });
    const rv = (start: string, week: number) => ({ [`${start}-第${week}周.json`]: { schema: REVIEW_FORMAT, start, week, trainings: 3, symptoms: false, moves: [], weightDrop: false } });
    expect(errs(ctx(p, [], plus(START, 8), rv(START, 2)))).not.toMatch(/weightDrop 只给 65 岁以上/);
    expect(errs(ctx(p, [], plus(START, 8), rv("2026-11-24", 1)))).toMatch(/weightDrop 只给 65 岁以上/);   // 那一周还没满 65 岁
  });
});
