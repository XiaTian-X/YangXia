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
const HOME = "18-39岁-居家版";
const OLD = "65岁以上-椅子辅助版";
type Log = Record<string, any>;
function run(product: string, weeks: number[], log: Log[], progress: Record<string, any>, opts: { ns?: number[]; products?: string[]; sessions?: any[]; reviews?: Record<string, any> } = {}) {
  const p = profile(product, weeks, opts.ns);
  if (opts.products) {
    p.segments.forEach((s: any, i: number) => (s.product = opts.products![i]));
    p.product = opts.products[opts.products.length - 1];
  }
  p.progressLog = log;
  p.progress = progress;
  return msgs(checkProgressLog(p, plans, rules, opts.sessions ?? [], { ...reviewsFor(p), ...(opts.reviews ?? {}) }, NOW));
}
const up = FEELS[2];
const down = FEELS[0];
/** 第 week 周（DATES[week-1] 开始）的复盘数据，move 的表现。 */
const rv = (week: number, moves: Record<string, any>[], extra: Record<string, any> = {}) =>
  ({ [`${DATES[week - 1]}-第${week}周.json`]: review(DATES[week - 1], week, moves, extra) });
const ev = (week: number) => `复盘/${DATES[week - 1]}-第${week}周.json`;

describe("个人进度：建档", () => {
  it("放行：开始那天记起始级、区间下限", () => {
    expect(run(BW, [1], [{ date: "2026-11-09", move: "pushup", field: "level", to: 3, rule: "建档" },
      { date: "2026-11-09", move: "pushup", field: "reps", to: 8, rule: "建档" }], { pushup: { level: 3, reps: 8 } })).toBe("");
  });
  it("拦下：建档不在开始那天", () => {
    expect(run(BW, [1, 2], [{ date: "2026-11-16", move: "pushup", field: "level", to: 3, rule: "建档" }], { pushup: { level: 3 } })).toMatch(/建档只能在这份成品开始那天/);
  });
  it("拦下：建档次数不是区间下限", () => {
    expect(run(BW, [1], [{ date: "2026-11-09", move: "pushup", field: "reps", to: 12, rule: "建档" }], { pushup: { reps: 12 } })).toMatch(/区间下限 8/);
  });
  it("拦下：第 1 周不能用的级（分腿蹲第 2 级）", () => {
    expect(run(BW, [1], [{ date: "2026-11-09", move: "split-squat", field: "level", to: 2, rule: "建档" }], { "split-squat": { level: 2 } })).toMatch(/起步能用的级/);
  });
  it("拦下：档案的 progress 和日志重放对不上（直接改了进度）", () => {
    expect(run(BW, [1], [], { pushup: { level: 4 } })).toMatch(/按 progressLog 重放应该是/);
  });
  it("放行：换成品那天在新成品里重新建档；拦下：不重新建档就沿用别的成品的级号", () => {
    const products = [BW, BW, BW, BW, HOME];
    const opts = { ns: [1, 1, 1, 1, 2], products };
    const base = [{ date: "2026-11-09", move: "pushup", field: "level", to: 3, rule: "建档" }];
    expect(run(BW, [1, 2, 3, 4, 1], [...base, { date: "2026-12-07", move: "pushup", field: "level", to: 3, rule: "建档" }], { pushup: { level: 3 } }, opts)).toBe("");
    expect(run(BW, [1, 2, 3, 4, 1], base, { pushup: { level: 3 } }, opts)).toMatch(/重新"建档"/);
  });
});

describe("个人进度：找级（第 1–2 周，按练习记录的感受调一级）", () => {
  const s = (feel: string, date = "2026-11-10", extra: Record<string, any> = {}) => session(date, [{ exercise: "pushup", feel, ...extra }]);
  const step = (date: string, to: number, evidence = "打卡/2026-11-10.json") => ({ date, move: "pushup", field: "level", to, rule: "找级", evidence });
  it("放行：做到上限还很轻松，下次升一级", () => {
    expect(run(BW, [1], [step("2026-11-11", 2)], { pushup: { level: 2 } }, { sessions: [s(up)] })).toBe("");
  });
  it("放行：做不到下限，降一级", () => {
    expect(run(BW, [1], [{ date: "2026-11-09", move: "pushup", field: "level", to: 3, rule: "建档" }, step("2026-11-11", 2)],
      { pushup: { level: 2 } }, { sessions: [s(down)] })).toBe("");
  });
  it("放行：两次训练各自的感受，两次各升一级", () => {
    expect(run(BW, [1], [step("2026-11-11", 2), step("2026-11-13", 3, "打卡/2026-11-12.json")], { pushup: { level: 3 } },
      { sessions: [s(up), s(up, "2026-11-12")] })).toBe("");
  });
  it("拦下：感受对不上", () => {
    expect(run(BW, [1], [step("2026-11-11", 2)], { pushup: { level: 2 } }, { sessions: [s(FEELS[1])] })).toMatch(/升一级要"做到上限还很轻松"/);
  });
  it("拦下：没写依据", () => {
    expect(run(BW, [1], [{ date: "2026-11-11", move: "pushup", field: "level", to: 2, rule: "找级" }], { pushup: { level: 2 } })).toMatch(/依据要写/);
  });
  it("拦下：两份记录都在上一次改动之前（攒着连升两级）", () => {
    expect(run(BW, [1], [step("2026-11-13", 2), step("2026-11-14", 3, "打卡/2026-11-12.json")], { pushup: { level: 3 } },
      { sessions: [s(up), s(up, "2026-11-12")] })).toMatch(/上一次改动/);
  });
  it("拦下：同一份练习记录连着用（一份记录升好几级）", () => {
    expect(run(BW, [1], [step("2026-11-11", 2), step("2026-11-12", 3)], { pushup: { level: 3 } }, { sessions: [s(up)] })).toMatch(/只能用一次/);
  });
  it("拦下：依据的练习记录在改动之后", () => {
    expect(run(BW, [1], [step("2026-11-10", 2, "打卡/2026-11-12.json")], { pushup: { level: 2 } }, { sessions: [s(up, "2026-11-12")] })).toMatch(/早于这条改动/);
  });
  it("拦下：依据是手改过的课程、或者这个动作没练", () => {
    expect(run(BW, [1], [step("2026-11-11", 2)], { pushup: { level: 2 } }, { sessions: [{ ...s(up), raw: { ...s(up).raw, edited: true } }] })).toMatch(/edited/);
    expect(run(BW, [1], [step("2026-11-11", 2)], { pushup: { level: 2 } }, { sessions: [s(up, "2026-11-10", { setsDone: 0 })] })).toMatch(/没练/);
  });
  it("拦下：一次调两级", () => {
    expect(run(BW, [1], [step("2026-11-11", 3)], { pushup: { level: 3 } }, { sessions: [s(up)] })).toMatch(/上下调一级/);
  });
  it("拦下：第 3 周不是找级的周", () => {
    expect(run(BW, [1, 2, 3], [step("2026-11-25", 2, "打卡/2026-11-24.json")], { pushup: { level: 2 } }, { sessions: [s(up, "2026-11-24")] })).toMatch(/不是找级的周/);
  });
  it("拦下：这一周有不适还往上调", () => {
    const sick = session("2026-11-10", [{ exercise: "pushup", feel: up }], true);
    expect(run(BW, [1], [step("2026-11-11", 2)], { pushup: { level: 2 } }, { sessions: [sick] })).toMatch(/不加量、不升级/);
  });
});

describe("个人进度：升级（达标、允许的周、紧挨着的上一周复盘）", () => {
  const easy = (week: number, allAtTop = true) => rv(week, [{ move: "glute-bridge", allAtTop, spare: 2 }]);
  const lvUp = (date: string, week: number) => ({ date, move: "glute-bridge", field: "level", to: 2, rule: "升级", evidence: ev(week) });
  it("放行：第 4 周，次数在区间上限、上一周复盘每组做满还有余力，升一级、次数回到下限", () => {
    // 臀桥是"3 组 × 20 次"，次数就是上限
    expect(run(BW, [1, 2, 3, 4], [lvUp("2026-11-30", 3)], { "glute-bridge": { level: 2, reps: 20 } }, { reviews: easy(3) })).toBe("");
  });
  it("放行：俯卧撑 8–15 次，档案次数还没加到 15，上一周复盘每组都做到上限就能升（18–39 岁第 4 周的正常路径）", () => {
    expect(run(BW, [1, 2, 3, 4], [{ date: "2026-11-30", move: "pushup", field: "level", to: 2, rule: "升级", evidence: ev(3) }],
      { pushup: { level: 2, reps: 8 } }, { reviews: rv(3, [{ move: "pushup", allAtTop: true, spare: 2 }]) })).toBe("");
  });
  it("拦下：复盘里没有每组做满", () => {
    expect(run(BW, [1, 2, 3, 4], [lvUp("2026-11-30", 3)], { "glute-bridge": { level: 2, reps: 20 } }, { reviews: easy(3, false) })).toMatch(/每组都做到区间上限/);
  });
  it("拦下：依据不是紧挨着的上一周（拿第 1 周的复盘升级）", () => {
    expect(run(BW, [1, 2, 3, 4], [lvUp("2026-11-30", 1)], { "glute-bridge": { level: 2, reps: 20 } }, { reviews: easy(1) })).toMatch(/紧挨着的上一周/);
  });
  it("拦下：第 3 周升级（18–39 岁第 4 周才升）", () => {
    expect(run(BW, [1, 2, 3], [lvUp("2026-11-23", 2)], { "glute-bridge": { level: 2, reps: 20 } }, { reviews: easy(2) })).toMatch(/不能升级/);
  });
  it("拦下：40–64 岁这一轮第 4 周也不升级；放行：下一段从第 1 周起", () => {
    expect(run(BW40, [1, 2, 3, 4], [lvUp("2026-11-30", 3)], { "glute-bridge": { level: 2, reps: 20 } }, { reviews: easy(3) })).toMatch(/这一轮不升级/);
    expect(run(BW40, [1, 2, 3, 4, 1], [lvUp("2026-12-07", 4)], { "glute-bridge": { level: 2, reps: 20 } }, { ns: [1, 1, 1, 1, 2], reviews: easy(4) })).toBe("");
  });
  it("拦下：上一周有不适，新开一段当天就升级", () => {
    expect(run(BW40, [1, 2, 3, 4, 1], [lvUp("2026-12-07", 4)], { "glute-bridge": { level: 2, reps: 20 } },
      { ns: [1, 1, 1, 1, 2], reviews: rv(4, [{ move: "glute-bridge", allAtTop: true, spare: 2 }], { symptoms: true }) })).toMatch(/不适|不加量/);
  });
  it("放行：第 2 段的难度级按成品 + 以后放开（18–39 岁第 2 段第 1 周能用保加利亚分腿蹲那一级）", () => {
    expect(run(BW, [1, 2, 3, 4, 1], [{ date: "2026-12-07", move: "split-squat", field: "level", to: 2, rule: "找级", evidence: "打卡/2026-12-07.json" }],
      { "split-squat": { level: 2 } }, { ns: [1, 1, 1, 1, 2], sessions: [session("2026-12-07", [{ exercise: "split-squat", feel: up }])] })).toBe("");
  });
});

describe("个人进度：加次数、退回、减量", () => {
  const base = { date: "2026-11-09", move: "pushup", field: "reps", to: 8, rule: "建档" };
  const add = (date: string, to: number, week: number) => ({ date, move: "pushup", field: "reps", to, rule: "加次数", evidence: ev(week) });
  const fine = (week: number, spare = 4, extra: Record<string, any> = {}) => rv(week, [{ move: "pushup", allAtTop: false, allDone: true, spare }], extra);
  it("放行：上一周每组做满、余力比目标多，加 2 次", () => {
    expect(run(BW, [1, 2], [base, add("2026-11-16", 10, 1)], { pushup: { reps: 10 } }, { reviews: fine(1) })).toBe("");
  });
  it("拦下：一次加 3 次", () => {
    expect(run(BW, [1, 2], [base, add("2026-11-16", 11, 1)], { pushup: { reps: 11 } }, { reviews: fine(1) })).toMatch(/每次加 1–2 次/);
  });
  it("拦下：余力只有目标那么多（2–3 次）就加", () => {
    expect(run(BW, [1, 2], [base, add("2026-11-16", 10, 1)], { pushup: { reps: 10 } }, { reviews: fine(1, 2) })).toMatch(/余力/);
  });
  it("拦下：同一份复盘一周里连加两次", () => {
    expect(run(BW, [1, 2], [base, add("2026-11-16", 10, 1), add("2026-11-18", 12, 1)], { pushup: { reps: 12 } }, { reviews: fine(1) })).toMatch(/每周最多|只能用一次/);
  });
  it("拦下：依据那一周有不适", () => {
    expect(run(BW, [1, 1], [base, add("2026-11-16", 10, 1)], { pushup: { reps: 10 } }, { reviews: fine(1, 4, { symptoms: true }) })).toMatch(/不适|不加量/);
  });
  it("拦下：这一段早些时候有不适，后面还加", () => {
    const sick = session("2026-11-10", [], true);
    const p = { ...fine(2) };
    expect(run(BW, [1, 1, 2], [base, { ...add("2026-11-23", 10, 2) }], { pushup: { reps: 10 } },
      { sessions: [sick], reviews: { ...rv(1, [], { symptoms: true }), ...p } })).toMatch(/这一段里/);
  });
  it("65 岁以上：要连着两次训练都轻松才加", () => {
    const b = { date: "2026-11-09", move: "a65-01-sit-to-stand", field: "reps", to: 8, rule: "建档" };
    const a = { date: "2026-11-16", move: "a65-01-sit-to-stand", field: "reps", to: 10, rule: "加次数", evidence: ev(1) };
    const r = (extra: Record<string, any>) => rv(1, [{ move: "a65-01-sit-to-stand", allAtTop: false, allDone: true, spare: 4, ...extra }]);
    expect(run(OLD, [1, 2], [b, a], { "a65-01-sit-to-stand": { reps: 10 } }, { reviews: r({}) })).toMatch(/连着两次/);
    expect(run(OLD, [1, 2], [b, a], { "a65-01-sit-to-stand": { reps: 10 } }, { reviews: r({ easyTwice: true }) })).toBe("");
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
  it("放行：起始重量在第一次练的那天记（不一定是开始那天）", () => {
    expect(run(GYM, [1], [{ ...start, date: "2026-11-11" }], { "gym-smith-squat": { weight: 20 } })).toBe("");
  });
  it("拦下：第 1 周调重量；依据是第 1 周的记录", () => {
    expect(run(GYM, [1], [start, { date: "2026-11-11", move: "gym-smith-squat", field: "weight", to: 25, rule: "调重量", evidence: "打卡/2026-11-10.json" }],
      { "gym-smith-squat": { weight: 25 } }, { sessions: [spare("2026-11-10", 7)] })).toMatch(/不调重量/);
    expect(run(GYM, [1, 2], [start, { date: "2026-11-17", move: "gym-smith-squat", field: "weight", to: 25, rule: "调重量", evidence: "打卡/2026-11-10.json" }],
      { "gym-smith-squat": { weight: 25 } }, { sessions: [spare("2026-11-10", 7)] })).toMatch(/调重量的那几周/);
  });
  it("拦下：还能做的不到 6 下", () => {
    expect(run(GYM, [1, 2], [start, { date: "2026-11-18", move: "gym-smith-squat", field: "weight", to: 25, rule: "调重量", evidence: "打卡/2026-11-17.json" }],
      { "gym-smith-squat": { weight: 25 } }, { sessions: [spare("2026-11-17", 4)] })).toMatch(/6 下以上/);
  });
  it("放行：第 3 周加重一次；拦下：第 4 周加重、同一段加两次、一档加太多", () => {
    const w3 = { date: "2026-11-23", move: "gym-smith-squat", field: "weight", to: 25, rule: "加重" };
    expect(run(GYM, [1, 2, 3], [start, w3], { "gym-smith-squat": { weight: 25 } })).toBe("");
    expect(run(GYM, [1, 2, 3, 4], [start, { ...w3, date: "2026-11-30" }], { "gym-smith-squat": { weight: 25 } })).toMatch(/不加重/);
    expect(run(GYM, [1, 2, 3], [start, w3, { ...w3, date: "2026-11-25", to: 30 }], { "gym-smith-squat": { weight: 30 } })).toMatch(/已经往上改过|已经加过重/);
    expect(run(GYM, [1, 2, 3], [start, { ...w3, to: 200 }], { "gym-smith-squat": { weight: 200 } })).toMatch(/最多加 25%/);
  });
  it("拦下：还没记过起始重量就加重", () => {
    expect(run(GYM, [1, 2, 3], [{ date: "2026-11-23", move: "gym-smith-squat", field: "weight", to: 25, rule: "加重" }], { "gym-smith-squat": { weight: 25 } })).toMatch(/还没记过起始重量/);
  });
});

describe("复核后补的拦截：轮次、条件变体的级、换成品", () => {
  const lv = (date: string, to: number, file: string) => ({ date, move: "sl-rdl", field: "level", to, rule: "找级", evidence: file });
  const ses = (date: string) => session(date, [{ exercise: "sl-rdl", feel: up }]);
  it("拦下：第 2 段骨质疏松没确认，单腿硬拉仍然只到扶墙那一级", () => {
    const p = profile(BW40, [1, 2, 3, 4, 1], [1, 1, 1, 1, 2]);
    p.conditions = {};
    p.progressLog = [lv("2026-12-08", 2, "打卡/2026-12-07.json"), lv("2026-12-10", 3, "打卡/2026-12-09.json")];
    p.progress = { "sl-rdl": { level: 3 } };
    expect(msgs(checkProgressLog(p, plans, rules, [ses("2026-12-07"), ses("2026-12-09")], reviewsFor(p), NOW))).toMatch(/第 3 级这一周不能用/);
  });
  it("拦下：练 1 周就换成品，不算第 2 轮；建档不能直接用以后几轮才放开的级", () => {
    const p = profile(BW, [1, 1], [1, 2]);
    p.segments[1].product = p.product = HOME;
    p.progressLog = [{ date: "2026-11-16", move: "split-squat", field: "level", to: 3, rule: "建档" }];
    p.progress = { "split-squat": { level: 3 } };
    expect(msgs(checkProgressLog(p, plans, rules, [], reviewsFor(p), NOW))).toMatch(/起步能用的级/);
  });
});

describe("个人进度：重来（65 岁以上生病住院回来）、半量", () => {
  const b = { date: DATES[0], move: "a65-01-sit-to-stand", field: "reps", to: 8, rule: "建档" };
  const a = { date: DATES[1], move: "a65-01-sit-to-stand", field: "reps", to: 10, rule: "加次数", evidence: ev(1) };
  const fine = rv(1, [{ move: "a65-01-sit-to-stand", allAtTop: false, allDone: true, spare: 4, easyTwice: true }]);
  const build = (log: Record<string, any>[], reps: number) => {
    const p = profile(OLD, [1, 2, 1], [1, 1, 2]);
    p.segments[2].restart = "评估/x-触发.json";
    p.progressLog = log;
    p.progress = { "a65-01-sit-to-stand": { reps } };
    return msgs(checkProgressLog(p, plans, rules, [], { ...reviewsFor(p), ...fine }, NOW));
  };
  it("拦下：重来那天没把加过的次数改回区间下限", () => expect(build([b, a], 10)).toMatch(/要写一条"重来"/));
  it("放行：重来那天改回区间下限，依据那份触发评估", () =>
    expect(build([b, a, { date: DATES[2], move: "a65-01-sit-to-stand", field: "reps", to: 8, rule: "重来", evidence: "评估/x-触发.json" }], 8)).toBe(""));
  it("拦下：重来不在重来那一段开始那天、往上改", () => {
    expect(build([b, a, { date: DATES[1], move: "a65-01-sit-to-stand", field: "reps", to: 8, rule: "重来", evidence: "评估/x-触发.json" }], 8)).toMatch(/重来只能写在/);
  });
  it("拦下：半量课那一周的复盘没写 half", () => {
    const p = profile(BW, [1, 2]);
    const s = session(DATES[0], [{ exercise: "pushup" }]).raw;
    s.course.source = { ...s.course.source, half: true };
    const out = checkProgress(p, [{ name: "打卡/a.json", raw: s }], [`${DATES[0]}-第1周.md`], NOW, reviewsFor(p));
    expect(out.map((i) => i.message).join()).toMatch(/half: true/);
  });
  it("拦下：复盘写了头晕却说没有不适", () => {
    expect(validateReview({ ...review(DATES[0], 1, []), dizzy: 1 }).map((i) => i.message).join()).toMatch(/头晕/);
  });
});
