// Agent 对话管理、SSE 流式对话与两阶段高危确认端点（零 SDK 依赖）。
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { DECLARATION } from "@yangxia/course-core";
import { assertProfileAccess, canPerformOnProfile, isTeenMemberAccount, type AuthActor } from "../auth/permissions.ts";
import type { ServerContext } from "../context.ts";
import { AGENT_DISCLOSURE, MIN_MODEL_REQUIREMENT, type SkillName } from "../agent/prompts/skills.ts";
import { loadAgentLlmConfig } from "../agent/runtime/config.ts";
import { resolveAgentRuntime, resolvePendingConfirmation, runAgentTurn } from "../agent/service.ts";
import {
  createThread,
  deleteThread,
  getOwnedThread,
  listActivePendingConfirmations,
  listMessages,
  listThreads,
} from "../agent/store/threads.ts";
import { AppError } from "../db/lock.ts";

const CreateThreadSchema = z.object({
  profileId: z.string().uuid().nullable().optional(),
  skill: z.enum(["general", "onboard", "course-export", "weekly-review", "assess", "meal-plan"]).default("general"),
  title: z.string().max(80).optional(),
});

const SendMessageSchema = z.object({
  text: z.string().trim().min(1).max(8000),
  skill: z.enum(["general", "onboard", "course-export", "weekly-review", "assess", "meal-plan"]).optional(),
});

const ConfirmActionSchema = z.object({
  confirmationId: z.string().uuid(),
  decision: z.enum(["confirm", "cancel"]),
});

// 用户级 Agent 对话频控（单用户每 5 分钟最多 30 轮，防共享外部模型额度被并发刷耗）
const AGENT_WINDOW_MS = 5 * 60_000;
const AGENT_MAX_PER_WINDOW = 30;

export function registerAgentRoutes(
  app: Hono<{ Variables: { actor: AuthActor } }>,
  ctx: ServerContext,
): void {
  const userTurnTimestamps = new Map<string, number[]>();

  function assertAgentQuota(userId: string, nowMs: number) {
    const arr = (userTurnTimestamps.get(userId) ?? []).filter((t) => nowMs - t < AGENT_WINDOW_MS);
    if (arr.length >= AGENT_MAX_PER_WINDOW) {
      throw new AppError(429, "AGENT_RATE_LIMITED", "短时间内对话次数过多，请稍后再试或改用网页端可视表单");
    }
    arr.push(nowMs);
    userTurnTimestamps.set(userId, arr);
  }

  app.get("/api/agent/info", (c) => {
    const db = ctx.getDb();
    let configured = false;
    let provider: string | null = null;
    let model: string | null = null;
    try {
      const cfg = loadAgentLlmConfig(db, ctx.masterKey);
      if (cfg) {
        configured = true;
        provider = cfg.provider;
        model = cfg.model;
      }
    } catch {
      configured = false;
    }
    return c.json({
      configured: configured || !!ctx.agentRuntimeFactory,
      provider,
      model,
      declaration: DECLARATION,
      disclosure: AGENT_DISCLOSURE,
      minModelRequirement: MIN_MODEL_REQUIREMENT,
      skills: ["general", "onboard", "course-export", "weekly-review", "assess", "meal-plan"] as SkillName[],
    });
  });

  app.get("/api/agent/threads", (c) => {
    const actor = c.get("actor");
    const profileId = c.req.query("profileId") || undefined;
    const rows = listThreads(ctx.getDb(), actor.userId, profileId);
    return c.json({
      threads: rows.map((r) => ({
        id: r.id,
        profileId: r.profile_id,
        skill: r.skill,
        title: r.title,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      })),
    });
  });

  app.post("/api/agent/threads", async (c) => {
    const actor = c.get("actor");
    const body = CreateThreadSchema.parse(await c.req.json());
    const db = ctx.getDb();
    if (body.profileId) {
      assertProfileAccess(db, actor, body.profileId, "read_basic");
    }
    const row = createThread(db, {
      userId: actor.userId,
      profileId: body.profileId ?? null,
      skill: body.skill,
      title: body.title,
      now: ctx.now(),
    });
    return c.json(
      {
        ok: true,
        thread: {
          id: row.id,
          profileId: row.profile_id,
          skill: row.skill,
          title: row.title,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        },
      },
      201,
    );
  });

  app.get("/api/agent/threads/:id", (c) => {
    const actor = c.get("actor");
    const db = ctx.getDb();
    const thread = getOwnedThread(db, c.req.param("id"), actor.userId);
    const messages = listMessages(db, thread.id, 100);
    const pending = listActivePendingConfirmations(db, thread.id, ctx.now());
    return c.json({
      thread: {
        id: thread.id,
        profileId: thread.profile_id,
        skill: thread.skill,
        title: thread.title,
        createdAt: thread.created_at,
        updatedAt: thread.updated_at,
      },
      messages: messages.map((m) => ({
        id: m.id,
        role: m.role,
        content: JSON.parse(m.content_json),
        createdAt: m.created_at,
      })),
      pendingConfirmations: pending,
    });
  });

  app.delete("/api/agent/threads/:id", (c) => {
    const actor = c.get("actor");
    deleteThread(ctx.getDb(), c.req.param("id"), actor.userId);
    return c.json({ ok: true });
  });

  app.post("/api/agent/threads/:id/messages", async (c) => {
    const actor = c.get("actor");
    const threadId = c.req.param("id");
    const body = SendMessageSchema.parse(await c.req.json());
    // 前置鉴权、档案权限、频控与模型配置校验，防止非法/未配置请求建立空 200 SSE
    const db = ctx.getDb();
    const thread = getOwnedThread(db, threadId, actor.userId);
    if (thread.profile_id) {
      const meta = assertProfileAccess(db, actor, thread.profile_id, "read_basic");
      if (!isTeenMemberAccount(db, actor) && !canPerformOnProfile(actor, meta, "read_basic")) {
        throw new AppError(403, "FORBIDDEN", "无权访问该档案");
      }
    }
    assertAgentQuota(actor.userId, ctx.now().getTime());
    const runtimeOverride = ctx.agentRuntimeFactory ? ctx.agentRuntimeFactory() : undefined;
    const runtime = resolveAgentRuntime(ctx, runtimeOverride);

    const ac = new AbortController();
    const reqSignal = c.req.raw.signal;
    if (reqSignal) {
      if (reqSignal.aborted) ac.abort("client_disconnected");
      else reqSignal.addEventListener("abort", () => ac.abort("client_disconnected"), { once: true });
    }

    return streamSSE(c, async (stream) => {
      stream.onAbort(() => {
        ac.abort("sse_closed");
      });
      for await (const ev of runAgentTurn(ctx, actor, {
        threadId,
        userText: body.text,
        skill: body.skill,
        signal: ac.signal,
        runtimeOverride: runtime,
      })) {
        if (ac.signal.aborted) break;
        await stream.writeSSE({
          event: ev.type,
          data: JSON.stringify(ev),
        });
      }
    });
  });

  app.post("/api/agent/threads/:id/confirm", async (c) => {
    const actor = c.get("actor");
    const threadId = c.req.param("id");
    const body = ConfirmActionSchema.parse(await c.req.json());
    const result = await resolvePendingConfirmation(ctx, actor, {
      threadId,
      confirmationId: body.confirmationId,
      decision: body.decision,
    });
    return c.json({ ok: true, result });
  });
}
