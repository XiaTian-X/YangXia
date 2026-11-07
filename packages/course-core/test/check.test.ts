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
    expectError(c, /4 组在原文里找不到出处/);
  });
  it("节奏秒数不在呼吸节奏原文里", () => {
    const c = A();
    c.blocks[0].items[0].tempo!.down = 4;
    expectError(c, /4 秒在「徒手深蹲」的呼吸节奏原文里找不到/);
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
    expectError(c, /4 轮在原文里找不到出处/);
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
  it("每侧和动作索引不符", () => {
    const c = A();
    c.blocks[0].items[1].perSide = false;
    expectError(c, /要分左右侧/);
  });
});

describe("安全筛查", () => {
  // 档案样例放在 contracts/fixtures/profiles/（提交前检查只允许那里出现档案格式）
  const profile = (answer: "是" | "否", doctorCleared: boolean, age = "a18") => {
    const p = readJson<Record<string, any>>(`${FIX}profiles/ok-a18-home.json`);
    p.age = age;
    p.screening.answers[0].answer = answer;
    p.screening.doctorCleared = doctorCleared;
    return p;
  };
  it("筛查全是\"否\"：通过", () => expect(run(A(), profile("否", false))).toEqual([]));
  it("有\"是\"、医生没同意：拒绝", () => expect(run(A(), profile("是", false)).join()).toMatch(/先问医生/));
  it("有\"是\"、医生同意了：通过", () => expect(run(A(), profile("是", true))).toEqual([]));
  it("65 岁以上医生没同意：拒绝", () => {
    const c = A();
    c.age = "a65";
    expect(run(c, profile("否", false, "a65")).join()).toMatch(/65 岁以上开始前都要先问医生/);
  });
  it("没做筛查：拒绝", () => {
    const p = profile("否", false);
    delete p.screening;
    expect(run(A(), p).join()).toMatch(/没做筛查不能出课程/);
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
});
