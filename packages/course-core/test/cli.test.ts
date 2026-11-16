// 命令行：导出、带档案的课程检查之前，评估记录、复盘数据本身的写法错误也要拦下（不只是 profile check）。
// 要用真模板（templates/ 或 YANGXIA_TEMPLATES）；模板不在时跳过。
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ASSESS_FORMAT } from "../src/assess.ts";
import { loadTemplates, templatesDir } from "../src/node.ts";
import { PROFILE_FORMAT } from "../src/profile.ts";
import { REVIEW_FORMAT } from "../src/progress.ts";

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
// 跌倒风险自查（阶段 3c）：一般性 3 问都"否"、两项步态都在线内
const lowRisk = { askedOn: today, general: { fell: false, unsteady: false, fear: false }, needsSupport: false, hardToStand: false, dizzy: false,
  walk4m: { seconds: 3.6, cane: false, siteOk: true, testedOn: today }, tug: { seconds: 9.8, cane: false, siteOk: true, chairOk: true, testedOn: today } };
const lowRiskConclusion = { level: "低", worst: null, effective: "低", gaitOfficial: false, gaitMargin: false, gaitIncomplete: false, doctorFirst: false, officialNeeded: false, reassessBy: null };

describe.skipIf(!hasTemplates)("导出之前也拦评估记录的写法错误", () => {
  const a65 = (name: string, more: Record<string, unknown>) => dir(name, "65岁以上-椅子辅助版", { birth: "1950-05", habitBase: { 散步: 20 } }, {
    [`评估/${today}-入门.json`]: { schema: ASSESS_FORMAT, date: today, kind: "入门", tests: chair, companion: true, doctorCleared: true, doctorDate: today,
      fallRisk: lowRisk, conclusion: { fallRisk: lowRiskConclusion } },
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

const STABLE_BW = "18-39岁-纯徒手版（稳定期）";
describe.skipIf(!hasTemplates || !t!.plans?.products[STABLE_BW])("稳定期：有基础的人直接进入，导出课程、生成计划单", () => {
  const entry = (fields: Record<string, unknown> = {}) => ({ [`评估/${today}-入门.json`]: { schema: ASSESS_FORMAT, date: today, kind: "入门", base: 2,
    tests: [{ id: "pushup-test", level: 3, value: 10 }, { id: "wallsit-test", value: 45 }], conclusion: {}, ...fields } });
  const stable = (name: string, extra: Record<string, unknown> = {}, files: Record<string, unknown> = entry()) => {
    const d = dir(name, STABLE_BW, { birth: "1996-05", body: "不记", focus: { areas: ["训练"] }, ...extra }, files);
    const p = JSON.parse(readFileSync(join(d, "档案.json"), "utf8"));
    p.segments[0].phase = "稳定";
    writeFileSync(join(d, "档案.json"), JSON.stringify(p));
    return d;
  };
  it("第 1 周能导出，提示这一周有氧做稳态；档案检查通过", () => {
    const d = stable("st-ok");
    const r = run("export", d, "1", "A");
    expect(r.stdout).toMatch(/已导出/);
    expect(r.stdout).toMatch(/有氧：这一周做稳态/);
    expect(run("profile", "check", d).status).toBe(0);
  });
  it("训练频率不到每周 2 天：不能直接进稳定期，导不出", () => {
    const r = run("export", stable("st-base", {}, entry({ base: 1 })), "1", "A");
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/有基础/);
  });
  it("计划单由命令生成：带声明，档案检查通过；手改过就报错", () => {
    const d = stable("st-plan");
    const r = run("plan", d);
    expect(r.stdout).toMatch(/已生成/);
    const f = join(d, "计划", "第1段-第1周.md");
    const text = readFileSync(f, "utf8");
    expect(text).toMatch(/未经专业审核，不是医学建议/);
    expect(text).toMatch(/稳定期 12 周的第 1 周：第 1 轮 · 第 1 周/);
    expect(run("profile", "check", d).status).toBe(0);
    writeFileSync(f, text.replace(/\d组×/, "9组×"));
    const bad = run("profile", "check", d);
    expect(bad.status).toBe(1);
    expect(bad.stdout).toMatch(/不手改/);
  });
  it("计划单只生成现在这一周的：写了周次不生成", () => {
    const r = run("plan", stable("st-future"), "3");
    expect(r.status).toBe(2);
    expect(r.stdout).toMatch(/只生成现在这一周/);
  });
  it("周期末评估：第 12 周之前提示还没练完", () => {
    const r = run("assess", stable("st-cycle"), "周期末");
    expect(r.stdout).toMatch(/现在是稳定期第 1 周，第 12 周的周复盘做完才算/);
  });
});

describe.skipIf(!hasTemplates || !t!.plans?.products[STABLE_BW])("稳定期：新手从起始期走到下一个周期", () => {
  let STARTER = "18-39岁-纯徒手版";
  let STABLE = STABLE_BW;
  let AGE = "a18";
  let BIRTH = "1996-05";
  let ENTRY: Record<string, unknown> = {};
  let tests: Record<string, unknown>[] = [{ id: "pushup-test", level: 2, value: 12 }, { id: "wallsit-test", value: 30 }];
  let endTests: Record<string, unknown>[] | null = null;
  const DECL = "> 本计划由养夏计划模板生成，未经专业审核，不是医学建议，不能替代医生的判断。";
  const back = (days: number) => { const d = new Date(Date.now() - days * 86_400_000); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
  /** plan：[第几段, 阶段, 第几周][]，最后一项从昨天开始，往前每周 7 天；每一周（除了最后一周）写复盘。 */
  function build(name: string, plan: [number, string, number][], ends: Record<number, [string, Record<string, unknown>]>, trainings = 4) {
    const segs = plan.map(([n, phase, week], i) => ({ n, ...(phase === "稳定" ? { phase } : {}), type: "标准", week, start: back(7 * (plan.length - 1 - i) + 1), product: phase === "稳定" ? STABLE : STARTER }));
    const d = dir(name, segs[segs.length - 1].product, { birth: BIRTH, body: "不记", startDate: segs[0].start, segments: segs, conditions: { 高血压: false },
      screening: undefined }, { [`评估/${segs[0].start}-入门.json`]: { schema: ASSESS_FORMAT, date: segs[0].start, kind: "入门", tests: endTests ? [] : tests, conclusion: {}, ...ENTRY } });
    const p = JSON.parse(readFileSync(join(d, "档案.json"), "utf8"));
    const items = t!.manifest.intake.screening.find((x) => x.age === AGE)!.items;
    p.screening = { answers: items.map((item) => ({ item, answer: "否" })), doctorCleared: false, date: segs[0].start };
    writeFileSync(join(d, "档案.json"), JSON.stringify(p));
    mkdirSync(join(d, "复盘"), { recursive: true });
    segs.slice(0, -1).forEach((s) => {
      const rw = s.phase === "稳定" ? ((s.week - 1) % 4) + 1 : s.week;
      writeFileSync(join(d, "复盘", `${s.start}-第${s.week}周.json`), JSON.stringify({ schema: REVIEW_FORMAT, start: s.start, week: s.week, trainings, checkinDays: 6, symptoms: false, moves: [],
        habits: { 散步: 5, 冥想: 5 }, ...(rw === 2 ? { steadyCheck: true } : {}) }));
      writeFileSync(join(d, "复盘", `${s.start}-第${s.week}周.md`), `# 第 ${s.week} 周复盘\n\n${DECL}\n\n训练 ${trainings} 次，没有不适。\n`);
    });
    for (const [n, [kind, conclusion]] of Object.entries(ends)) {
      const last = segs.filter((s) => s.n === Number(n)).pop()!;
      const date = new Date(new Date(`${last.start}T12:00:00`).getTime() + 6 * 86_400_000);
      const ds = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
      writeFileSync(join(d, "评估", `${ds}-${kind}.json`), JSON.stringify({ schema: ASSESS_FORMAT, date: ds, kind, segment: Number(n), tests: endTests ?? tests, conclusion }));
    }
    return d;
  }
  const wk = (n: number, phase: string, a: number, b: number): [number, string, number][] => Array.from({ length: b - a + 1 }, (_, i) => [n, phase, a + i]);
  it("起始期 4 周 → 段末到进阶线 → 稳定期 12 周 → 周期末达标 → 下一周期第 1 周：检查、导出、计划单都通过", () => {
    const d = build("nv-ok", [...wk(1, "起始", 1, 4), ...wk(2, "稳定", 1, 12), [3, "稳定", 1]],
      { 1: ["段末", { result: "添装备", next: "标准" }], 2: ["周期末", { result: "达标", next: { phase: "稳定" } }] });
    const chk = run("profile", "check", d);
    expect(chk.stdout).toMatch(/0 个错误/);
    expect(run("export", d, "1", "A").stdout).toMatch(/已导出/);
    expect(run("plan", d).stdout).toMatch(/已生成/);
    expect(run("assess", d, "周期末").stdout).toMatch(/12 周训练 48 次[\s\S]*结论：达标/);
    expect(run("profile", "check", d).status).toBe(0);
  });
  it("健身房：起始期 4 周 → 段末\"进入下一阶段\" → 稳定期第 1 周：检查、导出（3 组 × 10 次）、计划单（有氧 20 分钟）", () => {
    [STARTER, STABLE, AGE, BIRTH, ENTRY] = ["18-39岁-健身房版", "18-39岁-健身房版（稳定期）", "a18", "1996-05", {}];
    endTests = [{ id: "gym-weights", move: "gym-smith-squat", value: 40 }, { id: "gym-weights", move: "gym-chest-press", value: 30 }, { id: "gym-weights", move: "gym-lat-pulldown", value: 35 }];
    try {
      const d = build("gym-ok", [...wk(1, "起始", 1, 4), [2, "稳定", 1]], { 1: ["段末", { result: "进入下一阶段", next: "标准" }] });
      expect(run("profile", "check", d).stdout).toMatch(/0 个错误/);
      const e = run("export", d, "1", "A", "--out", join(root, "gym-a.json"));
      expect(e.stdout).toMatch(/有氧：这一周做稳态，每次 20 分钟/);
      const c = JSON.parse(readFileSync(join(root, "gym-a.json"), "utf8"));
      expect(c.blocks.flatMap((b: any) => b.items).find((i: any) => i.exercise === "gym-smith-squat")).toMatchObject({ sets: 3, reps: 10 });
      expect(run("plan", d).stdout).toMatch(/已生成/);
      expect(run("profile", "check", d).status).toBe(0);
    } finally {
      [STARTER, STABLE, AGE, BIRTH, ENTRY, endTests] = ["18-39岁-纯徒手版", STABLE_BW, "a18", "1996-05", {}, null];
    }
  });
  it("40–64 岁纯徒手：起始期 4 周 → 段末到进阶线 → 稳定期第 1 周：检查、导出、计划单（第 1 周写出升级窗口）", () => {
    [STARTER, STABLE, AGE, BIRTH, ENTRY] = ["40-64岁-纯徒手版", "40-64岁-纯徒手版（稳定期）", "a40", "1976-05", { prereqs: { checkup: true, bpOk: true }, conclusion: { needDoctor: false } }];
    try {
      const d = build("a40-ok", [...wk(1, "起始", 1, 4), [2, "稳定", 1]], { 1: ["段末", { result: "添装备", next: "标准" }] });
      const p = JSON.parse(readFileSync(join(d, "档案.json"), "utf8"));
      writeFileSync(join(d, "档案.json"), JSON.stringify({ ...p, stage: "40–64 岁" }));
      const chk = run("profile", "check", d);
      expect(chk.stdout).toMatch(/0 个错误/);
      expect(run("export", d, "1", "A").stdout).toMatch(/已导出/);
      expect(run("plan", d).stdout).toMatch(/已生成/);
    } finally {
      [STARTER, STABLE, AGE, BIRTH, ENTRY] = ["18-39岁-纯徒手版", STABLE_BW, "a18", "1996-05", {}];
    }
  });
  it("只练了 12–13 次（没到进阶线）就进稳定期：拦下", () => {
    const d = build("nv-low", [...wk(1, "起始", 1, 4), [2, "稳定", 1]], { 1: ["段末", { result: "原样", next: "标准" }] }, 3);
    const r = run("profile", "check", d);
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/到了进阶线/);
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

