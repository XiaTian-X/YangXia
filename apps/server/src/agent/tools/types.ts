// 受控业务工具类型定义（纯 Zod + 领域层接口，严禁依赖任何 Agent SDK）。
import type { z } from "zod";
import type { AuthActor } from "../../auth/permissions.ts";
import type { ServerContext } from "../../context.ts";

export interface ConfirmationStageHook {
  stageConfirmation(input: {
    toolName: string;
    profileId: string | null;
    expectedVersion?: number | null;
    summary: string;
    preview?: Record<string, unknown>;
    payload: unknown;
    warnings?: { path: string; message: string }[];
  }): { confirmationId: string };
}

export interface ToolContext {
  actor: AuthActor;
  threadId: string;
  /** 由鉴权会话与对话记录绑定的档案 ID（建档前可为 null）；模型不可作为入参覆盖。 */
  profileId: string | null;
  ctx: ServerContext;
  /** 在 Agent 对话轮次中为 true，高危写操作自动落两阶段确认卡；用户在确认接口点击确认时为 false。 */
  enforceTwoPhaseConfirm: boolean;
  /** 用户确认提交时从待确认卡透传的档案乐观锁版本，防 TOCTOU 覆盖或静默抹除迟到冲突。 */
  expectedVersion?: number;
  confirmHook?: ConfirmationStageHook;
  onBindProfile?: (profileId: string) => void;
}

export interface ToolExecutionResult {
  ok: boolean;
  code?: string;
  message?: string;
  data?: unknown;
  issues?: unknown[];
  pendingConfirmation?: boolean;
  confirmationId?: string;
  summary?: string;
  preview?: Record<string, unknown>;
}

export interface BusinessToolDef<TArgs = unknown> {
  name: string;
  description: string;
  readOnly?: boolean;
  /** true 表示在模型自主调用时必须先生成待确认卡，用户显式确认后再正式落库。 */
  highRisk?: boolean;
  parameters: z.ZodType<TArgs>;
  execute(args: TArgs, tctx: ToolContext): Promise<ToolExecutionResult> | ToolExecutionResult;
}
