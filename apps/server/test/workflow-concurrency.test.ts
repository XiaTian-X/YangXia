import { afterEach, describe, expect, it } from "vitest";
import { ASSESS_FORMAT, DECLARATION, REVIEW_FORMAT, SESSION_FORMAT } from "@yangxia/course-core";
import {
  createTestServer,
  extractSessionCookie,
  makeA06Profile,
  makeA18HomeProfile,
  makeA65Profile,
  type TestServerHandle,
} from "./helpers.ts";

let srv: TestServerHandle | null = null;
afterEach(() => {
  srv?.cleanup();
  srv = null;
});

async function setupAdmin(s: TestServerHandle) {
  const res = await s.req("/api/setup/init", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "AdminPassword123" }),
  });
  expect(res.status).toBe(201);
  return extractSessionCookie(res);
}

describe("核心业务闭环、并发乐观锁、迟到不适冲突、旧课作废、UTC 跨日与脱敏审计", () => {
  it("排课发布交付信封、增量动图、预计算回退、乐观锁冲突、65+ 未摔倒确认与 6–12 岁移动端提示", async () => {
    srv = await createTestServer({ now: new Date("2026-11-02T03:00:00.000Z") });
    const cookie = await setupAdmin(srv);
    const manifest = srv.ctx.templates.current().manifest;

    const pRes = await (
      await srv.req("/api/profiles", {
        method: "POST",
        cookie,
        csrf: true,
        origin: "http://localhost",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          profile: makeA18HomeProfile(manifest, "排课甲"),
          initialAssessment: {
            schema: ASSESS_FORMAT,
            date: "2026-11-02",
            kind: "入门",
            base: 0,
            tests: [{ id: "pushup-test", level: 2, value: 8 }],
            conclusion: {},
          },
        }),
      })
    ).json();
    const pid = pRes.id as string;

    // 生成计划单 + 发布第 1 周 A 日课程
    const sheetRes = await srv.req(`/api/profiles/${pid}/plan-sheet`, {
      method: "POST",
      cookie,
      csrf: true,
      origin: "http://localhost",
    });
    expect(sheetRes.status).toBe(201);
    const sheetBody = await sheetRes.json();
    expect(sheetBody.contentMd).toContain("未经专业审核");

    // 乐观锁测试：带过期 expectedVersion=1 更新必返 409 VERSION_CONFLICT
    const conflictPatch = await srv.req(`/api/profiles/${pid}`, {
      method: "PATCH",
      cookie,
      csrf: true,
      origin: "http://localhost",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expectedVersion: 1, patch: { wake: "06:30", bedtime: "22:10" } }),
    });
    expect(conflictPatch.status).toBe(409);
    expect((await conflictPatch.json()).code).toBe("VERSION_CONFLICT");

    // 发布课程
    const pubRes = await srv.req(`/api/profiles/${pid}/courses/publish`, {
      method: "POST",
      cookie,
      csrf: true,
      origin: "http://localhost",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ week: 1, day: "A" }),
    });
    expect(pubRes.status).toBe(201);
    const pubBody = await pubRes.json();
    expect(pubBody.envelope.schema).toBe("yangxia.delivery/1");
    expect(pubBody.envelope.declaration).toBe(DECLARATION);

    // 移动端拉取今日课程 + withTimeline=1 服务端预计算回退
    const today = await (await srv.req(`/api/mobile/today?profileId=${pid}`, { cookie })).json();
    expect(today.supported).toBe(true);
    expect(today.activeCourses).toHaveLength(1);
    const withTl = await (await srv.req(`/api/mobile/courses/${pubBody.id}?withTimeline=1`, { cookie })).json();
    expect(withTl.precomputedPlan.timeline.events.length).toBeGreaterThan(0);

    // 动图增量拉取：第一次返回 clip，第二次带 knownHashes 返回 unchanged
    const motionIds = Object.keys(pubBody.envelope.motionHashes);
    if (motionIds.length > 0) {
      const m1 = await (
        await srv.req("/api/mobile/motions/batch", {
          method: "POST",
          cookie,
          csrf: true,
          origin: "http://localhost",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ids: motionIds }),
        })
      ).json();
      expect(Object.keys(m1.clips)).toEqual(expect.arrayContaining(motionIds));
      const m2 = await (
        await srv.req("/api/mobile/motions/batch", {
          method: "POST",
          cookie,
          csrf: true,
          origin: "http://localhost",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ids: motionIds, knownHashes: pubBody.envelope.motionHashes }),
        })
      ).json();
      expect(Object.keys(m2.clips)).toHaveLength(0);
      expect(m2.unchanged).toEqual(expect.arrayContaining(motionIds));
    }

    // 65+ 档案发布前未确认未摔倒必拦下，确认后放行
    const p65 = await (
      await srv.req("/api/profiles", {
        method: "POST",
        cookie,
        csrf: true,
        origin: "http://localhost",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          isManaged: true,
          profile: makeA65Profile(manifest, "长辈甲"),
          initialAssessment: {
            schema: ASSESS_FORMAT,
            date: "2026-11-02",
            kind: "入门",
            companion: true,
            doctorCleared: true,
            doctorDate: "2026-11-02",
            tests: [{ id: "chair-stand-30s", value: 10, hands: "扶椅子", done: true }],
            conclusion: {},
          },
        }),
      })
    ).json();
    const block65 = await srv.req(`/api/profiles/${p65.id}/courses/publish`, {
      method: "POST",
      cookie,
      csrf: true,
      origin: "http://localhost",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ week: 1, day: "A" }),
    });
    expect(block65.status).toBe(400);
    expect((await block65.json()).code).toBe("CONFIRM_NO_FALL_REQUIRED");
    const ok65 = await srv.req(`/api/profiles/${p65.id}/courses/publish`, {
      method: "POST",
      cookie,
      csrf: true,
      origin: "http://localhost",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ week: 1, day: "A", confirmedNoFall: true }),
    });
    expect(ok65.status).toBe(201);

    // 6–12 岁家长版在移动端明确返回 supported: false
    const p06 = await (
      await srv.req("/api/profiles", {
        method: "POST",
        cookie,
        csrf: true,
        origin: "http://localhost",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isManaged: true, profile: makeA06Profile(manifest, "小孩甲") }),
      })
    ).json();
    const today06 = await (await srv.req(`/api/mobile/today?profileId=${p06.id}`, { cookie })).json();
    expect(today06.supported).toBe(false);
    expect(today06.message).toContain("6–12 岁家长版");
  });

  it("UTC 跨日、CLOCK_SKEW_FUTURE、幂等与不可抹除不适、复盘后迟到不适反拦排课、模板重载作废与脱敏审计", async () => {
    // 模拟 UTC 服务器在 2026-11-01T17:00:00Z 运行（北京时间 2026-11-02 01:00）
    srv = await createTestServer({
      now: new Date("2026-11-01T17:00:00.000Z"),
      customReloadLoader: async () => {
        const cur = srv!.ctx.templates.current();
        // 模拟重载后模板版本变化且 plans 移除一项或触发检查差异：将 18-39岁-居家版 改为无该成品触发 checkCourse 报错
        return {
          ...cur,
          version: "v9.9.9-test",
          templateHash: "reloaded-hash-999",
          plans: { ...cur.plans!, version: "v9.9.9-test", products: {} },
        };
      },
    });
    const cookie = await setupAdmin(srv);
    const manifest = srv.ctx.templates.current().manifest;

    const pRes = await (
      await srv.req("/api/profiles", {
        method: "POST",
        cookie,
        csrf: true,
        origin: "http://localhost",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          profile: makeA18HomeProfile(manifest, "跨日甲", {
            body: "记",
            bodyLog: [{ date: "2026-11-02", body: "记" }],
          }),
          initialAssessment: {
            schema: ASSESS_FORMAT,
            date: "2026-11-02",
            kind: "入门",
            base: 0,
            body: { height: 175, weight: 72.5, waist: 88 },
            tests: [{ id: "pushup-test", level: 2, value: 8 }],
            conclusion: {},
          },
        }),
      })
    ).json();
    const pid = pRes.id as string;

    const pubA = await (
      await srv.req(`/api/profiles/${pid}/courses/publish`, {
        method: "POST",
        cookie,
        csrf: true,
        origin: "http://localhost",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ week: 1, day: "A" }),
      })
    ).json();
    const pubB = await (
      await srv.req(`/api/profiles/${pid}/courses/publish`, {
        method: "POST",
        cookie,
        csrf: true,
        origin: "http://localhost",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ week: 1, day: "B" }),
      })
    ).json();

    const makeSess = (pub: any, patch: Record<string, any> = {}) => ({
      schema: SESSION_FORMAT,
      course: { id: pub.envelope.course.id, name: pub.envelope.course.name, source: pub.envelope.course.source },
      startedAt: "2026-11-01T16:30:00.000Z", // 北京时间 2026-11-02 00:30
      endedAt: "2026-11-01T16:50:00.000Z",
      items: [{ exercise: pub.envelope.course.blocks[0].items[0].exercise, setsPlanned: 2, setsDone: 2 }],
      feeling: "正好",
      symptoms: { pain: false, dizzy: false, chest: false },
      note: "体重72.5kg感觉还行",
      ...patch,
    });

    // 1. 未来超 5 分钟 → 422 CLOCK_SKEW_FUTURE + serverNow
    const futureRes = await srv.req("/api/mobile/sessions", {
      method: "POST",
      cookie,
      csrf: true,
      origin: "http://localhost",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        profileId: pid,
        session: makeSess(pubA, { startedAt: "2026-11-01T17:15:00.000Z", endedAt: "2026-11-01T17:30:00.000Z" }),
      }),
    });
    expect(futureRes.status).toBe(422);
    const futureBody = await futureRes.json();
    expect(futureBody.code).toBe("CLOCK_SKEW_FUTURE");
    expect(futureBody.serverNow).toBe("2026-11-01T17:00:00.000Z");

    // 2. 北京时间凌晨 00:30 正常入库 + 幂等重复提交返回 duplicate
    const s1Res = await srv.req("/api/mobile/sessions", {
      method: "POST",
      cookie,
      csrf: true,
      origin: "http://localhost",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        profileId: pid,
        idempotencyKey: "idem-001",
        courseRecordId: pubA.id,
        courseSnapshotHash: pubA.snapshotHash,
        session: makeSess(pubA),
      }),
    });
    expect(s1Res.status).toBe(201);
    const s1Body = await s1Res.json();
    expect(s1Body.legacyPath).toBe("打卡/养夏_练习记录_2026-11-02_0030.json");

    const s1Dup = await srv.req("/api/mobile/sessions", {
      method: "POST",
      cookie,
      csrf: true,
      origin: "http://localhost",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        profileId: pid,
        idempotencyKey: "idem-001",
        courseRecordId: pubA.id,
        courseSnapshotHash: pubA.snapshotHash,
        session: makeSess(pubA),
      }),
    });
    expect(s1Dup.status).toBe(200);
    expect((await s1Dup.json()).status).toBe("duplicate");

    // 3. 周中滑动续期后，推进到第 1 周末并提交无不适周复盘（同时推进第 2 周）
    srv.setNow(new Date("2026-11-05T02:00:00.000Z"));
    expect((await srv.req("/api/auth/refresh", { method: "POST", cookie, csrf: true, origin: "http://localhost" })).status).toBe(200);
    srv.setNow(new Date("2026-11-09T02:00:00.000Z"));
    const rev1 = await srv.req(`/api/profiles/${pid}/reviews`, {
      method: "POST",
      cookie,
      csrf: true,
      origin: "http://localhost",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        startDate: "2026-11-02",
        week: 1,
        reviewJson: {
          schema: REVIEW_FORMAT,
          start: "2026-11-02",
          week: 1,
          trainings: 1,
          symptoms: false,
          habits: { 散步: 5, 冥想: 5 },
          moves: [],
        },
        reviewMd: `${DECLARATION}\n\n第 1 周完成 1 次训练，无不适，下周继续。`,
        nextSegmentEntry: { n: 1, type: "标准", week: 2, start: "2026-11-09", product: "18-39岁-居家版" },
      }),
    });
    expect(rev1.status).toBe(201);
    const rev1Body = await rev1.json();
    // 推进第 2 周自动作废第 1 周活跃课程
    expect(rev1Body.invalidatedCourses.length).toBeGreaterThanOrEqual(2);

    // 发布第 2 周 A 日课程
    const pubW2 = await (
      await srv.req(`/api/profiles/${pid}/courses/publish`, {
        method: "POST",
        cookie,
        csrf: true,
        origin: "http://localhost",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ week: 2, day: "A" }),
      })
    ).json();

    // 4. 迟到的第 1 周离线练习记录（带疼痛 pain: true）回传：绝不丢弃、标注 staleCourse、作废第 2 周活跃课、置 hasConflict=1 并阻断后续排课！
    const lateHurt = await srv.req("/api/mobile/sessions", {
      method: "POST",
      cookie,
      csrf: true,
      origin: "http://localhost",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        profileId: pid,
        courseRecordId: pubB.id,
        courseSnapshotHash: pubB.snapshotHash,
        session: makeSess(pubB, {
          startedAt: "2026-11-04T02:00:00.000Z",
          endedAt: "2026-11-04T02:20:00.000Z",
          symptoms: { pain: true, dizzy: false, chest: false },
        }),
      }),
    });
    expect(lateHurt.status).toBe(201);
    const lateBody = await lateHurt.json();
    expect(lateBody.staleCourse).toBe(true);
    expect(lateBody.hasConflict).toBe(true);
    // 迟到不适记录必须强制作废已发布的第 2 周活跃课，移动端立刻看不到旧活跃课
    expect(lateBody.invalidatedCourses.length).toBeGreaterThanOrEqual(1);
    const afterLateToday = await (await srv.req(`/api/mobile/today?profileId=${pid}`, { cookie })).json();
    expect(afterLateToday.activeCourses).toHaveLength(0);
    expect(afterLateToday.invalidatedCourses.some((c: any) => c.id === pubW2.id)).toBe(true);

    // 尝试 --replace 用等价时间戳（不带 .000）抹除 pain: true → 仍精准命中旧记录并被 422 拒收（不误报 404）
    const erasePain = await srv.req("/api/mobile/sessions", {
      method: "POST",
      cookie,
      csrf: true,
      origin: "http://localhost",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        profileId: pid,
        replace: true,
        session: makeSess(pubB, {
          startedAt: "2026-11-04T02:00:00Z",
          endedAt: "2026-11-04T02:20:00Z",
          symptoms: { pain: false, dizzy: false, chest: false },
        }),
      }),
    });
    expect(erasePain.status).toBe(422);

    // 动图批量接口防原型链属性污染
    const protoMotions = await (
      await srv.req("/api/mobile/motions/batch", {
        method: "POST",
        cookie,
        csrf: true,
        origin: "http://localhost",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: ["toString", "constructor", "__proto__"] }),
      })
    ).json();
    expect(Object.keys(protoMotions.clips)).toHaveLength(0);
    expect(protoMotions.missing).toEqual(["toString", "constructor", "__proto__"]);

    // 存在未处理冲突时，发布新课程必被 409 PROFILE_CONFLICT_UNRESOLVED 拦下
    const blockedPub = await srv.req(`/api/profiles/${pid}/courses/publish`, {
      method: "POST",
      cookie,
      csrf: true,
      origin: "http://localhost",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ week: 2, day: "B" }),
    });
    expect(blockedPub.status).toBe(409);
    expect((await blockedPub.json()).code).toBe("PROFILE_CONFLICT_UNRESOLVED");

    // 5. 原子模板重载使不兼容活跃课自动作废（先另建一个无冲突档案测试重载作废）
    const p2 = await (
      await srv.req("/api/profiles", {
        method: "POST",
        cookie,
        csrf: true,
        origin: "http://localhost",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          profile: makeA18HomeProfile(manifest, "重载甲"),
          initialAssessment: {
            schema: ASSESS_FORMAT,
            date: "2026-11-02",
            kind: "入门",
            base: 0,
            tests: [{ id: "pushup-test", level: 2, value: 8 }],
            conclusion: {},
          },
        }),
      })
    ).json();
    const p2Pub = await (
      await srv.req(`/api/profiles/${p2.id}/courses/publish`, {
        method: "POST",
        cookie,
        csrf: true,
        origin: "http://localhost",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ week: 1, day: "A" }),
      })
    ).json();
    expect(p2Pub.ok).toBe(true);
    const reloadRes = await srv.req("/api/admin/templates/reload", {
      method: "POST",
      cookie,
      csrf: true,
      origin: "http://localhost",
    });
    expect(reloadRes.status).toBe(200);
    const reloadBody = await reloadRes.json();
    expect(reloadBody.coursesInvalidated).toBeGreaterThanOrEqual(1);
    const p2Today = await (await srv.req(`/api/mobile/today?profileId=${p2.id}`, { cookie })).json();
    expect(p2Today.activeCourses).toHaveLength(0);
    expect(p2Today.invalidatedCourses.some((c: any) => c.id === p2Pub.id)).toBe(true);

    // 6. 脱敏审计日志断言：绝不包含任何体重数字或自由备注原文
    const auditRes = await (await srv.req(`/api/profiles/${pid}/audit`, { cookie })).json();
    const serializedAudit = JSON.stringify(auditRes.auditLogs);
    expect(serializedAudit).not.toContain("72.5");
    expect(serializedAudit).not.toContain("感觉还行");
    expect(pubW2.id).toBeTruthy();
  });
});
