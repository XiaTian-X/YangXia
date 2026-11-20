// 个人档案、练习记录：TS 校验和 JSON Schema 对同样的样例判断一致；写给人的文字过红线。
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";
import { checkNotes, validateProfile, validateSession } from "../src/profile.ts";
import { REVIEW_FORMAT, validateReview } from "../src/progress.ts";
import { CONTRACTS, FIX, clone, fixtureManifest, readJson } from "./helpers.ts";

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
const profileSchema = ajv.compile(readJson(`${CONTRACTS}profile.schema.json`) as object);
const sessionSchema = ajv.compile(readJson(`${CONTRACTS}session.schema.json`) as object);
const errors = (xs: { level: string; path: string; message: string }[]) => xs.filter((i) => i.level === "error");
const P = () => clone(readJson<Record<string, any>>(`${FIX}profiles/ok-a18-home.json`));
const S = () => clone(readJson<Record<string, any>>(`${FIX}sessions/ok-a18-home.json`));

describe("个人档案", () => {
  it("合格样例：Schema 和 TS 都通过", () => {
    expect(profileSchema(P())).toBe(true);
    expect(errors(validateProfile(P()))).toEqual([]);
  });
  it("播放偏好写\"安静\"：65 岁以上、有高血压或没确认的成人提醒；确认没有高血压的成人、13–17 岁、全程 + 安静不提醒", () => {
    const warned = (patch: Record<string, any>) =>
      validateProfile(Object.assign(P(), patch)).some((i) => i.path === "playback.breathAfter" && i.level === "warning");
    const quiet = { breathAfter: "quiet" };
    expect(warned({ playback: quiet, conditions: {} })).toBe(true);
    expect(warned({ playback: quiet, age: "a40", conditions: { 高血压: true } })).toBe(true);
    expect(warned({ playback: quiet, age: "a65" })).toBe(true);
    expect(warned({ playback: quiet, conditions: { 高血压: false } })).toBe(false);
    expect(warned({ playback: quiet, age: "a13", conditions: {} })).toBe(false);
    expect(warned({ playback: { breathLead: "all", breathAfter: "quiet" }, conditions: {} })).toBe(false);
  });
  it("播放偏好（v4 阶段 8）：只记选择，合格的 Schema 和 TS 都通过", () => {
    const p = Object.assign(P(), { playback: { breathLead: "all", breathAfter: "quiet", countTiming: "on-rep" } });
    expect(profileSchema(p)).toBe(true);
    expect(errors(validateProfile(p))).toEqual([]);
  });
  const bad: [string, (p: Record<string, any>) => void][] = [
    ["缺少筛查", (p) => delete p.screening],
    ["代号里有空格", (p) => (p.code = "张 三")],
    ["起床时间格式不对", (p) => (p.wake = "6:20")],
    ["不认识的年龄段", (p) => (p.age = "a99")],
    ["答案不是是 / 否", (p) => (p.screening.answers[0].answer = "有")],
    ["起始期的段写到第 5 周", (p) => (p.segments[p.segments.length - 1].week = 5)],
    ["播放偏好的取值不对", (p) => (p.playback = { breathAfter: "loud" })],
    ["播放偏好写了不认识的项", (p) => (p.playback = { bpm: 60 })],
    ["稳定期的段写减量", (p) => Object.assign(p.segments[p.segments.length - 1], { phase: "稳定", type: "减量" })],
  ];
  for (const [name, f] of bad) {
    it(`不合格：${name}`, () => {
      const p = P();
      f(p);
      expect(profileSchema(p)).toBe(false);
      expect(errors(validateProfile(p)).length).toBeGreaterThan(0);
    });
  }
  it("65 岁以上没问医生：提醒不能出课程", () => {
    const p = P();
    p.age = "a65";
    p.stage = "65 岁以上";
    expect(validateProfile(p).map((i) => i.message).join()).toMatch(/65 岁以上开始前都要先问医生/);
  });
});

describe("练习记录", () => {
  it("合格样例：Schema 和 TS 都通过", () => {
    expect(sessionSchema(S())).toBe(true);
    expect(validateSession(S())).toEqual([]);
  });
  it("不合格：感受写错", () => {
    const s = S();
    s.feeling = "很好";
    expect(sessionSchema(s)).toBe(false);
    expect(errors(validateSession(s)).length).toBeGreaterThan(0);
  });
  it("有不适：提醒不加量、必要时就医", () => {
    const s = S();
    s.symptoms.chest = true;
    expect(validateSession(s).map((i) => i.message).join()).toMatch(/不加量.*就医/);
  });
  it("每个动作的感受、还能做几下、当场退回：合格", () => {
    const s = S();
    Object.assign(s.items[0], { feel: "做到上限还很轻松", spare: 6, reverted: true });
    expect(sessionSchema(s)).toBe(true);
    expect(validateSession(s)).toEqual([]);
  });
  it("不合格：感受不是成品原话", () => {
    const s = S();
    s.items[0].feel = "太轻松了";
    expect(sessionSchema(s)).toBe(false);
    expect(errors(validateSession(s)).map((i) => i.message).join()).toMatch(/感受只能是/);
  });
});

describe("档案的条件、器材、进度（格式）", () => {
  it("合格：条件只记是否、器材是 ID 列表、进度和日志", () => {
    const p = P();
    Object.assign(p, { conditions: { 高血压: true }, choices: ["door-row"], progress: { pushup: { level: 2 } },
      progressLog: [{ date: "2026-11-09", move: "pushup", field: "level", to: 2, rule: "建档" }] });
    expect(profileSchema(p)).toBe(true);
    expect(validateProfile(p)).toEqual([]);
  });
  it("不合格：条件写了病名细节、进度写了别的字段、日志规则不认识", () => {
    const p = P();
    Object.assign(p, { conditions: { 高血压: "二级，吃药" }, progress: { pushup: { level: 2, note: "x" } },
      progressLog: [{ date: "2026-11-09", move: "pushup", field: "level", to: 2, rule: "自己定" }] });
    expect(profileSchema(p)).toBe(false);
    expect(errors(validateProfile(p)).map((i) => `${i.path} ${i.message}`).join("\n")).toMatch(/只能有 level[\s\S]*rule[\s\S]*conditions/);
  });
});

describe("复盘数据：Schema 和 TS 一致", () => {
  const reviewSchema = ajv.compile(readJson(`${CONTRACTS}review.schema.json`) as object);
  const R = () => ({ schema: REVIEW_FORMAT, start: "2026-11-09", week: 1, trainings: 3, checkinDays: 5, symptoms: false,
    moves: [{ move: "pushup", allAtTop: false, spare: 2 }] });
  it("合格", () => {
    expect(reviewSchema(R())).toBe(true);
    expect(validateReview(R())).toEqual([]);
  });
  it("不合格：缺不适、余力不是整数", () => {
    const r: Record<string, any> = R();
    delete r.symptoms;
    r.moves[0].spare = 1.5;
    expect(reviewSchema(r)).toBe(false);
    expect(errors(validateReview(r)).length).toBe(2);
  });
});

describe("写给人的文字过红线", () => {
  const rules = fixtureManifest().redlines;
  it("13–17 岁的周复盘不能谈体重", () => expect(errors(checkNotes(rules, ["a13"], "复盘", "这周体重降了")).length).toBe(1));
  it("白名单里的否定说法放行", () => expect(checkNotes(rules, ["a13"], "复盘", "不称体重、不量腰围、不拍身材照")).toEqual([]));
  it("全家菜单不能写热量赤字", () => expect(errors(checkNotes(rules, ["fam"], "菜单", "控制热量赤字")).length).toBeGreaterThan(0));
});

describe("生成的计划要带声明（目前没有专业人员审核）", async () => {
  const { checkDeclaration, DECLARATION } = await import("../src/profile.ts");
  it("有声明：通过", () => expect(checkDeclaration("菜单/第1周.md", `# 菜单\n\n${DECLARATION}\n`)).toEqual([]));
  it("只写了不是医学建议、没写未经专业审核：拦下", () => {
    expect(checkDeclaration("复盘/x.md", "# 复盘\n\n> 不是医学建议。\n").map((i) => i.message).join()).toMatch(/未经专业审核/);
  });
});
