// 个人档案 yangxia.profile/1 和练习记录 yangxia.session/1 的结构校验（和 contracts/*.schema.json 对应），
// 以及 agent 写进档案目录的文字（周复盘、菜单）的红线检查。
import { validateAssessFields } from "./assess.ts";
import { isValidTimeZone, resolveTimeZone } from "./date.ts";
import { FEELS, validateProgressShape, validateSegments } from "./progress.ts";
import type { RedlineRules } from "./redlines.ts";
import { redlineHits } from "./redlines.ts";
import type { Issue } from "./types.ts";
import { sourceIssues } from "./validate.ts";

export const PROFILE_FORMAT = "yangxia.profile/1";
export const SESSION_FORMAT = "yangxia.session/1";
const STAGES = ["小学", "初中", "高中", "18–39 岁", "40–64 岁", "65 岁以上"];
const AGES = ["a06", "a13", "a18", "a40", "a65"];
const VENUES = ["gym", "home", "bw", "play", "chair"];
type Obj = Record<string, any>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export interface ValidateProfileOptions {
  now?: Date;
  timeZone?: string;
}

export function validateProfile(raw: unknown, opts?: ValidateProfileOptions): Issue[] {
  const out: Issue[] = [];
  const err = (path: string, message: string) => out.push({ level: "error", path, message });
  if (!isObj(raw)) return [{ level: "error", path: "", message: "档案要是 JSON 对象" }];
  if (raw.schema !== PROFILE_FORMAT) err("schema", `格式标识要写 "${PROFILE_FORMAT}"`);
  if (typeof raw.code !== "string" || !/^[^/\\\s]{1,20}$/.test(raw.code)) err("code", "代号要 1–20 个字，不能有空格和斜杠（不要用真名）");
  if (!STAGES.includes(raw.stage)) err("stage", `stage 只能是 ${STAGES.join("、")}`);
  if (!AGES.includes(raw.age)) err("age", `age 只能是 ${AGES.join("、")}`);
  if (raw.venue !== undefined && !VENUES.includes(raw.venue)) err("venue", `venue 只能是 ${VENUES.join("、")}`);
  if (typeof raw.product !== "string" || !raw.product) err("product", "缺少选用的成品名");
  for (const k of ["wake", "bedtime"]) if (raw[k] !== undefined && !HHMM.test(raw[k])) err(k, `${k} 要写成 HH:MM`);
  if (raw.timezone !== undefined && !isValidTimeZone(raw.timezone)) err("timezone", "timezone 要是合法的 IANA 时区名（如 Asia/Shanghai）");
  if (typeof raw.startDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(raw.startDate)) err("startDate", "startDate 要写成 YYYY-MM-DD");
  if (raw.household !== undefined && !(Array.isArray(raw.household) && raw.household.every((a: unknown) => AGES.includes(a as string)))) {
    err("household", `household 是家庭成员的年龄段列表，只能写 ${AGES.join("、")}`);
  }
  const tz = resolveTimeZone(opts?.timeZone, raw);
  out.push(...validateSegments(raw, opts?.now, tz), ...validateProgressShape(raw), ...validateAssessFields(raw));
  // 播放偏好（v4 阶段 8）：本人不要呼吸提示、想在做完时报数这类选择，只记选择；course export 写进课程，不低于安全下限
  const pb = raw.playback;
  if (pb !== undefined) {
    if (!isObj(pb)) err("playback", "playback 要是对象");
    else for (const [k, v] of Object.entries(pb)) {
      if (k === "breathLead") { if (!(v === "all" || (Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 60))) err("playback.breathLead", 'breathLead 是每组领几次：0–60 的整数，或 "all"'); }
      else if (k === "breathAfter") { if (v !== "quiet" && v !== "pluck") err("playback.breathAfter", 'breathAfter 只能是 "quiet" 或 "pluck"'); }
      else if (k === "countTiming") { if (v !== "on-rep" && v !== "on-up") err("playback.countTiming", 'countTiming 只能是 "on-rep" 或 "on-up"'); }
      else err(`playback.${k}`, "playback 只能写 breathLead、breathAfter、countTiming");
    }
    // 65 岁以上、有高血压或没确认的：领完以后至少响提示音，档案写"安静"也按提示音导出
    // （"高血压"这个条件只用在成人成品上，13–17 岁不算）
    const floor = raw.age === "a65" || ((raw.age === "a18" || raw.age === "a40") && raw.conditions?.["高血压"] !== false);
    if (floor && pb.breathAfter === "quiet" && pb.breathLead !== "all") {
      out.push({ level: "warning", path: "playback.breathAfter", message: "65 岁以上、有高血压或没确认的人，领完以后至少要响提示音：这里写的\"安静\"会按提示音导出" });
    }
  }
  const sc = raw.screening;
  if (!isObj(sc) || !Array.isArray(sc.answers) || typeof sc.doctorCleared !== "boolean") {
    err("screening", "缺少安全筛查（answers、doctorCleared）");
  } else {
    sc.answers.forEach((a: unknown, i: number) => {
      if (!isObj(a) || typeof a.item !== "string" || (a.answer !== "是" && a.answer !== "否")) err(`screening.answers[${i}]`, "每项要有 item 和 answer（是 / 否）");
    });
    if (sc.doctorAdvice !== undefined && (typeof sc.doctorAdvice !== "string" || sc.doctorAdvice.length > 300)) err("screening.doctorAdvice", "医生意见最多 300 个字");
    const yes = sc.answers.some((a: Obj) => a?.answer === "是");
    // 训练单的条件和筛查对不上：筛查里和高血压有关的那一项答了"是"，条件却记"没有高血压"
    if (raw.conditions?.["高血压"] === false && sc.answers.some((a: Obj) => a?.answer === "是" && /高血压/.test(a?.item ?? ""))) {
      out.push({ level: "warning", path: "conditions.高血压", message: "安全筛查里和高血压有关的一项答了\"是\"，条件却记了没有高血压：再和使用者确认一次" });
    }
    if ((raw.age === "a65" || yes) && !sc.doctorCleared) {
      out.push({ level: "warning", path: "screening", message: raw.age === "a65"
        ? "65 岁以上开始前都要先问医生：医生同意之前不出课程" : "安全筛查有\"是\"：先问医生，医生同意之前不出课程" });
    }
  }
  return out;
}

export function validateSession(raw: unknown): Issue[] {
  const out: Issue[] = [];
  const err = (path: string, message: string) => out.push({ level: "error", path, message });
  if (!isObj(raw)) return [{ level: "error", path: "", message: "练习记录要是 JSON 对象" }];
  if (raw.schema !== SESSION_FORMAT) err("schema", `格式标识要写 "${SESSION_FORMAT}"`);
  if (!isObj(raw.course) || typeof raw.course.id !== "string" || typeof raw.course.name !== "string") err("course", "缺少课程 id 和 name");
  else {
    if (!/^c_[a-z0-9]{6,40}$/.test(raw.course.id)) err("course.id", "课程 id 要以 c_ 开头，后面 6–40 个小写字母或数字");
    if (raw.course.name.length < 1 || raw.course.name.length > 60) err("course.name", "课程名要 1–60 个字");
    // 半量周、轮换计数、周次都读 source：和课程格式一样逐项查，不许多余的项
    out.push(...sourceIssues(raw.course.source, "course.source"));
  }
  if (typeof raw.startedAt !== "string" || Number.isNaN(Date.parse(raw.startedAt))) err("startedAt", "startedAt 要是时间");
  if (raw.endedAt !== undefined) {
    if (typeof raw.endedAt !== "string" || Number.isNaN(Date.parse(raw.endedAt))) err("endedAt", "endedAt 要是时间");
    else if (typeof raw.startedAt === "string" && Date.parse(raw.endedAt) < Date.parse(raw.startedAt)) err("endedAt", "endedAt 不能早于 startedAt");
  }
  if (raw.note !== undefined && (typeof raw.note !== "string" || [...raw.note].length > 500)) err("note", "备注是不超过 500 个字的文字");
  if (!Array.isArray(raw.items)) err("items", "缺少 items");
  else raw.items.forEach((it: unknown, i: number) => {
    if (!isObj(it) || typeof it.exercise !== "string" || !Number.isInteger(it.setsPlanned) || !Number.isInteger(it.setsDone)) {
      err(`items[${i}]`, "每项要有 exercise、setsPlanned、setsDone");
    } else if (it.setsDone < 0 || it.setsDone > it.setsPlanned) {
      err(`items[${i}].setsDone`, `完成 ${it.setsDone} 组，计划只有 ${it.setsPlanned} 组：完成组数要在 0 到计划组数之间`);
    } else {
      if (it.feel !== undefined && !(FEELS as readonly string[]).includes(it.feel)) err(`items[${i}].feel`, `感受只能是：${FEELS.join(" / ")}`);
      if (it.spare !== undefined && !(Number.isInteger(it.spare) && it.spare >= 0 && it.spare <= 30)) err(`items[${i}].spare`, "还能做几下：0–30 的整数");
      if (it.reverted !== undefined && typeof it.reverted !== "boolean") err(`items[${i}].reverted`, "reverted（升级做不到当场退回）只能是 true / false");
      if (it.skipped !== undefined && it.skipped !== (it.setsDone === 0)) err(`items[${i}].skipped`, "skipped 要等于\"一组都没做\"（setsDone 是 0）");
    }
  });
  if (!["轻松", "正好", "吃力"].includes(raw.feeling)) err("feeling", "feeling 只能是 轻松 / 正好 / 吃力");
  if (raw.edited !== undefined && typeof raw.edited !== "boolean") err("edited", "edited 只能是 true / false");
  else if (raw.edited) out.push({ level: "warning", path: "edited", message: "练的课程在编排器里手动改过，和成品原文可能不一致：周复盘按成品规则判断，不按这份记录加量" });
  const s = raw.symptoms;
  if (!isObj(s) || typeof s.pain !== "boolean" || typeof s.dizzy !== "boolean" || typeof s.chest !== "boolean") {
    err("symptoms", "symptoms 要有 pain、dizzy、chest（true / false）");
  } else if (s.pain || s.dizzy || s.chest) {
    out.push({ level: "warning", path: "symptoms", message: "这次有不适：下周不加量，按成品\"疼了怎么办\"处理；胸痛胸闷、头晕站不稳要建议就医" });
  }
  return out;
}

/** 所有生成的计划都要带的声明（目前没有专业人员审核，v4 方案第十一节第 6 条）。agent 写的计划、菜单、复盘开头写这一行。 */
export const DECLARATION = "> 本计划由养夏计划模板生成，未经专业审核，不是医学建议，不能替代医生的判断。";

/** 计划、菜单、复盘里有没有声明（"未经专业审核"和"不是医学建议"都要有）。 */
export function checkDeclaration(name: string, text: string): Issue[] {
  if (text.includes("未经专业审核") && text.includes("不是医学建议")) return [];
  return [{ level: "error", path: name, message: `开头要写声明（目前没有专业人员审核）：${DECLARATION}` }];
}

/** agent 写给这个人的文字（周复盘、菜单）：按年龄段过红线（这是正文，用白名单）。全家菜单用 fam 的词表。 */
export function checkNotes(rules: RedlineRules, ages: string[], name: string, text: string): Issue[] {
  const out: Issue[] = [];
  for (const age of ages) {
    for (const w of redlineHits(rules, age, text, true)) {
      out.push({ level: "error", path: name, message: `有 ${age} 年龄段的红线词「${w}」` });
    }
  }
  return out;
}
