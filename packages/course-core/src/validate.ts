// 课程格式的结构校验，和 contracts/course.schema.json 一一对应（报中文错误，不悄悄改值）。
// 两边是否一致由 test/conformance.test.ts 用 contracts/fixtures/ 里的样例核对。
import { SAFETY_SETTINGS, SETTING_CHECKS } from "./settings.ts";
import type { Course, Issue } from "./types.ts";

const AGES = ["a13", "a18", "a40", "a65"];
const ITEM_KEYS = ["exercise", "name", "mode", "sets", "reps", "duration", "perSide", "tempo", "rest", "quote", "figure"];

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const isInt = (v: unknown, lo: number, hi: number) => Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi;
const isHalf = (v: unknown, lo: number, hi: number) =>
  typeof v === "number" && v >= lo && v <= hi && Number.isInteger(v * 2);

const isLead = SETTING_CHECKS.breathLead;
/** 和安全有关的播放设置：写错报错（呼吸提示关系到会不会憋气）。 */
const SAFETY: Record<string, [(v: unknown) => boolean, string]> = {
  breath: [(v) => ["coach", "full-voice", "pluck", "off"].includes(v as string), "breath（旧写法）只能是 coach / full-voice / pluck / off"],
  breathLead: [isLead, 'breathLead 是每组领几次：0–60 的整数，或 "all"（全程）'],
  breathAfter: [SETTING_CHECKS.breathAfter, 'breathAfter 只能是 "quiet"（安静）或 "pluck"（提示音）'],
};
/** 外观和声音的播放设置：写错只提醒，编排器回到默认值（settings.ts 的 normalizeSettings 会丢掉它）。 */
const LOOKS: Record<string, (v: unknown) => boolean> = Object.fromEntries(
  Object.entries(SETTING_CHECKS).filter(([k]) => !(SAFETY_SETTINGS as readonly string[]).includes(k)),
);

/** 播放设置的取值：安全项写错返回错误，外观项写错返回提醒。 */
export function settingsIssues(raw: Obj, path: string): Issue[] {
  const out: Issue[] = [];
  for (const [k, v] of Object.entries(raw)) {
    if (k in SAFETY) {
      if (!SAFETY[k][0](v)) out.push({ level: "error", path: `${path}.${k}`, message: SAFETY[k][1] });
    } else if (k in LOOKS) {
      if (!LOOKS[k](v)) out.push({ level: "warning", path: `${path}.${k}`, message: "取值不对，编排器按默认值播" });
    } else out.push({ level: "warning", path: `${path}.${k}`, message: "不认识的设置（编排器会忽略）" });
  }
  return out;
}

export function validateCourse(raw: unknown): { course: Course | null; issues: Issue[] } {
  const issues: Issue[] = [];
  const err = (path: string, message: string) => issues.push({ level: "error", path, message });
  const warn = (path: string, message: string) => issues.push({ level: "warning", path, message });

  if (!isObj(raw)) {
    err("", "课程必须是一个 JSON 对象");
    return { course: null, issues };
  }
  if (raw.schema !== "yangxia.course/1") err("schema", '格式标识要写 "yangxia.course/1"');
  if (typeof raw.id !== "string" || !/^c_[a-z0-9]{6,40}$/.test(raw.id)) err("id", "id 要以 c_ 开头，后面 6–40 个小写字母或数字");
  if (typeof raw.name !== "string" || raw.name.length < 1 || raw.name.length > 60) err("name", "name 要 1–60 个字");
  if (!AGES.includes(raw.age as string)) err("age", `age 只能是 ${AGES.join(" / ")}（6–12 岁版和全家餐饮没有训练，不导出课程）`);
  const src = raw.source;
  if (!isObj(src)) err("source", "缺少 source（出自哪份成品、第几周）");
  else {
    if (typeof src.product !== "string" || !src.product) err("source.product", "缺少成品名");
    if (src.phase === "稳定" ? !isInt(src.week, 1, 12) : !isInt(src.week, 1, 4)) err("source.week", "week 要是 1–4 的整数（稳定期 1–12）");
    if (src.day !== undefined && (typeof src.day !== "string" || src.day.length > 20)) err("source.day", "day 最多 20 个字");
    if (src.templates !== undefined && typeof src.templates !== "string") err("source.templates", "templates 要是字符串");
    if (src.plan !== undefined && src.plan !== "yangxia.plans/1") err("source.plan", 'plan 只能是 "yangxia.plans/1"');
    if (src.segment !== undefined && !isInt(src.segment, 1, 99)) err("source.segment", "segment 是第几段，从 1 起的整数");
    if (src.type !== undefined && !["标准", "减量"].includes(src.type as string)) err("source.type", "type 只能是 标准 / 减量");
    if (src.phase !== undefined && src.phase !== "起始" && src.phase !== "稳定") err("source.phase", "phase 只能是 起始 / 稳定");
    if (src.half !== undefined && src.half !== true) err("source.half", "half 只能是 true（半量课：中断、生病回来的第一次）");
    if (src.picks !== undefined && !(isObj(src.picks) && Object.values(src.picks).every((v) => typeof v === "string"))) err("source.picks", "picks 是 {轮换组: 动作 ID}");
  }
  if (raw.presentation !== undefined && !isObj(raw.presentation)) err("presentation", "presentation 要是对象");
  else if (isObj(raw.presentation) && raw.presentation.sequencer !== undefined) {
    if (!isObj(raw.presentation.sequencer)) err("presentation.sequencer", "presentation.sequencer 要是对象");
    else issues.push(...settingsIssues(raw.presentation.sequencer, "presentation.sequencer"));
  }
  const co = raw.coaching;
  if (co !== undefined) {
    if (!isObj(co)) err("coaching", "coaching 要是对象");
    else {
      if (co.floor !== undefined && co.floor !== "pluck") err("coaching.floor", 'floor 只能是 "pluck"（领完以后至少响提示音）');
      if (co.prefs !== undefined) {
        if (!isObj(co.prefs)) err("coaching.prefs", "prefs 要是对象");
        else for (const [k, v] of Object.entries(co.prefs)) {
          // 档案里的播放偏好只能写这三项，写错一律报错（是 course export 照档案写的）
          const ok = k === "breathLead" || k === "breathAfter" || k === "countTiming" ? SETTING_CHECKS[k](v) : null;
          if (ok === null) err(`coaching.prefs.${k}`, "prefs 只能写 breathLead、breathAfter、countTiming");
          else if (!ok) err(`coaching.prefs.${k}`, "取值不对");
        }
      }
    }
  }
  if (!Array.isArray(raw.blocks) || raw.blocks.length < 1 || raw.blocks.length > 12) {
    err("blocks", "blocks 要有 1–12 段");
  } else {
    raw.blocks.forEach((b: unknown, bi: number) => {
      const bp = `blocks[${bi}]`;
      if (!isObj(b) || (b.kind !== "sets" && b.kind !== "circuit")) {
        err(bp, 'kind 只能是 "sets" 或 "circuit"');
        return;
      }
      if (b.kind === "circuit") {
        if (!isInt(b.rounds, 1, 10)) err(`${bp}.rounds`, "rounds 要是 1–10 的整数");
        if (b.restBetweenRounds !== undefined && !isInt(b.restBetweenRounds, 0, 300)) err(`${bp}.restBetweenRounds`, "轮间休息要是 0–300 的整数秒");
      }
      if (!Array.isArray(b.items) || b.items.length < 1 || b.items.length > 12) {
        err(`${bp}.items`, "items 要有 1–12 个动作");
        return;
      }
      b.items.forEach((it: unknown, ii: number) => {
        const p = `${bp}.items[${ii}]`;
        if (!isObj(it)) {
          err(p, "动作要是对象");
          return;
        }
        for (const k of Object.keys(it)) if (!ITEM_KEYS.includes(k)) warn(`${p}.${k}`, "不认识的字段（读的一方会忽略）");
        if (typeof it.exercise !== "string" || !/^[a-z0-9-]+$/.test(it.exercise)) err(`${p}.exercise`, "exercise 要是动作索引里的 ID");
        if (typeof it.name !== "string" || it.name.length < 1 || it.name.length > 24) err(`${p}.name`, "name 要 1–24 个字");
        if (it.mode !== "reps" && it.mode !== "timed") err(`${p}.mode`, 'mode 只能是 "reps" 或 "timed"');
        if (it.sets !== undefined && !isInt(it.sets, 1, 10)) err(`${p}.sets`, "sets 要是 1–10 的整数");
        if (b.kind === "circuit" && it.sets !== undefined && it.sets !== 1) err(`${p}.sets`, "循环里每个动作每轮做 1 组，sets 只能是 1（轮数写在 rounds）");
        if (it.perSide !== undefined && typeof it.perSide !== "boolean") err(`${p}.perSide`, "perSide 要是 true / false");
        if (!isInt(it.rest, 0, 300)) err(`${p}.rest`, "rest 要是 0–300 的整数秒");
        if (!Array.isArray(it.quote) || it.quote.length < 1 || it.quote.length > 4 ||
            !it.quote.every((q) => typeof q === "string" && q.length >= 2 && q.length <= 200)) {
          err(`${p}.quote`, "quote 要有 1–4 段成品原文，每段 2–200 个字");
        }
        if (it.mode === "reps") {
          if (!isInt(it.reps, 1, 60)) err(`${p}.reps`, "按次计数的动作要写 reps（1–60）");
          const tp = it.tempo;
          if (!isObj(tp)) err(`${p}.tempo`, "按次计数的动作要写 tempo（发力、下放各几秒）");
          else {
            if (tp.start !== "up" && tp.start !== "down") err(`${p}.tempo.start`, 'start 只能是 "up" 或 "down"');
            if (!isHalf(tp.up, 0.5, 10)) err(`${p}.tempo.up`, "up 要是 0.5–10 秒（以 0.5 秒为单位）");
            if (!isHalf(tp.down, 0.5, 10)) err(`${p}.tempo.down`, "down 要是 0.5–10 秒（以 0.5 秒为单位）");
            if (tp.top !== undefined && !isHalf(tp.top, 0, 10)) err(`${p}.tempo.top`, "top 要是 0–10 秒（以 0.5 秒为单位）");
            if (tp.bottom !== undefined && !isHalf(tp.bottom, 0, 10)) err(`${p}.tempo.bottom`, "bottom 要是 0–10 秒（以 0.5 秒为单位）");
          }
        }
        if (it.figure !== undefined && (typeof it.figure !== "string" || !/^[a-z0-9-]+(#[0-9]+)?$/.test(it.figure))) err(`${p}.figure`, "figure 是动图片段号（小写字母、数字、-，分级片段后面带 #级）");
        if (it.mode === "timed" && !isInt(it.duration, 5, 600)) err(`${p}.duration`, "计时动作要写 duration（5–600 秒）");
      });
    });
  }
  const ok = !issues.some((i) => i.level === "error");
  return { course: ok ? (raw as unknown as Course) : null, issues };
}
