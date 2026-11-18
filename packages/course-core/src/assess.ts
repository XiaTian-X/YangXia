// 评估（v4 阶段 2–3）：入门、段末、周期末、触发四种评估记录 yangxia.assessment/1，年龄段和学段推算，中断和摔倒。
// 参数全部来自模板 rules.json 的 assess、nextRound、habits（content/rules/评估.md、下一轮.md、打卡.md），
// BMI 切点来自 manifest 的官方参数（BMI_CN、WEIGHT_LOW_CN）。结论由这里重算，评估记录里写的结论对不上就报错。
// 稳定期（阶段 3）：周期末结论照 rules.json 的 stable.nextCycle 重算；进稳定期的两条路、有氧稳态 / 间歇（cardio）也在这里。
import type { Manifest } from "./manifest.ts";
import { habitPassWeeks, type PlansData, ROUND_WEEKS, roundWeek, type RulesData, stableParam } from "./plan.ts";
import { fallRiskConclusion, fallRiskIssues, fallRiskRules, validateFallRisk, validateOfficial } from "./fallrisk.ts";
import { bodyStateOn, cycleGoals, goalRules, lastWeighed, validateGoalFields, validateGoalRecord } from "./goals.ts";
import { validateAddFields } from "./senior.ts";
import { gapBefore, localDate, longGapDays, reviewDataName, type SegmentEntry, type SessionFile, trainingDates } from "./progress.ts";
import type { Issue } from "./types.ts";

type Obj = Record<string, any>;
export const ASSESS_FORMAT = "yangxia.assessment/1";
export const KINDS = ["入门", "段末", "触发", "周期末"] as const;
export const REASONS = ["跨段", "满一年", "身体变化", "生病住院", "生病", "摔倒", "换场地", "中断", "看完医生回来", "回起始期", "跌倒自查到期"] as const;
const SWITCH_REASONS = ["跨段", "换场地"];
const TOP_KEYS = ["schema", "date", "kind", "product", "segment", "reasons", "base", "prereqs", "body", "tests", "companion", "doctorCleared", "doctorDate",
  "eventDate", "eventDates", "fallAssessDone", "weightDrop", "doctorRestart", "fallRisk", "fallRiskSeen", "official", "goal", "eatingCheck", "goalConsent", "conclusion", "note"];
const HANDS = ["不用手", "扶椅子", "手撑"];
const STOPS = ["头晕", "腿软", "身体晃"];
const BIKE = ["稳态分钟", "间歇轮数"];
const BODY_AGES = ["a18", "a40"];
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/;
const DAY = 86_400_000;
const dayStart = (d: string) => new Date(`${d}T00:00:00`).getTime();
const addDays = (d: string, n: number) => localDate(new Date(dayStart(d) + n * DAY + 12 * 3_600_000));
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

// ---------- 模板参数 ----------

export interface AssessRules {
  tests: { id: string; products: string[]; timing: string[]; fields: string[]; judge: string; note: string }[];
  prereqs: { id: string; products: string[]; ask: string; note: string }[];
  params: { name: string; products: string[]; value: string; number?: number; note: string }[];
  crossing: { name: string; value: string; number?: number; note: string }[];
}
export interface NextRule {
  products: string[];
  segments: string[];
  order: number | null;
  extra: boolean;
  when: Obj[];
  result: string;
  upward: boolean;
  next: string;
  targets: Obj[];
  quotes: { section: string; text: string }[];
  note: string;
}
export interface HabitRule { products: string[]; segments: string[]; habit: string; per: "week" | "segment"; days: number; weeks: number[] }

export function assessRules(rules: RulesData | null): { assess: AssessRules; next: NextRule[]; habits: HabitRule[] } | null {
  const r = rules as Obj | null;
  if (!r?.assess || !Array.isArray(r.nextRound) || !Array.isArray(r.habits)) return null;
  return { assess: r.assess, next: r.nextRound, habits: r.habits };
}

/** 成品名 → 家族代码（a18·bw，起始期和稳定期成品一样）、年龄段、场地、阶段。 */
export function productInfo(m: Manifest, name: string): { code: string; age: string; venue: string; phase: string } | null {
  const p = m.products.find((x) => x.name === name);
  return p ? { code: `${p.age}·${p.venue}`, age: p.age, venue: p.venue, phase: (p as Obj).phase ?? "起始" } : null;
}
const phaseOf = (s: { phase?: string }) => s.phase ?? "起始";

export function param(a: AssessRules, name: string, code: string): { value: string; number?: number } | undefined {
  return a.params.find((x) => x.name === name && x.products.includes(code));
}
const crossNum = (a: AssessRules, name: string) => a.crossing.find((x) => x.name === name)?.number;
const crossText = (a: AssessRules, name: string) => a.crossing.find((x) => x.name === name)?.value ?? "";

// ---------- 年龄段、学段 ----------

const STAGE_AGE: Record<string, string> = { 小学: "a06", 初中: "a13", 高中: "a13", "18–39 岁": "a18", "40–64 岁": "a40", "65 岁以上": "a65" };
const SCHOOL = ["小学", "初中", "高中"];

function monthsBetween(birth: string, date: string): number | null {
  const b = MONTH.exec(birth ?? "");
  if (!b || !DATE.test(date)) return null;
  const [y, m] = date.split("-").map(Number);
  return (y * 12 + m) - (Number(b[1]) * 12 + Number(b[2]));
}

/**
 * 某一天的年龄段和学段：在校的按学段和入学年份（9 月 1 日升学，六三制或五四制），高中毕业而且满 18 岁才算成人；
 * 不在校的按出生年月（按出生月份的 1 日算）。缺资料返回 problem。
 */
export function ageAt(profile: Obj, date: string, a: AssessRules): { age: string | null; stage: string | null; problem?: string } {
  const adultAt = (months: number) => {
    const y = Math.floor(months / 12);
    const to40 = crossNum(a, "换 40–64 岁版") ?? 40;
    const to65 = crossNum(a, "换 65 岁以上版") ?? 65;
    if (y >= to65) return { age: "a65", stage: "65 岁以上" };
    if (y >= to40) return { age: "a40", stage: "40–64 岁" };
    return { age: "a18", stage: "18–39 岁" };
  };
  const adultYear = crossNum(a, "换成人版") ?? 18;
  const sc = profile.school;
  if (isObj(sc)) {
    const sys = sc.system === "54" ? "五四制" : "六三制";
    const lens = Object.fromEntries(crossText(a, sys).split("、").map((x) => {
      const m = /^(\S+) (\d+)$/.exec(x.trim());
      return m ? [m[1], Number(m[2])] : ["", 0];
    }));
    const [y, mo] = date.split("-").map(Number);
    const sep = crossText(a, "升学日期") || "09-01";
    const [sm, sd] = sep.split("-").map(Number);
    const dd = Number(date.slice(8, 10));
    const schoolYear = mo > sm || (mo === sm && dd >= sd) ? y : y - 1;
    let k = SCHOOL.indexOf(sc.stage);
    let left = schoolYear - Number(sc.entry);
    if (k < 0 || !Number.isInteger(sc.entry)) return { age: null, stage: null, problem: "school 要写 { stage: 小学 / 初中 / 高中, entry: 入学年份, system: 63 / 54 }" };
    // 入学之前的日期（升学后改了 school，以前几段的开始日）：按前一个学段算
    if (left < 0) {
      if (k === 0) return { age: STAGE_AGE[SCHOOL[0]], stage: SCHOOL[0] };
      return { age: STAGE_AGE[SCHOOL[k - 1]], stage: SCHOOL[k - 1] };
    }
    while (k < SCHOOL.length && left >= (lens[SCHOOL[k]] ?? 99)) {
      left -= lens[SCHOOL[k]];
      k++;
    }
    if (k < SCHOOL.length) return { age: STAGE_AGE[SCHOOL[k]], stage: SCHOOL[k] };
    // 高中毕业：满 18 岁才换成人版（GRAD_18），之前按高中
    const months = monthsBetween(profile.birth, date);
    if (months === null) return { age: null, stage: null, problem: "高中已经毕业：补记出生年月 birth（YYYY-MM），满 18 岁才换成人版" };
    if (Math.floor(months / 12) < adultYear) return { age: "a13", stage: "高中" };
    return adultAt(months);
  }
  const months = monthsBetween(profile.birth, date);
  if (months === null) return { age: null, stage: null, problem: "缺出生年月 birth（YYYY-MM）或学段 school：跨段、满 65 岁都靠它推算" };
  const y = Math.floor(months / 12);
  if (y < 13) return { age: null, stage: null, problem: "不满 13 岁的孩子记学段 school（小学按学段，不按年龄）" };
  if (y < adultYear) {
    // 不在校的 13–17 岁按同龄人的学段（SCHOOL_BY_AGE）
    const m = /初中 (\d+)–(\d+)/.exec(crossText(a, "不在校按年龄"));
    return { age: "a13", stage: m && y <= Number(m[2]) ? "初中" : "高中" };
  }
  return adultAt(months);
}

// ---------- 档案里评估用到的字段 ----------

/** birth、school、screening.date / doctorDate、body、habitBase、段的 habitTargets 的写法。 */
export function validateAssessFields(p: Obj): Issue[] {
  const out: Issue[] = [];
  const err = (path: string, message: string) => out.push({ level: "error", path, message });
  const minor = p.age === "a06" || p.age === "a13";
  if (p.birth !== undefined && !MONTH.test(p.birth)) err("birth", "birth 只记到月：YYYY-MM");
  if (p.school !== undefined) {
    const s = p.school;
    if (!isObj(s) || !SCHOOL.includes(s.stage) || !Number.isInteger(s.entry) || s.entry < 2000 || s.entry > 2100 || (s.system !== undefined && s.system !== "63" && s.system !== "54")) {
      err("school", "school 是 { stage: 小学 / 初中 / 高中, entry: 入学年份, system: \"63\" / \"54\"（默认 63） }");
    }
  }
  if (!minor && p.birth === undefined) err("birth", "成年人要记出生年月 birth（YYYY-MM，只到月）：满 40 岁、满 65 岁换版靠它推算");
  if (minor && p.school === undefined && p.birth === undefined) err("school", "未成年人记学段 school（不在校的记出生年月 birth）：升学换版靠它推算");
  const sc = p.screening;
  if (isObj(sc)) {
    if (typeof sc.date !== "string" || !DATE.test(sc.date)) err("screening.date", "安全筛查要记日期 date（YYYY-MM-DD）：满一年要重做");
    if (sc.doctorCleared === true && (typeof sc.doctorDate !== "string" || !DATE.test(sc.doctorDate))) err("screening.doctorDate", "医生同意要记日期 doctorDate（YYYY-MM-DD）：重做筛查、摔倒以后要重新确认");
    if (sc.doctorDate !== undefined && !(typeof sc.doctorDate === "string" && DATE.test(sc.doctorDate))) err("screening.doctorDate", "doctorDate 写成 YYYY-MM-DD");
  }
  if (p.body !== undefined) {
    if (!["记", "不记", "停记"].includes(p.body)) err("body", "body 只能是 记 / 不记 / 停记");
    else if (p.body === "停记" && !(typeof p.bodyStopDate === "string" && DATE.test(p.bodyStopDate))) err("bodyStopDate", "停记要写从哪天起 bodyStopDate（YYYY-MM-DD）：以前记的保留，之后不再记");
    else if (p.body === "记" && !BODY_AGES.includes(p.age)) err("body", "体重、腰围只给 18–64 岁记（6–17 岁、65 岁以上不记）");
  }
  if (p.focus !== undefined) {
    const AREAS = ["作息", "饮食", "训练"];
    if (!isObj(p.focus) || !Array.isArray(p.focus.areas) || !p.focus.areas.length || p.focus.areas.some((x: unknown) => !AREAS.includes(x as string))) {
      err("focus", "focus 是 { areas: [作息 / 饮食 / 训练] }：有基础的人想先从哪方面入手");
    } else if (!BODY_AGES.includes(p.age)) err("focus", "focus 只给 18–64 岁记");
  }
  if (p.habitBase !== undefined && !(isObj(p.habitBase) && Object.values(p.habitBase).every((v) => Number.isInteger(v) && (v as number) > 0))) {
    err("habitBase", "habitBase 是 {打卡项: 分钟}，如 { \"散步\": 20 }");
  } else if (p.age === "a65" && !Number.isInteger(p.habitBase?.["散步"])) {
    err("habitBase", "65 岁以上要记建档时定的散步时长 habitBase（如 { \"散步\": 20 }）：\"散步减 5 分钟\"按它算");
  }
  (Array.isArray(p.segments) ? p.segments : []).forEach((s: Obj, i: number) => {
    const firstOfSeg = i === 0 || p.segments[i - 1]?.n !== s?.n;
    if (!firstOfSeg && (s?.habitTargets !== undefined || s?.restart !== undefined)) err(`segments[${i}]`, "habitTargets、restart 只写在一段的第一项（新开一段那一周）");
    if (s?.habitTargets !== undefined && !(isObj(s.habitTargets) && Object.values(s.habitTargets).every((t) => isObj(t)
      && Object.keys(t).every((k) => ["days", "minutes", "line"].includes(k) && Number.isInteger(t[k]) && t[k] > 0)))) {
      err(`segments[${i}].habitTargets`, "habitTargets 是 {打卡项: {days} / {minutes} / {line}}，只写上一段段末结论给的降法");
    }
    if (s?.restart !== undefined && !(typeof s.restart === "string" && /^评估\/.+\.json$/.test(s.restart))) {
      err(`segments[${i}].restart`, "restart 写依据的触发评估：评估/<日期>-触发.json");
    }
  });
  out.push(...validateGoalFields(p));
  out.push(...validateAddFields(p));
  return out;
}

/** 评估记录的写法（不看档案）。 */
export function validateAssessment(raw: unknown): Issue[] {
  const out: Issue[] = [];
  const err = (path: string, message: string) => out.push({ level: "error", path, message });
  if (!isObj(raw)) return [{ level: "error", path: "", message: "评估记录要是 JSON 对象" }];
  if (raw.schema !== ASSESS_FORMAT) err("schema", `格式标识要写 "${ASSESS_FORMAT}"`);
  const extra = Object.keys(raw).filter((k) => !TOP_KEYS.includes(k));
  if (extra.length) err("", `评估记录只能有这些字段：${TOP_KEYS.join("、")}；多了 ${extra.join("、")}（身体数据只能写在 body 里，6–17 岁、65 岁以上不记）`);
  if (typeof raw.date !== "string" || !DATE.test(raw.date)) err("date", "date 是评估的日期 YYYY-MM-DD");
  if (!(KINDS as readonly string[]).includes(raw.kind)) err("kind", `kind 只能是 ${KINDS.join(" / ")}`);
  if (raw.product !== undefined && typeof raw.product !== "string") err("product", "product 是成品名");
  if ((raw.kind === "段末" || raw.kind === "周期末") && !Number.isInteger(raw.segment)) err("segment", `${raw.kind}评估要写是第几段（segment）`);
  if (raw.kind === "触发") {
    if (!Array.isArray(raw.reasons) || !raw.reasons.length || raw.reasons.some((x: unknown) => !(REASONS as readonly string[]).includes(x as string))) {
      err("reasons", `触发评估写原因 reasons：${REASONS.join("、")}`);
    } else if (raw.reasons.some((x: string) => x === "摔倒" || x === "生病住院") && !(typeof raw.eventDate === "string" && DATE.test(raw.eventDate))) {
      err("eventDate", "摔倒、生病住院的触发评估要写那天的日期 eventDate（医生同意要在它之后）");
    }
  }
  // 一份"摔倒"触发评估记一周里的好几次摔倒：eventDates 是每次的日期，eventDate 写最近那次
  if (raw.eventDates !== undefined) {
    const ds = raw.eventDates;
    if (!(Array.isArray(raw.reasons) && raw.reasons.includes("摔倒"))) err("eventDates", "eventDates 只给\"摔倒\"的触发评估（一次记了好几次摔倒）");
    else if (!Array.isArray(ds) || !ds.length || ds.some((d: unknown) => typeof d !== "string" || !DATE.test(d)) || new Set(ds).size !== ds.length) {
      err("eventDates", "eventDates 是每次摔倒的日期 [YYYY-MM-DD, …]，不重复（同一天摔了两次的，写两份触发评估）");
    } else if (ds.slice().sort().pop() !== raw.eventDate) err("eventDates", "eventDates 要包含 eventDate，而且 eventDate 是最近的那一次（医生同意、问卷都要在它之后）");
    else if (typeof raw.date === "string" && ds.some((d: string) => d > raw.date)) err("eventDates", "摔倒的日期不能晚于这份评估的日期");
  }
  if (raw.base !== undefined && ![0, 1, 2].includes(raw.base)) err("base", "base 是最近 3 个月平均每周几天力量练习：0、1、2（2 及以上）");
  if (raw.prereqs !== undefined && !(isObj(raw.prereqs) && Object.values(raw.prereqs).every((v) => typeof v === "boolean"))) err("prereqs", "prereqs 是 {checkup, bpOk}，只记是 / 否");
  if (raw.body !== undefined) {
    const b = raw.body;
    const ok = (v: unknown, lo: number, hi: number) => v === undefined || (typeof v === "number" && v >= lo && v <= hi);
    if (!isObj(b) || !ok(b.height, 100, 230) || !ok(b.weight, 25, 300) || !ok(b.waist, 40, 200) || Object.keys(b).some((k) => !["height", "weight", "waist"].includes(k))) {
      err("body", "body 是 {height 厘米, weight 公斤, waist 厘米}");
    }
  }
  if (raw.tests !== undefined) {
    if (!Array.isArray(raw.tests)) err("tests", "tests 是数组");
    else raw.tests.forEach((t: Obj, i: number) => {
      if (!isObj(t) || typeof t.id !== "string") return err(`tests[${i}]`, "每项要有 id");
      if (t.value !== undefined && !(typeof t.value === "number" && t.value >= 0)) err(`tests[${i}].value`, "value 是非负数");
      if (t.level !== undefined && !(Number.isInteger(t.level) && t.level >= 1)) err(`tests[${i}].level`, "level 是第几级");
      if (t.hands !== undefined && !HANDS.includes(t.hands)) err(`tests[${i}].hands`, `hands 只能是 ${HANDS.join(" / ")}`);
      if (t.stopReason !== undefined && !STOPS.includes(t.stopReason)) err(`tests[${i}].stopReason`, `stopReason 只能是 ${STOPS.join(" / ")}`);
      if (t.mode !== undefined && !BIKE.includes(t.mode)) err(`tests[${i}].mode`, `mode 只能是 ${BIKE.join(" / ")}`);
      if (t.done !== undefined && typeof t.done !== "boolean") err(`tests[${i}].done`, "done 是 true / false");
      if (t.depth !== undefined && (typeof t.depth !== "string" || t.depth.length > 30)) err(`tests[${i}].depth`, "depth 是蹲的深度（文字，最多 30 字）");
    });
  }
  for (const k of ["companion", "doctorCleared", "fallAssessDone", "doctorRestart", "fallRiskSeen"]) if (raw[k] !== undefined && typeof raw[k] !== "boolean") err(k, `${k} 是 true / false`);
  if (raw.fallRisk !== undefined) out.push(...validateFallRisk(raw.fallRisk));
  if (raw.official !== undefined) out.push(...validateOfficial(raw.official));
  if (raw.doctorDate !== undefined && !(typeof raw.doctorDate === "string" && DATE.test(raw.doctorDate))) err("doctorDate", "doctorDate 写成 YYYY-MM-DD");
  if (raw.eventDate !== undefined && !(typeof raw.eventDate === "string" && DATE.test(raw.eventDate))) err("eventDate", "eventDate 写成 YYYY-MM-DD");
  if (raw.conclusion !== undefined && !isObj(raw.conclusion)) err("conclusion", "conclusion 是对象（照 course assess 的输出写）");
  if (raw.note !== undefined && (typeof raw.note !== "string" || raw.note.length > 500)) err("note", "note 最多 500 字");
  out.push(...validateGoalRecord(raw));
  return out;
}

// ---------- 结论 ----------

/** BMI 切点：manifest 官方参数 WEIGHT_LOW_CN（低体重）、BMI_CN（超重、肥胖）。 */
export function bmiCuts(m: Manifest): { low: number; over: number; obese: number } | null {
  const params = ((m as Obj).params ?? []) as Obj[];
  const low = /BMI\s*<\s*([\d.]+)/.exec(params.find((x) => x.id === "WEIGHT_LOW_CN")?.value ?? "");
  const cn = /([\d.]+)\s*[–-]\s*[\d.]+\s*为超重[，,]\s*([\d.]+)\s*及以上为肥胖/.exec(params.find((x) => x.id === "BMI_CN")?.value ?? "");
  return low && cn ? { low: Number(low[1]), over: Number(cn[1]), obese: Number(cn[2]) } : null;
}

export function bmiOf(body: Obj | undefined, height?: number): number | null {
  const h = body?.height ?? height;
  if (!(typeof body?.weight === "number" && typeof h === "number")) return null;
  return Math.round((body.weight / ((h / 100) ** 2)) * 10) / 10;
}

export function bmiClass(bmi: number, cuts: { low: number; over: number; obese: number }): string {
  return bmi < cuts.low ? "低体重" : bmi < cuts.over ? "正常" : bmi < cuts.obese ? "超重" : "肥胖";
}

export interface SegmentNumbers {
  trainings: number;
  weeks: number[];
  falls: number;
  sick: number;
  sickInWeeks: number;
  symptoms: boolean;
  habits: Record<string, { week: number; days: number }[]>;
  missing: string[];
}

/** 一段的数字（SEGMENT_COUNT）：每个周次只取最后一份复盘，每周训练数不超过排的次数；生病超过 7 天、摔倒、头晕按整段加起来。 */
export function segmentNumbers(profile: Obj, n: number, reviewData: Record<string, Obj>, a: AssessRules, code: string, extra?: { dizzy?: number }, habitRules?: HabitRule[]): SegmentNumbers {
  const ss = (profile.segments as SegmentEntry[]).filter((s) => s.n === n);
  const type = ss[0]?.type ?? "标准";
  const cap = param(a, type === "减量" ? "减量段每周排的训练" : "每周排的训练", code)?.number ?? Infinity;
  const lastOf = new Map<number, SegmentEntry>();
  for (const s of ss) lastOf.set(s.week, s);
  const out: SegmentNumbers = { trainings: 0, weeks: [], falls: extra?.dizzy ?? 0, sick: 0, sickInWeeks: 0, symptoms: false, habits: {}, missing: [] };
  for (const s of ss) {
    const rv = reviewData[reviewDataName(s)];
    if (!rv) continue;
    out.falls += (rv.falls ?? 0) + (rv.nearFalls ?? 0) + (rv.dizzy ?? 0);
    out.sick += rv.sickDays ?? 0;
    if (rv.symptoms === true) out.symptoms = true;
  }
  const age = code.split("·")[0];
  const need = age === "a65" ? ["falls", "nearFalls", "dizzy"] : age === "a06" ? ["sickDays"] : [];
  const habitNames = (habitRules ?? []).filter((h) => h.segments.includes(type));
  for (let w = 1; w <= 4; w++) {
    const s = lastOf.get(w);
    const rv = s ? reviewData[reviewDataName(s)] : undefined;
    if (!rv) { out.missing.push(`第 ${w} 周的复盘数据`); continue; }
    const lack = [...need.filter((k) => !Number.isInteger(rv[k])), ...habitNames.filter((h) => h.weeks.includes(w) && !Number.isInteger(rv.habits?.[h.habit])).map((h) => `habits.${h.habit}`)];
    if (lack.length) out.missing.push(`第 ${w} 周复盘数据的 ${lack.join("、")}`);
    out.weeks.push(w);
    out.trainings += Math.min(rv.trainings ?? 0, cap);
    out.sickInWeeks += rv.sickDays ?? 0;
    for (const [h, d] of Object.entries((rv.habits ?? {}) as Record<string, number>)) (out.habits[h] ??= []).push({ week: w, days: d });
  }
  return out;
}

const lineFor = (base: number, sick: number) => Math.ceil((base * (28 - sick)) / 28);

export interface EndConclusion {
  result: string;
  next: string;
  upward: boolean;
  downgraded: boolean;
  extras: string[];
  habitTargets: Record<string, Obj>;
  numbers: SegmentNumbers;
  quotes: string[];
}

/**
 * 段末结论：照 nextRound 从上往下取第一条符合的；这一段有不适，往上的结论降为"原样"（SYMPTOM_CARRY）；
 * 附加行符合就同时生效。下一段的习惯目标：先按 HABIT_RESTORE 恢复做到了的，再按附加行降没达标的。
 */
export function segmentEnd(profile: Obj, n: number, reviewData: Record<string, Obj>, rules: NonNullable<ReturnType<typeof assessRules>>, code: string, extra?: { dizzy?: number; afterDoctor?: boolean }): EndConclusion | { error: string } {
  const ss = (profile.segments as SegmentEntry[]).filter((s) => s.n === n);
  if (!ss.length) return { error: `没有第 ${n} 段` };
  const type = ss[0].type;
  const habitRules = rules.habits.filter((h) => h.products.includes(code) && h.segments.includes(type));
  const nums = segmentNumbers(profile, n, reviewData, rules.assess, code, extra, habitRules);
  if (nums.missing.length) return { error: `第 ${n} 段缺 ${nums.missing.join("；")}：段末算不出来，先补问再写进复盘数据` };
  const cur: Record<string, Obj> = (ss[0] as Obj).habitTargets ?? {};
  const sick = nums.sickInWeeks;
  const lineOf = (h: string) => lineFor(cur[h]?.line ?? habitRules.find((x) => x.habit === h)?.days ?? 20, sick);
  const total = (h: string) => (nums.habits[h] ?? []).reduce((s, x) => s + x.days, 0);
  const weekMissed = (h: string) => {
    const r = habitRules.find((x) => x.habit === h);
    if (!r) return false;
    const need = cur[h]?.days ?? r.days;
    return r.weeks.some((w) => {
      const got = (nums.habits[h] ?? []).find((x) => x.week === w);
      return !got || got.days < need;
    });
  };
  const test = (c: Obj): boolean => {
    switch (c.kind) {
      case "trainings": return nums.trainings >= c.min && (c.max === null || nums.trainings <= c.max);
      case "fallsOrDizzy": return nums.falls > 0;
      case "sickOver": return nums.sick > c.value;
      case "habitWeekMiss": return (c.habits as string[]).some(weekMissed);
      case "allAtLine": return habitRules.every((h) => total(h.habit) >= lineOf(h.habit));
      case "anyBelowLine": return habitRules.some((h) => total(h.habit) < lineOf(h.habit));
      case "habitAboveLine": return total(c.habit) >= lineOf(c.habit) + c.plus;
      default: return false;
    }
  };
  const mine = rules.next.filter((r) => r.products.includes(code) && r.segments.includes(type));
  // 65 岁以上"先看医生"、医生同意以后：跳过那一条照后面几条走，往上的同样降级（细化方案第十三节第 1 条）
  const ordered = mine.filter((r) => !r.extra && !(extra?.afterDoctor && r.result === "先看医生")).sort((x, y) => (x.order ?? 0) - (y.order ?? 0));
  let hit = ordered.find((r) => r.when.every(test));
  if (!hit) return { error: `第 ${n} 段的数字（训练 ${nums.trainings}）对不上下一轮.md 的任何一条` };
  let downgraded = false;
  if (hit.upward && (nums.symptoms || extra?.afterDoctor)) {
    // 标准段降为"原样"；减量段再来一段减量段（"回标准段"也算往上，第十三节第 4 条）
    const down = type === "减量" ? "减量" : "原样";
    const same = ordered.find((r) => r.result === down && !r.upward);
    if (!same) return { error: `第 ${n} 段往上的结论要降为"${down}"，但下一轮.md 里这份成品${type}段没有不往上的"${down}"那一条` };
    hit = same;
    downgraded = true;
  }
  const extras = mine.filter((r) => r.extra && r.when.every(test));
  // 这一轮不评（6–12 岁生病超过 7 天）：习惯目标保持原样，不恢复也不再降
  if (hit.result === "不评重来") {
    return { result: hit.result, next: hit.next, upward: false, downgraded, extras: [], habitTargets: { ...cur }, numbers: nums, quotes: hit.quotes.map((q) => q.text) };
  }
  // 习惯目标：恢复做到了的（HABIT_RESTORE），再降这一次没达标的
  const targets: Record<string, Obj> = {};
  const base: Record<string, number> = profile.habitBase ?? {};
  for (const [h, t] of Object.entries(cur)) {
    const r = habitRules.find((x) => x.habit === h);
    const met = r ? (r.per === "segment" ? total(h) >= lineOf(h) : !weekMissed(h)) : true;
    if (!met) { targets[h] = { ...t }; continue; }
    if (t.minutes !== undefined && base[h] !== undefined) {
      const step = extrasStep(rules.next, code, h) ?? 5;
      if (t.minutes + step < base[h]) targets[h] = { minutes: t.minutes + step };
    }
  }
  const lowered = (h: string) => (r: NextRule) => r.when.some((c) => c.kind === "habitWeekMiss" ? (c.habits as string[]).includes(h) && weekMissed(h) : c.kind === "anyBelowLine" ? total(h) < lineOf(h) : false);
  for (const r of extras.concat(hit.result === "降那一项" ? [hit] : [])) {
    for (const h of habitRules.map((x) => x.habit).filter((h) => lowered(h)(r))) {
      for (const t of r.targets) {
        if (t.kind === "weekDays" && !t.habit) targets[h] = { days: t.days };
        else if (t.kind === "line") targets[h] = { line: t.days };
        else if (t.kind === "minutesDown" && t.habit === h) {
          const now = targets[h]?.minutes ?? cur[h]?.minutes ?? base[h];
          if (now === undefined) return { error: `"${h}减 ${t.step} 分钟"要有建档时定的时长：档案 habitBase 里记上 ${h} 的分钟数` };
          targets[h] = { minutes: Math.max(t.min, now - t.step) };
        } else if (t.kind === "minutes" && t.habit === h) targets[h] = { minutes: t.value };
      }
    }
  }
  return {
    result: hit.result, next: hit.next, upward: hit.upward && !downgraded, downgraded, extras: extras.map((r) => r.result),
    habitTargets: targets, numbers: nums, quotes: [...hit.quotes, ...extras.flatMap((r) => r.quotes)].map((q) => q.text),
  };
}

function extrasStep(next: NextRule[], code: string, habit: string): number | undefined {
  for (const r of next) if (r.products.includes(code)) for (const t of r.targets) if (t.kind === "minutesDown" && t.habit === habit) return t.step;
  return undefined;
}

// ---------- 整个档案目录的评估核对 ----------

export interface AssessFile { name: string; raw: Obj }
export interface AssessContext {
  profile: Obj;
  manifest: Manifest;
  plans: PlansData | null;
  rules: RulesData | null;
  sessions: SessionFile[];
  reviewData: Record<string, Obj>;
  assessments: AssessFile[];
  now?: Date;
}

const sameJson = (x: unknown, y: unknown) => JSON.stringify(sortKeys(x ?? {})) === JSON.stringify(sortKeys(y ?? {}));
function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (isObj(v)) return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])]));
  return v;
}

const screeningItem = (profile: Obj, re: RegExp) => (profile.screening?.answers ?? []).find((x: Obj) => re.test(x?.item ?? ""));
/** 人在某一天的年龄段（按出生年月 / 学段推算；推不出来的按档案的 age）。 */
const personAge = (ctx: AssessContext, date: string) => {
  const ar = assessRules(ctx.rules);
  return (ar ? ageAt(ctx.profile, date, ar.assess).age : null) ?? ctx.profile.age;
};
const hasReason = (a: AssessFile, r: string) => a.raw?.kind === "触发" && Array.isArray(a.raw.reasons) && a.raw.reasons.includes(r);
const isSwitch = (a: AssessFile) => a.raw?.kind === "触发" && Array.isArray(a.raw.reasons) && a.raw.reasons.some((x: string) => SWITCH_REASONS.includes(x)) && typeof a.raw.product === "string";
const segCode = (m: Manifest, name: string) => productInfo(m, name)?.code ?? "";

/**
 * 摔倒，一次一项（日期可以重复）："摔倒"触发评估记的每个日期各算一次（eventDates，没有就用 eventDate）；65 岁以上版周复盘里有 falls 的那一周，
 * 这一周的次数取复盘 falls 和这一周触发评估个数里大的那个——同一次摔倒复盘记了、触发评估也记了，只算一次；
 * 复盘比触发评估多出来的那几次按这一周的最后一天算。
 */
function fallDates(ctx: AssessContext): string[] {
  const ss = (ctx.profile.segments ?? []) as SegmentEntry[];
  // "摔倒"触发评估：记了 eventDates 的每个日期各算一次，没有的用 eventDate，都没写的按评估那天算（写法错误另外报）
  const trig = ctx.assessments.filter((a) => hasReason(a, "摔倒") && typeof a.raw.date === "string")
    .flatMap((a) => (Array.isArray(a.raw.eventDates) && a.raw.eventDates.length && a.raw.eventDates.every((d: unknown) => typeof d === "string")
      ? a.raw.eventDates : [typeof a.raw.eventDate === "string" ? a.raw.eventDate : a.raw.date]) as string[]);
  const out = [...trig];
  for (const s of ss) {
    const falls = ctx.reviewData[reviewDataName(s)]?.falls ?? 0;
    if (productInfo(ctx.manifest, s.product)?.age !== "a65" || !(falls > 0)) continue;
    const end = addDays(s.start, 6);
    const inWeek = trig.filter((d) => d >= s.start && d <= end).length;
    for (let i = inWeek; i < falls; i++) out.push(end);
  }
  return out.sort();
}

export interface DoctorEvent { date: string; reason: string }
/**
 * 要医生同意的事（带日期）：65 岁以上（筛查那天）、筛查有"是"（筛查那天）、40–64 岁开工前提没过（那次评估）、
 * 65 岁以上摔倒、生病住院（那天）、段末"先看医生"（那次评估）、换到 65 岁以上版（换段的触发评估）。
 */
export function doctorEvents(ctx: AssessContext): DoctorEvent[] {
  const p = ctx.profile;
  const sc = p.screening ?? {};
  const ss = (p.segments ?? []) as SegmentEntry[];
  const cur = ss.length ? productInfo(ctx.manifest, ss[ss.length - 1].product) : null;
  // 65 岁以上按人的年龄（满 65 岁当月起），不只看成品年龄段（阶段 3c 第五节）
  const today = localDate(ctx.now ?? new Date());
  const age = personAge(ctx, today) === "a65" ? "a65" : cur?.age ?? p.age;
  const ev: DoctorEvent[] = [];
  const sd = typeof sc.date === "string" ? sc.date : "";
  if (age === "a65") ev.push({ date: sd, reason: "65 岁以上开始前都要先问医生" });
  if ((sc.answers ?? []).some((a: Obj) => a?.answer === "是")) ev.push({ date: sd, reason: "安全筛查有\"是\"" });
  for (const a of ctx.assessments) {
    if (a.raw?.prereqs && Object.values(a.raw.prereqs).some((v) => v === false)) ev.push({ date: a.raw.date, reason: "40–64 岁的体检或血压还没确认" });
    if (hasReason(a, "生病住院") && typeof a.raw.eventDate === "string") ev.push({ date: a.raw.eventDate, reason: "生病、住院过" });
    if (a.raw?.kind === "段末" && a.raw.conclusion?.next === "不开") ev.push({ date: a.raw.date, reason: "段末结论是\"先看医生\"" });
  }
  if (age === "a65") for (const d of fallDates(ctx)) ev.push({ date: d, reason: "摔倒过" });
  // 跌倒风险自查：一年内的每一份，跌倒过、高风险的都要先问医生（医生同意不早于那份问卷）
  for (const fr of fallRiskList(ctx)) {
    if (fr.conclusion.doctorFirst && fr.askedOn <= today && (dayStart(today) - dayStart(fr.askedOn)) / DAY <= 365) ev.push({ date: fr.askedOn, reason: FALL_REASON });
  }
  return ev.filter((e) => e.date).sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : 0));
}

const FALL_REASON = "跌倒风险自查要先问医生";

export interface FallRiskEntry { file: AssessFile; askedOn: string; conclusion: ReturnType<typeof fallRiskConclusion> }
/** 所有跌倒风险自查（按 askedOn 从早到晚）和各自重算的结论；头晕用问卷里记的（问卷那天的筛查）。 */
export function fallRiskList(ctx: AssessContext): FallRiskEntry[] {
  const rr = fallRiskRules(ctx.rules);
  if (!rr) return [];
  return ctx.assessments.filter((a) => isObj(a.raw?.fallRisk) && typeof a.raw.fallRisk.askedOn === "string" && isObj(a.raw.fallRisk.general))
    .sort((x, y) => (x.raw.fallRisk.askedOn < y.raw.fallRisk.askedOn ? -1 : x.raw.fallRisk.askedOn > y.raw.fallRisk.askedOn ? 1 : 0))
    .map((f) => ({ file: f, askedOn: f.raw.fallRisk.askedOn, conclusion: fallRiskConclusion(f.raw.fallRisk, rr, { official: isObj(f.raw.official) ? f.raw.official : undefined }) }));
}
/** 最近一份跌倒风险自查（按 askedOn）。 */
export const latestFallRisk = (ctx: AssessContext): FallRiskEntry | null => fallRiskList(ctx).pop() ?? null;

/**
 * 现在需不需要医生同意、同意了没有。有效的医生同意 = doctorCleared 而且 doctorDate 不早于最近一件要医生同意的事。
 * stale：记了同意，但日期早于那件事（重做筛查、摔倒以后没重新问医生）。
 */
export function doctorNeed(ctx: AssessContext): { needed: boolean; ok: boolean; stale: boolean; after: string; reason: string } {
  const sc = ctx.profile.screening ?? {};
  const ev = doctorEvents(ctx);
  if (!ev.length) return { needed: false, ok: true, stale: false, after: "", reason: "" };
  const { date: after, reason } = ev[ev.length - 1];
  const cleared = sc.doctorCleared === true && typeof sc.doctorDate === "string";
  const ok = cleared && sc.doctorDate >= after;
  return { needed: true, ok, stale: cleared && !ok, after, reason };
}

/** 一份评估记录按档案和规则核对：测试项属于成品和时机、身体数据只给 18–64 岁且选了"记"、65 岁以上有人在旁边和医生同意、高血压的静蹲上限、开工前提、结论。 */
export function checkRecord(ctx: AssessContext, f: AssessFile, product: string, asEntry: boolean): Issue[] {
  const out: Issue[] = [];
  const err = (path: string, message: string) => out.push({ level: "error", path: `${f.name}${path ? " " + path : ""}`, message });
  const ar = assessRules(ctx.rules);
  const info = productInfo(ctx.manifest, product);
  if (!ar || !info) return out;
  const r = f.raw;
  // 周期末测的和段末一样（同一批测试项）
  const timing = asEntry ? "入门" : r.kind === "段末" || r.kind === "周期末" ? "段末" : null;
  const tests = (r.tests ?? []) as Obj[];
  for (const [i, t] of tests.entries()) {
    const def = ar.assess.tests.find((x) => x.id === t.id && x.products.includes(info.code));
    if (!def) { err(`tests[${i}]`, `测试项「${t.id}」不属于${product}（模板 评估.md 的测试项表）`); continue; }
    if (!timing || !def.timing.includes(timing)) { err(`tests[${i}]`, `「${t.id}」只在${def.timing.join("、")}评估里记`); continue; }
    const extraKeys = Object.keys(t).filter((k) => k !== "id" && !def.fields.includes(k));
    if (extraKeys.length) err(`tests[${i}]`, `「${t.id}」只记 ${def.fields.join("、")}，多了 ${extraKeys.join("、")}`);
    // 俯卧撑测试的级要是这份成品俯卧撑阶梯里有的级（直接进稳定期的门槛按它算，不能随手写一个大数）
    const pushLadder = t.id === "pushup-test" ? ctx.plans?.products[product]?.ladders.pushup : undefined;
    if (pushLadder && t.level !== undefined && !pushLadder.some((l) => l.level === t.level)) {
      err(`tests[${i}].level`, `俯卧撑的难度级只有第 ${pushLadder.map((l) => l.level).join("、")} 级（${pushLadder.map((l) => `${l.level} ${l.name}`).join("，")}），记的是 ${t.level}`);
    }
    if (t.id === "wallsit-test" && typeof t.value === "number") {
      const cap = param(ar.assess, "高血压静蹲上限", info.code)?.number;
      const hyper = ctx.profile.conditions?.["高血压"] !== false;   // 没确认按有
      if (cap !== undefined && hyper && t.value > cap) err(`tests[${i}].value`, `有高血压或没确认：静蹲最多 ${cap} 秒（成品"靠墙静蹲每组不超过 30–45 秒"，取下限），记的是 ${t.value} 秒`);
    }
  }
  // 这一段摔倒过、头晕过的 65 岁以上：医生同意之前不测，段末可以不记测试
  let skipTests = false;
  if (r.kind === "段末" && info.age === "a65" && Number.isInteger(r.segment)) {
    skipTests = segmentNumbers(ctx.profile, r.segment, ctx.reviewData, ar.assess, info.code).falls > 0;
  }
  if (timing && !skipTests) {
    for (const def of ar.assess.tests.filter((x) => x.products.includes(info.code) && x.timing.includes(timing) && x.id !== "body" && x.id !== "gym-weights")) {
      if (!tests.some((t) => t.id === def.id)) err("tests", `${asEntry ? "入门" : r.kind}要记「${def.id}」（${def.note.split("；")[0]}）`);
    }
  }
  // 身体数据
  const b = r.body;
  const a65Then = info.age === "a65" || personAge(ctx, r.date) === "a65";
  if (b !== undefined) {
    if (a65Then && info.age !== "a65") err("body", "满 65 岁当月起不记身高、体重、腰围的数字（只问体重有没有明显下降）");
    else if (!BODY_AGES.includes(info.age)) err("body", info.age === "a65" ? "65 岁以上不记身高、体重、腰围的数字（只问体重有没有明显下降）" : "6–17 岁不记身高、体重、腰围、BMI");
    // 按记录那天"记 / 不记 / 停记"判断（bodyLog；没有的由 body、bodyStopDate 推：停记以前记的保留）
    else if (bodyStateOn(ctx.profile, r.date) !== "记") err("body", `${r.date} 那天档案是"${bodyStateOn(ctx.profile, r.date)}"体重腰围，评估里不能有身体数据`);
    else if (!timing && !hasReason(f, "中断")) err("body", "身体数据只在入门、段末、周期末评估里记（\"记\"的人中断回来的触发评估也可以记一次）");
    // 身高只记一次：入门、换成品的触发评估；建档时没记、改成记以后的第一份评估
    if (typeof b?.height === "number" && !asEntry && !isSwitch(f)) {
      const earlier = ctx.assessments.find((a) => a !== f && typeof a.raw?.body?.height === "number" && typeof a.raw.date === "string" && a.raw.date <= r.date);
      if (earlier) err("body.height", `身高记在入门（或换成品的触发评估）里，已经有 ${earlier.name} 那一份：这里不再记（BMI 一律用最早那份身高算）`);
    }
  }
  if (timing && BODY_AGES.includes(info.age) && bodyStateOn(ctx.profile, r.date) === "记") {
    const hadHeight = ctx.assessments.some((a) => a !== f && typeof a.raw?.body?.height === "number" && typeof a.raw.date === "string" && a.raw.date <= r.date);
    const want = timing === "入门" || !hadHeight ? ["height", "weight", "waist"] : ["weight", "waist"];
    const lack = want.filter((k) => typeof b?.[k] !== "number");
    if (lack.length) err("body", `档案选了记体重腰围：${timing}要记 ${want.join("、")}，少了 ${lack.join("、")}`);
  }
  if (r.weightDrop !== undefined && (!a65Then || typeof r.weightDrop !== "boolean")) err("weightDrop", "weightDrop（体重有没有明显下降，是 / 否）只给 65 岁以上");
  // 65 岁以上：有人在旁边、医生同意之后才测（同意的日期不早于测之前最近一件要医生同意的事）
  if (info.age === "a65" && tests.length) {
    if (param(ar.assess, "测试要有人在旁", info.code) && r.companion !== true) err("companion", "65 岁以上的测试要家人在场时做：companion 写 true");
    const before = doctorEvents(ctx).filter((e) => e.date <= r.date && !(e.reason === "段末结论是\"先看医生\"" && e.date === r.date)).pop();
    if (!(r.doctorCleared === true && typeof r.doctorDate === "string" && r.doctorDate <= r.date)) {
      err("tests", "65 岁以上的测试要在医生同意之后做：评估里记 doctorCleared、doctorDate（不晚于评估日期）");
    } else if (before && r.doctorDate < before.date) {
      err("doctorDate", `测之前${before.reason}（${before.date}）：这次测试用的医生同意（${r.doctorDate}）要在那之后`);
    }
  }
  // 开工前提（40–64 岁）
  const pres = ar.assess.prereqs.filter((x) => x.products.includes(info.code));
  if (asEntry && pres.length) {
    for (const pr of pres) if (typeof r.prereqs?.[pr.id] !== "boolean") err(`prereqs.${pr.id}`, `${product}开始前要问：${pr.ask}（是 / 否）`);
  } else if (r.prereqs !== undefined) err("prereqs", "开工前提只在 40–64 岁的入门（或换到 40–64 岁版的触发）评估里记");
  if (r.base !== undefined && !(asEntry && ["a18", "a40", "a13"].includes(info.age))) err("base", "训练频率只在 18–64 岁、13–17 岁的入门评估里记");
  // 跌倒风险自查：这份记录本身的矛盾；测了步态的要家人在场、医生同意之后（和 65 岁以上的测试同一个规则）
  const rr = fallRiskRules(ctx.rules);
  if (rr && isObj(r.fallRisk) && isObj(r.fallRisk.general)) {
    out.push(...fallRiskIssues(r.fallRisk, rr, { official: isObj(r.official) ? r.official : undefined }).map((i) => ({ ...i, path: `${f.name} ${i.path}` })));
    for (const def of rr.gait) {
      const v = r.fallRisk[def.id];
      if (typeof v?.seconds !== "number" || typeof v.testedOn !== "string") continue;
      if (r.companion !== true) err(`fallRisk.${def.id}`, "步态测试要家人在场时做：companion 写 true");
      const before = doctorEvents(ctx).filter((e) => e.date <= v.testedOn && e.reason !== FALL_REASON).pop();
      if (!(r.doctorCleared === true && typeof r.doctorDate === "string" && r.doctorDate <= v.testedOn)) {
        err(`fallRisk.${def.id}`, "步态测试要在医生同意之后做：评估里记 doctorCleared、doctorDate（不晚于测的那天）");
      } else if (before && r.doctorDate < before.date) {
        err(`fallRisk.${def.id}`, `测之前${before.reason}（${before.date}）：这次测试用的医生同意（${r.doctorDate}）要在那之后`);
      }
      if (v.testedOn < r.fallRisk.askedOn || v.testedOn > r.date) err(`fallRisk.${def.id}.testedOn`, "步态测的日期要在问卷之后、评估日期之前");
    }
    if (r.fallRisk.askedOn > r.date) err("fallRisk.askedOn", "问卷的日期不能晚于这份评估的日期");
  }
  if (isObj(r.official) && typeof r.official.date === "string" && typeof r.date === "string" && r.official.date > r.date) err("official.date", "正式评估的日期不能晚于这份评估的日期");
  if (hasReason(f, "满一年") && a65Then && typeof r.fallAssessDone !== "boolean") err("fallAssessDone", "65 岁以上满一年复评要问：这一年做过跌倒风险评估没有（是 / 否）");
  // 结论
  const want = recordConclusion(ctx, f, product, asEntry);
  const { goals: wantGoals, ...wantRest } = want ?? {};
  if (r.conclusion !== undefined && want && wantGoals !== undefined && r.conclusion.goals === undefined && sameJson(r.conclusion, wantRest)) {
    // 换到有目标规则的模板以前写的周期末记录：只缺 goals，提醒补上，不算错
    out.push({ level: "warning", path: `${f.name} conclusion`, message: `这份周期末记录是换模板以前写的，没有下一周期能选的目标：用 npm run course -- assess 重算一次，补上 goals（${JSON.stringify(wantGoals)}）` });
  } else if (r.conclusion !== undefined && want && !sameJson(r.conclusion, want)) {
    err("conclusion", `写的结论和按规则重算的不一致：应该是 ${JSON.stringify(want)}（用 npm run course -- assess 算）`);
  } else if (r.conclusion === undefined && want && Object.keys(want).length) err("conclusion", `缺结论：应该是 ${JSON.stringify(want)}`);
  return out;
}

/** 算 BMI 用的身高：最早一份记了身高的评估（入门；建档时没记的，改成记以后的第一份）。 */
export function entryHeight(ctx: AssessContext): number | undefined {
  const list = ctx.assessments.filter((a) => typeof a.raw?.body?.height === "number" && typeof a.raw.date === "string")
    .sort((x, y) => (x.raw.date < y.raw.date ? -1 : x.raw.date > y.raw.date ? 1 : 0));
  return list[0]?.raw.body.height;
}

/** 一份记录应该写的结论。 */
export function recordConclusion(ctx: AssessContext, f: AssessFile, product: string, asEntry: boolean): Obj | null {
  const r = f.raw;
  const ar = assessRules(ctx.rules);
  const info = productInfo(ctx.manifest, product);
  if (!ar || !info) return null;
  const out: Obj = {};
  if (asEntry) {
    const pres = ar.assess.prereqs.filter((x) => x.products.includes(info.code));
    if (pres.length) out.needDoctor = pres.some((p) => r.prereqs?.[p.id] === false);
  }
  const cuts = bmiCuts(ctx.manifest);
  // BMI 一律用最早那份身高（这份就是最早的，就用它自己的）
  const bmi = bmiOf(typeof r.body?.weight === "number" ? { weight: r.body.weight } : undefined, entryHeight(ctx) ?? r.body?.height);
  if (cuts && bmi !== null && BODY_AGES.includes(info.age)) {
    out.bmi = bmi;
    out.bmiClass = bmiClass(bmi, cuts);
  }
  const rr = fallRiskRules(ctx.rules);
  if (rr && isObj(r.fallRisk) && r.fallRisk.general) {
    out.fallRisk = fallRiskConclusion(r.fallRisk, rr, { official: isObj(r.official) ? r.official : undefined });
  }
  if (r.kind === "周期末" && Number.isInteger(r.segment)) {
    const end = cycleEnd(ctx, r.segment);
    if ("error" in end) return out;
    out.result = end.result;
    out.next = end.next;
    // 下一周期能选什么目标（阶段 4，模板有目标规则时才算）
    const cg = goalRules(ctx.rules) && end.next.phase === "稳定" ? cycleGoals(ctx, r.segment, f) : null;
    if (cg) out.goals = cg.goals;
  }
  if (r.kind === "段末" && Number.isInteger(r.segment)) {
    const dizzy = ((r.tests ?? []) as Obj[]).filter((t) => t.stopReason === "头晕").length;
    const end = segmentEnd(ctx.profile, r.segment, ctx.reviewData, ar, info.code, { dizzy });
    if ("error" in end) return out;
    out.result = end.result;
    out.next = end.next;
    if (end.downgraded) out.downgraded = true;
    if (end.extras.length) out.extras = end.extras;
    if (Object.keys(end.habitTargets).length) out.habitTargets = end.habitTargets;
  }
  return out;
}

export interface CycleConclusion {
  result: string;
  next: { phase: string; type?: string; hold?: boolean };
  trainings: number;
  habitWeeks: Record<string, number>;
  quotes: string[];
}

/**
 * 周期末结论（稳定期第 12 周之后）：照 rules.stable.nextCycle 从上往下取第一条。
 * 数字照 SEGMENT_COUNT：每个周次只取最后一份复盘，每周训练数不超过排的次数；习惯按"每周达标几天"数达标的周数。不适不计入。
 */
export function cycleEnd(ctx: AssessContext, n: number, opts: { afterDoctor?: boolean } = {}): CycleConclusion | { error: string } {
  const ar = assessRules(ctx.rules);
  const st = ctx.rules?.stable;
  const ss = (ctx.profile.segments as SegmentEntry[]).filter((s) => s.n === n);
  if (!ar || !st) return { error: "模板还没有稳定期规则（rules.json 的 stable）：先更新模板" };
  if (!ss.length || phaseOf(ss[0]) !== "稳定") return { error: `第 ${n} 段不是稳定期的段` };
  const info = productInfo(ctx.manifest, ss[0].product);
  if (!info) return { error: `模板里没有成品「${ss[0].product}」` };
  const passTr = stableParam(ctx.rules, info.code, "周期达标训练数")?.number;
  const cap = param(ar.assess, "每周排的训练", info.code)?.number ?? Infinity;
  const habitRules = ar.habits.filter((h) => h.products.includes(info.code) && h.segments.includes("标准") && h.per === "week");
  // 习惯达标周数：一个数（每项都是它），或者按打卡项写（"散步 9、放松 7"）
  const passOf: Record<string, number | undefined> = Object.fromEntries(habitRules.map((h) => [h.habit, habitPassWeeks(ctx.rules, info.code, h.habit)]));
  if (passTr === undefined || Object.values(passOf).some((x) => x === undefined)) return { error: `稳定期.md 没有 ${info.code} 的周期达标线（周期达标训练数、每个打卡项的习惯达标周数）` };
  const lastOf = new Map<number, SegmentEntry>();
  for (const s of ss) lastOf.set(s.week, s);
  let trainings = 0;
  const habitWeeks: Record<string, number> = Object.fromEntries(habitRules.map((h) => [h.habit, 0]));
  const missing: string[] = [];
  for (let w = 1; w <= st.cycleWeeks; w++) {
    const s = lastOf.get(w);
    const rv = s ? ctx.reviewData[reviewDataName(s)] : undefined;
    if (!rv) { missing.push(`第 ${w} 周的复盘数据`); continue; }
    trainings += Math.min(rv.trainings ?? 0, cap);
    const lack: string[] = [];
    for (const h of habitRules) {
      if (!h.weeks.includes(roundWeek(w))) continue;
      const d = rv.habits?.[h.habit];
      if (!Number.isInteger(d)) lack.push(`habits.${h.habit}`);
      else if (d >= h.days) habitWeeks[h.habit]++;
    }
    if (lack.length) missing.push(`第 ${w} 周复盘数据的 ${lack.join("、")}`);
  }
  if (missing.length) return { error: `第 ${n} 段缺 ${missing.join("；")}：周期末算不出来，先补问再写进复盘数据` };
  // 上一个周期也没达标：紧挨着的上一段是同一家族的稳定段，它的周期末结论是"下一周期第一轮不升级"
  const all = ctx.profile.segments as SegmentEntry[];
  const first = all.findIndex((s) => s.n === n);
  const prevN = first > 0 ? all[first - 1].n : null;
  const prevMiss = prevN !== null && cycleHold(ctx, prevN);
  // 65 岁以上：最后一轮（第 9–12 周）摔倒、差点摔倒、头晕（含周期末坐站测试停下的原因是头晕），A65_STABLE_FALL；
  // 重复的周每一份复盘都算（头晕那一周不能往上走，会重复一遍）
  const lastRound = ss.filter((s) => s.week >= 9).map((s) => ctx.reviewData[reviewDataName(s)] ?? {});
  const endRec = ctx.assessments.filter((a) => a.raw?.kind === "周期末" && a.raw.segment === n).pop();
  const fallsOrDizzy = lastRound.some((rv) => (rv.falls ?? 0) + (rv.nearFalls ?? 0) + (rv.dizzy ?? 0) > 0)
    || ((endRec?.raw.tests ?? []) as Obj[]).some((x) => x.stopReason === "头晕");
  const test = (c: { kind: string }) => c.kind === "fallsOrDizzy" ? fallsOrDizzy && !opts.afterDoctor
    : c.kind === "trainingsBelow" ? trainings < passTr
    : c.kind === "habitsMiss" ? Object.entries(habitWeeks).some(([h, x]) => x < (passOf[h] as number))
    : c.kind === "prevMiss" ? prevMiss : false;
  // 下一周期的表按家族各一张（旧模板的行没有 products，照旧所有家族共用）
  const rows = st.nextCycle.filter((r) => !r.products || r.products.includes(info.code));
  const hit = [...rows].sort((x, y) => x.order - y.order).find((r) => r.when.every(test));
  if (!hit) return { error: "稳定期.md 的下一周期规则没有一条对得上" };
  return { result: hit.result, next: hit.next, trainings, habitWeeks, quotes: hit.quotes.map((q) => q.text) };
}

/**
 * 第 n 段（稳定期）周期末的结论是不是"下一周期第一轮不升级 / 不加项"：记录里写的 hold；
 * 结论是"先看医生"（65 岁以上第 0 行）、医生说接着练的，照跳过第 0 行重算的结论（记录里只能写"先看医生"）。
 */
export function cycleHold(ctx: AssessContext, n: number): boolean {
  const rec = ctx.assessments.filter((a) => a.raw?.kind === "周期末" && a.raw.segment === n).pop();
  if (!rec) return false;
  if (rec.raw.conclusion?.next?.hold === true) return true;
  if (rec.raw.conclusion?.next?.phase !== "不开") return false;
  const c = cycleEnd(ctx, n, { afterDoctor: true });
  return !("error" in c) && c.next.hold === true;
}

/**
 * 整个档案目录的评估核对（profile check、course export、course check --profile 之前都跑）：
 * 入门评估、段末评估和下一段对得上、换成品和重来有依据、跨段、满一年复筛、医生同意的日期、摔倒、中断。
 */
export function checkAssessments(ctx: AssessContext): Issue[] {
  const out: Issue[] = [];
  const err = (path: string, message: string) => out.push({ level: "error", path, message });
  const warn = (path: string, message: string) => out.push({ level: "warning", path, message });
  const ar = assessRules(ctx.rules);
  const p = ctx.profile;
  const ss = p.segments as SegmentEntry[];
  if (!Array.isArray(ss) || !ss.length) return out;
  if (!ar) {
    warn("档案.json", "模板还没有评估规则（rules.json 的 assess）：评估、跨段、中断都没核对，先更新模板");
    return out;
  }
  const now = ctx.now ?? new Date();
  const today = localDate(now);
  const A = ctx.assessments;
  const byKind = (k: string) => A.filter((a) => a.raw?.kind === k);
  const fileName = (a: AssessFile) => a.name.replace(/^.*[\\/]/, "");
  const sc = p.screening ?? {};
  const sd: string | undefined = typeof sc.date === "string" && DATE.test(sc.date) ? sc.date : undefined;

  // 0. 日期不能是将来
  for (const a of A) {
    const want = `${a.raw?.date}-${a.raw?.kind}.json`;
    if (!fileName(a).startsWith(`${a.raw?.date}-${a.raw?.kind}`)) err(a.name, `评估记录的文件名要是 评估/${want}`);
    for (const k of ["date", "doctorDate", "eventDate"]) if (typeof a.raw?.[k] === "string" && a.raw[k] > today) err(`${a.name} ${k}`, `${a.raw[k]} 还没到：日期照实写`);
  }
  for (const k of ["date", "doctorDate"]) if (typeof sc[k] === "string" && sc[k] > today) err(`档案.json screening.${k}`, `${sc[k]} 还没到：日期照实写`);

  const segStarts = ss.map((s, i) => ({ s, i })).filter(({ s, i }) => i === 0 || ss[i - 1].n !== s.n);
  const segOf = (n: number) => ss.filter((x) => x.n === n);

  // 1. 入门评估
  const entries = byKind("入门");
  const first = entries.find((a) => a.raw.date <= ss[0].start);
  if (!first) err("评估/", `第一段（${ss[0].start} 起）之前要有入门评估：评估/<日期>-入门.json（用 npm run course -- assess 列出要问、要测的项）`);
  for (const a of entries) {
    if (a.raw.product !== undefined && a.raw.product !== ss[0].product) err(a.name, `入门评估是给「${ss[0].product}」做的，写的是「${a.raw.product}」`);
    out.push(...checkRecord(ctx, a, ss[0].product, true));
  }
  // 档案里有稳定期的段，模板却没有稳定期规则：旧模板，下面按稳定期核对的都不成立
  if (ss.some((s) => phaseOf(s) === "稳定") && !ctx.rules?.stable) {
    err("档案.json segments", "档案里有稳定期的段，模板还没有稳定期规则（rules.json 的 stable）：先把模板仓库更新到 v3.1 之后");
    return out;
  }
  // 每一段的阶段要和成品一致
  for (const { s, i } of segStarts) {
    const info = productInfo(ctx.manifest, s.product);
    if (info && info.phase !== phaseOf(s)) err(`segments[${i}].phase`, `「${s.product}」是${info.phase}期的成品，这一段写的是${phaseOf(s)}期：phase 要和成品一致`);
  }
  // 直接进稳定期（有基础的人）：只限登记了门槛的成品（徒手、居家），入门评估里训练频率和俯卧撑测试都达线，方向含"训练"
  if (phaseOf(ss[0]) === "稳定") {
    const info = productInfo(ctx.manifest, ss[0].product);
    const days = info ? stableParam(ctx.rules, info.code, "有基础每周力量天数")?.number : undefined;
    const lvl = info ? stableParam(ctx.rules, info.code, "有基础俯卧撑级")?.number : undefined;
    const reps = info ? stableParam(ctx.rules, info.code, "有基础俯卧撑次数")?.number : undefined;
    const t = ((first?.raw.tests ?? []) as Obj[]).find((x) => x.id === "pushup-test");
    if (days === undefined || lvl === undefined || reps === undefined) {
      err("segments[0]", `「${ss[0].product}」不设直接进入：先走起始期，段末到了进阶线再进稳定期`);
    } else if (!first || first.raw.base !== days || !t || !(t.level >= lvl) || !(t.value >= reps)) {
      err("segments[0]", `直接进稳定期要"有基础"：入门评估里最近 3 个月每周 ${days} 天以上力量练习（base = ${days}），而且俯卧撑测试做到第 ${lvl} 级以上、满 ${reps} 次；不够就先走起始期`);
    } else if (!(Array.isArray(p.focus?.areas) && p.focus.areas.includes("训练"))) {
      err("档案.json focus", "直接进稳定期的人方向要含\"训练\"（focus.areas）；只想从作息、饮食入手的走起始期");
    }
  }

  // 2. 段末评估和下一段；换成品；中途重来
  const enders = byKind("段末");
  for (const a of enders) {
    const seg = segOf(a.raw.segment);
    if (!seg.length) { err(a.name, `没有第 ${a.raw.segment} 段`); continue; }
    out.push(...checkRecord(ctx, a, seg[0].product, false));
  }
  const cycleEnds = byKind("周期末");
  for (const a of cycleEnds) {
    const seg = segOf(a.raw.segment);
    if (!seg.length || phaseOf(seg[0]) !== "稳定") { err(a.name, `第 ${a.raw.segment} 段不是稳定期的段：周期末评估只在稳定期第 12 周之后做`); continue; }
    out.push(...checkRecord(ctx, a, seg[0].product, false));
  }
  const enterResults = (code: string) => (stableParam(ctx.rules, code, "进稳定期的结论")?.value ?? "").split("、").filter(Boolean);
  for (const { s, i } of segStarts.slice(1)) {
    const prev = ss[i - 1];
    const prevSeg = segOf(prev.n);
    const info = productInfo(ctx.manifest, s.product);
    const prevInfo = productInfo(ctx.manifest, prevSeg[0].product);
    const rs = (s as Obj).restart;
    const sameFam = !!info && !!prevInfo && info.code === prevInfo.code;
    const prevStable = phaseOf(prev) === "稳定";
    const curStable = phaseOf(s) === "稳定";
    const cycleWeeks = ctx.rules?.stable?.cycleWeeks ?? 12;
    // 进稳定期只有两条路：起始期段末到了进阶线（同一家族），或者有基础直接进入（只能是第一段）
    if (curStable && !(sameFam && ((prevStable && prev.week === cycleWeeks) || (!prevStable && prev.week === 4)))) {
      err(`segments[${i}]`, "进稳定期只有两条路：同一版本的起始期练完一段、段末到了进阶线；或者有基础的人建档时直接进入。换场地、换成品不能直接进稳定期（先走新版本的起始期）");
      continue;
    }
    if (prevStable) {
      if ((s as Obj).habitTargets !== undefined && Object.keys((s as Obj).habitTargets).length) err(`segments[${i}].habitTargets`, "稳定期之后的这一段没有习惯目标（习惯目标只来自起始期的段末结论）");
      if (prev.week === cycleWeeks) {
        // 一个周期练完：要有周期末评估，下一段照结论开
        const end = cycleEnds.find((a) => a.raw.segment === prev.n);
        if (!end) { err(`segments[${i}]`, `第 ${prev.n} 段（稳定期）练完了，开第 ${s.n} 段之前要做周期末评估（评估/<日期>-周期末.json）`); continue; }
        if (end.raw.date < prev.start || end.raw.date > s.start) err(end.name, `周期末评估的日期要在第 ${cycleWeeks} 周开始（${prev.start}）之后、下一段开始（${s.start}）之前`);
        let c = cycleEnd(ctx, prev.n);
        if ("error" in c) { err(end.name, c.error); continue; }
        // 65 岁以上最后一轮摔倒、头晕（第 0 行"先看医生"）：周期末以后看医生；doctorRestart false 跳过这一行照后面几行，true（或没写）回起始期标准段
        if (c.next.phase === "不开") {
          const back = A.find((a) => hasReason(a, "看完医生回来") && a.raw.date >= end.raw.date && a.raw.date <= s.start
            && a.raw.doctorCleared === true && typeof a.raw.doctorDate === "string" && a.raw.doctorDate >= end.raw.date);
          if (!back) { err(`segments[${i}]`, `第 ${prev.n} 段周期末的结论是"${c.result}"：要有一份触发评估（看完医生回来，医生同意的日期在周期末之后）才能开下一段`); continue; }
          if (typeof back.raw.doctorRestart !== "boolean") err(`${back.name} doctorRestart`, "写明 doctorRestart：医生让从第 1 周重新开始写 true，说可以接着照第 4 周的做法练写 false（没写按 true，回起始期第 1 周）");
          if (back.raw.doctorRestart === false) {
            const c2 = cycleEnd(ctx, prev.n, { afterDoctor: true });
            if ("error" in c2) { err(end.name, c2.error); continue; }
            c = c2;
          } else c = { ...c, next: { phase: "起始", type: "标准" } };
        }
        // 结论是回起始期的：不论换不换成品（换场地、跨段），段型都照结论（减量段换场地还是减量段）
        if (c.next.phase === "起始" && curStable) err(`segments[${i}]`, `第 ${prev.n} 段周期末的结论是"${c.result}"：下一段回起始期（${c.next.type}段），不能接着开稳定期`);
        if (c.next.phase === "起始" && !curStable && s.type !== c.next.type) err(`segments[${i}].type`, `第 ${prev.n} 段周期末的结论是"${c.result}"：回起始期${c.next.type}段，写的是${s.type}段`);
        if (c.next.phase === "稳定" && !curStable && s.type !== "标准") err(`segments[${i}].type`, `第 ${prev.n} 段周期末的结论是"${c.result}"：离开稳定期（自己要求回起始期、换成品）从标准段第 1 周开始`);
        if (sameFam) {
          const back = A.some((a) => hasReason(a, "回起始期") && a.raw.date >= prevSeg[0].start && a.raw.date <= s.start);
          if (c.next.phase === "稳定" && !curStable && !back) err(`segments[${i}]`, `第 ${prev.n} 段周期末的结论是"${c.result}"，接着开下一个周期（稳定期）；自己想回起始期的，做一份触发评估（原因：回起始期）`);
        }
      } else if (sameFam && !curStable) {
        // 周期中途回起始期：断了超过 8 周、医生建议从头来、自己要求——都要有触发评估，回标准段
        const a65 = prevInfo?.age === "a65";
        const why = A.some((a) => a.raw.kind === "触发" && a.raw.date >= prevSeg[0].start && a.raw.date <= s.start
          && (hasReason(a, "中断") || hasReason(a, "回起始期") || a.raw.doctorRestart === true
            // 65 岁以上：生病住院回来从第 1 周重新开始；摔倒、头晕看完医生没写 doctorRestart 的按从头来（A65_STABLE_FALL）
            || (a65 && (hasReason(a, "生病住院") || (hasReason(a, "看完医生回来") && a.raw.doctorRestart !== false)))));
        if (!why) err(`segments[${i}]`, "稳定期一个周期没练完就回起始期，要有触发评估：断了八周以上（中断）、医生建议从头来（doctorRestart）、或者自己要求（回起始期）");
        if (s.type !== "标准") err(`segments[${i}].type`, "周期中途回起始期：从标准段第 1 周开始");
      } else if (!sameFam && info && prevInfo && prevInfo.age !== info.age && info.age !== "a65" && prev.week % ROUND_WEEKS !== 0) {
        // 满 40 岁、13–17 岁满 18 岁：在轮的边界换版（满 65 岁不等，A65_SWITCH）
        err(`segments[${i}]`, `${info.age === "a40" ? "满 40 岁" : "满 18 岁"}在轮的边界换版：这一轮（4 周）练完再换，上一段才到第 ${prev.week} 周`);
      }
    } else if (prev.week === 4) {
      // 上一段练完了：照样要段末评估、照结论开（写了 restart 也一样）
      const end = enders.find((a) => a.raw.segment === prev.n);
      if (!end) { err(`segments[${i}]`, `第 ${prev.n} 段练完了，开第 ${s.n} 段之前要做段末评估（评估/<日期>-段末.json）`); continue; }
      if (end.raw.date < prev.start || end.raw.date > s.start) err(end.name, `段末评估的日期要在第 4 周开始（${prev.start}）之后、下一段开始（${s.start}）之前`);
      const dizzy = ((end.raw.tests ?? []) as Obj[]).filter((t) => t.stopReason === "头晕").length;
      const c = prevInfo ? segmentEnd(p, prev.n, ctx.reviewData, ar, prevInfo.code, { dizzy }) : null;
      if (!c || "error" in c) { if (c) err(end.name, c.error); continue; }
      if (c.next === "不开") {
        const back = A.find((a) => hasReason(a, "看完医生回来") && a.raw.date >= end.raw.date && a.raw.date <= s.start
          && a.raw.doctorCleared === true && typeof a.raw.doctorDate === "string" && a.raw.doctorDate >= end.raw.date);
        if (!back) err(`segments[${i}]`, `第 ${prev.n} 段段末的结论是"先看医生"：要有一份触发评估（看完医生回来，医生同意的日期在段末之后）才能开下一段`);
        // 医生同意以后：跳过"先看医生"照后面几条走（往上的降级）
        const c2 = prevInfo ? segmentEnd(p, prev.n, ctx.reviewData, ar, prevInfo.code, { dizzy, afterDoctor: true }) : null;
        if (c2 && !("error" in c2)) {
          const want = c2.next === "减量" ? "减量" : "标准";
          if (s.type !== want) err(`segments[${i}].type`, `第 ${prev.n} 段段末"先看医生"、医生同意以后照后面几条走（"${c2.result}"），下一段要是${want}段，写的是${s.type}段`);
          c.habitTargets = c2.habitTargets;
        }
      } else {
        // 换成品也照段末结论（第十三节第 5 条用户定之前，按保守的一边）
        const want = c.next === "减量" ? "减量" : "标准";
        if (s.type !== want) err(`segments[${i}].type`, `第 ${prev.n} 段段末的结论是"${c.result}"，下一段要是${want}段，写的是${s.type}段`);
      }
      // 进稳定期：段末结论要是进阶线那一条（往上是"是"），而且没被不适降级；登记了"进稳定期要习惯达标"的，下一段习惯目标还要是空的
      if (curStable && prevInfo && !(enterResults(prevInfo.code).includes(c.result) && c.upward && !c.downgraded)) {
        err(`segments[${i}]`, `第 ${prev.n} 段段末的结论是"${c.result}"${c.downgraded ? "（有不适，降级了）" : !c.upward ? "（不是往上那一条）" : ""}：到了进阶线（${enterResults(prevInfo.code).join("、") || "这份成品没有登记"}，往上那一条）而且这一段没有不适，才能进稳定期；否则照结论再跑一段起始期`);
      } else if (curStable && prevInfo && stableParam(ctx.rules, prevInfo.code, "进稳定期要习惯达标")?.value === "是" && Object.keys(c.habitTargets).length) {
        err(`segments[${i}]`, `第 ${prev.n} 段段末重算出的下一段习惯目标是 ${JSON.stringify(c.habitTargets)}：降过的习惯目标都改回来（下一段习惯目标是空的）才能进稳定期，先带着这个目标再跑一段起始期（STABLE_ENTRY_HABITS）`);
      }
      // 换成品：同一家族只留新成品这种段型也有的打卡项；换到别的家族的，上一段的习惯目标都不带过去（CROSS_FAMILY_RESET）
      const newHabits = new Set(ar.habits.filter((h) => h.products.includes(info?.code ?? "") && h.segments.includes(s.type)).map((h) => h.habit));
      const wantTargets = s.product === prev.product ? c.habitTargets : !sameFam ? {} : Object.fromEntries(Object.entries(c.habitTargets).filter(([h]) => newHabits.has(h)));
      if (!sameJson((s as Obj).habitTargets ?? {}, wantTargets)) {
        err(`segments[${i}].habitTargets`, !sameFam && s.product !== prev.product ? "换到别的家族的成品，上一段的习惯目标不带过去（CROSS_FAMILY_RESET）：这一段不写 habitTargets"
          : `按第 ${prev.n} 段段末，下一段的习惯目标应该是 ${JSON.stringify(wantTargets)}，写的是 ${JSON.stringify((s as Obj).habitTargets ?? {})}`);
      }
    } else if (rs) {
      // 中途重来：段型、习惯目标照被中断的那一段
      if (s.type !== prevSeg[0].type) err(`segments[${i}].type`, `从第 1 周重来，段型照被中断的第 ${prev.n} 段（${prevSeg[0].type}段）`);
      if (!sameJson((s as Obj).habitTargets ?? {}, (prevSeg[0] as Obj).habitTargets ?? {})) err(`segments[${i}].habitTargets`, `从第 1 周重来，习惯目标照被中断的第 ${prev.n} 段：${JSON.stringify((prevSeg[0] as Obj).habitTargets ?? {})}`);
    } else if (s.product !== prev.product) {
      // 一段中间换场地、换成品：段型照被换掉的那一段（减量段换场地还是减量段，第十三节第 5 条），习惯目标只留新成品也有的
      if (s.type !== prevSeg[0].type) err(`segments[${i}].type`, `一段中间换成品，段型照原来那一段（${prevSeg[0].type}段）`);
      const newHabits = new Set(ar.habits.filter((h) => h.products.includes(info?.code ?? "") && h.segments.includes(s.type)).map((h) => h.habit));
      const want = !sameFam ? {} : Object.fromEntries(Object.entries((prevSeg[0] as Obj).habitTargets ?? {}).filter(([h]) => newHabits.has(h)));
      if (!sameJson((s as Obj).habitTargets ?? {}, want)) err(`segments[${i}].habitTargets`, !sameFam ? "换到别的家族的成品，上一段的习惯目标不带过去（CROSS_FAMILY_RESET）：这一段不写 habitTargets"
        : `一段中间换成品，习惯目标照原来那一段（只留新成品也有的）：${JSON.stringify(want)}`);
    } else if ((s as Obj).habitTargets !== undefined) {
      err(`segments[${i}].habitTargets`, "习惯目标只能来自上一段的段末结论");
    }
    // 换成品（换家族）：触发评估（跨段、换场地），带上新成品入门的项目；换了年龄段还要重新筛查。同一家族的起始期和稳定期之间不用
    if (s.product !== prev.product && !sameFam) {
      const sw = A.filter((a) => isSwitch(a) && a.raw.product === s.product && a.raw.date <= s.start && a.raw.date >= prevSeg[0].start);
      if (!sw.length) err(`segments[${i}]`, `换成「${s.product}」要有触发评估（跨段或换场地，product 写新成品），带上新成品入门要问、要测的项`);
      else if (info && prevInfo && info.age !== prevInfo.age) {
        // 按新年龄段重新筛查：不早于推算进入新年龄段的那天（满 65 岁那个月的 1 日、升学那天），找不到就按上一段开始那天
        let bound = prevSeg[0].start;
        for (let d = prevSeg[0].start; d <= s.start; d = addDays(d, 1)) {
          if (ageAt(p, d, ar.assess).age === info.age) { bound = d; break; }
        }
        if (!sd || sd < bound || sd > s.start) err(`segments[${i}]`, `从${prevInfo.age}换到${info.age}：要按新年龄段重新做安全筛查（档案 screening.date 在 ${bound} 到 ${s.start} 之间）`);
      }
    }
    // 同一成品中途重来：65 岁以上生病住院、6–12 岁生病超过 7 天
    if (rs) {
      const t = A.find((a) => `评估/${fileName(a)}` === rs || a.name.replace(/\\/g, "/").endsWith(rs));
      const why = info?.age === "a65" ? "生病住院" : info?.age === "a06" ? "生病" : null;
      if (s.product !== prev.product) err(`segments[${i}].restart`, "重来是同一成品从第 1 周重新开始；换成品不写 restart");
      else if (!why) err(`segments[${i}].restart`, "只有 65 岁以上生病住院回来、6–12 岁生病超过 7 天才从第 1 周重来");
      else if (!t || !hasReason(t, why) || t.raw.date > s.start || t.raw.date < prevSeg[0].start) {
        err(`segments[${i}].restart`, `依据要是被中断的这一段里、新一段开始之前的触发评估（原因：${why}）：${rs}`);
      } else if (why === "生病住院" && !(t.raw.doctorCleared === true && typeof t.raw.doctorDate === "string" && typeof t.raw.eventDate === "string"
        && t.raw.doctorDate >= t.raw.eventDate && t.raw.doctorDate <= s.start)) {
        err(`segments[${i}].restart`, "生病、住院回来：先问医生能不能练，触发评估要记那天（eventDate）和之后的医生同意（doctorCleared、doctorDate）");
      } else if (why === "生病") {
        const sick = prevSeg.reduce((sum, x) => sum + (ctx.reviewData[reviewDataName(x)]?.sickDays ?? 0), 0);
        if (sick <= 7) err(`segments[${i}].restart`, `第 ${prev.n} 段加起来生病 ${sick} 天：超过 7 天才这一轮不评、从头开始`);
      }
    }
  }
  // 65 岁以上稳定期一轮里摔倒、差点摔倒、头晕（A65_STABLE_FALL，起始期"本轮摔倒过……先去看医生"对到 4 周一轮）：
  // 第 4、8 周练完先不开下一轮，轮末以后看医生；"看完医生回来"写 doctorRestart，true（或没写）回起始期标准段第 1 周
  for (const { s, i } of segStarts) {
    const info = productInfo(ctx.manifest, s.product);
    if (phaseOf(s) !== "稳定" || info?.age !== "a65") continue;
    const seg = ss.map((x, k) => ({ x, k })).filter(({ x }) => x.n === s.n && ss.indexOf(x) >= i);
    for (const endWeek of [4, 8]) {
      const inRound = seg.filter(({ x }) => x.week > endWeek - 4 && x.week <= endWeek);
      const w4 = inRound.filter(({ x }) => x.week === endWeek).pop();
      if (!w4) continue;
      const trouble = inRound.some(({ x }) => { const rv = ctx.reviewData[reviewDataName(x)]; return (rv?.falls ?? 0) + (rv?.nearFalls ?? 0) + (rv?.dizzy ?? 0) > 0; });
      const nx = ss[w4.k + 1];
      if (!trouble || !nx) continue;
      const roundEnd = addDays(w4.x.start, 6);
      const back = A.find((a) => hasReason(a, "看完医生回来") && a.raw.date >= roundEnd && a.raw.date <= nx.start
        && a.raw.doctorCleared === true && typeof a.raw.doctorDate === "string" && a.raw.doctorDate >= roundEnd);
      if (!back) { err(`segments[${w4.k + 1}]`, `第 ${s.n} 段第 ${endWeek - 3}–${endWeek} 周摔倒、差点摔倒或头晕过：这一轮练完先不开下一轮，先看医生（看完医生回来的触发评估，医生同意在 ${roundEnd} 以后）`); continue; }
      if (typeof back.raw.doctorRestart !== "boolean") err(`${back.name} doctorRestart`, "写明 doctorRestart：医生让从第 1 周重新开始写 true，说可以接着照第 4 周的做法练写 false（没写按 true，回起始期第 1 周）");
      if (back.raw.doctorRestart !== false && phaseOf(nx) === "稳定") err(`segments[${w4.k + 1}]`, "医生让从头来（或者没写 doctorRestart）：回起始期那一份，从标准段第 1 周开始，加项清零");
    }
  }
  // 65 岁以上稳定期里生病、住院（A65_STABLE_FALL 同一节）：回来以后新开的那一项要是起始期标准段第 1 周
  for (const a of A.filter((x) => hasReason(x, "生病住院") && typeof x.raw?.date === "string")) {
    const at = productAtIndex(ss, typeof a.raw.eventDate === "string" ? a.raw.eventDate : a.raw.date);
    if (at < 0 || phaseOf(ss[at]) !== "稳定" || productInfo(ctx.manifest, ss[at].product)?.age !== "a65") continue;
    const k = ss.findIndex((x, j) => j > at && x.start > (typeof a.raw.eventDate === "string" ? a.raw.eventDate : a.raw.date));
    if (k < 0) continue;
    if (phaseOf(ss[k]) === "稳定" || ss[k].type !== "标准" || ss[k].week !== 1) {
      err(`segments[${k}]`, `${a.name}：65 岁以上稳定期里生病、住院回来，先问医生能不能练，能练的回起始期那一份、从标准段第 1 周重新开始（加项清零），不能接着练稳定期`);
    }
  }
  for (const a of byKind("触发")) {
    // 跨段、换场地：按新成品的入门核对（开工前提、第〇章的测试、身体数据）
    out.push(...checkRecord(ctx, a, isSwitch(a) ? a.raw.product : productAt(ss, a.raw.date) ?? ss[0].product, isSwitch(a)));
  }

  // 3. 跨段（入学年份不能晚于今天所在的学年）
  if (isObj(p.school) && Number.isInteger(p.school.entry)) {
    const [y, mo] = today.split("-").map(Number);
    const sep = (crossText(ar.assess, "升学日期") || "09-01").split("-").map(Number);
    const schoolYear = mo > sep[0] || (mo === sep[0] && Number(today.slice(8, 10)) >= sep[1]) ? y : y - 1;
    if (p.school.entry > schoolYear) err("档案.json school.entry", `入学年份 ${p.school.entry} 还没到（现在是 ${schoolYear} 学年）：写已经入学的那个学段和年份`);
  }
  let ageProblem = false;
  for (const { s, i } of segStarts) {
    const info = productInfo(ctx.manifest, s.product);
    const at = ageAt(p, s.start, ar.assess);
    if (!at.age) {
      // 完全没记出生年月和学段的，档案格式检查已经报了，这里不重复
      if (!ageProblem && (p.birth !== undefined || p.school !== undefined)) err("档案.json", at.problem ?? "推算不了年龄段");
      ageProblem = true;
      continue;
    }
    if (info && at.age !== info.age) err(`segments[${i}]`, `第 ${s.n} 段开始那天（${s.start}）推算是${at.stage}（${at.age}），成品「${s.product}」是 ${info.age}：做触发评估（跨段），换成对应的成品`);
  }
  const last = ss[ss.length - 1];
  const curInfo = productInfo(ctx.manifest, last.product);
  const curStart = segStarts[segStarts.length - 1].s;
  if (!ageProblem && curInfo) {
    // 学段（初中升高中）：起始期和这一段开始那天比；稳定期一段 12 周，和这一轮开始那天比（"这一轮练完按高中重新算上床时间"）
    let stageDay = curStart.start;
    if (phaseOf(last) === "稳定") {
      for (let k = ss.length - 1; k >= 0 && ss[k].n === last.n; k--) if (roundWeek(ss[k].week) === 1) { stageDay = ss[k].start; break; }
    }
    const atStart = ageAt(p, stageDay, ar.assess);
    if (atStart.stage && p.stage !== atStart.stage && STAGE_AGE[p.stage] === atStart.age) err("档案.json stage", `这一${phaseOf(last) === "稳定" ? "轮" : "段"}开始那天推算是${atStart.stage}，档案写的是${p.stage}：改 stage，重算上床时间`);
    const atNow = ageAt(p, today, ar.assess);
    const curStable = phaseOf(last) === "稳定";
    if (atNow.age === "a65" && curInfo.age !== "a65") err("档案.json", "已经满 65 岁：要换 65 岁以上版（重新筛查、医生同意），不等这一段练完（A65_SWITCH）");
    else if (atNow.age && atNow.age !== curInfo.age && curStable) {
      // 稳定期一段 12 周：满 40 岁在轮的边界（这 4 周练完）换到 40–64 岁起始期；从满 40 岁那个月起先补体检、血压
      warn("档案.json", `现在推算是${atNow.stage}：这一轮（4 周）练完，做触发评估（跨段）换到对应年龄段的起始期`);
      const pre = A.some((a) => isSwitch(a) && productInfo(ctx.manifest, a.raw.product)?.age === atNow.age && isObj(a.raw.prereqs) && a.raw.date >= curStart.start);
      if (atNow.age === "a40" && !pre) err("档案.json", "已经满 40 岁：先做触发评估（跨段，product 写 40–64 岁的起始期成品），补上体检、血压这两项开工前提，之前不出课程");
      // 新的一轮从哪天开始：这一轮第 1 周第一次出现的那一项（有不适、没达标重复第 1 周的不算又开了一轮）
      for (let k = ss.length - 1; k >= 0 && ss[k].n === last.n; k--) {
        const roundStart = roundWeek(ss[k].week) === 1 && ss[k].week > 1 && !(k > 0 && ss[k - 1].n === ss[k].n && ss[k - 1].week === ss[k].week);
        if (roundStart && ageAt(p, ss[k].start, ar.assess).age !== curInfo.age) {
          err(`segments[${k}]`, `第 ${ss[k].week} 周（${ss[k].start}）开始新的一轮时已经是${ageAt(p, ss[k].start, ar.assess).stage}：要在轮的边界换到对应年龄段的起始期，不能接着用这一版`);
          break;
        }
      }
    }
    else if (atNow.age && atNow.age !== curInfo.age) warn("档案.json", `现在推算是${atNow.stage}：这一段练完，段末一起做触发评估（跨段）换成品`);
    else if (atNow.stage && atNow.stage !== p.stage && atNow.age === curInfo.age) warn("档案.json stage", `现在推算是${atNow.stage}：下一段开始前改 stage、重算上床时间`);
    const warnDays = crossNum(ar.assess, "跨段提前警告天数") ?? 28;
    if (curInfo.age === "a40" && curStart.start >= addDays(today, -7)) {
      const soon = ageAt(p, addDays(curStart.start, warnDays), ar.assess);
      if (soon.age === "a65") warn("档案.json", `这一段开始后 ${warnDays} 天内会满 65 岁：到时候要换 65 岁以上版`);
    }
  }

  // 4. 满一年复筛、医生同意、摔倒、体重下降、生病换药
  const code = segCode(ctx.manifest, last.product);
  const yearDays = param(ar.assess, "筛查有效天数", code)?.number;
  if (sd && yearDays !== undefined && (dayStart(today) - dayStart(sd)) / DAY > yearDays) {
    err("档案.json screening.date", `安全筛查是 ${sd} 做的，已经超过 ${yearDays} 天：做触发评估（满一年），重做筛查${curInfo?.age === "a65" ? "，也问医生做一次跌倒风险评估" : ""}`);
  }
  const a65Now = curInfo?.age === "a65" || personAge(ctx, today) === "a65";
  if (a65Now) {
    const recent = fallDates(ctx).filter((d) => (dayStart(today) - dayStart(d)) / DAY <= 365);
    const lastFall = recent[recent.length - 1];
    if (lastFall) {
      const it = screeningItem(p, /摔倒/);
      if (it && (it.answer !== "是" || !(sd && sd >= lastFall))) err("档案.json screening", `${lastFall} 前后摔倒过：重做安全筛查（"${it.item}"现在是"是"），医生同意以后再练平衡动作`);
    }
    for (const a of A) if (hasReason(a, "满一年") && a.raw.fallAssessDone === false) warn(a.name, "这一年还没做过跌倒风险评估：提醒去医院或社区卫生服务中心做一次（每年至少一次）");
  }
  const need = doctorNeed(ctx);
  if (need.needed && need.stale) err("档案.json screening.doctorDate", `${need.reason}（${need.after}）：档案记的医生同意（${sc.doctorDate}）早于这件事，要重新问医生，记新的 doctorDate`);
  else if (need.needed && !need.ok) warn("档案.json screening", `${need.reason}：医生同意（doctorDate 不早于 ${need.after}）之前不出课程`);
  const back = A.filter((a) => hasReason(a, "看完医生回来") && typeof a.raw.doctorDate === "string").map((a) => a.raw.doctorDate as string).sort().pop();
  if (back && !(typeof sc.doctorDate === "string" && sc.doctorDate >= back)) err("档案.json screening.doctorDate", `看完医生回来的触发评估记了医生同意（${back}）：档案的 doctorCleared、doctorDate 要同步改`);
  // 4b. 跌倒风险自查（阶段 3c）：生效日期之后，65 岁以上的入门、换到 65 岁以上版、满一年、摔倒、生病住院、身体变化、到期复查都要做
  const rr = fallRiskRules(ctx.rules);
  if (rr) {
    const ASKS = ["满一年", "摔倒", "生病住院", "身体变化", "跌倒自查到期"];
    const AFTER_EVENT = ["摔倒", "生病住院", "身体变化"];
    const firstStart = ss[0]?.start;
    for (const a of A) {
      const d = a.raw?.date;
      if (typeof d !== "string") continue;
      // 生效日期之前的记录免查；入门要第一段也在生效日期之前开始才免（设计值 A65_FALLRISK_START）
      if (d < rr.effective && (a.raw.kind !== "入门" || (typeof firstStart === "string" && firstStart < rr.effective))) continue;
      const prod = a.raw.kind === "入门" ? ss[0].product : isSwitch(a) ? a.raw.product : productAt(ss, d);
      if (productInfo(ctx.manifest, prod ?? "")?.age !== "a65") continue;
      const why = a.raw.kind === "入门" ? "建档" : isSwitch(a) ? "换到 65 岁以上版" : ASKS.find((x) => hasReason(a, x));
      if (!why) continue;
      const fr = a.raw.fallRisk;
      if (!isObj(fr)) { err(`${a.name} fallRisk`, `65 岁以上${why}要做跌倒风险自查（照成品第〇章《跌倒风险自查》的原话；npm run course -- assess 列出来）`); continue; }
      if (typeof fr.askedOn !== "string") continue;
      // 这次要重新问：事件之后做的问卷；不能照抄之前那份
      const ev = a.raw.eventDate;
      const evWhy = AFTER_EVENT.find((x) => hasReason(a, x));
      if (evWhy && typeof ev === "string" && fr.askedOn < ev) err(`${a.name} fallRisk.askedOn`, `${evWhy}（${ev}）之后要重新做一次问卷：这份问卷是 ${fr.askedOn} 做的，在那之前`);
      // 照抄：和更早写的一份记录的问卷日期、内容都一样（只报后写的这一份）
      const same = A.find((b) => b !== a && typeof b.raw?.date === "string" && (b.raw.date < d || (b.raw.date === d && b.name < a.name)) && sameJson(b.raw.fallRisk, fr));
      if (same) err(`${a.name} fallRisk`, `${why}要重新做一次问卷：这份问卷和 ${same.name} 那份一模一样（${fr.askedOn}），不能照抄；两件事一起的，写成一份记录`);
    }
    const all = fallRiskList(ctx);
    const within = (x: string) => x <= today && (dayStart(today) - dayStart(x)) / DAY <= 365;
    const recent = all.filter((x) => within(x.askedOn));
    const falls = fallDates(ctx);
    for (const fr of all) {
      const raw = fr.file.raw.fallRisk;
      const name = fr.file.name;
      const askedOn = fr.askedOn;
      // 头晕：问卷时另外问；问卷之前做的筛查（那天有效的那一份）和它对得上；测步态那天有效的筛查说经常头晕的不在家测
      const dz = screeningItem(p, /经常头晕/);
      if (dz && sd && sd <= askedOn && typeof raw.dizzy === "boolean" && raw.dizzy !== (dz.answer === "是")) {
        err(`${name} fallRisk.dizzy`, raw.dizzy ? `问卷说经常头晕，安全筛查"${dz.item}"却是"否"：人现在经常头晕，照实重做安全筛查` : `问卷之前做的安全筛查"${dz.item}"是"是"，问卷却说不经常头晕：照实答（经常头晕的不在家测步态）`);
      }
      // 问卷之后几天重做的筛查对头晕答得不一样：前后矛盾，提醒再确认（问卷那天自己说不头晕、当天测的步态不算违规）
      if (dz && sd && sd > askedOn && (dayStart(sd) - dayStart(askedOn)) / DAY <= 7 && typeof raw.dizzy === "boolean" && raw.dizzy !== (dz.answer === "是")) {
        warn(`${name} fallRisk.dizzy`, `问卷（${askedOn}）说${raw.dizzy ? "" : "不"}经常头晕，几天后的安全筛查（${sd}）"${dz.item}"却是"${dz.answer}"：照实再确认；经常头晕的不在家测步态，测过的告诉医生`);
      }
      if (dz?.answer === "是" && sd) {
        for (const def of rr.gait) {
          const v = raw[def.id];
          if (typeof v?.seconds === "number" && typeof v.testedOn === "string" && sd <= v.testedOn) err(`${name} fallRisk.${def.id}`, `测的那天（${v.testedOn}）有效的安全筛查（${sd}）"${dz.item}"是"是"：经常头晕的不在家测步态，不能记秒数`);
        }
      }
      if (!within(askedOn)) continue;
      // 和档案对得上（问卷照实答）：问卷之前 12 个月里档案记着的摔倒，一次一项。
      // 问卷那天的摔倒分不清先后：说跌倒过的算上（"2 次以上"要照实），说没跌倒过的不追溯（之后要有一份新的问卷，见下面）
      const fellNow = raw.general?.fell === true;
      const before = falls.filter((x) => (x < askedOn || (x === askedOn && fellNow)) && (dayStart(askedOn) - dayStart(x)) / DAY <= 365);
      if (before.length && raw.general?.fell === false) err(`${name} fallRisk.general.fell`, `档案里 ${before[before.length - 1]} 摔倒过，"在过去 12 个月内，你是否跌倒过？"却答了"否"：照实答`);
      if (before.length >= 2 && raw.severity?.twoPlus === false) err(`${name} fallRisk.severity.twoPlus`, `档案里过去 12 个月摔倒过 ${before.length} 次，"跌倒的次数是否大于等于 2 次"却答了"否"：照实答`);
      // 前一份说一年内跌倒过、不到一年的后一份说没有：档案里没有建档以前那次摔倒的日期，只提醒
      const prevFell = all.find((x) => x.askedOn < askedOn && x.file.raw.fallRisk.general?.fell === true && (dayStart(askedOn) - dayStart(x.askedOn)) / DAY <= 365);
      if (prevFell && raw.general?.fell === false) warn(`${name} fallRisk.general.fell`, `${prevFell.askedOn} 那份自查说过去 12 个月跌倒过，这一份却说没有：那次摔倒要是在 ${askedOn} 之前 12 个月以内，照实改成"是"`);
      // 先问医生：医生看过这份结果（fallRiskSeen），同意的日期在问卷之后 askedValidDays 天以内——每一份分别核对，新问卷盖不掉旧问卷
      const c = fr.conclusion;
      if (c.doctorFirst) {
        const seen = A.filter((a) => a.raw?.fallRiskSeen === true && typeof a.raw.date === "string" && a.raw.date >= askedOn);
        const cleared = seen.filter((a) => a.raw.doctorCleared === true && typeof a.raw.doctorDate === "string");
        const inTime = cleared.some((a) => a.raw.doctorDate >= askedOn && (dayStart(a.raw.doctorDate) - dayStart(askedOn)) / DAY <= rr.askedValidDays);
        const what = c.officialNeeded ? "过去 12 个月内跌倒过" : "是高风险";
        if (!seen.length) err(name, `跌倒风险自查${what}——先带着结果问医生，这份记录或之后的"看完医生回来"写 fallRiskSeen: true（医生看过这份自查结果），之前不出计划`);
        else if (!cleared.length) err(name, `跌倒风险自查${what}：医生看过结果、同意练以后（写 fallRiskSeen 的那份记录记 doctorCleared、doctorDate）才出计划`);
        else if (!inTime) err(name, `跌倒风险自查${what}：问卷是 ${askedOn} 做的，医生看结果、同意练要在那之后 ${rr.askedValidDays} 天以内——隔久了的，重新做一次问卷，再给医生看`);
      }
    }
    // 过去 12 个月内跌倒过（一年内任何一份自查这么说）：要有摔倒之后的正式跌倒风险评估
    const fellRec = recent.filter((x) => x.conclusion.officialNeeded).pop();
    if (fellRec) {
      const lastFall = falls.filter((d) => d <= today).pop();
      const ok = A.some((a) => isObj(a.raw?.official) && a.raw.official.afterFall === true && typeof a.raw.official.date === "string"
        && a.raw.official.date <= today && (!lastFall || a.raw.official.date >= lastFall) && (dayStart(today) - dayStart(a.raw.official.date)) / DAY <= 365);
      if (!ok) err(fellRec.file.name, `过去 12 个月内跌倒过：先去医生或社区卫生服务中心做一次正式的跌倒风险评估（要在${lastFall ? ` ${lastFall} 那次` : "最近一次"}摔倒之后），记 official { date, afterFall: true }；医生同意以后才出计划`);
    }
    // 高风险（不是因为跌倒过）：问卷之后 1～3 个月提醒随访
    for (const fr of recent) {
      if (fr.conclusion.effective !== "高" || fr.conclusion.officialNeeded) continue;
      const days = (dayStart(today) - dayStart(fr.askedOn)) / DAY;
      const followed = A.some((a) => isObj(a.raw?.official) && typeof a.raw.official.date === "string" && a.raw.official.date > fr.askedOn);
      if (days >= rr.highFollowup.min && !followed) warn(fr.file.name, `跌倒风险自查是高风险（${fr.askedOn}）：官方标准建议 1～3 个月后随访一次、再次评估——问问医生或社区卫生服务中心`);
    }
    const fr = all[all.length - 1];
    if (fr) {
      const raw = fr.file.raw.fallRisk;
      const name = fr.file.name;
      // 和问卷之前做的筛查对（之后单独重做的筛查是新的情况，不倒过来追溯）
      const fallItem = sd && sd <= fr.askedOn ? screeningItem(p, /最近一年摔倒过/) : undefined;
      if (raw.general?.fell === true && fallItem && fallItem.answer !== "是") err("档案.json screening", `跌倒风险自查说过去 12 个月跌倒过，安全筛查"${fallItem.item}"却答了"否"：照实重做筛查`);
      if (raw.needsSupport === true && fallItem && fallItem.answer !== "是") err("档案.json screening", `跌倒风险自查说在家走路也要扶墙或用助行器，安全筛查"${fallItem.item}"却答了"否"：照实重做筛查`);
      const wItem = screeningItem(p, /体重/);
      if (raw.frail?.weightLoss === true && wItem && wItem.answer !== "是") warn(`${name} fallRisk.frail.weightLoss`, `衰弱那一项说体重下降了，安全筛查"${wItem.item}"却答了"否"：照实再确认`);
      if (raw.frail?.weightLoss === false && wItem?.answer === "是") warn(`${name} fallRisk.frail.weightLoss`, `安全筛查说体重掉得明显，衰弱那一项却说体重没下降：照实再确认`);
      if (fr.conclusion.reassessBy && fr.conclusion.reassessBy < today) err(name, `跌倒风险自查约定 ${fr.conclusion.reassessBy} 再查：做触发评估（跌倒自查到期），之前不出课程`);
      // 每年一次：从最近一份问卷算，不跟着别的原因重做的筛查往后挪
      const yearly = addDays(fr.askedOn, yearDays ?? 365);
      if (a65Now && yearly < today) err(name, `跌倒风险自查是 ${fr.askedOn} 做的，已经超过一年：做触发评估（满一年或跌倒自查到期），重做一次，之前不出课程`);
    }
    // 摔倒以后要重做自查：档案里记着的最近一次摔倒，要有一份问卷在它之后（同一天的要说跌倒过）
    const lastFall = falls.filter((d) => d >= rr.effective && within(d)).pop();
    const covered = (d: string) => all.some((x) => x.askedOn > d || (x.askedOn === d && x.file.raw.fallRisk.general?.fell === true));
    if (a65Now && lastFall && !covered(lastFall)) {
      err("评估/", `${lastFall} 摔倒过，之后还没做跌倒风险自查：做触发评估（摔倒），带上问卷${fr ? `（最近一份是 ${fr.askedOn} 做的）` : ""}`);
    }
  } else if (A.some((a) => isObj(a.raw?.fallRisk))) warn("评估/", "模板还没有跌倒风险自查的规则（rules.json 的 fallRisk）：自查没核对，先把模板更新到 v3.2 之后");
  // 体重明显下降（65 岁以上）：重做筛查，"最近体重掉得明显"照实答
  const drops = [
    ...ss.filter((s) => ctx.reviewData[reviewDataName(s)]?.weightDrop === true).map((s) => s.start),
    ...A.filter((a) => a.raw?.weightDrop === true).map((a) => a.raw.date as string),
  ].filter((d) => (dayStart(today) - dayStart(d)) / DAY <= 365).sort();
  if (drops.length && a65Now) {
    const it = screeningItem(p, /体重/);
    const d = drops[drops.length - 1];
    if (it && (it.answer !== "是" || !(sd && sd >= d))) err("档案.json screening", `${d} 那一周说体重明显下降：重做安全筛查（"${it.item}"照实答），先问医生`);
  }
  for (const s of ss) {
    const rv = ctx.reviewData[reviewDataName(s)];
    if (!rv) continue;
    const sAge = productInfo(ctx.manifest, s.product)?.age === "a65" || personAge(ctx, s.start) === "a65" ? "a65" : productInfo(ctx.manifest, s.product)?.age;
    if (rv.weightDrop !== undefined && sAge !== "a65") err(`复盘/${reviewDataName(s)} weightDrop`, "weightDrop 只给 65 岁以上");
    if (rv.sickOrMeds === true && !(sd && sd >= s.start) && !A.some((a) => hasReason(a, "身体变化") && a.raw.date >= s.start)) {
      warn(`复盘/${reviewDataName(s)}`, "这一周生病或换了药：做触发评估（身体变化），重做安全筛查");
    }
    // habits 的键要是这份成品这种段型的打卡项
    // （减量段"照做不考核"的项记了也不算错，段末只是不数它）
    const known = new Set(ar.habits.filter((h) => h.products.includes(segCode(ctx.manifest, s.product))).map((h) => h.habit));
    for (const k of Object.keys(rv.habits ?? {})) if (!known.has(k)) err(`复盘/${reviewDataName(s)} habits.${k}`, `「${k}」不是这份成品的打卡项（有：${[...known].join("、") || "（没有）"}）`);
  }
  // BMI：只看最近一次筛查以后称的体重（评估里量的、减脂复盘里称的；称的那天是"记"）——筛查以前的旧体重不拿来推翻后来的筛查答案，
  // 改成不记也躲不开筛查以后量过的。评估里量的和复盘里称的分开核对：评估里量到 28 以上照实改筛查（报错），
  // 复盘称到的只提醒、下一次评估确认（一次周称重不停训练），复盘的提醒不顶掉评估的报错
  const todayB = localDate(ctx.now ?? new Date());
  type Weighed = ReturnType<typeof lastWeighed>;
  const afterScreen = (w: Weighed): Weighed => (w && (!sd || w.date >= sd) ? w : null);
  const lastA = afterScreen(lastWeighed(ctx, todayB, "评估"));
  const lastR = afterScreen(lastWeighed(ctx, todayB, "复盘"));
  const lastW = afterScreen(lastWeighed(ctx, todayB));
  const cuts = bmiCuts(ctx.manifest);
  const bmiAt = (w: { date: string; weight: number }) => bmiOf({ weight: w.weight }, entryHeight(ctx) ?? A.filter((a) => a.raw?.date === w.date && typeof a.raw?.body?.height === "number").pop()?.raw.body.height);
  if (lastW && !cuts) warn(lastW.where, "模板 manifest 里找不到 BMI 切点（BMI_CN、WEIGHT_LOW_CN）：BMI 没核对，先更新模板");
  else if (lastW && cuts) {
    const it = screeningItem(p, /BMI/);
    const bA = lastA ? bmiAt(lastA) : null;
    if (lastA && bA !== null && bA >= cuts.obese && it && it.answer !== "是") err(lastA.where, `BMI ${bA}（≥ ${cuts.obese}），安全筛查"${it.item}"却答了"否"：改成"是"，先问医生`);
    // 复盘称到的：只在它比最近一份评估新的时候提醒（评估量过、没到的，以评估为准）
    const bR = lastR && (!lastA || lastR.date > lastA.date) ? bmiAt(lastR) : null;
    if (lastR && bR !== null && bR >= cuts.obese && it && it.answer !== "是") {
      warn(lastR.where, `周复盘称的 BMI ${bR}（≥ ${cuts.obese}），安全筛查"${it.item}"还是"否"：下一次评估量体重确认，到了照实改成"是"、先问医生（改了以后医生同意之前不出课程）；没有减重的医生同意的，减脂下一周起退回保持`);
    }
    const bW = bmiAt(lastW);
    if (bW !== null && bW < cuts.low) warn(lastW.where, `BMI ${bW}（< ${cuts.low}，低体重）：不选减脂；饮食照成品，拿不准问医生`);
  }


  // 5. 中断、连着两周疼
  if (curInfo && curInfo.age !== "a06") {
    const g = gap(ctx, code, today);
    if (g) {
      const backed = A.some((a) => hasReason(a, "中断") && a.raw.date >= g.last);
      const restartDays = phaseOf(last) === "稳定" ? stableParam(ctx.rules, code, "回起始期的中断天数")?.number : undefined;
      if (restartDays !== undefined && g.days > restartDays) err("档案.json", `最后一次训练是 ${g.last}，已经断了 ${g.days} 天（超过 ${restartDays} 天）：做触发评估（中断），回到起始期那一份，从标准段第 1 周开始`);
      else if (g.long && !backed) err("档案.json", `最后一次训练是 ${g.last}，已经断了 ${g.days} 天（超过 ${g.longDays} 天）：先做触发评估（中断），问身体情况有没有变化`);
      else if (g.days > g.remindDays) warn("档案.json", `最后一次训练是 ${g.last}，断了 ${g.days} 天：照成品"不补作业、不清零、不从头再来"，回来第一次只做一半的量（course export 加 --half）`);
    }
    ss.forEach((s) => {
      const rv = ctx.reviewData[reviewDataName(s)];
      // 6–12 岁没有"训练"这一项：升初中以后，那几周不出这条提醒（CROSS_FAMILY_RESET）
      if (rv && rv.trainings === 0 && productInfo(ctx.manifest, s.product)?.age !== "a06") warn(`复盘/${reviewDataName(s)}`, "这一周没有训练：回来第一次只做一半的量（course export 加 --half）");
    });
    const trained = trainingDates(ss, ctx.sessions, ctx.reviewData, today);
    const longDays = ctx.rules ? longGapDays(ctx.rules, code) : 28;
    for (const a of A.filter((x) => hasReason(x, "中断"))) {
      const d = gapBefore(trained, gapBase(ctx), a.raw.date);
      if (d <= longDays) warn(a.name, `这份"中断"触发评估之前只断了 ${d} 天（不超过 ${longDays} 天）：不算长时间中断，稳定期不能按它找级`);
      if (d <= longDays && a.raw.body !== undefined) err(`${a.name} body`, `没有真的断过 ${longDays} 天以上：这份"中断"触发评估不能记身体数据（体重腰围只在入门、段末、周期末评估里记）`);
    }
    // 稳定期中间断过超过"回起始期的中断天数"、后来又接着练（不只看最近一次）：断之前在稳定期，
    // 断了以后新开的第一项要是起始期（跨周期、接着开下一个周期也算没回去）；断完以后没新开过一项、就在原来那一周接着练的也算
    for (let k = 1; k < trained.length; k++) {
      const from = productAtIndex(ss, trained[k - 1]);
      if (from < 0 || phaseOf(ss[from]) !== "稳定") continue;
      const info2 = productInfo(ctx.manifest, ss[from].product);
      const limit = info2 ? stableParam(ctx.rules, info2.code, "回起始期的中断天数")?.number : undefined;
      const days = Math.round((dayStart(trained[k]) - dayStart(trained[k - 1])) / DAY);
      if (limit === undefined || days <= limit) continue;
      // 断了以后：第一项起始期，或者第一项真的练过的（中间 0 次、重复本周的那几周跳过）
      const trainedIn = (j: number) => trained.some((d) => d >= ss[j].start && d < (j + 1 < ss.length ? ss[j + 1].start : "9999-12-31"));
      const next = ss.findIndex((x, j) => x.start > trained[k - 1] && (phaseOf(x) === "起始" || trainedIn(j)));
      if (next >= 0 && phaseOf(ss[next]) === "起始") continue;
      const at = next >= 0 ? next : productAtIndex(ss, trained[k]);
      err(`segments[${at}]`, `${trained[k - 1]} 到 ${trained[k]} 断了 ${days} 天（超过 ${limit} 天）还接着练稳定期：断了八周以上要做触发评估（中断），回到起始期那一份，从标准段第 1 周开始`);
      break;
    }
  }
  if (curInfo?.age === "a13") {
    for (let i = 1; i < ss.length; i++) {
      if (ctx.reviewData[reviewDataName(ss[i - 1])]?.symptoms === true && ctx.reviewData[reviewDataName(ss[i])]?.symptoms === true) {
        warn(`复盘/${reviewDataName(ss[i])}`, "连着两周都有疼痛：照成品，告诉家长、去看医生");
      }
    }
  }
  return out;
}

/** 某一天落在 segments 的哪一项（早于第一项返回 -1）。 */
function productAtIndex(ss: SegmentEntry[], date: string): number {
  for (let i = ss.length - 1; i >= 0; i--) if (date >= ss[i].start) return i;
  return -1;
}

function productAt(ss: SegmentEntry[], date: string): string | undefined {
  let hit: SegmentEntry | undefined;
  for (const s of ss) if (s.start <= date) hit = s;
  return (hit ?? ss[0])?.product;
}

/**
 * 最后一次训练：练习记录，和"训练数 > 0 的周复盘覆盖的那一周的最后一天"（下一项开始的前一天；拖长的周也算到那天）里较晚的；
 * 还没练过就按第一段开始那天。
 */
/** 中断从哪天起算：第一项不是 6–12 岁成品的那一段开始那天（6–12 岁没有"训练"这一项）；都是的按第一段。 */
function gapBase(ctx: AssessContext): string {
  const ss = ctx.profile.segments as SegmentEntry[];
  return ss.find((s) => productInfo(ctx.manifest, s.product)?.age !== "a06")?.start ?? ss[0].start;
}

export function gap(ctx: AssessContext, code: string, today: string): { last: string; days: number; remindDays: number; longDays: number; long: boolean } | null {
  const ar = assessRules(ctx.rules);
  if (!ar) return null;
  const remindDays = param(ar.assess, "中断提醒天数", code)?.number;
  const longDays = param(ar.assess, "长时间中断天数", code)?.number;
  if (remindDays === undefined || longDays === undefined) return null;
  const ss = ctx.profile.segments as SegmentEntry[];
  // 这一周有练习记录的，以练习记录为准；没有的，按这一周开始后的第 7 天算（trainingDates）；6–12 岁那几段不算（CROSS_FAMILY_RESET）
  const dates = [gapBase(ctx), ...trainingDates(ss, ctx.sessions, ctx.reviewData, today)];
  const last = dates.sort().pop()!;
  const days = Math.round((dayStart(today) - dayStart(last)) / DAY);
  return { last, days, remindDays, longDays, long: days > longDays };
}

/**
 * 这一周的有氧做稳态还是间歇（有氧不导出、没有练习记录，拦不了，只能让计划单和导出时的提示写对）：
 * 规则在 rules.cardio；有间歇的周，高血压（或没确认）而且没问过医生的做稳态，这一轮第 2 周的稳态自查没过（或没记）的做稳态。
 */
export function cardioMode(rules: RulesData | null, profile: Obj, product: { code: string; phase: string }, n: number, week: number, reviewData: Record<string, Obj>,
  opts: { severe?: boolean } = {}): { mode: string; why: string; duration?: string; interval: boolean } | null {
  const k = product.phase === "稳定" ? roundWeek(week) : week;
  // 这一阶段、这一轮第 k 周的行（阶段空着的两个阶段都用）
  const rows = (rules?.cardio ?? []).filter((c) => c.products.includes(product.code) && c.weeks.includes(k) && (c.phase ?? product.phase) === product.phase);
  if (!rows.length || !rules) return null;
  const interval = rows.some((c) => c.mode === "间歇");
  const hyper = rows.find((c) => c.when === "hypertensionNoDoctor");
  const out = (c: { mode: string; duration?: string } | undefined, why: string) => ({ mode: c?.mode === "间歇" ? "间歇" : "稳态", why, interval, ...(c?.duration ? { duration: c.duration } : {}) });
  // 认不出的写法（新的 when、新的模式）、缺了组合条件：一律稳态（保守），有"高血压没问过医生"那一行就照它的时长
  const KNOWN = ["always", "selfCheckPassed", "selfCheckFailed", "hypertensionNoDoctor", "severeObeseNoDoctor"];
  if (rows.some((c) => !KNOWN.includes(c.when) || (c.mode !== "间歇" && c.mode !== "稳态"))) return out(hyper ?? { mode: "稳态" }, "模板的有氧规则有这里不认识的写法：先按稳态做");
  const derived = rules.derivedConditions?.find((d) => d.name === "高血压没问过医生");
  if (!derived && hyper) return out(hyper, "模板缺少组合条件\"高血压没问过医生\"：先按保守的做法");
  const cond = (name: string): boolean => {
    const v = profile.conditions?.[name];
    return typeof v === "boolean" ? v : rules.conditions[name]?.default ?? true;
  };
  // BMI 37.5 以上（推出来的条件"重度肥胖"）而且有氧没问过医生：间歇的周一直稳态（只有有间歇的行写了这一条）
  const severeRow = rows.find((c) => c.when === "severeObeseNoDoctor");
  const derived2 = rules.derivedConditions?.find((d) => d.name === "重度肥胖没问过医生");
  if (severeRow && interval) {
    const severe = opts.severe ?? (typeof profile.conditions?.["重度肥胖"] === "boolean" ? profile.conditions["重度肥胖"]
      : (profile.screening?.answers ?? []).some((a: Obj) => /BMI/.test(a?.item ?? "") && a?.answer === "是"));
    const condS = (name: string) => (name === "重度肥胖" ? severe : cond(name));
    if (!derived2 || derived2.all.every((x) => condS(x.name) === x.value)) {
      return out(severeRow, "BMI 37.5 以上（或者没确认）而且没问过医生：间歇先问医生，没问之前继续做中等强度的稳态有氧");
    }
  }
  if (hyper && derived && derived.all.every((x) => cond(x.name) === x.value)) {
    return out(hyper, interval
      ? "有高血压（或没确认）而且没问过医生：间歇先问医生，没问之前继续做中等强度的稳态有氧"
      : "有高血压（或没确认）而且没问过医生：加时长、加坡度之前先问医生，没问之前保持第 2 周的强度");
  }
  if (!interval) {
    const always = rows.find((c) => c.when === "always");
    return out(always ?? rows[0], `${product.phase === "稳定" ? "每一轮" : "起始期"}第 ${k} 周`);
  }
  // 这一轮第 2 周的复盘（重复的周取最后一份）
  const ss = (profile.segments as SegmentEntry[]).filter((s) => s.n === n && s.week === week - k + 2);
  const rv = ss.length ? reviewData[reviewDataName(ss[ss.length - 1])] : undefined;
  if (rv?.steadyCheck === true) return out(rows.find((c) => c.when === "selfCheckPassed"), "这一轮第 2 周的稳态自查过了");
  return out(rows.find((c) => c.when === "selfCheckFailed"), rv?.steadyCheck === false ? "这一轮第 2 周的稳态自查没过：第 3–4 周继续稳态 20 分钟" : "这一轮第 2 周的稳态自查还没记：先自查，过了再上间歇");
}

/** 65 岁以上摔倒以后、医生同意之前：平衡动作不练。 */
export function balanceHold(ctx: AssessContext): boolean {
  const ss = (ctx.profile.segments ?? []) as SegmentEntry[];
  const cur = ss.length ? productInfo(ctx.manifest, ss[ss.length - 1].product) : null;
  if (cur?.age !== "a65" && personAge(ctx, localDate(ctx.now ?? new Date())) !== "a65") return false;
  const falls = fallDates(ctx);
  if (!falls.length) return false;
  const dd = ctx.profile.screening?.doctorDate;
  return !(ctx.profile.screening?.doctorCleared === true && typeof dd === "string" && dd >= falls[falls.length - 1]);
}
