// 65 岁以上稳定期（v4 阶段 6b）：加一项。起始期"下一轮的方向"那一条"想加量先问医生，医生同意的话，一次只加一项"：
// 医生同意（addClear）以后，一轮的第 1 周最多加一项（addOnLog），训练单不动、导出时按 rules.stable.addOns 改坐站起的上限或组数。
// 设计值 A65_ADD_ONE、A65_ADD_REPS、A65_ADD_CLEAR；摔倒、头晕的轮末处理在 assess.ts（A65_STABLE_FALL）。
import { type AssessContext, assessRules, cycleHold, param, productInfo } from "./assess.ts";
import { clearValid } from "./goals.ts";
import { type AddOnDef, addOnDefs, addOnsFromLog, roundWeek } from "./plan.ts";
import { reviewDataName, type SegmentEntry } from "./progress.ts";
import type { Issue } from "./types.ts";

type Obj = Record<string, any>;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const ACTIONS = ["加", "减"];

/** 档案里加项用到的字段：addClear [{ date, items }]、addOnLog [{ date, item, action, why }]。 */
export function validateAddFields(p: Obj): Issue[] {
  const out: Issue[] = [];
  const err = (path: string, message: string) => out.push({ level: "error", path, message });
  const sorted = (v: Obj[]) => v.every((e, i) => i === 0 || e.date >= v[i - 1].date);
  if (p.addClear !== undefined && !(Array.isArray(p.addClear) && p.addClear.length && p.addClear.every((e: Obj) => isObj(e) && typeof e.date === "string" && DATE.test(e.date)
    && Array.isArray(e.items) && e.items.length && e.items.every((x: unknown) => typeof x === "string") && Object.keys(e).every((k) => k === "date" || k === "items")) && sorted(p.addClear))) {
    err("addClear", "addClear 是 [{ date, items }]：医生说可以照这份计划一轮加一项的那天、同意的那几项（加项 ID），按日期从早到晚，续了就加一项");
  }
  if (p.addOnLog !== undefined && !(Array.isArray(p.addOnLog) && p.addOnLog.every((e: Obj) => isObj(e) && typeof e.date === "string" && DATE.test(e.date)
    && typeof e.item === "string" && ACTIONS.includes(e.action) && typeof e.why === "string" && e.why.trim() !== "" && Object.keys(e).every((k) => ["date", "item", "action", "why"].includes(k))) && sorted(p.addOnLog))) {
    err("addOnLog", "addOnLog 是 [{ date, item, action: 加 / 减, why }]：哪天加了 / 减了哪一项、规则上的理由（如\"上一轮 11 练、没有不适\"），按日期从早到晚；清零、失效由命令算，不用写");
  }
  return out;
}

const ss = (ctx: AssessContext) => (ctx.profile.segments ?? []) as SegmentEntry[];
const hasReason = (a: Obj, r: string) => Array.isArray(a?.raw?.reasons) && a.raw.reasons.includes(r);
const famOf = (ctx: AssessContext, s: SegmentEntry) => productInfo(ctx.manifest, s.product)?.code;
/** 这一项在 65 岁以上稳定期（有加项表的家族）里吗。 */
const inAddStable = (ctx: AssessContext, s: SegmentEntry | undefined) => !!s && s.phase === "稳定" && addOnDefs(ctx.rules, famOf(ctx, s) ?? "").length > 0;
const indexAt = (list: SegmentEntry[], date: string) => {
  for (let i = list.length - 1; i >= 0; i--) if (date >= list[i].start) return i;
  return -1;
};

/**
 * 某一天有效的加项：addOnLog 重放（回起始期清零，plan.ts addOnsFromLog），再去掉——
 * 看完医生回来（摔倒、头晕的轮末，A65_STABLE_FALL）以后清零；医生同意失效（过期，或者看了医生没续，"看了医生才算"的算法）的那一周起去掉。
 */
export function activeAddOns(ctx: AssessContext, date: string): string[] {
  const list = ss(ctx);
  const i = indexAt(list, date);
  if (i < 0 || !inAddStable(ctx, list[i])) return [];
  const code = famOf(ctx, list[i])!;
  const log = (Array.isArray(ctx.profile.addOnLog) ? ctx.profile.addOnLog : []) as Obj[];
  // 清零的日子：稳定期里的看完医生回来、生病住院（那天起）
  const dayOf = (a: Obj) => (hasReason(a, "生病住院") && typeof a.raw.eventDate === "string" ? a.raw.eventDate
    : hasReason(a, "看完医生回来") && typeof a.raw.doctorDate === "string" ? a.raw.doctorDate : a.raw.date) as string;
  const clears = ctx.assessments.filter((a) => (hasReason(a, "看完医生回来") || hasReason(a, "生病住院")) && typeof a.raw.date === "string" && dayOf(a) <= date
    && inAddStable(ctx, list[indexAt(list, dayOf(a))])).map(dayOf);
  const lastClear = clears.sort().pop() ?? "";
  let on = addOnsFromLog(ctx.profile, date).filter((item) => {
    // 清零以后又加的才算
    const added = log.filter((e) => e.item === item && e.action === "加" && e.date <= date).map((e) => e.date as string).sort().pop() ?? "";
    return added > lastClear;
  });
  // 同意失效那一周起去掉：这一项加了以后的每一周开始那天都要还有效（看了医生才算）
  on = on.filter((item) => {
    const added = log.filter((e) => e.item === item && e.action === "加" && e.date <= date).map((e) => e.date as string).sort().pop() ?? "";
    return list.filter((s) => s.start > added && s.start <= date).every((s) => clearValid(ctx, "addClear", s.start, code, { waitDoctor: true, item }).valid);
  });
  return on;
}

/**
 * 某一轮（稳定期里第 1 周那一项的下标 k）前面那一轮的 4 周：这一段的前 4 个周次，第 1 周的是上一段最后 4 个周次。
 * 训练数每个周次只算最后一份复盘（每周不超过排的次数）；摔倒头晕不适每一份都算（重复的周）。
 */
function prevRound(ctx: AssessContext, k: number): { trainings: number; trouble: boolean; missing: boolean } {
  const list = ss(ctx);
  const ar = assessRules(ctx.rules);
  const cur = list[k];
  const n = cur.week > 1 ? cur.n : k > 0 ? list[k - 1].n : cur.n;
  const before = list.slice(0, k).filter((s) => s.n === n);
  const top = cur.week > 1 ? cur.week - 1 : Math.max(0, ...before.map((s) => s.week));
  const want = [top - 3, top - 2, top - 1, top].filter((w) => w >= 1);
  let trainings = 0, trouble = false, missing = want.length < 4;
  for (const w of want) {
    const copies = before.filter((s) => s.week === w);
    if (!copies.length) { missing = true; continue; }
    for (const s of copies) {
      const rv = ctx.reviewData[reviewDataName(s)];
      if (rv && (rv.symptoms === true || (rv.falls ?? 0) > 0 || (rv.nearFalls ?? 0) > 0 || (rv.dizzy ?? 0) > 0)) trouble = true;
    }
    const last = copies[copies.length - 1];
    const rv = ctx.reviewData[reviewDataName(last)];
    if (!rv) { missing = true; continue; }
    const cap = ar ? param(ar.assess, "每周排的训练", famOf(ctx, last) ?? "")?.number ?? Infinity : Infinity;
    trainings += Math.min(rv.trainings ?? 0, cap);
  }
  return { trainings, trouble, missing };
}

/** 档案目录里加项的核对（profile check、导出之前都跑）：每一条"加""减"按 3.3 的条件重放。 */
export function addOnIssues(ctx: AssessContext): Issue[] {
  const out: Issue[] = [];
  const p = ctx.profile;
  const list = ss(ctx);
  const log = (Array.isArray(p.addOnLog) ? p.addOnLog : []) as Obj[];
  if (validateAddFields(p).length) return out;
  const err = (i: number, message: string) => out.push({ level: "error", path: `addOnLog[${i}]`, message });
  const perRound = new Map<string, number>();
  log.forEach((e, i) => {
    const k = indexAt(list, e.date);
    const s = list[k];
    if (!inAddStable(ctx, s)) { err(i, `${e.date} 不在 65 岁以上的稳定期里：加项只给 65 岁以上稳定期`); return; }
    const code = famOf(ctx, s)!;
    const defs = addOnDefs(ctx.rules, code);
    const def = defs.find((d) => d.id === e.item);
    if (!def) { err(i, `加项「${e.item}」不认识（有：${defs.map((d) => d.id).join("、")}）`); return; }
    const before = activeAddOns(ctx, prevDay(e.date));
    if (e.action === "减") {
      if (!activeAddOns(ctx, e.date).includes(e.item) && !before.includes(e.item)) err(i, `「${e.item}」${e.date} 没有加着，不用减`);
      return;
    }
    // 加：只在一轮的第 1 周；上一轮 ≥ 10 练、没有摔倒头晕不适；有效的医生同意（这一项）；一轮一项；二选一；要条件
    if (roundWeek(s.week) !== 1) { err(i, `只在一轮的第 1 周加（${e.date} 是这一段第 ${s.week} 周、这一轮第 ${roundWeek(s.week)} 周）`); return; }
    const pr = prevRound(ctx, k);
    if (pr.missing) err(i, "上一轮 4 周的复盘数据不全：先补上，才知道能不能加");
    else if (pr.trainings < 10) err(i, `上一轮只练了 ${pr.trainings} 次：上一轮完成 ≥ 10 次才能加一项`);
    else if (pr.trouble) err(i, "上一轮有摔倒、差点摔倒、头晕或者哪里疼：这一轮不加项");
    if (s.week === 1) {
      const prevN = k > 0 ? list[k - 1].n : null;
      const hold = prevN !== null && cycleHold(ctx, prevN);
      if (hold) err(i, "上一个周期末的结论是习惯没达标：这个周期第 1 轮不加项");
    }
    if (!clearValid(ctx, "addClear", e.date, code, { item: e.item }).valid) {
      err(i, `「${e.item}」没有有效的医生同意：先问医生"能不能照这份计划一轮加一项……"，同意了在档案 addClear 记那天和同意的项（一年有效；重做筛查、摔倒、生病住院、看完医生回来以后要重问）`);
    }
    const key = `${s.n}-${Math.floor((s.week - 1) / 4)}`;
    perRound.set(key, (perRound.get(key) ?? 0) + 1);
    const most = defsMax(ctx, code);
    if ((perRound.get(key) ?? 0) > most) err(i, `一轮最多加 ${most} 项：这一轮已经加过了`);
    if (before.includes(e.item)) err(i, `「${e.item}」已经加着了`);
    const rival = def.group ? defs.find((d) => d.group === def.group && d.id !== def.id && before.includes(d.id)) : undefined;
    if (rival) err(i, `「${e.item}」和「${rival.id}」只能选一种（${def.group}）`);
    if (def.requires && p.conditions?.[def.requires.name] !== def.requires.value) {
      err(i, `「${e.item}」要条件「${def.requires.name}」记了"${def.requires.value ? "是" : "否"}"（没确认的不能加）`);
    }
  });
  return out;
}

const defsMax = (ctx: AssessContext, code: string) => {
  const v = ctx.rules?.stable?.params.find((x) => x.name === "加项每轮最多" && x.products.includes(code))?.number;
  return typeof v === "number" ? v : 1;
};
const prevDay = (d: string) => {
  const t = new Date(`${d}T12:00:00Z`).getTime() - 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
};

/** 计划单上加项的几行（65 岁以上稳定期才有）。 */
export function addOnSheetLines(ctx: AssessContext, index: number): string[] {
  const list = ss(ctx);
  const s = list[index];
  if (!inAddStable(ctx, s)) return [];
  const code = famOf(ctx, s)!;
  const defs = addOnDefs(ctx.rules, code);
  const on = activeAddOns(ctx, s.start);
  const name = (d: AddOnDef) => d.quotes.find((q) => !q.section.startsWith("下一轮的方向"))?.text ?? d.id;
  const lines = ["## 加一项", ""];
  lines.push(on.length ? `- 现在加着的：${defs.filter((d) => on.includes(d.id)).map(name).join("；")}。` : "- 现在没有加项：照第五章训练单第 4 周那一列练。");
  for (const d of defs.filter((x) => on.includes(x.id) && x.kind === "follow")) lines.push(`- ${name(d)}：照成品做（课程里不出这一项），做之前照第七章确认。`);
  lines.push("- 哪一周觉得吃力：退回第 3 周的扶法、站法，或者去掉最近加的那一项（周复盘时记一条\"减\"）。");
  if (roundWeek(s.week) === 1) lines.push("- 这一周是一轮的第 1 周：上一轮完成 ≥ 10 次、没有摔倒头晕不适、医生同意过的，可以加一项（一轮最多一项）。");
  lines.push("");
  return lines;
}
