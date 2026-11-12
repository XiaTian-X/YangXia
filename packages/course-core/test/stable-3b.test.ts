// 稳定期 3b：健身房稳定期（不分轮、双进阶、有氧时长）、40–64 岁稳定期（升级窗口、直接进入要先体检血压）、
// 居家和健身房的有氧。用离线样例里真的稳定期成品（contracts/fixtures/，由 make-fixtures.ts 从模板生成）。
import { describe, expect, it } from "vitest";
import { ASSESS_FORMAT, type AssessContext, cardioMode, checkAssessments } from "../src/assess.ts";
import { exportCourse } from "../src/plan.ts";
import { SESSION_FORMAT } from "../src/profile.ts";
import { checkProgressLog, REVIEW_FORMAT } from "../src/progress.ts";
import { buildSheet } from "../src/sheet.ts";
import { FIX, fitAge, fixtureManifest, fixturePlans, fixtureRules, readJson } from "./helpers.ts";

const manifest = fixtureManifest();
const plans = fixturePlans();
const rules = fixtureRules();
const START = "2026-01-05";
const plus = (d: string, n: number) => new Date(new Date(`${d}T12:00:00Z`).getTime() + n * 86_400_000).toISOString().slice(0, 10);
const GYM = "18-39岁-健身房版";
const GYM_S = "18-39岁-健身房版（稳定期）";
const BW40 = "40-64岁-纯徒手版";
const BW40_S = "40-64岁-纯徒手版（稳定期）";
const HOME = "18-39岁-居家版";
const SQUAT = "gym-smith-squat";
type Seg = [n: number, week: number, product: string];

/** 档案：segs 每项隔 7 天；成品名带"（稳定期）"的那一段写 phase 稳定。 */
function profile(segs: Seg[], extra: Record<string, any> = {}) {
  const p = readJson<Record<string, any>>(`${FIX}profiles/ok-a18-home.json`);
  p.segments = segs.map(([n, week, product], i) => ({ n, ...(product.endsWith("（稳定期）") ? { phase: "稳定" } : {}), type: "标准", week, start: plus(START, 7 * i), product }));
  const last = p.segments[p.segments.length - 1];
  const prod = manifest.products.find((x) => x.name === last.product)!;
  Object.assign(p, { age: prod.age, stage: prod.age === "a40" ? "40–64 岁" : "18–39 岁", product: last.product, venue: prod.venue, startDate: START });
  delete p.wake;
  delete p.bedtime;
  const items = manifest.intake.screening.find((s) => s.age === prod.age)!.items;
  p.screening = { answers: items.map((item) => ({ item, answer: "否" })), doctorCleared: false, date: START };
  fitAge(p, prod.age);
  p.body = "不记";
  p.conditions = { 高血压: false };
  p.choices = ["table-row", "door-row"];
  p.progress = {};
  p.progressLog = [];
  return Object.assign(p, extra);
}
const run = (n: number, from: number, to: number, product: string): Seg[] => Array.from({ length: to - from + 1 }, (_, i) => [n, from + i, product]);
const reviews = (p: Record<string, any>, each: (i: number) => Record<string, any> = () => ({})) => Object.fromEntries(p.segments.slice(0, -1).map((s: any, i: number) =>
  [`${s.start}-第${s.week}周.json`, { schema: REVIEW_FORMAT, start: s.start, week: s.week, trainings: 4, checkinDays: 6, symptoms: false, moves: [], habits: { 散步: 5, 冥想: 5 }, ...each(i) }]));
const rec = (date: string, kind: string, fields: Record<string, any> = {}) => ({ name: `评估/${date}-${kind}.json`, raw: { schema: ASSESS_FORMAT, date, kind, conclusion: {}, ...fields } });
const lastDay = (p: Record<string, any>, n: number) => plus(p.segments.filter((s: any) => s.n === n).pop().start, 6);
function ctx(p: Record<string, any>, rv: Record<string, any>, assessments: any[], sessions: any[] = []): AssessContext {
  return { profile: p, manifest, plans, rules, sessions, reviewData: rv, assessments, now: new Date(`${plus(p.segments[p.segments.length - 1].start, 2)}T12:00:00`) };
}
const errs = (c: AssessContext) => checkAssessments(c).filter((i) => i.level === "error").map((i) => `${i.path}：${i.message}`).join("\n");
const session = (date: string, items: Record<string, any>[]) => ({
  name: `打卡/${date}.json`,
  raw: { schema: SESSION_FORMAT, course: { id: "c", name: "x", source: {} }, startedAt: `${date}T19:00:00`, feeling: "正好",
    items: items.map((x) => ({ setsPlanned: 3, setsDone: 3, ...x })), symptoms: { pain: false, dizzy: false, chest: false } },
});
const plog = (p: Record<string, any>, rv: Record<string, any>, sessions: any[] = [], assessments: any[] = []) =>
  checkProgressLog(p, plans, rules, sessions, rv, new Date(`${plus(p.segments[p.segments.length - 1].start, 2)}T12:00:00`), assessments).filter((i) => i.level === "error").map((i) => i.message).join("\n");
const exportErr = (p: Record<string, any>, week: number, day: string) => exportCourse({ plans, rules, manifest, profile: p, week, day }).issues.filter((i) => i.level === "error").map((i) => i.message).join();
const gymT = [{ id: "gym-weights", move: SQUAT, value: 40 }, { id: "gym-weights", move: "gym-chest-press", value: 30 }, { id: "gym-weights", move: "gym-lat-pulldown", value: 35 }];

describe("健身房稳定期：每周照第 4 周练、主项双进阶", () => {
  it("训练单：第 1–12 周都是 3 组，主项次数 10–12 走个人进度；提踵、平板支撑这些照动作库", () => {
    const g = plans.products[GYM_S];
    expect(g.phase).toBe("稳定");
    const sq = g.rows.find((r) => r.moves.includes(SQUAT))!;
    expect(sq).toMatchObject({ sets: 3, reps: { min: 10, max: 12 }, reps_from: "progress", weeks: Array.from({ length: 12 }, (_, i) => i + 1) });
    const calf = g.rows.find((r) => r.moves.includes("gym-calf-raise"))!;
    expect(calf.reps).toMatchObject({ min: 15, max: 20 });
  });
  it("第 5 周导出：深蹲 3 组 × 10 次（进度没记取 10）；进度记了 11 就做 11；写 13 拦下", () => {
    const base: Seg[] = [...run(1, 1, 4, GYM), ...run(2, 1, 5, GYM_S)];
    const c = exportCourse({ plans, rules, manifest, profile: profile(base, { venue: "gym" }), week: 5, day: "A" }).course!;
    expect(c.blocks.flatMap((b) => b.items).find((i) => i.exercise === SQUAT)).toMatchObject({ sets: 3, reps: 10 });
    const p11 = profile(base, { venue: "gym", progress: { [SQUAT]: { reps: 11 } } });
    expect(exportCourse({ plans, rules, manifest, profile: p11, week: 5, day: "A" }).course!.blocks.flatMap((b) => b.items).find((i) => i.exercise === SQUAT)).toMatchObject({ reps: 11 });
    expect(exportErr(profile(base, { venue: "gym", progress: { [SQUAT]: { reps: 13 } } }), 5, "A")).toMatch(/区间是 10–12/);
  });
  it("起始期段末\"进入下一阶段\"（≥ 14 练、没有不适）进稳定期：放行；直接进入：拦下", () => {
    const p = profile([...run(1, 1, 4, GYM), [2, 1, GYM_S]], { venue: "gym" });
    const a = [rec(START, "入门"), rec(lastDay(p, 1), "段末", { segment: 1, tests: gymT, conclusion: { result: "进入下一阶段", next: "标准" } })];
    expect(errs(ctx(p, reviews(p), a))).toBe("");
    const d = profile([[1, 1, GYM_S]], { venue: "gym", focus: { areas: ["训练"] } });
    expect(errs(ctx(d, {}, [rec(START, "入门", { base: 2 })]))).toMatch(/不设直接进入/);
  });
  it("双进阶（真的成品）：上一次每组做完、还能做 3 下 → 多做 1 下；稳定期用\"调重量\"拦下", () => {
    const p = profile([...run(1, 1, 4, GYM), ...run(2, 1, 2, GYM_S)], { venue: "gym", progress: { [SQUAT]: { weight: 40, reps: 11 } } });
    const d0 = p.segments[4].start;
    p.progressLog = [{ date: START, move: SQUAT, field: "weight", to: 40, rule: "建档" },
      { date: plus(d0, 2), move: SQUAT, field: "reps", to: 11, rule: "加次数", evidence: `打卡/${d0}.json` }];
    expect(plog(p, reviews(p), [session(d0, [{ exercise: SQUAT, spare: 3 }])])).toBe("");
    p.progressLog[1] = { date: plus(d0, 2), move: SQUAT, field: "weight", to: 45, rule: "调重量", evidence: `打卡/${d0}.json` };
    p.progress = { [SQUAT]: { weight: 45 } };
    expect(plog(p, reviews(p), [session(d0, [{ exercise: SQUAT, spare: 6 }])])).toMatch(/稳定期不用"调重量"/);
  });
  it("提踵、平板支撑、死虫式、面拉、农夫行走不走双进阶：加次数、加一档都拦下（原文\"照旧按动作库\"）", () => {
    const g = plans.products[GYM_S];
    expect(g.rows.filter((r) => r.double).map((r) => r.moves[0])).toContain(SQUAT);
    for (const m of ["gym-calf-raise", "plank", "dead-bug", "gym-face-pull", "gym-farmer-walk"]) expect(g.rows.some((r) => r.moves[0] === m && r.double)).toBe(false);
    const make = (move: string, field: string, from: number, to: number, rule: string) => {
      const p = profile([...run(1, 1, 4, GYM), ...run(2, 1, 2, GYM_S)], { venue: "gym", progress: { [move]: { [field]: to } } });
      const d0 = p.segments[4].start;
      p.progressLog = [{ date: START, move, field, to: from, rule: "建档" }, { date: plus(d0, 2), move, field, to, rule, evidence: `打卡/${d0}.json` }];
      if (field === "reps") p.progressLog.shift();
      return plog(p, reviews(p), [session(d0, [{ exercise: move, spare: 5 }])]);
    };
    expect(make("gym-face-pull", "reps", 15, 16, "加次数")).toMatch(/没有加次数的规则/);
    expect(make("gym-calf-raise", "reps", 15, 16, "加次数")).toMatch(/没有加次数的规则/);
    expect(make("plank", "reps", 30, 31, "加次数")).toMatch(/没有加次数的规则/);
    expect(make("gym-face-pull", "weight", 10, 12, "加一档")).toMatch(/加一档只给健身房稳定期走双进阶的主项/);
  });
  it("起始期没记下起始重量的：稳定期第 1 周可以补记（建档），之后照双进阶加一档", () => {
    const p = profile([...run(1, 1, 4, GYM), ...run(2, 1, 3, GYM_S)], { venue: "gym", progress: { [SQUAT]: { weight: 40 } } });
    p.progressLog = [{ date: p.segments[4].start, move: SQUAT, field: "weight", to: 40, rule: "建档" }];
    expect(plog(p, reviews(p))).toBe("");
    p.progressLog[0].date = p.segments[5].start;   // 稳定期第 2 周才补：拦下
    expect(plog(p, reviews(p))).toMatch(/起始重量在这份成品开始的那一周里记/);
  });
  it("计划单：表头写第几周、有氧每次 20 分钟；有高血压没问过医生的每次 15 分钟、坡度不再往上加", () => {
    const p = profile([...run(1, 1, 4, GYM), ...run(2, 1, 5, GYM_S)], { venue: "gym" });
    const c = ctx(p, reviews(p), [rec(START, "入门")]);
    const text = buildSheet(c).text!;
    expect(text).toMatch(/这一周做\*\*稳态\*\*，\*\*每次 20 分钟\*\*/);
    expect(text).toMatch(/健身房每周一样，照第 4 周的组数/);
    expect(text).not.toMatch(/照成品里这一轮第 \d 周做|有氧按当周递进/);
    const h = { ...p, conditions: { 高血压: true } };
    expect(buildSheet({ ...c, profile: h }).text).toMatch(/\*\*每次 15 分钟，坡度不再往上加\*\*（有高血压（或没确认）而且没问过医生：加时长、加坡度之前先问医生/);
  });
});

describe("有氧按阶段和时长", () => {
  const info = (code: string, phase: string) => ({ code, phase });
  it("健身房起始期：第 1 周 10 分钟、第 2–3 周 15 分钟、第 4 周 20 分钟；有高血压没问过医生的第 3–4 周保持 15 分钟", () => {
    const p = profile(run(1, 1, 4, GYM), { venue: "gym" });
    const at = (w: number, cond: Record<string, boolean> = { 高血压: false }) => cardioMode(rules, { ...p, conditions: cond }, info("a18·gym", "起始"), 1, w, {})?.duration;
    expect([1, 2, 3, 4].map((w) => at(w))).toEqual(["每次 10 分钟", "每次 15 分钟", "每次 15 分钟", "每次 20 分钟"]);
    expect(at(4, { 高血压: true })).toBe("每次 15 分钟，坡度不再往上加");
    expect(at(4, {})).toBe("每次 15 分钟，坡度不再往上加");   // 没确认按有高血压、没问过医生
    expect(at(4, { 高血压: true, 有氧问过医生: true })).toBe("每次 20 分钟");
    expect(at(2, { 高血压: true })).toBe("每次 15 分钟");
  });
  it("健身房稳定期：每一周每次 20 分钟，不分轮", () => {
    const p = profile(run(1, 1, 9, GYM_S), { venue: "gym" });
    expect([1, 5, 8, 9].map((w) => cardioMode(rules, p, info("a18·gym", "稳定"), 1, w, {})?.duration)).toEqual(Array(4).fill("每次 20 分钟"));
  });
  it("居家（单车）：第 2 周自查过了第 3 周才上间歇；有高血压没问过医生一直稳态", () => {
    const p = profile(run(1, 1, 3, HOME), { venue: "home" });
    const rv = reviews(p, (i) => (i === 1 ? { steadyCheck: true } : {}));
    expect(cardioMode(rules, p, info("a18·home", "起始"), 1, 3, rv)).toMatchObject({ mode: "间歇" });
    expect(cardioMode(rules, { ...p, conditions: { 高血压: true } }, info("a18·home", "起始"), 1, 3, rv)).toMatchObject({ mode: "稳态" });
    expect(cardioMode(rules, p, info("a18·home", "起始"), 1, 3, reviews(p))).toMatchObject({ mode: "稳态" });
  });
});

describe("40–64 岁稳定期", () => {
  const a40 = { stage: "40–64 岁" };
  const prereqs = { checkup: true, bpOk: true };
  const bwT = [{ id: "pushup-test", level: 3, value: 10 }, { id: "wallsit-test", value: 45 }];
  const upgrade = (wk: number, evIdx: number, moves = ["squat"]) => {
    const p = profile([...run(1, 1, 4, BW40), ...run(2, 1, wk, BW40_S)], { ...a40, progress: Object.fromEntries(moves.map((m) => [m, { level: 2, reps: 15 }])) });
    const i = p.segments.length - 1;
    const ev = p.segments[evIdx];
    p.progressLog = moves.map((m) => ({ date: p.segments[i].start, move: m, field: "level", to: 2, rule: "升级", evidence: `复盘/${ev.start}-第${ev.week}周.json` }));
    return plog(p, reviews(p, () => ({ moves: moves.map((m) => ({ move: m, allAtTop: true, spare: 2 })) })));
  };
  it("从起始期升上来：稳定期第 1 周就是第 2 轮，可以拿起始期第 3、4 周的复盘升级", () => {
    expect(upgrade(1, 3)).toBe("");
    expect(upgrade(2, 2)).toBe("");
  });
  it("稳定期第 3 周升级、一周升两个动作、拿稳定期第 1 周（2 组）的复盘：拦下", () => {
    expect(upgrade(3, 3)).toMatch(/不能升级/);
    expect(upgrade(1, 3, ["squat", "glute-bridge"])).toMatch(/一次只升一样/);
    expect(upgrade(2, 4)).toMatch(/上一轮第 3 或第 4 周/);
  });
  it("稳定期第 5 周（第 3 轮第 1 周）：依据是稳定期第 3、4 周的复盘", () => {
    expect(upgrade(5, 7)).toBe("");
    expect(upgrade(5, 3)).toMatch(/上一轮第 3 或第 4 周/);
  });
  it("直接进入：入门评估要有体检、血压两项，俯卧撑达线；第 1 轮不升级", () => {
    const p = profile([[1, 1, BW40_S]], { ...a40, focus: { areas: ["训练"] } });
    expect(errs(ctx(p, {}, [rec(START, "入门", { base: 2, tests: bwT, prereqs, conclusion: { needDoctor: false } })]))).toBe("");
    expect(errs(ctx(p, {}, [rec(START, "入门", { base: 2, tests: bwT })]))).toMatch(/prereqs|体检|开工前提/);
    const q = profile(run(1, 1, 4, BW40_S), { ...a40, progress: { squat: { level: 2, reps: 15 } } });
    q.progressLog = [{ date: q.segments[3].start, move: "squat", field: "level", to: 2, rule: "升级", evidence: `复盘/${q.segments[2].start}-第3周.json` }];
    expect(plog(q, reviews(q, () => ({ moves: [{ move: "squat", allAtTop: true, spare: 2 }] })))).toMatch(/不能升级/);
  });
  it("12 周表的第 1–2 周写出升级窗口（成品正文由模板生成，这里只看训练单的周次）", () => {
    expect(plans.products[BW40_S].rows.every((r) => r.weeks.every((w) => w >= 1 && w <= 12))).toBe(true);
  });
});
