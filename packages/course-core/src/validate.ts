// 课程格式的结构校验，和 contracts/course.schema.json 一一对应（报中文错误，不悄悄改值）。
// 两边是否一致由 test/conformance.test.ts 用 contracts/fixtures/ 里的样例核对。
import type { Course, Issue } from "./types.ts";

const AGES = ["a13", "a18", "a40", "a65"];
const ITEM_KEYS = ["exercise", "name", "mode", "sets", "reps", "duration", "perSide", "tempo", "rest", "quote"];

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const isInt = (v: unknown, lo: number, hi: number) => Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi;
const isHalf = (v: unknown, lo: number, hi: number) =>
  typeof v === "number" && v >= lo && v <= hi && Number.isInteger(v * 2);

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
    if (!isInt(src.week, 1, 4)) err("source.week", "week 要是 1–4 的整数");
    if (src.day !== undefined && (typeof src.day !== "string" || src.day.length > 20)) err("source.day", "day 最多 20 个字");
    if (src.templates !== undefined && typeof src.templates !== "string") err("source.templates", "templates 要是字符串");
  }
  if (raw.presentation !== undefined && !isObj(raw.presentation)) err("presentation", "presentation 要是对象");
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
        if (it.mode === "timed" && !isInt(it.duration, 5, 600)) err(`${p}.duration`, "计时动作要写 duration（5–600 秒）");
      });
    });
  }
  const ok = !issues.some((i) => i.level === "error");
  return { course: ok ? (raw as unknown as Course) : null, issues };
}
