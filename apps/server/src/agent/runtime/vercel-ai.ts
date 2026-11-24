// Vercel AI SDK 适配器（仓库内唯一 import 'ai' 与 '@ai-sdk/*' 的模块）：
// 实现 AgentRuntime 极薄接口；未来迁移至 DeepSeek Harness (dsh) 稳定版时，仅需替换本文件。
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { stepCountIs, streamText, tool, type LanguageModel, type ToolSet } from "ai";
import type { AgentLlmConfig } from "./config.ts";
import type { AgentEvent, AgentRuntime, AgentTurnRequest } from "./interface.ts";

function buildLanguageModel(cfg: AgentLlmConfig): LanguageModel {
  if (cfg.provider === "openai") {
    const provider = createOpenAI({ apiKey: cfg.apiKey, ...(cfg.baseUrl ? { baseURL: cfg.baseUrl } : {}) });
    return provider(cfg.model);
  }
  if (cfg.provider === "anthropic") {
    const provider = createAnthropic({ apiKey: cfg.apiKey, ...(cfg.baseUrl ? { baseURL: cfg.baseUrl } : {}) });
    return provider(cfg.model);
  }
  if (cfg.provider === "deepseek") {
    const provider = createOpenAICompatible({
      name: "deepseek",
      baseURL: cfg.baseUrl || "https://api.deepseek.com/v1",
      apiKey: cfg.apiKey,
    });
    return provider(cfg.model);
  }
  const provider = createOpenAICompatible({
    name: "openai-compatible",
    baseURL: cfg.baseUrl || "http://127.0.0.1:11434/v1",
    apiKey: cfg.apiKey,
  });
  return provider(cfg.model);
}

/** 绝不向客户端透传上游 SDK 原始异常文本（避免泄露 API Key 片段、私网 baseUrl 或内网 IP）。 */
function mapSafeLlmError(err: unknown): { code: string; message: string } {
  const status =
    typeof err === "object" && err !== null && "statusCode" in err
      ? Number((err as { statusCode?: unknown }).statusCode)
      : typeof err === "object" && err !== null && "status" in err
        ? Number((err as { status?: unknown }).status)
        : 0;
  const raw = err instanceof Error ? err.message : String(err ?? "");
  if (status === 401 || status === 403 || /unauthoriz|invalid.?api.?key|forbidden/i.test(raw)) {
    return { code: "LLM_AUTH_ERROR", message: "外部模型服务鉴权失败，请管理员在系统设置页核对 API Key" };
  }
  if (status === 429 || /rate.?limit|quota|too many requests/i.test(raw)) {
    return { code: "LLM_RATE_LIMITED", message: "外部模型服务请求繁忙或配额受限，请稍后再试，或改用网页可视表单" };
  }
  if (/timeout|timed out|ETIMEDOUT/i.test(raw)) {
    return { code: "LLM_TIMEOUT", message: "外部模型服务响应超时，请稍后重试或改用网页可视表单" };
  }
  if (/ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|fetch failed|network/i.test(raw)) {
    return { code: "LLM_UNREACHABLE", message: "无法连接外部模型服务，请管理员检查网络或模型地址配置" };
  }
  return { code: "LLM_STREAM_ERROR", message: "外部模型服务返回异常，请稍后重试或直接改用网页端可视表单" };
}

export class VercelAiRuntime implements AgentRuntime {
  readonly id = "vercel-ai-sdk";
  private readonly cfg: AgentLlmConfig;

  constructor(cfg: AgentLlmConfig) {
    this.cfg = cfg;
  }

  async *streamTurn(req: AgentTurnRequest): AsyncIterable<AgentEvent> {
    const model = buildLanguageModel(this.cfg);
    const toolSet: ToolSet = {};
    for (const spec of req.tools) {
      toolSet[spec.name] = tool({
        description: spec.description,
        inputSchema: spec.parameters,
        execute: async (input) => spec.execute(input),
      });
    }

    const result = streamText({
      model,
      system: req.system,
      messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
      tools: toolSet,
      stopWhen: stepCountIs(req.maxSteps),
      abortSignal: req.signal,
    });

    let fullText = "";
    let finishReason = "stop";

    for await (const part of result.stream) {
      if (req.signal.aborted) return;
      if (part.type === "text-delta") {
        fullText += part.text;
        yield { type: "text_delta", text: part.text };
      } else if (part.type === "tool-call") {
        yield {
          type: "tool_call",
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          args: part.input,
        };
      } else if (part.type === "tool-result") {
        yield {
          type: "tool_result",
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          result: part.output,
        };
      } else if (part.type === "tool-error") {
        // SDK 级工具参数校验失败不走 execute：转为失败 tool_result 供编排器计入连续 3 次失败熔断
        yield {
          type: "tool_result",
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          result: { ok: false, code: "SDK_TOOL_ARGS_ERROR", message: "模型传入的工具参数不符合格式要求" },
        };
      } else if (part.type === "finish") {
        finishReason = part.finishReason ?? "stop";
      } else if (part.type === "error") {
        const safe = mapSafeLlmError(part.error);
        yield { type: "error", code: safe.code, message: safe.message };
        return;
      }
    }

    if (req.signal.aborted) return;
    yield { type: "done", finishReason, text: fullText };
  }
}
