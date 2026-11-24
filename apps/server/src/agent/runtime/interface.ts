// Agent 运行底座极薄抽象接口（零 SDK 依赖）：
// 首版由 runtime/vercel-ai.ts 实现；未来 DeepSeek Harness (dsh) 发布稳定版后，仅替换此接口实现层即可平滑迁移。
import type { ZodType } from "zod";

export interface AgentMessage {
  role: "user" | "assistant";
  content: string;
}

export interface AgentToolSpec {
  name: string;
  description: string;
  parameters: ZodType;
  execute(args: unknown): Promise<unknown>;
}

export type AgentEvent =
  | { type: "text_delta"; text: string }
  | { type: "tool_call"; toolCallId: string; toolName: string; args: unknown }
  | { type: "tool_result"; toolCallId: string; toolName: string; result: unknown }
  | {
      type: "confirmation_required";
      confirmationId: string;
      toolName: string;
      summary: string;
      preview?: Record<string, unknown>;
      warnings?: { path: string; message: string }[];
    }
  | { type: "circuit_breaker"; toolName: string; message: string }
  | { type: "done"; finishReason: string; text: string }
  | { type: "error"; code: string; message: string };

export interface AgentTurnRequest {
  system: string;
  messages: AgentMessage[];
  tools: AgentToolSpec[];
  maxSteps: number;
  signal: AbortSignal;
}

export interface AgentRuntime {
  readonly id: string;
  streamTurn(req: AgentTurnRequest): AsyncIterable<AgentEvent>;
}
