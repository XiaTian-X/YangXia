// 课程检查：防止 agent 自己编处方。结构校验之外，逐项核对：
// - 动作在模板动作索引里，而且用在这份成品；计次 / 计时、是否每侧和索引一致
// - 每项的 quote 逐字出现在成品里，不能是别的周的原文
// - 组数、次数、秒数、休息都能在 quote 里找到出处；区间取较轻松的一端（次数、时长取下限，休息取上限）
//   组数、轮数只认本周的原文；次数、时长只认这个动作自己的原文或本周的原文（不能借别的动作、别的周的数字）
// - 节奏秒数出现在这个动作的呼吸节奏原文里（"第 3 周起放慢到 3 秒""那一级"这类有条件的写法，本周原文写了才算）
// - 字幕和画面文字没有这个年龄段的红线词；语音都在内置词表里
// - 带档案时：档案要和模板对得上（筛查逐项答全、成品和年龄段一致）；课程要出自档案选的成品、不能超过档案的周次；
//   安全筛查有"是"而医生没同意、或 65 岁以上医生没同意，直接拒绝
import { checkProfileWithTemplates } from "./intake.ts";
import { validateProfile } from "./profile.ts";
import { type Manifest, MANIFEST_FORMAT, productCode } from "./manifest.ts";
import { redlineHits } from "./redlines.ts";
import { buildTimeline } from "./timeline.ts";
import type { Course, CourseItem, Issue } from "./types.ts";
import { validateCourse } from "./validate.ts";
import { canSpeak } from "./voice.ts";
import { checkPlanCourse, currentSegment, isStartCourse, type PlansData, roundOf, type RulesData } from "./plan.ts";

export interface CheckContext {
  manifest: Manifest;
  /** 读成品全文（模板 dist/<成品名>.md）；读不到返回 null。 */
  readProduct: (name: string) => string | null;
  /** 个人档案（yangxia.profile/1），可选。 */
  profile?: unknown;
  /** 训练单、规则参数（模板 dist/data/）：课程由 course export 导出时，按它们和档案进度逐项核对。 */
  plans?: PlansData | null;
  rules?: RulesData | null;
  /** 65 岁以上稳定期这一周有效的加项（命令按档案和评估记录算好传进来，和导出时一样；不传的只按 addOnLog 重放）。 */
  addOns?: string[];
}

const REST = /休息|歇/;
const plain = (s: string) => s.replace(/\*\*/g, "").replace(/\s+/g, " ").trim();

interface Numbers {
  singles: Set<number>;
  lows: Set<number>;
  highs: Set<number>;
}

/** 取出 "N–M 单位" 和 "N 单位"。 */
export function numbersBefore(text: string, unit: string): Numbers {
  const out: Numbers = { singles: new Set(), lows: new Set(), highs: new Set() };
  const range = new RegExp(`(\\d+(?:\\.\\d+)?)\\s*[–~\\-－]\\s*(\\d+(?:\\.\\d+)?)\\s*${unit}`, "g");
  let rest = text;
  for (const m of text.matchAll(range)) {
    out.lows.add(Number(m[1]));
    out.highs.add(Number(m[2]));
    rest = rest.replace(m[0], " ");
  }
  for (const m of rest.matchAll(new RegExp(`(\\d+(?:\\.\\d+)?)\\s*${unit}`, "g"))) out.singles.add(Number(m[1]));
  return out;
}

/** "徒手深蹲 × 15""单臂哑铃划船 × 每侧 12"这类不带"次"的写法（× 后面不是组、秒、轮、分钟）。 */
export function timesNumbers(text: string): Numbers {
  const out: Numbers = { singles: new Set(), lows: new Set(), highs: new Set() };
  for (const m of text.matchAll(/×\s*(?:每侧\s*)?(\d+)(?:\s*[–~\-－]\s*(\d+))?(?!\s*(?:\d|组|秒|轮|分钟))/g)) {
    if (m[2]) {
      out.lows.add(Number(m[1]));
      out.highs.add(Number(m[2]));
    } else out.singles.add(Number(m[1]));
  }
  return out;
}

/** "第 N 周""第 N–M 周""第 N 周起（到第 4 周）"。 */
function weekMentions(quote: string): RegExpMatchArray[] {
  // "同第 2 周"是表格里"和第 2 周一样"的写法，不算写了第 2 周（由表格核对处理）
  return [...quote.replace(/同第\s*\d\s*周/g, "").matchAll(/第\s*(\d)(?:\s*[–~\-－]\s*(\d))?\s*周(起|开始|以后|之后)?/g)];
}
const mentionCovers = (m: RegExpMatchArray, week: number) => {
  const a = Number(m[1]);
  const b = m[2] ? Number(m[2]) : m[3] ? 4 : a;
  return week >= a && week <= b;
};

function weekIssue(quote: string, week: number): string | null {
  const mentions = weekMentions(quote);
  if (!mentions.length) return null;
  return mentions.some((m) => mentionCovers(m, week)) ? null : `原文写的是${mentions.map((m) => m[0]).join("、")}，不是第 ${week} 周`;
}

/**
 * 呼吸节奏原文里，本周能用的秒数：
 * - 没有附加条件的写法（"下蹲约 2 秒"）都能用；
 * - 写明周次的（"第 3 周起放慢到 3 秒"），只在那几周能用；句子里逗号后面的部分跟着前面最近的周次走；
 * - 写明"那一级"的（"下放 3 秒那一级"）是难度阶梯，不按周给，这里不算——本周的原文写了（"第 3 周｜下放放慢到 3 秒"）才算。
 */
export function tempoSeconds(breathing: string, week: number): Set<number> {
  const out = new Set<number>();
  const add = (s: string) => {
    const n = numbersBefore(s, "秒");
    [...n.singles, ...n.lows, ...n.highs].forEach((v) => out.add(v));
    if (s.includes("半秒")) out.add(0.5);
  };
  const conditional: string[] = [];
  const text = breathing.replace(/（[^（）]*）|\([^()]*\)/g, (s) => (weekMentions(s).length || /级/.test(s) ? (conditional.push(s), "") : s));
  for (const sentence of [...text.split(/[。；;]/), ...conditional]) {
    if (/级/.test(sentence) && !weekMentions(sentence).length) continue;
    let current: RegExpMatchArray[] | null = null;      // 这一句里最近的周次
    for (const part of sentence.split("，")) {
      const ms = weekMentions(part);
      if (ms.length) current = ms;
      if (!current || current.some((m) => mentionCovers(m, week))) add(part);
    }
  }
  return out;
}

/** 本周原文里写的节奏秒数（"第 3 周｜下放放慢到 3 秒"），按说的是哪一段分开：下放、停住、发力。 */
function quotedTempoSeconds(weekQuotes: string[]): Record<"up" | "down" | "top" | "bottom", Set<number>> {
  const out = { up: new Set<number>(), down: new Set<number>(), top: new Set<number>(), bottom: new Set<number>() };
  for (const q of weekQuotes) {
    for (const seg of q.split(/[|｜，。；;]/)) {
      const n = numbersBefore(seg, "秒");
      const vs = [...n.singles, ...n.lows, ...n.highs];
      const to = (k: keyof typeof out) => vs.forEach((v) => out[k].add(v));
      if (/下放|放慢|放下|坐下|蹲下/.test(seg)) to("down");
      if (/停/.test(seg)) (to("top"), to("bottom"));
      if (/发力|站起|抬起|拉起|推起/.test(seg)) to("up");
    }
  }
  return out;
}

const cells = (line: string) => line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => plain(c));
const isSep = (line: string | undefined) => !!line && /^\s*\|[\s|:-]+\|\s*$/.test(line);
function weekRange(text: string): [number, number] | null {
  const m = text.match(/第\s*(\d)(?:\s*[–~\-－]\s*(\d))?\s*周/);
  return m ? [Number(m[1]), Number(m[2] ?? m[1])] : null;
}

/** 原文落在"一列一周"的表格里时，核对它取自哪几列：只能是本周那一列（或本周格子写着"同第 N 周"时的第 N 周那一列）。 */
export function tableWeekIssue(lines: string[], quote: string, week: number): string | null {
  return tableWeek(lines, quote, week).issue;
}

/** inWeek：原文出自"一列一周"表格里本周那一列。issue：出自别的周那一列。 */
function tableWeek(lines: string[], quote: string, week: number): { inWeek: boolean; issue: string | null } {
  let firstIssue: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim().startsWith("|") || !plain(line).includes(quote) || isSep(lines[i + 1])) continue;
    let sep = i - 1;
    while (sep >= 0 && lines[sep].trim().startsWith("|") && !isSep(lines[sep])) sep--;
    if (sep < 1 || !isSep(lines[sep])) continue;
    const head = cells(lines[sep - 1]);
    const weeks = head.map(weekRange);
    if (!weeks.some(Boolean)) continue;                        // 不是"一列一周"的表
    const row = cells(line);
    const allowed = new Set<number>();
    weeks.forEach((w, c) => {
      if (w && week >= w[0] && week <= w[1]) {
        allowed.add(c);
        const same = (row[c] ?? "").match(/同第\s*(\d)\s*周/);
        if (same) weeks.forEach((w2, c2) => w2 && Number(same[1]) >= w2[0] && Number(same[1]) <= w2[1] && allowed.add(c2));
      }
    });
    const notThisWeek = [...allowed].find((c) => /不做/.test(row[c] ?? ""));
    if (notThisWeek !== undefined) {
      firstIssue ??= `这一行本周那一格写的是「${row[notThisWeek]}」：本周不做这个动作`;
      continue;
    }
    const covered = row.map((cell, c) => (cell && (quote.includes(cell) || cell.includes(quote)) ? c : -1)).filter((c) => c >= 0 && weeks[c]);
    // 别的周的格子和本周格子内容一样（或被本周格子包含，如"2 组"和"2 组，放下数 3 秒"）不算借别的周
    const sameAsAllowed = (c: number) => [...allowed].some((a) => (row[a] ?? "").includes(row[c] ?? "\u0000"));
    const bad = covered.filter((c) => !allowed.has(c) && !sameAsAllowed(c));
    if (!bad.length) return { inWeek: covered.some((c) => allowed.has(c)), issue: null };
    firstIssue ??= `原文取自表格里「${bad.map((c) => head[c]).join("、")}」那一列，不是第 ${week} 周`;
  }
  return { inWeek: false, issue: firstIssue };
}

/**
 * 原文所在的行说的是别的动作吗：那一行写着这份成品里别的动作名，却没写这个动作的名字。
 * 这样的原文不能当这个动作组数、次数、时长的出处（如桌下划船那句"4 组（第 1 周 3 组）"不能给深蹲用）。
 */
function foreignLine(lines: string[], q: string, ex: Manifest["exercises"][number], m: Manifest, code: string): boolean {
  const mine = [ex.name, ex.short, ...ex.aliases].filter((s) => s && s.length >= 2);
  // 别的动作：全名，以及名字最后两个字（"桌下（或门框）划船"这类说法也认得出是划船）
  const others = m.exercises
    .filter((e) => e.id !== ex.id && e.used.includes(code))
    .flatMap((e) => [e.name, e.short, ...e.aliases])
    .flatMap((s) => (s && s.length >= 2 ? [s, s.slice(-2)] : []))
    .filter((s) => !mine.some((n) => n.includes(s)));
  // 表格行只看行首那一格（说的是哪个动作）和原文摘到的那几格；正文看整行
  const scope = (raw: string) => {
    if (!raw.trim().startsWith("|")) return plain(raw);
    const cs = cells(raw);
    return [cs[0], ...cs.slice(1).filter((c) => c && (q.includes(c) || c.includes(q)))].join(" | ");
  };
  const hits = lines.filter((l) => plain(l).includes(q)).map(scope);
  return hits.length > 0 && hits.every((l) => others.some((o) => l.includes(o)) && !mine.some((n) => l.includes(n)));
}

/** 这个动作在这份成品里自己的原文（处方、标题）和名字，用来判断一段原文是不是在说它。 */
function ownTexts(ex: Manifest["exercises"][number], product: string): { texts: string[]; names: string[] } {
  const uses = ex.used_in.filter((u) => u.product === product);
  return {
    texts: uses.flatMap((u) => [u.prescription, u.title]).map((s) => plain(s ?? "")).filter((s) => s.length >= 2),
    names: [ex.name, ex.short, ...ex.aliases].filter((s) => s && s.length >= 2),
  };
}

function checkProfile(course: Course, profile: unknown, m: Manifest, issues: Issue[]) {
  const err = (path: string, message: string) => issues.push({ level: "error", path: `profile${path ? "." + path : ""}`, message });
  if (typeof profile !== "object" || profile === null) return err("", "档案要是 JSON 对象");
  const p = profile as Record<string, any>;
  if (p.schema !== "yangxia.profile/1") err("schema", '档案的格式标识要写 "yangxia.profile/1"');
  if (p.age !== course.age) err("age", `档案的年龄段是 ${p.age}，课程是 ${course.age}`);
  if (p.product !== course.source.product) err("product", `档案选用的是「${p.product}」，课程出自「${course.source.product}」：只能导出档案选的成品`);
  const week = currentSegment(p)?.week ?? 1;
  if (course.source.week > week) {
    err("week", `档案现在是第 ${week} 周，课程是第 ${course.source.week} 周：下一周要等周复盘按成品规则放行（weekly-review）后再导出`);
  }
  for (const i of [...validateProfile(p), ...checkProfileWithTemplates(p, m)]) {
    if (i.level === "error") issues.push({ ...i, path: `profile.${i.path}` });
  }
  const sc = p.screening;
  if (!sc || !Array.isArray(sc.answers) || typeof sc.doctorCleared !== "boolean") {
    return err("screening", "档案缺少安全筛查结果（answers、doctorCleared）——没做筛查不能出课程");
  }
  const yes = sc.answers.filter((a: any) => a?.answer === "是").map((a: any) => a.item);
  if (course.age === "a65" && !sc.doctorCleared) {
    err("screening", "65 岁以上开始前都要先问医生：医生同意之前不出课程");
  }
  if (yes.length && !sc.doctorCleared) {
    err("screening", `安全筛查有"是"（${yes.join("；")}）：先问医生，医生同意之前不出课程`);
  }
}

export function checkCourse(raw: unknown, ctx: CheckContext): Issue[] {
  const { course, issues } = validateCourse(raw);
  if (!course) return issues;
  const err = (path: string, message: string) => issues.push({ level: "error", path, message });
  const warn = (path: string, message: string) => issues.push({ level: "warning", path, message });
  const m = ctx.manifest;

  if (m.format !== MANIFEST_FORMAT) {
    err("", `模板 manifest 的格式是「${m.format}」，这里只认 ${MANIFEST_FORMAT}，请先更新模板`);
    return issues;
  }
  const product = m.products.find((p) => p.name === course.source.product);
  if (!product) {
    err("source.product", `模板里没有成品「${course.source.product}」`);
    return issues;
  }
  if (product.age !== course.age) err("age", `成品「${product.name}」的年龄段是 ${product.age}，课程写的是 ${course.age}`);
  const code = productCode(product);
  const text = ctx.readProduct(product.name);
  if (text === null) {
    err("source.product", `读不到成品正文「${product.file}」`);
    return issues;
  }
  const body = plain(text);
  const lines = text.split("\n");
  const week = course.source.week;
  // 由 course export 从训练单导出的课程：按训练单和档案进度逐项核对；原文核对只给起点课程
  // （标准段、不带条件变体、起始级、次数取下限）再跑一遍作第二层，它报的问题记成警告（训练单和正文的一致由模板仓库保证）
  const fromPlan = course.source.plan !== undefined;
  const profileObj = (ctx.profile ?? null) as Record<string, any> | null;
  let textLevel: "error" | "warning" | null = "error";
  if (fromPlan) {
    if (!ctx.plans || !ctx.rules) {
      err("source.plan", "课程是从训练单导出的，但模板没有训练单（dist/data/）：先更新模板");
      return issues;
    }
    if (!profileObj) err("source.plan", "从训练单导出的课程要连同档案一起检查（--profile）");
    else {
      issues.push(...checkPlanCourse(course, ctx.plans, ctx.rules, m, profileObj, ctx.addOns));
      textLevel = isStartCourse(ctx.plans, ctx.rules, profileObj, course) ? "warning" : null;
    }
  } else if (ctx.plans && ctx.rules && profileObj) {
    // 带档案、模板有训练单：手写的课程不放行（原文核对管不了条件、进度和训练日）
    err("source.plan", "这份课程不是用 course export 从训练单导出的：带档案检查时只认导出的课程，用 npm run course -- export 重新导出，不要手写处方");
  } else {
    warn("source.plan", "这份课程不是用 course export 从训练单导出的：用 npm run course -- export 重新导出，不要手写处方");
  }
  if (!fromPlan) {
    course.blocks.forEach((b, bi) => b.items.forEach((it, ii) => {
      if (it.figure !== undefined) err(`blocks[${bi}].items[${ii}].figure`, "手写的课程不能写 figure（动作示意动图只给 course export 导出的课程）");
    }));
  }
  const textErr = (path: string, message: string) => {
    if (!textLevel) return;
    // 第二层里，"原文在成品里找不到"是真错（训练单给的出处原文必须逐字在成品里），其余是原文核对认不出的写法，记警告
    const level = textLevel === "warning" && /^原文在「/.test(message) ? "error" : textLevel;
    issues.push({ level, path, message: textLevel === "warning" ? `原文核对（第二层）：${message}` : message });
  };

  course.blocks.forEach((block, bi) => {
    if (block.kind === "circuit") {
      const qs = block.items.flatMap((it) => it.quote).map(plain);
      const wq = qs.filter((q) => (weekMentions(q).length && !weekIssue(q, week)) || tableWeek(lines, q, week).inWeek);
      const rounds = numbersBefore(wq.join(" "), "轮");
      if (!rounds.singles.has(block.rounds) && !rounds.lows.has(block.rounds)) {
        textErr(`blocks[${bi}].rounds`, `${block.rounds} 轮在本周的原文里找不到出处（要摘写着"第 ${week} 周"的原文）`);
      }
      const rb = block.restBetweenRounds ?? 0;
      if (rb > 0) {
        const after = qs.map((q) => { const i = Math.max(q.lastIndexOf("休息"), q.lastIndexOf("歇")); return i >= 0 ? q.slice(i) : ""; }).join(" ");
        const n = numbersBefore(after, "秒");
        if (!n.singles.has(rb) && !n.highs.has(rb)) textErr(`blocks[${bi}].restBetweenRounds`, `轮间休息 ${rb} 秒在原文里找不到出处`);
      }
    }
    block.items.forEach((item: CourseItem, ii) => {
      const p = `blocks[${bi}].items[${ii}]`;
      const ex = m.exercises.find((e) => e.id === item.exercise);
      if (!ex) {
        err(`${p}.exercise`, `动作索引里没有「${item.exercise}」`);
        return;
      }
      if (!ex.used.includes(code)) err(`${p}.exercise`, `「${ex.name}」不在成品「${product.name}」里（它用在 ${ex.used.join("、")}）`);
      if (ex.mode !== item.mode) err(`${p}.mode`, `「${ex.name}」在动作索引里是${ex.mode === "timed" ? "计时" : "按次计数"}动作`);
      if (ex.per_side !== (item.perSide ?? false)) err(`${p}.perSide`, `「${ex.name}」在动作索引里${ex.per_side ? "要" : "不"}分左右侧`);
      // 从训练单导出的课程，难度级不是起始级时名称是"短名·级名"
      if (![ex.short, ex.name, ...ex.aliases].includes(item.name) && !(fromPlan && item.name.startsWith(`${ex.short}·`))) warn(`${p}.name`, `名称建议用动作索引里的短名「${ex.short}」`);

      const quotes = item.quote.map(plain);
      const weekQ: string[] = [];   // 本周的原文：写着本周（"第 N 周"），或出自"一列一周"表格的本周那一列
      const ownQ: string[] = [];    // 这个动作自己的原文：它在本成品的处方、标题，或写着它的名字
      const own = ownTexts(ex, product.name);
      quotes.forEach((q, qi) => {
        if (!body.includes(q)) textErr(`${p}.quote[${qi}]`, `原文在「${product.name}」里找不到：「${q}」`);
        const tw = tableWeek(lines, q, week);
        const w = weekIssue(q, week) ?? tw.issue;
        const foreign = foreignLine(lines, q, ex, m, code);
        if (w) textErr(`${p}.quote[${qi}]`, w);
        else {
          const ms = weekMentions(q);
          // 行首写着本周的表格行（"| 第 4 周 | 3 组 | …把第 3 周做扎实"）就是本周的，行里提到别的周只是引用
          const rowIsWeek = lines.some((l) => l.trim().startsWith("|") && plain(l).includes(q) && ((r) => !!r && week >= r[0] && week <= r[1])(weekRange(cells(l)[0] ?? "")));
          const mixed = !rowIsWeek && ms.some((x) => !mentionCovers(x, week));
          if (ms.length > 1 && textLevel === "error") {
            warn(`${p}.quote[${qi}]`, "这段原文同时写了几周的安排，请只摘本周那一句，否则核对不出数字是不是本周的");
          }
          // 同时写了别的周的句子不算本周的出处；说的是别的动作的那一行也不算
          if ((ms.length || tw.inWeek) && !mixed && !foreign) weekQ.push(q);
        }
        if (!foreign && (own.texts.some((x) => x.includes(q)) || own.names.some((n) => q.includes(n)))) ownQ.push(q);
      });
      // 成品写明"第 N 周开始做""下一轮才用"的动作，不能提前导出
      const uses = ex.used_in.filter((u) => u.product === product.name);
      const round = ctx.plans ? roundOf((ctx.profile ?? {}) as Record<string, any>, ctx.plans) : currentSegment((ctx.profile ?? {}) as Record<string, any>)?.n ?? 1;
      if (uses.length && uses.every((u) => (u.from_week ?? 1) > week)) {
        err(`${p}.exercise`, `「${ex.name}」成品写明第 ${Math.min(...uses.map((u) => u.from_week ?? 1))} 周开始做，现在是第 ${week} 周`);
      }
      if (uses.length && uses.every((u) => (u.from_round ?? 1) > round)) {
        err(`${p}.exercise`, `「${ex.name}」成品写明${Math.min(...uses.map((u) => u.from_round ?? 1)) >= 3 ? "再下一轮" : "下一轮"}才用，现在是第 ${round} 轮`);
      }
      const Q = quotes.join(" ");
      const WQ = weekQ.join(" ");
      const NQ = [...new Set([...weekQ, ...ownQ])];   // 次数、时长的出处

      if (block.kind === "sets") {
        const sets = item.sets ?? 1;
        const n = numbersBefore(WQ, "组");
        if (!n.singles.has(sets) && !n.lows.has(sets)) {
          textErr(`${p}.sets`, `${sets} 组在本周的原文里找不到出处（组数要摘写着"第 ${week} 周"的原文，或"一列一周"表格里本周那一列）`);
        }
      }
      if (item.mode === "reps") {
        const n = numbersBefore(NQ.join(" "), "次");
        const x = timesNumbers(NQ.join(" "));
        x.singles.forEach((v) => n.singles.add(v));
        x.lows.forEach((v) => n.lows.add(v));
        x.highs.forEach((v) => n.highs.add(v));
        const reps = item.reps!;
        if (!n.singles.has(reps) && !n.lows.has(reps)) {
          textErr(`${p}.reps`, n.highs.has(reps) ? `${reps} 次是区间的上限，次数要取下限`
            : `${reps} 次在原文里找不到出处（次数要摘「${ex.name}」自己的处方，或本周的原文）`);
        }
      } else {
        // 动作时长不看"休息"之后的秒数，否则"休息 90 秒"会被当成"撑 90 秒"的出处
        const work = NQ.map((q) => (REST.test(q) ? q.slice(0, q.search(REST)) : q)).join(" ");
        const n = numbersBefore(work, "秒");
        const d = item.duration!;
        if (!n.singles.has(d) && !n.lows.has(d)) {
          textErr(`${p}.duration`, n.highs.has(d) ? `${d} 秒是区间的上限，时长要取下限`
            : `${d} 秒在原文里找不到出处（时长要摘「${ex.name}」自己的处方，或本周的原文）`);
        }
      }
      // 休息：原文里"休息"之后的秒数（区间取上限），或健身房训练表里的 90″ 写法；0 秒要有"不休息"
      if (item.rest === 0) {
        if (!/不休息|连续做|不停/.test(Q)) textErr(`${p}.rest`, '休息 0 秒要有原文出处（如"不休息"）');
      } else {
        const after = quotes.map((q) => (REST.test(q) ? q.slice(q.search(REST)) : "")).join(" ");
        const n = numbersBefore(after, "秒");
        const marks = new Set([...Q.matchAll(/(\d+)\s*″/g)].map((x) => Number(x[1])));
        const ok = n.singles.has(item.rest) || n.highs.has(item.rest) || marks.has(item.rest);
        if (!ok) textErr(`${p}.rest`, n.lows.has(item.rest) ? `休息 ${item.rest} 秒是区间的下限，休息要取上限` : `休息 ${item.rest} 秒在原文里找不到出处（quote 里要带上写休息时间的原文）`);
      }
      if (item.mode === "reps" && item.tempo) {
        // 呼吸节奏原文里"第 3 周起放慢到 3 秒""下放 3 秒那一级"这类有条件的写法，只有本周的原文写了才算
        const breath = ex.used_in.filter((u) => u.product === product.name).map((u) => u.breathing).join("。");
        const base = tempoSeconds(breath, week);
        const quoted = quotedTempoSeconds(weekQ);
        const t = item.tempo;
        for (const [k, v] of [["up", t.up], ["down", t.down], ["top", t.top ?? 0], ["bottom", t.bottom ?? 0]] as const) {
          if (v > 0 && !base.has(v) && !quoted[k].has(v)) {
            textErr(`${p}.tempo.${k}`, `${v} 秒在「${ex.name}」本周能用的呼吸节奏里找不到（写明别的周、"那一级"的秒数，要本周的原文写了才算）：${breath || "（没摘到呼吸节奏）"}`);
          }
        }
      }
    });
  });

  // 字幕、画面、语音
  const tl = buildTimeline(course);
  const seen = new Set<string>();
  const texts = [course.name, ...tl.events.flatMap((e) => [e.tag, e.label, e.breathText, e.display, e.srtText ?? ""])];
  for (const s of texts) {
    for (const w of redlineHits(m.redlines, course.age, s, false)) {
      if (!seen.has(w)) {
        seen.add(w);
        err("", `字幕或画面里有这个年龄段的红线词「${w}」：${s}`);
      }
    }
  }
  for (const ev of tl.events) {
    if (ev.voice && !canSpeak(ev.voice)) err("", `内置语音说不出「${ev.voice}」`);
  }
  if (ctx.profile !== undefined) checkProfile(course, ctx.profile, m, issues);
  return issues;
}
