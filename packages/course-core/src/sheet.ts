// 个人计划单（v4 阶段 3）：这一周每天练什么、有氧做稳态还是间歇、习惯的达标线、下次评估。
// 由命令生成（npm run course -- plan），不手写；内容全部来自训练单、规则参数和档案，开头带声明。
import { type AssessContext, assessRules, cardioMode, productInfo } from "./assess.ts";
import { currentSegment, exportCourse, maxWeek, planType, ROUND_WEEKS, roundWeek } from "./plan.ts";
import { DECLARATION } from "./profile.ts";
import { localDate } from "./progress.ts";
import { itemSpec } from "./timeline.ts";
import type { Issue } from "./types.ts";

type Obj = Record<string, any>;
const MARK = /^<!-- 养夏计划单 段=(\d+) 周=(\d+) 模板=(\S+) 进度=(\d{4}-\d{2}-\d{2}) -->$/m;
const addDays = (d: string, n: number) => localDate(new Date(new Date(`${d}T12:00:00`).getTime() + n * 86_400_000));

/** 计划单开头的标记：第几段、第几周、生成时的模板版本、进度截到哪天。 */
export function sheetMark(text: string): { segment: number; week: number; templates: string; progress: string } | null {
  const m = MARK.exec(text);
  return m ? { segment: Number(m[1]), week: Number(m[2]), templates: m[3], progress: m[4] } : null;
}

/** 进度日志里最后一次改动的日期（没有就是开始日期）。 */
export const progressDate = (profile: Obj) =>
  [profile.startDate, ...(profile.progressLog ?? []).map((e: Obj) => e?.date)].filter((d) => typeof d === "string").sort().pop() as string;

export function buildSheet(ctx: AssessContext, week?: number): { text: string | null; issues: Issue[] } {
  const issues: Issue[] = [];
  const { profile, manifest, plans, rules } = ctx;
  const seg = currentSegment(profile);
  const p = seg && plans ? plans.products[seg.product] : undefined;
  const info = seg ? productInfo(manifest, seg.product) : null;
  if (!seg || !plans || !rules || !info) return { text: null, issues: [{ level: "error", path: "", message: "档案没有 segments，或者模板还没有训练单" }] };
  const w = week ?? seg.week;
  if (!Number.isInteger(w) || w < 1 || w > seg.week) {
    return { text: null, issues: [{ level: "error", path: "week", message: `档案现在是第 ${seg.n} 段第 ${seg.week} 周，只能生成第 1–${seg.week} 周的计划单` }] };
  }
  const stable = seg.phase === "稳定";
  const lines: string[] = [
    `# ${profile.code} · 第 ${seg.n} 段第 ${w} 周计划（${seg.product}）`, "", DECLARATION, "",
    `<!-- 养夏计划单 段=${seg.n} 周=${w} 模板=${plans.version} 进度=${progressDate(profile)} -->`, "",
    stable ? `稳定期 12 周的第 ${w} 周：第 ${Math.floor((w - 1) / ROUND_WEEKS) + 1} 轮 · 第 ${roundWeek(w)} 周（照成品里这一轮第 ${roundWeek(w)} 周做）。`
      : `起始期${seg.type}段第 ${w} 周。`,
    "", "## 训练", "",
  ];
  if (!p) {
    lines.push(`「${seg.product}」没有训练单（不用组数、次数）：照成品做。`, "");
  } else {
    for (const day of p.segments[planType(seg)]?.days ?? []) {
      const r = exportCourse({ plans, rules, manifest, profile, week: w, day });
      for (const i of r.issues.filter((x) => x.level === "error")) issues.push({ ...i, path: `${day} 日 ${i.path}` });
      lines.push(`### ${day} 日`, "");
      for (const b of r.course?.blocks ?? []) {
        if (b.kind === "circuit") lines.push(`循环 ${b.rounds} 轮（每轮之间休息 ${b.restBetweenRounds ?? 0} 秒）：`);
        for (const it of b.items) {
          lines.push(`- ${it.name}：${itemSpec(it, b.kind === "circuit" ? b.rounds : it.sets ?? 1)}${b.kind === "sets" && it.rest ? `，组间休息 ${it.rest} 秒` : ""}`);
        }
      }
      // 给人看的单子：动作写中文名（导出结果里"照成品做"的项带的是动作编号）
      const named = (x: string) => x.replace(/^[a-z0-9]+(?:-[a-z0-9]+)*/, (id) => manifest.exercises.find((e) => e.id === id)?.name ?? id);
      for (const f of r.follow) lines.push(`- 照成品做：${named(f.name)}（${f.reason}）`);
      for (const n of r.notes) lines.push(`- ${n}`);
      lines.push("");
    }
    const cm = cardioMode(rules, profile, info, seg.n, w, ctx.reviewData);
    if (cm) lines.push(`有氧：这一周做**${cm.mode}**（${cm.why}）。时长照成品这一周的写法。`, "");
    lines.push("热身、拉伸不在这张单子里，照成品做。练的时候疼、头晕、胸闷，马上停下。", "");
  }
  // 习惯：打卡表里要数的项和这一段的习惯目标
  const ar = assessRules(rules);
  const targets: Obj = ((profile.segments as Obj[]).find((s) => s.n === seg.n) ?? {}).habitTargets ?? {};
  const habits = (ar?.habits ?? []).filter((h) => h.products.includes(info.code) && h.segments.includes(stable ? "标准" : seg.type)
    && h.weeks.includes(stable ? roundWeek(w) : w));
  lines.push("## 每日习惯", "");
  for (const h of habits) {
    const t = targets[h.habit];
    const want = h.per === "week" ? `每周 ≥ ${t?.days ?? h.days} 天` : `四周累计，成功线 ${t?.line ?? h.days} 天（生病的日子按成品折算）`;
    lines.push(`- ${h.habit}：${want}${t?.minutes ? `，每次 ${t.minutes} 分钟` : ""}`);
  }
  lines.push("- 这一周每天考核哪几项、怎么算当天达标，照成品这一周的打卡表。", "");
  // 下次评估
  const last = maxWeek(seg.phase, rules);
  const cur = (profile.segments as Obj[])[(profile.segments as Obj[]).length - 1];
  lines.push("## 下次评估", "");
  lines.push(`- ${stable ? "周期末评估" : "段末评估"}：第 ${last} 周的周复盘之后（最早 ${addDays(cur.start, 7 * (last - seg.week + 1))}）。`);
  if (typeof profile.screening?.date === "string") {
    const days = ar?.assess.params.find((x) => x.name === "筛查有效天数" && x.products.includes(info.code))?.number;
    if (days) lines.push(`- 安全筛查：${addDays(profile.screening.date, days)} 之前重做一次。`);
  }
  lines.push("");
  return { text: lines.join("\n"), issues };
}

/**
 * 档案目录里的计划单：现在这一段的，用档案重新生成一遍比对。
 * 对不上：模板版本或进度在生成之后变了 → 提醒重新生成；都没变 → 报错（手改过）。以前几段的不查。
 */
export function checkSheet(ctx: AssessContext, name: string, text: string): Issue[] {
  const mark = sheetMark(text);
  if (!mark) return [{ level: "error", path: name, message: "计划单要由命令生成（npm run course -- plan），不手写：没有找到生成标记" }];
  const seg = currentSegment(ctx.profile);
  if (!seg || mark.segment !== seg.n) return [];
  const made = buildSheet(ctx, mark.week);
  if (!made.text || made.text === text) return [];
  if (mark.templates !== ctx.plans?.version || mark.progress !== progressDate(ctx.profile)) {
    return [{ level: "warning", path: name, message: "模板或个人进度在这张计划单生成之后变过：重新生成（npm run course -- plan）" }];
  }
  // 复盘、条件变了也会让内容不一样（有氧稳态 / 间歇、条件变体）：只提醒；标记之外的手改查不出是谁改的，一律让重新生成
  return [{ level: "error", path: name, message: "计划单和按档案重新生成的不一样（手改过，或者条件、复盘变了）：重新生成（npm run course -- plan），不手改" }];
}
