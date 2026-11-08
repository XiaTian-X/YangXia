// 个人档案 yangxia.profile/1 和练习记录 yangxia.session/1 的结构校验（和 contracts/*.schema.json 对应），
// 以及 agent 写进档案目录的文字（周复盘、菜单）的红线检查。
import { validateWeeks } from "./progress.ts";
import type { RedlineRules } from "./redlines.ts";
import { redlineHits } from "./redlines.ts";
import type { Issue } from "./types.ts";

export const PROFILE_FORMAT = "yangxia.profile/1";
export const SESSION_FORMAT = "yangxia.session/1";
const STAGES = ["小学", "初中", "高中", "18–39 岁", "40–64 岁", "65 岁以上"];
const AGES = ["a06", "a13", "a18", "a40", "a65"];
const VENUES = ["gym", "home", "bw", "play", "chair"];
type Obj = Record<string, any>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export function validateProfile(raw: unknown): Issue[] {
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
  if (typeof raw.startDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(raw.startDate)) err("startDate", "startDate 要写成 YYYY-MM-DD");
  if (raw.week !== undefined && !(Number.isInteger(raw.week) && raw.week >= 1 && raw.week <= 4)) err("week", "week 要是 1–4");
  if (raw.round !== undefined && !(Number.isInteger(raw.round) && raw.round >= 1)) err("round", "round 要是从 1 开始的整数");
  if (raw.household !== undefined && !(Array.isArray(raw.household) && raw.household.every((a: unknown) => AGES.includes(a as string)))) {
    err("household", `household 是家庭成员的年龄段列表，只能写 ${AGES.join("、")}`);
  }
  out.push(...validateWeeks(raw));
  const sc = raw.screening;
  if (!isObj(sc) || !Array.isArray(sc.answers) || typeof sc.doctorCleared !== "boolean") {
    err("screening", "缺少安全筛查（answers、doctorCleared）");
  } else {
    sc.answers.forEach((a: unknown, i: number) => {
      if (!isObj(a) || typeof a.item !== "string" || (a.answer !== "是" && a.answer !== "否")) err(`screening.answers[${i}]`, "每项要有 item 和 answer（是 / 否）");
    });
    if (sc.doctorAdvice !== undefined && (typeof sc.doctorAdvice !== "string" || sc.doctorAdvice.length > 300)) err("screening.doctorAdvice", "医生意见最多 300 个字");
    const yes = sc.answers.some((a: Obj) => a?.answer === "是");
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
  if (typeof raw.startedAt !== "string" || Number.isNaN(Date.parse(raw.startedAt))) err("startedAt", "startedAt 要是时间");
  if (!Array.isArray(raw.items)) err("items", "缺少 items");
  else raw.items.forEach((it: unknown, i: number) => {
    if (!isObj(it) || typeof it.exercise !== "string" || !Number.isInteger(it.setsPlanned) || !Number.isInteger(it.setsDone)) {
      err(`items[${i}]`, "每项要有 exercise、setsPlanned、setsDone");
    } else if (it.setsDone < 0 || it.setsDone > it.setsPlanned) {
      err(`items[${i}].setsDone`, `完成 ${it.setsDone} 组，计划只有 ${it.setsPlanned} 组：完成组数要在 0 到计划组数之间`);
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
