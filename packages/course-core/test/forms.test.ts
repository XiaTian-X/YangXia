import { describe, expect, it } from "vitest";
import { ASSESS_FORMAT, assessmentForm, buildAssessmentRecord, buildReviewRecord, REVIEW_FORMAT, SESSION_FORMAT, choiceGroups, evaluateAssessment, exportCourse, intakeForm, missingFields, profileFromIntake, nextWeekEntry, reviewForm, validateReview, uncoveredChoiceGroups, type IntakeTemplates, type PlansData, type RulesData } from "../src/index.ts";
import { loadTemplates, templatesDir } from "../src/node.ts";
import { fixtureManifest, fixturePlans } from "./helpers.ts";

describe("choiceGroups：建档向导照训练单问\"按器材选一个\"", () => {
  it("没有这份成品、或者成品里没有 choose 行时返回空", () => {
    expect(choiceGroups(fixturePlans(), fixtureManifest(), "不存在的成品")).toEqual([]);
  });

  it("真实模板：每份起始期、稳定期成品的组都能导出；13–17 岁按\"家长在旁边\"分两组；非动作 ID 的选项标不能导出", async () => {
    if (!(await templatesDir())) return;
    const t = await loadTemplates();
    const plans = t.plans as PlansData;
    const teen = choiceGroups(plans, t.manifest, "13-17岁-纯徒手版");
    expect(teen.length).toBe(2);
    const withParent = teen.find((g) => g.condition?.value === true)!;
    const noParent = teen.find((g) => g.condition?.value === false)!;
    expect(withParent.condition?.name).toBe("家长在旁边");
    expect(withParent.options.map((o) => o.value)).toContain("table-row");
    expect(noParent.options.map((o) => o.value)).not.toContain("table-row");
    expect(noParent.options.find((o) => o.value === "（毛巾划船）")).toMatchObject({ exportable: false, name: "毛巾划船" });

    // 只选桌下划船：家长不在旁边的那组没覆盖
    expect(uncoveredChoiceGroups(teen, ["table-row"]).map((g) => g.key)).toEqual([noParent.key]);
    expect(uncoveredChoiceGroups(teen, ["table-row", "door-row"])).toEqual([]);

    // 附册、餐饮模板、65 岁以上、6–12 岁没有要选的器材
    for (const name of ["65岁以上-椅子辅助版", "6-12岁-户外与游戏版（家长版）"]) {
      expect(choiceGroups(plans, t.manifest, name)).toEqual([]);
    }

    // 每份有 choose 的成品：每组选第一个可导出的选项后，用到它的那天能导出（不再报"先问使用者能用哪个"）
    for (const [name, product] of Object.entries(plans.products)) {
      const groups = choiceGroups(plans, t.manifest, name);
      if (!groups.length) continue;
      const choices = groups.map((g) => (g.options.find((o) => o.exportable) ?? g.options[0]).value);
      expect(uncoveredChoiceGroups(groups, choices)).toEqual([]);
      for (const g of groups) {
        for (const day of g.days) {
          const row = product.rows.find((r) => r.trim.kind === "choose" && r.day === day);
          if (!row) continue;
          const phase = name.includes("稳定期") ? "稳定" : "起始";
          const profile = {
            product: name,
            choices,
            conditions: g.condition ? { [g.condition.name]: g.condition.value } : {},
            segments: [{ n: 1, product: name, type: row.segments[0], phase, week: row.weeks[0], start: "2026-11-02" }],
          };
          const res = exportCourse({ plans, rules: t.rules as RulesData, manifest: t.manifest, profile, week: row.weeks[0], day });
          expect(res.issues.filter((e) => e.path === "profile.choices"), `${name} ${day}`).toEqual([]);
        }
      }
    }
  });
});

describe("intakeForm：建档向导要问什么、能选什么由规则推出", () => {
  async function real(): Promise<IntakeTemplates | null> {
    if (!(await templatesDir())) return null;
    const t = await loadTemplates();
    return { manifest: t.manifest, plans: t.plans as PlansData, rules: t.rules as RulesData };
  }
  const allNo = (items: string[]) => Object.fromEntries(items.map((x) => [x, "否" as const]));

  it("没选阶段只给选项；学龄前不建档", async () => {
    const t = await real();
    if (!t) return;
    const empty = intakeForm(t, {});
    expect(empty.stages.map((s) => s.stage)).toContain("学龄前");
    expect(empty.age).toBeNull();
    const pre = intakeForm(t, { stage: "学龄前" });
    expect(pre.blocked).toMatch(/不覆盖/);
    expect(pre.products).toEqual([]);
  });

  it("18–39 岁：问场地；只列起始期成品，按场地标推荐不预选；居家能直接进稳定期、健身房不能", async () => {
    const t = await real();
    if (!t) return;
    const f = intakeForm(t, { stage: "18–39 岁", venue: "home" });
    expect(f.age).toBe("a18");
    expect(f.venueAsk?.options.map((o) => o.value)).toEqual(["gym", "home", "bw"]);
    expect(f.products.map((p) => p.name).sort()).toEqual(["18-39岁-健身房版", "18-39岁-居家版", "18-39岁-纯徒手版"]);
    expect(f.products.filter((p) => p.recommended).map((p) => p.name)).toEqual(["18-39岁-居家版"]);
    expect(f.direct).toBeNull(); // 还没选成品

    const home = intakeForm(t, { stage: "18–39 岁", venue: "home", product: "18-39岁-居家版" });
    expect(home.direct).toMatchObject({ product: "18-39岁-居家版（稳定期）", days: 2, level: 3, reps: 8 });
    expect(home.basics).toMatchObject({ birth: true, body: true, walkBase: false, school: null, focus: false });
    expect(intakeForm(t, { stage: "18–39 岁", venue: "gym", product: "18-39岁-健身房版" }).direct).toBeNull();
    // 直接进稳定期：器材按稳定期那份，问方向
    const direct = intakeForm(t, { stage: "18–39 岁", venue: "home", product: "18-39岁-居家版", direct: true });
    expect(direct.basics.focus).toBe(true);
    expect(direct.choiceGroups.length).toBeGreaterThan(0);
  });

  it("训练条件只问这份成品的；重度肥胖只在 BMI ≥ 28 答\"是\"时问；有氧问过医生只对高血压（或没确认）、重度肥胖的人问", async () => {
    const t = await real();
    if (!t) return;
    const base = { stage: "18–39 岁", venue: "bw", product: "18-39岁-纯徒手版" };
    const items = intakeForm(t, base).screening!.items;
    const names = (a: object) => intakeForm(t, { ...base, ...a }).conditions.map((c) => c.name);
    expect(names({ screening: allNo(items) })).toEqual(["高血压", "有氧问过医生"]); // 高血压没确认
    expect(names({ screening: allNo(items), conditions: { 高血压: false } })).toEqual(["高血压"]);
    const bmi = items.find((x) => /BMI\s*≥\s*28/.test(x))!;
    const bmiYes = { screening: { ...allNo(items), [bmi]: "是" as const }, conditions: { 高血压: false } };
    expect(names(bmiYes)).toEqual(["高血压", "有氧问过医生", "重度肥胖"]);
    expect(names({ ...bmiYes, conditions: { 高血压: false, 重度肥胖: false } })).toEqual(["高血压", "重度肥胖"]);
    // 健身房版没有"重度肥胖"、40–64 岁才有"骨质疏松"
    expect(intakeForm(t, { stage: "18–39 岁", venue: "gym", product: "18-39岁-健身房版", ...bmiYes }).conditions.map((c) => c.name)).not.toContain("重度肥胖");
    expect(intakeForm(t, { stage: "40–64 岁", venue: "gym", product: "40-64岁-健身房版" }).conditions.map((c) => c.name)).toContain("骨质疏松");
    expect(names({})).not.toContain("骨质疏松");
  });

  it("13–17 岁、65 岁以上、6–12 岁：各自的条件和基本信息；65 岁以上筛查都答\"否\"也要先问医生", async () => {
    const t = await real();
    if (!t) return;
    const teen = intakeForm(t, { stage: "初中", product: "13-17岁-纯徒手版" });
    expect(teen.venueAsk).toBeNull();
    expect(teen.products.map((p) => p.recommended)).toEqual([true]);
    expect(teen.conditions.map((c) => c.name).sort()).toEqual(["家长在旁边", "没地方跳"]);
    expect(teen.conditions.find((c) => c.name === "家长在旁边")).toMatchObject({ perSession: true, unconfirmed: false });
    expect(teen.basics).toMatchObject({ birth: false, body: false, school: { stages: ["初中", "高中"] } });
    expect(teen.choiceGroups.length).toBe(2);

    const senior = intakeForm(t, { stage: "65 岁以上", product: "65岁以上-椅子辅助版" });
    expect(senior.conditions.map((c) => c.name)).toEqual(["家里没有别人"]);
    expect(senior.basics).toMatchObject({ birth: true, body: false, walkBase: true });
    const done = intakeForm(t, { stage: "65 岁以上", product: "65岁以上-椅子辅助版", screening: allNo(senior.screening!.items) });
    expect(done.screeningOutcome?.needDoctor).toBe(true);

    const child = intakeForm(t, { stage: "小学", product: "6-12岁-户外与游戏版（家长版）" });
    expect(child.conditions).toEqual([]);
    expect(child.basics.school?.stages).toEqual(["小学"]);
  });

  it("profileFromIntake：组装的档案过档案核对；只写问到并答了的条件；直接进稳定期第一段写稳定期成品", async () => {
    const t = await real();
    if (!t) return;
    const { validateProfile, checkProfileWithTemplates } = await import("../src/index.ts");
    const base = { stage: "18–39 岁", venue: "home", product: "18-39岁-居家版" };
    const items = intakeForm(t, base).screening!.items;
    const answers = { ...base, screening: allNo(items), conditions: { 高血压: false, 骨质疏松: true } };
    const r = profileFromIntake(t, { answers, code: "小夏", startDate: "2026-11-02", timezone: "Asia/Shanghai", wake: "07:00", birth: "1996-05", body: "不记", choices: ["table-row"] });
    if ("error" in r) throw new Error(r.error);
    const p = r.profile as Record<string, any>;
    expect(p.bedtime).toBe("22:40");
    expect(p.conditions).toEqual({ 高血压: false }); // 骨质疏松不属于 18–39 岁，不写
    expect(p.segments).toEqual([{ n: 1, type: "标准", week: 1, start: "2026-11-02", product: "18-39岁-居家版" }]);
    const issues = [...validateProfile(p), ...checkProfileWithTemplates(p, t.manifest)].filter((i) => i.level === "error");
    expect(issues).toEqual([]);

    const d = profileFromIntake(t, { answers: { ...answers, direct: true }, code: "小夏", startDate: "2026-11-02", timezone: "Asia/Shanghai", birth: "1996-05", body: "不记", choices: ["table-row"], focus: ["训练"] });
    if ("error" in d) throw new Error(d.error);
    expect((d.profile as any).segments[0]).toMatchObject({ phase: "稳定", product: "18-39岁-居家版（稳定期）" });
    expect((d.profile as any).focus).toEqual({ areas: ["训练"] });
    // 没答完筛查、孕期答"是"：不组装
    expect(profileFromIntake(t, { answers: base, code: "x", startDate: "2026-11-02", timezone: "Asia/Shanghai" })).toMatchObject({ error: expect.stringMatching(/筛查/) });
  });

  it("筛查：没答完没有结论；都答\"否\"可以开始；有\"是\"先问医生；孕期、产后 6 个月内答\"是\"不建档", async () => {
    const t = await real();
    if (!t) return;
    const base = { stage: "18–39 岁", venue: "home", product: "18-39岁-居家版" };
    const items = intakeForm(t, base).screening!.items;
    expect(intakeForm(t, { ...base, screening: { [items[0]]: "否" } }).screeningOutcome).toBeNull();
    expect(intakeForm(t, { ...base, screening: allNo(items) }).screeningOutcome).toMatchObject({ needDoctor: false });
    expect(intakeForm(t, { ...base, screening: { ...allNo(items), [items[0]]: "是" } }).screeningOutcome).toMatchObject({ needDoctor: true });
    const preg = items.find((x) => /怀孕/.test(x))!;
    const blocked = intakeForm(t, { ...base, screening: { ...allNo(items), [preg]: "是" } });
    expect(blocked.blocked).toMatch(/不覆盖/);
    expect(blocked.screeningOutcome).toBeNull();
  });
});

describe("assessmentForm：评估要问、要测什么（和 course assess 同一份）", () => {
  const STAGE: Record<string, string> = { a06: "小学", a13: "初中", a18: "18–39 岁", a40: "40–64 岁", a65: "65 岁以上" };
  const BIRTH: Record<string, string> = { a18: "1996-05", a40: "1980-05", a65: "1950-05" };
  async function setup(product: string, extra: Record<string, unknown> = {}) {
    if (!(await templatesDir())) return null;
    const t = await loadTemplates();
    const prod = t.manifest.products.find((p) => p.name === product)! as { age: string; venue: string; phase?: string };
    const stable = prod.phase === "稳定";
    const profile = {
      code: "t", stage: STAGE[prod.age], age: prod.age, venue: prod.venue, product,
      ...(BIRTH[prod.age] ? { birth: BIRTH[prod.age] } : { school: { stage: STAGE[prod.age], entry: 2025 } }),
      screening: { answers: [], doctorCleared: true, date: "2026-11-02", doctorDate: "2026-11-02" },
      segments: [{ n: 1, type: stable ? "稳定" : "标准", phase: stable ? "稳定" : "起始", week: 1, start: "2026-11-02", product }],
      progress: {}, progressLog: [], ...extra,
    };
    const bundle = { profile, timeZone: "Asia/Shanghai", sessions: [], reviewData: {}, courses: [], assessments: [], docs: [] };
    return { t, bundle };
  }
  const keys = (f: ReturnType<typeof assessmentForm>, section?: string) =>
    "error" in f ? [] : f.sections.filter((s) => !section || s.id === section).flatMap((s) => s.fields.map((x) => x.key));

  it("种类不对、起始期做周期末：返回错误", async () => {
    const s = await setup("18-39岁-居家版");
    if (!s) return;
    expect(assessmentForm(s.bundle, s.t, "随便")).toMatchObject({ error: expect.stringMatching(/种类/) });
    expect(assessmentForm(s.bundle, s.t, "周期末")).toMatchObject({ error: expect.stringMatching(/稳定期/) });
  });

  it("18–39 岁居家入门：训练基础 0 / 1 / 2，俯卧撑级照成品阶梯（6 级）；体重腰围只在\"记\"时问", async () => {
    const s = await setup("18-39岁-居家版", { body: "不记" });
    if (!s) return;
    const f = assessmentForm(s.bundle, s.t, "入门");
    if ("error" in f) throw new Error(f.error);
    const base = f.sections.find((x) => x.id === "general")!.fields.find((x) => x.key === "base")!;
    expect(base.input).toMatchObject({ type: "enum", options: [{ value: 0 }, { value: 1 }, { value: 2 }] });
    const level = f.sections.find((x) => x.id === "tests")!.fields.find((x) => x.key === "tests.pushup-test.level")!;
    expect(level.input.type === "enum" && level.input.options.length).toBe(6);
    expect(keys(f, "body")).toEqual([]);
    expect(f.lines[0]).toMatch(/^入门评估 · 18-39岁-居家版（未经专业审核/);
    const recorded = await setup("18-39岁-居家版", { body: "记" });
    const fb = assessmentForm(recorded!.bundle, recorded!.t, "入门");
    expect(keys(fb, "body")).toEqual(["body.height", "body.weight", "body.waist"]);
  });

  it("40–64 岁徒手：开工前提；静蹲有高血压或没确认的封顶，没有高血压的不封", async () => {
    const s = await setup("40-64岁-纯徒手版");
    if (!s) return;
    const f = assessmentForm(s.bundle, s.t, "入门");
    expect(keys(f, "prereqs")).toEqual(["prereqs.checkup", "prereqs.bpOk"]);
    const wall = (ff: typeof f) => ("error" in ff ? undefined : ff.sections.flatMap((x) => x.fields).find((x) => x.key === "tests.wallsit-test.value"));
    expect(wall(f)?.input).toMatchObject({ type: "int", max: 30 });
    const ok = await setup("40-64岁-纯徒手版", { conditions: { 高血压: false } });
    expect(wall(assessmentForm(ok!.bundle, ok!.t, "入门"))?.input).toMatchObject({ type: "int", max: 600 });
  });

  it("65 岁以上入门：坐站测试（用手方式、做完没有、停下原因）、家人在旁、医生同意；跌倒风险自查问卷和步态", async () => {
    const s = await setup("65岁以上-椅子辅助版", { habitBase: { 散步: 20 } });
    if (!s) return;
    const f = assessmentForm(s.bundle, s.t, "入门");
    if ("error" in f) throw new Error(f.error);
    expect(keys(f, "tests")).toEqual(["tests.chair-stand-30s.value", "tests.chair-stand-30s.hands", "tests.chair-stand-30s.done", "tests.chair-stand-30s.stopReason"]);
    expect(keys(f, "general")).toEqual(expect.arrayContaining(["companion", "doctorCleared", "doctorDate"]));
    const ask = keys(f, "fallRisk.ask");
    expect(ask).toEqual(expect.arrayContaining(["fallRisk.askedOn", "fallRisk.general.fell", "fallRisk.general.unsteady", "fallRisk.severity.twoPlus", "fallRisk.frail.fatigue", "fallRisk.dizzy"]));
    const unsteady = f.sections.flatMap((x) => x.fields).find((x) => x.key === "fallRisk.general.unsteady")!;
    expect(unsteady.input.type).toBe("yesnoUnsure");
    const twoPlus = f.sections.flatMap((x) => x.fields).find((x) => x.key === "fallRisk.severity.twoPlus")!;
    expect(twoPlus.showIf?.length).toBe(3);
    expect(keys(f, "fallRisk.gait")).toEqual(["fallRisk.walk4m", "fallRisk.tug"]);
    // 不记体重腰围、不问训练基础
    expect(keys(f)).not.toContain("base");
    expect(keys(f, "body")).toEqual([]);
  });

  it("6–12 岁、13–17 岁入门：不测、不记身体数据；13–17 岁问训练基础", async () => {
    const child = await setup("6-12岁-户外与游戏版（家长版）");
    if (!child) return;
    const fc = assessmentForm(child.bundle, child.t, "入门");
    expect(keys(fc)).toEqual([]);
    const teen = await setup("13-17岁-纯徒手版");
    const ft = assessmentForm(teen!.bundle, teen!.t, "入门");
    expect(keys(ft)).toEqual(["base"]);
  });

  it("健身房段末：重量取自个人进度、只读；带段号", async () => {
    const s = await setup("18-39岁-健身房版", { body: "不记", progress: { "gym-smith-squat": { weight: 40 } },
      segments: [{ n: 1, type: "标准", phase: "起始", week: 4, start: "2026-11-02", product: "18-39岁-健身房版" }] });
    if (!s) return;
    const f = assessmentForm(s.bundle, s.t, "段末");
    if ("error" in f) throw new Error(f.error);
    expect(f.segment).toBe(1);
    const w = f.sections.flatMap((x) => x.fields).find((x) => x.key === "tests.gym-weights.gym-smith-squat")!;
    expect(w).toMatchObject({ readonly: true, value: 40 });
    expect(f.summary.join("\n")).toMatch(/段末结论/);
  });

  it("触发：原因取 REASONS；跨段（满 65 岁）可换成的成品是 65 岁以上的", async () => {
    const s = await setup("40-64岁-健身房版", { birth: "1961-01" });
    if (!s) return;
    const f = assessmentForm(s.bundle, s.t, "触发", { now: new Date("2026-11-25T08:00:00Z") });
    if ("error" in f) throw new Error(f.error);
    const reasons = f.sections.flatMap((x) => x.fields).find((x) => x.key === "reasons")!;
    expect(reasons.input.type === "multi" && reasons.input.options.map((o) => o.value)).toContain("跌倒自查到期");
    expect(f.switchProducts).toEqual(["65岁以上-椅子辅助版"]);
    expect(f.lines.join("\n")).toMatch(/跨段要换到 a65 的成品/);
  });

  it("buildAssessmentRecord：照表单填的值组装的记录，服务端重算时 0 错误；没填的必填项列出来", async () => {
    const s = await setup("18-39岁-居家版", { body: "不记" });
    if (!s) return;
    const f = assessmentForm(s.bundle, s.t, "入门");
    if ("error" in f) throw new Error(f.error);
    expect(missingFields(f, {}).map((x) => x.key)).toEqual(["base", "tests.pushup-test.level", "tests.pushup-test.value"]);
    const values = { base: 2, "tests.pushup-test.level": 3, "tests.pushup-test.value": 10 };
    expect(missingFields(f, values)).toEqual([]);
    const raw = buildAssessmentRecord(f, values, "2026-11-02");
    expect(raw).toEqual({ schema: ASSESS_FORMAT, date: "2026-11-02", kind: "入门", base: 2, tests: [{ id: "pushup-test", level: 3, value: 10 }] });
    const ev = evaluateAssessment(s.bundle, s.t, "入门", { name: "评估/2026-11-02-入门.json", raw });
    expect(ev.issues.filter((i) => i.level === "error")).toEqual([]);
  });

  it("65 岁以上入门：坐站、家人在旁、医生同意、跌倒风险自查组装的记录 0 错误；严重程度只在一般性有\"是\"时问", async () => {
    const s = await setup("65岁以上-椅子辅助版", { habitBase: { 散步: 20 } });
    if (!s) return;
    const f = assessmentForm(s.bundle, s.t, "入门");
    if ("error" in f) throw new Error(f.error);
    const d = "2026-11-02";
    const values: Record<string, unknown> = {
      "tests.chair-stand-30s.value": 10, "tests.chair-stand-30s.hands": "扶椅子", "tests.chair-stand-30s.done": true,
      companion: true, doctorCleared: true, doctorDate: d,
      "fallRisk.askedOn": d, "fallRisk.general.fell": false, "fallRisk.general.unsteady": false, "fallRisk.general.fear": false,
      "fallRisk.needsSupport": false, "fallRisk.hardToStand": false, "fallRisk.dizzy": false,
      "fallRisk.walk4m": { seconds: 3.6, cane: false, siteOk: true, testedOn: d },
      "fallRisk.tug": { seconds: 9.8, cane: false, siteOk: true, chairOk: true, testedOn: d },
    };
    expect(missingFields(f, values)).toEqual([]);
    // 一般性有"是"：严重程度、衰弱要问
    expect(missingFields(f, { ...values, "fallRisk.general.fear": true }).map((x) => x.key)).toEqual(expect.arrayContaining(["fallRisk.severity.twoPlus", "fallRisk.frail.fatigue"]));
    const raw = buildAssessmentRecord(f, values, d);
    expect(raw.tests).toEqual([{ id: "chair-stand-30s", value: 10, hands: "扶椅子", done: true }]);
    expect(raw).not.toHaveProperty("fallRisk.severity");
    const ev = evaluateAssessment(s.bundle, s.t, "入门", { name: `评估/${d}-入门.json`, raw });
    expect(ev.issues.filter((i) => i.level === "error")).toEqual([]);
    expect(ev.conclusion).toHaveProperty("fallRisk");
  });
});

describe("reviewForm：周复盘要填什么、下一周怎么走", () => {
  const STAGE: Record<string, string> = { a06: "小学", a13: "初中", a18: "18–39 岁", a40: "40–64 岁", a65: "65 岁以上" };
  const session = (startedAt: string, dizzy = false, items: Record<string, unknown>[] = []) => ({
    name: `打卡/${startedAt.slice(0, 10)}.json`,
    raw: { schema: SESSION_FORMAT, course: { id: "c_abcdef12", name: "第 1 周 A 日", source: { week: 1, day: "A" } }, startedAt,
      items, feeling: "正好", symptoms: { pain: false, dizzy, chest: false } },
  });
  async function setup(product: string, seg: Record<string, unknown>, extra: Record<string, unknown> = {}, sessions: ReturnType<typeof session>[] = []) {
    if (!(await templatesDir())) return null;
    const t = await loadTemplates();
    const prod = t.manifest.products.find((p) => p.name === product)! as { age: string; venue: string; phase?: string };
    const stable = prod.phase === "稳定";
    const profile = { code: "t", stage: STAGE[prod.age], age: prod.age, venue: prod.venue, product, choices: ["table-row", "door-row"],
      segments: [{ n: 1, type: stable ? "稳定" : "标准", phase: stable ? "稳定" : "起始", week: 1, start: "2026-11-02", product, ...seg }], progress: {}, ...extra };
    return { t, bundle: { profile, timeZone: "Asia/Shanghai", sessions, reviewData: {}, courses: [], assessments: [], docs: [] } };
  }
  const keysOf = (f: ReturnType<typeof reviewForm>, id: string) => ("error" in f ? [] : (f.sections.find((s) => s.id === id)?.fields ?? []).map((x) => x.key));

  it("记录里有头晕：有不适锁定、不能推到下一周；训练次数不少于记录数；组装的复盘数据格式合格", async () => {
    const s = await setup("18-39岁-居家版", {}, { habitTargets: undefined }, [
      session("2026-11-03T10:00:00+08:00", true, [{ exercise: "pushup", setsPlanned: 3, setsDone: 3, skipped: false, feel: "正好" }]),
      session("2026-11-05T10:00:00+08:00"),
      session("2026-11-10T10:00:00+08:00"), // 下一周的，不算
    ]);
    if (!s) return;
    const f = reviewForm(s.bundle, s.t);
    if ("error" in f) throw new Error(f.error);
    expect(f.sessions.length).toBe(2);
    expect(f.minTrainings).toBe(2);
    expect(f.symptomsLocked).toBe(true);
    expect(f.next.find((x) => x.value === "advance")).toMatchObject({ allowed: false });
    expect(f.next.find((x) => x.value === "repeat")).toMatchObject({ allowed: true });
    expect(keysOf(f, "habits")).toEqual(["habits.散步", "habits.冥想"]);
    expect(keysOf(f, "cardio")).toEqual([]);
    const moves = keysOf(f, "moves");
    expect(moves).toContain("moves.pushup.allAtTop");
    expect(moves).toContain("moves.table-row.spare");
    const pushNote = f.sections.find((x) => x.id === "moves")!.fields.find((x) => x.key === "moves.pushup.allAtTop")!.note;
    expect(pushNote).toMatch(/2026-11-03：3\/3 组，感受"正好"/);
    const rec = buildReviewRecord(f, { trainings: 2, "habits.散步": 4, "habits.冥想": 0, "moves.pushup.allAtTop": true, "moves.pushup.spare": 2, "moves.table-row.allAtTop": false });
    expect(rec).toMatchObject({ schema: REVIEW_FORMAT, start: "2026-11-02", week: 1, trainings: 2, symptoms: true, habits: { 散步: 4, 冥想: 0 },
      moves: [{ move: "pushup", allAtTop: true, spare: 2 }] });
    expect(validateReview(rec)).toEqual([]);
  });

  it("纯徒手第 2 周问稳态自查；没有不适能推到下一周；推周不带 habitTargets", async () => {
    const s = await setup("18-39岁-纯徒手版", { week: 2, start: "2026-11-09", habitTargets: { 散步: { days: 4 } } });
    if (!s) return;
    const f = reviewForm(s.bundle, s.t);
    if ("error" in f) throw new Error(f.error);
    expect(keysOf(f, "cardio")).toEqual(["steadyCheck"]);
    expect(f.next.find((x) => x.value === "advance")).toMatchObject({ allowed: true });
    expect(nextWeekEntry(s.bundle.profile, "advance")).toEqual({ n: 1, type: "标准", phase: "起始", week: 3, start: "2026-11-16", product: "18-39岁-纯徒手版" });
    expect(nextWeekEntry(s.bundle.profile, "repeat")).toMatchObject({ week: 2, start: "2026-11-16" });
    // 使用者自己勾了不适：也不能推
    const g = reviewForm(s.bundle, s.t, { symptoms: true });
    expect("error" in g ? null : g.next.find((x) => x.value === "advance")?.allowed).toBe(false);
  });

  it("65 岁以上记摔倒、差点摔倒、头晕；6–12 岁记生病天数；第 4 周只能去段末评估", async () => {
    const a = await setup("65岁以上-椅子辅助版", { week: 4 }, { habitBase: { 散步: 20 } });
    if (!a) return;
    const f = reviewForm(a.bundle, a.t);
    if ("error" in f) throw new Error(f.error);
    expect(keysOf(f, "a65")).toEqual(["falls", "nearFalls", "dizzy", "weightDrop"]);
    expect(f.next.map((x) => x.value)).toEqual(["end"]);
    const rec = buildReviewRecord(f, { trainings: 3, "habits.散步": 5, "habits.放松": 5, falls: 0, nearFalls: 0, dizzy: 1 });
    expect(rec.symptoms).toBe(true); // 头晕也是不适
    const c = await setup("6-12岁-户外与游戏版（家长版）", {});
    const fc = reviewForm(c!.bundle, c!.t);
    expect(keysOf(fc, "a06")).toEqual(["sickDays"]);
    expect(keysOf(fc, "habits")).toEqual(["habits.动够60分钟", "habits.按时上床", "habits.视屏少于2小时"]);
  });
});
