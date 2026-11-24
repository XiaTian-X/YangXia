// 阶段 3 Agent 核心、受控业务工具、两阶段高危确认、熔断护栏与权限隔离端到端测试。
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ASSESS_FORMAT, DECLARATION, REVIEW_FORMAT } from "@yangxia/course-core";
import { loadAgentLlmConfig } from "../src/agent/runtime/config.ts";
import type { AgentEvent, AgentRuntime, AgentTurnRequest } from "../src/agent/runtime/interface.ts";
import { appendMessage, cleanupExpiredThreads, createPendingConfirmation } from "../src/agent/store/threads.ts";
import { ALL_BUSINESS_TOOLS } from "../src/agent/tools/registry.ts";
import { runMigrations } from "../src/db/database.ts";
import { MIGRATIONS } from "../src/db/schema.ts";
import {
  createTestServer,
  extractSessionCookie,
  makeA13Profile,
  makeA18HomeProfile,
  makeA65Profile,
  screeningAllNo,
  type TestServerHandle,
} from "./helpers.ts";

const SERVER_SRC_DIR = new URL("../src/", import.meta.url).pathname;

function collectTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...collectTsFiles(p));
    else if (name.endsWith(".ts")) out.push(p);
  }
  return out;
}

/** 解析 Hono streamSSE 返回的 text/event-stream 事件数组。 */
async function readSseEvents(res: Response): Promise<{ event: string; data: any }[]> {
  const text = await res.text();
  const events: { event: string; data: any }[] = [];
  for (const block of text.split(/\n\n+/)) {
    const lines = block.trim().split("\n");
    let event = "message";
    const dataLines: string[] = [];
    for (const line of lines) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
    }
    if (dataLines.length) {
      events.push({ event, data: JSON.parse(dataLines.join("\n")) });
    }
  }
  return events;
}

/** 构造可编程 Mock AgentRuntime：直接执行编排器传入的 wrappedTools 并吐出标准 AgentEvent。 */
function createMockRuntime(
  handler: (req: AgentTurnRequest) => AsyncIterable<AgentEvent>,
): AgentRuntime {
  return {
    id: "mock-llm",
    streamTurn: handler,
  };
}

let handles: TestServerHandle[] = [];
afterEach(() => {
  for (const h of handles) h.cleanup();
  handles = [];
});

async function setupAdmin(opts: Parameters<typeof createTestServer>[0] = {}) {
  const srv = await createTestServer(opts);
  handles.push(srv);
  const origReq = srv.req;
  srv.req = (path, init = {}) =>
    origReq(path, {
      ...init,
      origin: init.origin ?? (init.csrf ? "http://localhost" : undefined),
    });
  const setupRes = await srv.req("/api/setup/init", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "AdminPassword123" }),
  });
  expect(setupRes.status).toBe(201);
  const cookie = extractSessionCookie(setupRes);
  return { srv, cookie };
}

describe("阶段 3：SDK 隔离与 Agent 元信息/加密配置", () => {
  it("仓库内仅 agent/runtime/vercel-ai.ts 一处允许 import ai / @ai-sdk/*", () => {
    const files = collectTsFiles(SERVER_SRC_DIR);
    const offenders: string[] = [];
    for (const f of files) {
      if (f.endsWith("agent/runtime/vercel-ai.ts")) continue;
      const content = readFileSync(f, "utf8");
      if (/from\s+["'](ai|@ai-sdk\/[^"']+)["']/.test(content)) {
        offenders.push(f);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("工具清单严禁包含任何 shell / 文件 / 网络工具，且全部入参不含跨档案 profileId", () => {
    for (const t of ALL_BUSINESS_TOOLS) {
      expect(t.name).not.toMatch(/(^|_)(shell|exec|bash|file|fs|fetch|http|curl)(_|$)/i);
      const shape = (t.parameters as { shape?: Record<string, unknown> }).shape ?? {};
      expect(Object.keys(shape)).not.toContain("profileId");
      expect(Object.keys(shape)).not.toContain("targetProfileId");
      expect(Object.keys(shape)).not.toContain("userId");
    }
  });

  it("未配置 API Key 时优雅返回 400 AGENT_NOT_CONFIGURED，配置后加密存储且永不明文回显", async () => {
    const { srv, cookie } = await setupAdmin();
    const info1 = await srv.req("/api/agent/info", { cookie });
    expect(info1.status).toBe(200);
    const j1 = await info1.json();
    expect(j1.configured).toBe(false);
    expect(j1.declaration).toBe(DECLARATION);
    expect(j1.disclosure).toContain("外部模型");
    expect(j1.minModelRequirement).toContain("最低推荐模型规格");

    const tRes = await srv.req("/api/agent/threads", {
      method: "POST",
      cookie,
      csrf: true,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ skill: "onboard" }),
    });
    const threadId = (await tRes.json()).thread.id as string;

    const msgFail = await srv.req(`/api/agent/threads/${threadId}/messages`, {
      method: "POST",
      cookie,
      csrf: true,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "你好" }),
    });
    expect(msgFail.status).toBe(400);
    expect((await msgFail.json()).code).toBe("AGENT_NOT_CONFIGURED");

    // 写入外部模型配置（使用拼接字符串避免触发密钥泄露钩子误报）
    const dummyApiKey = ["fake", "deepseek", "secret", "key", "9876543210abcdef"].join("-");
    const patchRes = await srv.req("/api/admin/settings", {
      method: "PATCH",
      cookie,
      csrf: true,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        items: [
          { key: "agent.provider", value: "deepseek" },
          { key: "agent.model", value: "deepseek-chat" },
          { key: "agent.apiKey", value: dummyApiKey },
        ],
      }),
    });
    expect(patchRes.status).toBe(200);

    // 设置接口与 info 接口均永不回显明文 Key
    const settingsRes = await srv.req("/api/admin/settings", { cookie });
    const settingsText = await settingsRes.text();
    expect(settingsText).not.toContain(dummyApiKey);

    const info2 = await srv.req("/api/agent/info", { cookie });
    const j2 = await info2.json();
    expect(j2.configured).toBe(true);
    expect(j2.provider).toBe("deepseek");
    expect(j2.model).toBe("deepseek-chat");
    expect(JSON.stringify(j2)).not.toContain(dummyApiKey);

    // 后端可通过宿主机 masterKey 正常解密
    const cfg = loadAgentLlmConfig(srv.ctx.getDb(), srv.ctx.masterKey);
    expect(cfg?.apiKey).toBe(dummyApiKey);
    expect(cfg?.provider).toBe("deepseek");
  });
});

describe("阶段 3：Mock LLM 全流程（建档 -> 确认卡评估 -> 排课 -> 周复盘 -> 家庭菜单）", () => {
  it("跑通建档筛查拦截、高危评估两阶段确认（覆盖伪造结论）、排课发布、周复盘推进与家庭菜单红线", async () => {
    let scriptStep: (req: AgentTurnRequest) => AsyncIterable<AgentEvent> = async function* () {
      yield { type: "done", finishReason: "stop", text: "" };
    };
    const { srv, cookie } = await setupAdmin({
      now: new Date("2026-11-02T03:00:00.000Z"),
      agentRuntimeFactory: () => createMockRuntime((req) => scriptStep(req)),
    });
    const manifest = srv.ctx.templates.current().manifest;

    // 1a. 先在一个独立建档对话验证：缺筛查被拦、筛查有“是”可建档但被禁发课，且已绑档对话严禁二次 create_profile 覆盖改绑
    const waitDocThreadId = (
      await (
        await srv.req("/api/agent/threads", {
          method: "POST",
          cookie,
          csrf: true,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ skill: "onboard", title: "待医审建档" }),
        })
      ).json()
    ).thread.id as string;

    const toolResults: Record<string, any> = {};
    scriptStep = async function* (req) {
      const getIntake = req.tools.find((t) => t.name === "get_intake_and_bedtime")!;
      const createProfile = req.tools.find((t) => t.name === "create_profile")!;
      const pubCourse = req.tools.find((t) => t.name === "publish_course")!;

      toolResults.intake = await getIntake.execute({ age: "a18", stage: "18–39 岁", wake: "07:00" });

      // 缺少安全筛查 -> 必拦截
      const missingScreenProfile = makeA18HomeProfile(manifest, "缺筛查");
      delete (missingScreenProfile as any).screening;
      toolResults.missingScreenCreate = await createProfile.execute({ profile: missingScreenProfile });

      // 筛查有“是”但没医生同意 -> 允许保存建档但带警告，且绝不允许发课
      const yesScreenProfile = makeA18HomeProfile(manifest, "待医审", {
        screening: {
          ...screeningAllNo(manifest, "a18", "2026-11-02", false),
          answers: screeningAllNo(manifest, "a18", "2026-11-02", false).answers.map((a, idx) =>
            idx === 0 ? { ...a, answer: "是" } : a,
          ),
        },
      });
      toolResults.yesScreenCreate = await createProfile.execute({ profile: yesScreenProfile });
      toolResults.blockedPublishBeforeDoctor = await pubCourse.execute({ week: 1, day: "A" });

      // 已绑档对话内再次调 create_profile -> 必返 THREAD_ALREADY_BOUND 杜绝改绑
      toolResults.rebindBlocked = await createProfile.execute({ profile: makeA18HomeProfile(manifest, "试图改绑") });

      yield { type: "done", finishReason: "stop", text: "待医审建档测试完成。" };
    };
    const r0 = await srv.req(`/api/agent/threads/${waitDocThreadId}/messages`, {
      method: "POST",
      cookie,
      csrf: true,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "测试筛查与防改绑" }),
    });
    expect(r0.status).toBe(200);
    await readSseEvents(r0);
    expect(toolResults.intake.ok).toBe(true);
    expect(toolResults.intake.data.bedtime).toBeTruthy();
    expect(toolResults.missingScreenCreate.ok).toBe(false);
    expect(toolResults.yesScreenCreate.ok).toBe(true);
    expect(toolResults.yesScreenCreate.data.warnings.length).toBeGreaterThan(0);
    expect(toolResults.blockedPublishBeforeDoctor.ok).toBe(false);
    expect(toolResults.rebindBlocked.ok).toBe(false);
    expect(toolResults.rebindBlocked.code).toBe("THREAD_ALREADY_BOUND");

    // 1b. 新建主流程建档对话并正常建档「小夏」
    const tRes = await srv.req("/api/agent/threads", {
      method: "POST",
      cookie,
      csrf: true,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ skill: "onboard", title: "首次建档" }),
    });
    expect(tRes.status).toBe(201);
    const threadId = (await tRes.json()).thread.id as string;

    scriptStep = async function* (req) {
      const createProfile = req.tools.find((t) => t.name === "create_profile")!;
      const okProfile = makeA18HomeProfile(manifest, "小夏");
      toolResults.okCreate = await createProfile.execute({ profile: okProfile });
      yield { type: "text_delta", text: `${DECLARATION}\n已为您建档「小夏」。` };
      yield { type: "done", finishReason: "stop", text: `${DECLARATION}\n已为您建档「小夏」。` };
    };

    const r1 = await srv.req(`/api/agent/threads/${threadId}/messages`, {
      method: "POST",
      cookie,
      csrf: true,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "帮我建档，早上 7 点起床" }),
    });
    expect(r1.status).toBe(200);
    const ev1 = await readSseEvents(r1);
    expect(ev1.some((e) => e.event === "done")).toBe(true);
    expect(toolResults.okCreate.ok).toBe(true);
    const profileId = toolResults.okCreate.data.profileId as string;

    // 核对 thread 已自动绑定到新档案
    const tDetail = await (await srv.req(`/api/agent/threads/${threadId}`, { cookie })).json();
    expect(tDetail.thread.profileId).toBe(profileId);

    // 3. 高危操作：提交入门评估（模型故意伪造 conclusion） -> 必须生成确认卡且此时数据库尚未落库！
    scriptStep = async function* (req) {
      const submitAssess = req.tools.find((t) => t.name === "submit_assessment")!;
      const updateScreening = req.tools.find((t) => t.name === "update_screening_and_doctor")!;

      toolResults.assessStage = await submitAssess.execute({
        record: {
          schema: ASSESS_FORMAT,
          kind: "入门",
          date: "2026-11-02",
          base: 0,
          tests: [{ id: "pushup-test", level: 2, value: 8 }],
          conclusion: { direction: "模型伪造的跳级结论", forged: true },
        },
      });
      // 同时暂存一张高危筛查修改卡，用于测试用户点击「取消」
      toolResults.screenStage = await updateScreening.execute({
        cardioClear: [{ date: "2026-11-02" }],
      });

      yield { type: "text_delta", text: "已为您准备好入门评估确认卡，请点击确认。" };
      yield { type: "done", finishReason: "stop", text: "已为您准备好入门评估确认卡，请点击确认。" };
    };

    const r2 = await srv.req(`/api/agent/threads/${threadId}/messages`, {
      method: "POST",
      cookie,
      csrf: true,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "提交入门评估", skill: "assess" }),
    });
    const ev2 = await readSseEvents(r2);
    const confirmEvents = ev2.filter((e) => e.event === "confirmation_required");
    expect(confirmEvents.length).toBe(2);
    const assessConfirmId = toolResults.assessStage.confirmationId as string;
    const screenConfirmId = toolResults.screenStage.confirmationId as string;
    expect(toolResults.assessStage.pendingConfirmation).toBe(true);

    // 确认前：数据库里 assessments 必须还是 0 条！
    const beforeAssessCount = (
      srv.ctx.getDb().prepare("SELECT COUNT(*) AS n FROM assessments WHERE profile_id = ?").get(profileId) as { n: number }
    ).n;
    expect(beforeAssessCount).toBe(0);

    // 用户取消筛查修改卡 -> 档案未改，且再次操作同确认卡返 409
    const cancelRes = await srv.req(`/api/agent/threads/${threadId}/confirm`, {
      method: "POST",
      cookie,
      csrf: true,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirmationId: screenConfirmId, decision: "cancel" }),
    });
    expect(cancelRes.status).toBe(200);
    const replayCancel = await srv.req(`/api/agent/threads/${threadId}/confirm`, {
      method: "POST",
      cookie,
      csrf: true,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirmationId: screenConfirmId, decision: "confirm" }),
    });
    expect(replayCancel.status).toBe(409);

    // 用户点击确认提交入门评估 -> 正式落库，且模型伪造的 conclusion.forged 被服务端权威重算覆盖
    const confirmAssess = await srv.req(`/api/agent/threads/${threadId}/confirm`, {
      method: "POST",
      cookie,
      csrf: true,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirmationId: assessConfirmId, decision: "confirm" }),
    });
    expect(confirmAssess.status).toBe(200);
    const confirmBody = await confirmAssess.json();
    expect(confirmBody.result.ok).toBe(true);
    expect(confirmBody.result.data.conclusion.forged).toBeUndefined();

    // 重放已确认卡片 -> 409
    const replayConfirm = await srv.req(`/api/agent/threads/${threadId}/confirm`, {
      method: "POST",
      cookie,
      csrf: true,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirmationId: assessConfirmId, decision: "confirm" }),
    });
    expect(replayConfirm.status).toBe(409);

    // 过期确认卡 -> 410 CONFIRMATION_EXPIRED
    const expiredCard = createPendingConfirmation(srv.ctx.getDb(), {
      threadId,
      userId: (srv.ctx.getDb().prepare("SELECT id FROM users WHERE username = 'admin'").get() as { id: string }).id,
      profileId,
      toolName: "update_screening_and_doctor",
      summary: "测试过期卡片",
      payload: { cardioClear: [{ date: "2026-11-02" }] },
      ttlMs: 1_000,
      now: new Date("2026-11-02T02:00:00.000Z"),
    });
    const expiredRes = await srv.req(`/api/agent/threads/${threadId}/confirm`, {
      method: "POST",
      cookie,
      csrf: true,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirmationId: expiredCard.id, decision: "confirm" }),
    });
    expect(expiredRes.status).toBe(410);

    // 4. 确定性计划单生成 + 发布课程
    scriptStep = async function* (req) {
      const genPlan = req.tools.find((t) => t.name === "generate_plan_sheet")!;
      const pubCourse = req.tools.find((t) => t.name === "publish_course")!;
      toolResults.plan = await genPlan.execute({});
      toolResults.course = await pubCourse.execute({ week: 1, day: "A" });
      yield { type: "done", finishReason: "stop", text: "已生成第 1 周计划单并发布 A 日课程。" };
    };
    const r3 = await srv.req(`/api/agent/threads/${threadId}/messages`, {
      method: "POST",
      cookie,
      csrf: true,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "生成本周计划单并发布 A 日课程", skill: "course-export" }),
    });
    await readSseEvents(r3);
    expect(toolResults.plan.ok).toBe(true);
    expect(toolResults.plan.data.excerpt).toContain(DECLARATION);
    expect(toolResults.course.ok).toBe(true);
    expect(toolResults.course.data.declaration).toBe(DECLARATION);

    // 5. 周中滑动续期后，第 1 周结束后做周复盘（高危确认卡）并推进至第 2 周
    srv.setNow(new Date("2026-11-05T02:00:00.000Z"));
    expect((await srv.req("/api/auth/refresh", { method: "POST", cookie, csrf: true })).status).toBe(200);
    srv.setNow(new Date("2026-11-09T02:00:00.000Z"));
    scriptStep = async function* (req) {
      const submitReview = req.tools.find((t) => t.name === "submit_weekly_review")!;
      // 缺免责声明 -> 预检必须失败，不发确认卡
      toolResults.badReview = await submitReview.execute({
        startDate: "2026-11-02",
        week: 1,
        reviewJson: {
          schema: REVIEW_FORMAT,
          start: "2026-11-02",
          week: 1,
          trainings: 0,
          symptoms: false,
          habits: { 散步: 5, 冥想: 5 },
          moves: [],
        },
        reviewMd: "# 第 1 周复盘\n本周完成记录，无不适。",
      });
      // 合规复盘 + 推进第 2 周 -> 生成确认卡
      toolResults.okReview = await submitReview.execute({
        startDate: "2026-11-02",
        week: 1,
        reviewJson: {
          schema: REVIEW_FORMAT,
          start: "2026-11-02",
          week: 1,
          trainings: 0,
          symptoms: false,
          habits: { 散步: 5, 冥想: 5 },
          moves: [],
        },
        reviewMd: `${DECLARATION}\n\n# 第 1 周复盘\n本周无不适，按规则进入第 2 周。`,
        nextSegmentEntry: { n: 1, type: "标准", week: 2, start: "2026-11-09", product: "18-39岁-居家版" },
      });
      yield { type: "done", finishReason: "stop", text: "请确认提交第 1 周复盘并进入第 2 周。" };
    };
    const r4 = await srv.req(`/api/agent/threads/${threadId}/messages`, {
      method: "POST",
      cookie,
      csrf: true,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "提交本周复盘并进入第 2 周", skill: "weekly-review" }),
    });
    expect(r4.status).toBe(200);
    await readSseEvents(r4);
    expect(toolResults.badReview.ok).toBe(false);
    expect(toolResults.okReview.ok).toBe(true);
    expect(toolResults.okReview.pendingConfirmation).toBe(true);

    // 确认前仍是第 1 周，确认后推进为第 2 周
    const pBefore = await (await srv.req(`/api/profiles/${profileId}`, { cookie })).json();
    expect(pBefore.profile.segments.length).toBe(1);

    const reviewConfirm = await srv.req(`/api/agent/threads/${threadId}/confirm`, {
      method: "POST",
      cookie,
      csrf: true,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirmationId: toolResults.okReview.confirmationId, decision: "confirm" }),
    });
    expect(reviewConfirm.status).toBe(200);
    const pAfter = await (await srv.req(`/api/profiles/${profileId}`, { cookie })).json();
    expect(pAfter.profile.segments.length).toBe(2);
    expect(pAfter.profile.segments[1].week).toBe(2);

    // 6. 全家排菜单：无 household 必拦、含儿童禁词（千卡/减肥）必拦、合规菜单写入成功
    scriptStep = async function* (req) {
      const saveMeal = req.tools.find((t) => t.name === "save_meal_plan")!;
      const updateCond = req.tools.find((t) => t.name === "update_conditions_and_choices")!;
      toolResults.mealNoHousehold = await saveMeal.execute({
        title: "第1周",
        contentMd: `${DECLARATION}\n\n# 全家一周菜单\n清炒时蔬配糙米饭。`,
      });
      toolResults.setHousehold = await updateCond.execute({ household: ["a18", "a06"] });
      toolResults.mealRedline = await saveMeal.execute({
        title: "第1周",
        contentMd: `${DECLARATION}\n\n# 全家一周菜单\n每天控制 1500 千卡帮助减肥。`,
      });
      toolResults.mealOk = await saveMeal.execute({
        title: "第1周",
        contentMd: `${DECLARATION}\n\n# 全家一周菜单\n- 周一：杂粮饭、清蒸鱼、焯水西兰花。`,
      });
      yield { type: "done", finishReason: "stop", text: "已保存全家一周菜单。" };
    };
    const r5 = await srv.req(`/api/agent/threads/${threadId}/messages`, {
      method: "POST",
      cookie,
      csrf: true,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "排一份全家菜单", skill: "meal-plan" }),
    });
    await readSseEvents(r5);
    expect(toolResults.mealNoHousehold.ok).toBe(false);
    expect(toolResults.setHousehold.ok).toBe(true);
    expect(toolResults.mealRedline.ok).toBe(false);
    expect(toolResults.mealOk.ok).toBe(true);
  });
});

describe("阶段 3：对抗性安全、青少年只读隔离、熔断护栏与取消中止", () => {
  it("跨用户对话完全隔离、13–17 岁青少年仅开放只读工具、mobile_bound 禁止访问 Agent", async () => {
    let teenObservedToolNames: string[] = [];
    let teenStateResult: any = null;
    const { srv, cookie: adminCookie } = await setupAdmin({
      agentRuntimeFactory: () =>
        createMockRuntime(async function* (req) {
          teenObservedToolNames = req.tools.map((t) => t.name);
          const getState = req.tools.find((t) => t.name === "get_profile_state");
          if (getState) teenStateResult = await getState.execute({});
          yield { type: "done", finishReason: "stop", text: "只读回复完成。" };
        }),
    });
    const manifest = srv.ctx.templates.current().manifest;

    // 管理员创建独立成年成员 bob 与青少年成员 teen
    const bobUser = await (
      await srv.req("/api/admin/users", {
        method: "POST",
        cookie: adminCookie,
        csrf: true,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "bob", password: "BobPassword123!", role: "member" }),
      })
    ).json();
    expect(bobUser.ok).toBe(true);
    const bobLogin = await srv.req("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "bob", password: "BobPassword123!" }),
    });
    const bobCookie = extractSessionCookie(bobLogin);

    const teenUser = await (
      await srv.req("/api/admin/users", {
        method: "POST",
        cookie: adminCookie,
        csrf: true,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "teen1", password: "TeenPassword123!", role: "member" }),
      })
    ).json();
    const teenUserId = teenUser.user.id as string;

    // 为青少年建立代管 a13 档案并绑定 teenUserId
    const teenProfRes = await srv.req("/api/profiles", {
      method: "POST",
      cookie: adminCookie,
      csrf: true,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profile: makeA13Profile(manifest, "青青"), isManaged: true, memberUserId: teenUserId }),
    });
    expect(teenProfRes.status).toBe(201);
    const teenProfileId = (await teenProfRes.json()).id as string;

    const teenLogin = await srv.req("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "teen1", password: "TeenPassword123!" }),
    });
    const teenCookie = extractSessionCookie(teenLogin);

    // 管理员建一个 thread，bob 尝试读/发消息/删 -> 全部 403
    const adminThreadId = (
      await (
        await srv.req("/api/agent/threads", {
          method: "POST",
          cookie: adminCookie,
          csrf: true,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ skill: "general" }),
        })
      ).json()
    ).thread.id as string;

    expect((await srv.req(`/api/agent/threads/${adminThreadId}`, { cookie: bobCookie })).status).toBe(403);
    expect(
      (
        await srv.req(`/api/agent/threads/${adminThreadId}/messages`, {
          method: "POST",
          cookie: bobCookie,
          csrf: true,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: "偷看" }),
        })
      ).status,
    ).toBe(403);
    expect((await srv.req(`/api/agent/threads/${adminThreadId}`, { method: "DELETE", cookie: bobCookie, csrf: true })).status).toBe(403);

    // 青少年建绑定自己 a13 档案的对话：只应看到 3 个严格只读工具（不含 inspect_assessment），且 get_profile_state 裁剪敏感明细
    const teenThreadId = (
      await (
        await srv.req("/api/agent/threads", {
          method: "POST",
          cookie: teenCookie,
          csrf: true,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ profileId: teenProfileId, skill: "general" }),
        })
      ).json()
    ).thread.id as string;

    const teenMsg = await srv.req(`/api/agent/threads/${teenThreadId}/messages`, {
      method: "POST",
      cookie: teenCookie,
      csrf: true,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "看看我的情况" }),
    });
    expect(teenMsg.status).toBe(200);
    await readSseEvents(teenMsg);
    expect(teenObservedToolNames.sort()).toEqual([
      "get_intake_and_bedtime",
      "get_profile_state",
      "read_template_section",
    ]);
    expect(teenStateResult?.ok).toBe(true);
    expect(teenStateResult?.data?.readOnlyView).toBe(true);
    expect(teenStateResult?.data?.screeningSummary).toBeUndefined();
    expect(teenStateResult?.data?.conditions).toBeUndefined();
    expect(teenStateResult?.data?.auditIssues).toBeUndefined();

    // 青少年尝试确认任何高危卡片 -> 403
    const fakeConfirm = await srv.req(`/api/agent/threads/${teenThreadId}/confirm`, {
      method: "POST",
      cookie: teenCookie,
      csrf: true,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirmationId: "00000000-0000-4000-8000-000000000001", decision: "confirm" }),
    });
    expect(fakeConfirm.status).toBe(403);

    // mobile_bound 配对设备访问 /api/agent/info 与 /api/agent/threads -> 403
    const pairCode = (
      await (
        await srv.req(`/api/profiles/${teenProfileId}/pairing-code`, {
          method: "POST",
          cookie: adminCookie,
          csrf: true,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        })
      ).json()
    ).code as string;
    const claimed = await (
      await srv.req("/api/auth/pair", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: pairCode, deviceName: "Mi 6" }),
      })
    ).json();
    expect(claimed.ok).toBe(true);
    expect((await srv.req("/api/agent/info", { token: claimed.token })).status).toBe(403);
    expect((await srv.req("/api/agent/threads", { token: claimed.token })).status).toBe(403);
  });

  it("同一工具连续 3 次校验失败自动触发熔断并引导网页可视表单，且支持中断与保留期清理", async () => {
    let abortedObserved = false;
    let mode: "circuit" | "abort" = "circuit";
    const { srv, cookie } = await setupAdmin({
      now: new Date("2026-11-02T03:00:00.000Z"),
      agentRuntimeFactory: () =>
        createMockRuntime(async function* (req) {
          if (mode === "circuit") {
            const saveMeal = req.tools.find((t) => t.name === "save_meal_plan")!;
            for (let i = 0; i < 4; i++) {
              if (req.signal.aborted) break;
              await saveMeal.execute({ title: "第1周", contentMd: "缺声明也没 household" });
            }
            abortedObserved = req.signal.aborted;
            yield { type: "done", finishReason: "stop", text: "" };
          } else {
            await new Promise<void>((resolve) => {
              if (req.signal.aborted) {
                abortedObserved = true;
                resolve();
                return;
              }
              req.signal.addEventListener(
                "abort",
                () => {
                  abortedObserved = true;
                  resolve();
                },
                { once: true },
              );
              setTimeout(resolve, 1000);
            });
          }
        }),
    });
    const manifest = srv.ctx.templates.current().manifest;
    const pRes = await srv.req("/api/profiles", {
      method: "POST",
      cookie,
      csrf: true,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profile: makeA18HomeProfile(manifest, "熔断测试") }),
    });
    const profileId = (await pRes.json()).id as string;

    const tRes = await srv.req("/api/agent/threads", {
      method: "POST",
      cookie,
      csrf: true,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profileId, skill: "meal-plan" }),
    });
    const threadId = (await tRes.json()).thread.id as string;

    // 1. 触发 3 次失败熔断
    const cbRes = await srv.req(`/api/agent/threads/${threadId}/messages`, {
      method: "POST",
      cookie,
      csrf: true,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "硬写菜单" }),
    });
    const events = await readSseEvents(cbRes);
    const cbEvent = events.find((e) => e.event === "circuit_breaker");
    expect(cbEvent).toBeTruthy();
    expect(cbEvent!.data.toolName).toBe("save_meal_plan");
    expect(cbEvent!.data.message).toContain("可视表单");
    expect(abortedObserved).toBe(true);

    // 2. 客户端主动 Abort 信号立即传播至上游 Runtime
    mode = "abort";
    abortedObserved = false;
    const clientAc = new AbortController();
    const abortPromise = srv.req(`/api/agent/threads/${threadId}/messages`, {
      method: "POST",
      cookie,
      csrf: true,
      signal: clientAc.signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "长耗时请求" }),
    });
    // 稍等让 streamSSE 启动后立即中止
    await new Promise((r) => setTimeout(r, 25));
    clientAc.abort();
    await abortPromise.catch(() => {});
    await new Promise((r) => setTimeout(r, 25));
    expect(abortedObserved).toBe(true);

    // 3. 保留期自动清理与一键删除对话
    const deletedOld = cleanupExpiredThreads(srv.ctx.getDb(), 7, new Date("2026-11-20T03:00:00.000Z"));
    expect(deletedOld).toBe(1);
    expect((await srv.req(`/api/agent/threads/${threadId}`, { cookie })).status).toBe(404);
  });
});

describe("阶段 3 复审回归：迁移保数据、长对话窗口、TOCTOU 乐观锁、防盲签与异常脱敏", () => {
  it("Migration 2 升级保留既有 agent_messages 不被级联清空，且外键检查通过", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON;");
    db.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );
    `);
    // 仅先执行 Migration 1，插入历史用户、档案、对话与消息
    db.exec(MIGRATIONS[0].sql);
    db.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (1, ?, ?)").run(
      MIGRATIONS[0].name,
      "2026-11-01T00:00:00.000Z",
    );
    db.prepare(
      "INSERT INTO users (id, username, role, password_hash, created_at) VALUES ('u1', 'admin', 'admin', 'scrypt$h', '2026-11-01T00:00:00.000Z')",
    ).run();
    db.prepare(
      `INSERT INTO profiles (id, code, owner_user_id, is_managed, timezone, profile_json, version, created_at, updated_at)
       VALUES ('p1', '甲', 'u1', 0, 'Asia/Shanghai', '{}', 1, '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z')`,
    ).run();
    db.prepare(
      "INSERT INTO agent_threads (id, user_id, profile_id, title, created_at, updated_at) VALUES ('t1', 'u1', 'p1', '历史对话', '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z')",
    ).run();
    db.prepare(
      "INSERT INTO agent_messages (id, thread_id, role, content_json, created_at) VALUES ('m1', 't1', 'user', '{\"text\":\"重要历史消息\"}', '2026-11-01T00:00:01.000Z')",
    ).run();

    // 跑 Migration 2：关闭外键迁移并校验，历史消息必须完好无损
    runMigrations(db);
    const msgs = db.prepare("SELECT id, content_json FROM agent_messages WHERE thread_id = 't1'").all() as {
      id: string;
      content_json: string;
    }[];
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content_json).toContain("重要历史消息");
    db.close();
  });

  it("长对话超过 50 条（含大量 tool 日志）仍保留最新用户输入；活跃旧对话遇 retentionDays 不崩流", async () => {
    let observedLastMessage = "";
    const { srv, cookie } = await setupAdmin({
      now: new Date("2026-11-02T03:00:00.000Z"),
      agentRuntimeFactory: () =>
        createMockRuntime(async function* (req) {
          observedLastMessage = req.messages[req.messages.length - 1]?.content ?? "";
          yield { type: "done", finishReason: "stop", text: "收到最新消息。" };
        }),
    });
    const tId = (
      await (
        await srv.req("/api/agent/threads", {
          method: "POST",
          cookie,
          csrf: true,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ skill: "general" }),
        })
      ).json()
    ).thread.id as string;

    // 写入 60 条旧 tool 日志 + 10 条旧对话，并将 updated_at 拨回 20 天前
    const db = srv.ctx.getDb();
    for (let i = 0; i < 60; i++) {
      appendMessage(db, {
        threadId: tId,
        role: i % 6 === 0 ? "user" : "tool",
        content: i % 6 === 0 ? { text: `历史提问-${i}` } : { toolName: "get_profile_state", ok: true },
        now: new Date(Date.parse("2026-10-10T00:00:00.000Z") + i * 1000),
      });
    }
    db.prepare("UPDATE agent_threads SET updated_at = '2026-10-10T00:00:00.000Z' WHERE id = ?").run(tId);
    // 开启 7 天保留期清理
    await srv.req("/api/admin/settings", {
      method: "PATCH",
      cookie,
      csrf: true,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items: [{ key: "agent.retentionDays", value: "7" }] }),
    });

    const r = await srv.req(`/api/agent/threads/${tId}/messages`, {
      method: "POST",
      cookie,
      csrf: true,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "这是第 61 条最新用户消息" }),
    });
    expect(r.status).toBe(200);
    const evs = await readSseEvents(r);
    expect(evs.some((e) => e.event === "done")).toBe(true);
    expect(observedLastMessage).toBe("这是第 61 条最新用户消息");
  });

  it("确认卡 TOCTOU 乐观锁、防盲签 preview、医生同意建档拦截、65+ 防跌倒确认卡、SDK tool-error 熔断与异常脱敏", async () => {
    let mode: "doctorCreate" | "toctou" | "seniorNoFall" | "sdkToolError" | "rawErrorLeak" = "doctorCreate";
    const results: Record<string, any> = {};
    const { srv, cookie } = await setupAdmin({
      now: new Date("2026-11-02T03:00:00.000Z"),
      agentRuntimeFactory: () =>
        createMockRuntime(async function* (req) {
          if (mode === "doctorCreate") {
            const create = req.tools.find((t) => t.name === "create_profile")!;
            results.docCreate = await create.execute({
              profile: makeA65Profile(srv.ctx.templates.current().manifest, "长辈甲"),
            });
            yield { type: "done", finishReason: "stop", text: "请确认 65+ 医生同意建档。" };
          } else if (mode === "toctou") {
            const upScreen = req.tools.find((t) => t.name === "update_screening_and_doctor")!;
            results.card = await upScreen.execute({ cardioClear: [{ date: "2026-11-02" }] });
            yield { type: "done", finishReason: "stop", text: "请确认更新有氧医生同意。" };
          } else if (mode === "seniorNoFall") {
            const pub = req.tools.find((t) => t.name === "publish_course")!;
            results.seniorPub = await pub.execute({ week: 1, day: "A", confirmedNoFall: true });
            yield { type: "done", finishReason: "stop", text: "请本人确认近期无摔倒。" };
          } else if (mode === "sdkToolError") {
            for (let i = 0; i < 3; i++) {
              if (req.signal.aborted) break;
              yield {
                type: "tool_result",
                toolCallId: `tc-${i}`,
                toolName: "publish_course",
                result: { ok: false, code: "SDK_TOOL_ARGS_ERROR", message: "参数不合法" },
              };
            }
          } else if (mode === "rawErrorLeak") {
            throw new Error("Incorrect API key provided: secret-token-xyz at http://192.168.88.9:11434/v1");
          }
        }),
    });
    const manifest = srv.ctx.templates.current().manifest;

    // 1. 建档含 doctorCleared: true 必须强制落确认卡（含防盲签 preview）
    const tDocId = (
      await (
        await srv.req("/api/agent/threads", {
          method: "POST",
          cookie,
          csrf: true,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ skill: "onboard" }),
        })
      ).json()
    ).thread.id as string;

    const rDoc = await srv.req(`/api/agent/threads/${tDocId}/messages`, {
      method: "POST",
      cookie,
      csrf: true,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "给 65 岁长辈建档（医生已同意）" }),
    });
    const evDoc = await readSseEvents(rDoc);
    const docConfirmEv = evDoc.find((e) => e.event === "confirmation_required");
    expect(docConfirmEv).toBeTruthy();
    expect(docConfirmEv!.data.preview.screening.doctorCleared).toBe(true);
    expect(results.docCreate.pendingConfirmation).toBe(true);

    // 确认前未落库；确认后落库并绑定到 tDocId
    const confirmDoc = await srv.req(`/api/agent/threads/${tDocId}/confirm`, {
      method: "POST",
      cookie,
      csrf: true,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirmationId: results.docCreate.confirmationId, decision: "confirm" }),
    });
    expect(confirmDoc.status).toBe(200);
    const seniorPid = (await confirmDoc.json()).result.data.profileId as string;

    // 2. 65+ 传 confirmedNoFall: true 必须强制落确认卡，防模型代确认
    mode = "seniorNoFall";
    const rNoFall = await srv.req(`/api/agent/threads/${tDocId}/messages`, {
      method: "POST",
      cookie,
      csrf: true,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "发布本周课程" }),
    });
    const evNoFall = await readSseEvents(rNoFall);
    expect(evNoFall.find((e) => e.event === "confirmation_required")?.data.preview.confirmedNoFall).toBe(true);

    // 3. TOCTOU 乐观锁：暂存确认卡后，网页端先修改档案（version++），再确认旧卡片必返 409 VERSION_CONFLICT
    const pA18 = (
      await (
        await srv.req("/api/profiles", {
          method: "POST",
          cookie,
          csrf: true,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ profile: makeA18HomeProfile(manifest, "并发甲") }),
        })
      ).json()
    ).id as string;
    const tToctou = (
      await (
        await srv.req("/api/agent/threads", {
          method: "POST",
          cookie,
          csrf: true,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ profileId: pA18, skill: "general" }),
        })
      ).json()
    ).thread.id as string;

    mode = "toctou";
    await readSseEvents(
      await srv.req(`/api/agent/threads/${tToctou}/messages`, {
        method: "POST",
        cookie,
        csrf: true,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "更新有氧医生同意" }),
      }),
    );
    expect(results.card.pendingConfirmation).toBe(true);
    expect(results.card.preview.cardioClear).toEqual([{ date: "2026-11-02" }]);

    // 网页端先推进档案版本
    const webPatch = await srv.req(`/api/profiles/${pA18}`, {
      method: "PATCH",
      cookie,
      csrf: true,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ patch: { wake: "06:45" } }),
    });
    expect(webPatch.status).toBe(200);

    // 此时确认旧卡片必返 409 VERSION_CONFLICT 且不会覆盖网页端修改
    const staleConfirm = await srv.req(`/api/agent/threads/${tToctou}/confirm`, {
      method: "POST",
      cookie,
      csrf: true,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirmationId: results.card.confirmationId, decision: "confirm" }),
    });
    expect(staleConfirm.status).toBe(409);
    expect((await staleConfirm.json()).code).toBe("VERSION_CONFLICT");

    // 4. SDK tool-error（绕过 execute）连续 3 次同样触发熔断
    mode = "sdkToolError";
    const evSdkCb = await readSseEvents(
      await srv.req(`/api/agent/threads/${tToctou}/messages`, {
        method: "POST",
        cookie,
        csrf: true,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "测试 SDK tool-error 熔断" }),
      }),
    );
    expect(evSdkCb.some((e) => e.event === "circuit_breaker")).toBe(true);

    // 5. 上游异常脱敏：绝不泄露原始凭据片段或私网 IP
    mode = "rawErrorLeak";
    const evErr = await readSseEvents(
      await srv.req(`/api/agent/threads/${tToctou}/messages`, {
        method: "POST",
        cookie,
        csrf: true,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "触发上游异常" }),
      }),
    );
    const errEvent = evErr.find((e) => e.event === "error");
    expect(errEvent).toBeTruthy();
    expect(JSON.stringify(errEvent)).not.toContain("secret-token-xyz");
    expect(JSON.stringify(errEvent)).not.toContain("192.168.88.9");
    expect(seniorPid).toBeTruthy();
  });
});
