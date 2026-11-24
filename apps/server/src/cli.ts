// 宿主机运维命令行（npm run server:cli -- <子命令>）：
// - reset-password <username> <new-password>  管理员/成员离线重置密码并吊销全部会话
// - backup-export <输出.yxbackup> <备份口令>   导出换机可用加密备份
// - backup-restore <输入.yxbackup> <备份口令>  离线校验并恢复加密备份（请先停服务）
import { readFileSync, writeFileSync } from "node:fs";
import { decryptAndVerifyBackup, exportEncryptedBackup, writeRestoredSqliteFile } from "./backup/backup.ts";
import { loadConfig } from "./config.ts";
import { hashPassword, validatePassword } from "./crypto/password.ts";
import { writeAuditLog } from "./db/audit.ts";
import { openDatabase } from "./db/database.ts";
import { withTransaction } from "./db/lock.ts";

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  const config = loadConfig();

  if (cmd === "reset-password") {
    const [username, password] = args;
    if (!username || !password) {
      console.error("用法：npm run server:cli -- reset-password <用户名> <新密码（至少 8 位）>");
      process.exit(2);
    }
    const err = validatePassword(password);
    if (err) {
      console.error(`错误：${err}`);
      process.exit(2);
    }
    const db = openDatabase(config.dbPath);
    try {
      const user = db.prepare("SELECT id, username FROM users WHERE username = ? COLLATE NOCASE").get(username) as
        | { id: string; username: string }
        | undefined;
      if (!user) {
        console.error(`找不到用户：${username}`);
        process.exit(1);
      }
      const hash = await hashPassword(password);
      const now = new Date();
      withTransaction(db, () => {
        db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(hash, user.id);
        db.prepare("UPDATE auth_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL").run(
          now.toISOString(),
          user.id,
        );
        writeAuditLog(db, {
          actorUserId: user.id,
          action: "cli.password_reset",
          fields: ["users.password_hash", "auth_sessions.revoked_at"],
          ruleOrReason: "host_cli_reset",
          now,
        });
      });
      console.log(`已重置「${user.username}」的密码，并吊销全部既有登录会话。`);
    } finally {
      db.close();
    }
    return;
  }

  if (cmd === "backup-export") {
    const [outFile, passphrase] = args;
    if (!outFile || !passphrase) {
      console.error("用法：npm run server:cli -- backup-export <输出.yxbackup> <备份口令>");
      process.exit(2);
    }
    const db = openDatabase(config.dbPath);
    try {
      const { buffer, strippedSecretCount } = await exportEncryptedBackup(db, passphrase);
      writeFileSync(outFile, buffer, { mode: 0o600 });
      console.log(`已导出加密备份：${outFile}（${buffer.length} 字节；已剥离 ${strippedSecretCount} 条本机加密密钥项）`);
    } finally {
      db.close();
    }
    return;
  }

  if (cmd === "backup-restore") {
    const [inFile, passphrase] = args;
    if (!inFile || !passphrase) {
      console.error("用法：npm run server:cli -- backup-restore <输入.yxbackup> <备份口令>");
      process.exit(2);
    }
    const buf = readFileSync(inFile);
    const { sqliteBytes, header } = await decryptAndVerifyBackup(buf, passphrase);
    writeRestoredSqliteFile(config.dbPath, sqliteBytes);
    console.log(`已从 ${header.createdAt} 的加密备份恢复至 ${config.dbPath}（外部模型 API Key 需在系统设置页重新填写）。`);
    return;
  }

  console.error("可用命令：reset-password | backup-export | backup-restore");
  process.exit(2);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
