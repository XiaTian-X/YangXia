// v1.0.0 迁移导入、换机可用加密备份/恢复与系统加密设置端点。
import { Hono } from "hono";
import { z } from "zod";
import { isTeenMemberAccount, type AuthActor } from "../auth/permissions.ts";
import { decryptAndVerifyBackup, exportEncryptedBackup, RESTORE_NOTICE_TEXT, runAutoBackup } from "../backup/backup.ts";
import type { ServerContext } from "../context.ts";
import { encryptSecret } from "../crypto/master-key.ts";
import { writeAuditLog } from "../db/audit.ts";
import { AppError, withTransaction } from "../db/lock.ts";
import { importV1Directory, importV1Zip } from "../migrate/v1-importer.ts";

const MAX_UPLOAD_ZIP_BYTES = 55 * 1024 * 1024;
const MAX_UPLOAD_BACKUP_BYTES = 60 * 1024 * 1024;
const MAX_ZIP_B64_LEN = Math.ceil((MAX_UPLOAD_ZIP_BYTES * 4) / 3) + 16;
const MAX_BACKUP_B64_LEN = Math.ceil((MAX_UPLOAD_BACKUP_BYTES * 4) / 3) + 16;

const SECRET_KEY_RE = /api[_-]?key|secret|token|password|credential|private[_-]?key/i;

const BackupExportSchema = z.object({
  passphrase: z.string().min(8).max(128),
});

const BackupRestoreJsonSchema = z.object({
  passphrase: z.string().min(8).max(128),
  backupBase64: z.string().min(16).max(MAX_BACKUP_B64_LEN),
});

const ImportV1JsonSchema = z.object({
  zipBase64: z.string().min(16).max(MAX_ZIP_B64_LEN).optional(),
  directoryPath: z.string().min(1).max(300).optional(),
  timezone: z.string().min(1).max(64).optional(),
  isManaged: z.boolean().optional(),
  memberUserId: z.string().uuid().nullable().optional(),
  codeOverride: z.string().min(1).max(40).optional(),
});

const PatchSettingsSchema = z.object({
  items: z
    .array(
      z.object({
        key: z.string().min(1).max(80).regex(/^[a-z0-9._-]+$/i),
        value: z.string().max(4096).nullable(),
        isSecret: z.boolean().optional(),
      }),
    )
    .min(1)
    .max(30),
});

export function registerOpsRoutes(
  app: Hono<{ Variables: { actor: AuthActor } }>,
  ctx: ServerContext,
): void {
  const requireAdmin = (actor: AuthActor) => {
    if (actor.role !== "admin") throw new AppError(403, "ADMIN_ONLY", "仅管理员可执行此操作");
  };

  // v1.0.0 迁移：独立成年人可传 ZIP 导入本人名下；管理员可导入代管档案或读 YANGXIA_MIGRATE_DIR 白名单目录
  app.post("/api/profiles/import-v1", async (c) => {
    const actor = c.get("actor");
    // 在解压 ZIP 或读取大请求体之前前置做基础权限拦截
    if (actor.sessionKind === "mobile_bound" || isTeenMemberAccount(ctx.getDb(), actor)) {
      throw new AppError(403, "FORBIDDEN", "当前账号无权执行迁移导入");
    }

    const ct = c.req.header("content-type") ?? "";
    const snap = ctx.templates.current();
    const now = ctx.now();

    if (ct.includes("multipart/form-data")) {
      const form = await c.req.formData();
      const file = form.get("file");
      if (!(file instanceof File)) {
        throw new AppError(400, "MISSING_FILE", "请上传包含 v1.0.0 档案的 ZIP 文件（字段名 file）");
      }
      if (file.size > MAX_UPLOAD_ZIP_BYTES) {
        throw new AppError(413, "FILE_TOO_LARGE", "上传压缩包超过 55 MB 上限");
      }
      const isManaged = String(form.get("isManaged") ?? "") === "true";
      if (isManaged && actor.role !== "admin") {
        throw new AppError(403, "FORBIDDEN", "只有管理员可以导入代管子档案");
      }
      const buf = Buffer.from(await file.arrayBuffer());
      const report = importV1Zip(ctx.getDb(), snap, actor, buf, {
        timezone: typeof form.get("timezone") === "string" ? String(form.get("timezone")) || undefined : undefined,
        isManaged,
        memberUserId: typeof form.get("memberUserId") === "string" ? String(form.get("memberUserId")) || undefined : undefined,
        codeOverride: typeof form.get("codeOverride") === "string" ? String(form.get("codeOverride")) || undefined : undefined,
        now,
      });
      return c.json({ ok: true, report }, 201);
    }

    const body = ImportV1JsonSchema.parse(await c.req.json());
    if (body.isManaged && actor.role !== "admin") {
      throw new AppError(403, "FORBIDDEN", "只有管理员可以导入代管子档案");
    }
    const opts = {
      timezone: body.timezone,
      isManaged: body.isManaged,
      memberUserId: body.memberUserId,
      codeOverride: body.codeOverride,
      now,
    };

    if (body.zipBase64) {
      const buf = Buffer.from(body.zipBase64, "base64");
      if (buf.length > MAX_UPLOAD_ZIP_BYTES) {
        throw new AppError(413, "FILE_TOO_LARGE", "上传压缩包超过 55 MB 上限");
      }
      const report = importV1Zip(ctx.getDb(), snap, actor, buf, opts);
      return c.json({ ok: true, report }, 201);
    }
    if (body.directoryPath) {
      const report = importV1Directory(ctx.getDb(), snap, actor, body.directoryPath, ctx.config.migrateDir, opts);
      return c.json({ ok: true, report }, 201);
    }
    throw new AppError(400, "INVALID_IMPORT_INPUT", "请上传 ZIP 文件，或提供白名单目录路径");
  });

  // 换机可用加密备份导出
  app.post("/api/admin/backup/export", async (c) => {
    const actor = c.get("actor");
    requireAdmin(actor);
    const body = BackupExportSchema.parse(await c.req.json());
    const now = ctx.now();
    const { buffer, strippedSecretCount } = await exportEncryptedBackup(ctx.getDb(), body.passphrase, {
      scrypt: ctx.scrypt,
      now,
    });

    writeAuditLog(ctx.getDb(), {
      actorUserId: actor.userId,
      actorSessionId: actor.sessionId,
      action: "backup.export",
      fields: ["yxbackup"],
      ruleOrReason: `stripped_secrets:${strippedSecretCount}`,
      now,
    });

    const stamp = now.toISOString().slice(0, 10);
    return new Response(new Uint8Array(buffer), {
      status: 200,
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": `attachment; filename="yangxia-backup-${stamp}.yxbackup"`,
        "X-YangXia-Stripped-Secrets": String(strippedSecretCount),
      },
    });
  });

  // 触发一次定期自动备份并轮转
  app.post("/api/admin/backup/run-auto", async (c) => {
    const actor = c.get("actor");
    requireAdmin(actor);
    const pass = ctx.config.backupPassphrase;
    if (!pass) {
      throw new AppError(400, "AUTO_BACKUP_PASSPHRASE_MISSING", "未配置环境变量 YANGXIA_BACKUP_PASSPHRASE 或口令文件");
    }
    const db = ctx.getDb();
    const keepRow = db.prepare("SELECT value_enc FROM app_settings WHERE key = 'backup.keepCount' AND is_secret = 0").get() as
      | { value_enc: string }
      | undefined;
    const keepCount = keepRow ? Math.max(1, Number(keepRow.value_enc) || 7) : 7;
    const res = await runAutoBackup(db, ctx.config.backupDir, pass, keepCount, {
      scrypt: ctx.scrypt,
      now: ctx.now(),
    });
    return c.json({ ok: true, fileName: res.filePath.split("/").pop(), prunedCount: res.pruned.length });
  });

  // 换机可用加密备份恢复
  app.post("/api/admin/backup/restore", async (c) => {
    const actor = c.get("actor");
    requireAdmin(actor);
    const ct = c.req.header("content-type") ?? "";
    let backupBuf: Buffer;
    let passphrase: string;

    if (ct.includes("multipart/form-data")) {
      const form = await c.req.formData();
      const file = form.get("file");
      const pass = form.get("passphrase");
      if (!(file instanceof File) || typeof pass !== "string") {
        throw new AppError(400, "INVALID_RESTORE_INPUT", "请上传 .yxbackup 文件并填写备份口令");
      }
      if (file.size > MAX_UPLOAD_BACKUP_BYTES) {
        throw new AppError(413, "FILE_TOO_LARGE", "备份文件超过 60 MB 上限");
      }
      backupBuf = Buffer.from(await file.arrayBuffer());
      passphrase = pass;
    } else {
      const body = BackupRestoreJsonSchema.parse(await c.req.json());
      backupBuf = Buffer.from(body.backupBase64, "base64");
      if (backupBuf.length > MAX_UPLOAD_BACKUP_BYTES) {
        throw new AppError(413, "FILE_TOO_LARGE", "备份文件超过 60 MB 上限");
      }
      passphrase = body.passphrase;
    }

    const { sqliteBytes, header } = await decryptAndVerifyBackup(backupBuf, passphrase);
    ctx.restoreSqliteBytes(sqliteBytes);
    writeAuditLog(ctx.getDb(), {
      actorUserId: actor.userId,
      actorSessionId: actor.sessionId,
      action: "backup.restore",
      fields: ["sqlite"],
      ruleOrReason: `restored_from:${header.createdAt.slice(0, 10)}`,
      now: ctx.now(),
    });

    return c.json({
      ok: true,
      restoredFrom: header.createdAt,
      strippedSecretCount: header.strippedSecretCount,
      notice: RESTORE_NOTICE_TEXT,
    });
  });

  // 系统设置读写（is_secret=1 项永不明文回显）
  app.get("/api/admin/settings", (c) => {
    requireAdmin(c.get("actor"));
    const db = ctx.getDb();
    const rows = db.prepare("SELECT key, value_enc, is_secret, updated_at FROM app_settings ORDER BY key ASC").all() as {
      key: string;
      value_enc: string;
      is_secret: number;
      updated_at: string;
    }[];
    return c.json({
      settings: rows.map((r) =>
        r.is_secret === 1
          ? { key: r.key, isSecret: true, configured: true, updatedAt: r.updated_at }
          : { key: r.key, isSecret: false, value: r.value_enc, updatedAt: r.updated_at },
      ),
    });
  });

  app.patch("/api/admin/settings", async (c) => {
    const actor = c.get("actor");
    requireAdmin(actor);
    const body = PatchSettingsSchema.parse(await c.req.json());
    const db = ctx.getDb();
    const now = ctx.now();
    const nowIso = now.toISOString();
    const updatedKeys: string[] = [];

    withTransaction(db, () => {
      for (const item of body.items) {
        updatedKeys.push(item.key);
        if (item.value === null) {
          db.prepare("DELETE FROM app_settings WHERE key = ?").run(item.key);
          continue;
        }
        const isSecret = item.isSecret === true || SECRET_KEY_RE.test(item.key);
        if (isSecret) {
          const blob = encryptSecret(ctx.masterKey, item.value);
          db.prepare(
            `INSERT INTO app_settings (key, value_enc, iv, tag, is_secret, updated_at)
             VALUES (?, ?, ?, ?, 1, ?)
             ON CONFLICT(key) DO UPDATE SET value_enc = excluded.value_enc, iv = excluded.iv, tag = excluded.tag, is_secret = 1, updated_at = excluded.updated_at`,
          ).run(item.key, blob.valueEnc, blob.iv, blob.tag, nowIso);
        } else {
          db.prepare(
            `INSERT INTO app_settings (key, value_enc, iv, tag, is_secret, updated_at)
             VALUES (?, ?, '', '', 0, ?)
             ON CONFLICT(key) DO UPDATE SET value_enc = excluded.value_enc, iv = '', tag = '', is_secret = 0, updated_at = excluded.updated_at`,
          ).run(item.key, item.value, nowIso);
        }
      }

      writeAuditLog(db, {
        actorUserId: actor.userId,
        actorSessionId: actor.sessionId,
        action: "admin.settings_update",
        fields: updatedKeys,
        ruleOrReason: "settings_patch",
        now,
      });
    });

    return c.json({ ok: true, updatedKeys });
  });
}
