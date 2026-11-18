// 成人稳定期的目标（v4 阶段 4）：保持、减脂、增肌。
// 参数来自模板 rules.json 的 goals（content/rules/目标.md）；这里管：谁能选、减脂这一周的有氧台阶、中途退回、周期末下一周期能选什么、
// 计划单上的基础代谢两栏。目标只改有氧、吃和周期末，力量课程不变；有氧不导出，只写在计划单和导出提示里。
import { type AssessContext, type AssessFile, ageAt, assessRules, bmiOf, cardioMode, doctorEvents, entryHeight, productInfo } from "./assess.ts";
import { type RulesData, stableParam } from "./plan.ts";
import { localDate, reviewDataName, type SegmentEntry } from "./progress.ts";
import type { Issue } from "./types.ts";

type Obj = Record<string, any>;
export const GOALS = ["保持", "减脂", "增肌"] as const;
export type Goal = (typeof GOALS)[number];
const BODY_STATES = ["记", "不记", "停记"];
const EATING = ["问过", "只能保持"];
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAY = 86_400_000;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const dayStart = (d: string) => new Date(`${d}T00:00:00`).getTime();
const addDays = (d: string, n: number) => localDate(new Date(dayStart(d) + n * DAY + 12 * 3_600_000));
const days = (a: string, b: string) => Math.round((dayStart(b) - dayStart(a)) / DAY);

export interface GoalRules {
  params: { name: string; products: string[]; number: number }[];
  steps: { step: number; products: string[]; minutes: number }[];
}

export function goalRules(rules: RulesData | null | undefined): GoalRules | null {
  const g = (rules as Obj | null | undefined)?.goals;
  return isObj(g) && Array.isArray(g.params) && Array.isArray(g.steps) ? (g as GoalRules) : null;
}

export const goalParam = (gr: GoalRules, name: string, code: string): number | undefined =>
  gr.params.find((p) => p.name === name && p.products.includes(code))?.number;
const stepsOf = (gr: GoalRules, code: string) => gr.steps.filter((s) => s.products.includes(code)).sort((a, b) => a.step - b.step).map((s) => s.minutes);

/** 这一周的目标（没写的是保持）。 */
export const weekGoal = (s: Obj | undefined): Goal => (GOALS as readonly string[]).includes(s?.goal) ? s!.goal : "保持";

// ---------- 写法 ----------

/** 档案里目标用到的字段：segments[].goal、bodyLog、cardioClear。 */
export function validateGoalFields(p: Obj): Issue[] {
  const out: Issue[] = [];
  const err = (path: string, message: string) => out.push({ level: "error", path, message });
  (Array.isArray(p.segments) ? p.segments : []).forEach((s: Obj, i: number) => {
    if (s?.goal !== undefined && !(GOALS as readonly string[]).includes(s.goal)) err(`segments[${i}].goal`, `goal 只能是 ${GOALS.join(" / ")}（没写的是保持）`);
  });
  if (p.bodyLog !== undefined) {
    const log = p.bodyLog;
    if (!Array.isArray(log) || !log.length || log.some((e: Obj) => !isObj(e) || typeof e.date !== "string" || !DATE.test(e.date) || !BODY_STATES.includes(e.body)
      || Object.keys(e).some((k) => k !== "date" && k !== "body"))) {
      err("bodyLog", "bodyLog 是 [{ date, body: 记 / 不记 / 停记 }]：每次改记不记体重腰围的日期，只记这两样");
    } else {
      if (log.some((e: Obj, i: number) => i > 0 && e.date < log[i - 1].date)) err("bodyLog", "bodyLog 按日期从早到晚写");
      if (log[log.length - 1].body !== (p.body ?? "不记")) err("bodyLog", `bodyLog 最后一项是"${log[log.length - 1].body}"，档案的 body 是"${p.body ?? "不记"}"：要一致`);
      const stops = log.filter((e: Obj) => e.body === "停记");
      if (p.body === "停记" && stops.length && stops[stops.length - 1].date !== p.bodyStopDate) err("bodyLog", `最后一次停记是 ${stops[stops.length - 1].date}，bodyStopDate 写的是 ${p.bodyStopDate}：要一致`);
    }
  }
  for (const key of ["weightClear"]) {
    const v = p[key];
    if (v !== undefined && !(Array.isArray(v) && v.length && v.every((e: Obj) => isObj(e) && typeof e.date === "string" && DATE.test(e.date) && Object.keys(e).length === 1)
      && v.every((e: Obj, i: number) => i === 0 || e.date >= v[i - 1].date))) {
      err(key, "weightClear 是 [{ date }]：医生每次说可以按这份计划减重（每天少吃约 300 kcal、有氧逐步加到每周 250 分钟）的那天，按日期从早到晚，续了就加一项");
    }
  }
  if (p.dietByPro !== undefined && !(Array.isArray(p.dietByPro) && p.dietByPro.length
    && p.dietByPro.every((e: Obj) => isObj(e) && typeof e.date === "string" && DATE.test(e.date) && typeof e.pro === "boolean" && Object.keys(e).length === 2)
    && p.dietByPro.every((e: Obj, i: number) => i === 0 || e.date >= p.dietByPro[i - 1].date))) {
    err("dietByPro", "dietByPro 是 [{ date, pro }]：医生或营养师给了自己的减重方案（pro: true，吃照他们的）、不再照它（pro: false）的那天，按日期从早到晚，每次变了加一项");
  }
  if (p.cardioClear !== undefined && !(Array.isArray(p.cardioClear) && p.cardioClear.length
    && p.cardioClear.every((e: Obj) => isObj(e) && typeof e.date === "string" && DATE.test(e.date) && Object.keys(e).length === 1)
    && p.cardioClear.every((e: Obj, i: number) => i === 0 || e.date >= p.cardioClear[i - 1].date))) {
    err("cardioClear", "cardioClear 是 [{ date }]：医生每次说可以把有氧逐步加到每周 250 分钟中等强度的那天，按日期从早到晚，续了就加一项");
  }
  return out;
}

/** 评估记录里目标用到的字段：goal、eatingCheck、goalConsent。 */
export function validateGoalRecord(raw: Obj): Issue[] {
  const out: Issue[] = [];
  const err = (path: string, message: string) => out.push({ level: "error", path, message });
  if (raw.goal !== undefined && !(GOALS as readonly string[]).includes(raw.goal)) err("goal", `goal 是这个周期选的目标：${GOALS.join(" / ")}`);
  if (raw.eatingCheck !== undefined && !EATING.includes(raw.eatingCheck)) err("eatingCheck", "eatingCheck 只能是 问过（答了没有）/ 只能保持（答了有，不记答案）");
  if (raw.goal !== undefined && raw.goal !== "保持" && raw.eatingCheck === undefined) err("eatingCheck", "选减脂、增肌之前要照第八章开头的原话问一次进食困扰：写 eatingCheck");
  if (raw.eatingCheck === "只能保持" && raw.goal !== undefined && raw.goal !== "保持") err("goal", "进食困扰那一问答了有：这个周期只能选保持");
  if (raw.goalConsent !== undefined && !(isObj(raw.goalConsent) && typeof raw.goalConsent.date === "string" && DATE.test(raw.goalConsent.date) && Object.keys(raw.goalConsent).length === 1)) {
    err("goalConsent", "goalConsent 是 { date }：BMI 不到 18.5 的人选增肌，医生或营养师同意的那天");
  }
  return out;
}

/** 复盘数据里目标用到的字段：weight、cardioMinutes、tired。 */
export function validateGoalReview(r: Obj): Issue[] {
  const out: Issue[] = [];
  const err = (path: string, message: string) => out.push({ level: "error", path, message });
  if (r.weight !== undefined && !(typeof r.weight === "number" && r.weight >= 25 && r.weight <= 300 && Math.round(r.weight * 10) === r.weight * 10)) err("weight", "weight 是这一周称的体重（公斤，一位小数），每周最多一次");
  if (r.cardioMinutes !== undefined && !(Number.isInteger(r.cardioMinutes) && r.cardioMinutes >= 0 && r.cardioMinutes <= 2000)) err("cardioMinutes", "cardioMinutes 是这一周中等强度有氧大约做了几分钟（整数）");
  if (r.tired !== undefined && typeof r.tired !== "boolean") err("tired", "tired（练完没力气）是 true / false");
  return out;
}

// ---------- 状态 ----------

/** 某一天"记 / 不记 / 停记"：有 bodyLog 照它；没有的由 body、bodyStopDate 推（停记那天以前按记）。 */
export function bodyStateOn(p: Obj, date: string): string {
  if (Array.isArray(p.bodyLog) && p.bodyLog.length) {
    let st = "不记";
    for (const e of p.bodyLog) if (typeof e?.date === "string" && e.date <= date) st = e.body;
    return st;
  }
  if (p.body === "停记") return typeof p.bodyStopDate === "string" && date < p.bodyStopDate ? "记" : "停记";
  return p.body === "记" ? "记" : "不记";
}

/** 停记的日期（bodyLog 里的每一次，没有的用 bodyStopDate）。 */
function stopDates(p: Obj): string[] {
  if (Array.isArray(p.bodyLog) && p.bodyLog.length) return p.bodyLog.filter((e: Obj) => e?.body === "停记").map((e: Obj) => e.date);
  return p.body === "停记" && typeof p.bodyStopDate === "string" ? [p.bodyStopDate] : [];
}

interface Seg { n: number; first: number; entries: SegmentEntry[] }
function segs(p: Obj): Seg[] {
  const ss = (p.segments ?? []) as SegmentEntry[];
  const out: Seg[] = [];
  ss.forEach((s, i) => {
    const last = out[out.length - 1];
    if (last && last.n === s.n) last.entries.push(s);
    else out.push({ n: s.n, first: i, entries: [s] });
  });
  return out;
}
const stable = (s: Seg) => s.entries[0].phase === "稳定";
const roundOf = (w: number) => Math.floor((w - 1) / 4) + 1;
/** 建档时直接进的稳定期：目标从第 2 轮起才做。 */
const directEntry = (all: Seg[], s: Seg) => all[0] === s && stable(s);
/** 这一周实际按的目标（直接进入的第 1 轮按保持）。 */
export function effectiveGoal(p: Obj, index: number, gr?: GoalRules | null, code?: string): Goal {
  const ss = (p.segments ?? []) as SegmentEntry[];
  const e = ss[index];
  if (!e || e.phase !== "稳定") return "保持";
  const all = segs(p);
  const seg = all.find((s) => s.first <= index && index < s.first + s.entries.length);
  const from = gr && code ? goalParam(gr, "第几轮起生效（直接进入）", code) ?? 2 : 2;
  if (seg && directEntry(all, seg) && roundOf(e.week) < from) return "保持";
  return weekGoal(e);
}

const fullMaintain = (s: Seg, cycle: number) => stable(s) && s.entries.every((e) => weekGoal(e) === "保持") && s.entries.some((e) => e.week === cycle);

/** 周期开始之前最近的、量了体重和腰围的评估（记录那天是"记"）。 */
function bodyBefore(ctx: AssessContext, start: string, freshDays: number): AssessFile | null {
  const list = ctx.assessments.filter((a) => typeof a.raw?.date === "string" && a.raw.date <= start && days(a.raw.date, start) <= freshDays
    && typeof a.raw.body?.weight === "number" && typeof a.raw.body?.waist === "number" && bodyStateOn(ctx.profile, a.raw.date) === "记")
    .sort((x, y) => (x.raw.date < y.raw.date ? -1 : 1));
  return list.pop() ?? null;
}

/** 开这个周期的那份评估（按位置认）：上一段是稳定期的，它的周期末；上一段是起始期的，它的段末；建档时直接进入的，入门。 */
function openingRecord(ctx: AssessContext, index: number): AssessFile | null {
  const all = segs(ctx.profile);
  const k = all.findIndex((s) => s.first === index);
  if (k < 0) return null;
  if (k === 0) return ctx.assessments.find((a) => a.raw?.kind === "入门") ?? null;
  const prev = all[k - 1];
  const kind = stable(prev) ? "周期末" : "段末";
  return ctx.assessments.filter((a) => a.raw?.kind === kind && a.raw.segment === prev.n).pop() ?? null;
}

/** 体重（公斤）按固定的身高算 BMI（身高一律用最早那份，不用记录里自己写的）。 */
const bmiW = (w: unknown, h: number | undefined): number | null => (typeof w === "number" && typeof h === "number" ? bmiOf({ weight: w }, h) : null);

/** BMI 和腰围对应能选的目标（GOAL_GATE 那张表；BMI < 18.5 的增肌要另看同意）。 */
function tableGoals(gr: GoalRules, code: string, bmi: number, waist: number): { allowed: Goal[]; why: string[]; lowBmi: boolean; obeseCut?: boolean } {
  const low = goalParam(gr, "低体重 BMI", code) ?? 18.5;
  const over = goalParam(gr, "超重 BMI", code) ?? 24;
  const obese = goalParam(gr, "肥胖 BMI", code) ?? 28;
  const cutWaist = goalParam(gr, "减脂腰围", code) ?? 90;
  const bulkWaist = goalParam(gr, "增肌腰围", code) ?? 85;
  const obeseMax = goalParam(gr, "肥胖可减脂 BMI 上限", code) ?? 32.5;
  if (bmi >= obeseMax) return { allowed: ["保持"], why: [`BMI ${bmi}（${obeseMax} 以上）：不在这份计划里减重，找医生、营养师制订减重计划`], lowBmi: false };
  if (bmi >= obese) return { allowed: ["保持"], why: [`BMI ${bmi}：肥胖的人要医生同意按这份计划减重（档案 weightClear 记日期）才能选减脂`], lowBmi: false, obeseCut: true };
  if (bmi < low) return { allowed: ["保持"], why: [`BMI ${bmi} 不到 ${low}：增肌要先问医生或营养师（同意的那天记在开周期的评估 goalConsent）`], lowBmi: true };
  if (bmi < over) {
    if (waist >= cutWaist) return { allowed: ["保持", "减脂"], why: [], lowBmi: false };
    if (waist < bulkWaist) return { allowed: ["保持", "增肌"], why: [], lowBmi: false };
    return { allowed: ["保持"], why: [`腰围 ${waist} cm 在 ${bulkWaist}–${cutWaist - 1} 之间：不问性别，减脂、增肌都不选`], lowBmi: false };
  }
  return { allowed: ["保持", "减脂"], why: [], lowBmi: false };
}

const dietItem = (p: Obj) => (p.screening?.answers ?? []).find((a: Obj) => /糖尿病/.test(a?.item ?? "") && /痛风|高血脂/.test(a?.item ?? ""));
/** 筛查第 3 项（糖尿病、肾病、痛风或高尿酸、高血脂）答了"是"：吃照医生的意见。 */
export const dietByDoctor = (p: Obj) => dietItem(p)?.answer === "是";
/** 某一天吃是不是照医生、营养师给的减重方案（dietByPro 里那一天以前最近的一项；没记的是 false）。 */
export function dietByProOn(p: Obj, date: string): boolean {
  let on = false;
  for (const e of Array.isArray(p.dietByPro) ? p.dietByPro : []) if (typeof e?.date === "string" && e.date <= date) on = e.pro === true;
  return on;
}

export interface GateResult { allowed: Goal[]; why: string[]; bmi?: number; waist?: number; body?: AssessFile | null }

/** 某一段（周期）开始时能选什么（第三节）。index 是这一段第一项的下标。 */
export function goalGate(ctx: AssessContext, index: number): GateResult {
  const gr = goalRules(ctx.rules);
  const ar = assessRules(ctx.rules);
  const ss = (ctx.profile.segments ?? []) as SegmentEntry[];
  const e = ss[index];
  const info = e ? productInfo(ctx.manifest, e.product) : null;
  const only = (why: string): GateResult => ({ allowed: ["保持"], why: [why] });
  if (!gr || !ar || !e || !info) return only("模板还没有目标的规则（rules.json 的 goals）：先更新模板");
  if (e.phase !== "稳定" || !["a18", "a40"].includes(info.age)) return only("只有 18–64 岁的稳定期分目标");
  const code = info.code;
  const cycle = (ctx.rules as Obj)?.stable?.cycleWeeks ?? 12;
  const age0 = ageAt(ctx.profile, e.start, ar.assess).age;
  const age1 = ageAt(ctx.profile, addDays(e.start, cycle * 7 - 1), ar.assess).age;
  if (age0 !== info.age || age1 !== info.age) return only(`这 ${cycle} 周里会满 40 岁或 65 岁（到时候要换计划）：只选保持`);
  if (bodyStateOn(ctx.profile, e.start) !== "记") return only("档案没选\"记\"体重腰围（或者停记了）：只选保持");
  const open = openingRecord(ctx, index);
  if (open?.raw.eatingCheck === "只能保持") return only("进食困扰那一问：这个周期只选保持");
  const fresh = goalParam(gr, "身体数据有效天数", code) ?? 28;
  const body = bodyBefore(ctx, e.start, fresh);
  if (!body) return only(`周期开始前 ${fresh} 天以内没有量过体重、腰围：只选保持`);
  const bmi = bmiW(body.raw.body.weight, entryHeight(ctx));
  const waist = body.raw.body.waist as number;
  if (bmi === null) return only("算不出 BMI（没有记过身高）：只选保持");
  const t = tableGoals(gr, code, bmi, waist);
  const allowed: Goal[] = [...t.allowed];
  const why: string[] = [...t.why];
  if (t.lowBmi) {
    const consent = open?.raw.goalConsent?.date;
    if (typeof consent === "string" && consent <= e.start) { allowed.push("增肌"); why.length = 0; }
  }
  // 肥胖（28.0–32.4）：有有效的减重医生同意才能选减脂
  if (t.obeseCut && clearValid(ctx, "weightClear", e.start, code, { waitDoctor: true }).valid) { allowed.push("减脂"); why.length = 0; }
  // 医生、营养师有自己的减重方案：选保持，吃照他们的
  if (dietByProOn(ctx.profile, e.start) && allowed.length > 1) return { allowed: ["保持"], why: ["医生、营养师给了自己的减重方案（dietByPro）：选保持，训练照这份计划，吃照他们的"], bmi, waist, body };
  // 减脂之前要隔满一个完整的保持周期：连着两个减脂周期以后、停记以后
  if (allowed.includes("减脂")) {
    const all = segs(ctx.profile);
    const k = all.findIndex((s) => s.first === index);
    let run = 0;
    for (let j = k - 1; j >= 0; j--) {
      if (fullMaintain(all[j], cycle)) break;
      if (stable(all[j]) && weekGoal(all[j].entries[0]) === "减脂") run++;
    }
    const maxRun = goalParam(gr, "连着减脂周期", code) ?? 2;
    const lastStop = stopDates(ctx.profile).filter((d) => d < e.start).pop();
    const restAfterStop = lastStop ? all.slice(0, k).some((s) => s.entries[0].start >= lastStop && fullMaintain(s, cycle)) : true;
    if (run >= maxRun) { allowed.splice(allowed.indexOf("减脂"), 1); why.push(`连着 ${run} 个减脂周期：先完整练一个保持周期`); }
    else if (!restAfterStop) { allowed.splice(allowed.indexOf("减脂"), 1); why.push(`${lastStop} 停记过体重：先完整练一个保持周期，再选减脂`); }
  }
  return { allowed, why, bmi, waist, body };
}

/**
 * 带日期的医生同意（cardioClear、weightClear 同一个办法）这一天还有没有效：用这一天以前最近的一次，有效天数以内，
 * 不早于最近一次重做的筛查和最近一件要医生同意的事。两种算法：
 * - 默认（有氧台阶用，成品《目标》一节"没有同意的那几周不算进升档，问过以后从 100 分钟那一档重新开始"）：
 *   事情一出（重做筛查、生病住院、摔倒……）旧的同意就不算了；
 * - waitDoctor（减脂能不能选、要不要中途退回保持用）：要医生同意的事（筛查有"是"的那次筛查、生病住院、摔倒……）
 *   等看了医生才算进来——还没看医生的那几天本来就导不出课程和计划单，看医生时续上的，看医生以前开始的那一周
 *   不算失效；看了医生没续的，之后开始的周起失效（设计值 WEIGHT_CLEAR）。看医生的日子：档案 screening.doctorDate
 *   和"看完医生回来"触发评估记的 doctorDate。
 */
export function clearValid(ctx: AssessContext, key: "cardioClear" | "weightClear" | "addClear", date: string, code: string,
  opts: { waitDoctor?: boolean; item?: string } = {}): { valid: boolean; after: string } {
  const p = ctx.profile;
  const gr = goalRules(ctx.rules);
  // 加项的同意（65 岁以上稳定期，A65_ADD_CLEAR）：有效天数在稳定期规则里；item 给了只看同意了这一项的那几次
  const keep = key === "addClear" ? stableParam(ctx.rules, code, "加项医生同意有效天数")?.number ?? 365
    : gr ? goalParam(gr, key === "weightClear" ? "减重医生同意有效天数" : "有氧医生同意有效天数", code) ?? 365 : 365;
  const sd = typeof p.screening?.date === "string" ? p.screening.date : "";
  const docEv = doctorEvents(ctx).map((x) => x.date);
  let events: string[];
  if (opts.waitDoctor) {
    const visits = [p.screening?.doctorCleared === true ? p.screening?.doctorDate : undefined,
      ...ctx.assessments.filter((a) => Array.isArray(a.raw?.reasons) && a.raw.reasons.includes("看完医生回来")).map((a) => a.raw.doctorDate)]
      .filter((d): d is string => typeof d === "string" && DATE.test(d) && d <= date).sort();
    const seen = visits.pop() ?? "";
    events = [...(sd && !docEv.includes(sd) ? [sd] : []), ...docEv.filter((d) => seen && d <= seen)];
  } else {
    events = [sd, ...docEv];
    // 加项的同意（65 岁以上稳定期）：看完医生回来（摔倒、头晕轮末那一次）以后，旧的同意也不算（A65_ADD_CLEAR）
    if (key === "addClear") events.push(...ctx.assessments.filter((a) => Array.isArray(a.raw?.reasons) && a.raw.reasons.includes("看完医生回来")).map((a) => a.raw.date));
  }
  const after = events.filter((d) => d && d <= date).sort().pop() ?? "";
  // 每一周用当时有效的那一次同意（续过的不影响以前几周）
  const list = (Array.isArray(p[key]) ? p[key] : []).filter((e: Obj) => !opts.item || (Array.isArray(e?.items) && e.items.includes(opts.item)));
  const d = list.map((e: Obj) => e?.date).filter((x: unknown) => typeof x === "string" && x <= date).sort().pop();
  return { valid: typeof d === "string" && d >= after && days(d, date) <= keep, after };
}

/** 减脂这一周有氧要不要先问医生：有高血压（或没确认），或者筛查有"是"。valid：带日期的同意还有效（减重的同意也算）。 */
export function cardioDoctor(ctx: AssessContext, date: string, code: string): { needed: boolean; valid: boolean; after: string } {
  const p = ctx.profile;
  const hyper = p.conditions?.["高血压"] !== false;
  const yes = (p.screening?.answers ?? []).some((a: Obj) => a?.answer === "是");
  if (!hyper && !yes) return { needed: false, valid: true, after: "" };
  const c = clearValid(ctx, "cardioClear", date, code);
  const w = clearValid(ctx, "weightClear", date, code);
  return { needed: true, valid: c.valid || w.valid, after: c.after };
}

/**
 * BMI 37.5 以上（"重度肥胖"，推出来的条件）：这一天还是"记"、量过体重的（评估、减脂复盘里称的）按最近一次的 BMI，
 * 不管隔了多久；没量过的、改成不记或停记的看档案条件；也没有的看筛查"BMI ≥ 28"（设计值 SEVERE_OBESE_INTERVAL）。
 */
export function severeObese(ctx: AssessContext, date: string, code?: string): boolean {
  const gr = goalRules(ctx.rules);
  const line = (gr && code ? goalParam(gr, "重度肥胖 BMI", code) : undefined) ?? 37.5;
  const bmi = latestBmi(ctx, date);
  if (bmi !== null) return bmi >= line;
  const c = ctx.profile.conditions?.["重度肥胖"];
  if (typeof c === "boolean") return c;
  return (ctx.profile.screening?.answers ?? []).some((a: Obj) => /BMI/.test(a?.item ?? "") && a?.answer === "是");
}

/**
 * 最近一次称的体重（这一天以前）：评估里量的（记录那天是"记"），和减脂复盘里称的（算在那一周的最后一天，那一周是"记"）。
 * where 是给报错用的位置；only 只看评估或只看复盘。
 */
export function lastWeighed(ctx: AssessContext, date: string, only?: "评估" | "复盘"): { date: string; weight: number; where: string } | null {
  const p = ctx.profile;
  const pts: { date: string; weight: number; where: string }[] = [];
  if (only !== "复盘") for (const a of ctx.assessments) {
    if (typeof a.raw?.date === "string" && a.raw.date <= date && typeof a.raw.body?.weight === "number" && bodyStateOn(p, a.raw.date) === "记") pts.push({ date: a.raw.date, weight: a.raw.body.weight, where: `${a.name} body` });
  }
  if (only !== "评估") for (const s of (p.segments ?? []) as SegmentEntry[]) {
    const w = ctx.reviewData[reviewDataName(s)]?.weight;
    const end = typeof s.start === "string" ? addDays(s.start, 6) : "";
    if (typeof w === "number" && end && end <= date && bodyStateOn(p, s.start) === "记") pts.push({ date: end, weight: w, where: `复盘/${reviewDataName(s)} weight` });
  }
  return pts.sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : 0)).pop() ?? null;
}

/**
 * 最近一次量的 BMI（身高用最早那份）：只给这一天还是"记"的人——改成不记、停记以后不再有新的测量，旧的数不拿来用；
 * 没有的返回 null。
 */
export function latestBmi(ctx: AssessContext, date: string): number | null {
  if (bodyStateOn(ctx.profile, date) !== "记") return null;
  const last = lastWeighed(ctx, date);
  return last ? bmiW(last.weight, entryHeight(ctx)) : null;
}

// ---------- 减脂的有氧台阶 ----------

export interface CardioStep { minutes: number; step: number; steps: number; why: string; doctor?: string; half?: boolean }

/** 第 index 项那一周减脂的有氧台阶（不是减脂、不生效的返回 null）。 */
export function cutCardio(ctx: AssessContext, index: number): CardioStep | null {
  const gr = goalRules(ctx.rules);
  const ss = (ctx.profile.segments ?? []) as SegmentEntry[];
  const e = ss[index];
  const info = e ? productInfo(ctx.manifest, e.product) : null;
  if (!gr || !e || !info || effectiveGoal(ctx.profile, index, gr, info.code) !== "减脂") return null;
  const code = info.code;
  const steps = stepsOf(gr, code);
  if (!steps.length) return null;
  const doc = cardioDoctor(ctx, e.start, code);
  if (doc.needed && !doc.valid) {
    // 走减重同意的肥胖的人：续减重的同意（同时算有氧加量的），只续有氧的那一周起减脂就退回保持了
    const weight = Array.isArray(ctx.profile.weightClear) && ctx.profile.weightClear.length > 0;
    const ask = weight ? "先问医生\"能不能按这份计划减重——每天比平时少吃约 300 kcal，有氧逐步加到每周 250 分钟中等强度\"，同意了在档案 weightClear 里加一项日期（同时算有氧加量的同意）"
      : "先问医生\"能不能把有氧逐步加到每周 250 分钟中等强度\"，同意了在档案 cardioClear 里加一项日期";
    return { minutes: 0, step: 0, steps: steps.length, why: "有高血压（或没确认）、或者安全筛查有\"是\"",
      doctor: `${ask}${doc.after ? `（要在 ${doc.after} 之后）` : ""}；没问之前有氧照保持的量` };
  }
  const minWeeks = goalParam(gr, "有氧每档至少几周", code) ?? 2;
  const needRun = goalParam(gr, "有氧升档要连着做到几周", code) ?? 2;
  const all = segs(ctx.profile);
  const seg = all.find((s) => s.first <= index && index < s.first + s.entries.length)!;
  const k = all.indexOf(seg);
  // 起点：紧挨着的上一段是减脂（最后一周还是减脂）的，接着它最后那一档；不适带过来
  let step = 0;
  let symptomRound = -1;
  const prev = all[k - 1];
  if (prev && stable(prev) && weekGoal(prev.entries[prev.entries.length - 1]) === "减脂") {
    // 接着上一周期最后"做到"的那一档：最后一周没做到那一档的，退一档
    const lastIdx = prev.first + prev.entries.length - 1;
    const last = cutCardio(ctx, lastIdx);
    if (last && last.step > 0) {
      const did = ctx.reviewData[reviewDataName(ss[lastIdx])]?.cardioMinutes;
      step = Math.max(0, last.step - 1 - (typeof did === "number" && did >= last.minutes ? 0 : 1));
    }
    const lastRound = roundOf(prev.entries[prev.entries.length - 1].week);
    if (prev.entries.some((x) => roundOf(x.week) === lastRound && ctx.reviewData[reviewDataName(x)]?.symptoms === true)) symptomRound = 0;
  }
  // 上一周期周期末"第 1 轮不升级"：这个周期第 1 轮有氧也不升档
  const holdFirst = !!prev && stable(prev) && ctx.assessments.some((a) => a.raw?.kind === "周期末" && a.raw.segment === prev.n && a.raw.conclusion?.next?.hold === true);
  const breaks = ctx.assessments.filter((a) => a.raw?.kind === "触发" && Array.isArray(a.raw.reasons) && a.raw.reasons.includes("中断")).map((a) => a.raw.date as string);
  let run = 0, atStep = 0;
  const from = seg.first;
  for (let j = from; j < index; j++) {
    const x = ss[j];
    if (effectiveGoal(ctx.profile, j, gr, code) !== "减脂") continue;
    // 这一周没有有效的医生同意（要同意的人）：这一周不算，同意以后从第一档开始
    const dj = cardioDoctor(ctx, x.start, code);
    if (dj.needed && !dj.valid) { step = 0; run = 0; atStep = 0; continue; }
    const rv = ctx.reviewData[reviewDataName(x)];
    const sym = rv?.symptoms === true;
    if (sym) { symptomRound = roundOf(x.week); run = 0; atStep = 0; }
    else if (typeof rv?.cardioMinutes === "number" && rv.cardioMinutes >= steps[step]) { run++; atStep++; }
    else run = 0;
    const nx = ss[j + 1];
    if (!nx) break;
    // 断了四周以上（中断的触发评估）：回第一档
    if (breaks.some((d) => d > x.start && d <= nx.start)) { step = 0; run = 0; atStep = 0; continue; }
    const r2 = roundOf(nx.week);
    const blocked = symptomRound === r2 || (symptomRound === r2 - 1 && (nx.week - 1) % 4 === 0) || (holdFirst && r2 === 1);
    if (!blocked && run >= needRun && atStep >= minWeeks && step < steps.length - 1) { step++; run = 0; atStep = 0; }
  }
  if (breaks.some((d) => d > (ss[index - 1]?.start ?? "") && d <= e.start)) step = 0;
  const cur = e.week;
  const why = step === steps.length - 1 ? "已经是最高一档" : `连着 ${needRun} 周做到这一档、没有不适，而且这一档练满 ${minWeeks} 周，才升下一档`;
  return { minutes: steps[step], step: step + 1, steps: steps.length, why: roundOf(cur) === symptomRound ? "这一轮有过疼痛、头晕、胸闷：这一轮不升" : why };
}

// ---------- 基础代谢两栏 ----------

/** 按身高（入门）、最近的体重、年龄估基础代谢（成品同一个公式 BMR_FORMULA：Mifflin-St Jeor），男、女两栏，取整到 10。 */
export function bmrTwo(ctx: AssessContext, date: string): { male: number; female: number; height: number; weight: number; age: number } | null {
  const h = entryHeight(ctx);
  const birth = ctx.profile.birth;
  if (typeof h !== "number" || typeof birth !== "string") return null;
  const ss = (ctx.profile.segments ?? []) as SegmentEntry[];
  const fromReviews = ss.filter((s) => s.start < date).map((s) => ({ d: s.start, w: ctx.reviewData[reviewDataName(s)]?.weight })).filter((x) => typeof x.w === "number");
  const fromRecords = ctx.assessments.filter((a) => typeof a.raw?.date === "string" && a.raw.date <= date && typeof a.raw.body?.weight === "number").map((a) => ({ d: a.raw.date, w: a.raw.body.weight }));
  const last = [...fromReviews, ...fromRecords].sort((x, y) => (x.d < y.d ? -1 : 1)).pop();
  if (!last) return null;
  const [y, m] = birth.split("-").map(Number);
  const [y2, m2] = date.split("-").map(Number);
  const age = Math.floor(((y2 - y) * 12 + (m2 - m)) / 12);
  const base = 10 * last.w + 6.25 * h - 5 * age;
  const r10 = (x: number) => Math.round(x / 10) * 10;
  return { male: r10(base + 5), female: r10(base - 161), height: h, weight: last.w, age };
}

// ---------- 中途退回、周期末 ----------

/** 减脂掉太快、BMI 掉到 18.5 以下：从哪一项起要退回保持（复盘发现的下一周起）。 */
function cutStopFrom(ctx: AssessContext, seg: Seg, gr: GoalRules, code: string): { index: number; why: string } | null {
  const fromWeek = goalParam(gr, "掉太快从第几周", code) ?? 3;
  const n = goalParam(gr, "掉太快称重次数", code) ?? 4;
  const kg = goalParam(gr, "掉太快每周公斤", code) ?? 1;
  const low = goalParam(gr, "低体重 BMI", code) ?? 18.5;
  const h = entryHeight(ctx);
  const ws: { i: number; d: string; w: number }[] = [];
  let firstWeek = 0;
  for (let j = 0; j < seg.entries.length; j++) {
    const x = seg.entries[j];
    if (weekGoal(x) !== "减脂") break;
    if (effectiveGoal(ctx.profile, seg.first + j, gr, code) !== "减脂") continue;   // 直接进入的第 1 轮按保持
    if (!firstWeek) firstWeek = x.week;
    const w = ctx.reviewData[reviewDataName(x)]?.weight;
    if (typeof w !== "number") continue;
    if (typeof h === "number" && w / ((h / 100) ** 2) < low) return { index: seg.first + j + 1, why: `${x.start} 那一周称的体重 BMI 不到 ${low}` };
    if (x.week - firstWeek + 1 < fromWeek) continue;
    ws.push({ i: seg.first + j, d: x.start, w });
    if (ws.length >= n) {
      const a = ws[ws.length - n], b = ws[ws.length - 1];
      const weeks = days(a.d, b.d) / 7;
      if (weeks > 0 && (a.w - b.w) / weeks > kg) return { index: b.i + 1, why: `连着 ${n} 次称重平均每周掉了 ${Math.round(((a.w - b.w) / weeks) * 10) / 10} kg（超过 ${kg} kg）` };
    }
  }
  return null;
}

/** 周期末（第 n 段）以后下一周期能选什么（GOAL_CYCLE_END；还要再过一遍 goalGate）。 */
export function cycleGoals(ctx: AssessContext, n: number, record?: AssessFile): { goals: Goal[]; why: string } | null {
  const gr = goalRules(ctx.rules);
  const all = segs(ctx.profile);
  const seg = all.find((s) => s.n === n);
  if (!gr || !seg || !stable(seg)) return null;
  const info = productInfo(ctx.manifest, seg.entries[0].product);
  if (!info || !["a18", "a40"].includes(info.age)) return null;
  const code = info.code;
  const g = weekGoal(seg.entries[0]);
  const end = record?.raw.body;
  const h = entryHeight(ctx);
  const bmi = end ? bmiW(end.weight, h) : null;
  const all3: Goal[] = ["保持", "减脂", "增肌"];
  const cycle = (ctx.rules as Obj)?.stable?.cycleWeeks ?? 12;
  if (g === "保持") {
    if (bmi === null || typeof end?.waist !== "number") return { goals: all3, why: "这个周期是保持：下一周期照\"谁能选\"（这份记录没有体重腰围，开周期时再对）" };
    const t = tableGoals(gr, code, bmi, end.waist);
    return { goals: t.lowBmi ? ["保持", "增肌"] : t.allowed, why: t.lowBmi ? `BMI ${bmi}：增肌要先问医生或营养师` : `这个周期是保持：按周期末量的 BMI ${bmi}、腰围 ${end.waist} cm` };
  }
  const stopped = seg.entries.some((x) => weekGoal(x) === "保持");
  if (g === "减脂") {
    const safety = cutStopFrom(ctx, seg, gr, code) !== null || seg.entries.some((x) => bodyStateOn(ctx.profile, addDays(x.start, 6)) !== "记");
    if (stopped && safety) return { goals: ["保持"], why: "这个周期因为停记、掉太快或 BMI 太低退回过保持" };
    const over = goalParam(gr, "超重 BMI", code) ?? 24;
    const cutWaist = goalParam(gr, "减脂腰围", code) ?? 90;
    if (bmi !== null && bmi < over && typeof end.waist === "number" && end.waist < cutWaist) return { goals: ["保持"], why: `BMI ${bmi}、腰围 ${end.waist} cm：到了，下一周期保持，把体重维持住` };
    let run = 0;
    for (let j = all.indexOf(seg); j >= 0; j--) {
      if (fullMaintain(all[j], cycle)) break;
      if (stable(all[j]) && weekGoal(all[j].entries[0]) === "减脂") run++;
    }
    if (run >= (goalParam(gr, "连着减脂周期", code) ?? 2)) return { goals: ["保持"], why: `连着 ${run} 个减脂周期：下一周期保持（官方"6 个月内……并维持"）` };
    return { goals: ["保持", "减脂"], why: "可以接着减脂，也可以选保持；体重没降的缺口也不加" };
  }
  // 增肌
  const over = goalParam(gr, "超重 BMI", code) ?? 24;
  const bulkWaist = goalParam(gr, "增肌腰围", code) ?? 85;
  if ((bmi !== null && bmi >= over) || (typeof end?.waist === "number" && end.waist >= bulkWaist)) return { goals: ["保持"], why: "BMI 到了 24 或者腰围到了 85 cm" };
  const start = bodyBefore(ctx, seg.entries[0].start, 9999)?.raw.body;
  const pct = goalParam(gr, "增肌体重涨百分比", code) ?? 3;
  const cm = goalParam(gr, "增肌腰围涨", code) ?? 2;
  if (start && end && ((typeof end.weight === "number" && end.weight > start.weight * (1 + pct / 100)) || (typeof end.waist === "number" && end.waist - start.waist >= cm))) {
    return { goals: ["保持"], why: `12 周体重涨了超过 ${pct}% 或者腰围涨了 ${cm} cm 以上：涨得太快多半是脂肪` };
  }
  return { goals: ["保持", "增肌"], why: "可以接着增肌，也可以选保持" };
}

/** 档案目录里目标的核对（profile check、导出之前都跑）。 */
export function goalIssues(ctx: AssessContext): Issue[] {
  const out: Issue[] = [];
  const err = (path: string, message: string) => out.push({ level: "error", path, message });
  const gr = goalRules(ctx.rules);
  const p = ctx.profile;
  const ss = (p.segments ?? []) as SegmentEntry[];
  const all = segs(p);
  const any = ss.some((s) => weekGoal(s) !== "保持") || ctx.assessments.some((a) => a.raw?.goal !== undefined && a.raw.goal !== "保持");
  if (!gr) {
    if (any) out.push({ level: "warning", path: "档案.json segments", message: "模板还没有目标的规则（rules.json 的 goals）：减脂、增肌没核对，先把模板更新到 v3.3 之后" });
    return out;
  }
  for (const seg of all) {
    const g0 = weekGoal(seg.entries[0]);
    const info = productInfo(ctx.manifest, seg.entries[0].product);
    const code = info?.code ?? "";
    const path = (j: number) => `档案.json segments[${seg.first + j}].goal`;
    if (!stable(seg)) {
      seg.entries.forEach((x, j) => { if (x.goal !== undefined && weekGoal(x) !== "保持") err(path(j), "起始期不分目标：减脂、增肌在稳定期选"); });
      continue;
    }
    // 中途只能往保持退，退了不能改回去
    for (let j = 1; j < seg.entries.length; j++) {
      const a = weekGoal(seg.entries[j - 1]), b = weekGoal(seg.entries[j]);
      if (b !== a && b !== "保持") err(path(j), `一个周期里目标只能从${a === "保持" ? "减脂、增肌" : a}退回保持，不能${a === "保持" ? "退回以后再改回去" : `换成${b}`}`);
    }
    // 开周期：选的目标在"谁能选"里，开周期的评估写了同一个目标
    if (g0 !== "保持") {
      const gate = goalGate(ctx, seg.first);
      if (!gate.allowed.includes(g0)) err(path(0), `这个周期选了${g0}，可是只能选 ${gate.allowed.join("、")}：${gate.why.join("；")}`);
      const open = openingRecord(ctx, seg.first);
      if (!open) err(path(0), `选了${g0}：开这个周期的那份评估（上一段的周期末、进稳定期的段末、直接进入的入门）要写 goal 和 eatingCheck`);
      else if (open.raw.goal !== g0) err(path(0), `开这个周期的 ${open.name} 写的目标是${open.raw.goal ?? "（没写）"}，档案这一周是${g0}：要一致，选减脂、增肌要在这一份里问进食困扰（eatingCheck）`);
      else if (open.raw.eatingCheck !== "问过") err(path(0), `开这个周期的 ${open.name} 没问进食困扰（eatingCheck 要是"问过"）：每次选减脂、增肌都要问`);
    }
    // 周期末的结论：下一段（同一家族的稳定期）第 1 周的目标要在里面
    const k = all.indexOf(seg);
    const next = all[k + 1];
    if (next && stable(next) && weekGoal(next.entries[0]) !== "保持") {
      const rec = ctx.assessments.filter((a) => a.raw?.kind === "周期末" && a.raw.segment === seg.n).pop();
      const cg = cycleGoals(ctx, seg.n, rec);
      const want = weekGoal(next.entries[0]);
      if (cg && !cg.goals.includes(want)) err(`档案.json segments[${next.first}].goal`, `第 ${seg.n} 段周期末：下一周期只能选 ${cg.goals.join("、")}（${cg.why}），写的是${want}`);
    }
    // 中途退回：停记、不记（改动那一周起）；减脂掉太快、BMI 太低（复盘发现的下一周起）；增肌在评估里到了 24 或 85
    const stop = g0 === "减脂" && info ? cutStopFrom(ctx, seg, gr, code) : null;
    // 肥胖的人的减脂：这一周开始时最近一次量的 BMI 在 28 以上（没量过的按开周期时的），减重的医生同意都要有效
    const obeseLine = goalParam(gr, "肥胖 BMI", code) ?? 28;
    const gate0 = g0 === "减脂" ? goalGate(ctx, seg.first) : null;
    const obeseAt = (date: string) => {
      const b = latestBmi(ctx, date) ?? gate0?.bmi;
      return typeof b === "number" && b >= obeseLine;
    };
    seg.entries.forEach((x, j) => {
      const g = weekGoal(x);
      if (g === "保持") return;
      const endDay = addDays(x.start, 6);
      const st = bodyStateOn(p, x.start) !== "记" ? x.start : (Array.isArray(p.bodyLog) ? p.bodyLog : []).find((b: Obj) => b.date >= x.start && b.date <= endDay && b.body !== "记")?.date
        ?? (p.body === "停记" && typeof p.bodyStopDate === "string" && p.bodyStopDate >= x.start && p.bodyStopDate <= endDay ? p.bodyStopDate : undefined);
      if (st) err(path(j), `${st} 起不记（或停记）体重腰围：这一周起目标退回保持（这一周的计划单重新生成）`);
      else if (j > 0 && dietByProOn(p, x.start)) err(path(j), `医生、营养师给了自己的减重方案（dietByPro，${x.start} 这一周开始时已经记了）：这一周起退回保持，吃照他们的`);
      else if (g === "减脂" && obeseAt(x.start) && !clearValid(ctx, "weightClear", x.start, code, { waitDoctor: true }).valid) {
        const had = (Array.isArray(p.weightClear) ? p.weightClear : []).some((c: Obj) => typeof c?.date === "string" && c.date <= x.start);
        err(path(j), had ? `减重的医生同意（weightClear）到 ${x.start} 这一周已经失效（过期，或者重做了筛查、有了新的要问医生的事，看了医生没续）：这一周起退回保持，下一个周期再选`
          : `${x.start} 这一周开始时最近一次称的 BMI 到了 ${obeseLine}（肥胖），没有减重的医生同意（weightClear）：这一周起退回保持，医生同意了下一个周期再选`);
      }
      else if (stop && seg.first + j >= stop.index) err(path(j), `${stop.why}：下一周起退回保持，问问有没有饿着、没力气、头晕`);
      if (g === "增肌") {
        const over = goalParam(gr, "超重 BMI", code) ?? 24;
        const bulkWaist = goalParam(gr, "增肌腰围", code) ?? 85;
        const hit = ctx.assessments.find((a) => typeof a.raw?.date === "string" && a.raw.date >= seg.entries[0].start && a.raw.date < x.start && a.raw.body
          && ((bmiW(a.raw.body.weight, entryHeight(ctx)) ?? 0) >= over || (typeof a.raw.body.waist === "number" && a.raw.body.waist >= bulkWaist)));
        if (hit) err(path(j), `${hit.name} 量的 BMI 到了 ${over} 或者腰围到了 ${bulkWaist} cm：之后的周退回保持`);
      }
    });
    // 复盘数据：体重、有氧分钟、没力气只给这一周按减脂的人；体重要那一周是"记"
    seg.entries.forEach((x, j) => {
      const rv = ctx.reviewData[reviewDataName(x)];
      if (!rv) return;
      const cut = effectiveGoal(p, seg.first + j, gr, code) === "减脂";
      for (const key of ["weight", "cardioMinutes", "tired"]) {
        if (rv[key] !== undefined && !cut) err(`复盘/${reviewDataName(x)} ${key}`, `${key} 只给这一周按减脂的人（每周称一次体重、记有氧分钟、练完有没有没力气）`);
      }
      if (cut && rv.weight !== undefined && bodyStateOn(p, x.start) !== "记") err(`复盘/${reviewDataName(x)} weight`, "这一周不记体重腰围：复盘里不能有体重");
    });
  }
  // 周期末那一周：复盘的体重和周期末评估的体重合起来只算一次
  for (const seg of all.filter(stable)) {
    const last = seg.entries[seg.entries.length - 1];
    const rv = ctx.reviewData[reviewDataName(last)];
    const rec = ctx.assessments.find((a) => a.raw?.kind === "周期末" && a.raw.segment === seg.n && typeof a.raw.body?.weight === "number"
      && a.raw.date >= last.start && a.raw.date <= addDays(last.start, 6));
    if (rv?.weight !== undefined && rec) err(`复盘/${reviewDataName(last)} weight`, `这一周的体重已经记在 ${rec.name} 里：每周最多称一次，复盘不再记`);
  }
  // 改过记不记却没有 bodyLog：推不出以前哪天是记；选过减脂、增肌的一定要有（停记、改回记要查得出来）
  if (!(Array.isArray(p.bodyLog) && p.bodyLog.length)) {
    if (ss.some((s) => weekGoal(s) !== "保持")) err("档案.json bodyLog", "选了减脂、增肌：档案要有 bodyLog（建档那天的状态，以后每次改记不记都加一项），停记、改回记才查得出来");
    const usedBody = ctx.assessments.some((a) => a.raw?.body !== undefined) || Object.values(ctx.reviewData).some((r) => (r as Obj)?.weight !== undefined) || any;
    if (p.body === "记" && typeof p.bodyStopDate === "string") err("档案.json bodyLog", `body 是"记"、bodyStopDate（${p.bodyStopDate}）还在：停记以后又改回了记，要写 bodyLog（建档那天的状态、停记那天、改回记那天）`);
    else if ((p.body ?? "不记") === "不记" && usedBody) err("档案.json bodyLog", "档案现在是\"不记\"，以前记过体重腰围（评估、复盘里有）：改记不记要写 bodyLog（建档那天的状态，加上这一次改的日期），不然以前的记录都对不上");
  }
  // 评估记录：goal 只写在开稳定期周期的记录上
  for (const a of ctx.assessments) {
    if (a.raw?.goal === undefined) continue;
    if (!["入门", "段末", "周期末"].includes(a.raw.kind)) err(`${a.name} goal`, "goal 写在开周期的那份评估上：周期末、进稳定期的段末、直接进稳定期的入门");
  }
  return out;
}

/** 计划单上这一周目标的几行（保持的不写）。 */
export function goalSheetLines(ctx: AssessContext, index: number): string[] {
  const gr = goalRules(ctx.rules);
  const ss = (ctx.profile.segments ?? []) as SegmentEntry[];
  const e = ss[index];
  const info = e ? productInfo(ctx.manifest, e.product) : null;
  if (!gr || !e || !info) return [];
  const chosen = weekGoal(e);
  if (chosen === "保持") return [];
  const g = effectiveGoal(ctx.profile, index, gr, info.code);
  const lines = [`## 目标：${chosen}${g === "保持" ? "（第 2 轮起）" : ""}`, ""];
  if (g === "保持") {
    lines.push(`- 直接从稳定期开始的人：第 1 轮照起始期，${chosen}从第 2 轮起才做；这一周有氧、吃都照保持。`, "");
    return lines;
  }
  const doctorDiet = dietByDoctor(ctx.profile);
  const rv = (j: number) => ctx.reviewData[reviewDataName(ss[j])];
  const round = roundOf(e.week);
  const backThisRound = ss.slice(0, index).some((x, j) => x.n === e.n && roundOf(x.week) === round && (rv(j)?.symptoms === true || rv(j)?.tired === true));
  if (g === "减脂") {
    const c = cutCardio(ctx, index);
    if (c?.doctor) lines.push(`- 有氧：照保持的量。${c.doctor}。`);
    else if (c) lines.push(`- 有氧：这一周合计 **${c.minutes} 分钟**中等强度（第 ${c.step} / ${c.steps} 档；${c.why}）。训练里原有的有氧算进去，分在至少 ${goalParam(gr, "有氧每周最少天数", info.code) ?? 5} 天、每周留 1 天不做；做法照《稳定期说明》《目标》一节。断了 5 天以上，回来第一次只做一半。`);
    if (doctorDiet) lines.push("- 吃：照医生的意见（安全筛查第 3 项答了\"是\"）。");
    else if (backThisRound) lines.push("- 吃：这一轮有过不适或者练完没力气——这一轮剩下的时间吃回到保持（先把主食加回来）。");
    else {
      const b = bmrTwo(ctx, e.start);
      lines.push(`- 吃：每天比保持少约 ${goalParam(gr, "减脂每天少", info.code) ?? 300} kcal（肉少一份、油少一勺、主食少半个馒头；女性主食不减、肉再少半份），照《目标》一节。`);
      lines.push(b ? `- 不低于基础代谢：按身高 ${b.height} cm、体重 ${b.weight} kg、${b.age} 岁估，男约 ${b.male} kcal、女约 ${b.female} kcal，对自己那一栏；全天低于 ${goalParam(gr, "全天下限", info.code) ?? 1200} kcal 的先问医生或注册营养师。`
        : `- 不低于自己的基础代谢；全天低于 ${goalParam(gr, "全天下限", info.code) ?? 1200} kcal 的先问医生或注册营养师。`);
    }
    lines.push("- 这一周称一次体重（同一天、同一时间），记下有氧做了多少分钟、练完有没有没力气，周复盘一起记。");
  } else {
    if (doctorDiet) lines.push("- 吃：照医生的意见（安全筛查第 3 项答了\"是\"）。");
    else lines.push(`- 吃：每天比保持多约 ${goalParam(gr, "增肌每天多", info.code) ?? 200} kcal（主食多半个到一个馒头，不加鸡蛋），照《目标》一节。训练、有氧照保持。`);
  }
  lines.push("");
  return lines;
}

/** 计划单上和身体情况有关的几行（超重肥胖指向附册、跳跃、吃照专业方案）；都不沾的不写。 */
export function bodySheetLines(ctx: AssessContext, index: number): string[] {
  const ss = (ctx.profile.segments ?? []) as SegmentEntry[];
  const e = ss[index];
  const info = e ? productInfo(ctx.manifest, e.product) : null;
  if (!e || !info || !["a18", "a40"].includes(info.age)) return [];
  const gr = goalRules(ctx.rules);
  const out: string[] = [];
  const bmi = latestBmi(ctx, e.start);
  const over = (gr ? goalParam(gr, "超重 BMI", info.code) : undefined) ?? 24;
  const jumpBmi = (gr ? goalParam(gr, "不做跳跃的 BMI", info.code) : undefined) ?? over;
  const bmiItemYes = (ctx.profile.screening?.answers ?? []).some((a: Obj) => /BMI/.test(a?.item ?? "") && a?.answer === "是");
  const book = ctx.manifest.products.find((p) => (p as Obj).phase === "附册" && p.age === info.age);
  if ((bmi !== null && bmi >= over) || (bmi === null && bmiItemYes)) {
    out.push(`- 超重、肥胖：配合《${book?.name ?? "超重与肥胖（附册）"}》看——${info.age === "a18" ? "跳跃都不做（用低冲击版），" : ""}BMI 37.5 以上的间歇先问医生，肥胖的人选减脂要医生同意。`);
  }
  // 18–39 岁纯徒手版每一轮第 4 周的高冲击：只对记了体重、BMI 不到 24、这一周有氧真做间歇的写"可选"
  const cm = info.age === "a18" && info.venue === "bw" && (e.week - 1) % 4 === 3
    ? cardioMode(ctx.rules ?? null, ctx.profile, info, e.n, e.week, ctx.reviewData, { severe: severeObese(ctx, e.start, info.code) }) : null;
  if (cm?.mode === "间歇" && bmi !== null && bmi < jumpBmi) {
    out.push("- 这一周的有氧可以选高冲击（开合跳、原地高抬腿跑）：楼下没人、膝盖没有任何不适时（照成品）；默认低冲击。");
  }
  if (dietByProOn(ctx.profile, e.start)) out.push("- 吃：照医生、营养师给你的方案（这份计划的饮食部分不用）。");
  // 官方食养指南（成品末尾《附：官方食养指南》）：只指路，不改饮食（设计值 FOOD_GUIDE_APPENDIX）
  if (dietByDoctor(ctx.profile)) out.push("- 安全筛查第 3 项（糖尿病、肾病、痛风或高尿酸、高血脂）答了\"是\"：吃照医生的意见；官方的食养指南见成品末尾《附：官方食养指南》，哪一份对得上、怎么用，问医生或注册营养师。");
  if (ctx.profile.conditions?.["高血压"] === true) out.push("- 官方有《成人高血压食养指南》，见成品末尾《附：官方食养指南》；这份计划的饮食照常，拿不准问医生。");
  if (ctx.profile.conditions?.["骨质疏松"] === true) out.push("- 官方有《成人骨质疏松症食养指南》，见成品末尾《附：官方食养指南》；这份计划的饮食照常，拿不准问医生。");
  return out.length ? ["## 身体情况", "", ...out, ""] : [];
}

/** 导出提示里减脂的有氧一句。 */
export function goalCardioHint(ctx: AssessContext, index: number): string | null {
  const c = cutCardio(ctx, index);
  if (!c) return null;
  return c.doctor ? `减脂：有氧照保持的量（${c.doctor}）` : `减脂：这一周有氧合计 ${c.minutes} 分钟中等强度（第 ${c.step} / ${c.steps} 档），训练里的有氧算进去`;
}

