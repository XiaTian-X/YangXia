// 第一轮审查修复（F2）：表单接口、复盘这一周的核对、不适不能推周、网页写个人进度、返回的报错不露命令行字样。
import { afterEach, describe, expect, it } from "vitest";
import { ASSESS_FORMAT, buildAssessmentRecord, buildReviewRecord, DECLARATION, REVIEW_FORMAT, SESSION_FORMAT, type AssessmentForm, type ReviewForm } from "@yangxia/course-core";
import { createTestServer, makeA18HomeProfile, TEST_SETUP_CODE, type TestServerHandle } from "./helpers.ts";

let srv: TestServerHandle | null = null;
afterEach(() => {
  srv?.cleanup();
  srv = null;
});

const CLI = /npm run|档案\.json|course (export|assess|plan)/;

async function setup() {
  const s = await createTestServer({ now: new Date("2026-11-02T03:00:00.000Z") });
  const res = await s.req("/api/setup/init", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "AdminPassword123", setupCode: TEST_SETUP_CODE }),
  });
  let cookie = (res.headers.get("set-cookie") ?? "").split(";")[0];
  // 拨了好几周的钟，登录会过期：重新登录换一个
  const relogin = async () => {
    const r = await s.req("/api/auth/login", {
      method: "POST",
      origin: "http://localhost",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "AdminPassword123" }),
    });
    cookie = (r.headers.get("set-cookie") ?? "").split(";")[0];
  };
  const call = async (path: string, method = "GET", body?: unknown) =>
    s.req(path, {
      method,
      cookie,
      csrf: method !== "GET",
      origin: "http://localhost",
      ...(body !== undefined ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
    });
  return { s, call, relogin };
}

describe("表单接口：建档、评估、复盘、个人进度都由服务端照规则算", () => {
  it("建档表单：筛查答案走请求体；只列起始期成品；居家能直接进稳定期", async () => {
    const { s, call } = await setup();
    srv = s;
    const r = await call("/api/intake/form", "POST", { stage: "18–39 岁", venue: "home", product: "18-39岁-居家版" });
    expect(r.status).toBe(200);
    const { form } = await r.json();
    expect(form.products.map((p: { name: string }) => p.name)).not.toContain("18-39岁-超重与肥胖（附册）");
    expect(form.products.find((p: { recommended: boolean }) => p.recommended).name).toBe("18-39岁-居家版");
    if (form.direct) expect(form.direct.product).toBe("18-39岁-居家版（稳定期）");
    expect((await call("/api/intake/form", "POST", { stage: 3 })).status).toBe(400);
  });

  it("评估表单 → 组装记录 → 提交；结论有人话；不适的练习记录让复盘锁定、不能推周；重来这一周可以", async () => {
    const { s, call } = await setup();
    srv = s;
    const manifest = s.ctx.templates.current().manifest;
    // 先只建档（入门评估之后再交）
    const created = await (await call("/api/profiles", "POST", { profile: makeA18HomeProfile(manifest, "表单甲") })).json();
    const pid = created.id as string;

    const fr = await call(`/api/profiles/${pid}/assessments/form?kind=入门`);
    expect(fr.status).toBe(200);
    const form = (await fr.json()).form as AssessmentForm;
    expect(form.sections.flatMap((x) => x.fields.map((f) => f.key))).toEqual(expect.arrayContaining(["base", "tests.pushup-test.level"]));
    const record = buildAssessmentRecord({ ...form, lines: [] }, { base: 0, "tests.pushup-test.level": 2, "tests.pushup-test.value": 8 }, "2026-11-02");
    expect(record.schema).toBe(ASSESS_FORMAT);
    const ar = await call(`/api/profiles/${pid}/assessments`, "POST", { record });
    expect(ar.status).toBe(201);
    const list = await (await call(`/api/profiles/${pid}/assessments`)).json();
    expect(list.assessments[0].conclusionText.length).toBeGreaterThan(0);
    expect(JSON.stringify(list.assessments[0].conclusionText)).not.toMatch(/[{}]/);

    // 发布 A 日，手机回传一条带头晕的记录
    const pub = await (await call(`/api/profiles/${pid}/courses/publish`, "POST", { week: 1, day: "A" })).json();
    const sess = {
      schema: SESSION_FORMAT,
      course: { id: pub.envelope.course.id, name: pub.envelope.course.name, source: pub.envelope.course.source },
      startedAt: "2026-11-02T01:00:00.000Z",
      endedAt: "2026-11-02T01:30:00.000Z",
      items: [{ exercise: pub.envelope.course.blocks[0].items[0].exercise, setsPlanned: 2, setsDone: 2 }],
      feeling: "正好",
      symptoms: { pain: false, dizzy: true, chest: false },
    };
    expect((await call("/api/mobile/sessions", "POST", { profileId: pid, session: sess })).status).toBe(201);

    s.setNow(new Date("2026-11-09T02:00:00.000Z"));
    const rf = await (await call(`/api/profiles/${pid}/reviews/form`, "POST", {})).json();
    expect(rf.form.symptomsLocked).toBe(true);
    expect(rf.form.minTrainings).toBe(1);
    expect(rf.form.next.find((x: { value: string }) => x.value === "advance").allowed).toBe(false);

    const base = { startDate: "2026-11-02", week: 1, reviewMd: `${DECLARATION}\n\n第 1 周复盘` };
    const rv = (patch: Record<string, unknown>) => ({ schema: REVIEW_FORMAT, start: "2026-11-02", week: 1, trainings: 1, symptoms: true, habits: { 散步: 3, 冥想: 0 }, moves: [], ...patch });
    const few = await call(`/api/profiles/${pid}/reviews`, "POST", { ...base, reviewJson: rv({ trainings: 0 }) });
    expect(few.status).toBe(422);
    expect((await few.json()).code).toBe("REVIEW_TRAININGS_TOO_FEW");
    const hide = await call(`/api/profiles/${pid}/reviews`, "POST", { ...base, reviewJson: rv({ symptoms: false }) });
    expect((await hide.json()).code).toBe("REVIEW_SYMPTOMS_MISMATCH");
    const adv = await call(`/api/profiles/${pid}/reviews`, "POST", { ...base, reviewJson: rv({}), next: "advance" });
    expect((await adv.json()).code).toBe("REVIEW_ADVANCE_BLOCKED");
    const rep = await call(`/api/profiles/${pid}/reviews`, "POST", { ...base, reviewJson: rv({}), next: "repeat" });
    expect(rep.status).toBe(201);
    const after = await (await call(`/api/profiles/${pid}`)).json();
    const segs = after.profile.segments;
    expect(segs[segs.length - 1]).toMatchObject({ n: 1, week: 1, start: "2026-11-09" });
    expect(segs[segs.length - 1]).not.toHaveProperty("habitTargets");
  });

  it("网页写个人进度：表单列出动作和规则；不合规则的整批拒，报错是界面说法；合规则的重放通过", async () => {
    const { s, call } = await setup();
    srv = s;
    const manifest = s.ctx.templates.current().manifest;
    const created = await (await call("/api/profiles", "POST", {
      profile: makeA18HomeProfile(manifest, "进度甲"),
      initialAssessment: { schema: ASSESS_FORMAT, date: "2026-11-02", kind: "入门", base: 0, tests: [{ id: "pushup-test", level: 2, value: 8 }], conclusion: {} },
    })).json();
    const pid = created.id as string;
    const pf = await (await call(`/api/profiles/${pid}/progress/form`)).json();
    expect(pf.form.moves.map((m: { move: string }) => m.move)).toContain("pushup");
    expect(pf.form.rules.map((r: { rule: string }) => r.rule)).toEqual(expect.arrayContaining(["建档", "找级", "升级", "减量"]));

    // 第 1 周升级：不合规则（不是升级周、没有依据）
    const bad = await call(`/api/profiles/${pid}/progress-log`, "POST", { entries: [{ date: "2026-11-03", move: "pushup", field: "level", to: 3, rule: "升级" }] });
    expect(bad.status).toBe(422);
    const badBody = await bad.json();
    expect(JSON.stringify(badBody)).not.toMatch(CLI);
    // 建档：起始级照训练单（合规则）
    const ok = await call(`/api/profiles/${pid}/progress-log`, "POST", { entries: [{ date: "2026-11-02", move: "squat", field: "level", to: 1, rule: "建档" }] });
    expect(ok.status).toBe(200);
    expect((await ok.json()).progress.squat.level).toBe(1);
  });

  it("练完页每个动作的补充当个人进度的依据：感受\"做到上限还很轻松\"找级升一级，\"当场退回\"降回上一级", async () => {
    const { s, call } = await setup();
    srv = s;
    const snap = s.ctx.templates.current();
    const created = await (await call("/api/profiles", "POST", {
      profile: makeA18HomeProfile(snap.manifest, "依据甲"),
      initialAssessment: { schema: ASSESS_FORMAT, date: "2026-11-02", kind: "入门", base: 0, tests: [{ id: "pushup-test", level: 2, value: 8 }], conclusion: {} },
    })).json();
    const pid = created.id as string;
    const move = "squat";
    expect((await call(`/api/profiles/${pid}/progress-log`, "POST", { entries: [{ date: "2026-11-02", move, field: "level", to: 1, rule: "建档" }] })).status).toBe(200);
    const pub = await (await call(`/api/profiles/${pid}/courses/publish`, "POST", { week: 1, day: "A" })).json();
    const course = pub.envelope.course;
    const ladder = (snap.plans!.products["18-39岁-居家版"].ladders?.[move] ?? []) as { exercise: string }[];
    const items = course.blocks.flatMap((b: { items: { exercise: string; sets?: number }[] }) => b.items);
    const pi = items.findIndex((it: { exercise: string }) => ladder.some((l) => l.exercise === it.exercise));
    expect(pi).toBeGreaterThanOrEqual(0);
    // 手机照核心 buildSession 写的记录：只有填了的动作带 feel / spare / reverted
    const session = (startedAt: string, extra: Record<string, unknown>) => ({
      schema: SESSION_FORMAT,
      course: { id: course.id, name: course.name, source: course.source },
      startedAt,
      endedAt: new Date(Date.parse(startedAt) + 30 * 60_000).toISOString(),
      items: items.map((it: { exercise: string; sets?: number }, i: number) => ({ exercise: it.exercise, setsPlanned: it.sets ?? 1, setsDone: it.sets ?? 1, skipped: false, ...(i === pi ? extra : {}) })),
      feeling: "正好",
      symptoms: { pain: false, dizzy: false, chest: false },
    });
    s.setNow(new Date("2026-11-05T09:00:00.000Z"));
    expect((await call("/api/mobile/sessions", "POST", { profileId: pid, session: session("2026-11-03T01:00:00.000Z", { feel: "做到上限还很轻松" }) })).status).toBe(201);
    const pf = await (await call(`/api/profiles/${pid}/progress/form`)).json();
    const ev1 = pf.form.evidence.sessions[0].value as string;
    const up = await call(`/api/profiles/${pid}/progress-log`, "POST", { entries: [{ date: "2026-11-04", move, field: "level", to: 2, rule: "找级", evidence: ev1 }] });
    expect(JSON.stringify(await up.clone().json())).not.toMatch(CLI);
    expect(up.status).toBe(200);
    expect((await up.json()).progress[move].level).toBe(2);

    expect((await call("/api/mobile/sessions", "POST", { profileId: pid, session: session("2026-11-05T01:00:00.000Z", { feel: "做不到下限或后面几下变形", reverted: true }) })).status).toBe(201);
    const pf2 = await (await call(`/api/profiles/${pid}/progress/form`)).json();
    const ev2 = (pf2.form.evidence.sessions as { value: string }[]).find((x) => x.value !== ev1)!.value;
    // 没有标"当场退回"的那份记录不能当退回的依据
    const wrong = await call(`/api/profiles/${pid}/progress-log`, "POST", { entries: [{ date: "2026-11-05", move, field: "level", to: 1, rule: "退回", evidence: ev1 }] });
    expect(wrong.status).toBe(422);
    const down = await call(`/api/profiles/${pid}/progress-log`, "POST", { entries: [{ date: "2026-11-05", move, field: "level", to: 1, rule: "退回", evidence: ev2 }] });
    expect(down.status).toBe(200);
    expect((await down.json()).progress[move].level).toBe(1);
  });

  it("减脂的人这一周称的 BMI 不到 18.5：推到下一周时目标照规则改回保持，返回原因，整档核对通过", async () => {
    const { s, call, relogin } = await setup();
    srv = s;
    const manifest = s.ctx.templates.current().manifest;
    const product = "18-39岁-居家版（稳定期）";
    const created = await call("/api/profiles", "POST", {
      profile: makeA18HomeProfile(manifest, "减脂甲", {
        product, body: "记", focus: { areas: ["训练"] }, bodyLog: [{ date: "2026-11-02", body: "记" }],
        segments: [{ n: 1, type: "标准", phase: "稳定", week: 1, start: "2026-11-02", product, goal: "减脂" }],
      }),
      initialAssessment: {
        schema: ASSESS_FORMAT, date: "2026-11-02", kind: "入门", base: 2, goal: "减脂", eatingCheck: "问过",
        body: { height: 175, weight: 80, waist: 95 }, tests: [{ id: "pushup-test", level: 3, value: 10 }], conclusion: {},
      },
    });
    expect(created.status).toBe(201);
    const pid = (await created.json()).id as string;
    // 直接进稳定期的第 1 轮按保持算；第 2 轮（第 5 周）称的体重 BMI 不到 18.5，下一周起退回保持
    const day = (n: number) => new Date(Date.UTC(2026, 10, 2 + n)).toISOString().slice(0, 10);
    let body: any = null;
    for (let w = 1; w <= 5; w++) {
      const start = day(7 * (w - 1));
      s.setNow(new Date(`${day(7 * w)}T02:00:00.000Z`));
      await relogin();
      const rfr = await (await call(`/api/profiles/${pid}/reviews/form`, "POST", { symptoms: false })).json();
      const rf = rfr.form as ReviewForm;
      // 必填的照最小值填（测试里只为走到"推到下一周"）；第 5 周体重 55 公斤，BMI 约 18.0
      const values: Record<string, unknown> = { trainings: 3, symptoms: false, ...(w === 5 ? { weight: 55, cardioMinutes: 100, tired: false } : {}) };
      for (const f of rf.sections.flatMap((x) => x.fields)) {
        if (!f.required || f.readonly || values[f.key] !== undefined) continue;
        const inp = f.input as { type: string; min?: number; options?: { value: unknown }[] };
        values[f.key] = inp.type === "yesno" ? false : inp.type === "enum" ? inp.options![0].value : inp.min ?? 0;
      }
      const reviewJson = buildReviewRecord(rf, values);
      const r = await call(`/api/profiles/${pid}/reviews`, "POST", { startDate: start, week: w, reviewJson, reviewMd: `${DECLARATION}\n\n第 ${w} 周`, next: "advance" });
      body = await r.json();
      expect(r.status).toBe(201);
      if (w < 5) expect(body.goalReverted).toBeNull();
    }
    expect(body.goalReverted).toMatch(/下一周起目标改回保持/);
    expect(body.goalReverted).not.toMatch(CLI);
    const segs = body.profile.segments;
    expect(segs[segs.length - 1]).toMatchObject({ week: 6, goal: "保持" });
    const audit = await (await call(`/api/profiles/${pid}/audit`)).json();
    expect(audit.issues.filter((i: { level: string; path: string }) => i.level === "error" && /goal/.test(i.path))).toEqual([]);
  });

  it("档案设置里的训练条件：列这份成品要问的条件和档案记的值；服务端自己的报错也换成界面说法", async () => {
    const { s, call } = await setup();
    srv = s;
    const manifest = s.ctx.templates.current().manifest;
    const created = await (await call("/api/profiles", "POST", { profile: makeA18HomeProfile(manifest, "条件甲") })).json();
    const cs = await (await call(`/api/profiles/${created.id}/conditions`)).json();
    expect(cs.conditions.find((c: { name: string }) => c.name === "高血压")).toMatchObject({ recorded: false, perSession: false });
    // 报错文字不带英文字段名（AppError 也过 cleanText）
    const bad = await call("/api/profiles/not-a-profile/conditions");
    expect(JSON.stringify(await bad.json())).not.toMatch(CLI);
  });

  it("按向导建档：服务端组装档案；有基础的人直接进稳定期，入门评估当场达线；不达线被拒", async () => {
    const { s, call } = await setup();
    srv = s;
    const base = { stage: "18–39 岁", venue: "home", product: "18-39岁-居家版" };
    const items = (await (await call("/api/intake/form", "POST", base)).json()).form.screening.items as string[];
    const input = {
      answers: { ...base, direct: true, screening: Object.fromEntries(items.map((x) => [x, "否"])), conditions: { 高血压: false } },
      code: "直进甲", startDate: "2026-11-02", timezone: "Asia/Shanghai", wake: "07:00", birth: "1996-05", body: "不记", choices: ["table-row"], focus: ["训练"],
    };
    const ef = await call("/api/intake/entry-form", "POST", { input });
    expect(ef.status).toBe(200);
    const form = (await ef.json()).form as AssessmentForm;
    const rec = (base: number, level: number, value: number) => buildAssessmentRecord({ ...form, lines: [] },
      { base, "tests.pushup-test.level": level, "tests.pushup-test.value": value, "tests.wallsit-test.value": 30 }, "2026-11-02");
    const weak = await call("/api/profiles/from-intake", "POST", { input, initialAssessment: rec(1, 2, 8) });
    expect(weak.status).toBe(422);
    expect(JSON.stringify(await weak.json())).toMatch(/有基础/);
    const ok = await call("/api/profiles/from-intake", "POST", { input, initialAssessment: rec(2, 3, 10) });
    expect(ok.status).toBe(201);
    const created = await ok.json();
    const detail = await (await call(`/api/profiles/${created.id}`)).json();
    expect(detail.profile.segments[0]).toMatchObject({ phase: "稳定", product: "18-39岁-居家版（稳定期）" });
    expect(detail.profile.bedtime).toBe("22:40");
  });

  it("档案检查的报错换成界面说法：不出现命令、档案文件名", async () => {
    const { s, call } = await setup();
    srv = s;
    const manifest = s.ctx.templates.current().manifest;
    const created = await (await call("/api/profiles", "POST", { profile: makeA18HomeProfile(manifest, "检查甲") })).json();
    const audit = await (await call(`/api/profiles/${created.id}/audit`)).json();
    const entry = audit.issues.find((i: { code?: string }) => i.code === "ENTRY_ASSESSMENT_MISSING");
    expect(entry.message).toMatch(/到「评估与复盘」填写/);
    for (const i of audit.issues) expect(`${i.path} ${i.message}`).not.toMatch(CLI);
  });
});
