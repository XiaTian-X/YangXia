// 枚举"能导出的所有情形"：导出快照（export-snapshot.ts）和全量导出测试（real-templates.test.ts）共用。
// 范围：成品、段型、周、日、条件两边、轮次，以及这一天用到的每个器材选项、每个可用难度级、半量、轮换、65 岁以上的加项。
import type { ExportInput, PlansData, PlanRow, ProductPlan, RulesData } from "../src/plan.ts";
import { addOnDefs, allowedLevels, dayRows, maxWeek, startLevel } from "../src/plan.ts";
import type { Manifest } from "../src/manifest.ts";
import { PROFILE_FORMAT } from "../src/profile.ts";

export interface SweepSource {
  plans: PlansData;
  rules: RulesData;
  manifest: Manifest;
}

export interface SweepCase {
  /** 这一种情形的唯一名字，快照比对用。 */
  key: string;
  product: string;
  /** 训练单的段型：标准、减量、稳定。 */
  type: string;
  /** 变化的是什么："默认"、"选项 door-row"、"级 pushup 3"、"半量"、"轮换第 2 次"、"加项 xxx"。 */
  variant: string;
  input: ExportInput;
}

const START = "2025-01-06";
const STAGE: Record<string, string> = { a06: "小学", a13: "初中", a18: "18–39 岁", a40: "40–64 岁", a65: "65 岁以上" };
const BIRTH: Record<string, string> = { a18: "1996-05", a40: "1976-05", a65: "1950-05" };
const plus = (d: string, k: number) => new Date(new Date(`${d}T12:00:00Z`).getTime() + k * 86_400_000).toISOString().slice(0, 10);

/** 这份成品"按器材选一个"的所有选项（含括号占位），按训练单顺序去重。 */
export function chooseOptions(p: ProductPlan): string[] {
  return [...new Set(p.rows.filter((r) => r.trim.kind === "choose").flatMap((r) => r.moves))];
}

/** 档案的段：前面练完 round - 1 轮，这一段走到第 week 周。稳定期的 round 只分"直接进入"（1）和"从起始期升上来"（2）。 */
function segments(name: string, p: ProductPlan, type: string, round: number, week: number) {
  const stable = p.phase === "稳定";
  const before = round - 1;
  const out: Record<string, unknown>[] = [];
  let day = 0;
  for (let n = 1; n <= before; n++) {
    for (let w = 1; w <= 4; w++) out.push({ n, type: "标准", week: w, start: plus(START, 7 * day++), product: stable ? p.base ?? name : name });
  }
  for (let w = 1; w <= week; w++) {
    out.push({ n: before + 1, ...(stable ? { phase: "稳定" } : {}), type: type === "稳定" ? "标准" : type, week: w, start: plus(START, 7 * day++), product: name });
  }
  return out;
}

function makeProfile(src: SweepSource, name: string, p: ProductPlan, type: string, round: number, week: number, side: boolean) {
  const prod = src.manifest.products.find((x) => x.name === name)!;
  const items = src.manifest.intake.screening.find((s) => s.age === prod.age)?.items ?? [];
  const segs = segments(name, p, type, round, week);
  return {
    schema: PROFILE_FORMAT, code: "sweep", stage: STAGE[prod.age], age: prod.age, venue: prod.venue, product: name, startDate: START,
    screening: { answers: items.map((item) => ({ item, answer: "否" })), doctorCleared: true, date: START, doctorDate: START },
    segments: segs,
    conditions: Object.fromEntries(Object.entries(src.rules.conditions).map(([k, v]) => [k, side ? v.text : !v.text])),
    choices: chooseOptions(p), progress: {} as Record<string, unknown>, progressLog: [],
    ...(prod.age === "a13" ? { school: { stage: "初中", entry: 2024 } } : { birth: BIRTH[prod.age] }),
    ...(prod.age === "a65" ? { habitBase: { 散步: 20 } } : {}), ...(prod.age === "a18" || prod.age === "a40" ? { body: "不记" } : {}),
  };
}

/** 枚举所有情形。每个情形的 input 可以直接交给 exportCourse。 */
export function* sweepCases(src: SweepSource): Generator<SweepCase> {
  const { plans, rules, manifest } = src;
  for (const [name, p] of Object.entries(plans.products)) {
    const stable = p.phase === "稳定";
    const last = maxWeek(stable ? "稳定" : "起始", rules);
    const options = chooseOptions(p);
    const addOns = stable ? addOnDefs(rules, p.code) : [];
    for (const type of Object.keys(p.segments)) {
      for (const round of stable ? [1, 2] : [1, 2, 3]) {
        for (let week = 1; week <= last; week++) {
          for (const day of p.segments[type].days) {
            for (const side of [true, false]) {
              const key = `${name}|${type}|第${round}轮|第${week}周|${day}日|${side ? "正文一边" : "另一边"}`;
              const base = () => makeProfile(src, name, p, type, round, week, side);
              // 条件按这一边选好的行：另一边的行（比如骨质疏松收窄了级）不算这一边能用的选项和级
              const rows: PlanRow[] = dayRows(p, rules, base(), type, week, day);
              const one = (variant: string, profile: ReturnType<typeof base>, extra: Partial<ExportInput> = {}): SweepCase => ({
                key: `${key}|${variant}`, product: name, type, variant,
                input: { plans, rules, manifest, profile, week, day, ...extra },
              });
              yield one("默认", base());
              yield one("半量", base(), { half: true });
              if (rows.some((r) => r.trim.kind === "rotate")) yield one("轮换第 2 次", base(), { sessionsDone: 1 });
              const here = options.filter((o) => rows.some((r) => r.trim.kind === "choose" && r.moves.includes(o)));
              for (const o of here) yield one(`选项 ${o}`, { ...base(), choices: [o, ...options.filter((x) => x !== o)] });
              const seen = new Set<string>();
              for (const r of rows) {
                if (!r.levels) continue;
                for (const mv of r.moves) {
                  const ladder = p.ladders[mv];
                  if (!ladder || seen.has(mv)) continue;
                  seen.add(mv);
                  const start = startLevel(ladder);
                  for (const level of allowedLevels(p, { ...r, moves: [mv] }, stable ? round + Math.floor((week - 1) / 4) : round, rules)) {
                    if (level === start) continue;
                    yield one(`级 ${mv} ${level}`, { ...base(), choices: [mv, ...options.filter((x) => x !== mv)], progress: { [mv]: { level } } });
                  }
                }
              }
              for (const a of addOns) {
                if (rows.some((r) => r.moves.includes(a.move))) yield one(`加项 ${a.id}`, base(), { addOns: [a.id] });
              }
            }
          }
        }
      }
    }
  }
}
