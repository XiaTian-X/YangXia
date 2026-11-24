// Hono 应用工厂：统一异常处理、安全响应头、公开/受保护路由装配与静态前端 SPA 托管。
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { ZodError } from "zod";
import { createAuthMiddleware } from "./auth/middleware.ts";
import type { AuthActor } from "./auth/permissions.ts";
import type { ServerContext } from "./context.ts";
import { AppError } from "./db/lock.ts";
import { registerAgentRoutes } from "./routes/agent.ts";
import { registerProtectedAuthRoutes, registerPublicAuthRoutes } from "./routes/auth.ts";
import { registerMobileRoutes } from "./routes/mobile.ts";
import { registerOpsRoutes } from "./routes/ops.ts";
import { registerProfileRoutes } from "./routes/profiles.ts";
import { registerTemplateRoutes } from "./routes/templates.ts";

const STATIC_MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

const DEFAULT_WEB_DIST = resolve(fileURLToPath(new URL("../../web/dist", import.meta.url)));

const SPA_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'";

function safeStaticFile(rootDir: string, reqPath: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(reqPath);
  } catch {
    return null;
  }
  const clean = decoded.replace(/^\/+/, "");
  if (!clean || clean.includes("\0") || clean.includes("..")) return null;
  const full = resolve(rootDir, clean);
  if (!full.startsWith(rootDir + "/") && full !== rootDir) return null;
  if (!existsSync(full)) return null;
  try {
    const realRoot = realpathSync(rootDir);
    const realFull = realpathSync(full);
    if (!realFull.startsWith(realRoot + "/") && realFull !== realRoot) return null;
    if (!statSync(realFull).isFile()) return null;
    return realFull;
  } catch {
    return null;
  }
}

export function createApp(ctx: ServerContext): Hono {
  const app = new Hono();

  // 基础安全头（防 MIME 嗅探、点击劫持与跨站引用泄漏）
  app.use("*", async (c, next) => {
    await next();
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Referrer-Policy", "same-origin");
    c.header("X-Frame-Options", "DENY");
  });

  // 统一错误映射（不向客户端暴露堆栈或敏感字段）
  app.onError((err, c) => {
    if (err instanceof AppError) {
      return c.json(
        {
          ok: false,
          code: err.code,
          message: err.message,
          ...(err.details !== undefined ? { details: err.details } : {}),
        },
        err.status as ContentfulStatusCode,
      );
    }
    if (err instanceof ZodError) {
      return c.json(
        {
          ok: false,
          code: "INVALID_REQUEST",
          message: "请求参数格式不正确",
          details: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
        },
        400,
      );
    }
    if (err instanceof SyntaxError) {
      return c.json({ ok: false, code: "INVALID_JSON", message: "请求体不是合法 JSON" }, 400);
    }
    console.error("[yangxia-server]", err);
    return c.json({ ok: false, code: "INTERNAL_ERROR", message: "服务器内部错误" }, 500);
  });

  // 公开路由
  registerPublicAuthRoutes(app, ctx);

  // 受保护 API 路由（仅挂载 /api/*，避免遮挡后续阶段 4 托管的静态页面路径；动态取 ctx.getDb() 兼容在线恢复热切换）
  const dynamicAuthed = new Hono<{ Variables: { actor: AuthActor } }>();
  dynamicAuthed.use("/api/*", async (c, next) => {
    const mw = createAuthMiddleware(ctx.getDb(), ctx.config, ctx.now);
    return mw(c, next);
  });

  registerProtectedAuthRoutes(dynamicAuthed, ctx);
  registerProfileRoutes(dynamicAuthed, ctx);
  registerMobileRoutes(dynamicAuthed, ctx);
  registerTemplateRoutes(dynamicAuthed, ctx);
  registerOpsRoutes(dynamicAuthed, ctx);
  registerAgentRoutes(dynamicAuthed, ctx);

  app.route("/", dynamicAuthed);

  // 未命中的 /api/* 统一返回 JSON 404，绝不回落至 HTML
  app.all("/api/*", (c) => c.json({ ok: false, code: "NOT_FOUND", message: "接口不存在" }, 404));

  // 静态前端 SPA 托管（已构建 apps/web/dist 时生效）
  const webDistDir = resolve(process.env.YANGXIA_WEB_DIST || DEFAULT_WEB_DIST);
  app.get("*", (c) => {
    if (!existsSync(webDistDir)) {
      return c.text("养夏服务端已启动。请先运行 npm run build:web 构建网页管理端。", 200);
    }
    const reqPath = c.req.path;
    const direct = safeStaticFile(webDistDir, reqPath);
    if (direct) {
      const ext = extname(direct).toLowerCase();
      const cache = reqPath.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache";
      return new Response(readFileSync(direct), {
        status: 200,
        headers: {
          "Content-Type": STATIC_MIME[ext] ?? "application/octet-stream",
          "Cache-Control": cache,
          "X-Content-Type-Options": "nosniff",
          "X-Frame-Options": "DENY",
          ...(ext === ".svg" ? { "Content-Security-Policy": "default-src 'none'; sandbox" } : {}),
        },
      });
    }
    const indexHtml = join(webDistDir, "index.html");
    if (!existsSync(indexHtml)) {
      return c.text("网页管理端尚未构建（缺少 index.html）", 404);
    }
    return new Response(readFileSync(indexHtml), {
      status: 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-cache",
        "X-Content-Type-Options": "nosniff",
        "X-Frame-Options": "DENY",
        "Content-Security-Policy": SPA_CSP,
      },
    });
  });

  return app;
}
