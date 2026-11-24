import { describe, expect, it } from "vitest";
import {
  addDays,
  checkProgress,
  checkProgressLog,
  courseIdFor,
  dateInZone,
  dayNumber,
  daysBetween,
  hhmmInZone,
  isValidTimeZone,
  prepareSessionImport,
  PROFILE_FORMAT,
  resolveTimeZone,
  REVIEW_FORMAT,
  SESSION_FORMAT,
  trainingDates,
  validateProfile,
  validateSegments,
} from "../src/index.ts";
import { fixturePlans, fixtureRules } from "./helpers.ts";

describe("date.ts 纯日历日与 IANA 时区格式化", () => {
  it("dayNumber / daysBetween / addDays 跨闰年和常见夏令时切换日保持精确整数天", () => {
    expect(daysBetween("2024-03-01", "2024-02-28")).toBe(2);
    expect(daysBetween("2026-03-01", "2026-02-28")).toBe(1);
    expect(addDays("2026-03-08", 1)).toBe("2026-03-09"); // 美国春令时
    expect(addDays("2026-11-01", 1)).toBe("2026-11-02"); // 美国秋令时
    expect(daysBetween("2026-11-02", "2026-03-08")).toBe(239);
    expect(dayNumber("1970-01-01")).toBe(0);
    expect(addDays("2026-01-01", -1)).toBe("2025-12-31");
  });

  it("isValidTimeZone 与 validateProfile 拦住非法时区、放行合法 IANA 时区", () => {
    expect(isValidTimeZone("Asia/Shanghai")).toBe(true);
    expect(isValidTimeZone("UTC")).toBe(true);
    expect(isValidTimeZone("America/Los_Angeles")).toBe(true);
    expect(isValidTimeZone("Mars/Olympus")).toBe(false);
    expect(isValidTimeZone("")).toBe(false);
    expect(isValidTimeZone(null)).toBe(false);

    const base = {
      schema: PROFILE_FORMAT,
      code: "tz-test",
      stage: "18–39 岁",
      age: "a18",
      venue: "bw",
      product: "18-39岁-纯徒手版",
      birth: "1995-05",
      startDate: "2026-11-02",
      segments: [{ n: 1, type: "标准", week: 1, start: "2026-11-02", product: "18-39岁-纯徒手版" }],
      screening: { answers: [{ item: "心脏病", answer: "否" }], doctorCleared: true, date: "2026-11-02", doctorDate: "2026-11-02" },
    };
    expect(validateProfile({ ...base, timezone: "Asia/Shanghai" }).filter((i) => i.level === "error")).toEqual([]);
    const bad = validateProfile({ ...base, timezone: "Not/A_Zone" });
    expect(bad.some((i) => i.path === "timezone" && i.level === "error")).toBe(true);
    expect(resolveTimeZone("Not/A_Zone", { timezone: "Asia/Shanghai" })).toBe("Asia/Shanghai");
    expect(resolveTimeZone("UTC", { timezone: "Asia/Shanghai" })).toBe("UTC");
  });

  it("dateInZone / hhmmInZone 在午夜 00:xx 永不产出 24xx，且按指定时区跨日", () => {
    // 2026-11-24T16:30:00Z = UTC 2026-11-24 16:30 = 北京时间 2026-11-25 00:30
    const midnightBj = new Date("2026-11-24T16:30:00.000Z");
    expect(dateInZone(midnightBj, "UTC")).toBe("2026-11-24");
    expect(hhmmInZone(midnightBj, "UTC")).toBe("1630");
    expect(dateInZone(midnightBj, "Asia/Shanghai")).toBe("2026-11-25");
    expect(hhmmInZone(midnightBj, "Asia/Shanghai")).toBe("0030");

    // 2026-11-24T16:00:00Z = 北京时间 2026-11-25 00:00（关键边界：不能是 2400）
    const exactMidnightBj = new Date("2026-11-24T16:00:00.000Z");
    expect(dateInZone(exactMidnightBj, "Asia/Shanghai")).toBe("2026-11-25");
    expect(hhmmInZone(exactMidnightBj, "Asia/Shanghai")).toBe("0000");
  });
});

describe("跨时区业务规则：模拟 UTC 服务器服务北京时间（Asia/Shanghai）使用者", () => {
  const plans = fixturePlans();
  const rules = fixtureRules();

  it("validateSegments 与 validateProfile 透传 now/timeZone：北京时间 11-09 00:30 允许 11-10 开始第 2 周", () => {
    const profile = {
      schema: PROFILE_FORMAT,
      code: "bj-user",
      stage: "18–39 岁",
      age: "a18",
      venue: "bw",
      product: "18-39岁-纯徒手版",
      birth: "1995-05",
      timezone: "Asia/Shanghai",
      startDate: "2026-11-02",
      segments: [
        { n: 1, type: "标准", week: 1, start: "2026-11-02", product: "18-39岁-纯徒手版" },
        { n: 1, type: "标准", week: 2, start: "2026-11-10", product: "18-39岁-纯徒手版" },
      ],
      screening: { answers: [{ item: "心脏病", answer: "否" }], doctorCleared: true, date: "2026-11-02", doctorDate: "2026-11-02" },
    };
    // UTC 2026-11-08 16:30 = 北京时间 2026-11-09 00:30（明天是 11-10）
    const now = new Date("2026-11-08T16:30:00.000Z");
    expect(validateSegments(profile, now, "Asia/Shanghai")).toEqual([]);
    expect(validateProfile(profile, { now }).filter((i) => i.level === "error")).toEqual([]);
    // 若错误按 UTC 算，今天仍是 11-08，11-10 会被拦下
    expect(validateSegments(profile, now, "UTC").some((i) => i.level === "error")).toBe(true);
  });

  it("北京时间凌晨 00:30 的练习记录归入当天周次，不被 UTC 归错到前一天或早于段开始", () => {
    const profile = {
      schema: PROFILE_FORMAT,
      code: "bj-night",
      stage: "18–39 岁",
      age: "a18",
      venue: "bw",
      product: "18-39岁-纯徒手版",
      timezone: "Asia/Shanghai",
      startDate: "2026-11-02",
      segments: [
        { n: 1, type: "标准", week: 1, start: "2026-11-02", product: "18-39岁-纯徒手版" },
        { n: 1, type: "标准", week: 2, start: "2026-11-09", product: "18-39岁-纯徒手版" },
      ],
      screening: { answers: [{ item: "心脏病", answer: "否" }], doctorCleared: true, date: "2026-11-02" },
    };
    // 北京时间 2026-11-02 00:30（UTC 是 2026-11-01 16:30）
    const s1 = {
      schema: SESSION_FORMAT,
      course: {
        id: "c_985e5a16a9f0",
        name: "第 1 周 A 日",
        source: { plan: "yangxia.plans/1", product: "18-39岁-纯徒手版", templates: "v1.0.0", segment: 1, type: "标准", week: 1, day: "A" },
      },
      startedAt: "2026-11-01T16:30:00.000Z",
      endedAt: "2026-11-01T16:50:00.000Z",
      items: [{ exercise: "bw-pushup-l1", setsPlanned: 2, setsDone: 2, feel: "做到上限还很轻松" }],
      feeling: "轻松",
      symptoms: { pain: false, dizzy: false, chest: false },
    };
    const datesBj = trainingDates(profile.segments, [{ name: "打卡/s1.json", raw: s1 }], {}, "2026-11-10", "Asia/Shanghai");
    expect(datesBj).toEqual(["2026-11-02"]);
    // 11-01 16:30Z 在北京是 11-02，正常归入第 1 周，不报"早于开始日期"
    const issues = checkProgress(profile, [{ name: "打卡/s1.json", raw: s1 }], ["2026-11-02-第1周.md"], new Date("2026-11-10T02:00:00Z"), {
      "2026-11-02-第1周.json": { schema: REVIEW_FORMAT, start: "2026-11-02", week: 1, trainings: 1, symptoms: false, moves: [] },
    }, "Asia/Shanghai");
    expect(issues).toEqual([]);

    // prepareSessionImport 按档案时区生成文件名与段开始校验
    const bundle = { profile, timeZone: "Asia/Shanghai", sessions: [], reviewData: {}, courses: [], assessments: [], docs: [] };
    const realCid = courseIdFor("18-39岁-纯徒手版", 1, "标准", 1, "A", false);
    const s1Accepted = { ...s1, course: { ...s1.course, id: realCid } };
    const okImport = prepareSessionImport(bundle, s1Accepted, { now: new Date("2026-11-02T00:00:00Z") });
    expect(okImport.status).toBe("accepted");
    expect(okImport.suggestedName).toBe("打卡/养夏_练习记录_2026-11-02_0030.json");
    // 错误 course.id 必被拒绝
    const s1Bad = { ...s1, course: { ...s1.course, id: "c_0" } };
    expect(prepareSessionImport(bundle, s1Bad, { now: new Date("2026-11-02T00:00:00Z") }).status).toBe("rejected");
  });

  it("checkProgressLog 在跨时区下正确判定 sickToday 与 退回 规则", () => {
    const profile = {
      schema: PROFILE_FORMAT,
      code: "bj-log",
      stage: "18–39 岁",
      age: "a18",
      venue: "bw",
      product: "18-39岁-纯徒手版",
      birth: "1995-05",
      timezone: "Asia/Shanghai",
      startDate: "2026-11-02",
      segments: [{ n: 1, type: "标准", week: 1, start: "2026-11-02", product: "18-39岁-纯徒手版" }],
      progress: { squat: { level: 2 } },
      progressLog: [
        { date: "2026-11-02", move: "squat", field: "level", to: 1, rule: "建档" },
        { date: "2026-11-03", move: "squat", field: "level", to: 2, rule: "找级", evidence: "打卡/s1.json" },
      ],
      screening: { answers: [{ item: "心脏病", answer: "否" }], doctorCleared: true, date: "2026-11-02", doctorDate: "2026-11-02" },
    };
    // 北京时间 2026-11-03 00:30（UTC 2026-11-02 16:30）练了一次轻松
    const s1 = {
      name: "打卡/s1.json",
      raw: {
        schema: SESSION_FORMAT,
        course: { id: "c_abcdef", name: "A", source: { plan: "yangxia.plans/1", product: "18-39岁-纯徒手版", segment: 1, type: "标准", week: 1, day: "A" } },
        startedAt: "2026-11-02T16:30:00.000Z",
        items: [{ exercise: "squat", setsPlanned: 2, setsDone: 2, feel: "做到上限还很轻松" }],
        feeling: "轻松",
        symptoms: { pain: false, dizzy: false, chest: false },
      },
    };
    const ok = checkProgressLog(profile, plans, rules, [s1], {}, new Date("2026-11-04T00:00:00Z"), [], "Asia/Shanghai");
    expect(ok.filter((i) => i.level === "error")).toEqual([]);

    // 若北京 2026-11-03 01:00 有一次疼痛记录，11-03 的找级升档必须被 sickToday 拦下
    const sHurt = {
      name: "打卡/s2.json",
      raw: {
        ...s1.raw,
        startedAt: "2026-11-02T17:00:00.000Z",
        symptoms: { pain: true, dizzy: false, chest: false },
      },
    };
    const blocked = checkProgressLog(profile, plans, rules, [s1, sHurt], {}, new Date("2026-11-04T00:00:00Z"), [], "Asia/Shanghai");
    expect(blocked.some((i) => i.level === "error" && /疼痛/.test(i.message))).toBe(true);
  });
});
