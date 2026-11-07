// 个人档案、练习记录：TS 校验和 JSON Schema 对同样的样例判断一致；写给人的文字过红线。
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";
import { checkNotes, validateProfile, validateSession } from "../src/profile.ts";
import { CONTRACTS, FIX, clone, fixtureManifest, readJson } from "./helpers.ts";

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
const profileSchema = ajv.compile(readJson(`${CONTRACTS}profile.schema.json`) as object);
const sessionSchema = ajv.compile(readJson(`${CONTRACTS}session.schema.json`) as object);
const errors = (xs: { level: string }[]) => xs.filter((i) => i.level === "error");
const P = () => clone(readJson<Record<string, any>>(`${FIX}profiles/ok-a18-home.json`));
const S = () => clone(readJson<Record<string, any>>(`${FIX}sessions/ok-a18-home.json`));

describe("个人档案", () => {
  it("合格样例：Schema 和 TS 都通过", () => {
    expect(profileSchema(P())).toBe(true);
    expect(errors(validateProfile(P()))).toEqual([]);
  });
  const bad: [string, (p: Record<string, any>) => void][] = [
    ["缺少筛查", (p) => delete p.screening],
    ["代号里有空格", (p) => (p.code = "张 三")],
    ["起床时间格式不对", (p) => (p.wake = "6:20")],
    ["不认识的年龄段", (p) => (p.age = "a99")],
    ["答案不是是 / 否", (p) => (p.screening.answers[0].answer = "有")],
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
});

describe("写给人的文字过红线", () => {
  const rules = fixtureManifest().redlines;
  it("13–17 岁的周复盘不能谈体重", () => expect(errors(checkNotes(rules, ["a13"], "复盘", "这周体重降了")).length).toBe(1));
  it("白名单里的否定说法放行", () => expect(checkNotes(rules, ["a13"], "复盘", "不称体重、不量腰围、不拍身材照")).toEqual([]));
  it("全家菜单不能写热量赤字", () => expect(errors(checkNotes(rules, ["fam"], "菜单", "控制热量赤字")).length).toBeGreaterThan(0));
});
