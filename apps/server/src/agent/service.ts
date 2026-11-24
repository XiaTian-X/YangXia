// Agent 编排服务（零 SDK 依赖）：
// - 强制步数上限 maxSteps=8、单轮超时 90s、同一工具连续校验失败 3 次（含 SDK tool-error）自动熔断引导网页可视表单；
// - SSE 断开或主动取消立即触发 AbortSignal 中断上游模型；
// - 高危写入强制落两阶段确认卡，绑定 expectedVersion 乐观锁与防盲签 preview，确认时原子抢占 processing 防并发重放；
// - 只读权限成员（13–17 岁及其他无 manage 权限代管成员）仅暴露安全只读工具；已绑档对话禁止调用 create_profile。
import { assertProfileAccess, canPerformOnProfile, isTeenMemberAccount, type AuthActor } from "../auth/permissions.ts";
import type { ServerContext } from "../context.ts";
import { AppError } from "../db/lock.ts";
import { buildSystemPrompt, type SkillName } from "./prompts/skills.ts";
import { loadAgentLlmConfig } from "./runtime/config.ts";
import type { AgentEvent, AgentMessage, AgentRuntime, AgentToolSpec } from "./runtime/interface.ts";
import { VercelAiRuntime } from "./runtime/vercel-ai.ts";
import {
  appendMessage,
  bindThreadProfile,
  claimPendingConfirmation,
  cleanupExpiredThreads,
  createPendingConfirmation,
  finishProcessingConfirmation,
  getOwnedThread,
  getPendingConfirmation,
  listRecentConversationMessages,
  markConfirmationStatusIfPending,
} from "./store/threads.ts";
import { ALL_BUSINESS_TOOLS, BUSINESS_TOOL_MAP } from "./tools/registry.ts";
import type { ToolContext, ToolExecutionResult } from "./tools/types.ts";

export const AGENT_MAX_STEPS = 8;
export const AGENT_TURN_TIMEOUT_MS = 90_000;
export const TOOL_CONSECUTIVE_FAILURE_LIMIT = 3;
const MAX_HISTORY_CHARS = 24_000;

export interface RunAgentTurnOptions {
  threadId: string;
  userText: string;
  skill?: SkillName;
  signal: AbortSignal;
  runtimeOverride?: AgentRuntime;
  turnTimeoutMs?: number;
}

const activeThreadTurns = new Set<string>();

export function resolveAgentRuntime(ctx: ServerContext, override?: AgentRuntime): AgentRuntime {
  if (override) return override;
  const cfg = loadAgentLlmConfig(ctx.getDb(), ctx.masterKey);
  if (!cfg) {
    throw new AppError(
      400,
      "AGENT_NOT_CONFIGURED",
      "尚未配置外部大模型 API Key：请先在系统设置页配置模型服务，或直接使用网页端可视表单完成全部操作",
    );
  }
  return new VercelAiRuntime(cfg);
}

/** 提取最近对话历史（user/assistant 以及确认/取消系统摘要），按总字符数预算裁剪且保底保留最新一条用户消息。 */
function loadConversationHistory(ctx: ServerContext, threadId: string): AgentMessage[] {
  const rows = listRecentConversationMessages(ctx.getDb(), threadId, 40);
  const parsed: AgentMessage[] = [];
  for (const r of rows) {
    try {
      const obj = JSON.parse(r.content_json) as { text?: string };
      if (typeof obj?.text !== "string" || !obj.text.trim()) continue;
      if (r.role === "user" || r.role === "assistant") {
        parsed.push({ role: r.role, content: obj.text });
      } else if (r.role === "system") {
        // 将用户点击确认或取消的结果作为上下文回灌，让模型感知高危操作最终去向
        parsed.push({ role: "user", content: `[系统记录] ${obj.text}` });
      }
    } catch {
      /* ignore malformed history */
    }
  }
  const kept: AgentMessage[] = [];
  let chars = 0;
  for (let i = parsed.length - 1; i >= 0; i--) {
    const m = parsed[i];
    if (kept.length > 0 && chars + m.content.length > MAX_HISTORY_CHARS) break;
    kept.push(m);
    chars += m.content.length;
  }
  return kept.reverse();
}

export async function* runAgentTurn(
  ctx: ServerContext,
  actor: AuthActor,
  opts: RunAgentTurnOptions,
): AsyncIterable<AgentEvent> {
  if (activeThreadTurns.has(opts.threadId)) {
    throw new AppError(409, "THREAD_BUSY", "当前对话正在生成回复，请等待本轮结束或点击停止后再发送");
  }
  activeThreadTurns.add(opts.threadId);

  try {
    const db = ctx.getDb();
    const thread = getOwnedThread(db, opts.threadId, actor.userId);
    const teenAccount = isTeenMemberAccount(db, actor);
    let readOnlyMode = teenAccount;

    // 确认调用者对绑定档案仍具有合法权限，统一按 manage 能力判定只读模式
    if (thread.profile_id) {
      const meta = assertProfileAccess(db, actor, thread.profile_id, "read_basic");
      if (!canPerformOnProfile(actor, meta, "manage")) {
        readOnlyMode = true;
      }
    }

    // 清理过期历史对话（排除当前活跃对话，杜绝外键级联崩流）
    const retentionRow = db
      .prepare("SELECT value_enc FROM app_settings WHERE key = 'agent.retentionDays' AND is_secret = 0")
      .get() as { value_enc: string } | undefined;
    const retentionDays = retentionRow ? Number(retentionRow.value_enc) : 0;
    if (retentionDays > 0) {
      cleanupExpiredThreads(db, retentionDays, ctx.now(), thread.id);
    }

    const runtime = resolveAgentRuntime(ctx, opts.runtimeOverride);

    // 持久化本轮用户消息
    appendMessage(db, {
      threadId: thread.id,
      role: "user",
      content: { text: opts.userText },
      now: ctx.now(),
    });

    const history = loadConversationHistory(ctx, thread.id);
    const skill = opts.skill ?? thread.skill ?? "general";
    const system = buildSystemPrompt(skill);

    // 合并客户端断开信号、90s 单轮超时信号与熔断中止信号
    const turnAbort = new AbortController();
    const onParentAbort = () => turnAbort.abort(opts.signal.reason ?? "client_disconnected");
    if (opts.signal.aborted) turnAbort.abort("client_disconnected");
    else opts.signal.addEventListener("abort", onParentAbort, { once: true });

    const timeoutHandle = setTimeout(() => {
      turnAbort.abort("turn_timeout");
    }, opts.turnTimeoutMs ?? AGENT_TURN_TIMEOUT_MS);

    let currentProfileId = thread.profile_id;
    const consecutiveFailures = new Map<string, number>();
    const stagedConfirmations: Extract<AgentEvent, { type: "confirmation_required" }>[] = [];
    const guardState: { circuitBroken: { toolName: string; message: string } | null } = { circuitBroken: null };
    let totalToolCalls = 0;

    const recordToolOutcome = (toolName: string, ok: boolean) => {
      if (!ok) {
        const count = (consecutiveFailures.get(toolName) ?? 0) + 1;
        consecutiveFailures.set(toolName, count);
        if (count >= TOOL_CONSECUTIVE_FAILURE_LIMIT) {
          guardState.circuitBroken = {
            toolName,
            message: `工具「${toolName}」连续 ${count} 次未通过规则校验，已自动熔断。请改用网页端对应可视表单核对并完成录入。`,
          };
          turnAbort.abort("circuit_breaker");
        }
      } else {
        consecutiveFailures.set(toolName, 0);
      }
    };

    const toolCtx: ToolContext = {
      actor,
      threadId: thread.id,
      get profileId() {
        return currentProfileId;
      },
      ctx,
      enforceTwoPhaseConfirm: true,
      confirmHook: {
        stageConfirmation(input) {
          const row = createPendingConfirmation(ctx.getDb(), {
            threadId: thread.id,
            userId: actor.userId,
            profileId: input.profileId,
            expectedVersion: input.expectedVersion,
            toolName: input.toolName,
            summary: input.summary,
            preview: input.preview,
            payload: input.payload,
            now: ctx.now(),
          });
          stagedConfirmations.push({
            type: "confirmation_required",
            confirmationId: row.id,
            toolName: input.toolName,
            summary: input.summary,
            preview: input.preview,
            warnings: input.warnings,
          });
          return { confirmationId: row.id };
        },
      },
      onBindProfile(newPid) {
        if (currentProfileId !== null) return;
        if (bindThreadProfile(ctx.getDb(), thread.id, newPid, ctx.now())) {
          currentProfileId = newPid;
        }
      },
    };

    // 工具裁剪：
    // 1. 只读账号（青少年或仅具 read_basic 成员）仅暴露 readOnly=true 的 3 个安全工具；
    // 2. 已绑档对话移除 create_profile，杜绝模型误创或覆盖改绑。
    const allowedTools = ALL_BUSINESS_TOOLS.filter((t) => {
      if (readOnlyMode && !t.readOnly) return false;
      if (thread.profile_id !== null && t.name === "create_profile") return false;
      return true;
    });

    const wrappedTools: AgentToolSpec[] = allowedTools.map((def) => ({
      name: def.name,
      description: def.description,
      parameters: def.parameters,
      async execute(rawArgs: unknown): Promise<ToolExecutionResult> {
        if (turnAbort.signal.aborted) {
          return { ok: false, code: "ABORTED", message: "对话已中止" };
        }
        totalToolCalls += 1;
        if (totalToolCalls > AGENT_MAX_STEPS * 2) {
          guardState.circuitBroken = {
            toolName: def.name,
            message: "本轮工具调用次数已达上限，为避免死循环已暂停；建议直接前往网页端可视表单继续操作。",
          };
          turnAbort.abort("max_tool_calls");
          return { ok: false, code: "MAX_STEPS_EXCEEDED", message: guardState.circuitBroken.message };
        }

        const parsed = def.parameters.safeParse(rawArgs);
        let res: ToolExecutionResult;
        if (!parsed.success) {
          res = {
            ok: false,
            code: "INVALID_TOOL_ARGS",
            message: "工具参数不符合要求",
            issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
          };
        } else {
          res = await def.execute(parsed.data, toolCtx);
        }

        appendMessage(ctx.getDb(), {
          threadId: thread.id,
          role: "tool",
          content: { toolName: def.name, ok: res.ok, code: res.code, pendingConfirmation: !!res.pendingConfirmation },
          now: ctx.now(),
        });
        recordToolOutcome(def.name, res.ok);
        return res;
      },
    }));

    let assistantText = "";
    let emittedConfirmCount = 0;

    const finalizeCircuitBreaker = async function* (): AsyncIterable<AgentEvent> {
      while (emittedConfirmCount < stagedConfirmations.length) {
        yield stagedConfirmations[emittedConfirmCount++];
      }
      const cb = guardState.circuitBroken!;
      yield { type: "circuit_breaker", toolName: cb.toolName, message: cb.message };
      const finalMsg = assistantText ? `${assistantText}\n\n${cb.message}` : cb.message;
      appendMessage(ctx.getDb(), {
        threadId: thread.id,
        role: "assistant",
        content: { text: finalMsg, circuitBroken: true },
        now: ctx.now(),
      });
      yield { type: "done", finishReason: "circuit_breaker", text: finalMsg };
    };

    try {
      for await (const ev of runtime.streamTurn({
        system,
        messages: history,
        tools: wrappedTools,
        maxSteps: AGENT_MAX_STEPS,
        signal: turnAbort.signal,
      })) {
        while (emittedConfirmCount < stagedConfirmations.length) {
          yield stagedConfirmations[emittedConfirmCount++];
        }
        if (ev.type === "text_delta") {
          assistantText += ev.text;
          yield ev;
        } else if (ev.type === "tool_call") {
          yield ev;
        } else if (ev.type === "tool_result") {
          // 捕获 SDK tool-error（绕过 execute 的参数校验失败）也计入连续 3 次失败熔断，避免与 execute 内重复计数
          const rObj = ev.result as { ok?: boolean; code?: string } | null;
          if (rObj && rObj.ok === false && rObj.code === "SDK_TOOL_ARGS_ERROR") {
            recordToolOutcome(ev.toolName, false);
          }
          yield ev;
        } else if (ev.type === "error") {
          if (!guardState.circuitBroken && !turnAbort.signal.aborted) {
            yield ev;
          }
          break;
        } else if (ev.type === "done") {
          if (!assistantText && ev.text) assistantText = ev.text;
        }
      }

      if (guardState.circuitBroken) {
        yield* finalizeCircuitBreaker();
        return;
      }

      while (emittedConfirmCount < stagedConfirmations.length) {
        yield stagedConfirmations[emittedConfirmCount++];
      }

      if (turnAbort.signal.aborted) {
        const reason = String(turnAbort.signal.reason ?? "aborted");
        if (reason === "turn_timeout") {
          yield { type: "error", code: "TURN_TIMEOUT", message: "本轮模型响应超时（90 秒），请重试或改用网页可视表单" };
        }
        return;
      }

      if (assistantText.trim()) {
        appendMessage(ctx.getDb(), {
          threadId: thread.id,
          role: "assistant",
          content: { text: assistantText },
          now: ctx.now(),
        });
      }
      yield { type: "done", finishReason: "stop", text: assistantText };
    } catch {
      if (guardState.circuitBroken) {
        yield* finalizeCircuitBreaker();
        return;
      }
      if (turnAbort.signal.aborted) {
        if (String(turnAbort.signal.reason) === "turn_timeout") {
          yield { type: "error", code: "TURN_TIMEOUT", message: "本轮模型响应超时（90 秒），请重试或改用网页可视表单" };
        }
        return;
      }
      // 绝不透传未知底层异常原文，防止泄露上游凭据或内网地址
      yield { type: "error", code: "AGENT_RUNTIME_ERROR", message: "外部模型调用异常，请稍后重试或改用网页端可视表单" };
    } finally {
      clearTimeout(timeoutHandle);
      opts.signal.removeEventListener("abort", onParentAbort);
    }
  } finally {
    activeThreadTurns.delete(opts.threadId);
  }
}

/** 用户在界面显式点击「确认并保存」或「取消」后，以原子抢占 + 乐观锁校验执行已暂存的高危写入。 */
export async function resolvePendingConfirmation(
  ctx: ServerContext,
  actor: AuthActor,
  input: { threadId: string; confirmationId: string; decision: "confirm" | "cancel" },
): Promise<ToolExecutionResult> {
  const db = ctx.getDb();
  const thread = getOwnedThread(db, input.threadId, actor.userId);
  if (isTeenMemberAccount(db, actor)) {
    throw new AppError(403, "FORBIDDEN", "青少年账号无权执行高危档案写入");
  }

  const row = getPendingConfirmation(db, input.confirmationId, thread.id, actor.userId);
  if (row.profile_id !== thread.profile_id) {
    throw new AppError(409, "CONFIRMATION_PROFILE_MISMATCH", "确认卡与当前对话绑定的档案不一致，请重新发起操作");
  }
  if (row.profile_id) {
    assertProfileAccess(db, actor, row.profile_id, "manage");
  }
  if (row.status !== "pending") {
    throw new AppError(409, "CONFIRMATION_ALREADY_HANDLED", `该确认卡已处理（当前状态：${row.status}）`);
  }

  const now = ctx.now();
  if (now.getTime() >= Date.parse(row.expires_at)) {
    markConfirmationStatusIfPending(db, row.id, "expired");
    throw new AppError(410, "CONFIRMATION_EXPIRED", "确认卡已过期（超过 15 分钟），请重新发起操作");
  }

  if (input.decision === "cancel") {
    if (!markConfirmationStatusIfPending(db, row.id, "cancelled")) {
      throw new AppError(409, "CONFIRMATION_ALREADY_HANDLED", "该确认卡已被处理");
    }
    appendMessage(ctx.getDb(), {
      threadId: thread.id,
      role: "system",
      content: { text: `用户已取消高危操作：${row.summary}` },
      now,
    });
    return { ok: true, message: "已取消该操作，未对档案做任何修改" };
  }

  // 原子抢占 pending -> processing，彻底杜绝并发双击与重放
  if (!claimPendingConfirmation(db, row.id)) {
    throw new AppError(409, "CONFIRMATION_ALREADY_HANDLED", "该确认卡正在处理或已完成，请勿重复提交");
  }

  const def = BUSINESS_TOOL_MAP.get(row.tool_name);
  if (!def) {
    finishProcessingConfirmation(ctx.getDb(), row.id, "cancelled");
    throw new AppError(500, "UNKNOWN_TOOL", `找不到工具：${row.tool_name}`);
  }

  const payload = JSON.parse(row.payload_json) as unknown;
  const parsed = def.parameters.safeParse(payload);
  if (!parsed.success) {
    finishProcessingConfirmation(ctx.getDb(), row.id, "cancelled");
    throw new AppError(422, "INVALID_CONFIRMATION_PAYLOAD", "确认卡参数校验失败");
  }

  try {
    // 透传 expectedVersion 乐观锁，若期间网页端或手机端同步过修改/迟到不适冲突，自动拒绝覆盖并保住告警
    const commitCtx: ToolContext = {
      actor,
      threadId: thread.id,
      profileId: row.profile_id,
      ctx,
      enforceTwoPhaseConfirm: false,
      expectedVersion: row.expected_version ?? undefined,
      onBindProfile(newPid) {
        bindThreadProfile(ctx.getDb(), thread.id, newPid, now);
      },
    };
    const result = await def.execute(parsed.data, commitCtx);
    if (!result.ok) {
      if (result.code === "VERSION_CONFLICT") {
        finishProcessingConfirmation(ctx.getDb(), row.id, "expired");
        throw new AppError(
          409,
          "VERSION_CONFLICT",
          "确认期间档案已被更新（或收到了新的练习同步/冲突告警），该旧确认卡已自动失效，请刷新查看最新状态后重新操作",
        );
      }
      finishProcessingConfirmation(ctx.getDb(), row.id, "pending");
      throw new AppError(422, result.code ?? "CONFIRM_COMMIT_FAILED", result.message ?? "确认提交未通过规则校验", {
        issues: result.issues,
      });
    }

    finishProcessingConfirmation(ctx.getDb(), row.id, "confirmed");
    appendMessage(ctx.getDb(), {
      threadId: thread.id,
      role: "system",
      content: { text: `用户已确认并完成写入：${row.summary}`, toolName: row.tool_name },
      now,
    });
    return result;
  } catch (err) {
    // 若抛出未预期异常，确保不留卡死的 processing 行
    finishProcessingConfirmation(ctx.getDb(), row.id, "pending");
    throw err;
  }
}
