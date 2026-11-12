// 训练单（模板 dist/data/plans.json，yangxia.plans/1）和规则参数（rules.json，yangxia.rules/1）：
// - exportCourse：按档案（成品、段、周、进度、条件、器材）把某一天导出成课程，agent 只选哪一天，不填数字；
// - checkPlanCourse：用同一份档案重新导出一遍，和课程逐项比对（"和训练单 + 档案进度逐项核对"）。
// 训练单和成品正文的一致性由模板仓库的 check.py 保证（表格独立推一遍比对、原句逐字核对、漏转核对）。
import type { Manifest, ManifestExercise } from "./manifest.ts";
import type { Block, Course, CourseItem, Issue, Tempo } from "./types.ts";

export const PLANS_FORMAT = "yangxia.plans/1";
export const RULES_FORMAT = "yangxia.rules/1";

export interface Reps {
  min: number;
  max: number;
  unit: "reps" | "seconds";
}
export type Trim =
  | { kind: "keep" | "skip" | "add-if-time" | "choose" }
  | { kind: "cut-if-late"; n: number }
  | { kind: "rotate"; unit: "session" | "week"; group: string };

export interface PlanRow {
  segments: string[];
  weeks: number[];
  day: string;
  block: "sets" | "circuit";
  order: number;
  moves: string[];
  sets: number | null;
  reps: Reps | null;
  reps_from: "progress" | "week" | null;
  levels: number[] | null;
  rest: number | null;
  condition: { name: string; value: boolean } | null;
  trim: Trim;
  export: { ok: true } | { ok: false; reason: string };
  quotes: { section: string; text: string }[];
  note: string;
  /** 标准段每一周的出处原文（组数、次数、休息摘自正文哪几句）。 */
  evidence?: Record<string, string[]>;
  /** 这个位置在正文里写的呼吸节奏（D 日循环用循环那里的）。 */
  breathing?: string;
  /** 健身房稳定期：这一行走双进阶（周表定次数的主项；原文的例外动作没有）。 */
  double?: boolean;
}

export interface LadderLevel {
  level: number;
  name: string;
  exercise: string;
  start: boolean;
  /** 第 1 段（这一轮）这份成品能不能用。 */
  usable: boolean;
  /** 以后几段才能用：{成品代码: 从第几段起}。 */
  later?: Record<string, number>;
  export: { ok: true } | { ok: false; reason: string };
  tempo: { down?: number; bottom?: number; top?: number };
}

export interface ProductPlan {
  code: string;
  age: string;
  venue: string;
  segments: Record<string, { days: string[] }>;
  rows: PlanRow[];
  ladders: Record<string, LadderLevel[]>;
  /** 起始 / 稳定（v4 阶段 3）。稳定期成品的 code 是家族代码（和起始期成品一样），rows 的段型是"稳定"、周次 1–12。 */
  phase?: string;
  /** 稳定期成品：同一家族的起始期成品名。 */
  base?: string | null;
}

export interface PlansData {
  format: string;
  version: string;
  products: Record<string, ProductPlan>;
}

export interface RulesData {
  format: string;
  conditions: Record<string, { ask: string; products: string[]; default: boolean; text: boolean; per_session?: boolean; note: string }>;
  progress: { rule: string; products: string[]; value: { min: number; max: number } | null | string; note: string }[];
  slowdown: { products: string[]; weeks: number[]; moves: string[] | null; down: number; circuits: boolean }[];
  /** 稳定期参数和周期末规则（v4 阶段 3）。 */
  stable?: {
    cycleWeeks: number;
    roundWeeks: number;
    params: { name: string; products: string[]; value: string; number?: number; note: string }[];
    nextCycle: { order: number; when: { kind: string }[]; result: string; next: { phase: string; type?: string; hold?: boolean }; quotes: { section: string; text: string }[]; note: string }[];
  };
  /** 每一轮哪几周稳态、哪几周间歇。 */
  cardio?: { products: string[]; phase?: string; weeks: number[]; mode: string; duration?: string; when: string; quotes: { section: string; text: string }[]; note: string }[];
  /** 由两项条件合起来的组合条件。 */
  derivedConditions?: { name: string; all: { name: string; value: boolean }[] }[];
}

export const ROUND_WEEKS = 4;
/** 一段最多几周：起始期 4，稳定期 12（一个周期）。 */
export const maxWeek = (phase: string | undefined, rules?: RulesData | null) => (phase === "稳定" ? rules?.stable?.cycleWeeks ?? 12 : 4);
/** 这一周是这一轮的第几周（稳定期每 4 周一轮；起始期就是周次本身）。 */
export const roundWeek = (week: number) => ((week - 1) % ROUND_WEEKS) + 1;
/** 训练单里的段型：稳定期的段取"稳定"行，起始期按档案的段型（标准 / 减量）。 */
export const planType = (seg: { phase?: string; type?: string }) => (seg.phase === "稳定" ? "稳定" : seg.type ?? "标准");
/** 稳定期参数（按家族代码取）。 */
export function stableParam(rules: RulesData | null | undefined, code: string, name: string): { value: string; number?: number } | undefined {
  return rules?.stable?.params.find((x) => x.name === name && x.products.includes(code));
}

type Obj = Record<string, any>;

/** 档案最后一段：成品、段型、第几段、第几周。 */
export function currentSegment(profile: Obj): { product: string; type: string; n: number; week: number; phase: string } | null {
  const segs = profile?.segments;
  if (!Array.isArray(segs) || !segs.length) return null;
  const s = segs[segs.length - 1] ?? {};
  return { product: s.product ?? profile.product, type: s.type ?? "标准", n: s.n ?? 1, week: s.week ?? 1, phase: s.phase ?? "起始" };
}

/** 条件取值：档案记了就用档案的，没记按规则层的"没确认时"。 */
export function conditionValue(rules: RulesData, profile: Obj, name: string): boolean {
  // 组合条件（如"高血压没问过医生"）：每一项都成立才成立，各项没确认时按各自的"没确认时"
  const d = rules.derivedConditions?.find((x) => x.name === name);
  if (d) return d.all.every((part) => conditionValue(rules, profile, part.name) === part.value);
  const v = profile?.conditions?.[name];
  const c = rules.conditions[name];
  // 没记的按规则层的"没确认时"；规则层也没有这个条件的，取正文以外的那一边（保守）
  return typeof v === "boolean" ? v : c ? c.default : true;
}

/** 这一段（第 n 段）、这一周允许的难度级：第 1 段按训练单这一行的"级"；第 2 段起按阶梯表"成品 + 以后"放开（成品："下一轮第 1 周直接用最后定下的级"）。 */
export function allowedLevels(p: ProductPlan, row: PlanRow | null, round: number, rules?: RulesData): Set<number> {
  const out = new Set<number>();
  // 条件变体（不是正文那一边）写的级是上限，哪一轮都生效（如骨质疏松：单腿硬拉只到扶墙那一级）
  const c = row?.condition;
  const variant = !!c && !!rules && rules.conditions[c.name] && c.value !== rules.conditions[c.name].text;
  for (const mv of row?.moves ?? []) {
    const ladder = p.ladders[mv];
    if (!ladder) continue;
    for (const lv of ladder) {
      const later = lv.later?.[p.code];
      const ok = round <= 1 ? lv.usable && (row?.levels ?? []).includes(lv.level) : lv.usable || (later !== undefined && later <= round);
      if (ok && (!variant || (row?.levels ?? []).includes(lv.level))) out.add(lv.level);
    }
  }
  return out;
}

/**
 * 第几轮 = 同一个年龄段里已经练完的 4 周轮数 + 1：
 * - 起始期的段练到第 4 周算一轮（换成品、没练满 4 周就新开的段不算：
 *   "下一轮才用"的级、40–64 岁推迟的升级要真的练完一轮）；
 * - 稳定期的段每满 4 周算一轮（被提前截断的只算练满的 4 周）；正在进行的稳定段，前面练完的 4 周也算。
 * 直接进稳定期的人从第 1 轮起；从起始期升上来的人，稳定期第 1–4 周至少是第 2 轮。
 */
export function roundOf(profile: Obj, plans: PlansData, index?: number): number {
  const ss: Obj[] = Array.isArray(profile?.segments) ? profile.segments : [];
  if (!ss.length) return 1;
  const i = index ?? ss.length - 1;
  const age = plans.products[ss[i].product]?.age;
  const lastOf = new Map<number, Obj>();
  for (let k = 0; k < i; k++) if (ss[k].n < ss[i].n) lastOf.set(ss[k].n, ss[k]);
  let rounds = 0;
  for (const e of lastOf.values()) {
    if (plans.products[e.product]?.age !== age) continue;
    rounds += e.phase === "稳定" ? Math.floor(e.week / ROUND_WEEKS) : e.week === 4 ? 1 : 0;
  }
  if (ss[i].phase === "稳定") rounds += Math.floor((ss[i].week - 1) / ROUND_WEEKS);
  return 1 + rounds;
}



/** 某一段、某一周、某一天的训练单行（条件按档案选好一边），按顺序。 */
export function dayRows(p: ProductPlan, rules: RulesData, profile: Obj, type: string, week: number, day: string): PlanRow[] {
  return p.rows
    .filter((r) => r.segments.includes(type) && r.weeks.includes(week) && r.day === day)
    .filter((r) => !r.condition || conditionValue(rules, profile, r.condition.name) === r.condition.value)
    .sort((a, b) => Number(a.block === "circuit") - Number(b.block === "circuit") || a.order - b.order);
}

/** 这个动作（或阶梯）在这一周的处方行（次数来源是"进度"的那一行），用来查次数区间、允许的级。 */
export function progressRow(p: ProductPlan, rules: RulesData, profile: Obj, type: string, week: number, move: string): PlanRow | null {
  const rows = p.rows.filter((r) => r.segments.includes(type) && r.weeks.includes(week) && r.moves.includes(move)
    && (!r.condition || conditionValue(rules, profile, r.condition.name) === r.condition.value));
  return rows.find((r) => r.reps_from === "progress" && r.reps) ?? rows.find((r) => r.reps) ?? null;
}

/** 起始级：阶梯表里这份成品标了"起始"的那一级。 */
export function startLevel(ladder: LadderLevel[]): number {
  return ladder.find((l) => l.start && l.usable)?.level ?? 1;
}

/** 规则层的某条进度规则对这份成品的取值（找级周、升级周……）；没写返回 undefined，写了"无"返回 null。 */
export function ruleValue(rules: RulesData, code: string, rule: string): { min: number; max: number } | null | undefined {
  const r = rules.progress.find((x) => x.rule === rule && x.products.includes(code));
  if (!r) return undefined;
  return typeof r.value === "object" ? r.value : null;
}

const plain = (s: string) => s.replace(/\*\*/g, "").replace(/\s+/g, " ").trim();
const DOWN = /放下|下放|下沉|下蹲|蹲下|往回|放回|送回|伸回|降回|坐下|往下|慢慢放|靠近|弯曲|屈肘|屈膝/;

/**
 * 从"呼吸节奏"原文读出平时的节奏：发力时呼气（up）、还原时吸气（down），"停 N 秒"是停顿（发力后是 top，下放后是 bottom）。
 * 读不出发力和下放各几秒就返回 null（课程不写节奏，编排器用默认节奏）。
 */
export function baseTempo(breathing: string): Tempo | null {
  // 括号里写着周次、"那一级"、"进阶"的是有条件的写法，不算平时的节奏；"（约 2 秒）"这类照常读
  const first = plain(breathing).replace(/（[^（）]*）|\([^()]*\)/g, (s) => (/周|级|进阶/.test(s) ? "" : s)).split(/[。；;]/)[0] ?? "";
  const segs = first.split("→").map((seg, i) => {
    const m = seg.match(/(\d+(?:\.\d+)?)(?:\s*[–-]\s*\d+(?:\.\d+)?)?\s*秒/);
    const sec = m ? Number(m[1]) : /半秒/.test(seg) ? 0.5 : null;
    return { i, seg, sec, hold: /停/.test(seg.replace(/不停|别把气停住/g, "")) };
  });
  // 发力：第一个"呼气"且写了秒数的一段；还原：第一个"吸气"、写了秒数、说的是往下 / 往回的一段（没有就取第一个吸气的一段）
  const up = segs.find((x) => !x.hold && x.sec !== null && /呼气/.test(x.seg));
  const inhale = segs.filter((x) => !x.hold && x.sec !== null && /吸气/.test(x.seg));
  const down = inhale.find((x) => DOWN.test(x.seg)) ?? inhale[0];
  if (!up || !down) return null;
  const t: Tempo = { start: up.i < down.i ? "up" : "down", up: up.sec!, down: down.sec! };
  for (const h of segs.filter((x) => x.hold && x.sec !== null)) {
    // 停顿跟在哪一段后面：发力之后是顶点停，还原之后是底部停
    const prev: { i: number } | undefined = [up, down].filter((x) => x.i < h.i).sort((a, b) => b.i - a.i)[0];
    if (prev === up && t.top === undefined) t.top = h.sec!;
    else if (prev === down && t.bottom === undefined) t.bottom = h.sec!;
  }
  const ok = (v: number | undefined) => v === undefined || (v >= 0.5 && v <= 10 && Number.isInteger(v * 2));
  return ok(t.up) && ok(t.down) && ok(t.top) && ok(t.bottom) ? t : null;
}

export interface ExportInput {
  plans: PlansData;
  rules: RulesData;
  manifest: Manifest;
  profile: Obj;
  week: number;
  day: string;
  /** 轮换组这一次做哪一个：{组名: 动作}。不写按规则算（每周轮换按周次，每次轮换按 sessionsDone）。 */
  picks?: Record<string, string>;
  /** 这一段里这一天已经练过几次（每次轮换用）。 */
  sessionsDone?: number;
  /** 课程 id（不写按成品、周、日生成）。 */
  id?: string;
  /** 半量（中断、生病回来的第一次，设计值 HALF）：每个动作组数、循环轮数减半向上取整，次数、秒数、休息不变。 */
  half?: boolean;
}

export interface ExportResult {
  course: Course | null;
  /** 这一天照成品做、不在课程里的项（交替动作、有氧、原文有歧义……）。 */
  follow: { name: string; reason: string }[];
  /** 本周不做、有时间可以加、时间不够先砍。 */
  notes: string[];
  issues: Issue[];
}

function exName(ex: ManifestExercise, lv: LadderLevel | null, ladder: LadderLevel[] | null): string {
  if (!lv || !ladder || lv.level === startLevel(ladder) || ladder.filter((l) => l.exercise === lv.exercise).length <= 1) return ex.short;
  const full = `${ex.short}·${lv.name}`;
  return full.length <= 24 ? full : ex.short;
}

/** 档案选的成品、最后一段的段型和周次，导出某一天。 */
export function exportCourse(input: ExportInput): ExportResult {
  const { plans, rules, manifest, profile, week, day } = input;
  const out: ExportResult = { course: null, follow: [], notes: [], issues: [] };
  const err = (path: string, message: string) => out.issues.push({ level: "error", path, message });
  if (plans.format !== PLANS_FORMAT || rules.format !== RULES_FORMAT) {
    err("", `模板的训练单格式不对（要 ${PLANS_FORMAT}、${RULES_FORMAT}）：先更新模板仓库`);
    return out;
  }
  const seg = currentSegment(profile);
  if (!seg) {
    err("profile.segments", "档案没有 segments（每一段的成品、段型、第几段、第几周）");
    return out;
  }
  const productName = seg.product;
  const p = plans.products[productName];
  const prod = manifest.products.find((x) => x.name === productName);
  if (!p || !prod) {
    err("profile.product", `「${productName}」没有训练单（6–12 岁版、全家餐饮没有训练课程）`);
    return out;
  }
  if (Number.isInteger(week) && week >= 1 && week < seg.week && seg.phase === "稳定" && roundWeek(week) > roundWeek(seg.week)) {
    // 稳定期每一轮从第 1 周（2 组、常速）重新走：上一轮后面几周的处方比现在重，不能回头导出
    err("week", `档案现在是稳定期第 ${seg.week} 周（这一轮第 ${roundWeek(seg.week)} 周）：第 ${week} 周是一轮的第 ${roundWeek(week)} 周，比现在这一周重，不能导出（只能导出不超过这一轮第 ${roundWeek(seg.week)} 周的周）`);
    return out;
  }
  if (!Number.isInteger(week) || week < 1 || week > seg.week) {
    err("week", `档案现在是第 ${seg.n} 段第 ${seg.week} 周，只能导出第 1–${seg.week} 周（下一周要等周复盘放行）`);
    return out;
  }
  const ptype = planType(seg);
  if ((p.phase ?? "起始") !== seg.phase) {
    err("profile.segments", `「${productName}」是${p.phase ?? "起始"}期的成品，档案这一段写的是${seg.phase}期：phase 要和成品一致`);
    return out;
  }
  const days = p.segments[ptype]?.days ?? [];
  if (!days.includes(day)) {
    err("day", `${productName}的${ptype}段没有 ${day} 日（有 ${days.join("、")}）`);
    return out;
  }
  const rows = dayRows(p, rules, profile, ptype, week, day);
  const choices: string[] = Array.isArray(profile.choices) ? profile.choices : [];
  const progress: Obj = profile.progress ?? {};
  const picks: Record<string, string> = {};
  const blocks: Block[] = [];
  let circuit: { rounds: number; rest: number; items: CourseItem[] } | null = null;
  const sets: CourseItem[] = [];

  for (const r of rows) {
    const label = r.moves.join(" / ");
    if (r.trim.kind === "skip") {
      out.notes.push(`本周不做：${label}`);
      continue;
    }
    if (r.trim.kind === "add-if-time") {
      out.follow.push({ name: label, reason: "有时间可以加（成品写的是有富余才加），默认不在课程里" });
      continue;
    }
    let move = r.moves[0];
    if (r.trim.kind === "rotate") {
      const group = r.trim.group;
      const members = rows.filter((x) => x.trim.kind === "rotate" && (x.trim as { group: string }).group === group).map((x) => x.moves[0]);
      const want = input.picks?.[group];
      const auto = r.trim.unit === "week" ? members[(week - 1) % members.length] : members[(input.sessionsDone ?? 0) % members.length];
      const pick = want ?? auto;
      if (want && !members.includes(want)) err(`source.picks.${group}`, `轮换组「${group}」只有 ${members.join("、")}`);
      picks[group] = pick;
      if (move !== pick) continue;
    }
    if (r.trim.kind === "choose") {
      const hit = choices.find((c) => r.moves.includes(c));
      if (!hit) {
        err(`profile.choices`, `「${label}」要按器材选一个：档案的 choices 里还没有这几个里的任何一个，先问使用者能用哪个`);
        continue;
      }
      move = hit;
    }
    if (r.trim.kind === "cut-if-late") out.notes.push(`时间不够先砍：${move}（第 ${r.trim.n} 个砍）`);
    const cond = r.condition ? rules.conditions[r.condition.name] : null;
    if (r.condition && cond?.per_session) {
      const v = conditionValue(rules, profile, r.condition.name);
      out.notes.push(`每次练之前确认：${cond.ask}？档案记的是${typeof profile?.conditions?.[r.condition.name] === "boolean" ? (v ? "是" : "否") : "没确认（按保守版本）"}；当天不一样就照成品原文换做法（${move}）`);
    }
    if (move.startsWith("（")) {
      out.follow.push({ name: move.slice(1, -1), reason: r.export.ok ? "不在动作索引里" : r.export.reason });
      continue;
    }
    if (!r.export.ok) {
      out.follow.push({ name: move, reason: r.export.reason });
      continue;
    }
    // 训练单这一行写了"级"才按个人进度的难度级做；没写的（如循环里的"徒手深蹲 × 15"）照写的那个动作做
    const ladder = r.levels ? p.ladders[move] ?? null : null;
    let lv: LadderLevel | null = null;
    let exerciseId = move;
    if (ladder) {
      const level = Number.isInteger(progress[move]?.level) ? progress[move].level : startLevel(ladder);
      lv = ladder.find((l) => l.level === level) ?? null;
      const ok = allowedLevels(p, { ...r, moves: [move] }, roundOf(profile, plans), rules);
      if (!lv || !ok.has(level)) {
        err(`profile.progress.${move}.level`, `「${move}」第 ${level} 级第 ${seg.n} 段第 ${week} 周不能用（这一周可以用第 ${[...ok].join("、")} 级）`);
        continue;
      }
      if (!lv.export.ok) {
        out.follow.push({ name: `${move} 第 ${level} 级「${lv.name}」`, reason: lv.export.reason });
        continue;
      }
      exerciseId = lv.exercise;
    }
    const ex = manifest.exercises.find((e) => e.id === exerciseId);
    if (!ex || !r.reps) {
      err(`plans.${move}`, `动作索引里没有「${exerciseId}」，或训练单没写次数：先更新模板`);
      continue;
    }
    let amount = r.reps.min;
    if (r.reps_from === "progress" && Number.isInteger(progress[move]?.reps)) amount = progress[move].reps;
    if (amount < r.reps.min || amount > r.reps.max) {
      err(`profile.progress.${move}.reps`, `「${move}」进度记的是 ${amount}，这一周的区间是 ${r.reps.min}–${r.reps.max}`);
      continue;
    }
    const item: CourseItem = {
      exercise: ex.id,
      name: exName(ex, lv, ladder),
      mode: ex.mode,
      ...(r.block === "sets" ? { sets: input.half ? Math.ceil((r.sets ?? 1) / 2) : r.sets ?? 1 } : {}),
      ...(ex.mode === "reps" ? { reps: amount } : { duration: amount }),
      ...(ex.per_side ? { perSide: true } : {}),
      rest: r.block === "circuit" ? 0 : r.rest ?? 0,
      quote: quotesFor(r, week),
    };
    if (ex.mode === "reps") {
      // 呼吸节奏：训练单这一行在正文里那个位置的（循环用循环那里写的）；难度级换了动作的，用那个动作的
      const own = ex.used_in.filter((u) => u.product === productName).map((u) => u.breathing);
      const breath = (lv && lv.exercise !== move ? own[0] : r.breathing) ?? own[0] ?? "";
      const base = baseTempo(breath);
      if (!base) {
        out.follow.push({ name: move, reason: "呼吸节奏原文没写发力、下放各几秒，课程格式要写节奏，照成品做" });
        continue;
      }
      {
        const t: Tempo = { ...base, ...(lv?.tempo ?? {}) };
        for (const s of rules.slowdown) {
          if (!s.products.includes(p.code) || !s.weeks.includes(seg.phase === "稳定" ? roundWeek(week) : week)) continue;
          if (r.block === "circuit" && !s.circuits) continue;
          if (s.moves ? !s.moves.includes(ex.id) && !s.moves.includes(move) : !base.down) continue;
          t.down = Math.max(t.down, s.down);
        }
        item.tempo = t;
      }
    }
    if (r.block === "circuit") {
      circuit ??= { rounds: input.half ? Math.ceil((r.sets ?? 1) / 2) : r.sets ?? 1, rest: r.rest ?? 0, items: [] };
      circuit.items.push(item);
    } else sets.push(item);
  }
  if (sets.length) blocks.push({ kind: "sets", items: sets });
  if (circuit) blocks.push({ kind: "circuit", rounds: circuit.rounds, restBetweenRounds: circuit.rest, items: circuit.items });
  if (out.issues.some((i) => i.level === "error")) return out;
  if (!blocks.length) {
    out.issues.push({ level: "warning", path: "", message: `第 ${week} 周 ${day} 日没有能导出的动作：这一天照成品做（见下面的清单）` });
    return out;
  }
  const short = productName.replace(/岁-/, " ").replace(/版.*$/, "");
  out.course = {
    schema: "yangxia.course/1",
    id: input.id ?? `c_${hash(`${productName}|${seg.n}|${seg.type}|${week}|${day}${input.half ? "|half" : ""}`)}`,
    name: `${short} · 第 ${week} 周 · ${day} 日${input.half ? " · 半量" : ""}`.slice(0, 60),
    age: prod.age as Course["age"],
    source: {
      product: productName, templates: plans.version, week, day,
      plan: PLANS_FORMAT, segment: seg.n, type: seg.type, phase: seg.phase,
      ...(Object.keys(picks).length ? { picks } : {}),
      ...(input.half ? { half: true } : {}),
    } as Course["source"],
    blocks,
  };
  return out;
}

const tempoText = (t: Tempo | undefined) =>
  t ? `${t.start === "up" ? "发力" : "下放"}起：发力 ${t.up}、顶停 ${t.top ?? 0}、下放 ${t.down}、底停 ${t.bottom ?? 0} 秒` : "（不写）";

function quotesFor(r: PlanRow, week: number): string[] {
  const xs = [...(r.evidence?.[String(week)] ?? []), ...r.quotes.map((q) => q.text)];
  const uniq = [...new Set(xs.map((x) => x.slice(0, 200)).filter((x) => x.length >= 2))];
  return (uniq.length ? uniq : [`训练单：${r.moves.join(" / ")} 第 ${week} 周 ${r.day} 日`]).slice(0, 4);
}

function hash(s: string): string {
  let h = 2166136261;
  for (const ch of s) h = Math.imul(h ^ ch.codePointAt(0)!, 16777619) >>> 0;
  return h.toString(36).padStart(7, "0").slice(0, 12);
}

/** 起点课程：标准段、不带条件变体、每个动作都是起始级、次数取区间下限。只有这样的课程才再跑一遍原文核对。 */
export function isStartCourse(plans: PlansData, rules: RulesData, profile: Obj, course: Course): boolean {
  const seg = currentSegment(profile);
  const p = plans.products[course.source.product];
  // 稳定期的课程不做原文核对（成品里的 4 周表是按轮写的，周次对不上；稳定段由标准段派生，按训练单核对）
  if (!seg || !p || (course.source as Obj).type !== "标准" || (course.source as Obj).half === true || seg.phase === "稳定") return false;
  const rows = dayRows(p, rules, profile, "标准", course.source.week, course.source.day ?? "");
  if (rows.some((r) => r.condition && conditionValue(rules, profile, r.condition.name) !== rules.conditions[r.condition.name]?.text)) return false;
  for (const r of rows) {
    for (const m of r.moves) {
      const pr = profile.progress?.[m];
      if (p.ladders[m] && pr?.level !== undefined && pr.level !== startLevel(p.ladders[m])) return false;
      if (r.reps_from === "progress" && r.reps && pr?.reps !== undefined && pr.reps !== r.reps.min) return false;
    }
  }
  return true;
}

/** 用同一份档案重新导出一遍，和课程逐项比对：动作、组数、次数或秒数、休息、节奏、轮数。 */
export function checkPlanCourse(course: Course, plans: PlansData, rules: RulesData, manifest: Manifest, profile: Obj): Issue[] {
  const issues: Issue[] = [];
  const err = (path: string, message: string) => issues.push({ level: "error", path, message });
  const src = course.source as Obj;
  const seg = currentSegment(profile);
  if (seg && src.segment !== undefined && src.segment !== seg.n) err("source.segment", `课程是第 ${src.segment} 段的，档案现在是第 ${seg.n} 段：重新导出`);
  if (seg && src.type !== undefined && src.type !== seg.type) err("source.type", `课程是${src.type}段的，档案现在是${seg.type}段：重新导出`);
  if (seg && (src.phase ?? "起始") !== seg.phase) err("source.phase", `课程是${src.phase ?? "起始"}期的，档案现在是${seg.phase}期：重新导出`);
  const want = exportCourse({ plans, rules, manifest, profile, week: course.source.week, day: course.source.day ?? "", picks: src.picks, half: src.half === true });
  for (const i of want.issues) issues.push({ ...i, path: `训练单 ${i.path}` });
  if (!want.course) return issues;
  const a = course.blocks;
  const b = want.course.blocks;
  if (a.length !== b.length) {
    err("blocks", `课程有 ${a.length} 块，按训练单和档案应该是 ${b.length} 块（重新用 course export 导出）`);
    return issues;
  }
  a.forEach((blk, bi) => {
    const wb = b[bi];
    if (blk.kind !== wb.kind) return err(`blocks[${bi}]`, `应该是${wb.kind === "circuit" ? "循环" : "逐个动作"}`);
    if (blk.kind === "circuit" && wb.kind === "circuit") {
      if (blk.rounds !== wb.rounds) err(`blocks[${bi}].rounds`, `训练单这一周是 ${wb.rounds} 轮，课程写 ${blk.rounds} 轮`);
      if ((blk.restBetweenRounds ?? 0) !== (wb.restBetweenRounds ?? 0)) err(`blocks[${bi}].restBetweenRounds`, `轮间休息应该是 ${wb.restBetweenRounds} 秒`);
    }
    const wantIds = wb.items.map((x) => x.exercise).join("、");
    if (blk.items.length !== wb.items.length || blk.items.some((x, i) => x.exercise !== wb.items[i].exercise)) {
      return err(`blocks[${bi}].items`, `动作和顺序应该是：${wantIds}；课程是：${blk.items.map((x) => x.exercise).join("、")}`);
    }
    blk.items.forEach((it, ii) => {
      const w = wb.items[ii];
      const p = `blocks[${bi}].items[${ii}]`;
      if (it.name !== w.name) err(`${p}.name`, `名称应该是「${w.name}」（难度级），课程写「${it.name}」`);
      for (const k of ["sets", "reps", "duration", "rest", "mode", "perSide"] as const) {
        const x = it[k] ?? (k === "sets" ? 1 : k === "perSide" ? false : undefined);
        const y = w[k] ?? (k === "sets" ? 1 : k === "perSide" ? false : undefined);
        if (x !== y) err(`${p}.${k}`, `按训练单和档案进度应该是 ${y ?? "（不写）"}，课程写 ${x ?? "（不写）"}`);
      }
      const ta = tempoText(it.tempo);
      const tb = tempoText(w.tempo);
      if (ta !== tb) err(`${p}.tempo`, `节奏应该是 ${tb}，课程写 ${ta}`);
    });
  });
  return issues;
}
