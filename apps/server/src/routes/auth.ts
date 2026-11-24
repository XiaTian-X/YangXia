// 健康检查、首次初始化、账密登录、扫码绑定兑换、滑动续期、设备吊销与管理员用户管理。
import { Hono, type Context } from "hono";
import { getCookie } from "hono/cookie";
import { z } from "zod";
import {
  clearSessionCookie,
  createSession,
  getClientIp,
  refreshSession,
  SESSION_COOKIE,
  setSessionCookie,
} from "../auth/middleware.ts";
import { isTeenMemberAccount, type AuthActor } from "../auth/permissions.ts";
import type { ServerContext } from "../context.ts";
import { hashPassword, validatePassword, verifyPassword } from "../crypto/password.ts";
import { newId, normalizePairingCode, sha256Hex } from "../crypto/tokens.ts";
import { writeAuditLog } from "../db/audit.ts";
import { AppError, withTransaction } from "../db/lock.ts";

const SetupSchema = z.object({
  username: z.string().trim().min(2).max(40).regex(/^[a-zA-Z0-9_\u4e00-\u9fa5-]+$/, "用户名只允许字母、数字、中文、下划线与短横线"),
  password: z.string().min(8).max(128),
  deviceName: z.string().max(80).optional(),
});

const LoginSchema = z.object({
  username: z.string().trim().min(1).max(60),
  password: z.string().min(1).max(128),
  kind: z.enum(["web", "mobile_account"]).default("web"),
  deviceName: z.string().max(80).optional(),
});

const PairSchema = z.object({
  code: z.string().trim().min(16).max(64),
  deviceName: z.string().max(80).optional(),
});

const CreateUserSchema = z.object({
  username: z.string().trim().min(2).max(40).regex(/^[a-zA-Z0-9_\u4e00-\u9fa5-]+$/),
  password: z.string().min(8).max(128),
  role: z.enum(["admin", "member"]).default("member"),
});

const ResetPasswordSchema = z.object({
  password: z.string().min(8).max(128),
});

/** 公开写接口要求 Content-Type 为 application/json，防浏览器 text/plain 简单请求跨站 CSRF。 */
function requireJsonContentType(c: Context): void {
  const ct = (c.req.header("content-type") ?? "").toLowerCase();
  if (!ct.includes("application/json")) {
    throw new AppError(415, "UNSUPPORTED_MEDIA_TYPE", "请求头 Content-Type 必须为 application/json");
  }
}

export function registerPublicAuthRoutes(app: Hono, ctx: ServerContext): void {
  app.get("/api/health", (c) => {
    const db = ctx.getDb();
    const row = db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number };
    const snap = ctx.templates.current();
    return c.json({
      ok: true,
      initialized: row.n > 0,
      templateVersion: snap.version,
      templateHash: snap.templateHash,
      serverNow: ctx.now().toISOString(),
    });
  });

  app.post("/api/setup/init", async (c) => {
    requireJsonContentType(c);
    const now = ctx.now();
    const ip = getClientIp(c, ctx.config);
    const wait = ctx.setupLimiter.check(`setup:${ip}`, now.getTime());
    if (wait !== null) {
      c.header("Retry-After", String(wait));
      throw new AppError(429, "RATE_LIMITED", `请求过于频繁，请 ${wait} 秒后再试`);
    }
    ctx.setupLimiter.hit(`setup:${ip}`, now.getTime());

    const body = SetupSchema.parse(await c.req.json());
    const pwErr = validatePassword(body.password);
    if (pwErr) throw new AppError(400, "WEAK_PASSWORD", pwErr);

    const passwordHash = await hashPassword(body.password, ctx.scrypt);
    const db = ctx.getDb();

    const created = withTransaction(db, () => {
      const cnt = db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number };
      if (cnt.n > 0) {
        throw new AppError(409, "ALREADY_INITIALIZED", "系统已完成初始化，请直接登录");
      }
      const userId = newId();
      const nowIso = now.toISOString();
      db.prepare(
        "INSERT INTO users (id, username, password_hash, role, created_at) VALUES (?, ?, ?, 'admin', ?)",
      ).run(userId, body.username, passwordHash, nowIso);

      const sess = createSession(db, {
        userId,
        kind: "web",
        deviceName: body.deviceName || "初始管理员浏览器",
        now,
      });
      writeAuditLog(db, {
        actorUserId: userId,
        actorSessionId: sess.sessionId,
        action: "setup.init",
        fields: ["users"],
        ruleOrReason: "first_admin",
        now,
      });
      return { userId, sess };
    });

    setSessionCookie(c, created.sess.token, ctx.config);
    return c.json(
      {
        ok: true,
        user: { id: created.userId, username: body.username, role: "admin" as const },
        sessionId: created.sess.sessionId,
        expiresAt: created.sess.expiresAt,
        absoluteExpiresAt: created.sess.absoluteExpiresAt,
      },
      201,
    );
  });

  app.post("/api/auth/login", async (c) => {
    requireJsonContentType(c);
    const now = ctx.now();
    const nowMs = now.getTime();
    const ip = getClientIp(c, ctx.config);
    const ipWait = ctx.authLimiter.check(`ip:${ip}`, nowMs);
    if (ipWait !== null) {
      c.header("Retry-After", String(ipWait));
      throw new AppError(429, "RATE_LIMITED", `登录尝试过多，请 ${ipWait} 秒后再试`);
    }

    const body = LoginSchema.parse(await c.req.json());
    const userKey = `user:${body.username.toLowerCase()}`;
    const userWait = ctx.authLimiter.check(userKey, nowMs);
    if (userWait !== null) {
      c.header("Retry-After", String(userWait));
      throw new AppError(429, "RATE_LIMITED", `该账号登录尝试过多，请 ${userWait} 秒后再试`);
    }

    const db = ctx.getDb();
    const user = db
      .prepare("SELECT id, username, password_hash, role, disabled_at FROM users WHERE username = ? COLLATE NOCASE")
      .get(body.username) as
      | { id: string; username: string; password_hash: string; role: "admin" | "member"; disabled_at: string | null }
      | undefined;

    if (!user || user.disabled_at || !(await verifyPassword(body.password, user.password_hash))) {
      ctx.authLimiter.fail(`ip:${ip}`, nowMs);
      ctx.authLimiter.fail(userKey, nowMs);
      throw new AppError(401, "INVALID_CREDENTIALS", "用户名或密码错误");
    }

    ctx.authLimiter.succeed(`ip:${ip}`);
    ctx.authLimiter.succeed(userKey);

    const sess = createSession(db, {
      userId: user.id,
      kind: body.kind,
      deviceName: body.deviceName || (body.kind === "web" ? "网页端" : "手机端"),
      now,
    });
    writeAuditLog(db, {
      actorUserId: user.id,
      actorSessionId: sess.sessionId,
      action: "auth.login",
      fields: [body.kind],
      ruleOrReason: "password_login",
      now,
    });

    if (body.kind === "web") {
      setSessionCookie(c, sess.token, ctx.config);
      return c.json({
        ok: true,
        user: { id: user.id, username: user.username, role: user.role },
        sessionId: sess.sessionId,
        expiresAt: sess.expiresAt,
        absoluteExpiresAt: sess.absoluteExpiresAt,
      });
    }

    return c.json({
      ok: true,
      token: sess.token,
      user: { id: user.id, username: user.username, role: user.role },
      sessionId: sess.sessionId,
      expiresAt: sess.expiresAt,
      absoluteExpiresAt: sess.absoluteExpiresAt,
    });
  });

  app.post("/api/auth/pair", async (c) => {
    requireJsonContentType(c);
    const now = ctx.now();
    const nowMs = now.getTime();
    const ip = getClientIp(c, ctx.config);
    const wait = ctx.pairLimiter.check(`pair:${ip}`, nowMs);
    if (wait !== null) {
      c.header("Retry-After", String(wait));
      throw new AppError(429, "RATE_LIMITED", `扫码绑定尝试过多，请 ${wait} 秒后再试`);
    }

    const body = PairSchema.parse(await c.req.json());
    const norm = normalizePairingCode(body.code);
    if (!/^[0-9a-f]{32}$/.test(norm)) {
      ctx.pairLimiter.fail(`pair:${ip}`, nowMs);
      throw new AppError(401, "PAIRING_CODE_INVALID", "绑定码无效或已过期");
    }

    const codeHash = sha256Hex(norm);
    const db = ctx.getDb();

    const result = withTransaction(db, () => {
      const row = db
        .prepare(
          `SELECT pc.*, p.code AS profile_code
           FROM pairing_codes pc
           JOIN profiles p ON p.id = pc.profile_id
           WHERE pc.code_hash = ?`,
        )
        .get(codeHash) as
        | {
            id: string;
            profile_id: string;
            profile_code: string;
            created_by: string;
            expires_at: string;
            used_at: string | null;
          }
        | undefined;

      if (!row || row.used_at || nowMs >= Date.parse(row.expires_at)) {
        ctx.pairLimiter.fail(`pair:${ip}`, nowMs);
        throw new AppError(401, "PAIRING_CODE_INVALID", "绑定码无效、已被使用或已过期（有效期 5 分钟）");
      }

      db.prepare("UPDATE pairing_codes SET used_at = ? WHERE id = ?").run(now.toISOString(), row.id);

      const sess = createSession(db, {
        userId: row.created_by,
        kind: "mobile_bound",
        boundProfileId: row.profile_id,
        deviceName: body.deviceName || `扫码绑定设备（${row.profile_code}）`,
        now,
      });

      writeAuditLog(db, {
        actorUserId: row.created_by,
        actorSessionId: sess.sessionId,
        profileId: row.profile_id,
        action: "auth.pair_redeem",
        fields: ["mobile_bound"],
        ruleOrReason: "pairing_code_redeemed",
        now,
      });

      return {
        token: sess.token,
        sessionId: sess.sessionId,
        profileId: row.profile_id,
        profileCode: row.profile_code,
        expiresAt: sess.expiresAt,
        absoluteExpiresAt: sess.absoluteExpiresAt,
      };
    });

    ctx.pairLimiter.succeed(`pair:${ip}`);
    return c.json({ ok: true, ...result }, 201);
  });
}

export function registerProtectedAuthRoutes(
  app: Hono<{ Variables: { actor: AuthActor } }>,
  ctx: ServerContext,
): void {
  app.get("/api/auth/me", (c) => {
    const actor = c.get("actor");
    const db = ctx.getDb();
    return c.json({
      user: { id: actor.userId, username: actor.username, role: actor.role },
      session: {
        id: actor.sessionId,
        kind: actor.sessionKind,
        boundProfileId: actor.boundProfileId,
      },
      isTeen: actor.sessionKind !== "mobile_bound" && isTeenMemberAccount(db, actor),
    });
  });

  app.post("/api/auth/refresh", (c) => {
    const actor = c.get("actor");
    const db = ctx.getDb();
    const now = ctx.now();
    const res = refreshSession(db, actor.sessionId, now);
    // Web Cookie 会话滑动续期时同步重发 Set-Cookie，避免浏览器 7 天后丢弃 Cookie
    if (actor.viaCookie) {
      const rawToken = getCookie(c, SESSION_COOKIE);
      if (rawToken) {
        const maxAgeSec = Math.max(1, Math.floor((Date.parse(res.expiresAt) - now.getTime()) / 1000));
        setSessionCookie(c, rawToken, ctx.config, maxAgeSec);
      }
    }
    return c.json({ ok: true, ...res });
  });

  app.post("/api/auth/logout", (c) => {
    const actor = c.get("actor");
    const db = ctx.getDb();
    db.prepare("UPDATE auth_sessions SET revoked_at = ? WHERE id = ?").run(ctx.now().toISOString(), actor.sessionId);
    if (actor.viaCookie) clearSessionCookie(c, ctx.config);
    return c.json({ ok: true });
  });

  app.get("/api/auth/devices", (c) => {
    const actor = c.get("actor");
    const db = ctx.getDb();
    const rows =
      actor.role === "admin"
        ? (db
            .prepare(
              `SELECT s.id, s.user_id, s.kind, s.bound_profile_id, s.device_name, s.expires_at, s.absolute_expires_at, s.last_used_at, s.created_at,
                      p.code AS bound_profile_code
               FROM auth_sessions s
               LEFT JOIN profiles p ON p.id = s.bound_profile_id
               WHERE s.revoked_at IS NULL
                 AND (s.user_id = ? OR (s.kind = 'mobile_bound' AND p.is_managed = 1))
               ORDER BY s.last_used_at DESC`,
            )
            .all(actor.userId) as Record<string, unknown>[])
        : (db
            .prepare(
              `SELECT s.id, s.user_id, s.kind, s.bound_profile_id, s.device_name, s.expires_at, s.absolute_expires_at, s.last_used_at, s.created_at,
                      p.code AS bound_profile_code
               FROM auth_sessions s
               LEFT JOIN profiles p ON p.id = s.bound_profile_id
               WHERE s.revoked_at IS NULL AND s.user_id = ?
               ORDER BY s.last_used_at DESC`,
            )
            .all(actor.userId) as Record<string, unknown>[]);

    return c.json({
      devices: rows.map((r) => ({
        id: r.id,
        kind: r.kind,
        boundProfileId: r.bound_profile_id,
        boundProfileCode: r.bound_profile_code ?? null,
        deviceName: r.device_name,
        isCurrent: r.id === actor.sessionId,
        expiresAt: r.expires_at,
        absoluteExpiresAt: r.absolute_expires_at,
        lastUsedAt: r.last_used_at,
        createdAt: r.created_at,
      })),
    });
  });

  app.delete("/api/auth/devices/:id", (c) => {
    const actor = c.get("actor");
    const targetId = c.req.param("id");
    const db = ctx.getDb();
    const row = db
      .prepare(
        `SELECT s.id, s.user_id, s.kind, s.bound_profile_id, p.is_managed, p.owner_user_id
         FROM auth_sessions s
         LEFT JOIN profiles p ON p.id = s.bound_profile_id
         WHERE s.id = ?`,
      )
      .get(targetId) as
      | {
          id: string;
          user_id: string;
          kind: string;
          bound_profile_id: string | null;
          is_managed: number | null;
          owner_user_id: string | null;
        }
      | undefined;

    if (!row) throw new AppError(404, "DEVICE_NOT_FOUND", "找不到对应设备会话");
    const canRevoke =
      row.user_id === actor.userId ||
      (actor.role === "admin" && row.kind === "mobile_bound" && row.is_managed === 1) ||
      (row.kind === "mobile_bound" && row.owner_user_id === actor.userId);
    if (!canRevoke) throw new AppError(403, "FORBIDDEN", "无权吊销该设备会话");

    const now = ctx.now();
    db.prepare("UPDATE auth_sessions SET revoked_at = ? WHERE id = ?").run(now.toISOString(), targetId);
    writeAuditLog(db, {
      actorUserId: actor.userId,
      actorSessionId: actor.sessionId,
      profileId: row.bound_profile_id,
      action: "auth.device_revoke",
      fields: ["auth_sessions.revoked_at"],
      ruleOrReason: row.kind,
      now,
    });
    return c.json({ ok: true });
  });

  // 管理员用户管理
  const requireAdmin = (actor: AuthActor) => {
    if (actor.role !== "admin") throw new AppError(403, "ADMIN_ONLY", "仅管理员可执行此操作");
  };

  app.get("/api/admin/users", (c) => {
    requireAdmin(c.get("actor"));
    const db = ctx.getDb();
    const rows = db
      .prepare("SELECT id, username, role, created_at, disabled_at FROM users ORDER BY created_at ASC")
      .all() as Record<string, unknown>[];
    return c.json({ users: rows });
  });

  app.post("/api/admin/users", async (c) => {
    const actor = c.get("actor");
    requireAdmin(actor);
    const body = CreateUserSchema.parse(await c.req.json());
    const pwErr = validatePassword(body.password);
    if (pwErr) throw new AppError(400, "WEAK_PASSWORD", pwErr);

    const passwordHash = await hashPassword(body.password, ctx.scrypt);
    const db = ctx.getDb();
    const now = ctx.now();

    const user = withTransaction(db, () => {
      const dup = db.prepare("SELECT 1 FROM users WHERE username = ? COLLATE NOCASE").get(body.username);
      if (dup) throw new AppError(409, "USERNAME_EXISTS", "用户名已存在");
      const id = newId();
      db.prepare("INSERT INTO users (id, username, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)").run(
        id,
        body.username,
        passwordHash,
        body.role,
        now.toISOString(),
      );
      writeAuditLog(db, {
        actorUserId: actor.userId,
        actorSessionId: actor.sessionId,
        action: "admin.user_create",
        fields: ["users", body.role],
        ruleOrReason: "admin_create",
        now,
      });
      return { id, username: body.username, role: body.role, createdAt: now.toISOString() };
    });

    return c.json({ ok: true, user }, 201);
  });

  app.post("/api/admin/users/:id/reset-password", async (c) => {
    const actor = c.get("actor");
    requireAdmin(actor);
    const targetId = c.req.param("id");
    const body = ResetPasswordSchema.parse(await c.req.json());
    const pwErr = validatePassword(body.password);
    if (pwErr) throw new AppError(400, "WEAK_PASSWORD", pwErr);

    const passwordHash = await hashPassword(body.password, ctx.scrypt);
    const db = ctx.getDb();
    const now = ctx.now();

    withTransaction(db, () => {
      const target = db.prepare("SELECT id FROM users WHERE id = ?").get(targetId);
      if (!target) throw new AppError(404, "USER_NOT_FOUND", "找不到对应账号");
      db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(passwordHash, targetId);
      // 重置密码后立即吊销该账号全部已有会话
      db.prepare("UPDATE auth_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL").run(
        now.toISOString(),
        targetId,
      );
      writeAuditLog(db, {
        actorUserId: actor.userId,
        actorSessionId: actor.sessionId,
        action: "admin.password_reset",
        fields: ["users.password_hash", "auth_sessions.revoked_at"],
        ruleOrReason: "admin_reset",
        now,
      });
    });

    return c.json({ ok: true });
  });
}
