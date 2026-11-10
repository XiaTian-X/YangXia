// 评估（v4 阶段 2）：入门、段末、触发三种评估记录 yangxia.assessment/1，年龄段和学段推算，中断和摔倒。
// 参数全部来自模板 rules.json 的 assess、nextRound、habits（content/rules/评估.md、下一轮.md、打卡.md），
// BMI 切点来自 manifest 的官方参数（BMI_CN、WEIGHT_LOW_CN）。结论由这里重算，评估记录里写的结论对不上就报错。
// 周期末评估属于稳定期（阶段 3），现在遇到就报"阶段 3 才有"。
import type { Manifest } from "./manifest.ts";
import type { PlansData, RulesData } from "./plan.ts";
import { localDate, reviewDataName, type SegmentEntry, type SessionFile } from "./progress.ts";
import type { Issue } from "./types.ts";

type Obj = Record<string, any>;
export const ASSESS_FORMAT = "yangxia.assessment/1";
export const KINDS = ["入门", "段末", "触发", "周期末"] as const;
export const REASONS = ["跨段", "满一年", "身体变化", "生病住院", "生病", "摔倒", "换场地", "中断", "看完医生回来"] as const;
const SWITCH_REASONS = ["跨段", "换场地"];
const TOP_KEYS = ["schema", "date", "kind", "product", "segment", "reasons", "base", "prereqs", "body", "tests", "companion", "doctorCleared", "doctorDate",
  "eventDate", "fallAssessDone", "weightDrop", "conclusion", "note"];
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

/** 成品名 → 代码（a18·bw）和年龄段。 */
export function productInfo(m: Manifest, name: string): { code: string; age: string } | null {
  const p = m.products.find((x) => x.name === name);
  return p ? { code: `${p.age}·${p.venue}`, age: p.age } : null;
}

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
    else if (p.body === "记" && !BODY_AGES.includes(p.age)) err("body", "体重、腰围只给 18–64 岁记（6–17 岁、65 岁以上不记）");
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
  else if (raw.kind === "周期末") err("kind", "周期末评估属于稳定期，阶段 3 才有");
  if (raw.product !== undefined && typeof raw.product !== "string") err("product", "product 是成品名");
  if (raw.kind === "段末" && !Number.isInteger(raw.segment)) err("segment", "段末评估要写是第几段（segment）");
  if (raw.kind === "触发") {
    if (!Array.isArray(raw.reasons) || !raw.reasons.length || raw.reasons.some((x: unknown) => !(REASONS as readonly string[]).includes(x as string))) {
      err("reasons", `触发评估写原因 reasons：${REASONS.join("、")}`);
    } else if (raw.reasons.some((x: string) => x === "摔倒" || x === "生病住院") && !(typeof raw.eventDate === "string" && DATE.test(raw.eventDate))) {
      err("eventDate", "摔倒、生病住院的触发评估要写那天的日期 eventDate（医生同意要在它之后）");
    }
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
  for (const k of ["companion", "doctorCleared", "fallAssessDone"]) if (raw[k] !== undefined && typeof raw[k] !== "boolean") err(k, `${k} 是 true / false`);
  if (raw.doctorDate !== undefined && !(typeof raw.doctorDate === "string" && DATE.test(raw.doctorDate))) err("doctorDate", "doctorDate 写成 YYYY-MM-DD");
  if (raw.eventDate !== undefined && !(typeof raw.eventDate === "string" && DATE.test(raw.eventDate))) err("eventDate", "eventDate 写成 YYYY-MM-DD");
  if (raw.conclusion !== undefined && !isObj(raw.conclusion)) err("conclusion", "conclusion 是对象（照 course assess 的输出写）");
  if (raw.note !== undefined && (typeof raw.note !== "string" || raw.note.length > 500)) err("note", "note 最多 500 字");
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
export function segmentEnd(profile: Obj, n: number, reviewData: Record<string, Obj>, rules: NonNullable<ReturnType<typeof assessRules>>, code: string, extra?: { dizzy?: number }): EndConclusion | { error: string } {
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
  const ordered = mine.filter((r) => !r.extra).sort((x, y) => (x.order ?? 0) - (y.order ?? 0));
  let hit = ordered.find((r) => r.when.every(test));
  if (!hit) return { error: `第 ${n} 段的数字（训练 ${nums.trainings}）对不上下一轮.md 的任何一条` };
  let downgraded = false;
  if (hit.upward && nums.symptoms) {
    const same = ordered.find((r) => r.result === "原样" && !r.upward);
    if (!same) return { error: `第 ${n} 段有不适，往上的结论要降为"原样"，但下一轮.md 里这份成品这种段型没有不往上的"原样"那一条` };
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
const hasReason = (a: AssessFile, r: string) => a.raw?.kind === "触发" && Array.isArray(a.raw.reasons) && a.raw.reasons.includes(r);
const isSwitch = (a: AssessFile) => a.raw?.kind === "触发" && Array.isArray(a.raw.reasons) && a.raw.reasons.some((x: string) => SWITCH_REASONS.includes(x)) && typeof a.raw.product === "string";
const segCode = (m: Manifest, name: string) => productInfo(m, name)?.code ?? "";

/** 摔倒的日期：周复盘里有 falls 的那一周——有同一周的"摔倒"触发评估就用它的 eventDate，没有就按那一周的最后一天；加上"摔倒"触发评估自己的 eventDate。 */
function fallDates(ctx: AssessContext): string[] {
  const ss = (ctx.profile.segments ?? []) as SegmentEntry[];
  const trig = ctx.assessments.filter((a) => hasReason(a, "摔倒") && typeof a.raw.eventDate === "string").map((a) => a.raw.eventDate as string);
  const out = [...trig];
  for (const s of ss) {
    if (productInfo(ctx.manifest, s.product)?.age !== "a65" || !((ctx.reviewData[reviewDataName(s)]?.falls ?? 0) > 0)) continue;
    const end = addDays(s.start, 6);
    const inWeek = trig.filter((d) => d >= s.start && d <= end).sort();
    out.push(inWeek.length ? inWeek[inWeek.length - 1] : end);
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
  const age = cur?.age ?? p.age;
  const ev: DoctorEvent[] = [];
  const sd = typeof sc.date === "string" ? sc.date : "";
  if (age === "a65") ev.push({ date: sd, reason: "65 岁以上开始前都要先问医生" });
  if ((sc.answers ?? []).some((a: Obj) => a?.answer === "是")) ev.push({ date: sd, reason: "安全筛查有\"是\"" });
  for (const a of ctx.assessments) {
    if (a.raw?.prereqs && Object.values(a.raw.prereqs).some((v) => v === false)) ev.push({ date: a.raw.date, reason: "40–64 岁的体检或血压还没确认" });
    if (hasReason(a, "生病住院") && typeof a.raw.eventDate === "string") ev.push({ date: a.raw.eventDate, reason: "生病、住院过" });
    if (a.raw?.kind === "段末" && a.raw.conclusion?.next === "不开") ev.push({ date: a.raw.date, reason: "段末结论是\"先看医生\"" });
    if (isSwitch(a) && productInfo(ctx.manifest, a.raw.product)?.age === "a65") ev.push({ date: a.raw.date, reason: "换到 65 岁以上版" });
  }
  if (age === "a65") for (const d of fallDates(ctx)) ev.push({ date: d, reason: "摔倒过" });
  return ev.filter((e) => e.date).sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : 0));
}

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
  const timing = asEntry ? "入门" : r.kind === "段末" ? "段末" : null;
  const tests = (r.tests ?? []) as Obj[];
  for (const [i, t] of tests.entries()) {
    const def = ar.assess.tests.find((x) => x.id === t.id && x.products.includes(info.code));
    if (!def) { err(`tests[${i}]`, `测试项「${t.id}」不属于${product}（模板 评估.md 的测试项表）`); continue; }
    if (!timing || !def.timing.includes(timing)) { err(`tests[${i}]`, `「${t.id}」只在${def.timing.join("、")}评估里记`); continue; }
    const extraKeys = Object.keys(t).filter((k) => k !== "id" && !def.fields.includes(k));
    if (extraKeys.length) err(`tests[${i}]`, `「${t.id}」只记 ${def.fields.join("、")}，多了 ${extraKeys.join("、")}`);
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
      if (!tests.some((t) => t.id === def.id)) err("tests", `${timing}要记「${def.id}」（${def.note.split("；")[0]}）`);
    }
  }
  // 身体数据
  const b = r.body;
  if (b !== undefined) {
    if (!BODY_AGES.includes(info.age)) err("body", info.age === "a65" ? "65 岁以上不记身高、体重、腰围的数字（只问体重有没有明显下降）" : "6–17 岁不记身高、体重、腰围、BMI");
    else if (ctx.profile.body !== "记") err("body", `档案选了${ctx.profile.body === "停记" ? "停记" : "不记"}体重腰围，评估里不能有身体数据`);
    else if (!timing) err("body", "身体数据只在入门、段末评估里记");
  }
  if (timing && BODY_AGES.includes(info.age) && ctx.profile.body === "记") {
    const want = timing === "入门" ? ["height", "weight", "waist"] : ["weight", "waist"];
    const lack = want.filter((k) => typeof b?.[k] !== "number");
    if (lack.length) err("body", `档案选了记体重腰围：${timing}要记 ${want.join("、")}，少了 ${lack.join("、")}`);
  }
  if (r.weightDrop !== undefined && (info.age !== "a65" || typeof r.weightDrop !== "boolean")) err("weightDrop", "weightDrop（体重有没有明显下降，是 / 否）只给 65 岁以上");
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
  if (hasReason(f, "满一年") && info.age === "a65" && typeof r.fallAssessDone !== "boolean") err("fallAssessDone", "65 岁以上满一年复评要问：这一年做过跌倒风险评估没有（是 / 否）");
  // 结论
  const want = recordConclusion(ctx, f, product, asEntry);
  if (r.conclusion !== undefined && want && !sameJson(r.conclusion, want)) {
    err("conclusion", `写的结论和按规则重算的不一致：应该是 ${JSON.stringify(want)}（用 npm run course -- assess 算）`);
  } else if (r.conclusion === undefined && want && Object.keys(want).length) err("conclusion", `缺结论：应该是 ${JSON.stringify(want)}`);
  return out;
}

function entryHeight(ctx: AssessContext): number | undefined {
  return ctx.assessments.map((a) => a.raw).filter((x) => x.kind === "入门" || x.kind === "触发").map((x) => x.body?.height).find((h) => typeof h === "number");
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
  const bmi = bmiOf(r.body, entryHeight(ctx));
  if (cuts && bmi !== null && BODY_AGES.includes(info.age)) {
    out.bmi = bmi;
    out.bmiClass = bmiClass(bmi, cuts);
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

  // 2. 段末评估和下一段；换成品；中途重来
  const enders = byKind("段末");
  for (const a of enders) {
    const seg = segOf(a.raw.segment);
    if (!seg.length) { err(a.name, `没有第 ${a.raw.segment} 段`); continue; }
    out.push(...checkRecord(ctx, a, seg[0].product, false));
  }
  for (const { s, i } of segStarts.slice(1)) {
    const prev = ss[i - 1];
    const prevSeg = segOf(prev.n);
    const info = productInfo(ctx.manifest, s.product);
    const prevInfo = productInfo(ctx.manifest, prevSeg[0].product);
    const rs = (s as Obj).restart;
    if (prev.week === 4) {
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
      } else if (s.product === prev.product || s.type !== "标准") {
        const want = c.next === "减量" ? "减量" : "标准";
        if (s.type !== want) err(`segments[${i}].type`, `第 ${prev.n} 段段末的结论是"${c.result}"，下一段要是${want}段，写的是${s.type}段`);
      }
      if (s.product === prev.product && !sameJson((s as Obj).habitTargets ?? {}, c.habitTargets)) {
        err(`segments[${i}].habitTargets`, `按第 ${prev.n} 段段末，下一段的习惯目标应该是 ${JSON.stringify(c.habitTargets)}，写的是 ${JSON.stringify((s as Obj).habitTargets ?? {})}`);
      }
    } else if (rs) {
      // 中途重来：段型、习惯目标照被中断的那一段
      if (s.type !== prevSeg[0].type) err(`segments[${i}].type`, `从第 1 周重来，段型照被中断的第 ${prev.n} 段（${prevSeg[0].type}段）`);
      if (!sameJson((s as Obj).habitTargets ?? {}, (prevSeg[0] as Obj).habitTargets ?? {})) err(`segments[${i}].habitTargets`, `从第 1 周重来，习惯目标照被中断的第 ${prev.n} 段：${JSON.stringify((prevSeg[0] as Obj).habitTargets ?? {})}`);
    } else if ((s as Obj).habitTargets !== undefined) {
      err(`segments[${i}].habitTargets`, "习惯目标只能来自上一段的段末结论");
    }
    // 换成品：触发评估（跨段、换场地），带上新成品入门的项目；换了年龄段还要重新筛查
    if (s.product !== prev.product) {
      const sw = A.filter((a) => isSwitch(a) && a.raw.product === s.product && a.raw.date <= s.start && a.raw.date >= prevSeg[0].start);
      if (!sw.length) err(`segments[${i}]`, `换成「${s.product}」要有触发评估（跨段或换场地，product 写新成品），带上新成品入门要问、要测的项`);
      else if (info && prevInfo && info.age !== prevInfo.age) {
        const t = sw[sw.length - 1];
        if (!sd || sd < t.raw.date) err(`segments[${i}]`, `从${prevInfo.age}换到${info.age}：要按新年龄段重新做安全筛查（档案 screening.date 不早于换段的触发评估 ${t.raw.date}）`);
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
  for (const a of byKind("触发")) {
    // 跨段、换场地：按新成品的入门核对（开工前提、第〇章的测试、身体数据）
    out.push(...checkRecord(ctx, a, isSwitch(a) ? a.raw.product : productAt(ss, a.raw.date) ?? ss[0].product, isSwitch(a)));
  }

  // 3. 跨段
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
    const atStart = ageAt(p, curStart.start, ar.assess);
    if (atStart.stage && p.stage !== atStart.stage && STAGE_AGE[p.stage] === atStart.age) err("档案.json stage", `这一段开始那天推算是${atStart.stage}，档案写的是${p.stage}：改 stage，重算上床时间`);
    const atNow = ageAt(p, today, ar.assess);
    if (atNow.age === "a65" && curInfo.age !== "a65") err("档案.json", "已经满 65 岁：要换 65 岁以上版（重新筛查、医生同意），不等这一段练完（A65_SWITCH）");
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
  if (curInfo?.age === "a65") {
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
  // 体重明显下降（65 岁以上）：重做筛查，"最近体重掉得明显"照实答
  const drops = [
    ...ss.filter((s) => ctx.reviewData[reviewDataName(s)]?.weightDrop === true).map((s) => s.start),
    ...A.filter((a) => a.raw?.weightDrop === true).map((a) => a.raw.date as string),
  ].sort();
  if (drops.length && curInfo?.age === "a65") {
    const it = screeningItem(p, /体重/);
    const d = drops[drops.length - 1];
    if (it && (it.answer !== "是" || !(sd && sd >= d))) err("档案.json screening", `${d} 那一周说体重明显下降：重做安全筛查（"${it.item}"照实答），先问医生`);
  }
  for (const s of ss) {
    const rv = ctx.reviewData[reviewDataName(s)];
    if (!rv) continue;
    const sAge = productInfo(ctx.manifest, s.product)?.age;
    if (rv.weightDrop !== undefined && sAge !== "a65") err(`复盘/${reviewDataName(s)} weightDrop`, "weightDrop 只给 65 岁以上");
    if (rv.sickOrMeds === true && !(sd && sd >= s.start) && !A.some((a) => hasReason(a, "身体变化") && a.raw.date >= s.start)) {
      warn(`复盘/${reviewDataName(s)}`, "这一周生病或换了药：做触发评估（身体变化），重做安全筛查");
    }
    // habits 的键要是这份成品这种段型的打卡项
    const known = new Set(ar.habits.filter((h) => h.products.includes(segCode(ctx.manifest, s.product)) && h.segments.includes(s.type)).map((h) => h.habit));
    for (const k of Object.keys(rv.habits ?? {})) if (!known.has(k)) err(`复盘/${reviewDataName(s)} habits.${k}`, `「${k}」不是这份成品${s.type}段的打卡项（有：${[...known].join("、") || "（没有）"}）`);
  }
  // BMI：只看最新一份身体数据
  const bodies = A.filter((a) => typeof a.raw?.body?.weight === "number").sort((x, y) => (x.raw.date < y.raw.date ? -1 : 1));
  if (bodies.length) {
    const cuts = bmiCuts(ctx.manifest);
    const lastBody = bodies[bodies.length - 1];
    const bmi = bmiOf(lastBody.raw.body, entryHeight(ctx));
    if (!cuts) warn(lastBody.name, "模板 manifest 里找不到 BMI 切点（BMI_CN、WEIGHT_LOW_CN）：BMI 没核对，先更新模板");
    else if (bmi !== null && bmi >= cuts.obese) {
      const it = screeningItem(p, /BMI/);
      if (it && it.answer !== "是") err(`${lastBody.name} body`, `BMI ${bmi}（≥ ${cuts.obese}），安全筛查"${it.item}"却答了"否"：改成"是"，先问医生`);
    } else if (bmi !== null && bmi < cuts.low) warn(`${lastBody.name} body`, `BMI ${bmi}（< ${cuts.low}，低体重）：不选减脂；饮食照成品，拿不准问医生`);
  }

  // 5. 中断、连着两周疼
  if (curInfo && curInfo.age !== "a06") {
    const g = gap(ctx, code, today);
    if (g) {
      const backed = A.some((a) => hasReason(a, "中断") && a.raw.date >= g.last);
      if (g.long && !backed) err("档案.json", `最后一次训练是 ${g.last}，已经断了 ${g.days} 天（超过 ${g.longDays} 天）：先做触发评估（中断），问身体情况有没有变化`);
      else if (g.days > g.remindDays) warn("档案.json", `最后一次训练是 ${g.last}，断了 ${g.days} 天：照成品"不补作业、不清零、不从头再来"，回来第一次只做一半的量（course export 加 --half）`);
    }
    ss.forEach((s) => {
      const rv = ctx.reviewData[reviewDataName(s)];
      if (rv && rv.trainings === 0) warn(`复盘/${reviewDataName(s)}`, "这一周没有训练：回来第一次只做一半的量（course export 加 --half）");
    });
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

function productAt(ss: SegmentEntry[], date: string): string | undefined {
  let hit: SegmentEntry | undefined;
  for (const s of ss) if (s.start <= date) hit = s;
  return (hit ?? ss[0])?.product;
}

/**
 * 最后一次训练：练习记录，和"训练数 > 0 的周复盘覆盖的那一周的最后一天"（下一项开始的前一天；拖长的周也算到那天）里较晚的；
 * 还没练过就按第一段开始那天。
 */
export function gap(ctx: AssessContext, code: string, today: string): { last: string; days: number; remindDays: number; longDays: number; long: boolean } | null {
  const ar = assessRules(ctx.rules);
  if (!ar) return null;
  const remindDays = param(ar.assess, "中断提醒天数", code)?.number;
  const longDays = param(ar.assess, "长时间中断天数", code)?.number;
  if (remindDays === undefined || longDays === undefined) return null;
  const ss = ctx.profile.segments as SegmentEntry[];
  const dates: string[] = [ss[0].start];
  for (const s of ctx.sessions) {
    const t = Date.parse(s.raw?.startedAt);
    if (!Number.isNaN(t)) dates.push(localDate(new Date(t)));
  }
  ss.forEach((s, i) => {
    const rv = ctx.reviewData[reviewDataName(s)];
    if (!(rv && rv.trainings > 0)) return;
    const end = i + 1 < ss.length ? addDays(ss[i + 1].start, -1) : addDays(s.start, 6);
    dates.push(end < today ? end : today);
  });
  const last = dates.sort().pop()!;
  const days = Math.round((dayStart(today) - dayStart(last)) / DAY);
  return { last, days, remindDays, longDays, long: days > longDays };
}

/** 65 岁以上摔倒以后、医生同意之前：平衡动作不练。 */
export function balanceHold(ctx: AssessContext): boolean {
  const ss = (ctx.profile.segments ?? []) as SegmentEntry[];
  const cur = ss.length ? productInfo(ctx.manifest, ss[ss.length - 1].product) : null;
  if (cur?.age !== "a65") return false;
  const falls = fallDates(ctx);
  if (!falls.length) return false;
  const dd = ctx.profile.screening?.doctorDate;
  return !(ctx.profile.screening?.doctorCleared === true && typeof dd === "string" && dd >= falls[falls.length - 1]);
}
