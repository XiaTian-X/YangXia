// 段序列和个人进度：档案的 segments 记下每一段（起始期 4 周一段）每一周从哪天开始；progressLog 记下每个动作的
// 难度级、次数、重量每一次是怎么改的、依据哪份练习记录或复盘。按代码核对 AGENTS.md 和成品的规矩：
// - 每一周结束都有周复盘（复盘/<开始日期>-第N周.md 和同名 .json），不复盘不能进下一周；
// - 一周里有疼痛、头晕、胸闷，下一周不能往上走，这一周之后的进度也不能往上加；
// - 进度只能照成品的规则改（找级、升级、加次数、加重各有允许的周和依据），一次只改一样，重放日志要等于档案的 progress。
import { addOnsFromLog, allowedLevels, currentSegment, planType, type PlansData, progressRow, ROUND_WEEKS, roundOf, roundWeek, ruleValue, type RulesData, stableParam, startLevel } from "./plan.ts";
import { validateGoalReview } from "./goals.ts";
import type { Issue } from "./types.ts";

export interface SegmentEntry {
  /** 第几段（换段、换成品时加 1）。 */
  n: number;
  /** 段型：标准 / 减量。 */
  type: string;
  /** 这一段的第几周（起始期 1–4，稳定期 1–12）。 */
  week: number;
  /** 这一周从哪天开始。 */
  start: string;
  /** 这一段用的成品。 */
  product: string;
  /** 阶段：起始（默认）/ 稳定。同一段里不变，要和成品的阶段一致。 */
  phase?: string;
  /** 这一周的目标（阶段 4，稳定期才有）：保持（默认）/ 减脂 / 增肌。一段里只能往保持退。 */
  goal?: string;
}

type Obj = Record<string, any>;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TYPES = ["标准", "减量"];

/** 复盘文件名：复盘/<这一周的开始日期>-第N周.md（和同名 .json）。 */
export const reviewName = (e: { start: string; week: number }) => `${e.start}-第${e.week}周.md`;
export const reviewDataName = (e: { start: string; week: number }) => `${e.start}-第${e.week}周.json`;

const DAY = 86_400_000;
/** 本地时区的这一天 0 点。 */
const dayStart = (d: string) => new Date(`${d}T00:00:00`).getTime();
const localDate = (t: Date) => `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`;
const localToday = (now: Date) => dayStart(localDate(now));

/**
 * segments 的结构：至少一段；第一段是第 1 段第 1 周、从 startDate 开始；每一周至少 7 天、开始日期最晚是明天；
 * 同一段里每次最多推进一周、成品和段型不变；新开一段（n 加 1）从第 1 周开始，只能在上一段第 4 周之后或者换成品时；
 * 最后一段的成品就是档案的 product。旧的 week、round、weeks 不再用。
 */
export function validateSegments(p: Obj, now = new Date()): Issue[] {
  const out: Issue[] = [];
  const err = (path: string, message: string) => out.push({ level: "error", path, message });
  for (const k of ["week", "round", "weeks"]) {
    if (p[k] !== undefined) err(k, `${k} 是旧字段，换成 segments（每一段的成品、段型、第几段、第几周、开始日期）`);
  }
  const ss = p.segments;
  if (!Array.isArray(ss) || ss.length === 0) {
    err("segments", '缺少 segments：建档时写 [{ "n": 1, "type": "标准", "week": 1, "start": 开始日期, "product": 成品名 }]');
    return out;
  }
  let bad = false;
  ss.forEach((e: unknown, i: number) => {
    const s = e as Obj;
    const stable = s?.phase === "稳定";
    if (typeof e !== "object" || e === null || !Number.isInteger(s.n) || s.n < 1 || !TYPES.includes(s.type)
      || !Number.isInteger(s.week) || s.week < 1 || s.week > (stable ? 12 : 4) || typeof s.start !== "string" || !DATE.test(s.start)
      || typeof s.product !== "string" || !s.product) {
      err(`segments[${i}]`, "每一项要有 n（第几段）、type（标准 / 减量）、week（起始期 1–4，稳定期 1–12）、start（YYYY-MM-DD）、product（成品名）");
      bad = true;
    }
    if (s?.phase !== undefined && s.phase !== "起始" && s.phase !== "稳定") { err(`segments[${i}].phase`, "phase 只能是 起始 / 稳定"); bad = true; }
    if (stable && s.type !== "标准") err(`segments[${i}].type`, "稳定期没有减量段：type 写 标准");
  });
  if (bad) return out;
  const first = ss[0] as SegmentEntry;
  if (first.n !== 1 || first.week !== 1) err("segments[0]", "第一项要是第 1 段第 1 周");
  if (typeof p.startDate === "string" && first.start !== p.startDate) err("segments[0].start", `第一项的开始日期要和 startDate（${p.startDate}）一致`);
  for (let i = 1; i < ss.length; i++) {
    const s = ss[i] as SegmentEntry;
    const prev = ss[i - 1] as SegmentEntry;
    if (dayStart(s.start) - dayStart(prev.start) < 7 * DAY) err(`segments[${i}].start`, `每一周至少练 7 天：上一周 ${prev.start} 开始，这一周最早 7 天后开始`);
    if (dayStart(s.start) > localToday(now) + DAY) err(`segments[${i}].start`, `开始日期 ${s.start} 还没到：周复盘做完才追加下一周，最早从明天开始`);
    if (s.n === prev.n) {
      if (s.product !== prev.product || s.type !== prev.type || (s.phase ?? "起始") !== (prev.phase ?? "起始")) err(`segments[${i}]`, "同一段里成品、段型、阶段不变；换成品、换段型要新开一段（n 加 1）");
      if (s.week > prev.week + 1) err(`segments[${i}].week`, `从第 ${prev.week} 周不能直接跳到第 ${s.week} 周：每次最多推进一周`);
      if (s.week < prev.week) err(`segments[${i}].week`, `同一段里周次不能往回走（第 ${prev.week} 周 → 第 ${s.week} 周）；要从头来就新开一段`);
    } else if (s.n === prev.n + 1) {
      if (s.week !== 1) err(`segments[${i}].week`, "新的一段从第 1 周开始");
      // 同一成品中途重来（65 岁以上生病住院回来、6–12 岁生病超过 7 天）要写 restart：依据的触发评估，由评估核对
      const prevMax = prev.phase === "稳定" ? 12 : 4;
      if (prev.week !== prevMax && s.product === prev.product && typeof (s as Obj).restart !== "string") err(`segments[${i}].n`, `上一段才到第 ${prev.week} 周：练完第 ${prevMax} 周（${prev.phase === "稳定" ? "周期末" : "段末"}）或者换成品，才能新开一段（生病住院回来从第 1 周重来的，写 restart）`);
    } else err(`segments[${i}].n`, `段号要连续：上一项是第 ${prev.n} 段，这一项是第 ${s.n} 段`);
  }
  const last = ss[ss.length - 1] as SegmentEntry;
  if (typeof p.product === "string" && last.product !== p.product) err("product", `档案的 product 是「${p.product}」，segments 最后一项是「${last.product}」：两处要一致`);
  return out;
}

export interface SessionFile {
  name: string;
  raw: Obj;
  archived?: boolean;
}

const symptomatic = (raw: Obj) => {
  const s = raw?.symptoms;
  return !!s && !!(s.pain || s.dizzy || s.chest);
};

/** 某个时间落在 segments 的哪一项（周）；早于第一项返回 -1。 */
function periodIndex(ss: SegmentEntry[], t: number): number {
  for (let i = ss.length - 1; i >= 0; i--) if (t >= dayStart(ss[i].start)) return i;
  return -1;
}

/**
 * 训练过的日期（中断按它算）：练习记录的日期；某一周没有练习记录、复盘数据写了练过的，按这一周开始后的第 7 天算，不晚于 today。
 * 对拖长的周是往早里算（宁可多报一次中断）；对正常 7 天的周是这一周最晚的一天（往晚里算：实际可能早几天就练完了，
 * 这样算出的中断会少几天——找级、"不算长时间中断"这类往上的放得更紧，"超过 28 天先做触发评估"会晚几天报；没有练习记录就只能这样）。
 * 升序、不重复。
 */
export function trainingDates(ss: SegmentEntry[], sessions: SessionFile[], reviewData: Record<string, Obj>, today: string): string[] {
  const dates = new Set<string>();
  const sessionDates: string[] = [];
  for (const s of sessions) {
    const t = Date.parse(s.raw?.startedAt);
    if (!Number.isNaN(t)) sessionDates.push(localDate(new Date(t)));
  }
  for (const d of sessionDates) dates.add(d);
  ss.forEach((s, i) => {
    const rv = reviewData[reviewDataName(s)];
    if (!(rv && rv.trainings > 0)) return;
    const next = i + 1 < ss.length ? ss[i + 1].start : "9999-12-31";
    if (sessionDates.some((d) => d >= s.start && d < next)) return;
    const end = localDate(new Date(dayStart(s.start) + 6 * DAY + DAY / 2));
    dates.add(end < today ? end : today);
  });
  return [...dates].sort();
}

/**
 * 按 segments 核对练习记录和周复盘：
 * - 除了正在进行的最后一周，每一周都要有复盘（.md 和 .json）；复盘数据的训练次数不能少于这一周的练习记录数，
 *   练习记录里有不适，复盘就不能写没有；
 * - 某一周有不适，同一段的下一周不能比它高；
 * - 练习记录练的周次比当时高：提醒。
 */
export function checkProgress(profile: Obj, sessions: SessionFile[], reviews: string[], now = new Date(), reviewData: Record<string, Obj> = {}): Issue[] {
  const out: Issue[] = [];
  const ss = profile.segments as SegmentEntry[];
  if (!Array.isArray(ss) || validateSegments(profile, now).some((i) => i.level === "error")) return out;
  const sick = new Set<number>();
  const halfWeeks = new Set<number>();
  const count = new Map<number, number>();
  for (const s of sessions) {
    const t = Date.parse(s.raw?.startedAt);
    if (Number.isNaN(t)) continue;
    const i = periodIndex(ss, t);
    if (i < 0) {
      if (!s.archived) out.push({ level: "warning", path: s.name, message: `练习记录早于开始日期 ${ss[0].start}，不算进任何一周` });
      continue;
    }
    // 历史/ 里的记录，日期落在这些周里的照样算数（不能靠挪进 历史/ 躲开不适记录）
    if (symptomatic(s.raw)) sick.add(i);
    if (s.raw?.course?.source?.half === true) halfWeeks.add(i);
    count.set(i, (count.get(i) ?? 0) + 1);
    const cw = s.raw?.course?.source?.week;
    if (Number.isInteger(cw) && cw > ss[i].week) {
      out.push({ level: "warning", path: s.name, message: `这天练的是第 ${cw} 周的课程，当时还在第 ${ss[i].week} 周` });
    }
  }
  ss.forEach((e, i) => {
    if (i === ss.length - 1) return;
    const md = reviewName(e);
    const js = reviewDataName(e);
    if (!reviews.includes(md)) {
      out.push({ level: "error", path: `复盘/${md}`, message: `第 ${e.n} 段第 ${e.week} 周（${e.start} 起）没有周复盘：先复盘，再按成品规则决定下一周` });
    }
    const data = reviewData[js];
    if (!data) {
      out.push({ level: "error", path: `复盘/${js}`, message: `第 ${e.n} 段第 ${e.week} 周没有复盘数据（和 ${md} 成对的 .json）：训练次数、不适、逐个动作的表现要写进去` });
    } else {
      if (data.start !== e.start || data.week !== e.week) out.push({ level: "error", path: `复盘/${js}`, message: `复盘数据写的是 ${data.start} 第 ${data.week} 周，文件名是 ${e.start} 第 ${e.week} 周` });
      const n = count.get(i) ?? 0;
      if (Number.isInteger(data.trainings) && data.trainings < n) {
        out.push({ level: "error", path: `复盘/${js}`, message: `复盘写练了 ${data.trainings} 次，这一周的练习记录就有 ${n} 份：训练次数不能少于练习记录数` });
      }
      if (sick.has(i) && data.symptoms === false) {
        out.push({ level: "error", path: `复盘/${js}`, message: "这一周的练习记录里有疼痛、头晕或胸闷，复盘数据不能写没有不适" });
      }
      if (halfWeeks.has(i) && data.half !== true) {
        out.push({ level: "error", path: `复盘/${js}`, message: "这一周练过半量课（练习记录的课程是 half），复盘数据要写 half: true：这一周不当加量依据" });
      }
      if (data.symptoms === true) sick.add(i);
    }
    const next = ss[i + 1];
    if (sick.has(i) && next.n === e.n && next.week > e.week) {
      out.push({ level: "error", path: `segments[${i + 1}]`, message: `第 ${e.week} 周（${e.start} 起）有疼痛、头晕或胸闷的记录，下一周不能加到第 ${next.week} 周：按成品"疼了怎么办"处理，这一周重来或者先就医` });
    }
  });
  return out;
}

// ---------- 个人进度 ----------

export const FEELS = ["做不到下限或后面几下变形", "能做到下限，最后两下有点难", "做到上限还很轻松"] as const;
const RULES = ["建档", "找级", "退回", "减量", "升级", "加次数", "调重量", "加重", "重来", "加一档"] as const;
const FIELDS = ["level", "reps", "weight"] as const;
type Field = (typeof FIELDS)[number];
const UP = new Set(["找级", "升级", "加次数", "调重量", "加重", "加一档"]);

/** progress 的结构：{动作或阶梯 ID: {level?, reps?, weight?}}。 */
export function validateProgressShape(p: Obj): Issue[] {
  const out: Issue[] = [];
  const err = (path: string, message: string) => out.push({ level: "error", path, message });
  if (p.progress !== undefined) {
    if (typeof p.progress !== "object" || p.progress === null || Array.isArray(p.progress)) err("progress", "progress 是 {动作 ID: {level, reps, weight}}");
    else for (const [k, v] of Object.entries(p.progress as Obj)) {
      if (typeof v !== "object" || v === null) { err(`progress.${k}`, "要是 {level, reps, weight}"); continue; }
      for (const f of Object.keys(v)) if (!(FIELDS as readonly string[]).includes(f)) err(`progress.${k}.${f}`, "只能有 level、reps、weight");
      for (const f of FIELDS) if (v[f] !== undefined && !(typeof v[f] === "number" && v[f] > 0)) err(`progress.${k}.${f}`, `${f} 要是正数`);
    }
  }
  if (p.progressLog !== undefined && !Array.isArray(p.progressLog)) err("progressLog", "progressLog 是数组");
  else (p.progressLog ?? []).forEach((e: Obj, i: number) => {
    if (typeof e !== "object" || e === null || typeof e.date !== "string" || !DATE.test(e.date) || typeof e.move !== "string"
      || !(FIELDS as readonly string[]).includes(e.field) || !(typeof e.to === "number" && e.to > 0) || !(RULES as readonly string[]).includes(e.rule)) {
      err(`progressLog[${i}]`, `每一项要有 date、move、field（level / reps / weight）、to（正数）、rule（${RULES.join(" / ")}），依据写 evidence`);
    }
  });
  if (p.conditions !== undefined && !(typeof p.conditions === "object" && p.conditions !== null && Object.values(p.conditions).every((v) => typeof v === "boolean"))) {
    err("conditions", "conditions 是 {条件名: true / false}，只记是否，不记诊断细节和用药");
  }
  if (p.choices !== undefined && !(Array.isArray(p.choices) && p.choices.every((c: unknown) => typeof c === "string"))) {
    err("choices", "choices 是能用的器材对应的动作 ID 列表，按优先顺序");
  }
  return out;
}

/** 健身房稳定期双进阶的余力门槛（设计值 GYM_DOUBLE_RULES；模板规则层登记了"双进阶加次数余力""双进阶加一档余力"就用登记的）。 */
const GYM_REPS_SPARE = 3;
const GYM_STEP_SPARE = 2;

/** 长时间中断的天数（模板评估参数"长时间中断天数"，没有按 28）。 */
export function longGapDays(rules: RulesData, code: string): number {
  const ps = ((rules as Obj).assess?.params ?? []) as { name: string; products: string[]; number?: number }[];
  return ps.find((x) => x.name === "长时间中断天数" && x.products.includes(code))?.number ?? 28;
}

/** date 那天之前最后一次训练（没有就按开始日期）到 date 隔了几天。 */
export function gapBefore(trained: string[], start: string, date: string): number {
  const before = trained.filter((d) => d < date);
  const last = before.length ? before[before.length - 1] : start;
  return Math.round((dayStart(date) - dayStart(last)) / DAY);
}

type State = Record<string, Partial<Record<Field, number>> & { product?: Partial<Record<Field, string>> }>;

/**
 * 重放 progressLog，逐条按规则核对，最后要等于档案的 progress。
 * sessions：档案目录里的练习记录（name 是相对档案目录的路径）；reviewData：复盘数据（键是文件名）。
 * 规则（成品原文 + content/rules/进度.md 的参数）：
 * - 往上调（找级升、升级、加次数、调重量、加重）：这一段里出现过疼痛、头晕、胸闷，或者上一周有，就不行；同一个动作同一天只往上改一样；
 *   升级、加次数、调重量、加重每个动作每周最多一次；每份依据（练习记录、复盘数据）对每个动作只能用一次；
 * - 练习记录当依据：日期不晚于这条改动，在规定的周里，不是手改过的课程（edited），这个动作练过（setsDone > 0）；
 * - 复盘数据当依据：必须是紧挨着的上一周的复盘，那一周不能有不适。
 */
export function checkProgressLog(profile: Obj, plans: PlansData, rules: RulesData, sessions: SessionFile[], reviewData: Record<string, Obj>, now = new Date(), assessments: { raw: Obj }[] = []): Issue[] {
  return replayProgress(profile, plans, rules, sessions, reviewData, now, false, assessments).issues;
}

/** 重放到某一天为止的进度（不核对规则），给"档案进度变了，旧课程是按哪一天的进度导出的"用。 */
export function progressOn(profile: Obj, plans: PlansData, rules: RulesData, date: string, now = new Date()): Obj {
  const p = { ...profile, progressLog: (profile.progressLog ?? []).filter((e: Obj) => typeof e?.date === "string" && e.date <= date) };
  return replayProgress(p, plans, rules, [], {}, now, true).state;
}

function replayProgress(profile: Obj, plans: PlansData, rules: RulesData, sessions: SessionFile[], reviewData: Record<string, Obj>, now: Date, quiet = false, assessments: { raw: Obj }[] = []): { issues: Issue[]; state: Obj } {
  const out: Issue[] = [];
  const err = (i: number, message: string) => out.push({ level: "error", path: `progressLog[${i}]`, message });
  const ss = profile.segments as SegmentEntry[];
  const state: State = {};
  const plainState = () => Object.fromEntries(Object.entries(state).map(([k, v]) => [k, Object.fromEntries(FIELDS.filter((f) => v[f] !== undefined).map((f) => [f, v[f]]))]));
  if (!Array.isArray(ss) || validateSegments(profile, now).some((x) => x.level === "error") || validateProgressShape(profile).length) return { issues: out, state: plainState() };
  if (!quiet) {
    for (const name of Object.keys(profile.conditions ?? {})) {
      if (!rules.conditions[name]) out.push({ level: "error", path: `conditions.${name}`, message: `模板的规则层没有条件「${name}」（有：${Object.keys(rules.conditions).join("、")}）` });
    }
  }
  const log: Obj[] = [...(profile.progressLog ?? [])].map((e, i) => ({ ...e, _i: i }));
  log.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a._i - b._i));
  const upOnDate = new Map<string, number>();
  const oncePerWeek = new Set<string>();
  const usedEvidence = new Set<string>();
  const lastChange = new Map<string, string>();   // 动作 → 上一次改动的日期（找级的依据要晚于它）
  const lastTouch = new Map<string, string>();    // 动作 → 上一次改次数或重量的日期（健身房双进阶的依据要晚于它）
  const upgradeWeeks = new Map<number, string>(); // 40–64 岁"一次只升一样"：这一周已经升过的动作
  // 成品家族：稳定期成品和同一年龄段、场地的起始期成品，进度接着用
  const fam = (name: string) => plans.products[name]?.base ?? name;
  const stableOf = (x: SegmentEntry) => x.phase === "稳定";
  const wk = (x: SegmentEntry) => (stableOf(x) ? roundWeek(x.week) : x.week);
  /** 这一项所在的"轮"从哪一项开始：起始期是这一段的第一项，稳定期是这一段里这 4 周的第一项。 */
  const blockStart = (k: number) => {
    const x = ss[k];
    const idx = (y: SegmentEntry) => (stableOf(y) ? Math.floor((y.week - 1) / ROUND_WEEKS) : 0);
    return ss.findIndex((y) => y.n === x.n && idx(y) === idx(x));
  };
  const trained = trainingDates(ss, sessions, reviewData, localDate(now));
  const lateUp = new Set<string>();               // 40–64 岁"下一轮升级"：这一轮已经按上一轮的复盘升过的动作
  const sessionAt = (name: string) => sessions.find((s) => s.name === name || s.name.endsWith(`/${name}`));
  const sessionPeriod = (s: SessionFile) => periodIndex(ss, Date.parse(s.raw?.startedAt));
  const sickPeriods = new Set<number>();
  for (const s of sessions) {
    const i = sessionPeriod(s);
    if (i >= 0 && symptomatic(s.raw)) sickPeriods.add(i);
  }
  ss.forEach((e, i) => {
    if (reviewData[reviewDataName(e)]?.symptoms === true) sickPeriods.add(i);
  });
  for (const e of log) {
    const i = e._i as number;
    const t = dayStart(e.date);
    if (t < dayStart(ss[0].start) || t > localToday(now) + DAY) {
      err(i, `日期 ${e.date} 不在档案的时间范围里（${ss[0].start} 到明天）`);
      continue;
    }
    const pi = periodIndex(ss, t);
    const period = ss[pi];
    const p = plans.products[period.product];
    if (!p) {
      err(i, `「${period.product}」没有训练单`);
      continue;
    }
    if (!p.rows.some((r) => r.moves.includes(e.move))) {
      err(i, `「${e.move}」不在${period.product}的训练单里`);
      continue;
    }
    // 加项（65 岁以上稳定期）：这一条记的那天哪几项有效
    const row = progressRow(p, rules, profile, planType(period), period.week, e.move, addOnsFromLog(profile, e.date));
    const ladder = p.ladders[e.move];
    const stable = stableOf(period);
    const kWeek = wk(period);
    // 健身房稳定期双进阶只给训练单标了 double 的行（周表定次数的主项）；提踵、平板支撑、死虫式、面拉、农夫行走照起始期的规则
    const gymDouble = stable && p.venue === "gym" && row?.double === true;
    const cur = (state[e.move] ??= {});
    cur.product ??= {};
    const field = e.field as Field;
    const to = e.to as number;
    const from = cur[field] !== undefined && cur.product[field] === fam(period.product) ? cur[field] : undefined;
    const round = roundOf(profile, plans, pi);
    const allowed = allowedLevels(p, row, round, rules);
    // 建档只能用第 1 轮这一周允许的级（换成品重新建档也一样）；以后几轮才放开的级要一级一级"升"上去
    const startAllowed = allowedLevels(p, row, 1, rules);
    const productStart = ss.findIndex((x, k) => fam(x.product) === fam(period.product) && (k === 0 || fam(ss[k - 1].product) !== fam(period.product)));
    if (field === "level" && !ladder) { err(i, `「${e.move}」没有难度阶梯，不记 level`); continue; }
    if (field === "reps" && row && row.reps_from !== "progress") { err(i, `「${e.move}」的次数由当周的表定（周表），不记进度`); continue; }
    if (field === "weight" && p.venue !== "gym") { err(i, "只有健身房版记重量"); continue; }
    // 依据
    const ev = typeof e.evidence === "string" ? e.evidence : "";
    const sess = ev ? sessionAt(ev) : undefined;
    const itemOf = (raw: Obj) => (raw?.items ?? []).find((it: Obj) => it.exercise === e.move || (ladder ?? []).some((l) => l.exercise === it.exercise));
    const sessOk = (weeksRule?: string): string | null => {
      if (!sess) return `依据要写这个动作的练习记录（evidence 写 打卡/… 的文件名）`;
      const st = Date.parse(sess.raw?.startedAt);
      if (Number.isNaN(st) || dayStart(localDate(new Date(st))) > t) return "依据的练习记录要早于这条改动";
      const si = sessionPeriod(sess);
      if (si < 0 || ss[si].n !== period.n || si < pi - 1) return "依据的练习记录要是这一周或上一周的";
      if (weeksRule) {
        const v = ruleValue(rules, p.code, weeksRule);
        if (!v || wk(ss[si]) < v.min || wk(ss[si]) > v.max) return `依据的练习记录要在${weeksRule === "找级周" ? "找级" : "调重量"}的那几周里`;
      }
      if (sess.raw?.edited) return "依据的练习记录练的是手改过的课程（edited），不按它调";
      if (sess.raw?.course?.source?.half === true) return "依据的练习记录练的是半量课（中断、生病回来的第一次），不当加量依据";
      const it = itemOf(sess.raw);
      if (!it || !(it.setsDone > 0)) return "依据的练习记录里这个动作没练（完成 0 组）";
      return null;
    };
    const prevReview = () => {
      if (pi < 1) return { error: "依据要写上一周的复盘数据（evidence 写 复盘/….json），第一周之前没有复盘" };
      const want = reviewDataName(ss[pi - 1]);
      const key = ev.replace(/^.*[\\/]/, "");
      if (key !== want) return { error: `依据要写紧挨着的上一周的复盘数据：复盘/${want}` };
      const rv = reviewData[want];
      if (!rv) return { error: `依据的复盘数据 复盘/${want} 不存在` };
      if (rv.symptoms === true) return { error: "依据的那一周有疼痛、头晕或胸闷：不加、不升（可以降）" };
      if (rv.half === true) return { error: "依据的那一周练过半量课（中断、生病回来），这一周的复盘不当加量依据" };
      return { rv, start: ss[pi - 1].start, m: (rv.moves ?? []).find((x: Obj) => x.move === e.move) };
    };
    const weeksOf = (rule: string) => ruleValue(rules, p.code, rule);
    // 双进阶：依据要是"上一次练这个动作"的记录——它和这条改动之间不能还有一次练这个动作的记录（改动当天的不算，分不清先后）
    const notLatest = (): boolean => {
      if (!sess) return false;
      const at = Date.parse(sess.raw?.startedAt);
      // 中间那次这个动作没练（0 组，比如被砍掉了）不算"又练过"
      return sessions.some((x) => { const xt = Date.parse(x.raw?.startedAt); return x !== sess && !Number.isNaN(xt) && xt > at && xt < t && itemOf(x.raw)?.setsDone > 0; });
    };
    const spareNeed = (rule: string, fallback: number) => weeksOf(rule)?.min ?? fallback;
    const inWeeks = (rule: string) => {
      const v = weeksOf(rule);
      return !!v && kWeek >= v.min && kWeek <= v.max;
    };
    // 上一轮（起始期是上一段，稳定期是上一个 4 周）有过不适：这一轮要先有一周没有不适的复盘，才往上走
    const carryBlocked = (k: number) => {
      const start = blockStart(k);
      if (start < 1) return false;
      const prevStart = blockStart(start - 1);
      let prevSick = false;
      for (let j = prevStart; j < start; j++) if (sickPeriods.has(j)) prevSick = true;
      if (!prevSick) return false;
      return !ss.some((x, j) => j >= start && j < k && reviewData[reviewDataName(x)]?.symptoms === false);
    };
    // 上一轮第 3、4 周的复盘（3 组的周）：40–64 岁第 2 轮起每轮第 1–2 周升级的依据
    const prevRoundReview = () => {
      const start = blockStart(pi);
      if (start < 1) return { error: "依据要写上一轮第 3 或第 4 周的复盘数据，这是第一轮" };
      const prevStart = blockStart(start - 1);
      const names: string[] = [];
      for (let j = prevStart; j < start; j++) if (wk(ss[j]) >= 3) names.push(reviewDataName(ss[j]));
      const key = ev.replace(/^.*[\\/]/, "");
      if (!names.includes(key)) return { error: `依据要写上一轮第 3 或第 4 周的复盘数据（${names.map((x) => `复盘/${x}`).join("、") || "还没有"}）` };
      const rv = reviewData[key];
      if (!rv) return { error: `依据的复盘数据 复盘/${key} 不存在` };
      if (rv.symptoms === true) return { error: "依据的那一周有疼痛、头晕或胸闷：不加、不升（可以降）" };
      if (rv.half === true) return { error: "依据的那一周练过半量课（中断、生病回来），这一周的复盘不当加量依据" };
      return { rv, start: ss.find((x) => reviewDataName(x) === key)?.start ?? "", m: (rv.moves ?? []).find((x: Obj) => x.move === e.move) };
    };
    // 周期末"习惯没达标"：下一周期的第一轮不升级（健身房：头 4 周不加次数、不加一档）
    const holdRound = () => {
      if (!stable || period.week > ROUND_WEEKS) return false;
      const start = ss.findIndex((x) => x.n === period.n);
      if (start < 1) return false;
      const prevN = ss[start - 1].n;
      return assessments.some((a) => a.raw?.kind === "周期末" && a.raw?.segment === prevN && a.raw?.conclusion?.next?.hold === true);
    };
    // 长时间中断回来的头 N 天可以找级（不论周次）：那份"中断"触发评估之前真的断了超过"长时间中断天数"，返回评估的日期
    const gapReturn = (): string | null => {
      const days = stableParam(rules, p.code, "找级窗口天数")?.number ?? 14;
      const longDays = longGapDays(rules, p.code);
      const hit = assessments.filter((a) => a.raw?.kind === "触发" && Array.isArray(a.raw?.reasons) && a.raw.reasons.includes("中断")
        && typeof a.raw.date === "string" && DATE.test(a.raw.date) && dayStart(a.raw.date) <= t && t < dayStart(a.raw.date) + days * DAY
        && gapBefore(trained, ss.find((s) => plans.products[s.product])?.start ?? ss[0].start, a.raw.date) > longDays).map((a) => a.raw.date as string).sort();
      return hit.length ? hit[hit.length - 1] : null;
    };
    const before = from ?? (field === "level" && ladder ? startLevel(ladder) : field === "reps" && row?.reps ? row.reps.min : undefined);
    if (e.rule === "重来") {
      // 65 岁以上生病、住院回来从第 1 周重新开始（A65_RESTART）：只在重来那一段开始那天、依据那份触发评估，改回起始级、区间下限
      const entry = ss[pi] as Obj;
      const startTo = field === "level" && ladder ? startLevel(ladder) : field === "reps" && row?.reps ? row.reps.min : undefined;
      if (typeof entry.restart !== "string" || e.date !== entry.start || entry.week !== 1) err(i, "重来只能写在从第 1 周重来的那一段开始那天（segments 那一项写了 restart）");
      else if (ev.replace(/^.*?(评估\/)/, "评估/") !== entry.restart) err(i, `重来的依据要写那份触发评估：${entry.restart}`);
      else if (startTo === undefined || to !== startTo) err(i, `重来改回训练单的起始值：${field === "level" ? "起始级" : "区间下限"} ${startTo ?? "（这一项没有起始值）"}`);
      else if (before !== undefined && to > before) err(i, "重来只能往下改");
      cur[field] = to;
      cur.product[field] = fam(period.product);
      if (field === "level") lastChange.set(e.move, e.date);
      continue;
    }
    if (e.rule === "建档") {
      // 重量：这份成品开始的那一周记；起始期没记下来的，到了稳定期第一周还可以补记（重量是记录，不是处方）
      const okDay = field === "weight" ? pi === productStart || (stable && period.week === 1) : e.date === ss[productStart].start;
      if (from !== undefined) err(i, `「${e.move}」的 ${field} 在这份成品里已经有值，建档只能写一次（降、升按规则写）`);
      else if (!okDay) err(i, field === "weight" ? "起始重量在这份成品开始的那一周里记（起始期没记的，稳定期第 1 周可以补记）" : `建档只能在这份成品开始那天（${ss[productStart].start}）写`);
      else if (field === "level" && !startAllowed.has(to)) err(i, `建档只能用这一周起步能用的级（第 ${[...startAllowed].join("、")} 级），写的是第 ${to} 级`);
      else if (field === "reps" && row?.reps && to !== row.reps.min) err(i, `建档时次数取区间下限 ${row.reps.min}，写的是 ${to}`);
    } else if (before === undefined) {
      err(i, field === "weight" ? `「${e.move}」还没记过起始重量：先写一条"建档"` : `「${e.move}」没有起始值`);
      continue;
    } else if (UP.has(e.rule)) {
      // 不适：这一段里出现过（稳定期按轮：这 4 周里出现过），或者上一周有，都不往上加
      const segStart = blockStart(pi);
      const sickToday = sessions.some((s) => sessionPeriod(s) === pi && symptomatic(s.raw) && Date.parse(s.raw?.startedAt) < t + DAY);
      const sickBefore = sickToday || [...sickPeriods].some((k) => k === pi - 1 || (k >= segStart && k < pi));
      if (sickBefore) err(i, `${stable ? "这一轮（4 周）里" : "这一段里"}（或上一周）有疼痛、头晕或胸闷的记录：不加量、不升级（可以降）`);
      else if (stable && carryBlocked(pi)) err(i, "上一轮有过疼痛、头晕或胸闷：这一轮要先有一周没有不适的复盘，才接着往上走");
      if (holdRound() && (e.rule === "升级" || gymDouble)) err(i, "上一个周期习惯没达标：这个周期的第一轮（头 4 周）不升级、不加量");
      const k = `${e.move}|${e.date}`;
      upOnDate.set(k, (upOnDate.get(k) ?? 0) + 1);
      if ((upOnDate.get(k) ?? 0) > 1) err(i, `「${e.move}」${e.date} 已经往上改过一样了：一次只改一样（升级、加次数、加重不同时）`);
      // 健身房双进阶（稳定期）是例外：每练一次最多改一次，由"依据晚于上一次改动、每份记录只用一次"管
      if (e.rule !== "找级" && !(gymDouble && (e.rule === "加次数" || e.rule === "加一档"))) {
        const key = `${e.move}|${pi}`;
        if (oncePerWeek.has(key)) err(i, `「${e.move}」这一周已经往上改过了：每个动作每周最多往上改一次`);
        oncePerWeek.add(key);
      }
      if (ev) {
        const uk = `${ev.replace(/^.*[\\/]/, "")}|${e.move}`;
        if (usedEvidence.has(uk)) err(i, `依据 ${ev} 已经给「${e.move}」用过一次了：每份依据只能用一次`);
        usedEvidence.add(uk);
      }
    }
    switch (e.rule) {
      case "找级": {
        // 稳定期的找级只给三种人：直接进入的人的第 1 轮、家族外换了成品的人（走新成品的起始期）、长时间中断回来的头两周
        const direct = stable && round === 1 && inWeeks("找级周");
        const backDate = stable && !direct ? gapReturn() : null;
        const back = backDate !== null;
        const findOk = stable ? back || direct : inWeeks("找级周");
        const problem = sessOk(back ? undefined : "找级周")
          ?? (back && localDate(new Date(Date.parse(sess!.raw?.startedAt))) < backDate! ? `中断回来以后的找级，依据要是做完触发评估（${backDate}）以后练的那一次` : null);
        const it = sess ? itemOf(sess.raw) : null;
        const want = to > before! ? FEELS[2] : FEELS[0];
        if (field !== "level") err(i, "找级只改难度级");
        else if (!findOk) err(i, stable
          ? "稳定期的找级只给：直接进稳定期的人的第 1 轮第 1–2 周、真的断了四周以上而且做过\"中断\"触发评估回来的头两周；其他时候只能往下调（减量、退回）"
          : `第 ${period.week} 周不是找级的周（${fmtWeeks(weeksOf("找级周"))}）`);
        else if (Math.abs(to - before!) !== 1) err(i, `找级一次只能上下调一级（第 ${before} 级 → 第 ${to} 级）`);
        else if (!allowed.has(to)) err(i, `第 ${to} 级这一周不能用（可以用第 ${[...allowed].join("、")} 级）`);
        else if (problem) err(i, `找级：${problem}，记录里这个动作的感受要是"${want}"`);
        else if (lastChange.has(e.move) && localDate(new Date(Date.parse(sess!.raw?.startedAt))) <= lastChange.get(e.move)!) err(i, `找级的依据要是上一次改动（${lastChange.get(e.move)}）之后练的那一次`);
        else if (it.feel !== want) err(i, `依据的练习记录里这个动作的感受是"${it.feel ?? "（没填）"}"，${to > before! ? "升" : "降"}一级要"${want}"`);
        break;
      }
      case "退回": {
        const it = sess ? itemOf(sess.raw) : null;
        if (field !== "level" || to !== before! - 1) err(i, "退回是难度级降回上一级");
        else if (!it || it.reverted !== true || Date.parse(sess!.raw?.startedAt) >= t + DAY) err(i, "退回要写依据：这一天之前的练习记录里这个动作标了\"退回\"（reverted）");
        break;
      }
      case "减量":
        if (!(to < before!)) err(i, "减量只能往下调（降级、减次数、减重量随时可以）");
        break;
      case "升级": {
        // 18–39 岁：每一轮第 4 周（升级周）。40–64 岁：第 1 轮不升；第 2 轮起每一轮第 1–2 周，第 3–4 周不动，每周最多升一个动作，
        // 依据是上一轮第 3 或第 4 周的复盘（"下一轮从第 1 周起升级，一次只升一样"）
        const nextRound = weeksOf("下一轮升级");
        // 窗口：模板登记了"下一轮升级窗口"（设计值 A40_UPGRADE_WINDOW）就用它，没有就只有原文写的那一周
        const win = weeksOf("下一轮升级窗口") ?? nextRound;
        const late = !inWeeks("升级周") && !!nextRound && !!win && round >= 2 && kWeek >= win.min && kWeek <= win.max;
        const lateKey = `${blockStart(pi)}|${e.move}`;
        const okWeek = inWeeks("升级周") || late;
        const rv = late ? prevRoundReview() : prevReview();
        if (field !== "level" || to !== before! + 1) err(i, "升级是难度级加一级");
        else if (!okWeek) err(i, `第 ${round} 轮（第 ${period.n} 段）第 ${period.week} 周不能升级（${weeksOf("升级周") === null ? `这一版第 1 轮不升级；第 2 轮起每一轮${fmtWeeks(win)}可以升，别的周级别不动` : `升级周：每一轮${fmtWeeks(weeksOf("升级周"))}`}）`);
        else if (!allowed.has(to)) err(i, `第 ${to} 级这一周不能用（可以用第 ${[...allowed].join("、")} 级）`);
        else if ("error" in rv) err(i, `升级：${rv.error}`);
        else if (!rv.m || rv.m.allAtTop !== true || !(rv.m.spare >= 1)) err(i, "升级要达标：依据的复盘数据里这个动作每组都做到区间上限、最后一组还有余力（成品的\"达标\"）");
        else if (late && !stable && carryBlocked(pi)) err(i, "上一段有过疼痛、头晕或胸闷：这一段要先有一周没有不适的复盘，才能按\"下一轮升级\"往上升（SYMPTOM_CARRY）");
        else if (late && upgradeWeeks.has(pi) && upgradeWeeks.get(pi) !== e.move) err(i, `这一周已经升过「${upgradeWeeks.get(pi)}」：40–64 岁一次只升一样（每周最多升一个动作）`);
        else if (late && lateUp.has(lateKey)) err(i, `「${e.move}」这一轮已经按上一轮的复盘升过一级：上一轮是在原来那一级达标的，新的一级要先练到达标（下一轮再升）`);
        // 依据那一周要是在现在这一级练的：这个动作上一次改级之后才开始的那一周（比如重复第 4 周，不能拿改级之前那一周的复盘再升一次）
        else if (lastChange.has(e.move) && rv.start < lastChange.get(e.move)!) err(i, `升级的依据那一周（${rv.start} 起）开始时「${e.move}」还不是现在这一级（${lastChange.get(e.move)} 改过级）：要用在现在这一级练满一周的复盘`);
        if (late) { upgradeWeeks.set(pi, upgradeWeeks.get(pi) ?? e.move); lateUp.add(lateKey); }
        break;
      }
      case "加次数": {
        if (gymDouble) {
          // 健身房双进阶：上一次练这个动作的练习记录里 3 组都做完、还能做 3 下以上 → 下一次多做 1 下，不超过区间上限
          const problem = sessOk();
          const it = sess ? itemOf(sess.raw) : null;
          if (field !== "reps" || to !== before! + 1) err(i, "双进阶每次只多做 1 下");
          else if (row?.reps && to > row.reps.max) err(i, `不能超过 ${row.reps.max} 次：3 组都做到 ${row.reps.max} 次就该加一档、回到 ${row.reps.min} 次`);
          else if (problem) err(i, `双进阶加次数：${problem}`);
          else if (lastTouch.has(e.move) && localDate(new Date(Date.parse(sess!.raw?.startedAt))) <= lastTouch.get(e.move)!) err(i, `依据要是上一次改动（${lastTouch.get(e.move)}）之后练的那一次`);
          else if (notLatest()) err(i, "双进阶的依据要是最近一次练这个动作的练习记录（它之后又练过这个动作，按后面那一次）");
          else if (it.setsDone !== it.setsPlanned || !(it.spare >= spareNeed("双进阶加次数余力", GYM_REPS_SPARE))) err(i, `双进阶加次数要依据的练习记录里这个动作每组都做完、"还能做几下"是 ${spareNeed("双进阶加次数余力", GYM_REPS_SPARE)} 下以上（加完仍留 2 下余力）`);
          break;
        }
        const step = weeksOf("加次数");
        const need = weeksOf("加次数余力")?.min ?? 4;
        const rv = prevReview();
        if (field !== "reps") err(i, "加次数只改次数");
        else if (!step) err(i, "这份成品没有加次数的规则");
        else if (to - before! < step.min || to - before! > step.max) err(i, `每次加 ${step.min}–${step.max} 次（${before} → ${to}）`);
        else if (row?.reps && to > row.reps.max) err(i, `不能超过区间上限 ${row.reps.max}`);
        else if ("error" in rv) err(i, `加次数：${rv.error}`);
        else if (!rv.m || rv.m.allDone !== true || !(rv.m.spare >= need)) err(i, `加次数要上一周的复盘数据里这个动作每组都做满（allDone）、最后一组还剩 ${need} 次以上余力`);
        else if (p.age === "a65" && rv.m.easyTwice !== true) err(i, "65 岁以上加次数要连着两次训练都轻松（复盘数据里 easyTwice）");
        break;
      }
      case "加一档": {
        // 健身房双进阶：3 组都做到区间上限（12 次）、还留 2 下以上余力、没当场退回 → 加一档，次数回到区间下限
        const problem = sessOk();
        const it = sess ? itemOf(sess.raw) : null;
        const cap = weeksOf("每档加重上限")?.min;
        const reps = state[e.move]?.reps;
        if (!gymDouble) err(i, stable && p.venue === "gym"
          ? `加一档只给健身房稳定期走双进阶的主项；「${e.move}」照旧按动作库的次数或秒数，不往上加重量`
          : "加一档是健身房稳定期双进阶的规则（起始期用 调重量、加重）");
        else if (field !== "weight" || !(to > before!)) err(i, "加一档是重量往上加一档");
        else if (!row?.reps || reps !== row.reps.max) err(i, `加一档要先把次数做到 ${row?.reps?.max ?? "区间上限"} 次（现在是 ${reps ?? row?.reps?.min ?? "下限"} 次）`);
        else if (problem) err(i, `加一档：${problem}`);
        else if (lastTouch.has(e.move) && localDate(new Date(Date.parse(sess!.raw?.startedAt))) <= lastTouch.get(e.move)!) err(i, `依据要是上一次改动（${lastTouch.get(e.move)}）之后练的那一次`);
        else if (notLatest()) err(i, "双进阶的依据要是最近一次练这个动作的练习记录（它之后又练过这个动作，按后面那一次）");
        else if (it.setsDone !== it.setsPlanned || !(it.spare >= spareNeed("双进阶加一档余力", GYM_STEP_SPARE)) || it.reverted === true) err(i, `加一档要依据的练习记录里这个动作每组都做完、"还能做几下"是 ${spareNeed("双进阶加一档余力", GYM_STEP_SPARE)} 下以上、没有当场退回`);
        else if (cap !== undefined && to > before! * (1 + cap / 100) + 1e-9) err(i, `加一档最多加 ${cap}%（${before} → 最多 ${Math.round(before! * (1 + cap / 100) * 100) / 100}）`);
        break;
      }
      case "调重量": {
        const problem = sessOk("调重量周");
        const it = sess ? itemOf(sess.raw) : null;
        const cap = weeksOf("每档加重上限")?.min;
        if (stable) err(i, "稳定期不用\"调重量\"：加重只走双进阶（加次数、加一档）");
        else if (field !== "weight" || !(to > before!)) err(i, "调重量是往上加一档");
        else if (!inWeeks("调重量周")) err(i, `第 ${period.week} 周不调重量（${fmtWeeks(weeksOf("调重量周"))}）`);
        else if (problem) err(i, `调重量：${problem}`);
        else if (!(it.spare >= 6)) err(i, "调重量要依据的练习记录里这个动作\"还能做几下\"是 6 下以上");
        else if (cap !== undefined && to > before! * (1 + cap / 100) + 1e-9) err(i, `加一档最多加 ${cap}%（${before} → 最多 ${Math.round(before! * (1 + cap / 100) * 100) / 100}）`);
        break;
      }
      case "加重": {
        const cap = weeksOf("每档加重上限")?.min;
        if (stable) err(i, "稳定期不用\"加重\"：加重只走双进阶（加次数、加一档）");
        else if (field !== "weight" || !(to > before!)) err(i, "加重是往上加一档");
        else if (!inWeeks("加重周")) err(i, `第 ${period.week} 周不加重（加重周：${fmtWeeks(weeksOf("加重周"))}）`);
        else if (cap !== undefined && to > before! * (1 + cap / 100) + 1e-9) err(i, `加一档最多加 ${cap}%（${before} → 最多 ${Math.round(before! * (1 + cap / 100) * 100) / 100}）`);
        break;
      }
    }
    cur[field] = to;
    cur.product[field] = fam(period.product);
    if (field === "level") lastChange.set(e.move, e.date);
    else lastTouch.set(e.move, e.date);
    if ((e.rule === "升级" || e.rule === "加一档") && row?.reps) {
      cur.reps = row.reps.min;   // 升级、加一档后次数回到区间下限
      cur.product.reps = fam(period.product);
    }
  }
  if (quiet) return { issues: out, state: plainState() };
  // 中途重来（A65_RESTART）：重来那一段开始那天，进度里高于起始值的每一项都要用"重来"改回去
  ss.forEach((entry, k) => {
    if (typeof (entry as Obj).restart !== "string") return;
    const p = plans.products[entry.product];
    if (!p) return;
    const st = progressOn(profile, plans, rules, entry.start, now);
    for (const [move, v] of Object.entries(st as Record<string, Obj>)) {
      const ladder = p.ladders[move];
      const row = progressRow(p, rules, profile, entry.type, 1, move);
      if (ladder && v.level !== undefined && v.level > startLevel(ladder)) out.push({ level: "error", path: `segments[${k}]`, message: `${entry.start} 从第 1 周重来：「${move}」还是第 ${v.level} 级，要写一条"重来"改回起始级 ${startLevel(ladder)}` });
      if (row?.reps && v.reps !== undefined && v.reps > row.reps.min) out.push({ level: "error", path: `segments[${k}]`, message: `${entry.start} 从第 1 周重来：「${move}」还是每组 ${v.reps} 次，要写一条"重来"改回区间下限 ${row.reps.min}` });
    }
  });
  // 重放结果要等于档案的 progress
  const prog: Obj = profile.progress ?? {};
  const keys = new Set([...Object.keys(prog), ...Object.keys(state)]);
  for (const k of keys) {
    for (const f of FIELDS) {
      const a = prog[k]?.[f];
      const b = state[k]?.[f];
      if (a !== b && !(a === undefined && b === undefined)) {
        out.push({ level: "error", path: `progress.${k}.${f}`, message: `档案写的是 ${a ?? "（没写）"}，按 progressLog 重放应该是 ${b ?? "（没写）"}：进度只能经 progressLog 改，每一条写明规则和依据` });
      }
    }
  }
  // 现在这一周：进度要在训练单允许的范围里；换了成品的，难度级要在新成品里重新建档（各成品的级号意思不同）
  const seg = currentSegment(profile);
  const p = seg ? plans.products[seg.product] : undefined;
  if (seg && p) {
    for (const [k, v] of Object.entries(prog)) {
      const row = progressRow(p, rules, profile, planType(seg), seg.week, k);
      if (!row) continue;
      if (v.level !== undefined && p.ladders[k] && state[k]?.level !== undefined && state[k]?.product?.level !== fam(seg.product)) {
        out.push({ level: "error", path: `progress.${k}.level`, message: `难度级是在别的成品里定的，换成「${seg.product}」后要重新"建档"（各成品的级号意思不同）` });
      } else if (v.level !== undefined && p.ladders[k] && !allowedLevels(p, row, roundOf(profile, plans), rules).has(v.level)) {
        out.push({ level: "warning", path: `progress.${k}.level`, message: `第 ${v.level} 级这一周（第 ${seg.n} 段第 ${seg.week} 周）不能用，导出前要降回能用的级` });
      }
      if (v.reps !== undefined && row.reps && (v.reps < row.reps.min || v.reps > row.reps.max)) {
        out.push({ level: "error", path: `progress.${k}.reps`, message: `次数 ${v.reps} 不在这一周的区间 ${row.reps.min}–${row.reps.max} 里` });
      }
    }
  }
  return { issues: out, state: plainState() };
}

const fmtWeeks = (v: { min: number; max: number } | null | undefined) =>
  v === undefined ? "成品没写" : v === null ? "这一轮没有" : v.min === v.max ? `第 ${v.min} 周` : `第 ${v.min}–${v.max} 周`;

/** 复盘数据 yangxia.review/1 的结构。 */
export const REVIEW_FORMAT = "yangxia.review/1";
export function validateReview(raw: unknown): Issue[] {
  const out: Issue[] = [];
  const err = (path: string, message: string) => out.push({ level: "error", path, message });
  if (typeof raw !== "object" || raw === null) return [{ level: "error", path: "", message: "复盘数据要是 JSON 对象" }];
  const r = raw as Obj;
  if (r.schema !== REVIEW_FORMAT) err("schema", `格式标识要写 "${REVIEW_FORMAT}"`);
  if (typeof r.start !== "string" || !DATE.test(r.start)) err("start", "start 是这一周的开始日期 YYYY-MM-DD");
  if (!Number.isInteger(r.week) || r.week < 1 || r.week > 12) err("week", "week 是 1–4（稳定期 1–12）");
  if (r.steadyCheck !== undefined && typeof r.steadyCheck !== "boolean") err("steadyCheck", "steadyCheck（这一轮第 2 周的稳态自查过没过）是 true / false");
  if (!Number.isInteger(r.trainings) || r.trainings < 0) err("trainings", "trainings 是这一周练了几次（照使用者说的）");
  if (r.checkinDays !== undefined && !(Number.isInteger(r.checkinDays) && r.checkinDays >= 0 && r.checkinDays <= 7)) err("checkinDays", "checkinDays 是 0–7");
  if (typeof r.symptoms !== "boolean") err("symptoms", "symptoms：这一周有没有疼痛、头晕、胸闷（true / false）");
  if (r.habits !== undefined && !(typeof r.habits === "object" && r.habits !== null && !Array.isArray(r.habits)
    && Object.values(r.habits).every((v) => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 7))) err("habits", "habits 是 {打卡项: 这一周达标几天（0–7）}，打卡项见模板 打卡.md");
  for (const k of ["falls", "nearFalls", "dizzy"]) if (r[k] !== undefined && !(Number.isInteger(r[k]) && r[k] >= 0)) err(k, `${k} 是这一周的次数（65 岁以上：摔倒、差点摔倒、头晕）`);
  if (r.sickDays !== undefined && !(Number.isInteger(r.sickDays) && r.sickDays >= 0 && r.sickDays <= 7)) err("sickDays", "sickDays 是这一周生病几天（6–12 岁，0–7）");
  for (const k of ["sickOrMeds", "half", "weightDrop"]) if (r[k] !== undefined && typeof r[k] !== "boolean") err(k, `${k} 是 true / false`);
  if (Number.isInteger(r.dizzy) && r.dizzy > 0 && r.symptoms === false) err("symptoms", "这一周头晕过（dizzy），symptoms 要写 true：头晕也是不适，下周不加量");
  out.push(...validateGoalReview(r));
  if (!Array.isArray(r.moves)) err("moves", "moves 是逐个动作的表现：[{ move, allAtTop, spare }]");
  else r.moves.forEach((m: Obj, i: number) => {
    if (typeof m !== "object" || m === null || typeof m.move !== "string" || typeof m.allAtTop !== "boolean" || !(Number.isInteger(m.spare) && m.spare >= 0)
      || (m.allDone !== undefined && typeof m.allDone !== "boolean") || (m.easyTwice !== undefined && typeof m.easyTwice !== "boolean")) {
      err(`moves[${i}]`, "每项要有 move（动作 ID）、allAtTop（每组都做到区间上限）、spare（最后一组还剩几次余力），可选 allDone（每组都做满当前次数）、easyTwice（连着两次训练都轻松）");
    }
  });
  return out;
}

export { localDate };
