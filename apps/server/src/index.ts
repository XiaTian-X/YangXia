// 养夏自托管后端主入口（Node 24 + Hono + 内置 node:sqlite）。
import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { runAutoBackup } from "./backup/backup.ts";
import { loadConfig } from "./config.ts";
import { createServerContext } from "./context.ts";
import { fileSetupCode } from "./auth/setup-code.ts";
import { loadOrCreateMasterKey } from "./crypto/master-key.ts";
import { openDatabase } from "./db/database.ts";
import { TemplatesManager } from "./templates/manager.ts";

async function main() {
  const config = loadConfig();
  const db = openDatabase(config.dbPath);
  const masterKey = loadOrCreateMasterKey(config.masterKeyPath);
  const templates = await TemplatesManager.create(config.templatesDir);
  const users = (db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n;
  const setup = fileSetupCode(config.dataDir, users > 0);
  const ctx = createServerContext({ db, config, templates, masterKey, setupCode: setup.store });
  const app = createApp(ctx);

  // 可选定期自动加密备份检查（每 15 分钟检查一次是否达到配置间隔）
  let lastAutoBackupMs = 0;
  const backupTimer = setInterval(async () => {
    if (!config.backupPassphrase) return;
    try {
      const curDb = ctx.getDb();
      const enabledRow = curDb
        .prepare("SELECT value_enc FROM app_settings WHERE key = 'backup.autoEnabled' AND is_secret = 0")
        .get() as { value_enc: string } | undefined;
      if (enabledRow?.value_enc !== "true") return;
      const intervalRow = curDb
        .prepare("SELECT value_enc FROM app_settings WHERE key = 'backup.intervalHours' AND is_secret = 0")
        .get() as { value_enc: string } | undefined;
      const keepRow = curDb
        .prepare("SELECT value_enc FROM app_settings WHERE key = 'backup.keepCount' AND is_secret = 0")
        .get() as { value_enc: string } | undefined;
      const intervalMs = Math.max(1, Number(intervalRow?.value_enc) || 24) * 3_600_000;
      const keepCount = Math.max(1, Number(keepRow?.value_enc) || 7);
      const nowMs = Date.now();
      if (nowMs - lastAutoBackupMs < intervalMs) return;
      const res = await runAutoBackup(ctx.getDb(), config.backupDir, config.backupPassphrase, keepCount);
      lastAutoBackupMs = nowMs;
      console.log(`[yangxia-server] 自动加密备份完成：${res.filePath}`);
    } catch (err) {
      console.error("[yangxia-server] 自动备份失败：", err);
    }
  }, 15 * 60_000);
  backupTimer.unref();

  const server = serve({
    fetch: app.fetch,
    hostname: config.host,
    port: config.port,
  });

  console.log(
    `养夏自托管服务已启动：http://${config.host}:${config.port}（模板 ${templates.current().version}，数据库 ${config.dbPath}）`,
  );
  if (setup.code) {
    console.log(`[yangxia-server] 还没有管理员：首次初始化口令 ${setup.code}（也写在 ${setup.path}，只有本机能读；初始化完成后自动删除）`);
  }

  const shutdown = () => {
    clearInterval(backupTimer);
    server.close(() => {
      ctx.close();
      process.exit(0);
    });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("[yangxia-server] 启动失败：", err);
  process.exit(1);
});
