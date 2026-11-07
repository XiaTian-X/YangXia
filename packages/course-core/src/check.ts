// 课程检查：防止 agent 自己编处方。结构校验之外，逐项核对：
// - 动作在模板动作索引里，而且用在这份成品；计次 / 计时、是否每侧和索引一致
// - 每项的 quote 逐字出现在成品里，不能是别的周的原文
// - 组数、次数、秒数、休息都能在 quote 里找到出处；区间取较轻松的一端（次数、时长取下限，休息取上限）
// - 节奏秒数出现在这个动作的呼吸节奏原文里
// - 字幕和画面文字没有这个年龄段的红线词；语音都在内置词表里
// - 带档案时：安全筛查有"是"而医生没同意、或 65 岁以上医生没同意，直接拒绝
import { type Manifest, MANIFEST_FORMAT, productCode } from "./manifest.ts";
import { redlineHits } from "./redlines.ts";
import { buildTimeline } from "./timeline.ts";
import type { Course, CourseItem, Issue } from "./types.ts";
import { validateCourse } from "./validate.ts";
import { canSpeak } from "./voice.ts";

export interface CheckContext {
  manifest: Manifest;
  /** 读成品全文（模板 dist/<成品名>.md）；读不到返回 null。 */
  readProduct: (name: string) => string | null;
  /** 个人档案（yangxia.profile/1），可选。 */
  profile?: unknown;
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

function weekMentions(quote: string): RegExpMatchArray[] {
  return [...quote.matchAll(/第\s*(\d)(?:\s*[–~\-－]\s*(\d))?\s*周/g)];
}

function weekIssue(quote: string, week: number): string | null {
  const mentions = weekMentions(quote);
  if (!mentions.length) return null;
  const covers = mentions.some((m) => {
    const a = Number(m[1]);
    const b = m[2] ? Number(m[2]) : a;
    return week >= a && week <= b;
  });
  return covers ? null : `原文写的是${mentions.map((m) => m[0]).join("、")}，不是第 ${week} 周`;
}

const cells = (line: string) => line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => plain(c));
const isSep = (line: string | undefined) => !!line && /^\s*\|[\s|:-]+\|\s*$/.test(line);
function weekRange(text: string): [number, number] | null {
  const m = text.match(/第\s*(\d)(?:\s*[–~\-－]\s*(\d))?\s*周/);
  return m ? [Number(m[1]), Number(m[2] ?? m[1])] : null;
}

/** 原文落在"一列一周"的表格里时，核对它取自哪几列：只能是本周那一列（或本周格子写着"同第 N 周"时的第 N 周那一列）。 */
export function tableWeekIssue(lines: string[], quote: string, week: number): string | null {
  let firstIssue: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim().startsWith("|") || !plain(line).includes(quote) || isSep(lines[i + 1])) continue;
    let sep = i - 1;
    while (sep >= 0 && lines[sep].trim().startsWith("|") && !isSep(lines[sep])) sep--;
    if (sep < 1 || !isSep(lines[sep])) continue;
    const head = cells(lines[sep - 1]);
    const weeks = head.map(weekRange);
    if (!weeks.some(Boolean)) return null;                     // 不是"一列一周"的表
    const row = cells(line);
    const allowed = new Set<number>();
    weeks.forEach((w, c) => {
      if (w && week >= w[0] && week <= w[1]) {
        allowed.add(c);
        const same = (row[c] ?? "").match(/同第\s*(\d)\s*周/);
        if (same) weeks.forEach((w2, c2) => w2 && Number(same[1]) >= w2[0] && Number(same[1]) <= w2[1] && allowed.add(c2));
      }
    });
    const covered = row.map((cell, c) => (cell && (quote.includes(cell) || cell.includes(quote)) ? c : -1)).filter((c) => c >= 0 && weeks[c]);
    const bad = covered.filter((c) => !allowed.has(c));
    if (!bad.length) return null;
    firstIssue ??= `原文取自表格里「${bad.map((c) => head[c]).join("、")}」那一列，不是第 ${week} 周`;
  }
  return firstIssue;
}

function checkProfile(course: Course, profile: unknown, issues: Issue[]) {
  const err = (path: string, message: string) => issues.push({ level: "error", path: `profile${path ? "." + path : ""}`, message });
  if (typeof profile !== "object" || profile === null) return err("", "档案要是 JSON 对象");
  const p = profile as Record<string, any>;
  if (p.schema !== "yangxia.profile/1") err("schema", '档案的格式标识要写 "yangxia.profile/1"');
  if (p.age !== course.age) err("age", `档案的年龄段是 ${p.age}，课程是 ${course.age}`);
  if (p.product && p.product !== course.source.product) {
    issues.push({ level: "warning", path: "profile.product", message: `档案选用的是「${p.product}」，课程出自「${course.source.product}」` });
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

  course.blocks.forEach((block, bi) => {
    if (block.kind === "circuit") {
      const qs = block.items.flatMap((it) => it.quote).map(plain);
      const rounds = numbersBefore(qs.join(" "), "轮");
      if (!rounds.singles.has(block.rounds) && !rounds.lows.has(block.rounds)) {
        err(`blocks[${bi}].rounds`, `${block.rounds} 轮在原文里找不到出处`);
      }
      const rb = block.restBetweenRounds ?? 0;
      if (rb > 0) {
        const after = qs.map((q) => { const i = Math.max(q.lastIndexOf("休息"), q.lastIndexOf("歇")); return i >= 0 ? q.slice(i) : ""; }).join(" ");
        const n = numbersBefore(after, "秒");
        if (!n.singles.has(rb) && !n.highs.has(rb)) err(`blocks[${bi}].restBetweenRounds`, `轮间休息 ${rb} 秒在原文里找不到出处`);
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
      if (![ex.short, ex.name, ...ex.aliases].includes(item.name)) warn(`${p}.name`, `名称建议用动作索引里的短名「${ex.short}」`);

      const quotes = item.quote.map(plain);
      quotes.forEach((q, qi) => {
        if (!body.includes(q)) err(`${p}.quote[${qi}]`, `原文在「${product.name}」里找不到：「${q}」`);
        const w = weekIssue(q, week) ?? tableWeekIssue(lines, q, week);
        if (w) err(`${p}.quote[${qi}]`, w);
        else if (weekMentions(q).length > 1) {
          warn(`${p}.quote[${qi}]`, "这段原文同时写了几周的安排，请只摘本周那一句，否则核对不出数字是不是本周的");
        }
      });
      const Q = quotes.join(" ");

      if (block.kind === "sets") {
        const sets = item.sets ?? 1;
        const n = numbersBefore(Q, "组");
        if (!n.singles.has(sets) && !n.lows.has(sets)) err(`${p}.sets`, `${sets} 组在原文里找不到出处`);
      }
      if (item.mode === "reps") {
        const n = numbersBefore(Q, "次");
        const x = timesNumbers(Q);
        x.singles.forEach((v) => n.singles.add(v));
        x.lows.forEach((v) => n.lows.add(v));
        x.highs.forEach((v) => n.highs.add(v));
        const reps = item.reps!;
        if (!n.singles.has(reps) && !n.lows.has(reps)) {
          err(`${p}.reps`, n.highs.has(reps) ? `${reps} 次是区间的上限，次数要取下限` : `${reps} 次在原文里找不到出处`);
        }
      } else {
        // 动作时长不看"休息"之后的秒数，否则"休息 90 秒"会被当成"撑 90 秒"的出处
        const work = quotes.map((q) => (REST.test(q) ? q.slice(0, q.search(REST)) : q)).join(" ");
        const n = numbersBefore(work, "秒");
        const d = item.duration!;
        if (!n.singles.has(d) && !n.lows.has(d)) {
          err(`${p}.duration`, n.highs.has(d) ? `${d} 秒是区间的上限，时长要取下限` : `${d} 秒在原文里找不到出处`);
        }
      }
      // 休息：原文里"休息"之后的秒数（区间取上限），或健身房训练表里的 90″ 写法；0 秒要有"不休息"
      if (item.rest === 0) {
        if (!/不休息|连续做|不停/.test(Q)) err(`${p}.rest`, '休息 0 秒要有原文出处（如"不休息"）');
      } else {
        const after = quotes.map((q) => (REST.test(q) ? q.slice(q.search(REST)) : "")).join(" ");
        const n = numbersBefore(after, "秒");
        const marks = new Set([...Q.matchAll(/(\d+)\s*″/g)].map((x) => Number(x[1])));
        const ok = n.singles.has(item.rest) || n.highs.has(item.rest) || marks.has(item.rest);
        if (!ok) err(`${p}.rest`, n.lows.has(item.rest) ? `休息 ${item.rest} 秒是区间的下限，休息要取上限` : `休息 ${item.rest} 秒在原文里找不到出处（quote 里要带上写休息时间的原文）`);
      }
      if (item.mode === "reps" && item.tempo) {
        const breath = ex.used_in.filter((u) => u.product === product.name).map((u) => u.breathing).join(" ");
        const n = numbersBefore(breath, "秒");
        const allowed = new Set([...n.singles, ...n.lows, ...n.highs]);
        if (breath.includes("半秒")) allowed.add(0.5);
        const t = item.tempo;
        for (const [k, v] of [["up", t.up], ["down", t.down], ["top", t.top ?? 0], ["bottom", t.bottom ?? 0]] as const) {
          if (v > 0 && !allowed.has(v)) err(`${p}.tempo.${k}`, `${v} 秒在「${ex.name}」的呼吸节奏原文里找不到：${breath || "（没摘到呼吸节奏）"}`);
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
  if (ctx.profile !== undefined) checkProfile(course, ctx.profile, issues);
  return issues;
}
