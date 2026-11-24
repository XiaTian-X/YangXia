// 认证会话、滑动续期、Cookie CSRF 防护、受信任反代检测与 mobile_bound 路由白名单中间件。
import type { Context, MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { DatabaseSync } from "node:sqlite";
import type { ServerConfig } from "../config.ts";
import { generateOpaqueToken, newId, sha256Hex } from "../crypto/tokens.ts";
import { AppError } from "../db/lock.ts";
import { isAllowedForMobileBound, type AuthActor, type SessionKind } from "./permissions.ts";

export const SESSION_COOKIE = "yx_session";

const DAY_MS = 86_400_000;
export const SESSION_TTL: Record<SessionKind, { slidingMs: number; absoluteMs: number }> = {
  web: { slidingMs: 7 * DAY_MS, absoluteMs: 30 * DAY_MS },
  mobile_account: { slidingMs: 30 * DAY_MS, absoluteMs: 180 * DAY_MS },
  mobile_bound: { slidingMs: 30 * DAY_MS, absoluteMs: 180 * DAY_MS },
};

export interface AuthSessionRow {
  id: string;
  token_hash: string;
  user_id: string;
  kind: SessionKind;
  bound_profile_id: string | null;
  device_name: string;
  expires_at: string;
  absolute_expires_at: string;
  revoked_at: string | null;
  last_used_at: string;
  created_at: string;
  username: string;
  role: "admin" | "member";
  disabled_at: string | null;
}

export function createSession(
  db: DatabaseSync,
  input: {
    userId: string;
    kind: SessionKind;
    boundProfileId?: string | null;
    deviceName?: string;
    now?: Date;
  },
): { sessionId: string; token: string; expiresAt: string; absoluteExpiresAt: string } {
  const now = input.now ?? new Date();
  const ttl = SESSION_TTL[input.kind];
  const sessionId = newId();
  const token = generateOpaqueToken();
  const tokenHash = sha256Hex(token);
  const expiresAt = new Date(now.getTime() + ttl.slidingMs).toISOString();
  const absoluteExpiresAt = new Date(now.getTime() + ttl.absoluteMs).toISOString();
  const nowIso = now.toISOString();

  db.prepare(
    `INSERT INTO auth_sessions
      (id, token_hash, user_id, kind, bound_profile_id, device_name, expires_at, absolute_expires_at, last_used_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    sessionId,
    tokenHash,
    input.userId,
    input.kind,
    input.boundProfileId ?? null,
    (input.deviceName ?? "").trim().slice(0, 80),
    expiresAt,
    absoluteExpiresAt,
    nowIso,
    nowIso,
  );
  return { sessionId, token, expiresAt, absoluteExpiresAt };
}

/** 滑动续期：校验未吊销、未超绝对上限，延长 expires_at 但永不突破 absolute_expires_at。 */
export function refreshSession(
  db: DatabaseSync,
  sessionId: string,
  now = new Date(),
): { expiresAt: string; absoluteExpiresAt: string } {
  const row = db
    .prepare(
      `SELECT s.*, u.disabled_at FROM auth_sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.id = ?`,
    )
    .get(sessionId) as (AuthSessionRow & { disabled_at: string | null }) | undefined;
  if (!row || row.revoked_at || row.disabled_at) {
    throw new AppError(401, "SESSION_REVOKED", "登录已失效，请重新登录");
  }
  const nowMs = now.getTime();
  const expMs = Date.parse(row.expires_at);
  const absMs = Date.parse(row.absolute_expires_at);
  if (nowMs >= expMs || nowMs >= absMs) {
    throw new AppError(401, "SESSION_EXPIRED", "登录已过期，请重新登录");
  }
  const ttl = SESSION_TTL[row.kind];
  const nextMs = Math.min(absMs, nowMs + ttl.slidingMs);
  const nextIso = new Date(nextMs).toISOString();
  db.prepare("UPDATE auth_sessions SET expires_at = ?, last_used_at = ? WHERE id = ?").run(
    nextIso,
    now.toISOString(),
    sessionId,
  );
  return { expiresAt: nextIso, absoluteExpiresAt: row.absolute_expires_at };
}

function getDirectRemoteIp(c: Context): string | undefined {
  const env = c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined;
  const addr = env?.incoming?.socket?.remoteAddress?.trim();
  return addr || undefined;
}

/**
 * 提取真实客户端 IP：
 * - 仅当直连远端 socket IP 命中 TRUSTED_PROXIES 时采信 X-Forwarded-For；
 * - 从右向左剥离受信任反代，取最右侧首个非受信任 IP（防止客户端伪造最左侧 X-Forwarded-For 绕过限速）；
 * - 直连地址缺失时视为不可信并回退 "unknown"（绝不回退 127.0.0.1）。
 */
export function getClientIp(c: Context, config: ServerConfig): string {
  const directIp = getDirectRemoteIp(c);
  if (!directIp) return "unknown";
  if (config.trustedProxies.isTrusted(directIp)) {
    const xff = c.req.header("x-forwarded-for");
    if (xff) {
      const chain = xff
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      for (let i = chain.length - 1; i >= 0; i--) {
        if (!config.trustedProxies.isTrusted(chain[i])) return chain[i];
      }
      if (chain.length > 0) return chain[0];
    }
  }
  return directIp;
}

/** 是否经 HTTPS 访问（直连 HTTPS，或直连远端命中 TRUSTED_PROXIES 且 X-Forwarded-Proto=https）。 */
export function isHttpsRequest(c: Context, config: ServerConfig): boolean {
  if (c.req.url.startsWith("https://")) return true;
  const directIp = getDirectRemoteIp(c);
  if (directIp && config.trustedProxies.isTrusted(directIp)) {
    const proto = c.req.header("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase();
    if (proto === "https") return true;
  }
  return false;
}

export function setSessionCookie(c: Context, token: string, config: ServerConfig, maxAgeSec = 7 * 86400): void {
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "Lax",
    secure: isHttpsRequest(c, config),
    path: "/",
    maxAge: Math.max(1, Math.floor(maxAgeSec)),
  });
}

export function clearSessionCookie(c: Context, config: ServerConfig): void {
  deleteCookie(c, SESSION_COOKIE, {
    httpOnly: true,
    sameSite: "Lax",
    secure: isHttpsRequest(c, config),
    path: "/",
  });
}

/** 期望的当前请求 Origin（用于 Cookie CSRF 同源校验，经 URL.origin 归一化默认端口，仅受信任反代可覆盖 Host/Proto）。 */
function expectedOrigin(c: Context, config: ServerConfig): string {
  const url = new URL(c.req.url);
  const directIp = getDirectRemoteIp(c);
  let proto = url.protocol;
  let host = c.req.header("host") || url.host;
  if (directIp && config.trustedProxies.isTrusted(directIp)) {
    const fProto = c.req.header("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase();
    const fHost = c.req.header("x-forwarded-host")?.split(",")[0]?.trim();
    if (fProto === "https" || fProto === "http") proto = `${fProto}:`;
    if (fHost) host = fHost;
  }
  try {
    return new URL(`${proto}//${host}`).origin;
  } catch {
    return `${proto}//${host}`;
  }
}

export function verifyCookieCsrf(c: Context, config: ServerConfig): void {
  const method = c.req.method.toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return;

  if (c.req.header("x-yangxia-csrf") !== "1") {
    throw new AppError(403, "CSRF_REJECTED", "缺少防跨站请求头 X-YangXia-CSRF");
  }
  const origin = c.req.header("origin");
  const referer = c.req.header("referer");
  const expected = expectedOrigin(c, config).toLowerCase();

  let actualOrigin: string | null = null;
  if (origin) {
    try {
      actualOrigin = new URL(origin).origin.toLowerCase();
    } catch {
      throw new AppError(403, "CSRF_REJECTED", "非法 Origin 头");
    }
  } else if (referer) {
    try {
      actualOrigin = new URL(referer).origin.toLowerCase();
    } catch {
      throw new AppError(403, "CSRF_REJECTED", "非法 Referer 头");
    }
  }
  if (!actualOrigin || actualOrigin !== expected) {
    throw new AppError(403, "CSRF_REJECTED", "跨站请求已被拦截");
  }
}

export function createAuthMiddleware(
  db: DatabaseSync,
  config: ServerConfig,
  getNow: () => Date,
): MiddlewareHandler<{ Variables: { actor: AuthActor } }> {
  return async (c, next) => {
    const authHeader = c.req.header("authorization");
    let rawToken: string | undefined;
    let viaCookie = false;

    if (authHeader && /^Bearer\s+/i.test(authHeader)) {
      rawToken = authHeader.replace(/^Bearer\s+/i, "").trim();
    } else {
      const ck = getCookie(c, SESSION_COOKIE);
      if (ck) {
        rawToken = ck;
        viaCookie = true;
      }
    }

    if (!rawToken) {
      throw new AppError(401, "UNAUTHENTICATED", "请先登录");
    }

    if (viaCookie) {
      verifyCookieCsrf(c, config);
    }

    const tokenHash = sha256Hex(rawToken);
    const row = db
      .prepare(
        `SELECT s.*, u.username, u.role, u.disabled_at
         FROM auth_sessions s
         JOIN users u ON u.id = s.user_id
         WHERE s.token_hash = ?`,
      )
      .get(tokenHash) as AuthSessionRow | undefined;

    if (!row || row.revoked_at || row.disabled_at) {
      throw new AppError(401, "SESSION_INVALID", "登录已失效，请重新登录");
    }

    const now = getNow();
    const nowMs = now.getTime();
    if (nowMs >= Date.parse(row.expires_at) || nowMs >= Date.parse(row.absolute_expires_at)) {
      throw new AppError(401, "SESSION_EXPIRED", "登录已过期，请重新登录");
    }

    // 温和刷新 last_used_at（距上次超过 5 分钟再写，减少写放大）
    if (nowMs - Date.parse(row.last_used_at) > 5 * 60_000) {
      db.prepare("UPDATE auth_sessions SET last_used_at = ? WHERE id = ?").run(now.toISOString(), row.id);
    }

    const actor: AuthActor = {
      userId: row.user_id,
      username: row.username,
      role: row.role,
      sessionId: row.id,
      sessionKind: row.kind,
      boundProfileId: row.bound_profile_id,
      viaCookie,
    };

    // 扫码绑定设备严格路由白名单拦截
    if (actor.sessionKind === "mobile_bound" && !isAllowedForMobileBound(c.req.method, c.req.path)) {
      throw new AppError(403, "BOUND_DEVICE_FORBIDDEN", "扫码绑定设备仅允许拉取本人课程与提交练习记录");
    }

    c.set("actor", actor);
    await next();
  };
}
