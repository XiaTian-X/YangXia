import { afterEach, describe, expect, it } from "vitest";
import { ASSESS_FORMAT, DECLARATION, SESSION_FORMAT } from "@yangxia/course-core";
import {
  createTestServer,
  extractSessionCookie,
  makeA13Profile,
  makeA18HomeProfile,
  type TestServerHandle,
  TEST_SETUP_CODE,
} from "./helpers.ts";

let srv: TestServerHandle | null = null;
afterEach(() => {
  srv?.cleanup();
  srv = null;
});

async function initAdmin(s: TestServerHandle) {
  const res = await s.req("/api/setup/init", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "AdminPassword123", setupCode: TEST_SETUP_CODE }),
  });
  expect(res.status).toBe(201);
  return { cookie: extractSessionCookie(res), body: await res.json() };
}

describe("认证、安全加固与四类角色严格白名单", () => {
  it("初始化、Cookie CSRF 防护、受信任反代 Secure 判定与限速退避", async () => {
    srv = await createTestServer({ trustedProxies: "10.0.0.1" });

    // 健康检查不登录只回 ok：不透露是否初始化、模板版本和哈希
    const h0 = await (await srv.req("/api/health")).json();
    expect(h0).toEqual({ ok: true });
    expect(await (await srv.req("/api/setup/status")).json()).toEqual({ needsSetup: true });

    // 没带初始化口令、口令不对：一律拒绝（不再"谁先访问谁当管理员"）
    for (const setupCode of [undefined, "WRONG-CODE-0000"]) {
      const bad = await srv.req("/api/setup/init", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "intruder", password: "AdminPassword123", ...(setupCode ? { setupCode } : {}) }),
      });
      expect(bad.status).toBe(403);
    }
    // 口令大小写、空格、短横线不敏感
    expect(srv.ctx.setupCode.matches(" test setu pcod ")).toBe(true);

    // 首次初始化 + 禁止重复初始化（口令用过就失效）
    const { cookie } = await initAdmin(srv);
    expect(srv.ctx.setupCode.current()).toBeNull();
    expect(await (await srv.req("/api/setup/status")).json()).toEqual({ needsSetup: false });
    const dupInit = await srv.req("/api/setup/init", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "admin2", password: "AdminPassword123", setupCode: TEST_SETUP_CODE }),
    });
    expect(dupInit.status).toBe(409);

    // Cookie 写接口无 CSRF 头必被 403 拦截
    const noCsrf = await srv.req("/api/auth/refresh", {
      method: "POST",
      cookie,
      origin: "http://localhost",
    });
    expect(noCsrf.status).toBe(403);
    expect((await noCsrf.json()).code).toBe("CSRF_REJECTED");

    // 跨站 Origin 必被 403 拦截
    const evilOrigin = await srv.req("/api/auth/refresh", {
      method: "POST",
      cookie,
      csrf: true,
      origin: "http://evil.nas.local",
    });
    expect(evilOrigin.status).toBe(403);

    // 同源 + X-YangXia-CSRF: 1 放行滑动续期，同步刷新 Set-Cookie 且不突破绝对上限
    const okRefresh = await srv.req("/api/auth/refresh", {
      method: "POST",
      cookie,
      csrf: true,
      origin: "http://localhost",
    });
    expect(okRefresh.status).toBe(200);
    expect(okRefresh.headers.get("set-cookie") ?? "").toContain("yx_session=");
    const refBody = await okRefresh.json();
    expect(Date.parse(refBody.expiresAt)).toBeLessThanOrEqual(Date.parse(refBody.absoluteExpiresAt));

    // 公开写接口拒绝 text/plain 简单请求 CSRF
    const textPlainLogin = await srv.req("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: JSON.stringify({ username: "admin", password: "AdminPassword123" }),
    });
    expect(textPlainLogin.status).toBe(415);

    // 经受信任反代时，同时伪造最左侧 X-Forwarded-For 与轮换不同用户名，仍不可绕过按真实客户端 IP（最右侧非反代 IP）限速
    for (let i = 0; i < 5; i++) {
      const r = await srv.req("/api/auth/login", {
        method: "POST",
        remoteIp: "10.0.0.1",
        headers: {
          "Content-Type": "application/json",
          "X-Forwarded-For": `198.51.100.${i + 1}, 203.0.113.9`,
        },
        body: JSON.stringify({ username: `ghost${i}`, password: "WrongPassword99", kind: "mobile_account" }),
      });
      expect(r.status).toBe(401);
    }
    const spoofedXffBlocked = await srv.req("/api/auth/login", {
      method: "POST",
      remoteIp: "10.0.0.1",
      headers: {
        "Content-Type": "application/json",
        "X-Forwarded-For": "198.51.100.99, 203.0.113.9",
      },
      body: JSON.stringify({ username: "admin", password: "AdminPassword123", kind: "mobile_account" }),
    });
    expect(spoofedXffBlocked.status).toBe(429);

    // 受信任反代才采信 X-Forwarded-Proto: https 设置 Secure Cookie
    const spoofHttps = await srv.req("/api/auth/login", {
      method: "POST",
      remoteIp: "192.168.1.99",
      headers: { "Content-Type": "application/json", "X-Forwarded-Proto": "https" },
      body: JSON.stringify({ username: "admin", password: "AdminPassword123", kind: "web" }),
    });
    expect(spoofHttps.status).toBe(200);
    expect(spoofHttps.headers.get("set-cookie") ?? "").not.toContain("Secure");

    const trustedHttps = await srv.req("/api/auth/login", {
      method: "POST",
      remoteIp: "10.0.0.1",
      headers: { "Content-Type": "application/json", "X-Forwarded-Proto": "https" },
      body: JSON.stringify({ username: "admin", password: "AdminPassword123", kind: "web" }),
    });
    expect(trustedHttps.status).toBe(200);
    expect(trustedHttps.headers.get("set-cookie") ?? "").toContain("Secure");

    // 连续 5 次错误密码触发递增退避限速（第 6 次直接 429）
    for (let i = 0; i < 5; i++) {
      const r = await srv.req("/api/auth/login", {
        method: "POST",
        remoteIp: "192.168.1.50",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "admin", password: "WrongPassword99", kind: "mobile_account" }),
      });
      expect(r.status).toBe(401);
    }
    const limited = await srv.req("/api/auth/login", {
      method: "POST",
      remoteIp: "192.168.1.50",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "AdminPassword123", kind: "mobile_account" }),
    });
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
  });

  it("独立成年人严格隔离（管理员亦不可查看/修改）与代号冲突防探测", async () => {
    srv = await createTestServer();
    const { cookie: adminCookie } = await initAdmin(srv);
    const manifest = srv.ctx.templates.current().manifest;

    // 管理员创建成员账号 alice
    const uRes = await srv.req("/api/admin/users", {
      method: "POST",
      cookie: adminCookie,
      csrf: true,
      origin: "http://localhost",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "alice", password: "AlicePassword123", role: "member" }),
    });
    expect(uRes.status).toBe(201);
    const aliceId = (await uRes.json()).user.id;

    // alice 手机/Token 登录
    const aliceLogin = await (
      await srv.req("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "alice", password: "AlicePassword123", kind: "mobile_account" }),
      })
    ).json();
    const aliceToken = aliceLogin.token as string;

    // alice 创建自己的独立档案
    const pRes = await srv.req("/api/profiles", {
      method: "POST",
      token: aliceToken,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        profile: makeA18HomeProfile(manifest, "爱丽丝"),
        initialAssessment: {
          schema: ASSESS_FORMAT,
          date: "2026-11-02",
          kind: "入门",
          base: 0,
          tests: [{ id: "pushup-test", level: 2, value: 8 }],
          conclusion: {},
        },
      }),
    });
    expect(pRes.status).toBe(201);
    const aliceProfileId = (await pRes.json()).id as string;

    // 管理员在档案列表中看不到 alice 的独立档案，直接按 ID 访问也被 403 拦下
    const adminList = await (await srv.req("/api/profiles", { cookie: adminCookie })).json();
    expect(adminList.profiles.some((p: any) => p.id === aliceProfileId)).toBe(false);
    expect((await srv.req(`/api/profiles/${aliceProfileId}`, { cookie: adminCookie })).status).toBe(403);
    expect(
      (
        await srv.req(`/api/profiles/${aliceProfileId}`, {
          method: "PATCH",
          cookie: adminCookie,
          csrf: true,
          origin: "http://localhost",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ patch: { wake: "07:00" } }),
        })
      ).status,
    ).toBe(403);

    // 管理员用相同代号建档返回通用冲突提示，不泄露归属人
    const dupCode = await srv.req("/api/profiles", {
      method: "POST",
      cookie: adminCookie,
      csrf: true,
      origin: "http://localhost",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profile: makeA18HomeProfile(manifest, "爱丽丝") }),
    });
    expect(dupCode.status).toBe(409);
    const dupBody = await dupCode.json();
    expect(dupBody.code).toBe("PROFILE_CODE_CONFLICT");
    expect(dupBody.message).not.toContain("alice");

    // 管理员重置 alice 密码后，alice 旧 Token 立即失效
    const resetRes = await srv.req(`/api/admin/users/${aliceId}/reset-password`, {
      method: "POST",
      cookie: adminCookie,
      csrf: true,
      origin: "http://localhost",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "NewAlicePassword99" }),
    });
    expect(resetRes.status).toBe(200);
    expect((await srv.req("/api/auth/me", { token: aliceToken })).status).toBe(401);
  });

  it("13–17 岁可登录账号严格白名单：仅允许只读课/计划单/模板、交练习记录与改允许的 playback", async () => {
    srv = await createTestServer();
    const { cookie: adminCookie } = await initAdmin(srv);
    const manifest = srv.ctx.templates.current().manifest;

    const teenUserRes = await (
      await srv.req("/api/admin/users", {
        method: "POST",
        cookie: adminCookie,
        csrf: true,
        origin: "http://localhost",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "xiaoming", password: "TeenPassword123", role: "member" }),
      })
    ).json();
    const teenUserId = teenUserRes.user.id as string;

    // 管理员为 13–17 岁建立代管档案并关联 teenUserId
    const pRes = await srv.req("/api/profiles", {
      method: "POST",
      cookie: adminCookie,
      csrf: true,
      origin: "http://localhost",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        isManaged: true,
        memberUserId: teenUserId,
        profile: makeA13Profile(manifest, "小明"),
        initialAssessment: {
          schema: ASSESS_FORMAT,
          date: "2026-11-02",
          kind: "入门",
          base: 0,
          tests: [],
          conclusion: {},
        },
      }),
    });
    expect(pRes.status).toBe(201);
    const teenProfileId = (await pRes.json()).id as string;

    // 管理员生成计划单并发布一节课
    const sheetRes = await srv.req(`/api/profiles/${teenProfileId}/plan-sheet`, {
      method: "POST",
      cookie: adminCookie,
      csrf: true,
      origin: "http://localhost",
    });
    expect(sheetRes.status).toBe(201);
    const pubRes = await srv.req(`/api/profiles/${teenProfileId}/courses/publish`, {
      method: "POST",
      cookie: adminCookie,
      csrf: true,
      origin: "http://localhost",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ week: 1, day: "A" }),
    });
    expect(pubRes.status).toBe(201);
    const pubBody = await pubRes.json();

    // 青少年登录
    const teenLogin = await (
      await srv.req("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "xiaoming", password: "TeenPassword123", kind: "mobile_account" }),
      })
    ).json();
    const teenToken = teenLogin.token as string;

    // 白名单内允许的操作：看本人基本信息、看计划单、看模板、拉今日课程、改 playback、提交练习记录
    const me = await (await srv.req("/api/auth/me", { token: teenToken })).json();
    expect(me.isTeen).toBe(true);
    const detail = await (await srv.req(`/api/profiles/${teenProfileId}`, { token: teenToken })).json();
    expect(detail.canManage).toBe(false);
    expect((await srv.req(`/api/profiles/${teenProfileId}/documents`, { token: teenToken })).status).toBe(200);
    expect((await srv.req("/api/templates/meta", { token: teenToken })).status).toBe(200);
    expect((await srv.req(`/api/mobile/today?profileId=${teenProfileId}`, { token: teenToken })).status).toBe(200);
    expect(
      (
        await srv.req("/api/mobile/playback", {
          method: "PATCH",
          token: teenToken,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ profileId: teenProfileId, playback: { countTiming: "on-rep" } }),
        })
      ).status,
    ).toBe(200);
    const sessRes = await srv.req("/api/mobile/sessions", {
      method: "POST",
      token: teenToken,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        profileId: teenProfileId,
        courseRecordId: pubBody.id,
        courseSnapshotHash: pubBody.snapshotHash,
        session: {
          schema: SESSION_FORMAT,
          course: { id: pubBody.envelope.course.id, name: pubBody.envelope.course.name, source: pubBody.envelope.course.source },
          startedAt: "2026-11-02T02:00:00.000Z",
          endedAt: "2026-11-02T02:20:00.000Z",
          items: [{ exercise: pubBody.envelope.course.blocks[0].items[0].exercise, setsPlanned: 2, setsDone: 2 }],
          feeling: "正好",
          symptoms: { pain: false, dizzy: false, chest: false },
        },
      }),
    });
    expect(sessRes.status).toBe(201);

    // 白名单外一律 403 拦截：改档案主体、自建独立档案、排课发布、提交复盘、提交评估、发扫码码、写菜单
    expect(
      (
        await srv.req(`/api/profiles/${teenProfileId}`, {
          method: "PATCH",
          token: teenToken,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ patch: { age: "a18" } }),
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await srv.req("/api/profiles", {
          method: "POST",
          token: teenToken,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ profile: makeA18HomeProfile(manifest, "越权自建") }),
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await srv.req(`/api/profiles/${teenProfileId}/courses/publish`, {
          method: "POST",
          token: teenToken,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ week: 1, day: "A" }),
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await srv.req(`/api/profiles/${teenProfileId}/reviews`, {
          method: "POST",
          token: teenToken,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ startDate: "2026-11-02", week: 1, reviewJson: {}, reviewMd: DECLARATION }),
        })
      ).status,
    ).toBe(403);
    expect((await srv.req(`/api/profiles/${teenProfileId}/pairing-code`, { method: "POST", token: teenToken })).status).toBe(403);
  });

  it("128-bit 5 分钟一次性扫码绑定（mobile_bound）严格路由白名单、过期失效与一键吊销", async () => {
    srv = await createTestServer();
    const { cookie: adminCookie } = await initAdmin(srv);
    const manifest = srv.ctx.templates.current().manifest;

    const p1 = await (
      await srv.req("/api/profiles", {
        method: "POST",
        cookie: adminCookie,
        csrf: true,
        origin: "http://localhost",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ profile: makeA18HomeProfile(manifest, "档案一") }),
      })
    ).json();
    const p2 = await (
      await srv.req("/api/profiles", {
        method: "POST",
        cookie: adminCookie,
        csrf: true,
        origin: "http://localhost",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isManaged: true, profile: makeA18HomeProfile(manifest, "档案二") }),
      })
    ).json();

    // 生成一个 5 分钟过期扫码码并测过期失效
    const expCodeRes = await (
      await srv.req(`/api/profiles/${p2.id}/pairing-code`, {
        method: "POST",
        cookie: adminCookie,
        csrf: true,
        origin: "http://localhost",
      })
    ).json();
    expect(expCodeRes.code).toMatch(/^[0-9a-f]{32}$/);
    srv.setNow(new Date(srv.getNow().getTime() + 6 * 60_000));
    expect(
      (
        await srv.req("/api/auth/pair", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code: expCodeRes.code }),
        })
      ).status,
    ).toBe(401);

    // 重新生成并在有效期内兑换（仅可兑换一次）
    const okCodeRes = await (
      await srv.req(`/api/profiles/${p2.id}/pairing-code`, {
        method: "POST",
        cookie: adminCookie,
        csrf: true,
        origin: "http://localhost",
      })
    ).json();
    const pairRes = await srv.req("/api/auth/pair", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: okCodeRes.code, deviceName: "Mi 6 老人机" }),
    });
    expect(pairRes.status).toBe(201);
    const pairBody = await pairRes.json();
    const boundToken = pairBody.token as string;
    expect(pairBody.profileId).toBe(p2.id);

    // 二次使用同一绑定码必拒
    expect(
      (
        await srv.req("/api/auth/pair", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code: okCodeRes.code }),
        })
      ).status,
    ).toBe(401);

    // mobile_bound 仅可见绑定档案 p2，禁止越权访问 p1 或任何 Web/Admin 端点
    const mobProfiles = await (await srv.req("/api/mobile/profiles", { token: boundToken })).json();
    expect(mobProfiles.profiles).toHaveLength(1);
    expect(mobProfiles.profiles[0].id).toBe(p2.id);
    expect((await srv.req(`/api/mobile/today?profileId=${p2.id}`, { token: boundToken })).status).toBe(200);
    expect((await srv.req(`/api/mobile/today?profileId=${p1.id}`, { token: boundToken })).status).toBe(403);
    expect((await srv.req("/api/profiles", { token: boundToken })).status).toBe(403);
    expect((await srv.req("/api/templates/meta", { token: boundToken })).status).toBe(403);
    expect((await srv.req("/api/auth/devices", { token: boundToken })).status).toBe(403);

    // 管理员在设备列表中可一键吊销该绑定设备
    const devList = await (await srv.req("/api/auth/devices", { cookie: adminCookie })).json();
    const targetDev = devList.devices.find((d: any) => d.id === pairBody.sessionId);
    expect(targetDev).toBeTruthy();
    const revRes = await srv.req(`/api/auth/devices/${pairBody.sessionId}`, {
      method: "DELETE",
      cookie: adminCookie,
      csrf: true,
      origin: "http://localhost",
    });
    expect(revRes.status).toBe(200);
    expect((await srv.req("/api/mobile/profiles", { token: boundToken })).status).toBe(401);
  });
});
