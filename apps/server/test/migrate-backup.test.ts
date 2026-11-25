import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ASSESS_FORMAT, courseIdFor, DECLARATION, REVIEW_FORMAT, SESSION_FORMAT } from "@yangxia/course-core";
import { RESTORE_NOTICE_KEY, runAutoBackup } from "../src/backup/backup.ts";
import { createZipBuffer } from "../src/migrate/zip.ts";
import {
  createTestServer,
  extractSessionCookie,
  FAST_SCRYPT,
  makeA18HomeProfile,
  type TestServerHandle,
  TEST_SETUP_CODE,
} from "./helpers.ts";

let servers: TestServerHandle[] = [];
afterEach(() => {
  for (const s of servers) s.cleanup();
  servers = [];
});

async function initAdmin(s: TestServerHandle) {
  const res = await s.req("/api/setup/init", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "AdminPassword123", setupCode: TEST_SETUP_CODE }),
  });
  expect(res.status).toBe(201);
  return extractSessionCookie(res);
}

describe("SVG 沙箱安全头、v1.0.0 全目录迁移（含 历史/第N段/）与换机可用加密备份", () => {
  it("模板 SVG 返回 CSP sandbox + nosniff，拦截路径穿越", async () => {
    const srv = await createTestServer();
    servers.push(srv);
    const cookie = await initAdmin(srv);

    const imgDir = join(srv.ctx.templates.current().dir, "dist", "img");
    if (existsSync(imgDir)) {
      const svg = readdirSync(imgDir).find((f) => f.endsWith(".svg"));
      if (svg) {
        const res = await srv.req(`/api/templates/img/${encodeURIComponent(svg)}`, { cookie });
        expect(res.status).toBe(200);
        expect(res.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
        expect(res.headers.get("x-content-type-options")).toBe("nosniff");
        expect(res.headers.get("content-type")).toContain("image/svg+xml");
      }
    }

    // 路径穿越尝试必返 404
    const trav = await srv.req("/api/templates/img/..%2Fmanifest.json", { cookie });
    expect(trav.status).toBe(404);
  });

  it("v1.0.0 ZIP 迁移（含 历史/第1段/ 与旧计划单 readonly_legacy）、Zip Slip/符号链接拦截与白名单目录导入", async () => {
    const srv = await createTestServer({ now: new Date("2026-12-01T03:00:00.000Z") });
    servers.push(srv);
    const cookie = await initAdmin(srv);
    const manifest = srv.ctx.templates.current().manifest;

    // 构造多段 v1.0.0 档案（第 1 段已完成并归档进 历史/第1段/，当前在第 2 段第 1 周）
    const profile = makeA18HomeProfile(manifest, "老用户甲", {
      startDate: "2026-11-02",
      household: ["a18"],
      segments: [
        { n: 1, type: "标准", week: 1, start: "2026-11-02", product: "18-39岁-居家版" },
        { n: 1, type: "标准", week: 2, start: "2026-11-09", product: "18-39岁-居家版" },
        { n: 1, type: "标准", week: 3, start: "2026-11-16", product: "18-39岁-居家版" },
        { n: 1, type: "标准", week: 4, start: "2026-11-23", product: "18-39岁-居家版" },
        { n: 2, type: "减量", week: 1, start: "2026-11-30", product: "18-39岁-居家版" },
      ],
    });

    const cid1 = courseIdFor("18-39岁-居家版", 1, "标准", 1, "A", false);
    const s1 = {
      schema: SESSION_FORMAT,
      course: {
        id: cid1,
        name: "第 1 周 A 日",
        source: { plan: "yangxia.plans/1", product: "18-39岁-居家版", templates: "v1.0.0", segment: 1, type: "标准", week: 1, day: "A" },
      },
      startedAt: "2026-11-03T02:00:00.000Z",
      endedAt: "2026-11-03T02:20:00.000Z",
      items: [{ exercise: "squat", setsPlanned: 2, setsDone: 2 }],
      feeling: "正好",
      symptoms: { pain: false, dizzy: false, chest: false },
    };

    const mkRev = (start: string, week: number, trainings: number) => ({
      json: {
        schema: REVIEW_FORMAT,
        start,
        week,
        trainings,
        symptoms: false,
        habits: { 散步: 5, 冥想: 5 },
        moves: [],
      },
      md: `${DECLARATION}\n\n第 ${week} 周复盘：完成 ${trainings} 练，状态稳定。`,
    });
    const r1 = mkRev("2026-11-02", 1, 2);
    const r2 = mkRev("2026-11-09", 2, 2);
    const r3 = mkRev("2026-11-16", 3, 2);
    const r4 = mkRev("2026-11-23", 4, 2);

    const aEntry = {
      schema: ASSESS_FORMAT,
      date: "2026-11-02",
      kind: "入门",
      base: 0,
      tests: [{ id: "pushup-test", level: 2, value: 8 }],
      conclusion: {},
    };
    const aEnd1 = {
      schema: ASSESS_FORMAT,
      date: "2026-11-29",
      kind: "段末",
      segment: 1,
      tests: [
        { id: "pushup-test", level: 2, value: 10 },
        { id: "bike-test", value: 20 },
      ],
      conclusion: {
        result: "减量",
        next: "减量",
      },
    };

    const validZip = createZipBuffer([
      { path: "老用户甲/档案.json", data: JSON.stringify(profile, null, 2) },
      { path: "老用户甲/评估/2026-11-02-入门.json", data: JSON.stringify(aEntry) },
      { path: "老用户甲/历史/第1段/评估/2026-11-29-段末.json", data: JSON.stringify(aEnd1) },
      { path: "老用户甲/历史/第1段/打卡/养夏_练习记录_2026-11-03_1000.json", data: JSON.stringify(s1) },
      { path: "老用户甲/历史/第1段/复盘/2026-11-02-第1周.json", data: JSON.stringify(r1.json) },
      { path: "老用户甲/历史/第1段/复盘/2026-11-02-第1周.md", data: r1.md },
      { path: "老用户甲/历史/第1段/复盘/2026-11-09-第2周.json", data: JSON.stringify(r2.json) },
      { path: "老用户甲/历史/第1段/复盘/2026-11-09-第2周.md", data: r2.md },
      { path: "老用户甲/历史/第1段/复盘/2026-11-16-第3周.json", data: JSON.stringify(r3.json) },
      { path: "老用户甲/历史/第1段/复盘/2026-11-16-第3周.md", data: r3.md },
      { path: "老用户甲/历史/第1段/复盘/2026-11-23-第4周.json", data: JSON.stringify(r4.json) },
      { path: "老用户甲/历史/第1段/复盘/2026-11-23-第4周.md", data: r4.md },
      // 无生成标记的旧版计划单：迁入标 readonly_legacy=1，不因模板升级报 checkSheet 错
      { path: "老用户甲/计划/第2段-第1周.md", data: `${DECLARATION}\n\n旧版 v1 计划单归档内容` },
      { path: "老用户甲/菜单/第1周.md", data: `${DECLARATION}\n\n周一：杂粮饭 + 清蒸鱼 + 绿叶菜` },
      // 课程包 .html 和日历 .ics 应被跳过并在报告中列出
      { path: "老用户甲/课程/老用户甲_第1周_A日.html", data: "<html></html>" },
      { path: "老用户甲/训练安排.ics", data: "BEGIN:VCALENDAR\nEND:VCALENDAR\n" },
    ]);

    const impRes = await srv.req("/api/profiles/import-v1", {
      method: "POST",
      cookie,
      csrf: true,
      origin: "http://localhost",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ zipBase64: validZip.toString("base64") }),
    });
    expect(impRes.status).toBe(201);
    const impBody = await impRes.json();
    expect(impBody.report.counts.sessions).toBe(1);
    expect(impBody.report.counts.reviews).toBe(4);
    expect(impBody.report.counts.assessments).toBe(2);
    expect(impBody.report.counts.documents).toBe(2);
    expect(impBody.report.skipped.map((x: any) => x.path)).toEqual(
      expect.arrayContaining(["课程/老用户甲_第1周_A日.html", "训练安排.ics"]),
    );

    // 导入后跑完整 audit 必须 0 error
    const audit = await (await srv.req(`/api/profiles/${impBody.report.profileId}/audit`, { cookie })).json();
    expect(audit.issues.filter((i: any) => i.level === "error")).toEqual([]);

    // Zip Slip 与符号链接拦截
    const slipZip = createZipBuffer([{ path: "../escape.json", data: "{}" }]);
    expect(
      (
        await srv.req("/api/profiles/import-v1", {
          method: "POST",
          cookie,
          csrf: true,
          origin: "http://localhost",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ zipBase64: slipZip.toString("base64") }),
        })
      ).status,
    ).toBe(400);

    const symlinkZip = createZipBuffer([{ path: "档案.json", data: "/etc/passwd", unixMode: 0o120777 }]);
    const symRes = await srv.req("/api/profiles/import-v1", {
      method: "POST",
      cookie,
      csrf: true,
      origin: "http://localhost",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ zipBase64: symlinkZip.toString("base64") }),
    });
    expect(symRes.status).toBe(400);
    expect((await symRes.json()).code).toBe("ZIP_SYMLINK_FORBIDDEN");

    // YANGXIA_MIGRATE_DIR 白名单目录校验
    const migRoot = join(srv.tempDir, "allowed-migrate");
    const subDir = join(migRoot, "old-profile");
    mkdirSync(join(subDir, "评估"), { recursive: true });
    writeFileSync(join(subDir, "档案.json"), JSON.stringify(makeA18HomeProfile(manifest, "目录导入甲", { startDate: "2026-11-30", segments: [{ n: 1, type: "标准", week: 1, start: "2026-11-30", product: "18-39岁-居家版" }] })));
    writeFileSync(join(subDir, "评估", "2026-11-30-入门.json"), JSON.stringify({ ...aEntry, date: "2026-11-30" }));
    srv.ctx.config.migrateDir = migRoot;

    // 越出白名单目录 → 403
    const escRes = await srv.req("/api/profiles/import-v1", {
      method: "POST",
      cookie,
      csrf: true,
      origin: "http://localhost",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ directoryPath: ".." }),
    });
    expect(escRes.status).toBe(403);

    // 合法白名单子目录 → 201
    const dirRes = await srv.req("/api/profiles/import-v1", {
      method: "POST",
      cookie,
      csrf: true,
      origin: "http://localhost",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ directoryPath: "old-profile" }),
    });
    expect(dirRes.status).toBe(201);
  });

  it("换机可用加密备份：剥离原机 master.key 加密 API Key，在全新 master.key 宿主机 100% 恢复并验证自动轮转", async () => {
    // 宿主机 A（文件库 + 独立 masterKey A）
    const hostA = await createTestServer({ fileBackedDb: true });
    servers.push(hostA);
    const cookieA = await initAdmin(hostA);
    const manifest = hostA.ctx.templates.current().manifest;

    // 存入外部模型 API Key（包含带下划线键名且未显式标 isSecret，亦自动识别加密）与普通配置
    const dummyApiKey = ["fake", "api", "key", "do", "not", "leak", "123456"].join("-");
    const setRes = await hostA.req("/api/admin/settings", {
      method: "PATCH",
      cookie: cookieA,
      csrf: true,
      origin: "http://localhost",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        items: [
          { key: "agent.provider", value: "deepseek", isSecret: false },
          { key: "agent.apiKey", value: dummyApiKey, isSecret: true },
          { key: "agent.extra_api_key", value: `${dummyApiKey}-2` },
        ],
      }),
    });
    expect(setRes.status).toBe(200);

    // GET /api/admin/settings 永不明文回显 secret
    const gotSet = await (await hostA.req("/api/admin/settings", { cookie: cookieA })).json();
    expect(JSON.stringify(gotSet)).not.toContain(dummyApiKey);
    expect(gotSet.settings.find((x: any) => x.key === "agent.apiKey")).toMatchObject({ isSecret: true, configured: true });
    expect(gotSet.settings.find((x: any) => x.key === "agent.extra_api_key")).toMatchObject({ isSecret: true, configured: true });

    // 创建档案并导出加密备份
    const profRes = await hostA.req("/api/profiles", {
      method: "POST",
      cookie: cookieA,
      csrf: true,
      origin: "http://localhost",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profile: makeA18HomeProfile(manifest, "灾备档案甲") }),
    });
    expect(profRes.status).toBe(201);
    const profId = (await profRes.json()).id as string;

    const expRes = await hostA.req("/api/admin/backup/export", {
      method: "POST",
      cookie: cookieA,
      csrf: true,
      origin: "http://localhost",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ passphrase: "MyStrongBackupPassword!2026" }),
    });
    expect(expRes.status).toBe(200);
    expect(expRes.headers.get("x-yangxia-stripped-secrets")).toBe("2");
    const backupBytes = Buffer.from(await expRes.arrayBuffer());

    // 篡改备份头 AAD（修改 strippedSecretCount 字段）必被 AES-GCM 拒收
    const hLen = backupBytes.readUInt32BE(8);
    const tamperedHeader = JSON.parse(backupBytes.subarray(12, 12 + hLen).toString("utf8"));
    tamperedHeader.strippedSecretCount = 0;
    const tamperedHdrBuf = Buffer.from(JSON.stringify(tamperedHeader), "utf8");
    const tamperedLen = Buffer.alloc(4);
    tamperedLen.writeUInt32BE(tamperedHdrBuf.length, 0);
    const tamperedBackup = Buffer.concat([backupBytes.subarray(0, 8), tamperedLen, tamperedHdrBuf, backupBytes.subarray(12 + hLen)]);

    // 全新宿主机 B（全新数据库 + 全新 masterKey B）
    const hostB = await createTestServer({ fileBackedDb: true });
    servers.push(hostB);
    const cookieB = await initAdmin(hostB);

    const tamperRes = await hostB.req("/api/admin/backup/restore", {
      method: "POST",
      cookie: cookieB,
      csrf: true,
      origin: "http://localhost",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ passphrase: "MyStrongBackupPassword!2026", backupBase64: tamperedBackup.toString("base64") }),
    });
    expect(tamperRes.status).toBe(400);
    expect((await tamperRes.json()).code).toBe("BACKUP_DECRYPT_FAILED");

    // 错误口令必被 400 BACKUP_DECRYPT_FAILED 拒收
    const badPass = await hostB.req("/api/admin/backup/restore", {
      method: "POST",
      cookie: cookieB,
      csrf: true,
      origin: "http://localhost",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ passphrase: "WrongPassword123", backupBase64: backupBytes.toString("base64") }),
    });
    expect(badPass.status).toBe(400);
    expect((await badPass.json()).code).toBe("BACKUP_DECRYPT_FAILED");

    // 正确口令恢复到全新宿主机 B
    const okRestore = await hostB.req("/api/admin/backup/restore", {
      method: "POST",
      cookie: cookieB,
      csrf: true,
      origin: "http://localhost",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ passphrase: "MyStrongBackupPassword!2026", backupBase64: backupBytes.toString("base64") }),
    });
    expect(okRestore.status).toBe(200);
    const restBody = await okRestore.json();
    expect(restBody.strippedSecretCount).toBe(2);

    // 用原宿主机 A 的管理员账密登录宿主机 B，确认档案与普通设置完整恢复、原机加密 API Key 已剥离且带恢复提示
    const loginB = await hostB.req("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "AdminPassword123", kind: "mobile_account" }),
    });
    expect(loginB.status).toBe(200);
    const tokenB = (await loginB.json()).token as string;

    const profOnB = await (await hostB.req(`/api/profiles/${profId}`, { token: tokenB })).json();
    expect(profOnB.code).toBe("灾备档案甲");

    const setOnB = await (await hostB.req("/api/admin/settings", { token: tokenB })).json();
    expect(setOnB.settings.find((x: any) => x.key === "agent.provider")?.value).toBe("deepseek");
    expect(setOnB.settings.find((x: any) => x.key === "agent.apiKey")).toBeUndefined();
    expect(setOnB.settings.find((x: any) => x.key === RESTORE_NOTICE_KEY)?.value).toContain("重新填写");

    // 定期自动备份轮转（keepCount=2，连续跑 3 次仅留最新 2 份）
    for (let i = 0; i < 3; i++) {
      await runAutoBackup(hostB.ctx.getDb(), hostB.ctx.config.backupDir, "AutoBackupPass123", 2, {
        scrypt: FAST_SCRYPT,
        now: new Date(Date.parse("2026-11-10T00:00:00Z") + i * 3600_000),
      });
    }
    const kept = readdirSync(hostB.ctx.config.backupDir).filter((f) => f.endsWith(".yxbackup"));
    expect(kept).toHaveLength(2);
  });
});
