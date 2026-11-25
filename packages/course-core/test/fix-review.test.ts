// 第一轮修复实施后审查的复查：下一周目标退回保持、评估表单的界面说法、复盘动作表现填一半、步态填完没有、
// 摔倒日期的空行、学段只问一次、练前确认带保守的一边。
import { describe, expect, it } from "vitest";
import {
  ASSESS_FORMAT,
  assessmentForm,
  buildAssessContext,
  buildAssessmentRecord,
  missingFields,
  nextWeekEntry,
  nextWeekGoalRevert,
  partialMoveFields,
  presentAssessmentForm,
  presentFormText,
  profileFromIntake,
  REVIEW_FORMAT,
  type AssessmentForm,
  type ReviewForm,
} from "../src/index.ts";
import { gaitComplete } from "../src/assess-form.ts";
import { loadTemplates, templatesDir } from "../src/node.ts";

describe("下一周的目标照规则退回保持（不让复盘存不了）", () => {
  it("真实模板：减脂的人这一周称的 BMI 不到 18.5，下一周起退回保持；改成保持以后不再报", async () => {
    if (!(await templatesDir())) return;
    const t = await loadTemplates();
    const product = "18-39岁-纯徒手版（稳定期）";
    const starts = Array.from({ length: 8 }, (_, i) => new Date(Date.UTC(2026, 10, 2 + 7 * i)).toISOString().slice(0, 10));
    const segs: Record<string, unknown>[] = starts.slice(0, 7).map((start, i) => ({ n: 1, type: "标准", phase: "稳定", week: i + 1, start, product, goal: "减脂" }));
    const profile: Record<string, any> = {
      code: "t", stage: "18–39 岁", age: "a18", venue: "bw", product, birth: "1996-05", body: "记",
      screening: { answers: [], doctorCleared: false, date: "2026-11-02" }, startDate: "2026-11-02",
      bodyLog: [{ date: "2026-11-02", body: "记" }], segments: segs, progress: {}, progressLog: [],
    };
    const reviewData: Record<string, any> = {};
    starts.slice(0, 7).forEach((start, i) => {
      reviewData[`${start}-第${i + 1}周.json`] = { schema: REVIEW_FORMAT, start, week: i + 1, trainings: 3, symptoms: false, moves: [],
        ...(i >= 4 ? { weight: i === 6 ? 55 : 70, cardioMinutes: 100, tired: false } : {}) };
    });
    const assessments = [{ name: "评估/2026-11-01-入门.json", raw: { schema: ASSESS_FORMAT, date: "2026-11-01", kind: "入门", base: 2, goal: "减脂", eatingCheck: "问过",
      body: { height: 175, weight: 80, waist: 95 }, tests: [{ id: "pushup-test", level: 3, value: 10 }] } }];
    const next = nextWeekEntry(profile, "advance")!;
    expect(next.goal).toBe("减脂"); // 照抄上一周
    profile.segments = [...segs, next];
    const bundle = { profile, timeZone: "Asia/Shanghai", sessions: [], reviewData, courses: [], assessments, docs: [] };
    const now = new Date("2026-12-21T08:00:00Z");
    const reason = nextWeekGoalRevert(buildAssessContext(bundle as any, t, { now }));
    expect(reason).toMatch(/退回保持/);
    next.goal = "保持";
    expect(nextWeekGoalRevert(buildAssessContext(bundle as any, t, { now }))).toBeNull();
  });
});

describe("评估表单交给网页的说法", () => {
  it("测试编号、年龄段代号、原始 JSON、英文字段名都换成人话", () => {
    expect(presentFormText(`结论：照原样；下一段：标准；习惯目标 {"散步":{"minutes":15},"放松":{"minutes":3}}`)).toBe("结论：照原样；下一段：标准；习惯目标 散步 15 分钟、放松 3 分钟");
    expect(presentFormText("pushup-test：前后比·同一级（原文是做到\"再也做不出一个标准动作\"的一组，照原文记录）")).toBe("俯卧撑测试：和上次比，要用同一级（原文是做到\"再也做不出一个标准动作\"的一组，照原文记录）");
    expect(presentFormText("chair-stand-30s：前后比·同一种用手的方式（没做完时 value 是已经做了几次；停下的原因是头晕的，算进段末\"头晕\"）")).not.toMatch(/chair-stand|value/);
    expect(presentFormText("现在推算是65 岁以上：跨段要换到 a65 的成品")).toBe("现在推算是65 岁以上：跨段要换到 65 岁以上 的成品");
    const s = presentFormText("结论：x；下一段：先不开：周期末以后看医生，做触发评估\"看完医生回来\"写明 doctorRestart（true 回起始期第 1 周；false 照后面几条再算一次）");
    expect(s).not.toMatch(/doctorRestart|true|false/);
    expect(presentFormText("下一周期能选的目标（还没算周期末量的体重腰围；写好记录再跑一次，结论的 goals 照重算的写）：保持、减脂——x。选减脂、增肌的，照第八章开头原话问一次进食困扰（eatingCheck），记 goal"))
      .not.toMatch(/goals|eatingCheck|goal\b|跑一次/);
    expect(presentFormText("body：BMI 分档（只在档案选了\"记\"时记；身高只在入门记。分档用 BMI_CN、WEIGHT_LOW_CN；腰围不分档（档案不记性别），只看前后）")).not.toMatch(/[A-Z]{3,}_|body：/);
    expect(presentFormText("habits.放松 是每周几天")).toBe("习惯「放松」 是每周几天");
  });

  it("真实模板：入门、触发评估的表单（含 65 岁以上跨段）换完以后不出现英文编号和年龄段代号", async () => {
    if (!(await templatesDir())) return;
    const t = await loadTemplates();
    const prod = "40-64岁-纯徒手版";
    const profile = {
      code: "t", stage: "40–64 岁", age: "a40", venue: "bw", product: prod, birth: "1961-01", body: "记", startDate: "2026-11-02",
      screening: { answers: [], doctorCleared: false, date: "2026-11-02" },
      segments: [{ n: 1, type: "标准", week: 2, start: "2026-11-02", product: prod }], progress: {}, progressLog: [],
    };
    const bundle = { profile, timeZone: "Asia/Shanghai", sessions: [], reviewData: {}, courses: [], assessments: [], docs: [] };
    for (const kind of ["入门", "触发"] as const) {
      const f = assessmentForm(bundle as any, t, kind, { now: new Date("2026-11-10T08:00:00Z") });
      if ("error" in f) continue;
      const p = presentAssessmentForm(f);
      const text = [...p.summary, ...p.sections.flatMap((s) => [...s.notes, ...s.fields.map((x) => x.note ?? "")])].join("\n");
      expect(text).not.toMatch(/[a-z]+-test|chair-stand|\ba(06|13|18|40|65)\b|[A-Z]{3,}_[A-Z]|doctorRestart|eatingCheck|\bvalue\b/);
      expect(p.lines).toEqual([]);
    }
  });
});

describe("复盘、评估表单的填法", () => {
  const rf = {
    sections: [{ id: "moves", title: "", notes: [], fields: [
      { key: "moves.squat.allAtTop", label: "深蹲：每组都做到区间上限了吗", required: false, input: { type: "yesno" } },
      { key: "moves.squat.spare", label: "深蹲：最后一组还剩几次余力", required: false, input: { type: "int", min: 0, max: 30 } },
      { key: "moves.squat.allDone", label: "深蹲：每组都做满现在的次数了吗", required: false, input: { type: "yesno" } },
    ] }],
  } as unknown as ReviewForm;

  it("动作表现填了一部分：每组都做到上限、最后一组余力都要补上", () => {
    expect(partialMoveFields(rf, {})).toEqual([]);
    expect(partialMoveFields(rf, { "moves.squat.allDone": true, "moves.squat.spare": 2 }).map((f) => f.key)).toEqual(["moves.squat.allAtTop"]);
    expect(partialMoveFields(rf, { "moves.squat.allDone": true, "moves.squat.spare": 2, "moves.squat.allAtTop": false })).toEqual([]);
  });

  it("步态：测了的要秒数、日期，用手杖、场地（起立行走另有椅子）都答了；不替人预答", () => {
    expect(gaitComplete({}, false)).toBe(false);
    expect(gaitComplete({ seconds: 3.6, testedOn: "2026-11-02" }, false)).toBe(false);
    expect(gaitComplete({ seconds: 3.6, testedOn: "2026-11-02", cane: false, siteOk: true }, false)).toBe(true);
    expect(gaitComplete({ seconds: 9.8, testedOn: "2026-11-02", cane: false, siteOk: true }, true)).toBe(false);
    expect(gaitComplete({ seconds: 9.8, testedOn: "2026-11-02", cane: false, siteOk: true, chairOk: true }, true)).toBe(true);
    expect(gaitComplete({ result: "没测成" }, false)).toBe(false);
    expect(gaitComplete({ result: "没测成", reason: "中途停下" }, false)).toBe(false);
    expect(gaitComplete({ result: "没测成", reason: "中途停下", stopReason: "头晕" }, false)).toBe(true);
    const form = { kind: "入门", product: "", code: "", age: "a65", segment: null, switchProducts: [], summary: [], lines: [], sections: [{ id: "g", title: "", notes: [], fields: [
      { key: "fallRisk.walk4m", label: "4 米走", required: true, input: { type: "gait", chair: false, untested: [], skipped: [], stops: [] } },
    ] }] } as unknown as AssessmentForm;
    expect(missingFields(form, { "fallRisk.walk4m": { seconds: 3.6, testedOn: "2026-11-02" } }).length).toBe(1);
  });

  it("摔倒的日期：空行不算", () => {
    const form = { kind: "触发", product: "", code: "", age: "a65", segment: null, switchProducts: [], summary: [], lines: [], sections: [{ id: "g", title: "", notes: [], fields: [
      { key: "eventDates", label: "摔倒的日期", required: true, input: { type: "dates" } },
    ] }] } as unknown as AssessmentForm;
    const rec = buildAssessmentRecord(form, { eventDates: ["2026-11-03", "", "2026-11-05"] }, "2026-11-06");
    expect(rec.eventDates).toEqual(["2026-11-03", "2026-11-05"]);
    expect(rec.eventDate).toBe("2026-11-05");
  });

  it("真实模板：基本信息里的学段和入口问卷不一样就不建档", async () => {
    if (!(await templatesDir())) return;
    const t = await loadTemplates();
    const tt = { manifest: t.manifest, plans: t.plans!, rules: t.rules! };
    const answers = { stage: "初中", product: "13-17岁-纯徒手版", screening: {} as Record<string, "是" | "否"> };
    const f0 = (await import("../src/index.ts")).intakeForm(tt, answers);
    for (const item of f0.screening?.items ?? []) answers.screening[item] = "否";
    const base = { code: "t1", answers, timezone: "Asia/Shanghai", startDate: "2026-11-02", choices: ["door-row"] };
    const bad = profileFromIntake(tt, { ...base, school: { stage: "高中", entry: 2025 } } as any);
    expect("error" in bad && bad.error).toMatch(/学段和入口问卷选的不一样/);
    const ok = profileFromIntake(tt, { ...base, school: { stage: "初中", entry: 2025 } } as any);
    expect("profile" in ok).toBe(true);
  });
});
