// 个人进度怎么改（不配大模型也能照成品规则改：v2 第一轮审查 P0-7）：能改哪些动作、哪几项、现在是多少，
// 有哪些规则、各要什么依据、依据可以选哪几份记录。改不改、改成多少由使用者照规则定；写入后由 checkProgressLog 重放核对，不合规则的拒。
import type { ProfileBundle, TemplateBundle } from "./engine.ts";
import { productCode } from "./manifest.ts";
import { planType, type PlansData, type RulesData } from "./plan.ts";
import { localDate, progressOn, reviewDataName, UP_RULES } from "./progress.ts";

type Obj = Record<string, any>;
type Field = "level" | "reps" | "weight";

export interface ProgressRuleOption {
  rule: string;
  /** 一句话说这条规则什么时候能用（照成品规则；细节由重放核对时给原因）。 */
  when: string;
  fields: Field[];
  /** 依据：练习记录、上一周的复盘数据、触发评估；null 是不用依据。 */
  evidence: "session" | "review" | "session-or-review" | "assessment" | null;
  /** 往上加的规则：这一段（稳定期这一轮）或上一周有疼痛、头晕、胸闷时不能用（找级往下降一级除外）。 */
  up: boolean;
}

export interface ProgressMove {
  move: string;
  name: string;
  fields: Field[];
  current: Partial<Record<Field, number>>;
  /** 难度阶梯（有 level 的）。 */
  levels: { level: number; name: string }[];
}

export interface ProgressForm {
  moves: ProgressMove[];
  rules: ProgressRuleOption[];
  evidence: { sessions: { value: string; label: string }[]; reviews: { value: string; label: string }[]; assessments: { value: string; label: string }[] };
}

const RULE_OPTIONS: Omit<ProgressRuleOption, "up">[] = [
  { rule: "建档", when: "第一次记起始值：这份成品开始的那一周（重量起始期没记的，稳定期第 1 周可以补）", fields: ["level", "reps", "weight"], evidence: null },
  { rule: "找级", when: "找级周里照练习记录这个动作的感受升或降一级", fields: ["level"], evidence: "session" },
  { rule: "退回", when: "练习记录里这个动作标了\"当场退回\"：降回上一级", fields: ["level"], evidence: "session" },
  { rule: "减量", when: "往下调（降级、减次数、减重量）随时可以", fields: ["level", "reps", "weight"], evidence: null },
  { rule: "升级", when: "升级周、上一周的复盘里这个动作每组都做到区间上限、最后一组还有余力", fields: ["level"], evidence: "review" },
  { rule: "加次数", when: "上一周的复盘里每组都做满、余力够（健身房稳定期双进阶看最近一次练习记录）", fields: ["reps"], evidence: "session-or-review" },
  { rule: "调重量", when: "起始期调重量周：练习记录里这个动作还能做 6 下以上", fields: ["weight"], evidence: "session" },
  { rule: "加重", when: "起始期加重周", fields: ["weight"], evidence: null },
  { rule: "加一档", when: "健身房稳定期双进阶：次数做到区间上限、练习记录每组做完、余力够、没有当场退回", fields: ["weight"], evidence: "session" },
  { rule: "重来", when: "65 岁以上从第 1 周重来那一段开始那天，改回起始值", fields: ["level", "reps"], evidence: "assessment" },
];

export function progressForm(bundle: ProfileBundle, t: TemplateBundle, opts: { now?: Date } = {}): ProgressForm | { error: string } {
  const p = bundle.profile as Obj;
  const ss = (p.segments ?? []) as Obj[];
  const e = ss[ss.length - 1];
  if (!e) return { error: "档案还没有 segments" };
  if (!t.plans || !t.rules) return { error: "模板缺训练单或规则层" };
  const plans = t.plans as PlansData;
  const plan = plans.products[e.product ?? p.product];
  if (!plan) return { error: "这份成品没有训练单，不记个人进度" };
  const info = t.manifest.products.find((x) => x.name === (e.product ?? p.product));
  const gym = info ? productCode(info).endsWith("·gym") : false;
  const type = planType(e);
  const state = progressOn(p, plans, t.rules as RulesData, "9999-12-31", opts.now ?? new Date(), bundle.timeZone) as Record<string, Obj>;
  const name = (id: string) => {
    const ex = t.manifest.exercises.find((x) => x.id === id);
    return ex ? ex.short || ex.name : id;
  };
  const moves = new Map<string, ProgressMove>();
  for (const r of plan.rows) {
    if (!r.segments.includes(type)) continue;
    const ids = r.trim.kind === "choose" ? r.moves.filter((m) => ((p.choices ?? []) as string[]).includes(m)).slice(0, 1) : [r.moves[0]];
    for (const m of ids) {
      if (!t.manifest.exercises.some((x) => x.id === m)) continue;
      const fields: Field[] = [];
      if (r.levels && plan.ladders[m]) fields.push("level");
      if (r.reps_from === "progress") fields.push("reps");
      if (gym) fields.push("weight");
      if (!fields.length) continue;
      const cur = moves.get(m) ?? { move: m, name: name(m), fields: [], current: {}, levels: (plan.ladders[m] ?? []).map((l) => ({ level: l.level, name: l.name })) };
      for (const f of fields) if (!cur.fields.includes(f)) cur.fields.push(f);
      for (const f of cur.fields) if (typeof state[m]?.[f] === "number") cur.current[f] = state[m][f];
      moves.set(m, cur);
    }
  }
  const sessions = bundle.sessions
    .filter((s) => typeof s.raw?.startedAt === "string")
    .sort((a, b) => (a.raw.startedAt < b.raw.startedAt ? 1 : -1))
    .slice(0, 30)
    .map((s) => ({ value: s.name, label: `${localDate(new Date(s.raw.startedAt), bundle.timeZone)} · ${s.raw.course?.name ?? "练习记录"}` }));
  const reviews = (ss as { n: number; start: string; week: number }[]).filter((x) => bundle.reviewData[reviewDataName(x)])
    .map((x) => ({ value: `复盘/${reviewDataName(x)}`, label: `第 ${x.n} 段第 ${x.week} 周（${x.start} 起）的复盘` }))
    .reverse();
  const assessments = bundle.assessments.filter((a) => a.raw?.kind === "触发")
    .map((a) => ({ value: a.name, label: `${a.raw.date} 的触发评估（${(a.raw.reasons ?? []).join("、")}）` }));
  const rules = RULE_OPTIONS.filter((r) => r.fields.some((f) => f !== "weight" || gym)).map((r) => ({ ...r, up: (UP_RULES as readonly string[]).includes(r.rule) }));
  return { moves: [...moves.values()], rules, evidence: { sessions, reviews, assessments } };
}
