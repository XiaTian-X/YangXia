import { describe, expect, it } from "vitest";
import { choiceGroups, exportCourse, uncoveredChoiceGroups, type PlansData, type RulesData } from "../src/index.ts";
import { loadTemplates, templatesDir } from "../src/node.ts";
import { fixtureManifest, fixturePlans } from "./helpers.ts";

describe("choiceGroups：建档向导照训练单问\"按器材选一个\"", () => {
  it("没有这份成品、或者成品里没有 choose 行时返回空", () => {
    expect(choiceGroups(fixturePlans(), fixtureManifest(), "不存在的成品")).toEqual([]);
  });

  it("真实模板：每份起始期、稳定期成品的组都能导出；13–17 岁按\"家长在旁边\"分两组；非动作 ID 的选项标不能导出", async () => {
    if (!(await templatesDir())) return;
    const t = await loadTemplates();
    const plans = t.plans as PlansData;
    const teen = choiceGroups(plans, t.manifest, "13-17岁-纯徒手版");
    expect(teen.length).toBe(2);
    const withParent = teen.find((g) => g.condition?.value === true)!;
    const noParent = teen.find((g) => g.condition?.value === false)!;
    expect(withParent.condition?.name).toBe("家长在旁边");
    expect(withParent.options.map((o) => o.value)).toContain("table-row");
    expect(noParent.options.map((o) => o.value)).not.toContain("table-row");
    expect(noParent.options.find((o) => o.value === "（毛巾划船）")).toMatchObject({ exportable: false, name: "毛巾划船" });

    // 只选桌下划船：家长不在旁边的那组没覆盖
    expect(uncoveredChoiceGroups(teen, ["table-row"]).map((g) => g.key)).toEqual([noParent.key]);
    expect(uncoveredChoiceGroups(teen, ["table-row", "door-row"])).toEqual([]);

    // 附册、餐饮模板、65 岁以上、6–12 岁没有要选的器材
    for (const name of ["65岁以上-椅子辅助版", "6-12岁-户外与游戏版（家长版）"]) {
      expect(choiceGroups(plans, t.manifest, name)).toEqual([]);
    }

    // 每份有 choose 的成品：每组选第一个可导出的选项后，用到它的那天能导出（不再报"先问使用者能用哪个"）
    for (const [name, product] of Object.entries(plans.products)) {
      const groups = choiceGroups(plans, t.manifest, name);
      if (!groups.length) continue;
      const choices = groups.map((g) => (g.options.find((o) => o.exportable) ?? g.options[0]).value);
      expect(uncoveredChoiceGroups(groups, choices)).toEqual([]);
      for (const g of groups) {
        for (const day of g.days) {
          const row = product.rows.find((r) => r.trim.kind === "choose" && r.day === day);
          if (!row) continue;
          const phase = name.includes("稳定期") ? "稳定" : "起始";
          const profile = {
            product: name,
            choices,
            conditions: g.condition ? { [g.condition.name]: g.condition.value } : {},
            segments: [{ n: 1, product: name, type: row.segments[0], phase, week: row.weeks[0], start: "2026-11-02" }],
          };
          const res = exportCourse({ plans, rules: t.rules as RulesData, manifest: t.manifest, profile, week: row.weeks[0], day });
          expect(res.issues.filter((e) => e.path === "profile.choices"), `${name} ${day}`).toEqual([]);
        }
      }
    }
  });
});
