// 65 岁以上的跌倒风险自查（v4 阶段 3c）：照 WS/T 887—2026 第 5 章的问法、测法和分级。
// 问法、判定线、参数来自模板 rules.json 的 fallRisk（content/rules/跌倒风险.md）；这里只管记录的写法和结论怎么算。
// 这是在家做的自查，不是正式的跌倒风险评估；结论只决定"先不先问医生、要不要先做正式评估、多久再查"，不放宽任何现有规则。
import type { RulesData } from "./plan.ts";
import type { Issue } from "./types.ts";

type Obj = Record<string, any>;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const DAY = 86_400_000;
const dayStart = (d: string) => new Date(`${d}T00:00:00`).getTime();
const addDays = (d: string, n: number) => {
  const t = new Date(dayStart(d) + n * DAY + 12 * 3_600_000);
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`;
};

export interface FallRiskRules {
  effective: string;
  questions: { id: string; part: string; clause: string; who: string; quotes: { section: string; text: string }[] }[];
  frail: { id: string; quotes: { section: string; text: string }[] }[];
  noHomeGait: { id: string }[];
  gait: { id: "walk4m" | "tug"; official: string; line: number; margin: number; distance?: number }[];
  frailMin: number;
  midDays: number;
  askedValidDays: number;
  highFollowup: { min: number; max: number };
}

export function fallRiskRules(rules: RulesData | null | undefined): FallRiskRules | null {
  const f = (rules as Obj | null | undefined)?.fallRisk;
  return isObj(f) && Array.isArray(f.questions) && Array.isArray(f.gait) && typeof f.effective === "string" ? (f as FallRiskRules) : null;
}

export const GENERAL = ["fell", "unsteady", "fear"] as const;
export const SELF_ONLY = ["unsteady", "fear"] as const;
export const SEVERITY = ["twoPlus", "medical", "helpUp", "syncope"] as const;
export const FRAIL = ["fatigue", "stairs", "walk", "illness", "weightLoss"] as const;
/** 没测成的客观原因（算 gaitIncomplete）。 */
export const UNTESTED = ["场地不够", "椅子不合要求", "家人不在", "本人不想测", "中途停下"] as const;
/** 按规则不测的原因（不算 gaitIncomplete）。 */
export const SKIPPED = ["跌倒过", "高风险", "走路要扶", "站起困难", "经常头晕"] as const;
const STOPS = ["头晕", "腿软", "身体晃"];
const LEVELS = ["低", "中", "高"] as const;
type Level = (typeof LEVELS)[number];
const rank = (l: Level) => LEVELS.indexOf(l);
const maxLevel = (a: Level, b: Level): Level => (rank(a) >= rank(b) ? a : b);

/** fallRisk 的写法（不看档案、不看规则）。 */
export function validateFallRisk(fr: unknown, path = "fallRisk"): Issue[] {
  const out: Issue[] = [];
  const err = (p: string, message: string) => out.push({ level: "error", path: `${path}${p ? "." + p : ""}`, message });
  if (!isObj(fr)) return [{ level: "error", path, message: "fallRisk 是对象：{ askedOn, general, severity?, frail?, needsSupport, hardToStand, walk4m?, tug? }" }];
  const KEYS = ["askedOn", "general", "severity", "frail", "needsSupport", "hardToStand", "walk4m", "tug"];
  const extra = Object.keys(fr).filter((k) => !KEYS.includes(k));
  if (extra.length) err("", `只能有 ${KEYS.join("、")}；多了 ${extra.join("、")}（不记病名、用药、体重数字）`);
  if (typeof fr.askedOn !== "string" || !DATE.test(fr.askedOn)) err("askedOn", "askedOn 是问卷做的日期 YYYY-MM-DD");
  const g = fr.general;
  if (!isObj(g) || typeof g.fell !== "boolean" || SELF_ONLY.some((k) => !(typeof g[k] === "boolean" || g[k] === null))
    || Object.keys(g).some((k) => !(GENERAL as readonly string[]).includes(k))) {
    err("general", "general 是 { fell, unsteady, fear }：fell 是 true / false；unsteady、fear 只问老人本人，本人说不清的写 null");
  }
  const bools = (v: unknown, keys: readonly string[]) => isObj(v) && keys.every((k) => typeof v[k] === "boolean") && Object.keys(v).every((k) => keys.includes(k));
  if (fr.severity !== undefined && !bools(fr.severity, SEVERITY)) err("severity", `severity 是 { ${SEVERITY.join(", ")} }，每项 true / false`);
  if (fr.frail !== undefined && !bools(fr.frail, FRAIL)) err("frail", `frail 是 { ${FRAIL.join(", ")} }，每项 true / false（疾病只记有没有 5 种或更多，不记病名；体重只记是 / 否）`);
  for (const k of ["needsSupport", "hardToStand"]) if (typeof fr[k] !== "boolean") err(k, `${k}（在家走路也要扶墙或用助行器 / 扶着椅子也很难自己站起来）是 true / false`);
  for (const t of ["walk4m", "tug"] as const) {
    const v = fr[t];
    if (v === undefined) continue;
    if (!isObj(v)) { err(t, `${t} 是对象`); continue; }
    if (typeof v.seconds === "number") {
      const keys = ["seconds", "cane", "siteOk", "testedOn", ...(t === "tug" ? ["chairOk"] : [])];
      if (!(v.seconds > 0 && v.seconds < 600) || Math.round(v.seconds * 10) !== v.seconds * 10) err(`${t}.seconds`, "seconds 是正数，最多一位小数（往大里取：5.04 记 5.1）");
      for (const k of keys.slice(1)) if (k === "testedOn" ? !(typeof v[k] === "string" && DATE.test(v[k])) : typeof v[k] !== "boolean") err(`${t}.${k}`, k === "testedOn" ? "testedOn 是测的日期" : `${k} 是 true / false`);
      if (Object.keys(v).some((k) => !keys.includes(k))) err(t, `测了的只能有 ${keys.join("、")}`);
    } else if (v.result === "没测成") {
      if (!(UNTESTED as readonly string[]).includes(v.reason)) err(`${t}.reason`, `没测成的原因只能是 ${UNTESTED.join(" / ")}`);
      if (v.reason === "中途停下" && !STOPS.includes(v.stopReason)) err(`${t}.stopReason`, `中途停下要写 stopReason：${STOPS.join(" / ")}`);
      if (Object.keys(v).some((k) => !["result", "reason", "stopReason", "testedOn"].includes(k))) err(t, "没测成的只能有 result、reason、stopReason、testedOn");
    } else if (v.result === "按规则不测") {
      if (!(SKIPPED as readonly string[]).includes(v.reason)) err(`${t}.reason`, `按规则不测的原因只能是 ${SKIPPED.join(" / ")}`);
      if (Object.keys(v).some((k) => !["result", "reason"].includes(k))) err(t, "按规则不测的只能有 result、reason");
    } else err(t, `${t} 写 { seconds, cane, siteOk, testedOn } 或者 { result: "没测成" / "按规则不测", reason }`);
  }
  return out;
}

/** 正式跌倒风险评估的写法：{ date, afterFall, level? }。 */
export function validateOfficial(v: unknown, path = "official"): Issue[] {
  if (!isObj(v) || typeof v.date !== "string" || !DATE.test(v.date) || typeof v.afterFall !== "boolean"
    || (v.level !== undefined && !(LEVELS as readonly string[]).includes(v.level)) || Object.keys(v).some((k) => !["date", "afterFall", "level"].includes(k))) {
    return [{ level: "error", path, message: "official 是医生或社区做的正式跌倒风险评估 { date, afterFall（是不是在最近一次摔倒之后做的）, level?（低 / 中 / 高，照医生说的） }" }];
  }
  return [];
}

export interface FallRiskConclusion {
  /** 标准等级（只用得到的答案和测出来的结果）；定不了写"未定"。 */
  level: Level | "未定";
  /** "未定"时可能的最高一级。 */
  worst: Level | null;
  /** 处理用的等级：合了正式评估以后的（自查未定的照正式评估，两边都定得了的取高的；没有正式等级的未定照 worst）。 */
  effective: Level;
  gaitOfficial: boolean;
  gaitMargin: boolean;
  gaitIncomplete: boolean;
  doctorFirst: boolean;
  officialNeeded: boolean;
  /** 6 个月复评的日期；每年的那一次跟复筛一起，不写在这里。 */
  reassessBy: string | null;
}

/** 这份记录不在家测步态的原因（有就不能有秒数）。 */
export function noHomeGait(fr: Obj, frailMin: number, dizzy: boolean): string | null {
  const g = fr.general ?? {};
  if (g.fell === true) return "跌倒过";
  if (severityPositive(fr, frailMin) === true) return "高风险";
  if (fr.needsSupport === true) return "走路要扶";
  if (fr.hardToStand === true) return "站起困难";
  if (dizzy) return "经常头晕";
  return null;
}

function severityPositive(fr: Obj, frailMin: number): boolean | null {
  if (!isObj(fr.severity) || !isObj(fr.frail)) return null;
  const frailCount = FRAIL.filter((k) => fr.frail[k] === true).length;
  return SEVERITY.some((k) => fr.severity[k] === true) || frailCount >= frailMin;
}

/** 每项步态的结果：阳性（官方线）、阴性、没得到。 */
function gaitStatus(fr: Obj, rr: FallRiskRules): { pos: boolean | null; official: boolean; margin: boolean; incomplete: boolean } {
  let anyPos = false, allNeg = true, margin = false, incomplete = false;
  for (const def of rr.gait) {
    const v = fr[def.id];
    if (typeof v?.seconds === "number") {
      const limit = def.id === "walk4m" && def.distance ? def.distance / def.line : def.line;
      const pos = v.seconds > limit + 1e-9;
      const okSite = v.siteOk === true && (def.id !== "tug" || v.chairOk === true);
      if (!okSite) { allNeg = false; incomplete = true; continue; }     // 场地、椅子不合要求的按没测成
      if (pos) anyPos = true;
      else if (v.seconds >= def.margin - 1e-9) margin = true;
    } else {
      allNeg = false;
      if (v?.result === "没测成" || v === undefined) incomplete = true;
    }
  }
  return { pos: anyPos ? true : allNeg ? false : null, official: anyPos, margin, incomplete };
}

/**
 * 结论（照 5.1.4、5.2.1；"未定"照设计值 A65_UNDETERMINED：没得到的项当阳性、当阴性各算一遍，不一样就是未定）。
 * dizzy：安全筛查"经常头晕，或者站起来时眼前发黑"答了"是"。official：这份记录里的正式评估。
 */
export function fallRiskConclusion(fr: Obj, rr: FallRiskRules, opts: { dizzy?: boolean; official?: Obj } = {}): FallRiskConclusion {
  const g = fr.general ?? {};
  const gVals = GENERAL.map((k) => g[k]);
  const gen: boolean | null = gVals.some((v) => v === true) ? true : gVals.some((v) => v === null || v === undefined) ? null : false;
  const sev = severityPositive(fr, rr.frailMin);
  const gait = gaitStatus(fr, rr);
  const levels = new Set<Level>();
  for (const gv of gen === null ? [false, true] : [gen]) {
    if (!gv) { levels.add("低"); continue; }
    if (sev === true) { levels.add("高"); continue; }
    if (sev === null) { levels.add("低"); levels.add("中"); levels.add("高"); continue; }    // 没问严重程度（写法错误另外报）
    for (const v of gait.pos === null ? [false, true] : [gait.pos]) levels.add(v ? "中" : "低");
  }
  const list = [...levels].sort((a, b) => rank(a) - rank(b));
  const level: Level | "未定" = list.length === 1 ? list[0] : "未定";
  const worst: Level | null = list.length === 1 ? null : list[list.length - 1];
  const off = opts.official;
  const offLevel: Level | null = off && (LEVELS as readonly string[]).includes(off.level) && typeof off.date === "string"
    && Math.abs(dayStart(off.date) - dayStart(fr.askedOn)) <= 365 * DAY ? off.level : null;
  const self: Level = level === "未定" ? worst! : level;
  const effective: Level = offLevel ? (level === "未定" ? offLevel : maxLevel(level, offLevel)) : self;
  const doctorFirst = g.fell === true || effective === "高";
  const general = gen === false;
  // 6 个月再查：中风险、按留余量的线阳性，或者一般性全阴性的人步态按官方线阳性（标准等级仍是低）
  const reassessBy = !doctorFirst && (effective === "中" || gait.margin || gait.official) && typeof fr.askedOn === "string" ? addDays(fr.askedOn, rr.midDays) : null;
  return {
    level, worst, effective,
    gaitOfficial: gait.official, gaitMargin: gait.margin && !gait.official,
    // 一般性全阴性的人（标准到这里就结束了）没测成不算"没测成"：标准等级就是低风险
    gaitIncomplete: !general && gait.incomplete && noHomeGait(fr, rr.frailMin, !!opts.dizzy) === null,
    doctorFirst, officialNeeded: g.fell === true, reassessBy,
  };
}

/** 只看这一份记录就能查出来的矛盾。dizzy：筛查"经常头晕"答"是"。 */
export function fallRiskIssues(fr: Obj, rr: FallRiskRules, opts: { dizzy?: boolean; path?: string } = {}): Issue[] {
  const out: Issue[] = [];
  const path = opts.path ?? "fallRisk";
  const err = (p: string, message: string) => out.push({ level: "error", path: `${path}${p ? "." + p : ""}`, message });
  const g = fr.general ?? {};
  const gen = GENERAL.some((k) => g[k] === true) || SELF_ONLY.some((k) => g[k] === null);
  if (gen && (!isObj(fr.severity) || !isObj(fr.frail))) err("severity", "一般性 3 问有\"是\"（或者第 2、3 问老人说不清）：接着问严重程度 4 问和衰弱 5 条（severity、frail）");
  if (!gen && (fr.severity !== undefined || fr.frail !== undefined)) err("severity", "一般性 3 问都是\"否\"，问卷到这里结束：不写严重程度和衰弱");
  if (g.fell === false && isObj(fr.severity) && SEVERITY.some((k) => fr.severity[k] === true)) err("severity", "第 1 问说过去 12 个月没跌倒过，严重程度 4 问（问的都是跌倒的情况）却有\"是\"：前后对不上，照实重问");
  const no = noHomeGait(fr, rr.frailMin, !!opts.dizzy);
  for (const def of rr.gait) {
    const v = fr[def.id];
    if (no) {
      if (typeof v?.seconds === "number") err(def.id, `这个人不在家测步态（${no}）：不能记秒数——带着问卷结果去做正式的跌倒风险评估`);
      else if (v?.result === "没测成") err(def.id, `这个人按规则不在家测（${no}）：写 { result: "按规则不测", reason: "${no}" }`);
    } else {
      if (v === undefined) err(def.id, `要测${def.id === "walk4m" ? " 4 m 步速" : "计时起立行走"}（测了写秒数，测不了写"没测成"和原因）`);
      else if (v.result === "按规则不测") err(def.id, "这个人不属于按规则不在家测的那几种情况：测了写秒数，测不了写\"没测成\"和原因");
    }
  }
  return out;
}

export const fallRiskAddDays = addDays;
