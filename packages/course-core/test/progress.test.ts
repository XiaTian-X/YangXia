// 周次推进：不复盘不能进下一段；有不适的那一段之后不能加量；weeks 本身的结构。
import { describe, expect, it } from "vitest";
import { checkProgress, reviewName, validateWeeks } from "../src/progress.ts";
import { FIX, clone, readJson } from "./helpers.ts";

const P = () => clone(readJson<Record<string, any>>(`${FIX}profiles/ok-a18-home.json`));
const S = () => clone(readJson<Record<string, any>>(`${FIX}sessions/ok-a18-home.json`));
const NOW = new Date("2026-12-01T12:00:00");   // 测试里的"今天"：样例日期都在它之前
const msgs = (xs: { level: string; message: string }[], level = "error") => xs.filter((i) => i.level === level).map((i) => i.message).join("\n");
const at = (date: string, sick = false) => {
  const s = S();
  s.startedAt = new Date(`${date}T19:00:00`).toISOString();
  if (sick) s.symptoms.pain = true;
  return { name: `打卡/${date}.json`, raw: s };
};
const twoWeeks = (second: number) => {
  const p = P();
  p.weeks = [{ week: 1, start: "2026-11-09" }, { week: second, start: "2026-11-16" }];
  p.week = second;
  return p;
};

describe("weeks 的结构", () => {
  it("样例档案合格", () => expect(validateWeeks(P(), NOW)).toEqual([]));
  const bad: [string, (p: Record<string, any>) => void, RegExp][] = [
    ["缺少 weeks", (p) => delete p.weeks, /缺少 weeks/],
    ["第一段不是第 1 周", (p) => (p.weeks[0].week = 2), /从第 1 周开始/],
    ["第一段和 startDate 不一致", (p) => (p.weeks[0].start = "2026-11-10"), /startDate/],
    ["日期没有递增", (p) => p.weeks.push({ week: 1, start: "2026-11-09" }), /至少练 7 天/],
    ["一段不到 7 天（一天推进一周）", (p) => { p.weeks.push({ week: 2, start: "2026-11-11" }); p.week = 2; }, /至少练 7 天/],
    ["预先写好以后的推进", (p) => { p.weeks.push({ week: 2, start: "2027-01-04" }); p.week = 2; }, /还没到/],
    ["跳周", (p) => { p.weeks.push({ week: 3, start: "2026-11-16" }); p.week = 3; }, /不能直接跳到第 3 周/],
    ["week 和最后一段不一致", (p) => (p.week = 2), /两处要一致/],
  ];
  for (const [name, f, re] of bad) {
    it(`拦下：${name}`, () => {
      const p = P();
      f(p);
      expect(msgs(validateWeeks(p, NOW))).toMatch(re);
    });
  }
});

describe("按日期核对复盘和不适", () => {
  it("复盘文件名：开始日期-第N周", () => expect(reviewName({ week: 2, start: "2026-11-16" })).toBe("2026-11-16-第2周.md"));
  it("正常推进：上一段有复盘、没有不适", () => {
    expect(checkProgress(twoWeeks(2), [at("2026-11-10"), at("2026-11-17")], ["2026-11-09-第1周.md"], NOW)).toEqual([]);
  });
  it("上一段没有复盘：拒绝", () => {
    expect(msgs(checkProgress(twoWeeks(2), [at("2026-11-10")], [], NOW))).toMatch(/这一段没有周复盘/);
  });
  it("上一段有不适还加到下一周：拒绝", () => {
    expect(msgs(checkProgress(twoWeeks(2), [at("2026-11-10", true)], ["2026-11-09-第1周.md"], NOW))).toMatch(/下一段不能加到第 2 周/);
  });
  it("上一段有不适、重复本周：通过", () => {
    expect(checkProgress(twoWeeks(1), [at("2026-11-10", true)], ["2026-11-09-第1周.md"], NOW)).toEqual([]);
  });
  it("这一段（还没结束）的不适不影响已经走过的推进", () => {
    expect(checkProgress(twoWeeks(2), [at("2026-11-10"), at("2026-11-18", true)], ["2026-11-09-第1周.md"], NOW)).toEqual([]);
  });
  it("不适记录挪进 历史/ 也照样算", () => {
    const s = { ...at("2026-11-10", true), archived: true };
    expect(msgs(checkProgress(twoWeeks(2), [s], ["2026-11-09-第1周.md"], NOW))).toMatch(/下一段不能加到第 2 周/);
  });
  it("练了比当时更高一周的课程：提醒", () => {
    const s = at("2026-11-10");
    s.raw.course.source.week = 3;
    expect(msgs(checkProgress(P(), [s], [], NOW), "warning")).toMatch(/第 3 周的课程，当时还在第 1 周/);
  });
  it("早于这一轮开始的记录：提醒放进 历史/", () => {
    expect(msgs(checkProgress(P(), [at("2026-11-01")], [], NOW), "warning")).toMatch(/历史/);
  });
});
