// 周复盘要填什么（weekly-review skill 的网页版）：训练次数、不适从这一周的练习记录带入，
// 习惯项、按年龄段要记的数、稳态自查、减脂的每周项、每个动作的表现都从规则层和训练单推出来；
// 下一周怎么走（推到下一周 / 这一周重来 / 段末、周期末评估）也由这里算，网页只选。
import type { FormField, FormSection } from "./assess-form.ts";
import { assessRules } from "./assess.ts";
import { addDays } from "./date.ts";
import type { ProfileBundle, TemplateBundle } from "./engine.ts";
import { bodyStateOn, effectiveGoal, goalRules } from "./goals.ts";
import { productCode, type Manifest } from "./manifest.ts";
import { maxWeek, planType, roundWeek, type PlansData, type RulesData } from "./plan.ts";
import { localDate, REVIEW_FORMAT } from "./progress.ts";

type Obj = Record<string, any>;

export type NextChoice = "advance" | "repeat" | "end";

export interface ReviewSessionSummary {
  date: string;
  course: string;
  half: boolean;
  symptoms: string[];
  feeling: string;
  edited: boolean;
  items: { exercise: string; name: string; setsDone: number; setsPlanned: number; feel?: string; spare?: number; reverted?: boolean }[];
}

export interface ReviewForm {
  segment: number;
  week: number;
  start: string;
  /** 这一周最后一天。 */
  end: string;
  phase: string;
  type: string;
  product: string;
  age: string;
  /** 这一周（档案时区）手机回传的练习记录。 */
  sessions: ReviewSessionSummary[];
  /** 训练次数不能少于记录数。 */
  minTrainings: number;
  /** 记录里有疼痛、头晕、胸闷：复盘的"有不适"锁定为是。 */
  symptomsLocked: boolean;
  half: boolean;
  sections: FormSection[];
  /** 下一周怎么走（allowed 为 false 的给出原因；有不适不能推到下一周）。 */
  next: { value: NextChoice; label: string; allowed: boolean; reason?: string }[];
}

const SYMPTOM_NAMES: Record<string, string> = { pain: "疼痛", dizzy: "头晕", chest: "胸闷" };

function exerciseName(m: Manifest, id: string): string {
  const ex = m.exercises.find((e) => e.id === id);
  return ex ? ex.short || ex.name : id;
}

/**
 * 现在这一周（档案 segments 的最后一项）的周复盘表单。
 * symptoms 是使用者在表单里勾的（没勾时只看记录）：它决定"推到下一周"能不能选。
 */
export function reviewForm(bundle: ProfileBundle, t: TemplateBundle, opts: { symptoms?: boolean } = {}): ReviewForm | { error: string } {
  const p = bundle.profile as Obj;
  const ss = (p.segments ?? []) as Obj[];
  if (!ss.length) return { error: "档案还没有 segments：先做入门评估、开第一段" };
  if (!t.plans || !t.rules) return { error: "模板缺训练单或规则层" };
  const plans = t.plans as PlansData;
  const rules = t.rules as RulesData;
  const idx = ss.length - 1;
  const e = ss[idx];
  const product = e.product ?? p.product;
  const info = t.manifest.products.find((x) => x.name === product);
  const plan = plans.products[product];
  // 6–12 岁家长版没有训练单（户外与游戏）：没有"每个动作的表现"
  if (!info) return { error: `模板里没有成品「${product}」` };
  const code = productCode(info);
  const phase = e.phase ?? "起始";
  const type = planType(e);
  const end = addDays(e.start, 6);
  const tz = bundle.timeZone;

  // 这一周的练习记录
  const sessions: ReviewSessionSummary[] = bundle.sessions
    .map((s) => s.raw as Obj)
    .filter((r) => typeof r?.startedAt === "string")
    .map((r) => ({ r, date: localDate(new Date(r.startedAt), tz) }))
    .filter(({ date }) => date >= e.start && date <= end)
    .sort((a, b) => (a.r.startedAt < b.r.startedAt ? -1 : 1))
    .map(({ r, date }) => ({
      date,
      course: String(r.course?.name ?? ""),
      half: r.course?.source?.half === true,
      symptoms: Object.entries(r.symptoms ?? {}).filter(([, v]) => v === true).map(([k]) => SYMPTOM_NAMES[k] ?? k),
      feeling: String(r.feeling ?? ""),
      edited: r.edited === true,
      items: ((r.items ?? []) as Obj[]).map((it) => ({
        exercise: it.exercise, name: exerciseName(t.manifest, it.exercise), setsDone: it.setsDone, setsPlanned: it.setsPlanned,
        ...(it.feel ? { feel: it.feel } : {}), ...(Number.isInteger(it.spare) ? { spare: it.spare } : {}), ...(it.reverted ? { reverted: true } : {}),
      })),
    }));
  const symptomsLocked = sessions.some((s) => s.symptoms.length > 0);
  const half = sessions.some((s) => s.half);
  const symptoms = symptomsLocked || opts.symptoms === true;
  const sections: FormSection[] = [];

  // 这一周
  const week: FormField[] = [
    { key: "trainings", label: "这一周练了几次", required: true, input: { type: "int", min: sessions.length, max: 14 }, value: sessions.length,
      note: `手机回传的练习记录有 ${sessions.length} 条：不能少于它（没带手机练的照实加上）` },
    symptomsLocked
      ? { key: "symptoms", label: "这一周有没有疼痛、头晕、胸闷", required: true, input: { type: "yesno" }, readonly: true, value: true,
        note: "练习记录里写了：不能取消。下周不加量，按成品\"疼了怎么办\"处理；胸痛胸闷、头晕站不稳要建议就医" }
      : { key: "symptoms", label: "这一周有没有疼痛、头晕、胸闷", required: true, input: { type: "yesno" },
        note: "有的话下周不加量，按成品\"疼了怎么办\"处理；胸痛胸闷、头晕站不稳要建议就医" },
  ];
  sections.push({ id: "week", title: `第 ${e.n} 段第 ${e.week} 周（${e.start}–${end}）`, notes: half ? ["这一周练过半量课"] : [], fields: week });

  // 习惯：段末要考核的那几项（rules.habits 按成品、段型、周筛），不是每天打卡的全部
  // 起始期按段型和周次（段末照它算）；稳定期按"标准"段每周考核的那几项、轮内第几周（周期末照它算）
  const habitRules = assessRules(rules)?.habits ?? [];
  const habits = phase === "稳定"
    ? habitRules.filter((h) => h.products.includes(code) && h.segments.includes("标准") && h.per === "week" && h.weeks.includes(roundWeek(e.week)))
    : habitRules.filter((h) => h.products.includes(code) && h.segments.includes(type) && h.weeks.includes(e.week));
  if (habits.length) {
    sections.push({ id: "habits", title: "习惯（这一周达标几天）", notes: [`这里只列${phase === "稳定" ? "周期末" : "段末"}要考核的几项；照打卡记录填，记不清的按没做到填`],
      fields: habits.map((h) => ({ key: `habits.${h.habit}`, label: h.per === "week" ? `${h.habit}：这一周达标几天（${h.days} 天以上算达标）` : `${h.habit}：这一周达标几天（这一段合计 ${h.days} 天以上算达标）`,
        required: true, input: { type: "int", min: 0, max: 7 } })) });
  }

  // 按年龄段
  if (info.age === "a65") {
    sections.push({ id: "a65", title: "这一周的摔倒、头晕", notes: ["有摔倒、差点摔倒、头晕的，这一轮后面不加量；摔倒的另做触发评估"], fields: [
      { key: "falls", label: "摔倒了几次", required: true, input: { type: "int", min: 0, max: 20 } },
      { key: "nearFalls", label: "差点摔倒几次", required: true, input: { type: "int", min: 0, max: 20 } },
      { key: "dizzy", label: "头晕几次", required: true, input: { type: "int", min: 0, max: 20 } },
      { key: "weightDrop", label: "体重有没有明显下降（不记数字）", required: false, input: { type: "yesno" } },
    ] });
  }
  if (info.age === "a06") {
    sections.push({ id: "a06", title: "这一周的身体情况", notes: [], fields: [
      { key: "sickDays", label: "孩子这一周生病几天", required: true, input: { type: "int", min: 0, max: 7 } },
    ] });
  }

  // 稳态自查：有间歇的成品，每一轮第 2 周问一次
  const interval = (rules.cardio ?? []).filter((c: Obj) => c.products.includes(code) && c.when === "selfCheckPassed");
  if (interval.length && roundWeek(e.week) === 2) {
    const q = interval.flatMap((c: Obj) => (c.quotes ?? []).map((x: Obj) => x.text));
    sections.push({ id: "cardio", title: "有氧：稳态自查", notes: q, fields: [
      { key: "steadyCheck", label: "这一周的稳态有氧做完能说完整句子、第二天不觉得累吗", required: true, input: { type: "yesno" },
        note: "过了，下一周才上间歇；有高血压（或没确认）、BMI 37.5 以上又没问过医生的一直做稳态" },
    ] });
  }

  // 减脂的人：每周的有氧分钟、练完有没有没力气、体重（这一周"记"时，每周最多一次）
  const gr = goalRules(rules);
  if (effectiveGoal(p, idx, gr, code) === "减脂") {
    const fields: FormField[] = [
      { key: "cardioMinutes", label: "这一周中等强度有氧大约做了几分钟", required: true, input: { type: "int", min: 0, max: 2000 } },
      { key: "tired", label: "练完有没有没力气", required: true, input: { type: "yesno" }, note: "有的话下一周退回上一个台阶" },
    ];
    if (bodyStateOn(p, e.start) === "记") fields.push({ key: "weight", label: "这一周称的体重（公斤，一周最多一次，可以不称）", required: false, input: { type: "decimal", min: 25, max: 300, step: 0.1 } });
    sections.push({ id: "goal", title: "减脂", notes: ["出现节食、焦虑就停记体重"], fields });
  }

  // 每个动作的表现：升级、加次数照它核对（成品的"达标"）
  const moves = new Set<string>();
  for (const r of plan?.rows ?? []) {
    if (!r.segments.includes(type) || !r.weeks.includes(e.week)) continue;
    if (!(r.reps_from === "progress" || r.levels)) continue;
    if (r.trim.kind === "choose") {
      const pick = ((p.choices ?? []) as string[]).find((c) => r.moves.includes(c));
      if (pick && t.manifest.exercises.some((x) => x.id === pick)) moves.add(pick);
    } else if (r.trim.kind !== "skip") moves.add(r.moves[0]);
  }
  if (moves.size) {
    const fields: FormField[] = [];
    for (const m of moves) {
      const name = exerciseName(t.manifest, m);
      const seen = sessions.flatMap((s) => s.items.filter((it) => it.exercise === m).map((it) =>
        `${s.date}：${it.setsDone}/${it.setsPlanned} 组${it.feel ? `，感受"${it.feel}"` : ""}${it.spare !== undefined ? `，还能做 ${it.spare} 下` : ""}${it.reverted ? "，当场退回" : ""}`));
      const note = seen.length ? `记录里：${seen.join("；")}` : "这一周的记录里没有这个动作";
      fields.push(
        { key: `moves.${m}.allAtTop`, label: `${name}：每组都做到区间上限了吗`, required: false, input: { type: "yesno" }, note },
        { key: `moves.${m}.spare`, label: `${name}：最后一组还剩几次余力`, required: false, input: { type: "int", min: 0, max: 30 } },
        { key: `moves.${m}.allDone`, label: `${name}：每组都做满现在的次数了吗`, required: false, input: { type: "yesno" } },
      );
      if (info.age === "a65") fields.push({ key: `moves.${m}.easyTwice`, label: `${name}：连着两次训练都轻松吗`, required: false, input: { type: "yesno" } });
    }
    sections.push({ id: "moves", title: "每个动作的表现（升级、加次数照它核对）", notes: ["不确定的可以不填：不填的动作下周不加量"], fields });
  }

  // 下一周怎么走
  const max = maxWeek(phase, rules);
  const next: ReviewForm["next"] = [];
  if (e.week < max) {
    next.push(symptoms
      ? { value: "advance", label: `推到第 ${e.week + 1} 周`, allowed: false, reason: "这一周有不适：不能往上走，先重来这一周" }
      : { value: "advance", label: `推到第 ${e.week + 1} 周`, allowed: true });
    next.push({ value: "repeat", label: `第 ${e.week} 周重来一次`, allowed: true });
  } else {
    next.push({ value: "end", label: phase === "稳定" ? "复盘后做周期末评估" : "复盘后做段末评估", allowed: true });
  }
  return { segment: e.n, week: e.week, start: e.start, end, phase, type, product, age: info.age, sessions, minTrainings: sessions.length, symptomsLocked, half, sections, next };
}

/** 下一周的 segments 项：habitTargets、restart 只写在一段的第一项，不抄过去。 */
export function nextWeekEntry(profile: Obj, choice: NextChoice): Obj | null {
  const ss = (profile.segments ?? []) as Obj[];
  const e = ss[ss.length - 1];
  if (!e || choice === "end") return null;
  const { habitTargets: _h, restart: _r, ...base } = e;
  return { ...base, week: choice === "advance" ? e.week + 1 : e.week, start: addDays(e.start, 7) };
}

/** 照表单填的值组装复盘数据（yangxia.review/1）。动作只写 allAtTop、spare 都填了的。 */
export function buildReviewRecord(form: ReviewForm, values: Record<string, unknown>): Record<string, unknown> {
  const rec: Obj = { schema: REVIEW_FORMAT, start: form.start, week: form.week };
  const habits: Obj = {};
  const moves = new Map<string, Obj>();
  for (const f of form.sections.flatMap((s) => s.fields)) {
    const v = f.readonly ? f.value : values[f.key];
    if (v === undefined || v === "") continue;
    if (f.key.startsWith("habits.")) habits[f.key.slice(7)] = v;
    else if (f.key.startsWith("moves.")) {
      const [, move, field] = f.key.split(".");
      const m = moves.get(move) ?? { move };
      m[field] = v;
      moves.set(move, m);
    } else rec[f.key] = v;
  }
  if (form.symptomsLocked) rec.symptoms = true;
  if (Object.keys(habits).length) rec.habits = habits;
  rec.moves = [...moves.values()].filter((m) => typeof m.allAtTop === "boolean" && Number.isInteger(m.spare));
  if (form.half) rec.half = true;
  // 头晕也是不适
  if (Number.isInteger(rec.dizzy) && rec.dizzy > 0) rec.symptoms = true;
  return rec;
}
