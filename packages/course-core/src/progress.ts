// 周次推进：档案的 weeks 记下每一段练的是第几周、从哪天开始（周复盘每次追加一段，放行就加 1，重复本周就不变）。
// 有了日期，就能按代码核对 AGENTS.md 的两条规矩：
// - 每一段结束都有周复盘（复盘/<这一段的开始日期>-第N周.md），不复盘不能进下一段；
// - 这一段的练习记录里有疼痛、头晕、胸闷，下一段不能加量（周次不能往上走）。
import type { Issue } from "./types.ts";

export interface WeekEntry {
  week: number;
  start: string;
}

type Obj = Record<string, any>;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** 复盘文件名：复盘/<这一段的开始日期>-第N周.md */
export const reviewName = (e: WeekEntry) => `${e.start}-第${e.week}周.md`;

const DAY = 86_400_000;
/** 本地时区的这一天 0 点。 */
const dayStart = (d: string) => new Date(`${d}T00:00:00`).getTime();
const localToday = (now: Date) => dayStart(`${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`);

/**
 * weeks 的结构：至少一段；第一段是第 1 周、从 startDate 开始；每段至少 7 天；每段最多比上一段多 1 周；
 * 第二段起的开始日期最晚是明天（不能预先写好以后的推进）；最后一段就是现在的 week。
 */
export function validateWeeks(p: Obj, now = new Date()): Issue[] {
  const out: Issue[] = [];
  const err = (path: string, message: string) => out.push({ level: "error", path, message });
  const ws = p.weeks;
  if (!Array.isArray(ws) || ws.length === 0) {
    err("weeks", "缺少 weeks（每一段练第几周、从哪天开始）：建档时写 [{ \"week\": 1, \"start\": 开始日期 }]");
    return out;
  }
  ws.forEach((e: unknown, i: number) => {
    const w = e as Obj;
    if (typeof e !== "object" || e === null || !Number.isInteger(w.week) || w.week < 1 || w.week > 4 || typeof w.start !== "string" || !DATE.test(w.start)) {
      err(`weeks[${i}]`, "每一段要有 week（1–4）和 start（YYYY-MM-DD）");
      return;
    }
    if (i === 0) {
      if (w.week !== 1) err("weeks[0].week", "第一段要从第 1 周开始");
      if (typeof p.startDate === "string" && w.start !== p.startDate) err("weeks[0].start", `第一段的开始日期要和 startDate（${p.startDate}）一致`);
      return;
    }
    const prev = ws[i - 1] as Obj;
    if (typeof prev?.start === "string" && DATE.test(prev.start) && dayStart(w.start) - dayStart(prev.start) < 7 * DAY) {
      err(`weeks[${i}].start`, `每一段至少练 7 天：上一段 ${prev.start} 开始，这一段最早 7 天后开始`);
    }
    if (dayStart(w.start) > localToday(now) + DAY) err(`weeks[${i}].start`, `开始日期 ${w.start} 还没到：周复盘做完才追加下一段，最早从明天开始`);
    if (Number.isInteger(prev?.week) && w.week > prev.week + 1) err(`weeks[${i}].week`, `从第 ${prev.week} 周不能直接跳到第 ${w.week} 周：每次最多推进一周`);
  });
  const last = ws[ws.length - 1] as Obj;
  const week = p.week ?? 1;
  if (Number.isInteger(last?.week) && last.week !== week) err("week", `week 是 ${week}，weeks 最后一段是第 ${last.week} 周：两处要一致`);
  return out;
}

/**
 * 按 weeks 核对练习记录和周复盘：
 * - 除了正在进行的最后一段，每一段都要有复盘文件；
 * - 某一段里有不适记录，下一段的周次不能比它高；
 * - 练习记录练的周次比当时那一段高：提醒（课程检查本来会拦，可能是手改的课程）。
 */
export function checkProgress(profile: Obj, sessions: { name: string; raw: Obj; archived?: boolean }[], reviews: string[], now = new Date()): Issue[] {
  const out: Issue[] = [];
  const ws = profile.weeks as WeekEntry[];
  if (!Array.isArray(ws) || validateWeeks(profile, now).length) return out;
  const periodOf = (t: number) => {
    for (let i = ws.length - 1; i >= 0; i--) if (t >= dayStart(ws[i].start)) return i;
    return -1;
  };
  const sick = new Set<number>();
  for (const s of sessions) {
    const t = Date.parse(s.raw?.startedAt);
    if (Number.isNaN(t)) continue;
    const i = periodOf(t);
    if (i < 0) {
      if (!s.archived) out.push({ level: "warning", path: s.name, message: `练习记录早于这一轮的开始日期 ${ws[0].start}：上一轮的记录应该在 历史/ 里` });
      continue;
    }
    // 历史/ 里的记录，日期落在这一轮之内的照样算数（不能靠挪进 历史/ 躲开不适记录）
    const sym = s.raw?.symptoms;
    if (sym && (sym.pain || sym.dizzy || sym.chest)) sick.add(i);
    const cw = s.raw?.course?.source?.week;
    if (Number.isInteger(cw) && cw > ws[i].week) {
      out.push({ level: "warning", path: s.name, message: `这天练的是第 ${cw} 周的课程，当时还在第 ${ws[i].week} 周` });
    }
  }
  ws.forEach((e, i) => {
    if (i === ws.length - 1) return;
    if (!reviews.includes(reviewName(e))) {
      out.push({ level: "error", path: `复盘/${reviewName(e)}`, message: `第 ${e.week} 周（${e.start} 起）这一段没有周复盘：先复盘，再按成品规则决定下一段` });
    }
    const next = ws[i + 1];
    if (sick.has(i) && next.week > e.week) {
      out.push({ level: "error", path: `weeks[${i + 1}]`, message: `第 ${e.week} 周（${e.start} 起）有疼痛、头晕或胸闷的记录，下一段不能加到第 ${next.week} 周：按成品"疼了怎么办"处理，这一周重来或者先就医` });
    }
  });
  return out;
}
