import { describe, expect, it } from "vitest";
import * as coreIndex from "../src/index.ts";
import {
  ASSESS_FORMAT,
  auditProfileBundle,
  courseIdFor,
  DECLARATION,
  DELIVERY_FORMAT,
  detectInvalidatedCourses,
  exportProfileCourse,
  generateProfileSheet,
  prepareSessionImport,
  PROFILE_FORMAT,
  SESSION_FORMAT,
  type ProfileBundle,
  type TemplateBundle,
} from "../src/index.ts";
import { loadTemplates, templatesDir } from "../src/node.ts";
import { fixtureManifest, fixtureMotions, fixturePlans, fixtureRules } from "./helpers.ts";

function fixtureTemplates(): TemplateBundle {
  return {
    manifest: fixtureManifest(),
    plans: fixturePlans(),
    rules: fixtureRules(),
    motions: fixtureMotions(),
    readProduct: () => null,
    templateHash: "fixture-hash",
    motionHashes: { squat: "h-squat", plank: "h-plank", "gym-farmer-walk": "h-walk" },
  };
}

function screeningAllNo(manifest: TemplateBundle["manifest"], age = "a18") {
  const items = manifest.intake.screening.find((s) => s.age === age)?.items ?? ["心脏病"];
  return { answers: items.map((item) => ({ item, answer: "否" as const })), doctorCleared: true, date: "2026-11-02", doctorDate: "2026-11-02" };
}

function baseProfile(manifest: TemplateBundle["manifest"], patch: Record<string, any> = {}) {
  return {
    schema: PROFILE_FORMAT,
    code: "eng-user",
    stage: "18–39 岁",
    age: "a18",
    venue: "home",
    product: "18-39岁-居家版",
    birth: "1995-05",
    body: "不记",
    timezone: "Asia/Shanghai",
    startDate: "2026-11-02",
    segments: [{ n: 1, type: "标准", week: 1, start: "2026-11-02", product: "18-39岁-居家版" }],
    screening: screeningAllNo(manifest, "a18"),
    conditions: { 高血压: false, 没地方跳: false },
    choices: ["table-row"],
    ...patch,
  };
}

describe("engine.ts 存储无关核心引擎", () => {
  it("index.ts 严禁导出 package.ts（保护课程包嵌入块唯一性）", () => {
    expect("packCourse" in coreIndex).toBe(false);
    expect("unpackCourse" in coreIndex).toBe(false);
    expect("packageInfo" in coreIndex).toBe(false);
    expect("PACKAGE_FORMAT" in coreIndex).toBe(false);
  });

  it("auditProfileBundle：拦截非法历史段号、缺 household 的菜单、历史计划单 legacyReadonly 免于 checkSheet", () => {
    const t = fixtureTemplates();
    const profile = baseProfile(t.manifest, {
      segments: [
        { n: 1, type: "标准", week: 1, start: "2026-11-02", product: "18-39岁-居家版" },
      ],
    });
    const bundle: ProfileBundle = {
      profile,
      timeZone: "Asia/Shanghai",
      sessions: [],
      reviewData: {},
      courses: [{ name: "历史/第1段/课程/x.json", raw: {}, archived: true, archivedSegment: 1 }],
      assessments: [],
      docs: [
        { name: "菜单/第1周.md", text: `${DECLARATION}\n\n周一：鸡胸肉配青菜`, kind: "menu" },
        // 旧版迁入的历史计划单（无生成标记，但标了 legacyReadonly）不触发 checkSheet 报错
        { name: "计划/第1段-第1周.md", text: `${DECLARATION}\n\n历史计划单归档`, kind: "plan", legacyReadonly: true },
      ],
    };
    const issues = auditProfileBundle(bundle, t, { now: new Date("2026-11-03T02:00:00Z") });
    expect(issues.some((i) => i.level === "error" && i.path.includes("历史/第1段") && /小于现在的第 1 段/.test(i.message))).toBe(true);
    expect(issues.some((i) => i.level === "error" && i.path === "菜单/第1周.md" && /household/.test(i.message))).toBe(true);
    expect(issues.some((i) => i.path === "计划/第1段-第1周.md" && /没有找到生成标记/.test(i.message))).toBe(false);

    // 去掉 legacyReadonly 后，手写计划单必被 checkSheet 拦下
    const strictBundle: ProfileBundle = {
      ...bundle,
      courses: [],
      docs: [{ name: "计划/第1段-第1周.md", text: `${DECLARATION}\n\n手写计划单`, kind: "plan" }],
    };
    const strictIssues = auditProfileBundle(strictBundle, t, { now: new Date("2026-11-03T02:00:00Z") });
    expect(strictIssues.some((i) => i.level === "error" && i.path === "计划/第1段-第1周.md" && /没有找到生成标记/.test(i.message))).toBe(true);
  });

  it("prepareSessionImport：覆盖去重、不可抹除症状/edited、CLOCK_SKEW_FUTURE 与时区校验", () => {
    const t = fixtureTemplates();
    const profile = baseProfile(t.manifest);
    const cid = courseIdFor("18-39岁-居家版", 1, "标准", 1, "A", false);
    const makeSession = (patch: Record<string, any> = {}) => ({
      schema: SESSION_FORMAT,
      course: {
        id: cid,
        name: "第 1 周 A 日",
        source: { plan: "yangxia.plans/1", product: "18-39岁-居家版", templates: "v1.0.0", segment: 1, type: "标准", week: 1, day: "A" },
      },
      startedAt: "2026-11-02T01:30:00.000Z", // 北京时间 09:30
      endedAt: "2026-11-02T01:55:00.000Z",
      items: [{ exercise: "squat", setsPlanned: 2, setsDone: 2 }],
      feeling: "正好",
      symptoms: { pain: false, dizzy: false, chest: false },
      ...patch,
    });
    const now = new Date("2026-11-02T02:00:00.000Z");
    const bundle: ProfileBundle = { profile, timeZone: "Asia/Shanghai", sessions: [], reviewData: {}, courses: [], assessments: [], docs: [] };

    // 正常接收
    const r1 = prepareSessionImport(bundle, makeSession(), { now });
    expect(r1.status).toBe("accepted");
    expect(r1.suggestedName).toBe("打卡/养夏_练习记录_2026-11-02_0930.json");

    // 未来超 5 分钟 → clock_skew_future
    const future = prepareSessionImport(bundle, makeSession({ startedAt: "2026-11-02T02:10:00.000Z", endedAt: "2026-11-02T02:30:00.000Z" }), { now });
    expect(future.status).toBe("clock_skew_future");
    expect(future.serverNow).toBe(now.toISOString());

    // 已有不适记录：--replace 不可将 pain 抹为 false
    const hurtSess = makeSession({ symptoms: { pain: true, dizzy: false, chest: false } });
    const withHurt: ProfileBundle = { ...bundle, sessions: [{ name: "打卡/s1.json", raw: hurtSess }] };
    const dup = prepareSessionImport(withHurt, hurtSess, { now });
    expect(dup.status).toBe("duplicate");
    const erasePain = prepareSessionImport(withHurt, makeSession(), { replace: true, now });
    expect(erasePain.status).toBe("rejected");
    expect(erasePain.reason).toContain("不能改成没有");

    // 已有 edited: true：--replace 不可抹除
    const editedSess = makeSession({ edited: true });
    const withEdited: ProfileBundle = { ...bundle, sessions: [{ name: "打卡/s2.json", raw: editedSess }] };
    const eraseEdited = prepareSessionImport(withEdited, makeSession(), { replace: true, now });
    expect(eraseEdited.status).toBe("rejected");
    expect(eraseEdited.reason).toContain("edited");
  });

  it("真实模板：exportProfileCourse 输出完整交付信封、detectInvalidatedCourses 覆盖全部作废触发条件、node.ts 防路径穿越", async () => {
    if (!(await templatesDir())) return;
    const t = await loadTemplates();
    // 验证 node.ts 新增能力
    expect(t.templateHash).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.keys(t.motionHashes).length).toBeGreaterThan(0);
    expect(t.listDocs().length).toBeGreaterThan(0);
    expect(t.readDoc("全家餐饮模板")).toBeTruthy();
    expect(t.readDoc("../README")).toBeNull();
    expect(t.resolveImage("../manifest.json")).toBeNull();
    expect(t.resolveImage("nonexistent.svg")).toBeNull();

    const profile = baseProfile(t.manifest);
    const bundle: ProfileBundle = {
      profile,
      timeZone: "Asia/Shanghai",
      sessions: [],
      reviewData: {},
      courses: [],
      assessments: [
        {
          name: "评估/2026-11-02-入门.json",
          raw: {
            schema: ASSESS_FORMAT,
            date: "2026-11-02",
            kind: "入门",
            base: 0,
            tests: [{ id: "pushup-test", level: 2, value: 8 }],
            conclusion: {},
          },
        },
      ],
      docs: [],
    };
    const now = new Date("2026-11-02T03:00:00Z");
    const exp = exportProfileCourse(bundle, t, { week: 1, day: "A", now });
    expect(exp.issues.filter((i) => i.level === "error")).toEqual([]);
    expect(exp.envelope).not.toBeNull();
    expect(exp.envelope!.schema).toBe(DELIVERY_FORMAT);
    expect(exp.envelope!.declaration).toBe(DECLARATION);
    expect(exp.envelope!.templateHash).toBe(t.templateHash);
    expect(exp.envelope!.notes.length).toBeGreaterThan(0);

    // 计划单生成
    const sh = generateProfileSheet(bundle, t, { now });
    expect(sh.issues).toEqual([]);
    expect(sh.file).toBe("计划/第1段-第1周.md");
    expect(sh.text).toContain("未经专业审核");

    // 1. 正常状态不作废
    const active = [{ name: "课程/第1段-第1周-A日.json", raw: exp.course!, createdDate: "2026-11-02" }];
    expect(detectInvalidatedCourses(bundle, t, active, { now })).toEqual([]);

    // 2. 导出后新增不适 → 强制作废
    const sickBundle: ProfileBundle = {
      ...bundle,
      sessions: [{
        name: "打卡/hurt.json",
        raw: {
          schema: SESSION_FORMAT,
          course: { id: exp.course!.id, name: exp.course!.name, source: exp.course!.source },
          startedAt: "2026-11-02T04:00:00.000Z",
          items: [{ exercise: exp.course!.blocks[0].items[0].exercise, setsPlanned: 2, setsDone: 1 }],
          feeling: "吃力",
          symptoms: { pain: true, dizzy: false, chest: false },
        },
      }],
    };
    const invSick = detectInvalidatedCourses(sickBundle, t, active, { now });
    expect(invSick).toHaveLength(1);
    expect(invSick[0].reason).toContain("疼痛、头晕或胸闷");

    // 3. 筛查改出"是"且无医生同意 → 强制作废
    const docBundle: ProfileBundle = {
      ...bundle,
      profile: baseProfile(t.manifest, {
        screening: {
          ...screeningAllNo(t.manifest, "a18"),
          answers: screeningAllNo(t.manifest, "a18").answers.map((a, i) => (i === 0 ? { ...a, answer: "是" } : a)),
          doctorCleared: false,
          doctorDate: undefined,
        },
      }),
    };
    const invDoc = detectInvalidatedCourses(docBundle, t, active, { now });
    expect(invDoc).toHaveLength(1);
    expect(invDoc[0].reason).toContain("医生同意");

    // 4. 推进到第 2 周 → 第 1 周旧课作废
    const nextWkBundle: ProfileBundle = {
      ...bundle,
      profile: baseProfile(t.manifest, {
        segments: [
          { n: 1, type: "标准", week: 1, start: "2026-11-02", product: "18-39岁-居家版" },
          { n: 1, type: "标准", week: 2, start: "2026-11-09", product: "18-39岁-居家版" },
        ],
      }),
    };
    const invNext = detectInvalidatedCourses(nextWkBundle, t, active, { now: new Date("2026-11-09T03:00:00Z") });
    expect(invNext).toHaveLength(1);
    expect(invNext[0].reason).toContain("第 1 段第 2 周");
  });
});
