// 阶段 4 网页管理端端到端测试（桌面 1440×900 + 平板 820×1180）：
// 覆盖首次初始化、无大模型全流程闭环（建档/算上床时间/扫码本地 SVG 二维码/入门评估/计划单/排课发布/菜单红线/模板阅读）、
// Agent SSE 流式回复 + 高危两阶段确认卡、管理员加密配置与备份导出，并强断言 0 外部网络请求。
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { serve } from "@hono/node-server";
import { expect, test } from "@playwright/test";
import type { Manifest, MotionsData, PlansData, RulesData } from "@yangxia/course-core";
import { templatesDir } from "@yangxia/course-core/node";
import type { AgentEvent, AgentRuntime } from "../../server/src/agent/runtime/interface.ts";
import { createApp } from "../../server/src/app.ts";
import { createTrustedProxyMatcher, type ServerConfig } from "../../server/src/config.ts";
import { createServerContext } from "../../server/src/context.ts";
import { openDatabase } from "../../server/src/db/database.ts";
import { TemplatesManager, type TemplatesSnapshot } from "../../server/src/templates/manager.ts";

const REPO_ROOT = resolve(new URL("../../../", import.meta.url).pathname);
const FIX = join(REPO_ROOT, "contracts", "fixtures");
const WEB_DIST = resolve(REPO_ROOT, "apps", "web", "dist");

function loadFixtureSnapshot(): TemplatesSnapshot {
  const manifest = JSON.parse(readFileSync(join(FIX, "manifest.json"), "utf8")) as Manifest;
  const plans = JSON.parse(readFileSync(join(FIX, "data", "plans.json"), "utf8")) as PlansData;
  const rules = JSON.parse(readFileSync(join(FIX, "data", "rules.json"), "utf8")) as RulesData;
  const motions = JSON.parse(readFileSync(join(FIX, "data", "motions.json"), "utf8")) as MotionsData;
  const motionIndex = Object.fromEntries(
    Object.entries(motions.clips).map(([id, clip]) => [id, { id, clip, hash: `fix-${id}`, sizeBytes: JSON.stringify(clip).length }]),
  );
  const motionHashes = Object.fromEntries(Object.keys(motions.clips).map((id) => [id, `fix-${id}`]));
  return {
    manifest,
    plans,
    rules,
    motions,
    readProduct: () => null,
    version: manifest.version,
    dir: FIX,
    templateHash: "fixture-hash",
    motionIndex,
    motionHashes,
    loadedAt: new Date().toISOString(),
    listDocs: () => ["18-39岁-居家版"],
    readDoc: (name) => (name === "18-39岁-居家版" ? "# 18-39岁-居家版\n\n未经专业审核，不是医学建议，不能替代医生的判断" : null),
    resolveImage: () => null,
  };
}

async function startLiveTestServer() {
  const tempDir = mkdtempSync(join(tmpdir(), "yangxia-web-e2e-"));
  const dbPath = join(tempDir, "yangxia.sqlite");
  const db = openDatabase(dbPath);
  const snap = (await templatesDir()) ? (await TemplatesManager.create()).current() : loadFixtureSnapshot();
  const templates = new TemplatesManager(snap);

  const mockRuntime: AgentRuntime = {
    id: "mock-e2e",
    async *streamTurn(req): AsyncIterable<AgentEvent> {
      const upScreen = req.tools.find((t) => t.name === "update_screening_and_doctor");
      if (upScreen) {
        await upScreen.execute({ cardioClear: [{ date: "2026-11-02" }] });
      }
      yield { type: "text_delta", text: "未经专业审核，不是医学建议，不能替代医生的判断\n" };
      yield { type: "text_delta", text: "已为您生成有氧医生同意确认卡，请核对后点击确认。" };
      yield { type: "done", finishReason: "stop", text: "已为您生成有氧医生同意确认卡，请核对后点击确认。" };
    },
  };

  process.env.YANGXIA_WEB_DIST = WEB_DIST;
  const config: ServerConfig = {
    host: "127.0.0.1",
    port: 0,
    dataDir: tempDir,
    dbPath,
    masterKeyPath: join(tempDir, "master.key"),
    backupDir: join(tempDir, "backups"),
    trustedProxies: createTrustedProxyMatcher(),
    backupPassphrase: "e2e-auto-backup-pass",
    defaultTimezone: "Asia/Shanghai",
  };
  const ctx = createServerContext({
    db,
    config,
    templates,
    masterKey: randomBytes(32),
    scrypt: { N: 1024, r: 8, p: 1, keylen: 64 },
    now: () => new Date("2026-11-02T03:00:00.000Z"),
    agentRuntimeFactory: () => mockRuntime,
  });

  const app = createApp(ctx);
  const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
  await new Promise<void>((resolveReady) => {
    if (server.listening) resolveReady();
    else server.once("listening", () => resolveReady());
  });
  const addr = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  return {
    baseUrl,
    async close() {
      await new Promise<void>((res) => server.close(() => res()));
      ctx.close();
      rmSync(tempDir, { recursive: true, force: true });
    },
  };
}

test("桌面 1440×900 与平板 820×1180：无大模型全闭环 + Agent SSE 确认卡 + 0 外部请求", async ({ page }) => {
  const srv = await startLiveTestServer();
  const externalRequests: string[] = [];

  page.on("request", (req) => {
    const url = req.url();
    if (url.startsWith("blob:") || url.startsWith("data:")) return;
    if (!url.startsWith(srv.baseUrl)) {
      externalRequests.push(url);
    }
  });

  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(srv.baseUrl);

    // 1. 首次初始化管理员
    await expect(page.getByRole("heading", { name: "首次初始化管理员" })).toBeVisible();
    await expect(page.getByText("未经专业审核，不是医学建议，不能替代医生的判断")).toBeVisible();
    await page.locator('input[name="password"]').fill("AdminPass123!");
    await page.locator('input[name="confirmPassword"]').fill("AdminPass123!");
    await page.getByRole("button", { name: "创建管理员并进入" }).click();
    await expect(page.getByRole("heading", { name: "尚未建立或选择档案" })).toBeVisible();

    // 2. 家庭与档案：可视向导建档 + 按公式算上床时间 + 扫码本地 SVG 二维码
    await page.getByRole("button", { name: "前往可视向导建档" }).click();
    await expect(page.getByRole("heading", { name: "家庭与档案" })).toBeVisible();
    await page.getByPlaceholder("如 小夏、爸爸").fill("小夏E2E");
    await page.getByRole("button", { name: "按公式计算" }).click();
    await expect(page.locator('input[placeholder="点击右侧计算"]')).toHaveValue(/\d{2}:\d{2}/);
    // 设置日期与当前测试时钟对齐（2026-11-02）
    await page.locator('input[type="date"]').first().fill("2026-11-02");
    await page.getByLabel("a18", { exact: true }).check();
    await page.getByLabel("a06", { exact: true }).check();
    await page.getByRole("button", { name: "校验并创建档案" }).click();
    await expect(page.getByText(/已成功建档「小夏E2E」/)).toBeVisible();

    // 扫码绑定弹窗：本地 SVG 二维码渲染正常且 0 外部请求
    await page.getByRole("button", { name: "手机扫码绑定" }).click();
    const qrSvg = page.getByRole("img", { name: "手机扫码配对二维码" });
    await expect(qrSvg).toBeVisible();
    const pathD = await qrSvg.locator("path").getAttribute("d");
    expect(pathD && pathD.length > 100).toBe(true);
    await page.getByRole("button", { name: "关闭" }).click();

    // 3. 评估与复盘：可视化提交入门评估并展示后端重算结论
    await page.getByRole("button", { name: "评估与复盘" }).click();
    await page.getByRole("button", { name: "提交「入门」评估" }).click();
    await expect(page.getByText(/已提交「入门」评估，服务端重算结论/)).toBeVisible();

    // 4. 排课中心：生成本周计划单 + 发布第 1 周 A 日课程
    await page.getByRole("button", { name: "排课中心" }).click();
    await page.getByRole("button", { name: "生成 / 更新本周计划单" }).click();
    await expect(page.getByText(/已确定性生成本周个人计划单/)).toBeVisible();
    await page.getByRole("button", { name: /发布第 1 周 .* 日课程/ }).click();
    await expect(page.getByText(/已发布跟练课程/)).toBeVisible();
    await expect(page.getByText("当前可跟练课程（1）")).toBeVisible();

    // 5. 饮食与模板阅读：菜单合规保存 + 红线拦截 + 模板正文渲染
    await page.getByRole("button", { name: "饮食与模板" }).click();
    await page.getByRole("button", { name: "校验红线并保存菜单" }).click();
    await expect(page.getByText(/已通过免责声明与全家安全红线校验/)).toBeVisible();

    // 触发儿童青少年热量/减肥红线拦截
    await page.locator("textarea").fill("未经专业审核，不是医学建议，不能替代医生的判断\n\n每天控制 1200 千卡减肥");
    await page.getByRole("button", { name: "校验红线并保存菜单" }).click();
    await expect(page.getByRole("alert")).toBeVisible();

    // 6. 养夏助手：SSE 流式输出 + 高危两阶段确认卡
    await page.getByRole("button", { name: "养夏助手" }).click();
    await expect(page.getByText("隐私披露与模型说明")).toBeVisible();
    await page.getByPlaceholder(/输入问题或指令/).fill("请登记医生同意有氧加量");
    await page.getByRole("button", { name: "发送" }).click();
    const confirmCard = page.getByTestId("agent-confirm-card");
    await expect(confirmCard).toBeVisible();
    await expect(confirmCard).toContainText("cardioClear");
    await confirmCard.getByRole("button", { name: "确认并保存" }).click();
    await expect(confirmCard).toBeHidden();
    await expect(page.getByText(/用户已确认并完成写入/)).toBeVisible();

    // 7. 系统管理：加密存 API Key（永不明文回显）+ 模板热重载 + 导出加密备份
    await page.getByRole("button", { name: "系统管理" }).click();
    const dummyKey = ["fake", "e2e", "secret", "key", "abcdef1234567890"].join("-");
    await page.getByPlaceholder(/填写外部模型 API Key/).fill(dummyKey);
    await page.getByRole("button", { name: "保存模型配置" }).click();
    await expect(page.getByText("API Key 已加密存储")).toBeVisible();
    expect(await page.content()).not.toContain(dummyKey);

    await page.getByRole("button", { name: "重新加载模板" }).click();
    await expect(page.getByText(/已原子热重载模板/)).toBeVisible();

    await page.getByPlaceholder("设置备份口令（至少 8 位）").fill("MyBackupPass123!");
    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: "导出 .yxbackup" }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/\.yxbackup$/);

    // 8. 平板 820×1180 断点适配验证（无水平溢出，导航可用）
    await page.setViewportSize({ width: 820, height: 1180 });
    await page.getByRole("button", { name: "排课中心" }).click();
    await expect(page.getByRole("heading", { name: /小夏E2E/ })).toBeVisible();
    const hasOverflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
    expect(hasOverflow).toBe(false);

    // 强断言：全程 0 个外部网络请求！
    expect(externalRequests).toEqual([]);
  } finally {
    await srv.close();
  }
});
