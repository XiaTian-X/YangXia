// 段序列和个人进度：不复盘不能进下一周；有不适的那一周之后不能加量；进度只能照成品规则改，每条规则都有拦下 / 放行用例。
// 只用 contracts/fixtures/（训练单是离线样例节选），模板仓库不在也会跑。
import { describe, expect, it } from "vitest";
import { checkProgress, checkProgressLog, FEELS, REVIEW_FORMAT, reviewDataName, reviewName, validateReview, validateSegments } from "../src/progress.ts";
import { FIX, clone, fixturePlans, fixtureRules, readJson } from "./helpers.ts";

const plans = fixturePlans();
const rules = fixtureRules();
const P = () => clone(readJson<Record<string, any>>(`${FIX}profiles/ok-a18-home.json`));
const S = () => clone(readJson<Record<string, any>>(`${FIX}sessions/ok-a18-home.json`));
const NOW = new Date("2026-12-31T12:00:00");   // 测试里的"今天"：样例日期都在它之前
const msgs = (xs: { level: string; message: string }[], level = "error") => xs.filter((i) => i.level === level).map((i) => i.message).join("\n");
const DATES = ["2026-11-09", "2026-11-16", "2026-11-23", "2026-11-30", "2026-12-07", "2026-12-14"];

/** 档案：成品 product，周次依次是 weeks（[1,2,3] 表示练到第 3 周），段号依次 ns（默认都在第 1 段）。 */
function profile(product: string, weeks: number[], ns?: number[]) {
  const p = P();
  p.product = product;
  p.segments = weeks.map((w, i) => ({ n: ns?.[i] ?? 1, type: "标准", week: w, start: DATES[i], product }));
  return p;
}
const session = (date: string, items: Record<string, any>[] = [], sick = false) => {
  const s = S();
  s.startedAt = new Date(`${date}T19:00:00`).toISOString();
  if (items.length) s.items = items.map((x) => ({ setsPlanned: 3, setsDone: 3, ...x }));
  if (sick) s.symptoms.pain = true;
  return { name: `打卡/${date}.json`, raw: s };
};
const review = (start: string, week: number, moves: Record<string, any>[] = [], extra: Record<string, any> = {}) =>
  ({ schema: REVIEW_FORMAT, start, week, trainings: 4, symptoms: false, moves, ...extra });
const reviewsFor = (p: Record<string, any>, extra: Record<string, Record<string, any>> = {}) => {
  const out: Record<string, Record<string, any>> = {};
  p.segments.slice(0, -1).forEach((e: any) => (out[reviewDataName(e)] = review(e.start, e.week)));
  return { ...out, ...extra };
};

describe("segments 的结构", () => {
  it("样例档案合格", () => expect(validateSegments(P(), NOW)).toEqual([]));
  const bad: [string, (p: Record<string, any>) => void, RegExp][] = [
    ["缺少 segments", (p) => delete p.segments, /缺少 segments/],
    ["还在用旧字段 weeks", (p) => (p.weeks = []), /旧字段/],
    ["第一项不是第 1 段第 1 周", (p) => (p.segments[0].week = 2), /第 1 段第 1 周/],
    ["第一项和 startDate 不一致", (p) => (p.segments[0].start = "2026-11-10"), /startDate/],
    ["一周不到 7 天", (p) => p.segments.push({ ...p.segments[0], week: 2, start: "2026-11-11" }), /至少练 7 天/],
    ["预先写好以后的推进", (p) => p.segments.push({ ...p.segments[0], week: 2, start: "2027-03-01" }), /还没到/],
    ["跳周", (p) => p.segments.push({ ...p.segments[0], week: 3, start: "2026-11-16" }), /不能直接跳到第 3 周/],
    ["同一段周次往回走", (p) => p.segments.push({ ...p.segments[0], week: 2, start: "2026-11-16" }, { ...p.segments[0], week: 1, start: "2026-11-23" }), /不能往回走/],
    ["没到第 4 周就新开一段", (p) => p.segments.push({ ...p.segments[0], n: 2, start: "2026-11-16" }), /练完第 4 周/],
    ["同一段里换了成品", (p) => p.segments.push({ ...p.segments[0], week: 2, start: "2026-11-16", product: "18-39岁-纯徒手版" }), /新开一段/],
    ["product 和最后一项不一致", (p) => (p.product = "18-39岁-纯徒手版"), /两处要一致/],
  ];
  for (const [name, f, re] of bad) {
    it(`拦下：${name}`, () => {
      const p = P();
      f(p);
      expect(msgs(validateSegments(p, NOW))).toMatch(re);
    });
  }
  it("放行：第 4 周之后新开一段", () => expect(validateSegments(profile("18-39岁-居家版", [1, 2, 3, 4, 1], [1, 1, 1, 1, 2]), NOW)).toEqual([]));
  it("放行：换成品就新开一段", () => {
    const p = profile("18-39岁-居家版", [1, 2, 1], [1, 1, 2]);
    p.segments[2].product = p.product = "18-39岁-纯徒手版";
    expect(validateSegments(p, NOW)).toEqual([]);
  });
});

describe("按日期核对复盘和不适", () => {
  const two = (second: number) => profile("18-39岁-居家版", [1, second]);
  const md = ["2026-11-09-第1周.md"];
  it("复盘文件名：开始日期-第N周", () => expect(reviewName({ week: 2, start: "2026-11-16" })).toBe("2026-11-16-第2周.md"));
  it("正常推进：上一周有复盘（.md 和 .json）、没有不适", () => {
    const p = two(2);
    expect(checkProgress(p, [session("2026-11-10"), session("2026-11-17")], md, NOW, reviewsFor(p))).toEqual([]);
  });
  it("拦下：上一周没有复盘", () => expect(msgs(checkProgress(two(2), [], [], NOW, {}))).toMatch(/没有周复盘/));
  it("拦下：只有 .md 没有复盘数据", () => expect(msgs(checkProgress(two(2), [], md, NOW, {}))).toMatch(/没有复盘数据/));
  it("拦下：复盘写的训练次数少于练习记录", () => {
    const p = two(2);
    const rv = reviewsFor(p, { [reviewDataName(p.segments[0])]: review("2026-11-09", 1, [], { trainings: 1 }) });
    expect(msgs(checkProgress(p, [session("2026-11-10"), session("2026-11-12")], md, NOW, rv))).toMatch(/不能少于练习记录数/);
  });
  it("拦下：练习记录有不适，复盘写没有", () => {
    const p = two(1);
    expect(msgs(checkProgress(p, [session("2026-11-10", [], true)], md, NOW, reviewsFor(p)))).toMatch(/不能写没有不适/);
  });
  it("拦下：上一周有不适还加到下一周", () => {
    const p = two(2);
    const rv = reviewsFor(p, { [reviewDataName(p.segments[0])]: review("2026-11-09", 1, [], { symptoms: true }) });
    expect(msgs(checkProgress(p, [session("2026-11-10", [], true)], md, NOW, rv))).toMatch(/下一周不能加到第 2 周/);
  });
  it("放行：上一周有不适、重复本周", () => {
    const p = two(1);
    const rv = reviewsFor(p, { [reviewDataName(p.segments[0])]: review("2026-11-09", 1, [], { symptoms: true }) });
    expect(checkProgress(p, [session("2026-11-10", [], true)], md, NOW, rv)).toEqual([]);
  });
  it("不适记录挪进 历史/ 也照样算", () => {
    const p = two(2);
    const s = { ...session("2026-11-10", [], true), archived: true };
    expect(msgs(checkProgress(p, [s], md, NOW, reviewsFor(p)))).toMatch(/不能写没有不适/);
  });
  it("提醒：练了比当时更高一周的课程", () => {
    const s = session("2026-11-10");
    s.raw.course.source.week = 3;
    expect(msgs(checkProgress(P(), [s], [], NOW), "warning")).toMatch(/第 3 周的课程，当时还在第 1 周/);
  });
});

describe("复盘数据的格式", () => {
  it("合格", () => expect(validateReview(review("2026-11-09", 1, [{ move: "pushup", allAtTop: true, spare: 2 }]))).toEqual([]));
  it("拦下：缺不适、动作表现写法不对", () => {
    const r: Record<string, any> = review("2026-11-09", 1, [{ move: "pushup", allAtTop: "是" }]);
    delete r.symptoms;
    expect(msgs(validateReview(r))).toMatch(/symptoms[\s\S]*allAtTop/);
  });
});

// ---------- 个人进度规则 ----------

const BW = "18-39岁-纯徒手版";
const BW40 = "40-64岁-纯徒手版";
const GYM = "18-39岁-健身房版";
type Log = Record<string, any>;
function run(product: string, weeks: number[], log: Log[], progress: Record<string, any>, opts: { ns?: number[]; sessions?: any[]; reviews?: Record<string, any> } = {}) {
  const p = profile(product, weeks, opts.ns);
  p.progressLog = log;
  p.progress = progress;
  return msgs(checkProgressLog(p, plans, rules, opts.sessions ?? [], { ...reviewsFor(p), ...(opts.reviews ?? {}) }, NOW));
}
const up = FEELS[2];
const down = FEELS[0];

describe("个人进度：建档", () => {
  it("放行：开始那天记起始级、区间下限", () => {
    expect(run(BW, [1], [{ date: "2026-11-09", move: "pushup", field: "level", to: 3, rule: "建档" },
      { date: "2026-11-09", move: "pushup", field: "reps", to: 8, rule: "建档" }], { pushup: { level: 3, reps: 8 } })).toBe("");
  });
  it("拦下：建档不在开始那天", () => {
    expect(run(BW, [1, 2], [{ date: "2026-11-16", move: "pushup", field: "level", to: 3, rule: "建档" }], { pushup: { level: 3 } })).toMatch(/建档只能在开始那天/);
  });
  it("拦下：建档次数不是区间下限", () => {
    expect(run(BW, [1], [{ date: "2026-11-09", move: "pushup", field: "reps", to: 12, rule: "建档" }], { pushup: { reps: 12 } })).toMatch(/区间下限 8/);
  });
  it("拦下：第 1 周不能用的级（分腿蹲第 2 级）", () => {
    expect(run(BW, [1], [{ date: "2026-11-09", move: "split-squat", field: "level", to: 2, rule: "建档" }], { "split-squat": { level: 2 } })).toMatch(/不能用/);
  });
  it("拦下：档案的 progress 和日志重放对不上（直接改了进度）", () => {
    expect(run(BW, [1], [], { pushup: { level: 4 } })).toMatch(/按 progressLog 重放应该是/);
  });
});

describe("个人进度：找级（第 1–2 周，按练习记录的感受调一级）", () => {
  const s = (feel: string) => session("2026-11-10", [{ exercise: "pushup", feel }]);
  it("放行：做到上限还很轻松，下次升一级", () => {
    expect(run(BW, [1], [{ date: "2026-11-11", move: "pushup", field: "level", to: 2, rule: "找级", evidence: "打卡/2026-11-10.json" }],
      { pushup: { level: 2 } }, { sessions: [s(up)] })).toBe("");
  });
  it("放行：做不到下限，降一级", () => {
    expect(run(BW, [1], [{ date: "2026-11-09", move: "pushup", field: "level", to: 3, rule: "建档" },
      { date: "2026-11-11", move: "pushup", field: "level", to: 2, rule: "找级", evidence: "打卡/2026-11-10.json" }],
      { pushup: { level: 2 } }, { sessions: [s(down)] })).toBe("");
  });
  it("拦下：感受对不上", () => {
    expect(run(BW, [1], [{ date: "2026-11-11", move: "pushup", field: "level", to: 2, rule: "找级", evidence: "打卡/2026-11-10.json" }],
      { pushup: { level: 2 } }, { sessions: [s(FEELS[1])] })).toMatch(/升一级要"做到上限还很轻松"/);
  });
  it("拦下：没写依据", () => {
    expect(run(BW, [1], [{ date: "2026-11-11", move: "pushup", field: "level", to: 2, rule: "找级" }], { pushup: { level: 2 } })).toMatch(/找级要写依据/);
  });
  it("拦下：一次调两级", () => {
    expect(run(BW, [1], [{ date: "2026-11-11", move: "pushup", field: "level", to: 3, rule: "找级", evidence: "打卡/2026-11-10.json" }],
      { pushup: { level: 3 } }, { sessions: [s(up)] })).toMatch(/上下调一级/);
  });
  it("拦下：第 3 周不是找级的周", () => {
    const s3 = session("2026-11-24", [{ exercise: "pushup", feel: up }]);
    expect(run(BW, [1, 2, 3], [{ date: "2026-11-25", move: "pushup", field: "level", to: 2, rule: "找级", evidence: "打卡/2026-11-24.json" }],
      { pushup: { level: 2 } }, { sessions: [s3] })).toMatch(/不是找级的周/);
  });
  it("拦下：这一周有不适还往上调", () => {
    const sick = session("2026-11-10", [{ exercise: "pushup", feel: up }], true);
    expect(run(BW, [1], [{ date: "2026-11-11", move: "pushup", field: "level", to: 2, rule: "找级", evidence: "打卡/2026-11-10.json" }],
      { pushup: { level: 2 } }, { sessions: [sick] })).toMatch(/不加量、不升级/);
  });
});

describe("个人进度：升级（达标、允许的周、一次一样）", () => {
  const toTop = { date: "2026-11-09", move: "pushup", field: "reps", to: 8, rule: "建档" };
  const reps = (to: number, date: string, ev: string) => ({ date, move: "pushup", field: "reps", to, rule: "加次数", evidence: ev });
  // 18–39 岁：第 1 周 8 次，之后按复盘每次加 2 次到 14，第 4 周到上限 15
  const climb = [toTop, reps(10, "2026-11-16", "复盘/2026-11-09-第1周.json"), reps(12, "2026-11-23", "复盘/2026-11-16-第2周.json"),
    reps(14, "2026-11-25", "复盘/2026-11-16-第2周.json")];
  const easy = (start: string, week: number, allAtTop = false) => ({ [`${start}-第${week}周.json`]: review(start, week, [{ move: "pushup", allAtTop, spare: 2 }]) });
  const reviews = { ...easy("2026-11-09", 1), ...easy("2026-11-16", 2), ...easy("2026-11-23", 3, true) };
  it("放行：第 4 周，次数到上限、复盘里每组做满还有余力，升一级、次数回到下限", () => {
    const log = [...climb, reps(15, "2026-11-30", "复盘/2026-11-23-第3周.json"),
      { date: "2026-12-01", move: "pushup", field: "level", to: 2, rule: "升级", evidence: "复盘/2026-11-23-第3周.json" }];
    expect(run(BW, [1, 2, 3, 4], log, { pushup: { level: 2, reps: 8 } }, { reviews })).toBe("");
  });
  it("拦下：复盘里没有每组做满", () => {
    const log = [...climb, reps(15, "2026-11-30", "复盘/2026-11-23-第3周.json"),
      { date: "2026-12-01", move: "pushup", field: "level", to: 2, rule: "升级", evidence: "复盘/2026-11-23-第3周.json" }];
    expect(run(BW, [1, 2, 3, 4], log, { pushup: { level: 2, reps: 8 } }, { reviews: { ...reviews, ...easy("2026-11-23", 3, false) } })).toMatch(/每组都做到上限/);
  });
  it("放行：40–64 岁下一段从第 1 周起可以升", () => {
    const log = [...climb, reps(15, "2026-11-30", "复盘/2026-11-23-第3周.json"),
      { date: "2026-12-08", move: "pushup", field: "level", to: 2, rule: "升级", evidence: "复盘/2026-11-30-第4周.json" }];
    expect(run(BW40, [1, 2, 3, 4, 1], log, { pushup: { level: 2, reps: 8 } }, { ns: [1, 1, 1, 1, 2], reviews: { ...reviews, ...easy("2026-11-30", 4, true) } })).toBe("");
  });
  it("拦下：次数还没到区间上限就升级", () => {
    const log = [...climb, { date: "2026-12-01", move: "pushup", field: "level", to: 2, rule: "升级", evidence: "复盘/2026-11-23-第3周.json" }];
    expect(run(BW, [1, 2, 3, 4], log, { pushup: { level: 2, reps: 8 } }, { reviews })).toMatch(/要到区间上限 15/);
  });
  it("拦下：第 3 周升级（18–39 岁第 4 周起才升）", () => {
    const log = [toTop, { date: "2026-11-24", move: "pushup", field: "level", to: 2, rule: "升级", evidence: "复盘/2026-11-16-第2周.json" }];
    expect(run(BW, [1, 2, 3], log, { pushup: { level: 2, reps: 8 } }, { reviews })).toMatch(/不能升级/);
  });
  it("拦下：40–64 岁这一轮第 4 周也不升级", () => {
    const log = [{ ...toTop }, { date: "2026-12-01", move: "pushup", field: "level", to: 2, rule: "升级", evidence: "复盘/2026-11-23-第3周.json" }];
    expect(run(BW40, [1, 2, 3, 4], log, { pushup: { level: 2, reps: 8 } }, { reviews })).toMatch(/这一轮不升级/);
  });
  it("拦下：升级和加次数同一天（一次只改一样）", () => {
    const log = [...climb, reps(15, "2026-12-02", "复盘/2026-11-23-第3周.json"),
      { date: "2026-12-02", move: "pushup", field: "level", to: 2, rule: "升级", evidence: "复盘/2026-11-23-第3周.json" }];
    expect(run(BW, [1, 2, 3, 4], log, { pushup: { level: 2, reps: 8 } }, { reviews })).toMatch(/一次只改一样/);
  });
});

describe("个人进度：加次数、退回、减量", () => {
  const base = { date: "2026-11-09", move: "pushup", field: "reps", to: 8, rule: "建档" };
  const rv = { "2026-11-09-第1周.json": review("2026-11-09", 1, [{ move: "pushup", allAtTop: false, spare: 2 }]) };
  it("放行：复盘里还有余力，加 2 次", () => {
    expect(run(BW, [1, 2], [base, { date: "2026-11-16", move: "pushup", field: "reps", to: 10, rule: "加次数", evidence: "复盘/2026-11-09-第1周.json" }], { pushup: { reps: 10 } }, { reviews: rv })).toBe("");
  });
  it("拦下：一次加 3 次", () => {
    expect(run(BW, [1, 2], [base, { date: "2026-11-16", move: "pushup", field: "reps", to: 11, rule: "加次数", evidence: "复盘/2026-11-09-第1周.json" }], { pushup: { reps: 11 } }, { reviews: rv })).toMatch(/每次加 1–2 次/);
  });
  it("拦下：复盘里没有余力", () => {
    const tired = { "2026-11-09-第1周.json": review("2026-11-09", 1, [{ move: "pushup", allAtTop: false, spare: 0 }]) };
    expect(run(BW, [1, 2], [base, { date: "2026-11-16", move: "pushup", field: "reps", to: 9, rule: "加次数", evidence: "复盘/2026-11-09-第1周.json" }], { pushup: { reps: 9 } }, { reviews: tired })).toMatch(/还有余力/);
  });
  it("拦下：周表定次数的动作（循环、健身房主项）不记次数", () => {
    expect(run(GYM, [1], [{ date: "2026-11-09", move: "gym-smith-squat", field: "reps", to: 12, rule: "建档" }], { "gym-smith-squat": { reps: 12 } })).toMatch(/周表/);
  });
  it("放行：升级做不到当场退回（练习记录标了退回）", () => {
    const s = session("2026-11-10", [{ exercise: "pushup", reverted: true }]);
    expect(run(BW, [1], [{ date: "2026-11-09", move: "pushup", field: "level", to: 3, rule: "建档" },
      { date: "2026-11-10", move: "pushup", field: "level", to: 2, rule: "退回", evidence: "打卡/2026-11-10.json" }], { pushup: { level: 2 } }, { sessions: [s] })).toBe("");
  });
  it("拦下：退回没有依据", () => {
    expect(run(BW, [1], [{ date: "2026-11-09", move: "pushup", field: "level", to: 3, rule: "建档" },
      { date: "2026-11-10", move: "pushup", field: "level", to: 2, rule: "退回" }], { pushup: { level: 2 } })).toMatch(/退回要写依据/);
  });
  it("放行：减量随时可以（有不适也行）", () => {
    const sick = session("2026-11-10", [], true);
    expect(run(BW, [1], [{ date: "2026-11-09", move: "pushup", field: "level", to: 3, rule: "建档" },
      { date: "2026-11-11", move: "pushup", field: "level", to: 2, rule: "减量" }], { pushup: { level: 2 } }, { sessions: [sick] })).toBe("");
  });
  it("拦下：减量写成往上调", () => {
    expect(run(BW, [1], [{ date: "2026-11-11", move: "pushup", field: "level", to: 2, rule: "减量" }], { pushup: { level: 2 } })).toMatch(/只能往下调/);
  });
});

describe("个人进度：健身房重量", () => {
  const start = { date: "2026-11-09", move: "gym-smith-squat", field: "weight", to: 20, rule: "建档" };
  const spare = (date: string, n: number) => session(date, [{ exercise: "gym-smith-squat", spare: n }]);
  it("放行：第 2 周还能做 6 下以上，加一档", () => {
    expect(run(GYM, [1, 2], [start, { date: "2026-11-18", move: "gym-smith-squat", field: "weight", to: 25, rule: "调重量", evidence: "打卡/2026-11-17.json" }],
      { "gym-smith-squat": { weight: 25 } }, { sessions: [spare("2026-11-17", 7)] })).toBe("");
  });
  it("拦下：第 1 周调重量", () => {
    expect(run(GYM, [1], [start, { date: "2026-11-11", move: "gym-smith-squat", field: "weight", to: 25, rule: "调重量", evidence: "打卡/2026-11-10.json" }],
      { "gym-smith-squat": { weight: 25 } }, { sessions: [spare("2026-11-10", 7)] })).toMatch(/不调重量/);
  });
  it("拦下：还能做的不到 6 下", () => {
    expect(run(GYM, [1, 2], [start, { date: "2026-11-18", move: "gym-smith-squat", field: "weight", to: 25, rule: "调重量", evidence: "打卡/2026-11-17.json" }],
      { "gym-smith-squat": { weight: 25 } }, { sessions: [spare("2026-11-17", 4)] })).toMatch(/6 下以上/);
  });
  it("放行：第 3 周加重一次；拦下：第 4 周加重、同一段加两次", () => {
    const w3 = { date: "2026-11-23", move: "gym-smith-squat", field: "weight", to: 25, rule: "加重" };
    expect(run(GYM, [1, 2, 3], [start, w3], { "gym-smith-squat": { weight: 25 } })).toBe("");
    expect(run(GYM, [1, 2, 3, 4], [start, { ...w3, date: "2026-11-30" }], { "gym-smith-squat": { weight: 25 } })).toMatch(/不加重/);
    expect(run(GYM, [1, 2, 3], [start, w3, { ...w3, date: "2026-11-25", to: 30 }], { "gym-smith-squat": { weight: 30 } })).toMatch(/已经加过重/);
  });
  it("拦下：还没记起始重量就加重", () => {
    expect(run(GYM, [1, 2, 3], [{ date: "2026-11-23", move: "gym-smith-squat", field: "weight", to: 25, rule: "加重" }], { "gym-smith-squat": { weight: 25 } })).toMatch(/还没记过起始重量/);
  });
});
