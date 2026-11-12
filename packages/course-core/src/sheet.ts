// 个人计划单（v4 阶段 3）：这一周每天练什么、有氧做稳态还是间歇、习惯的达标线、下次评估。
// 由命令生成（npm run course -- plan），不手写；内容全部来自训练单、规则参数和档案，开头带声明。
// 只生成、只逐字核对"现在这一周"的单子；以前几周的留着不再核对内容（当时的进度、复盘都可能不一样了）。
import { type AssessContext, assessRules, cardioMode, productInfo } from "./assess.ts";
import { currentSegment, exportCourse, maxWeek, planType, ROUND_WEEKS, roundWeek } from "./plan.ts";
import { DECLARATION } from "./profile.ts";
import { localDate, progressOn } from "./progress.ts";
import { itemSpec } from "./timeline.ts";
import type { Issue } from "./types.ts";

type Obj = Record<string, any>;
const MARK = /^<!-- 养夏计划单 段=(\d+) 周=(\d+) 开始=(\d{4}-\d{2}-\d{2}) 模板=(\S+) 进度=(\d{4}-\d{2}-\d{2}) -->$/m;
const FILE = /(?:^|[\\/])第(\d+)段-第(\d+)周\.md$/;
const addDays = (d: string, n: number) => localDate(new Date(new Date(`${d}T12:00:00`).getTime() + n * 86_400_000));

/** 计划单的文件名（相对档案目录）。 */
export const sheetFile = (segment: number, week: number) => `计划/第${segment}段-第${week}周.md`;

/** 计划单开头的标记：第几段、第几周、这一周从哪天开始、生成时的模板版本、进度截到哪天。 */
export function sheetMark(text: string): { segment: number; week: number; start: string; templates: string; progress: string } | null {
  const m = MARK.exec(text);
  return m ? { segment: Number(m[1]), week: Number(m[2]), start: m[3], templates: m[4], progress: m[5] } : null;
}

/** 进度日志里最后一次改动的日期（没有就是开始日期）。 */
export const progressDate = (profile: Obj) =>
  [profile.startDate, ...(profile.progressLog ?? []).map((e: Obj) => e?.date)].filter((d) => typeof d === "string").sort().pop() as string;

/** 现在这一周（档案 segments 最后一项）的计划单。 */
export function buildSheet(ctx: AssessContext): { text: string | null; issues: Issue[] } {
  const issues: Issue[] = [];
  const { profile, manifest, plans, rules } = ctx;
  const seg = currentSegment(profile);
  const p = seg && plans ? plans.products[seg.product] : undefined;
  const info = seg ? productInfo(manifest, seg.product) : null;
  if (!seg || !plans || !rules || !info) return { text: null, issues: [{ level: "error", path: "", message: "档案没有 segments，或者模板还没有训练单" }] };
  const w = seg.week;
  const entries = profile.segments as Obj[];
  const cur = entries[entries.length - 1];
  const stable = seg.phase === "稳定";
  // 给人看的单子：动作写中文名（导出结果里的提示带的是动作编号）
  const names = new Map(manifest.exercises.map((e) => [e.id, e.name]));
  const named = (x: string) => x.replace(/[a-z][a-z0-9]*(?:-[a-z0-9]+)*/g, (id) => names.get(id) ?? id);
  const lines: string[] = [
    `# ${profile.code} · 第 ${seg.n} 段第 ${w} 周计划（${seg.product}）`, "", DECLARATION, "",
    `<!-- 养夏计划单 段=${seg.n} 周=${w} 开始=${cur.start} 模板=${plans.version} 进度=${progressDate(profile)} -->`, "",
    stable ? `稳定期 12 周的第 ${w} 周：第 ${Math.floor((w - 1) / ROUND_WEEKS) + 1} 轮 · 第 ${roundWeek(w)} 周（照成品里这一轮第 ${roundWeek(w)} 周做）。`
      : `起始期${seg.type}段第 ${w} 周。`,
    "", "## 训练", "",
  ];
  if (!p) {
    lines.push(`「${seg.product}」没有训练单（不用组数、次数）：照成品做。`, "");
  } else {
    const cm = cardioMode(rules, profile, info, seg.n, w, ctx.reviewData);
    const cardioText = cm ? `这一周做**${cm.mode}**${cm.mode === "稳态" && cm.interval ? "，不做间歇" : ""}（${cm.why}）；时长照成品这一周的写法` : "";
    let cardioShown = false;
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
      for (const f of r.follow) {
        // 有氧那一项：稳态还是间歇写在同一行，不让"按间歇做"和"这一周做稳态"并排打架
        if (cm && /有氧/.test(`${f.name}${f.reason}`)) {
          lines.push(`- 照成品做：${named(f.name)}——${cardioText}`);
          cardioShown = true;
        } else lines.push(`- 照成品做：${named(f.name)}（${named(f.reason)}）`);
      }
      for (const n of r.notes) lines.push(`- ${named(n)}`);
      lines.push("");
    }
    if (cm && !cardioShown) lines.push(`有氧：${cardioText}。`, "");
    lines.push("热身、拉伸不在这张单子里，照成品做。练的时候疼、头晕、胸闷，马上停下。", "");
  }
  // 习惯：打卡表里要数的项和这一段的习惯目标
  const ar = assessRules(rules);
  const targets: Obj = (entries.find((s) => s.n === seg.n) ?? {}).habitTargets ?? {};
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
  lines.push("## 下次评估", "");
  lines.push(`- ${stable ? "周期末评估" : "段末评估"}：第 ${last} 周的周复盘之后（最早 ${addDays(cur.start, 7 * (last - w + 1))}）。`);
  if (typeof profile.screening?.date === "string") {
    const days = ar?.assess.params.find((x) => x.name === "筛查有效天数" && x.products.includes(info.code))?.number;
    if (days) lines.push(`- 安全筛查：${addDays(profile.screening.date, days)} 之前重做一次。`);
  }
  lines.push("");
  return { text: lines.join("\n"), issues };
}

/**
 * 档案目录里的计划单：
 * - 文件名是 计划/第N段-第N周.md，要和生成标记一致；还没到的周不能有；
 * - 以前几段、以前几周的：只查标记（当时的进度、复盘可能都变了，不再核对内容）；
 * - 现在这一周的：用档案重新生成，逐字比对。对不上——这一周重新开始过、模板版本变了：报错让重新生成；
 *   进度在生成之后改过，而它和按那天的进度生成的一样、之后也没往下调过：只提醒重新生成；其余都是错误（手改过，或者条件、复盘变了）。
 */
export function checkSheet(ctx: AssessContext, name: string, text: string): Issue[] {
  const err = (message: string): Issue[] => [{ level: "error", path: name, message }];
  const mark = sheetMark(text);
  if (!mark) return err("计划单要由命令生成（npm run course -- plan），不手写：没有找到生成标记");
  const fm = FILE.exec(name);
  if (!fm || Number(fm[1]) !== mark.segment || Number(fm[2]) !== mark.week) {
    return err(`计划单的文件名要是 ${sheetFile(mark.segment, mark.week)}（生成标记写的是第 ${mark.segment} 段第 ${mark.week} 周）：文件名和标记要一致，不手改`);
  }
  const seg = currentSegment(ctx.profile);
  const entries = ctx.profile.segments as Obj[] | undefined;
  if (!seg || !Array.isArray(entries) || !entries.length) return [];
  const cur = entries[entries.length - 1];
  if (mark.segment > seg.n || (mark.segment === seg.n && mark.week > seg.week)) {
    return err(`档案现在是第 ${seg.n} 段第 ${seg.week} 周，这张计划单写的是第 ${mark.segment} 段第 ${mark.week} 周（还没到）：删掉，到了那一周再生成`);
  }
  if (mark.segment < seg.n || mark.week < seg.week) return [];
  const regen = "重新生成（npm run course -- plan），不手改";
  if (mark.start !== cur.start) return err(`这一周从 ${cur.start} 开始，这张计划单是按 ${mark.start} 开始的那一周生成的：${regen}`);
  const made = buildSheet(ctx);
  if (!made.text || made.text === text) return [];
  if (mark.templates !== ctx.plans?.version) return err(`模板版本和这张计划单生成时不一样（生成时 ${mark.templates}，现在 ${ctx.plans?.version}）：${regen}`);
  const now = progressDate(ctx.profile);
  if (mark.progress !== now && ctx.plans && ctx.rules) {
    // 进度在生成之后改过：按生成那天的进度再生成一遍，一样才算"过期"
    const log: Obj[] = ctx.profile.progressLog ?? [];
    const then = progressOn(ctx.profile, ctx.plans, ctx.rules, mark.progress, ctx.now);
    const old = { ...ctx.profile, progress: then, progressLog: log.filter((e) => typeof e?.date === "string" && e.date <= mark.progress) };
    if (buildSheet({ ...ctx, profile: old }).text === text) {
      // 之后往下调过（减量、退回、重来、找级降级）：旧单子比现在重，不能只提醒
      const lowered = log.some((e) => typeof e?.date === "string" && e.date > mark.progress && typeof e.to === "number"
        && (["减量", "退回", "重来"].includes(e.rule) || e.to < (then?.[e.move]?.[e.field] ?? -Infinity)));
      if (lowered) return err(`个人进度在这张计划单生成之后往下调过（生成时截到 ${mark.progress}）：旧单子比现在重，${regen}`);
      return [{ level: "warning", path: name, message: `个人进度在这张计划单生成之后改过（生成时截到 ${mark.progress}，现在 ${now}）：重新生成（npm run course -- plan）` }];
    }
  }
  return err(`计划单和按档案重新生成的不一样（手改过，或者条件、复盘变了）：${regen}`);
}
