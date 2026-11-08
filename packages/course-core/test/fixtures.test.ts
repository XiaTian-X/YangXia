// 离线样例和模板发布物一致：模板仓库在的时候核对（模板更新后忘了重新生成样例，这里会报）。
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { templatesDir } from "../src/node.ts";
import { fixturePlans, fixtureRules, readJson } from "./helpers.ts";

const dir = await templatesDir();
const dist = dir ? join(dir, "dist", "data") : "";
const has = !!dir && existsSync(join(dist, "plans.json"));

describe.skipIf(!has)("离线样例和模板 dist/data 一致（不一致就运行 node packages/course-core/test/make-fixtures.ts）", () => {
  it("规则参数一样", () => expect(fixtureRules()).toEqual(readJson(join(dist, "rules.json"))));
  it("样例里的训练单和模板的一样", () => {
    const full = readJson<{ version: string; products: Record<string, unknown> }>(join(dist, "plans.json"));
    const fix = fixturePlans();
    expect(fix.version).toBe(full.version);
    for (const [name, p] of Object.entries(fix.products)) expect(p, name).toEqual(full.products[name]);
  });
});

import { MANIFEST_FORMAT } from "../src/manifest.ts";
import { PLANS_FORMAT, RULES_FORMAT } from "../src/plan.ts";
import { CONTRACTS } from "./helpers.ts";

describe("contracts/templates.json 写的格式号和代码一致", () => {
  const c = readJson<{ manifestFormat: string; data: { file: string; format: string }[] }>(join(CONTRACTS, "templates.json"));
  it("manifest", () => expect(c.manifestFormat).toBe(MANIFEST_FORMAT));
  it("训练单、规则参数", () => expect(c.data.map((d) => d.format).sort()).toEqual([PLANS_FORMAT, RULES_FORMAT].sort()));
});
