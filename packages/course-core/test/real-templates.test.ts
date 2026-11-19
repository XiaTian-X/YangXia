// 真模板全量导出：每份有训练单的成品、每种段型、每一周、每一天（含半量、条件两边、轮换两次）都能导出，
// 而且课程检查 0 错误。模板不在（或没有训练单）时跳过。
import { describe, expect, it } from "vitest";
import { checkCourse } from "../src/check.ts";
import { loadTemplates, templatesDir } from "../src/node.ts";
import { dayRows, exportCourse, maxWeek, NO_TEMPO_REASON } from "../src/plan.ts";
import { PROFILE_FORMAT } from "../src/profile.ts";
import { sweepCases } from "./sweep.ts";

const t = (await templatesDir()) ? await loadTemplates() : null;
const START = "2025-01-06";
const plus = (d: string, k: number) => new Date(new Date(`${d}T12:00:00Z`).getTime() + k * 86_400_000).toISOString().slice(0, 10);
const STAGE: Record<string, string> = { a06: "小学", a13: "初中", a18: "18–39 岁", a40: "40–64 岁", a65: "65 岁以上" };

describe.skipIf(!t?.plans || !t?.rules)("真模板：每份成品每段每周每天都能导出", () => {
  const plans = t!.plans!;
  const rules = t!.rules!;
  for (const [name, p] of Object.entries(plans.products)) {
    it(name, () => {
      const prod = t!.manifest.products.find((x) => x.name === name)!;
      const items = t!.manifest.intake.screening.find((s) => s.age === prod.age)!.items;
      const phase = p.phase === "稳定" ? "稳定" : "起始";
      const bad: string[] = [];
      let n = 0;
      for (const type of Object.keys(p.segments)) {
        for (const side of [true, false]) {
          const conditions = Object.fromEntries(Object.entries(rules.conditions).map(([k, v]) => [k, side ? v.text : !v.text]));
          for (let w = 1; w <= maxWeek(phase, rules); w++) {
            const segments = Array.from({ length: w }, (_, i) => ({ n: 1, ...(phase === "稳定" ? { phase } : {}), type: type === "稳定" ? "标准" : type, week: i + 1, start: plus(START, 7 * i), product: name }));
            const profile: Record<string, unknown> = {
              schema: PROFILE_FORMAT, code: "sweep", stage: STAGE[prod.age], age: prod.age, venue: prod.venue, product: name, startDate: START,
              screening: { answers: items.map((item) => ({ item, answer: "否" })), doctorCleared: true, date: START, doctorDate: START },
              segments, conditions, choices: ["table-row", "door-row", "a13-bar-row"], progress: {}, progressLog: [],
              ...(prod.age === "a13" ? { school: { stage: "初中", entry: 2024 } } : { birth: { a18: "1996-05", a40: "1976-05", a65: "1950-05" }[prod.age] }),
              ...(prod.age === "a65" ? { habitBase: { 散步: 20 } } : {}), ...(prod.age === "a18" || prod.age === "a40" ? { body: "不记" } : {}),
            };
            for (const day of p.segments[type].days) {
              for (const [half, sessionsDone] of [[false, 0], [false, 1], [true, 0]] as [boolean, number][]) {
                {
                  n++;
                  const r = exportCourse({ plans, rules, manifest: t!.manifest, profile, week: w, day, half, sessionsDone });
                  const errs = r.issues.filter((i) => i.level === "error");
                  const chk = r.course ? checkCourse(r.course, { manifest: t!.manifest, readProduct: t!.readProduct, profile, plans, rules }).filter((i) => i.level === "error") : [];
                  if (errs.length || chk.length) bad.push(`${type} ${side ? "正文那一边" : "另一边"} 第${w}周 ${day}${half ? " 半量" : ""}：${[...errs, ...chk].map((i) => i.message).join(" | ").slice(0, 200)}`);
                }
              }
            }
          }
        }
      }
      expect(n).toBeGreaterThan(0);
      expect(bad.slice(0, 5)).toEqual([]);
    }, 60_000);
  }
});

// 分层：日常只跑下面这些（全部情形导出，每个选项、每个可用级过一次课程检查）；
// 全部情形都过课程检查要几分钟，发版前用 npm run snapshot -- check。
describe.skipIf(!t?.plans || !t?.rules)("真模板：每个选项、每个可用级", () => {
  const src = { plans: t!.plans!, rules: t!.rules!, manifest: t!.manifest };
  const cases = [...sweepCases(src)];

  it("全部情形都能导出；标了可导出的动作都读得出节奏", () => {
    const bad: string[] = [];
    for (const c of cases) {
      const r = exportCourse(c.input);
      for (const i of r.issues.filter((x) => x.level === "error")) bad.push(`${c.key}：${i.message}`);
      // 读不出节奏的动作要在训练单标"照成品做"（原因相同）；还标着可导出就是模板的错
      const rows = dayRows(src.plans.products[c.product], src.rules, c.input.profile, c.type, c.input.week, c.input.day);
      for (const f of r.follow.filter((x) => x.reason === NO_TEMPO_REASON)) {
        if (rows.some((x) => x.moves.includes(f.name) && x.export.ok)) bad.push(`${c.key}：${f.name} 标了可导出，但读不出节奏`);
      }
    }
    expect(bad.slice(0, 5)).toEqual([]);
  }, 60_000);

  it("每份成品的每个选项、每个级、每个加项，至少有一次通过课程检查", () => {
    const seen = new Set<string>();
    const bad: string[] = [];
    for (const c of cases) {
      const id = `${c.product}|${c.variant}`;
      if (seen.has(id)) continue;
      seen.add(id);
      const r = exportCourse(c.input);
      if (!r.course) continue;
      const errs = checkCourse(r.course, { manifest: src.manifest, readProduct: t!.readProduct, profile: c.input.profile, plans: src.plans, rules: src.rules, addOns: c.input.addOns }).filter((i) => i.level === "error");
      if (errs.length) bad.push(`${c.key}：${errs.map((i) => i.message).join(" | ").slice(0, 200)}`);
    }
    expect(seen.size).toBeGreaterThan(100);
    expect(bad.slice(0, 5)).toEqual([]);
  }, 60_000);
});
