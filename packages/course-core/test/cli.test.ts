// 命令行：导出、带档案的课程检查之前，评估记录、复盘数据本身的写法错误也要拦下（不只是 profile check）。
// 要用真模板（templates/ 或 YANGXIA_TEMPLATES）；模板不在时跳过。
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ASSESS_FORMAT } from "../src/assess.ts";
import { loadTemplates, templatesDir } from "../src/node.ts";
import { PROFILE_FORMAT } from "../src/profile.ts";

const REPO = new URL("../../../", import.meta.url).pathname;
const hasTemplates = !!(await templatesDir());
const t = hasTemplates ? await loadTemplates() : null;
const root = mkdtempSync(join(tmpdir(), "yangxia-cli-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const today = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; })();

/** 一个能导出第 1 周课程的档案目录（今天开始），files 里的文件另外写进去。 */
function dir(name: string, product: string, extra: Record<string, any>, files: Record<string, unknown>) {
  const prod = t!.manifest.products.find((p) => p.name === product)!;
  const items = t!.manifest.intake.screening.find((s) => s.age === prod.age)!.items;
  const stage = { a13: "初中", a18: "18–39 岁", a40: "40–64 岁", a65: "65 岁以上" }[prod.age as "a13"]!;
  const p = {
    schema: PROFILE_FORMAT, code: name, stage, age: prod.age, venue: prod.venue, product, startDate: today,
    screening: { answers: items.map((item) => ({ item, answer: "否" })), doctorCleared: true, date: today, doctorDate: today },
    segments: [{ n: 1, type: "标准", week: 1, start: today, product }],
    conditions: Object.fromEntries(Object.entries(t!.rules!.conditions).map(([k, v]) => [k, v.text])), choices: ["table-row", "door-row", "a13-bar-row"],
    progress: {}, progressLog: [], ...extra,
  };
  const d = join(root, name);
  mkdirSync(join(d, "评估"), { recursive: true });
  writeFileSync(join(d, "档案.json"), JSON.stringify(p));
  for (const [f, v] of Object.entries(files)) writeFileSync(join(d, f), JSON.stringify(v));
  return d;
}
const run = (...args: string[]) => spawnSync("node", [join(REPO, "packages/course-core/src/cli.ts"), ...args], { encoding: "utf8" });
const chair = [{ id: "chair-stand-30s", value: 10, hands: "扶椅子", done: true }];

describe.skipIf(!hasTemplates)("导出之前也拦评估记录的写法错误", () => {
  const a65 = (name: string, more: Record<string, unknown>) => dir(name, "65岁以上-椅子辅助版", { birth: "1950-05", habitBase: { 散步: 20 } }, {
    [`评估/${today}-入门.json`]: { schema: ASSESS_FORMAT, date: today, kind: "入门", tests: chair, companion: true, doctorCleared: true, doctorDate: today, conclusion: {} },
    ...more,
  });
  it("合格的档案能导出", () => {
    const r = run("export", a65("ok", {}), "1", "A", "--out", join(root, "ok.json"));
    expect(r.stdout).toMatch(/已导出/);
  });
  it("摔倒的触发评估没写 eventDate：导不出，也按评估那天算摔倒", () => {
    const d = a65("fall", { [`评估/${today}-触发.json`]: { schema: ASSESS_FORMAT, date: today, kind: "触发", reasons: ["摔倒"], conclusion: {} } });
    const r = run("export", d, "1", "A", "--out", join(root, "fall.json"));
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/eventDate/);
  });
  it("13–17 岁评估顶层写了体重：导不出", () => {
    const d = dir("teen", "13-17岁-纯徒手版", { school: { stage: "初中", entry: Number(today.slice(0, 4)) - 2 } }, {
      [`评估/${today}-入门.json`]: { schema: ASSESS_FORMAT, date: today, kind: "入门", weight: 52, conclusion: {} },
    });
    const r = run("export", d, "1", "A", "--out", join(root, "teen.json"));
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/只能有这些字段/);
  });
});

describe.skipIf(!hasTemplates)("profile check 查计划、菜单、复盘的声明", () => {
  it("菜单没写声明：报错；写了：通过", () => {
    const d = dir("menu", "18-39岁-纯徒手版", { birth: "1996-05", body: "不记", household: ["a18"] }, {
      [`评估/${today}-入门.json`]: { schema: ASSESS_FORMAT, date: today, kind: "入门",
        tests: [{ id: "pushup-test", level: 2, value: 12 }, { id: "wallsit-test", value: 30 }], conclusion: {} },
    });
    mkdirSync(join(d, "菜单"), { recursive: true });
    writeFileSync(join(d, "菜单", "第1周.md"), "# 第 1 周菜单\n\n周一：米饭、青菜\n");
    expect(run("profile", "check", d).stdout).toMatch(/开头要写声明/);
    writeFileSync(join(d, "菜单", "第1周.md"), "# 第 1 周菜单\n\n> 本计划由养夏计划模板生成，未经专业审核，不是医学建议，不能替代医生的判断。\n\n周一：米饭、青菜\n");
    expect(run("profile", "check", d).stdout).not.toMatch(/开头要写声明/);
  });
});

