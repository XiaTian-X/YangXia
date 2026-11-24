// 模板只读接口（正文、图解 SVG 强制 CSP sandbox）与管理员原子热重载。
import { readFileSync } from "node:fs";
import { extname } from "node:path";
import { Hono } from "hono";
import { DECLARATION } from "@yangxia/course-core";
import type { AuthActor } from "../auth/permissions.ts";
import type { ServerContext } from "../context.ts";
import { AppError } from "../db/lock.ts";

const CONTENT_TYPES: Record<string, string> = {
  ".svg": "image/svg+xml; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};

export function registerTemplateRoutes(
  app: Hono<{ Variables: { actor: AuthActor } }>,
  ctx: ServerContext,
): void {
  app.get("/api/templates/meta", (c) => {
    const snap = ctx.templates.current();
    return c.json({
      version: snap.version,
      templateHash: snap.templateHash,
      loadedAt: snap.loadedAt,
      declaration: DECLARATION,
      docs: snap.listDocs(),
      manifest: snap.manifest,
    });
  });

  app.get("/api/templates/docs/:name", (c) => {
    const name = c.req.param("name");
    const snap = ctx.templates.current();
    const content = snap.readDoc(name);
    if (content === null) {
      throw new AppError(404, "TEMPLATE_DOC_NOT_FOUND", `找不到模板文档：${name}`);
    }
    return c.json({
      name,
      version: snap.version,
      declaration: DECLARATION,
      content,
    });
  });

  app.get("/api/templates/img/:file", (c) => {
    const file = c.req.param("file");
    const snap = ctx.templates.current();
    const resolved = snap.resolveImage(file);
    if (!resolved) {
      throw new AppError(404, "TEMPLATE_IMAGE_NOT_FOUND", `找不到模板图片：${file}`);
    }
    const ext = extname(resolved).toLowerCase();
    const contentType = CONTENT_TYPES[ext] ?? "application/octet-stream";
    const bytes = readFileSync(resolved);

    // 架构 3.3 硬安全要求：SVG 强制沙箱 CSP 与 nosniff，彻底杜绝内联脚本执行
    return new Response(bytes, {
      status: 200,
      headers: {
        "Content-Type": contentType,
        "Content-Security-Policy": "default-src 'none'; sandbox",
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, max-age=3600",
      },
    });
  });

  app.post("/api/admin/templates/reload", async (c) => {
    const actor = c.get("actor");
    if (actor.role !== "admin") {
      throw new AppError(403, "ADMIN_ONLY", "仅管理员可重载模板");
    }
    const result = await ctx.templates.reload(() => ctx.getDb(), actor, ctx.now());
    return c.json({ ok: true, ...result });
  });
}
