// Hono 应用工厂：统一异常处理、安全响应头、公开/受保护路由装配与可选静态前端托管。
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

export function createApp(ctx: ServerContext): Hono {
  const app = new Hono();

  // 基础安全头
  app.use("*", async (c, next) => {
    await next();
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Referrer-Policy", "same-origin");
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

  return app;
}
