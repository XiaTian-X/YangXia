// 个人计划单（v4 阶段 3）：这一周每天练什么、有氧做稳态还是间歇、习惯的达标线、下次评估。
// 由命令生成（npm run course -- plan），不手写；内容全部来自训练单、规则参数和档案，开头带声明。
// 只生成现在这一周的单子；profile check 把现在这一周和以前几周的单子都按档案重新生成、逐字比对
// （以前几周的按那一周、生成时的进度重新生成；对不上就删掉——以前几周的单子不用留）。
import { type AssessContext, assessRules, cardioMode, fallRiskList, productInfo } from "./assess.ts";
import { addDays } from "./date.ts";
import { bodySheetLines, goalSheetLines, severeObese } from "./goals.ts";
import { activeAddOns, addOnSheetLines } from "./senior.ts";
import { currentSegment, exportCourse, maxWeek, planType, ROUND_WEEKS, roundWeek } from "./plan.ts";
import { DECLARATION } from "./profile.ts";
import { progressOn } from "./progress.ts";
import { itemSpec } from "./timeline.ts";
import type { Issue } from "./types.ts";

type Obj = Record<string, any>;
const MARK = /^<!-- 养夏计划单 段=(\d+) 周=(\d+) 开始=(\d{4}-\d{2}-\d{2}) 模板=(\S+) 进度=(\d{4}-\d{2}-\d{2}\/\d+) -->$/m;
const FILE = /(?:^|[\\/])第(\d+)段-第(\d+)周\.md$/;

/** 计划单的文件名（相对档案目录）。 */
export const sheetFile = (segment: number, week: number) => `计划/第${segment}段-第${week}周.md`;

/** 计划单开头的标记：第几段、第几周、这一周从哪天开始、生成时的模板版本、进度（最后一次改动的日期 / 进度日志的条数）。 */
export function sheetMark(text: string): { segment: number; week: number; start: string; templates: string; progress: string } | null {
  const m = MARK.exec(text);
  return m ? { segment: Number(m[1]), week: Number(m[2]), start: m[3], templates: m[4], progress: m[5] } : null;
}

/** 进度截到哪里："最后一次改动的日期（没有就是开始日期）/ 进度日志的条数"——同一天又改了进度也分得出来。 */
export const progressDate = (profile: Obj) => {
  const log: Obj[] = Array.isArray(profile.progressLog) ? profile.progressLog : [];
  const day = [profile.startDate, ...log.map((e) => e?.date)].filter((d) => typeof d === "string").sort().pop() as string;
  return `${day}/${log.length}`;
};

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
    stable && info.venue === "gym" ? `稳定期 12 周的第 ${w} 周：健身房每周一样，照第 4 周的组数（每个动作 3 组），主项次数和重量照《稳定期说明》的双进阶。`
      : stable && info.venue === "chair" ? `稳定期 12 周的第 ${w} 周（第 ${Math.floor((w - 1) / ROUND_WEEKS) + 1} 轮 · 第 ${roundWeek(w)} 周）：每周都照第五章训练单第 4 周那一列练（2 组，平衡动作照第 4 周的扶法，全程扶着、不松手），加项见下。`
      : stable ? `稳定期 12 周的第 ${w} 周：第 ${Math.floor((w - 1) / ROUND_WEEKS) + 1} 轮 · 第 ${roundWeek(w)} 周（照成品里这一轮第 ${roundWeek(w)} 周做）。`
      : `起始期${seg.type}段第 ${w} 周。`,
    "", "## 训练", "",
  ];
  if (!p) {
    lines.push(`「${seg.product}」没有训练单（不用组数、次数）：照成品做。`, "");
  } else {
    const cm = cardioMode(rules, profile, info, seg.n, w, ctx.reviewData, { severe: severeObese(ctx, cur.start, info.code) });
    const cardioText = cm ? `这一周做**${cm.mode}**${cm.mode === "稳态" && cm.interval ? "，不做间歇" : ""}${cm.duration ? `，**${cm.duration}**` : ""}（${cm.why}）${cm.duration ? "" : "；时长照成品这一周的写法"}` : "";
    let cardioShown = false;
    for (const day of p.segments[planType(seg)]?.days ?? []) {
      const r = exportCourse({ plans, rules, manifest, profile, week: w, day, addOns: activeAddOns(ctx, cur.start) });
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
  // 目标（阶段 4）：减脂、增肌这一周的有氧和吃（保持的不写）
  lines.push(...goalSheetLines(ctx, entries.length - 1));
  lines.push(...bodySheetLines(ctx, entries.length - 1));
  lines.push(...addOnSheetLines(ctx, entries.length - 1));
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
  const days = ar?.assess.params.find((x) => x.name === "筛查有效天数" && x.products.includes(info.code))?.number;
  if (typeof profile.screening?.date === "string" && days) lines.push(`- 安全筛查：${addDays(profile.screening.date, days)} 之前重做一次。`);
  // 65 岁以上的跌倒风险自查：这一周开始以前最近的一份；6 个月和每年的，先到的那个
  const fr = info.age === "a65" ? fallRiskList(ctx).filter((x) => typeof x.file.raw.date === "string" && x.file.raw.date <= cur.start).pop() : undefined;
  if (fr) {
    const yearly = addDays(fr.askedOn, days ?? 365);
    const mid = fr.conclusion.reassessBy && fr.conclusion.reassessBy < yearly ? fr.conclusion.reassessBy : null;
    lines.push(`- 跌倒风险自查：${mid ?? yearly} 之前重做一次（${mid ? "约 6 个月" : "每年一次"}，照成品第〇章《跌倒风险自查》；这不是正式的跌倒风险评估）。`);
    if (fr.conclusion.effective === "高") lines.push("- 自查是高风险：随访照医生、社区卫生服务中心的安排。");
  }
  lines.push("");
  return { text: lines.join("\n"), issues };
}

/**
 * 档案目录里的计划单（profile check）：
 * - 文件名是 计划/第N段-第N周.md，要和生成标记一致；标记的段、周、开始日期要是档案 segments 里真有的那一项；还没到的周不能有；
 * - 每一张都按档案重新生成、逐字比对：截到标记的那一项，进度用生成时的（进度日志的前几条，标记里记着条数）；
 * - 现在这一周的：和按现在的进度生成的一样就通过；进度在生成之后改过、和按当时进度生成的一样的，只提醒重新生成（之后往下调过的报错）；
 * - 以前几周的：和按当时生成的一样就通过，对不上（手改过，或者模板、条件、复盘、筛查日期后来变了）就报错，删掉——以前几周的单子不用留；
 * - 模板版本和生成时不一样：报错（旧版本没法重新生成来比）。
 */
export function checkSheet(ctx: AssessContext, name: string, text: string): Issue[] {
  const err = (message: string): Issue[] => [{ level: "error", path: name, message, code: "SHEET_REGENERATE" }];
  const mark = sheetMark(text);
  if (!mark) return err("计划单要由命令生成（npm run course -- plan），不手写：没有找到生成标记");
  const fm = FILE.exec(name);
  if (!fm || Number(fm[1]) !== mark.segment || Number(fm[2]) !== mark.week) {
    return err(`计划单的文件名要是 ${sheetFile(mark.segment, mark.week)}（生成标记写的是第 ${mark.segment} 段第 ${mark.week} 周）：文件名和标记要一致，不手改`);
  }
  const seg = currentSegment(ctx.profile);
  const entries = ctx.profile.segments as Obj[] | undefined;
  if (!seg || !Array.isArray(entries) || !entries.length || !ctx.plans || !ctx.rules) return [];
  if (mark.segment > seg.n || (mark.segment === seg.n && mark.week > seg.week)) {
    return err(`档案现在是第 ${seg.n} 段第 ${seg.week} 周，这张计划单写的是第 ${mark.segment} 段第 ${mark.week} 周（还没到）：删掉，到了那一周再生成`);
  }
  const isNow = mark.segment === seg.n && mark.week === seg.week;
  const cur = entries[entries.length - 1];
  const regen = "重新生成（npm run course -- plan），不手改";
  const drop = "以前几周的计划单不用留：删掉";
  if (isNow && mark.start !== cur.start) return err(`这一周从 ${cur.start} 开始，这张计划单是按 ${mark.start} 开始的那一周生成的：${regen}`);
  const k = isNow ? entries.length - 1 : entries.findIndex((x) => x.n === mark.segment && x.week === mark.week && x.start === mark.start);
  if (k < 0) return err(`生成标记写的第 ${mark.segment} 段第 ${mark.week} 周（${mark.start} 开始）在档案 segments 里没有：${drop}，不手改`);
  if (mark.templates !== ctx.plans.version) {
    return err(`模板版本和这张计划单生成时不一样（生成时 ${mark.templates}，现在 ${ctx.plans.version}）：${isNow ? regen : drop}`);
  }
  // 截到这一项的档案；进度用生成时的那几条进度日志
  const log: Obj[] = Array.isArray(ctx.profile.progressLog) ? ctx.profile.progressLog : [];
  const count = Number(mark.progress.split("/")[1]);
  const at = (p: Obj) => ({ ...p, segments: entries.slice(0, k + 1), product: entries[k].product });
  const snapLog = log.slice(0, count);
  const snap = { ...ctx.profile, progressLog: snapLog };
  const okSnap = count <= log.length && progressDate(snap) === mark.progress;
  const thenProgress = okSnap ? progressOn(snap, ctx.plans, ctx.rules, mark.progress.split("/")[0], ctx.now, ctx.timeZone) : null;
  const madeThen = thenProgress ? buildSheet({ ...ctx, profile: at({ ...snap, progress: thenProgress }) }).text : null;
  if (!isNow) return madeThen === text ? [] : err(`以前几周的计划单和按当时的档案重新生成的不一样（手改过，或者条件、复盘、筛查后来变了）：${drop}`);
  const madeNow = buildSheet(ctx).text;
  if (madeNow === text) return [];
  if (mark.progress !== progressDate(ctx.profile) && madeThen === text) {
    // 之后往下调过（减量、退回、重来、找级降级）：旧单子比现在重，不能只提醒
    const lowered = log.slice(count).some((e) => typeof e?.to === "number"
      && (["减量", "退回", "重来"].includes(e.rule) || e.to < (thenProgress?.[e.move]?.[e.field] ?? -Infinity)));
    if (lowered) return err(`个人进度在这张计划单生成之后往下调过（生成时进度截到 ${mark.progress}）：旧单子比现在重，${regen}`);
    return [{ level: "warning", path: name, message: `个人进度在这张计划单生成之后改过（生成时 ${mark.progress}，现在 ${progressDate(ctx.profile)}）：重新生成（npm run course -- plan）`, code: "SHEET_REGENERATE" }];
  }
  return err(`计划单和按档案重新生成的不一样（手改过，或者条件、复盘变了）：${regen}`);
}
