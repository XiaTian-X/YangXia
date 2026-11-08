// 课程检查：防止自编处方。这些测试只用 contracts/fixtures/，模板仓库不在也会跑（安全测试不能跳过）。
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checkCourse } from "../src/check.ts";
import { failedRedlineCases, redlineHits } from "../src/redlines.ts";
import type { Course } from "../src/types.ts";
import { FIX, clone, courseFixtures, fixtureManifest, fixtureReadProduct, okCourse, readJson } from "./helpers.ts";

const manifest = fixtureManifest();
const run = (c: unknown, profile?: unknown) =>
  checkCourse(c, { manifest, readProduct: fixtureReadProduct, profile }).filter((i) => i.level === "error").map((i) => i.message);
const A = () => clone(okCourse("ok-a18-home-w1-a.json"));
const D = () => clone(okCourse("ok-a18-home-w1-d-circuit.json"));

describe("红线规则（模板 manifest 里的校验样例）", () => {
  it("样例全部判对", () => expect(failedRedlineCases(manifest.redlines)).toEqual([]));
  it("字幕不用白名单", () => {
    expect(redlineHits(manifest.redlines, "a65", "用力时呼气，不憋气", true)).toEqual([]);
    expect(redlineHits(manifest.redlines, "a65", "用力时呼气，不憋气", false)).toEqual(["憋气"]);
  });
});

describe("合格的课程通过（8 份训练成品各一份样例）", () => {
  for (const [name, c] of courseFixtures("ok-")) it(name, () => expect(run(c)).toEqual([]));
});

describe("自编处方被拦下", () => {
  const expectError = (c: Course, pattern: RegExp) => expect(run(c).join("\n")).toMatch(pattern);
  it("原文在成品里找不到", () => {
    const c = A();
    c.blocks[0].items[0].quote[1] = "3 组 × 25 次";
    expectError(c, /找不到：「3 组 × 25 次」/);
  });
  it("次数取了区间上限", () => {
    const c = A();
    c.blocks[0].items[0].reps = 20;
    expectError(c, /区间的上限，次数要取下限/);
  });
  it("编了一个原文里没有的次数", () => {
    const c = A();
    c.blocks[0].items[0].reps = 18;
    expectError(c, /18 次在原文里找不到出处/);
  });
  it("休息取了区间下限", () => {
    const c = A();
    c.blocks[0].items[2].rest = 45;
    expectError(c, /区间的下限，休息要取上限/);
  });
  it("拿第 1 周的原文做第 2 周的课程", () => {
    const c = A();
    c.source.week = 2;
    expectError(c, /原文写的是第 1 周，不是第 2 周/);
  });
  it("组数没有出处", () => {
    const c = A();
    c.blocks[0].items[0].sets = 4;
    expectError(c, /4 组在本周的原文里找不到出处/);
  });
  it("节奏秒数不在呼吸节奏原文里", () => {
    const c = A();
    c.blocks[0].items[0].tempo!.down = 4;
    expectError(c, /4 秒在「徒手深蹲」本周能用的呼吸节奏里找不到/);
  });
  it("计时动作取了区间上限", () => {
    const c = A();
    c.blocks[0].items[3].duration = 90;
    expectError(c, /90 秒是区间的上限|90 秒在原文里找不到/);
  });
  it("轮数和轮间休息要有出处", () => {
    const c = D();
    (c.blocks[0] as { rounds: number }).rounds = 4;
    (c.blocks[0] as { restBetweenRounds: number }).restBetweenRounds = 30;
    expectError(c, /4 轮在本周的原文里找不到出处/);
    expectError(c, /轮间休息 30 秒在原文里找不到出处/);
  });
  it("动作不在这份成品里", () => {
    const c = A();
    c.blocks[0].items[0].exercise = "gym-smith-squat";
    expectError(c, /动作索引里没有|不在成品/);
  });
  it("65 岁以上训练单：抄了第 2 周那一列", () => {
    const c = clone(okCourse("ok-a65-chair-w1.json"));
    c.blocks[0].items[0].sets = 2;
    c.blocks[0].items[0].quote[0] = "1. 坐站起（8–10 次） | 1 组，可以用手撑 | 2 组，可以用手撑";
    expectError(c, /取自表格里「第 2 周」那一列，不是第 1 周/);
  });
  it("休息写成\"歇\"也认得，但不能编", () => {
    const c = clone(okCourse("ok-a65-chair-w1.json"));
    c.blocks[0].items[0].rest = 90;
    expectError(c, /休息 90 秒在原文里找不到出处/);
  });
  // 独立审查发现的绕过写法：数字借自别的周、别的动作
  it("组数借动作库那句\"3 组 × …\"，没有本周的原文", () => {
    const c = A();
    c.blocks[0].items[0].sets = 3;
    c.blocks[0].items[0].quote = ["3 组 × 15–20 次", "大动作（深蹲、分腿蹲、俯卧撑、划船）休息 90 秒，小动作 45–60 秒"];
    expectError(c, /3 组在本周的原文里找不到出处/);
  });
  it("次数借别的动作的处方", () => {
    const c = A();
    c.blocks[0].items[0].reps = 8;
    c.blocks[0].items[0].quote[1] = "3 组 × 8–15 次";
    expectError(c, /8 次在原文里找不到出处（次数要摘「徒手深蹲」自己的处方/);
  });
  it("时长借单车间歇那句的秒数", () => {
    const c = A();
    c.blocks[0].items[3].duration = 90;
    c.blocks[0].items[3].quote.splice(2, 0, "(30 秒冲 + 90 秒慢) × 6");
    expectError(c, /90 秒是区间的上限|90 秒在原文里找不到出处/);
  });
  it("第 1 周用第 3 周才放慢的下放 3 秒", () => {
    const a13 = clone(okCourse("ok-a13-bw-w1-a.json"));
    a13.blocks[0].items[0].tempo!.down = 3;
    expectError(a13, /3 秒在「徒手深蹲」本周能用的呼吸节奏里找不到/);
    const home = A();
    home.blocks[0].items[0].tempo!.down = 3;   // 居家版写的是"下放 3 秒那一级"：难度阶梯，不按周给
    expectError(home, /3 秒在「徒手深蹲」本周能用的呼吸节奏里找不到/);
  });
  it("第 3 周的课程：组数、放慢的下放都出自本周原文（样例 ok-*-w3-a 通过）", () => {
    expect(run(okCourse("ok-a18-home-w3-a.json"))).toEqual([]);
    expect(run(okCourse("ok-a13-bw-w3-a.json"))).toEqual([]);
  });
  it("每侧和动作索引不符", () => {
    const c = A();
    c.blocks[0].items[1].perSide = false;
    expectError(c, /要分左右侧/);
  });
});

describe("档案", () => {
  // 档案样例放在 contracts/fixtures/profiles/（提交前检查只允许那里出现档案格式）。
  // 其他年龄段的档案按模板 manifest 现拼：阶段、成品、筛查项都取自模板，保证除了要测的那一点之外都合格。
  const STAGE: Record<string, string> = { a13: "初中", a18: "18–39 岁", a40: "40–64 岁", a65: "65 岁以上" };
  const profile = (answer: "是" | "否", doctorCleared: boolean, age = "a18", product = "18-39岁-居家版") => {
    const p = readJson<Record<string, any>>(`${FIX}profiles/ok-a18-home.json`);
    const prod = manifest.products.find((x) => x.name === product)!;
    Object.assign(p, { age, stage: STAGE[age], product, venue: prod.venue });
    p.segments[0].product = product;
    delete p.wake;
    delete p.bedtime;
    p.screening.answers = manifest.intake.screening.find((s) => s.age === age)!.items.map((item) => ({ item, answer: "否" }));
    p.screening.answers[0].answer = answer;
    p.screening.doctorCleared = doctorCleared;
    return p;
  };
  it("筛查全是\"否\"：通过", () => expect(run(A(), profile("否", false))).toEqual([]));
  it("有\"是\"、医生没同意：拒绝", () => expect(run(A(), profile("是", false)).join()).toMatch(/先问医生/));
  it("有\"是\"、医生同意了：通过", () => expect(run(A(), profile("是", true))).toEqual([]));
  it("65 岁以上医生没同意：拒绝；同意了：通过", () => {
    const c = okCourse("ok-a65-chair-w1.json");
    expect(run(c, profile("否", false, "a65", c.source.product)).join()).toMatch(/65 岁以上开始前都要先问医生/);
    expect(run(c, profile("否", true, "a65", c.source.product))).toEqual([]);
  });
  it("没做筛查：拒绝", () => {
    const p = profile("否", false);
    delete p.screening;
    expect(run(A(), p).join()).toMatch(/没做筛查不能出课程/);
  });
  it("筛查只答了一部分：拒绝", () => {
    const p = profile("否", false);
    p.screening.answers = p.screening.answers.slice(0, 2);
    expect(run(A(), p).join()).toMatch(/少答了 6 项/);
  });
  it("筛查一项没答（空数组）：拒绝", () => {
    const p = profile("否", false);
    p.screening.answers = [];
    expect(run(A(), p).join()).toMatch(/少答了 8 项/);
  });
  it("课程不是档案选的成品：拒绝", () => {
    const p = profile("否", false, "a18", "18-39岁-纯徒手版");
    expect(run(A(), p).join()).toMatch(/只能导出档案选的成品/);
  });
  it("课程周次超过档案周次：拒绝（要等周复盘放行）", () => {
    const c = A();
    c.source.week = 2;
    expect(run(c, profile("否", false)).join()).toMatch(/档案现在是第 1 周，课程是第 2 周/);
  });
});

describe("真实模板（模板仓库在才跑；不在时上面的样例测试仍然覆盖安全规则）", async () => {
  const { templatesDir, loadTemplates } = await import("../src/node.ts");
  const dir = await templatesDir();
  const live = dir && existsSync(`${dir}/dist/manifest.json`);
  it.skipIf(!live)("样例课程对真实模板也通过；真实红线样例全部判对", async () => {
    const t = await loadTemplates();
    expect(failedRedlineCases(t.manifest.redlines)).toEqual([]);
    for (const [, c] of courseFixtures("ok-")) {
      const errs = checkCourse(c, { manifest: t.manifest, readProduct: t.readProduct }).filter((i) => i.level === "error");
      expect(errs).toEqual([]);
    }
  });

  // 复核时审查员找到的绕法和误伤：只有完整的成品里才有这些原文，所以放在真实模板这一组
  const RB = "大动作（深蹲、分腿蹲、俯卧撑、划船）休息 90 秒，小动作 45–60 秒";
  const course = (product: string, age: string, week: number, item: Record<string, unknown>) => ({
    schema: "yangxia.course/1", id: "c_livecase01", name: "核对", age, source: { product, week }, blocks: [{ kind: "sets", items: [item] }] });
  const squat = (o: Record<string, unknown>) => ({ exercise: "squat", name: "徒手深蹲", mode: "reps", sets: 2, reps: 15,
    tempo: { start: "down", down: 2, up: 1 }, rest: 90, ...o });
  const liveErrors = async (c: unknown, profile?: unknown) => {
    const t = await loadTemplates();
    return checkCourse(c, { manifest: t.manifest, readProduct: t.readProduct, profile }).filter((i) => i.level === "error").map((i) => i.message).join("\n");
  };
  it.skipIf(!live)("组数借别的动作那一行（划船\"4 组（第 1 周 3 组）\"）：拦下", async () => {
    for (const q of ["C 日的桌下（或门框）划船始终做 4 组（第 1 周 3 组）", "4 组（第 1 周 3 组）"]) {
      const c = course("18-39岁-居家版", "a18", 1, squat({ sets: q.startsWith("C") ? 4 : 3, quote: [q, "3 组 × 15–20 次", RB] }));
      expect(await liveErrors(c)).toMatch(/组在本周的原文里找不到出处/);
    }
  });
  it.skipIf(!live)("表头的多周句不算本周出处", async () => {
    const c = course("18-39岁-居家版", "a18", 1, squat({ sets: 3, quote: ["第 1 周（2 组，边学边练） | 第 2 周（3 组）", "3 组 × 15–20 次", RB] }));
    expect(await liveErrors(c)).toMatch(/3 组在本周的原文里找不到出处/);
  });
  it.skipIf(!live)("本周原文的\"下放放慢到 3 秒\"只给下放用", async () => {
    const c = course("18-39岁-居家版", "a18", 3, squat({ sets: 3, tempo: { start: "down", down: 3, up: 1, top: 3 }, quote: ["第 3 周 | 3 组 | 下放放慢到 3 秒", "3 组 × 15–20 次", RB] }));
    const e = await liveErrors(c);
    expect(e.match(/本周能用的呼吸节奏里找不到/g)?.length).toBe(1);   // 只有 top 3 被拦，down 3 有本周原文
  });
  it.skipIf(!live)("写明第 3 周开始做、下一轮才用的动作不能提前导出", async () => {
    const walk = course("65岁以上-椅子辅助版", "a65", 1, { exercise: "a65-09-heel-toe-walk", name: "脚跟脚尖走", mode: "reps", sets: 1, reps: 2,
      tempo: { start: "up", up: 1, down: 1 }, rest: 30, quote: ["1 组", "平衡动作之间歇 30 秒"] });
    expect(await liveErrors(walk)).toMatch(/第 3 周开始做，现在是第 1 周/);
    const bss = course("18-39岁-居家版", "a18", 4, { exercise: "bss", name: "保加利亚分腿蹲", mode: "reps", perSide: true, sets: 3, reps: 10,
      tempo: { start: "down", down: 2, up: 1 }, rest: 90, quote: ["第 4 周 | 3 组 | 下放 3 秒", "每侧 3 组 × 10–12 次", RB] });
    expect(await liveErrors(bss)).toMatch(/下一轮才用，现在是第 1 轮/);
  });
  it.skipIf(!live)("65 岁以上训练单：本周格子和别的周内容一样、\"同第 3 周\"、行首写着本周的递进表，都能导出", async () => {
    const heel = course("65岁以上-椅子辅助版", "a65", 4, { exercise: "a65-02-heel-raise", name: "扶椅踮脚", mode: "reps", sets: 2, reps: 10,
      tempo: { start: "up", up: 1, top: 1, down: 3 }, rest: 60, quote: ["2. 扶椅踮脚（10–12 次）", "2 组，放下数 3 秒 | 同第 3 周", "力量动作每组之间坐下歇 60 秒"] });
    expect(await liveErrors(heel)).toBe("");
    const wall = course("65岁以上-椅子辅助版", "a65", 3, { exercise: "a65-04-wall-pushup", name: "扶墙俯卧撑", mode: "reps", sets: 2, reps: 8,
      tempo: { start: "down", down: 2, up: 1 }, rest: 60, quote: ["4. 扶墙俯卧撑（8–10 次）", "2 组", "力量动作每组之间坐下歇 60 秒"] });
    expect(await liveErrors(wall)).toBe("");
    const a40 = course("40-64岁-居家版", "a40", 4, squat({ sets: 3, tempo: { start: "down", down: 3, up: 1 },
      quote: ["第 4 周 | 3 组 | 下放 3 秒，不换进阶变式，把第 3 周做扎实", "3 组 × 15–20 次", RB] }));
    expect(await liveErrors(a40)).toBe("");
  });
});
