// 网页 e2e 共用：起一个真服务端（临时数据目录、文件初始化口令、模拟模型），返回地址和口令。
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { serve } from "@hono/node-server";
import type { Manifest, MotionsData, PlansData, RulesData } from "@yangxia/course-core";
import { templatesDir } from "@yangxia/course-core/node";
import type { AgentEvent, AgentRuntime } from "../../server/src/agent/runtime/interface.ts";
import { createApp } from "../../server/src/app.ts";
import { fileSetupCode } from "../../server/src/auth/setup-code.ts";
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

export async function startLiveTestServer() {
  let clock = new Date("2026-11-02T03:00:00.000Z");
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
  // 首次初始化口令照生产入口：写在数据目录的 setup-code.txt（权限 600）
  const setup = fileSetupCode(tempDir, false);
  const ctx = createServerContext({
    db,
    config,
    templates,
    setupCode: setup.store,
    masterKey: randomBytes(32),
    scrypt: { N: 1024, r: 8, p: 1, keylen: 64 },
    now: () => clock,
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
    setupCode: setup.code!,
    /** 拨服务端的时钟（周复盘要在这一周结束以后做）。 */
    setNow(d: Date) {
      clock = d;
    },
    setupPath: setup.path,
    async close() {
      await new Promise<void>((res) => server.close(() => res()));
      ctx.close();
      rmSync(tempDir, { recursive: true, force: true });
    },
  };
}

