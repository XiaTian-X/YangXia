// 稳定期（v4 阶段 3a）：轮次、段的阶段、进度规则（找级只给三种人、升级窗口、按轮的不适、健身房双进阶）、
// 进稳定期的两条路、周期末结论、有氧、个人计划单。每条规则有拦下 / 放行用例。只用 contracts/fixtures/。
import { describe, expect, it } from "vitest";
import { ASSESS_FORMAT, type AssessContext, cardioMode, checkAssessments, cycleEnd } from "../src/assess.ts";
import { exportCourse, roundOf } from "../src/plan.ts";
import { SESSION_FORMAT, validateProfile } from "../src/profile.ts";
import { checkProgressLog, FEELS, REVIEW_FORMAT, validateSegments } from "../src/progress.ts";
import { buildSheet, checkSheet } from "../src/sheet.ts";
import { FIX, clone, fitAge, fixtureManifest, fixturePlans, fixtureRules, readJson } from "./helpers.ts";

const manifest = fixtureManifest();
const plans = fixturePlans();
const rules = fixtureRules();
const STARTER = "18-39岁-纯徒手版";
const STABLE = "18-39岁-纯徒手版（稳定期）";
const START = "2026-01-05";
const plus = (d: string, n: number) => new Date(new Date(`${d}T12:00:00Z`).getTime() + n * 86_400_000).toISOString().slice(0, 10);
type Seg = [n: number, phase: "起始" | "稳定", week: number, type?: string, product?: string];
type Rv = [string, Record<string, any>];
const bwT = [{ id: "pushup-test", level: 3, value: 10 }, { id: "wallsit-test", value: 60 }];

/** 档案：segs 每项隔 7 天；起始期用纯徒手版，稳定期用它的稳定期成品。 */
function profile(segs: Seg[], extra: Record<string, any> = {}) {
  const p = readJson<Record<string, any>>(`${FIX}profiles/ok-a18-home.json`);
  p.segments = segs.map(([n, phase, week, type, product], i) => ({
    n, ...(phase === "稳定" ? { phase } : {}), type: type ?? "标准", week, start: plus(START, 7 * i), product: product ?? (phase === "稳定" ? STABLE : STARTER),
  }));
  const last = p.segments[p.segments.length - 1];
  // 样例成品（不在成品清单里）按第一段的成品取年龄段和场地
  const prod = manifest.products.find((x) => x.name === last.product) ?? manifest.products.find((x) => x.name === p.segments[0].product)!;
  Object.assign(p, { age: prod.age, stage: "18–39 岁", product: last.product, venue: prod.venue, startDate: START });
  delete p.wake;
  delete p.bedtime;
  const items = manifest.intake.screening.find((s) => s.age === prod.age)!.items;
  p.screening = { answers: items.map((item) => ({ item, answer: "否" })), doctorCleared: false, date: START };
  fitAge(p, prod.age);
  p.body = "不记";
  p.conditions = { 高血压: false };
  p.choices = ["table-row", "door-row"];
  return Object.assign(p, extra);
}
const weeks = (n: number, phase: "起始" | "稳定", from: number, to: number): Seg[] => Array.from({ length: to - from + 1 }, (_, i) => [n, phase, from + i]);
const review = (p: Record<string, any>, i: number, fields: Record<string, any> = {}): Rv => {
  const s = p.segments[i];
  return [`${s.start}-第${s.week}周.json`, { schema: REVIEW_FORMAT, start: s.start, week: s.week, trainings: 4, checkinDays: 6, symptoms: false, moves: [], habits: { 散步: 5, 冥想: 5 }, ...fields }];
};
const reviews = (p: Record<string, any>, each: (i: number) => Record<string, any> = () => ({})): Rv[] => p.segments.slice(0, -1).map((_: unknown, i: number) => review(p, i, each(i)));
const rec = (date: string, kind: string, fields: Record<string, any> = {}): { name: string; raw: Record<string, any> } =>
  ({ name: `评估/${date}-${kind}.json`, raw: { schema: ASSESS_FORMAT, date, kind, ...fields } });
const entry = (p: Record<string, any>, fields: Record<string, any> = {}) => rec(START, "入门", { tests: bwT, conclusion: {}, ...fields });
const endRec = (p: Record<string, any>, n: number, conclusion: Record<string, any>, kind = "段末") => {
  const seg = p.segments.filter((s: any) => s.n === n);
  return rec(plus(seg[seg.length - 1].start, 6), kind, { segment: n, tests: bwT, conclusion });
};
function ctx(p: Record<string, any>, rv: Rv[], assessments: { name: string; raw: Record<string, any> }[], now?: string): AssessContext {
  const last = p.segments[p.segments.length - 1].start;
  return { profile: p, manifest, plans, rules, sessions: [], reviewData: Object.fromEntries(rv), assessments, now: new Date(`${now ?? plus(last, 2)}T12:00:00`) };
}
const errs = (c: AssessContext) => checkAssessments(c).filter((i) => i.level === "error").map((i) => `${i.path}：${i.message}`);
const warns = (c: AssessContext) => checkAssessments(c).filter((i) => i.level === "warning").map((i) => i.message);
const nowOf = (p: Record<string, any>) => new Date(`${plus(p.segments[p.segments.length - 1].start, 2)}T12:00:00`);
const session = (date: string, items: Record<string, any>[], extra: Record<string, any> = {}) => ({
  name: `打卡/${date}.json`,
  raw: { schema: SESSION_FORMAT, course: { id: "c", name: "x", source: {} }, startedAt: `${date}T19:00:00`, feeling: "正好",
    items: items.map((x) => ({ setsPlanned: 3, setsDone: 3, ...x })), symptoms: { pain: false, dizzy: false, chest: false }, ...extra },
});
const plog = (p: Record<string, any>, rv: Rv[], sessions: any[] = [], assessments: any[] = [], pl = plans) =>
  checkProgressLog(p, pl, rules, sessions, Object.fromEntries(rv), nowOf(p), assessments).filter((i) => i.level === "error").map((i) => i.message).join("\n");

describe("段和轮次", () => {
  it("稳定段周次 1–12、没有减量段、一段只在第 12 周结束", () => {
    const now = new Date("2026-12-31T12:00:00");
    const ok = profile([...weeks(1, "稳定", 1, 12), [2, "稳定", 1]]);
    expect(validateSegments(ok, now)).toEqual([]);
    const cut = profile([...weeks(1, "稳定", 1, 4), [2, "稳定", 1]]);
    expect(validateSegments(cut, now).map((i) => i.message).join()).toMatch(/练完第 12 周（周期末）/);
    const red = profile([[1, "稳定", 1, "减量"]]);
    expect(validateSegments(red, now).map((i) => i.message).join()).toMatch(/稳定期没有减量段/);
    const over = profile([[1, "稳定", 1]]);
    over.segments[0].week = 13;
    expect(validateSegments(over, now).length).toBeGreaterThan(0);
    const mix = profile([[1, "起始", 1], [1, "稳定", 2]]);
    expect(validateSegments(mix, now).map((i) => i.message).join()).toMatch(/同一段里成品、段型、阶段不变/);
  });
  it("轮次 = 练完的 4 周轮数 + 1：直接进入从 1 起，从起始期升上来至少是第 2 轮", () => {
    expect(roundOf(profile([[1, "稳定", 1]]), plans)).toBe(1);
    expect(roundOf(profile(weeks(1, "稳定", 1, 5)), plans)).toBe(2);
    expect(roundOf(profile(weeks(1, "稳定", 1, 9)), plans)).toBe(3);
    expect(roundOf(profile([...weeks(1, "起始", 1, 4), [2, "稳定", 1]]), plans)).toBe(2);
    expect(roundOf(profile([...weeks(1, "起始", 1, 4), ...weeks(2, "稳定", 1, 8)]), plans)).toBe(3);
    // 被提前截断的稳定段只算练满的 4 周；回起始期以后接着往上数
    expect(roundOf(profile([...weeks(1, "稳定", 1, 6), [2, "起始", 1]]), plans)).toBe(2);
    expect(roundOf(profile([...weeks(1, "稳定", 1, 12), [2, "起始", 1]]), plans)).toBe(4);
  });
  it("稳定期第 5 周导出的是这一轮第 1 周的处方（2 组、常速），第 7 周放慢到 3 秒", () => {
    const p5 = profile(weeks(1, "稳定", 1, 5));
    const a1 = exportCourse({ plans, rules, manifest, profile: profile([[1, "起始", 1]]), week: 1, day: "A" }).course!;
    const a5 = exportCourse({ plans, rules, manifest, profile: p5, week: 5, day: "A" }).course!;
    const spec = (c: typeof a1) => c.blocks.flatMap((b) => b.items.map((i) => [i.exercise, i.sets, i.reps ?? i.duration, i.rest, i.tempo?.down]));
    expect(spec(a5)).toEqual(spec(a1));
    expect(a5.source).toMatchObject({ phase: "稳定", week: 5 });
    const a7 = exportCourse({ plans, rules, manifest, profile: profile(weeks(1, "稳定", 1, 7)), week: 7, day: "A" }).course!;
    expect(a7.blocks[0].items[0].tempo).toMatchObject({ down: 3 });
  });
  it("后面几轮才用的级：直接进入的人第 1 轮用不了，第 2 轮（第 5 周）起、从起始期升上来的人都能用", () => {
    const lv = (p: Record<string, any>, week: number) => exportCourse({ plans, rules, manifest, profile: p, week, day: "A" }).issues.filter((i) => i.level === "error").map((i) => i.message).join();
    const direct = profile([[1, "稳定", 1]], { progress: { "split-squat": { level: 3 } } });
    expect(lv(direct, 1)).toMatch(/split-squat」第 3 级第 1 段第 1 周不能用/);
    expect(lv(profile(weeks(1, "稳定", 1, 5), { progress: { "split-squat": { level: 3 } } }), 5)).toBe("");
    expect(lv(profile([...weeks(1, "起始", 1, 4), [2, "稳定", 1]], { progress: { "split-squat": { level: 3 } } }), 1)).toBe("");
  });
  it("稳定期 12 周每一天都能导出，半量课也能", () => {
    for (let w = 1; w <= 12; w++) {
      const p = profile(weeks(1, "稳定", 1, w));
      for (const day of plans.products[STABLE].segments["稳定"].days) {
        for (const half of [false, true]) {
          const r = exportCourse({ plans, rules, manifest, profile: p, week: w, day, half });
          expect(r.issues.filter((i) => i.level === "error"), `第 ${w} 周 ${day} 日${half ? "半量" : ""}`).toEqual([]);
          expect(r.course).toBeTruthy();
        }
      }
    }
  });
  it("模板没有稳定期规则（旧模板）：档案里有稳定段就拦下，提示先更新模板", () => {
    const p = profile([[1, "稳定", 1]], { focus: { areas: ["训练"] } });
    const old = clone(rules);
    delete (old as Record<string, any>).stable;
    expect(errs({ ...ctx(p, [], [entry(p, { base: 2 })]), rules: old }).join()).toMatch(/更新到 v3\.1 之后/);
  });
  it("不能回头导出上一轮更重的周：第 5 周（2 组）导不出第 4 周（3 组、放慢）；这一轮里前面的周可以", () => {
    const msg = (now: number, week: number) => exportCourse({ plans, rules, manifest, profile: profile(weeks(1, "稳定", 1, now)), week, day: "A" })
      .issues.filter((i) => i.level === "error").map((i) => i.message).join();
    expect(msg(5, 4)).toMatch(/比现在这一周重，不能导出/);
    expect(msg(5, 1)).toBe("");
    expect(msg(7, 6)).toBe("");
    expect(msg(7, 3)).toBe("");
    expect(msg(7, 4)).toMatch(/不能导出/);
  });
  it("档案的阶段和成品对不上：拦下", () => {
    const p = profile([[1, "起始", 1, "标准", STABLE]]);
    expect(exportCourse({ plans, rules, manifest, profile: p, week: 1, day: "A" }).issues.map((i) => i.message).join()).toMatch(/phase 要和成品一致/);
    expect(errs(ctx(p, [], [entry(p)])).join()).toMatch(/phase 要和成品一致/);
  });
});

describe("进稳定期的两条路", () => {
  const fromStarter = (trainings: number | number[], fields: (i: number) => Record<string, any> = () => ({})) => {
    const p = profile([...weeks(1, "起始", 1, 4), [2, "稳定", 1]]);
    const t = Array.isArray(trainings) ? trainings : [trainings, trainings, trainings, trainings];
    return { p, rv: reviews(p, (i) => ({ trainings: t[i], ...fields(i) })) };
  };
  it("起始期段末到了进阶线（≥ 14 练、没有不适）：放行", () => {
    const { p, rv } = fromStarter(4);
    expect(errs(ctx(p, rv, [entry(p), endRec(p, 1, { result: "添装备", next: "标准" })]))).toEqual([]);
  });
  it("12–13 练（原样再跑）就进稳定期：拦下", () => {
    const { p, rv } = fromStarter([4, 3, 3, 3]);
    expect(errs(ctx(p, rv, [entry(p), endRec(p, 1, { result: "原样", next: "标准" })])).join()).toMatch(/到了进阶线/);
  });
  it("有不适被降级还进稳定期：拦下", () => {
    const { p, rv } = fromStarter(4, (i) => (i === 1 ? { symptoms: true } : {}));
    expect(errs(ctx(p, rv, [entry(p), endRec(p, 1, { result: "原样", next: "标准", downgraded: true })])).join()).toMatch(/到了进阶线/);
  });
  it("没练完第 4 周、或者用换场地进稳定期：拦下", () => {
    const p = profile([...weeks(1, "起始", 1, 2), [2, "稳定", 1]]);
    const sw = rec(p.segments[2].start, "触发", { reasons: ["换场地"], product: STABLE, tests: bwT, conclusion: {} });
    expect(errs(ctx(p, reviews(p), [entry(p), sw])).join()).toMatch(/进稳定期只有两条路/);
  });
  it("有基础直接进入：训练频率、俯卧撑测试、方向都达线才放行", () => {
    const p = profile([[1, "稳定", 1]], { focus: { areas: ["训练", "饮食"] } });
    expect(errs(ctx(p, [], [entry(p, { base: 2 })]))).toEqual([]);
    expect(errs(ctx(p, [], [entry(p, { base: 1 })])).join()).toMatch(/有基础/);
    expect(errs(ctx(p, [], [entry(p, { base: 2, tests: [{ id: "pushup-test", level: 2, value: 12 }, bwT[1]] })])).join()).toMatch(/第 3 级以上/);
    expect(errs(ctx(p, [], [entry(p, { base: 2, tests: [{ id: "pushup-test", level: 3, value: 7 }, bwT[1]] })])).join()).toMatch(/满 8 次/);
    const q = profile([[1, "稳定", 1]], { focus: { areas: ["作息"] } });
    expect(errs(ctx(q, [], [entry(q, { base: 2 })])).join()).toMatch(/方向要含/);
    const r = profile([[1, "稳定", 1]]);
    expect(errs(ctx(r, [], [entry(r, { base: 2 })])).join()).toMatch(/方向要含/);
  });
  it("俯卧撑测试的级要是阶梯里有的级：随手写第 99 级过不了门槛", () => {
    const p = profile([[1, "稳定", 1]], { focus: { areas: ["训练"] } });
    expect(errs(ctx(p, [], [entry(p, { base: 2, tests: [{ id: "pushup-test", level: 99, value: 8 }, bwT[1]] })])).join()).toMatch(/俯卧撑的难度级只有/);
  });
  it("没登记直接进入门槛的成品（如健身房）：不能直接进稳定期", () => {
    const p = profile([[1, "稳定", 1]], { focus: { areas: ["训练"] } });
    const r = clone(rules);
    r.stable!.params = r.stable!.params.filter((x) => !x.name.startsWith("有基础"));
    expect(errs({ ...ctx(p, [], [entry(p, { base: 2 })]), rules: r }).join()).toMatch(/不设直接进入/);
  });
  it("focus 的写法", () => {
    expect(validateProfile(profile([[1, "稳定", 1]], { focus: { areas: ["减脂"] } })).map((i) => i.message).join()).toMatch(/focus 是/);
  });
});

describe("稳定期的进度规则", () => {
  const up = FEELS[2];
  const top = (move: string) => [{ move, allAtTop: true, spare: 2 }];
  it("找级：从起始期升上来的人第 1–2 周不能往上调；直接进入的人第 1 轮可以", () => {
    const find = (date: string) => [{ date, move: "pushup", field: "level", to: 2, rule: "找级", evidence: `打卡/${date}.json` }];
    const a = profile([...weeks(1, "起始", 1, 4), [2, "稳定", 1]], { progress: { pushup: { level: 2 } } });
    const da = a.segments[4].start;
    a.progressLog = find(da);
    expect(plog(a, reviews(a), [session(da, [{ exercise: "pushup", feel: up }])])).toMatch(/稳定期的找级只给/);
    const b = profile([[1, "稳定", 1]], { progress: { pushup: { level: 2 } } });
    b.progressLog = find(START);
    expect(plog(b, [], [session(START, [{ exercise: "pushup", feel: up }])])).toBe("");
    // 直接进入的人到了第 2 轮（第 5 周）也不能再找级
    const c = profile(weeks(1, "稳定", 1, 5), { progress: { pushup: { level: 2 } } });
    const dc = c.segments[4].start;
    c.progressLog = find(dc);
    expect(plog(c, reviews(c), [session(dc, [{ exercise: "pushup", feel: up }])])).toMatch(/稳定期的找级只给/);
  });
  describe("找级：真的断了四周以上、做过触发评估回来的头 14 天", () => {
    // 稳定期第 3 周从 S 开始，练了一次（S+1）就断了，第 4 周拖到 S+42 才开始
    const make = (logDate: number, evidence: number) => {
      const p = profile([...weeks(1, "起始", 1, 4), ...weeks(2, "稳定", 1, 4)], { progress: { pushup: { level: 2 } } });
      const S = p.segments[6].start;
      p.segments[7].start = plus(S, 42);
      p.progressLog = [{ date: plus(S, logDate), move: "pushup", field: "level", to: 2, rule: "找级", evidence: `打卡/${plus(S, evidence)}.json` }];
      const ss = [session(plus(S, 1), [{ exercise: "pushup", feel: up }]), session(plus(S, 40), [{ exercise: "pushup", feel: up }]), session(plus(S, 45), [{ exercise: "pushup", feel: up }])];
      return { p, S, ss };
    };
    const trig = (S: string, day: number) => [rec(plus(S, day), "触发", { reasons: ["中断"] })];
    it("断了 38 天、触发评估之后练的那一次当依据：放行（不论周次）", () => {
      const { p, S, ss } = make(40, 40);
      expect(plog(p, reviews(p), ss, trig(S, 39))).toBe("");
    });
    it("没有真的断过（触发评估之前只断了 19 天）：写了\"中断\"评估也不能找级", () => {
      const { p, S, ss } = make(40, 40);
      expect(plog(p, reviews(p), ss, trig(S, 20))).toMatch(/稳定期的找级只给/);
    });
    it("拿中断之前的练习记录当依据：拦下", () => {
      const { p, S, ss } = make(40, 1);
      expect(plog(p, reviews(p), ss, trig(S, 39))).toMatch(/做完触发评估（[\d-]+）以后练的那一次/);
    });
    it("过了 14 天：拦下", () => {
      const { p, S, ss } = make(45, 45);
      expect(plog(p, reviews(p), ss, trig(S, 30))).toMatch(/稳定期的找级只给/);
    });
    it("每周都在练、没有中断：\"中断\"触发评估只给提醒，找级照样拦", () => {
      const p = profile([...weeks(1, "起始", 1, 4), ...weeks(2, "稳定", 1, 6)], { progress: { pushup: { level: 2 } } });
      const d = p.segments[9].start;
      p.progressLog = [{ date: d, move: "pushup", field: "level", to: 2, rule: "找级", evidence: `打卡/${d}.json` }];
      const a = [rec(plus(d, -1), "触发", { reasons: ["中断"], conclusion: {} })];
      expect(plog(p, reviews(p), [session(d, [{ exercise: "pushup", feel: up }])], a)).toMatch(/稳定期的找级只给/);
      expect(warns(ctx(p, reviews(p), [entry(p), endRec(p, 1, { result: "添装备", next: "标准" }), ...a])).join()).toMatch(/不算长时间中断/);
    });
  });
  it("升级：每一轮第 4 周（稳定期第 4、8、12 周）；别的周不行", () => {
    const run = (wk: number) => {
      const p = profile([...weeks(1, "起始", 1, 4), ...weeks(2, "稳定", 1, wk)], { progress: { pushup: { level: 2, reps: 8 } } });
      const i = p.segments.length - 1;
      p.progressLog = [{ date: p.segments[i].start, move: "pushup", field: "level", to: 2, rule: "升级", evidence: `复盘/${p.segments[i - 1].start}-第${p.segments[i - 1].week}周.json` }];
      return plog(p, reviews(p, (k) => (k === i - 1 ? { moves: top("pushup") } : {})));
    };
    expect(run(4)).toBe("");
    expect(run(8)).toBe("");
    expect(run(5)).toMatch(/不能升级/);
    expect(run(7)).toMatch(/不能升级/);
  });
  it("不适按轮算：这一轮里有不适，后面不升；下一轮有一周没有不适的复盘就放开", () => {
    const build = (wk: number, sickAt: number) => {
      const p = profile([...weeks(1, "起始", 1, 4), ...weeks(2, "稳定", 1, wk)], { progress: { pushup: { level: 2, reps: 8 } } });
      const i = p.segments.length - 1;
      p.progressLog = [{ date: p.segments[i].start, move: "pushup", field: "level", to: 2, rule: "升级", evidence: `复盘/${p.segments[i - 1].start}-第${p.segments[i - 1].week}周.json` }];
      return plog(p, reviews(p, (k) => ({ ...(k === i - 1 ? { moves: top("pushup") } : {}), ...(k === sickAt ? { symptoms: true } : {}) })));
    };
    expect(build(4, 5)).toMatch(/这一轮（4 周）里/);   // 稳定期第 2 周（下标 5）有不适，第 4 周不升
    expect(build(8, 5)).toBe("");                    // 上一轮有不适，这一轮第 5–7 周都没有：第 8 周可以升
  });
  it("周期末习惯没达标：下一周期的第一轮不升级", () => {
    const p = profile([...weeks(1, "稳定", 1, 12), ...weeks(2, "稳定", 1, 4)], { progress: { pushup: { level: 2, reps: 8 } } });
    const i = p.segments.length - 1;
    p.progressLog = [{ date: START, move: "pushup", field: "level", to: 1, rule: "建档" },
      { date: p.segments[i].start, move: "pushup", field: "level", to: 2, rule: "升级", evidence: `复盘/${p.segments[i - 1].start}-第3周.json` }];
    const rv = reviews(p, (k) => (k === i - 1 ? { moves: top("pushup") } : {}));
    const hold = endRec(p, 1, { result: "习惯没达标", next: { phase: "稳定", hold: true } }, "周期末");
    expect(plog(p, rv, [], [hold])).toMatch(/第一轮（头 4 周）不升级/);
    expect(plog(p, rv, [], [endRec(p, 1, { result: "达标", next: { phase: "稳定" } }, "周期末")])).toBe("");
  });
  it("进度在同一家族里接着用：起始期定的级，稳定期不用重新建档", () => {
    const p = profile([...weeks(1, "起始", 1, 4), [2, "稳定", 1]], { progress: { pushup: { level: 3 } } });
    p.progressLog = [{ date: START, move: "pushup", field: "level", to: 3, rule: "建档" }];
    expect(plog(p, reviews(p))).toBe("");
  });
});

describe("40–64 岁第 2 轮起的升级窗口（起始期、稳定期同一个口径）", () => {
  const BW40 = "40-64岁-纯徒手版";
  const build = (wk: number, evWeek: number | null, moves: string[] = ["glute-bridge"]) => {
    const p = profile([...weeks(1, "起始", 1, 4), ...weeks(2, "起始", 1, wk)].map(([n, ph, w]) => [n, ph, w, "标准", BW40] as Seg));
    Object.assign(p, { age: "a40", stage: "40–64 岁", birth: "1976-05" });
    const i = p.segments.length - 1;
    const ev = evWeek === null ? p.segments[i - 1] : p.segments[evWeek - 1];
    p.progress = Object.fromEntries(moves.map((m) => [m, { level: 2, reps: m === "glute-bridge" ? 20 : 15 }]));
    p.progressLog = moves.map((m) => ({ date: p.segments[i].start, move: m, field: "level", to: 2, rule: "升级", evidence: `复盘/${ev.start}-第${ev.week}周.json` }));
    return plog(p, reviews(p, () => ({ moves: moves.map((m) => ({ move: m, allAtTop: true, spare: 2 })) })));
  };
  it("第 1、2 周可以升，依据是上一轮第 3 或第 4 周的复盘", () => {
    expect(build(1, 4)).toBe("");
    expect(build(2, 3)).toBe("");
  });
  it("第 2 周拿本轮第 1 周（2 组）的复盘当依据：拦下", () => expect(build(2, null)).toMatch(/上一轮第 3 或第 4 周/));
  it("第 3 周：拦下", () => expect(build(3, 4)).toMatch(/不能升级/));
  it("一周升两个动作：拦下", () => expect(build(1, 4, ["glute-bridge", "squat"])).toMatch(/一次只升一样/));
  it("同一个动作第 1 周、第 2 周连升两级（两份依据都是在原来那一级做的）：拦下", () => {
    const p = profile([...weeks(1, "起始", 1, 4), ...weeks(2, "起始", 1, 2)].map(([n, ph, w]) => [n, ph, w, "标准", BW40] as Seg));
    Object.assign(p, { age: "a40", stage: "40–64 岁", birth: "1976-05" });
    const ev = (k: number) => `复盘/${p.segments[k].start}-第${p.segments[k].week}周.json`;
    p.progress = { squat: { level: 3, reps: 15 } };
    p.progressLog = [{ date: p.segments[4].start, move: "squat", field: "level", to: 2, rule: "升级", evidence: ev(2) },
      { date: p.segments[5].start, move: "squat", field: "level", to: 3, rule: "升级", evidence: ev(3) }];
    expect(plog(p, reviews(p, () => ({ moves: [{ move: "squat", allAtTop: true, spare: 2 }] })))).toMatch(/这一轮已经按上一轮的复盘升过一级/);
  });
  it("保加利亚分腿蹲（第 3 级）要到第 3 轮：第 2 轮导不出，第 3 轮可以", () => {
    const at = (segs: Seg[]) => {
      const p = profile(segs.map(([n, ph, w]) => [n, ph, w, "标准", BW40] as Seg), { progress: { "split-squat": { level: 3 } } });
      Object.assign(p, { age: "a40", stage: "40–64 岁", birth: "1976-05" });
      return exportCourse({ plans, rules, manifest, profile: p, week: 1, day: "A" }).issues.filter((i) => i.level === "error").map((i) => i.message).join();
    };
    expect(at([...weeks(1, "起始", 1, 4), [2, "起始", 1]])).toMatch(/split-squat」第 3 级第 2 段第 1 周不能用/);
    expect(at([...weeks(1, "起始", 1, 4), ...weeks(2, "起始", 1, 4), [3, "起始", 1]])).toBe("");
  });
});

describe("健身房双进阶（用起始期健身房版派生一份稳定期样例验规则；真的成品在 3b）", () => {
  const GYM = "18-39岁-健身房版";
  const GS = "健身房稳定期样例";
  const MOVE = "gym-smith-squat";
  const pl = clone(plans);
  pl.products[GS] = { ...clone(pl.products[GYM]), phase: "稳定", base: GYM, segments: { 稳定: { days: pl.products[GYM].segments["标准"].days } },
    rows: pl.products[GYM].rows.filter((r) => r.segments.includes("标准") && r.weeks.includes(4)).map((r) => ({
      ...clone(r), segments: ["稳定"], weeks: Array.from({ length: 12 }, (_, i) => i + 1),
      ...(r.moves.includes(MOVE) ? { reps: { min: 10, max: 12, unit: "reps" as const }, reps_from: "progress" as const } : {}) })) };
  const base = (wk: number, log: Record<string, any>[], progress: Record<string, any>) => {
    const p = profile([...weeks(1, "起始", 1, 4).map(([n, ph, w]) => [n, ph, w, "标准", GYM] as Seg), ...weeks(2, "稳定", 1, wk).map(([n, ph, w]) => [n, ph, w, "标准", GS] as Seg)]);
    p.venue = "gym";
    p.progressLog = [{ date: START, move: MOVE, field: "weight", to: 40, rule: "建档" }, ...log];
    p.progress = { [MOVE]: progress };
    return p;
  };
  const d = (p: Record<string, any>, i: number, off = 0) => plus(p.segments[i].start, off);
  it("加次数：上一次练习记录每组做完、还能做 3 下以上，下一次多做 1 下", () => {
    const p = base(1, [], { weight: 40, reps: 11 });
    p.progressLog.push({ date: d(p, 4, 1), move: MOVE, field: "reps", to: 11, rule: "加次数", evidence: `打卡/${d(p, 4)}.json` });
    expect(plog(p, reviews(p), [session(d(p, 4), [{ exercise: MOVE, spare: 3 }])], [], pl)).toBe("");
    expect(plog(p, reviews(p), [session(d(p, 4), [{ exercise: MOVE, spare: 2 }])], [], pl)).toMatch(/3 下以上/);
    expect(plog(p, reviews(p), [session(d(p, 4), [{ exercise: MOVE, spare: 4, setsDone: 2 }])], [], pl)).toMatch(/每组都做完/);
  });
  it("一周里可以连着加（每练一次最多一次）；同一份记录不能用两次；不能超过 12 次", () => {
    const p = base(1, [], { weight: 40, reps: 12 });
    p.progressLog.push({ date: d(p, 4, 1), move: MOVE, field: "reps", to: 11, rule: "加次数", evidence: `打卡/${d(p, 4)}.json` },
      { date: d(p, 4, 3), move: MOVE, field: "reps", to: 12, rule: "加次数", evidence: `打卡/${d(p, 4, 2)}.json` });
    const two = [session(d(p, 4), [{ exercise: MOVE, spare: 3 }]), session(d(p, 4, 2), [{ exercise: MOVE, spare: 3 }])];
    expect(plog(p, reviews(p), two, [], pl)).toBe("");
    p.progressLog[2].evidence = `打卡/${d(p, 4)}.json`;
    expect(plog(p, reviews(p), two, [], pl)).toMatch(/只能用一次|上一次改动/);
    const q = base(1, [], { weight: 40, reps: 13 });
    q.progressLog.push({ date: d(q, 4, 1), move: MOVE, field: "reps", to: 13, rule: "加次数", evidence: `打卡/${d(q, 4)}.json` });
    expect(plog(q, reviews(q), [session(d(q, 4), [{ exercise: MOVE, spare: 5 }])], [], pl)).toMatch(/只多做 1 下|不能超过 12/);
  });
  const toTwelve = (p: Record<string, any>) => {
    p.progressLog.push({ date: d(p, 4, 1), move: MOVE, field: "reps", to: 11, rule: "加次数", evidence: `打卡/${d(p, 4)}.json` },
      { date: d(p, 4, 3), move: MOVE, field: "reps", to: 12, rule: "加次数", evidence: `打卡/${d(p, 4, 2)}.json` });
    return [session(d(p, 4), [{ exercise: MOVE, spare: 3 }]), session(d(p, 4, 2), [{ exercise: MOVE, spare: 3 }])];
  };
  it("加一档：做到 12 次、每组做完、还留 2 下以上，加一档并回到 10 次；最多加 25%", () => {
    const p = base(2, [], { weight: 45, reps: 10 });
    const ss = toTwelve(p);
    p.progressLog.push({ date: d(p, 5, 1), move: MOVE, field: "weight", to: 45, rule: "加一档", evidence: `打卡/${d(p, 5)}.json` });
    const s3 = session(d(p, 5), [{ exercise: MOVE, spare: 2 }]);
    expect(plog(p, reviews(p), [...ss, s3], [], pl)).toBe("");
    expect(plog(p, reviews(p), [...ss, session(d(p, 5), [{ exercise: MOVE, spare: 1 }])], [], pl)).toMatch(/2 下以上/);
    expect(plog(p, reviews(p), [...ss, session(d(p, 5), [{ exercise: MOVE, spare: 3, reverted: true }])], [], pl)).toMatch(/没有当场退回/);
    const big = base(2, [], { weight: 60, reps: 10 });
    const ss2 = toTwelve(big);
    big.progressLog.push({ date: d(big, 5, 1), move: MOVE, field: "weight", to: 60, rule: "加一档", evidence: `打卡/${d(big, 5)}.json` });
    expect(plog(big, reviews(big), [...ss2, session(d(big, 5), [{ exercise: MOVE, spare: 2 }])], [], pl)).toMatch(/最多加 25%/);
  });
  it("没到 12 次就加一档、稳定期用调重量或加重：拦下", () => {
    const p = base(1, [], { weight: 45, reps: 10 });
    p.progressLog.push({ date: d(p, 4, 1), move: MOVE, field: "weight", to: 45, rule: "加一档", evidence: `打卡/${d(p, 4)}.json` });
    expect(plog(p, reviews(p), [session(d(p, 4), [{ exercise: MOVE, spare: 4 }])], [], pl)).toMatch(/先把次数做到 12 次/);
    const q = base(3, [], { weight: 45 });
    q.progressLog.push({ date: d(q, 6), move: MOVE, field: "weight", to: 45, rule: "加重" });
    expect(plog(q, reviews(q), [], [], pl)).toMatch(/稳定期不用"加重"/);
  });
  it("依据要是最近一次练这个动作的记录：之后又练过一次（没做完），不能拿前一次的当依据", () => {
    const p = base(1, [], { weight: 40, reps: 11 });
    p.progressLog.push({ date: d(p, 4, 3), move: MOVE, field: "reps", to: 11, rule: "加次数", evidence: `打卡/${d(p, 4)}.json` });
    const ss = [session(d(p, 4), [{ exercise: MOVE, spare: 3 }]), session(d(p, 4, 2), [{ exercise: MOVE, spare: 0, setsDone: 2 }])];
    expect(plog(p, reviews(p), ss, [], pl)).toMatch(/最近一次练这个动作/);
  });
  it("上一轮有过不适：这一轮先有一周没有不适的复盘才接着加", () => {
    const p = base(5, [], { weight: 40, reps: 11 });
    p.progressLog.push({ date: d(p, 8, 1), move: MOVE, field: "reps", to: 11, rule: "加次数", evidence: `打卡/${d(p, 8)}.json` });
    const rv = reviews(p, (i) => (i === 5 ? { symptoms: true } : {}));
    expect(plog(p, rv, [session(d(p, 8), [{ exercise: MOVE, spare: 3 }])], [], pl)).toMatch(/上一轮有过疼痛、头晕或胸闷/);
    const q = base(6, [], { weight: 40, reps: 11 });
    q.progressLog.push({ date: d(q, 9, 1), move: MOVE, field: "reps", to: 11, rule: "加次数", evidence: `打卡/${d(q, 9)}.json` });
    expect(plog(q, reviews(q, (i) => (i === 5 ? { symptoms: true } : {})), [session(d(q, 9), [{ exercise: MOVE, spare: 3 }])], [], pl)).toBe("");
  });
  it("起始期不能用加一档", () => {
    const p = profile(weeks(1, "起始", 1, 3).map(([n, ph, w]) => [n, ph, w, "标准", GYM] as Seg));
    p.venue = "gym";
    p.progressLog = [{ date: START, move: MOVE, field: "weight", to: 40, rule: "建档" },
      { date: p.segments[2].start, move: MOVE, field: "weight", to: 45, rule: "加一档", evidence: `打卡/${p.segments[1].start}.json` }];
    p.progress = { [MOVE]: { weight: 45 } };
    expect(plog(p, reviews(p), [session(p.segments[1].start, [{ exercise: MOVE, spare: 3 }])], [], pl)).toMatch(/健身房稳定期双进阶/);
  });
});

describe("周期末结论和下一段", () => {
  const cycle = (each: (i: number) => Record<string, any> = () => ({}), next: Seg = [2, "稳定", 1]) => {
    const p = profile([...weeks(1, "稳定", 1, 12), next], { focus: { areas: ["训练"] } });
    return { p, rv: reviews(p, each) };
  };
  const base = (p: Record<string, any>) => entry(p, { base: 2 });
  it("四条规则从上往下：训练 < 36 → 回起始期减量段；习惯没达标 → 下一周期第一轮不升级；达标 → 下一周期", () => {
    const low = cycle(() => ({ trainings: 2 }));
    expect(cycleEnd(ctx(low.p, low.rv, []), 1)).toMatchObject({ result: "训练没达标", next: { phase: "起始", type: "减量" }, trainings: 24 });
    const habit = cycle((i) => (i < 4 ? { habits: { 散步: 5, 冥想: 2 } } : {}));
    expect(cycleEnd(ctx(habit.p, habit.rv, []), 1)).toMatchObject({ result: "习惯没达标", next: { phase: "稳定", hold: true }, habitWeeks: { 散步: 12, 冥想: 8 } });
    const pass = cycle((i) => (i < 3 ? { habits: { 散步: 5, 冥想: 2 }, trainings: 3 } : {}));
    expect(cycleEnd(ctx(pass.p, pass.rv, []), 1)).toMatchObject({ result: "达标", next: { phase: "稳定" }, trainings: 45 });
  });
  it("每周最多算 4 次训练；不适不计入周期达标", () => {
    const { p, rv } = cycle((i) => ({ trainings: 9, symptoms: i === 3 }));
    expect(cycleEnd(ctx(p, rv, []), 1)).toMatchObject({ result: "达标", trainings: 48 });
  });
  it("连续两个周期习惯没达标：回起始期标准段", () => {
    const p = profile([...weeks(1, "稳定", 1, 12), ...weeks(2, "稳定", 1, 12), [3, "起始", 1]]);
    const rv = reviews(p, (i) => (i % 12 < 4 ? { habits: { 散步: 5, 冥想: 2 } } : {}));
    const first = endRec(p, 1, { result: "习惯没达标", next: { phase: "稳定", hold: true } }, "周期末");
    expect(cycleEnd(ctx(p, rv, [first]), 2)).toMatchObject({ result: "连续两个周期没达标", next: { phase: "起始", type: "标准" } });
  });
  it("周期练完没做周期末评估、结论写错、下一段不照结论：拦下；照结论：放行", () => {
    const { p, rv } = cycle();
    expect(errs(ctx(p, rv, [base(p)])).join()).toMatch(/周期末评估/);
    expect(errs(ctx(p, rv, [base(p), endRec(p, 1, { result: "习惯没达标", next: { phase: "稳定", hold: true } }, "周期末")])).join()).toMatch(/重算的不一致/);
    expect(errs(ctx(p, rv, [base(p), endRec(p, 1, { result: "达标", next: { phase: "稳定" } }, "周期末")]))).toEqual([]);
    const low = cycle(() => ({ trainings: 2 }));
    const lowEnd = endRec(low.p, 1, { result: "训练没达标", next: { phase: "起始", type: "减量" } }, "周期末");
    expect(errs(ctx(low.p, low.rv, [base(low.p), lowEnd])).join()).toMatch(/不能接着开稳定期/);
    const back = cycle(() => ({ trainings: 2 }), [2, "起始", 1, "标准"]);
    expect(errs(ctx(back.p, back.rv, [base(back.p), endRec(back.p, 1, { result: "训练没达标", next: { phase: "起始", type: "减量" } }, "周期末")])).join()).toMatch(/回起始期减量段/);
    const ok = cycle(() => ({ trainings: 2 }), [2, "起始", 1, "减量"]);
    expect(errs(ctx(ok.p, ok.rv, [base(ok.p), endRec(ok.p, 1, { result: "训练没达标", next: { phase: "起始", type: "减量" } }, "周期末")]))).toEqual([]);
  });
  it("结论是回起始期减量段：换场地到别的版本也得是减量段", () => {
    const HOME = "18-39岁-居家版";
    const make = (type: string) => {
      const p = profile([...weeks(1, "稳定", 1, 12), [2, "起始", 1, type, HOME]], { focus: { areas: ["训练"] } });
      p.venue = "home";
      const sw = rec(p.segments[12].start, "触发", { reasons: ["换场地"], product: HOME, tests: bwT, conclusion: {} });
      const end = endRec(p, 1, { result: "训练没达标", next: { phase: "起始", type: "减量" } }, "周期末");
      return errs(ctx(p, reviews(p, () => ({ trainings: 2 })), [base(p), end, sw])).join();
    };
    expect(make("标准")).toMatch(/回起始期减量段，写的是标准段/);
    expect(make("减量")).not.toMatch(/回起始期/);
  });
  it("稳定期中间断过超过 8 周、后来又接着练：不只看最近一次，照样拦", () => {
    const p = profile(weeks(1, "稳定", 1, 5), { focus: { areas: ["训练"] } });
    for (let k = 3; k < 5; k++) p.segments[k].start = plus(p.segments[k].start, 70);   // 第 3 周拖了 11 周
    const out = errs(ctx(p, reviews(p), [base(p), rec(p.segments[3].start, "触发", { reasons: ["中断"], conclusion: {} })])).join();
    expect(out).toMatch(/断了 \d+ 天（超过 56 天）还接着练稳定期/);
  });
  it("周期中途回起始期：要有触发评估（中断、医生建议从头来、自己要求），回标准段", () => {
    const p = profile([...weeks(1, "稳定", 1, 6), [2, "起始", 1]], { focus: { areas: ["训练"] } });
    const rv = reviews(p);
    expect(errs(ctx(p, rv, [base(p)])).join()).toMatch(/一个周期没练完就回起始期/);
    expect(errs(ctx(p, rv, [base(p), rec(p.segments[6].start, "触发", { reasons: ["回起始期"], conclusion: {} })]))).toEqual([]);
    expect(errs(ctx(p, rv, [base(p), rec(p.segments[6].start, "触发", { reasons: ["身体变化"], doctorRestart: true, conclusion: {} })]))).toEqual([]);
  });
  it("稳定期断了超过 8 周：要回起始期", () => {
    const p = profile(weeks(1, "稳定", 1, 3), { focus: { areas: ["训练"] } });
    const out = errs(ctx(p, reviews(p), [base(p), rec(plus(p.segments[2].start, 60), "触发", { reasons: ["中断"], conclusion: {} })], plus(p.segments[2].start, 62)));
    expect(out.join()).toMatch(/回到起始期那一份/);
  });
  it("稳定期里满 40 岁：先补体检血压（没有就拦），新的一轮开始时已经满 40 岁还用 18–39 岁版也拦", () => {
    const p = profile(weeks(1, "稳定", 1, 6), { focus: { areas: ["训练"] }, birth: "1986-01" });
    p.segments.forEach((s: any, i: number) => (s.start = plus("2025-12-08", 7 * i)));   // 第 5 周（新一轮）从 2026-01-05 开始，已满 40 岁
    p.startDate = p.segments[0].start;
    p.screening.date = p.startDate;
    const e = rec(p.startDate, "入门", { tests: bwT, base: 2, conclusion: {} });
    const out = errs(ctx(p, reviews(p), [e])).join();
    expect(out).toMatch(/已经满 40 岁：先做触发评估/);
    expect(out).toMatch(/要在轮的边界换到对应年龄段的起始期/);
  });
  it("新一轮的第 1 周是满 40 岁之前开始的，后来重复这一周：不算又开了一轮，接着练不拦", () => {
    const p = profile([...weeks(1, "稳定", 1, 5), [1, "稳定", 5]], { focus: { areas: ["训练"] }, birth: "1986-01" });
    p.segments.forEach((s: any, i: number) => (s.start = plus("2025-12-01", 7 * i)));   // 第 5 周 2025-12-29 开始（39 岁），重复的第 5 周 2026-01-05 开始（已满 40）
    p.startDate = p.segments[0].start;
    p.screening.date = p.startDate;
    const e = rec(p.startDate, "入门", { tests: bwT, base: 2, conclusion: {} });
    const out = errs(ctx(p, reviews(p), [e], "2026-01-08")).join();
    expect(out).toMatch(/已经满 40 岁：先做触发评估/);      // 体检、血压还是要先补
    expect(out).not.toMatch(/开始新的一轮时已经是/);
  });
});

describe("有氧：每一轮先稳态、再间歇", () => {
  const info = { code: "a18·bw", phase: "稳定" };
  const p = profile(weeks(1, "稳定", 1, 7));
  const rv = (steady?: boolean) => Object.fromEntries(reviews(p, (i) => (i === 5 && steady !== undefined ? { steadyCheck: steady } : {})));
  it("每一轮第 1–2 周稳态；第 3–4 周自查过了才间歇，没过、没记都稳态", () => {
    expect(cardioMode(rules, p, info, 1, 5, rv())).toMatchObject({ mode: "稳态" });
    expect(cardioMode(rules, p, info, 1, 7, rv(true))).toMatchObject({ mode: "间歇" });
    expect(cardioMode(rules, p, info, 1, 7, rv(false))).toMatchObject({ mode: "稳态" });
    expect(cardioMode(rules, p, info, 1, 7, rv())).toMatchObject({ mode: "稳态", why: expect.stringMatching(/还没记/) });
  });
  it("模板的有氧规则有不认识的写法、缺组合条件：一律稳态", () => {
    const odd = clone(rules);
    odd.cardio!.find((x) => x.mode === "间歇")!.when = "someNewRule";
    expect(cardioMode(odd, p, info, 1, 7, rv(true))).toMatchObject({ mode: "稳态" });
    const none = clone(rules);
    none.derivedConditions = [];
    expect(cardioMode(none, p, info, 1, 7, rv(true))).toMatchObject({ mode: "稳态" });
  });
  it("有高血压（或没确认）而且没问过医生：一直稳态；问过医生才按自查", () => {
    const hyper = { ...p, conditions: { 高血压: true } };
    expect(cardioMode(rules, hyper, info, 1, 7, rv(true))).toMatchObject({ mode: "稳态", why: expect.stringMatching(/先问医生/) });
    expect(cardioMode(rules, { ...p, conditions: {} }, info, 1, 7, rv(true))).toMatchObject({ mode: "稳态" });
    expect(cardioMode(rules, { ...p, conditions: { 高血压: true, 有氧问过医生: true } }, info, 1, 7, rv(true))).toMatchObject({ mode: "间歇" });
  });
});

describe("个人计划单", () => {
  const p = profile(weeks(1, "稳定", 1, 7), { focus: { areas: ["训练"] }, progress: { pushup: { level: 2 } } });
  p.progressLog = [{ date: START, move: "pushup", field: "level", to: 2, rule: "建档" }];
  const c = ctx(p, reviews(p, (i) => (i === 5 ? { steadyCheck: true } : {})), [entry(p, { base: 2 })]);
  const NAME = "计划/第1段-第7周.md";
  const levels = (x: AssessContext, name: string, text: string) => checkSheet(x, name, text).map((i) => i.level);
  it("带声明和生成标记；每一天的动作、有氧、习惯、下次评估都有；动作写中文名", () => {
    const { text, issues } = buildSheet(c);
    expect(issues).toEqual([]);
    expect(text).toMatch(/未经专业审核，不是医学建议/);
    expect(text).toMatch(/<!-- 养夏计划单 段=1 周=7 开始=\d{4}-\d{2}-\d{2} 模板=\S+ 进度=\d{4}-\d{2}-\d{2} -->/);
    expect(text).toMatch(/第 2 轮 · 第 3 周/);
    expect(text).toMatch(/### A 日[\s\S]*### D 日/);
    expect(text).toMatch(/照成品做：徒手有氧——这一周做\*\*间歇\*\*/);
    expect(text).toMatch(/散步：每周 ≥ 5 天/);
    expect(text).toMatch(/周期末评估：第 12 周的周复盘之后/);
    expect(text).not.toMatch(/[：（、] ?[a-z]+(-[a-z]+)+/);   // 不留动作编号（sl-rdl 这类）
  });
  it("有高血压、没问过医生的人：计划单写稳态、不做间歇；手改成间歇会被拦下", () => {
    const h = clone(p);
    h.conditions = { 高血压: true };
    const hc = { ...c, profile: h };
    const text = buildSheet(hc).text!;
    expect(text).toMatch(/这一周做\*\*稳态\*\*，不做间歇（有高血压（或没确认）而且没问过医生/);
    expect(text).not.toMatch(/按 D 日第一部分的时长和间歇做/);
    expect(checkSheet(hc, NAME, text)).toEqual([]);
    expect(levels(hc, NAME, text.replace("**稳态**", "**间歇**"))).toEqual(["error"]);
  });
  it("和档案重新生成的一样：通过；手改过、没有标记：拦下", () => {
    const text = buildSheet(c).text!;
    expect(checkSheet(c, NAME, text)).toEqual([]);
    expect(levels(c, NAME, text.replace(/\d组×/, "9组×"))).toEqual(["error"]);
    expect(checkSheet(c, "计划/x.md", "# 自己写的计划").map((i) => i.message).join()).toMatch(/由命令生成/);
  });
  it("手改内容再改标记：段号、周次、开始日期、模板版本、进度日期，哪一个都绕不过", () => {
    const bad = buildSheet(c).text!.replace(/\d组×/, "9组×");
    const tamper = (from: RegExp, to: string, name = NAME) => checkSheet(c, name, bad.replace(from, to)).map((i) => `${i.level}：${i.message}`).join();
    expect(tamper(/段=1/, "段=2")).toMatch(/error：.*文件名和标记要一致/);
    expect(tamper(/段=1/, "段=2", "计划/第2段-第7周.md")).toMatch(/error：.*还没到/);
    expect(tamper(/周=7/, "周=12", "计划/第1段-第12周.md")).toMatch(/error：.*还没到/);
    expect(tamper(/开始=[\d-]+/, "开始=2020-01-01")).toMatch(/error：.*重新生成/);
    expect(tamper(/模板=\S+/, "模板=v0.1")).toMatch(/error：.*模板版本/);
    expect(tamper(/进度=[\d-]+/, "进度=2020-01-01")).toMatch(/error：.*手改过/);
  });
  it("进度在生成之后往上改过：只提醒重新生成；往下调过：旧单子比现在重，报错", () => {
    const text = buildSheet(c).text!;
    const later = (to: number, rule: string) => {
      const q = clone(p);
      q.progressLog.push({ date: q.segments[6].start, move: "pushup", field: "level", to, rule });
      q.progress = { pushup: { level: to } };
      return checkSheet({ ...c, profile: q }, NAME, text).map((i) => `${i.level}：${i.message}`).join();
    };
    expect(later(3, "找级")).toMatch(/^warning：个人进度在这张计划单生成之后改过/);
    expect(later(1, "减量")).toMatch(/^error：.*旧单子比现在重/);
  });
  it("以前几周的单子不再核对内容（周不是正好 7 天、重复过也不误报）；这一周重新开始过要重新生成", () => {
    const old = buildSheet({ ...c, profile: { ...p, segments: p.segments.slice(0, 6) } }).text!;
    expect(checkSheet(c, "计划/第1段-第6周.md", old)).toEqual([]);
    const late = clone(p);
    late.segments[6].start = plus(late.segments[6].start, 2);     // 第 7 周晚 2 天开始
    expect(checkSheet({ ...c, profile: late }, "计划/第1段-第6周.md", old)).toEqual([]);
    const again = clone(p);
    again.segments.push({ ...again.segments[6], start: plus(again.segments[6].start, 7) });   // 重复第 7 周
    const cur = buildSheet(c).text!;
    expect(checkSheet({ ...c, profile: again }, NAME, cur).map((i) => i.message).join()).toMatch(/是按 [\d-]+ 开始的那一周生成的/);
  });
});

describe("阶段 1–2 的规则没被改坏", () => {
  it("起始期第 1–2 周照样找级", () => {
    const p = profile([[1, "起始", 1]], { progress: { pushup: { level: 2 } } });
    p.progressLog = [{ date: START, move: "pushup", field: "level", to: 2, rule: "找级", evidence: `打卡/${START}.json` }];
    expect(plog(p, [], [session(START, [{ exercise: "pushup", feel: FEELS[2] }])])).toBe("");
  });
  it("没有警告以外的问题：从起始期升上来、练到稳定期第 12 周、周期末达标、开下一周期", () => {
    const p = profile([...weeks(1, "起始", 1, 4), ...weeks(2, "稳定", 1, 12), [3, "稳定", 1]]);
    const rv = reviews(p);
    const a = [entry(p), endRec(p, 1, { result: "添装备", next: "标准" }), endRec(p, 2, { result: "达标", next: { phase: "稳定" } }, "周期末")];
    expect(errs(ctx(p, rv, a))).toEqual([]);
    expect(warns(ctx(p, rv, a))).toEqual([]);
    expect(plog(p, rv, [], a)).toBe("");
  });
});
