// 真模板全量导出：每份有训练单的成品、每种段型、每一周、每一天（含半量、条件两边、轮换两次）都能导出，
// 而且课程检查 0 错误。模板不在（或没有训练单）时跳过。
import { describe, expect, it } from "vitest";
import { checkCourse } from "../src/check.ts";
import { loadTemplates, templatesDir } from "../src/node.ts";
import { exportCourse, maxWeek } from "../src/plan.ts";
import { PROFILE_FORMAT } from "../src/profile.ts";

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
