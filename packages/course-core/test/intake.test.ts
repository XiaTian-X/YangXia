// 档案和模板对得上：阶段 ↔ 年龄段、成品、筛查逐项原话、上床时间公式。
import { describe, expect, it } from "vitest";
import { bedtimeFor, checkProfileWithTemplates, notCoveredItems, screeningFor } from "../src/intake.ts";
import { FIX, clone, fixtureManifest, readJson } from "./helpers.ts";

const m = fixtureManifest();
const P = () => clone(readJson<Record<string, any>>(`${FIX}profiles/ok-a18-home.json`));
const errs = (p: unknown) => checkProfileWithTemplates(p, m).filter((i) => i.level === "error");

describe("上床时间", () => {
  it("起床时间 − 目标睡眠 − 入睡缓冲", () => {
    expect(bedtimeFor(m, "18–39 岁", "06:20")).toBe("22:00");
    expect(bedtimeFor(m, "初中", "06:30")).toBe("21:10");
    expect(bedtimeFor(m, "65 岁以上", "05:30")).toBe("22:10");
  });
  it("跨午夜", () => expect(bedtimeFor(m, "高中", "07:00")).toBe("22:40"));
  it("不覆盖的阶段、格式不对：null", () => {
    expect(bedtimeFor(m, "学龄前", "07:00")).toBeNull();
    expect(bedtimeFor(m, "18–39 岁", "6点")).toBeNull();
  });
});

describe("不覆盖的人群", () => {
  it("a18、a40 的\"怀孕，或产后 6 个月内\"属于不覆盖", () => {
    for (const age of ["a18", "a40"]) expect(notCoveredItems(m, age).map((x) => x.item)).toEqual(["怀孕，或产后 6 个月内"]);
    expect(notCoveredItems(m, "a65")).toEqual([]);
  });
});

describe("档案和模板核对", () => {
  it("合格样例没有错误", () => expect(errs(P())).toEqual([]));

  const bad: [string, (p: Record<string, any>) => void, RegExp][] = [
    ["筛查一项没答", (p) => (p.screening.answers = []), /少答了 8 项/],
    ["筛查少答一项", (p) => p.screening.answers.pop(), /少答了 1 项/],
    ["筛查改了原话", (p) => (p.screening.answers[0].item += "？"), /不是 a18 筛查项的原话/],
    ["筛查重复", (p) => p.screening.answers.push(clone(p.screening.answers[0])), /重复/],
    ["阶段和年龄段不一致", (p) => (p.stage = "40–64 岁"), /对应的年龄段是 a40/],
    ["学龄前不建档", (p) => (p.stage = "学龄前"), /不覆盖/],
    ["成品不存在", (p) => (p.product = "18-39岁-游泳版"), /没有成品/],
    ["成品年龄段不对", (p) => (p.product = "40-64岁-居家版"), /年龄段是 a40/],
    ["场地和成品不一致", (p) => (p.venue = "gym"), /场地是 home/],
    ["上床时间心算错了", (p) => (p.bedtime = "22:30"), /按公式上床时间是 22:00/],
  ];
  for (const [name, f, msg] of bad) {
    it(`拦下：${name}`, () => {
      const p = P();
      f(p);
      expect(errs(p).map((i) => i.message).join("\n")).toMatch(msg);
    });
  }

  it("孕期、产后 6 个月内答\"是\"：医生同意了也不出计划（模板不覆盖）", () => {
    const p = P();
    const i = p.screening.answers.findIndex((a: any) => a.item.includes("产后 6 个月内"));
    expect(i).toBeGreaterThanOrEqual(0);
    p.screening.answers[i].answer = "是";
    p.screening.doctorCleared = true;
    expect(errs(p).map((x) => x.message).join()).toMatch(/不出计划（医生同意也一样）/);
  });
  it("其他项答\"是\"、医生同意：不算不覆盖", () => {
    const p = P();
    p.screening.answers[3].answer = "是";
    p.screening.doctorCleared = true;
    expect(errs(p)).toEqual([]);
  });
  it("每个年龄段都有筛查项", () => {
    for (const age of ["a13", "a18", "a40", "a65"]) expect(screeningFor(m, age)?.items.length).toBeGreaterThan(0);
  });
});
