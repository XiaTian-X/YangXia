// 外部大模型配置加载（零 SDK 依赖）：统一从 app_settings 读取并用宿主机 master.key 解密 API Key。
import type { DatabaseSync } from "node:sqlite";
import { decryptSecret } from "../../crypto/master-key.ts";
import { AppError } from "../../db/lock.ts";

export type AgentProviderId = "deepseek" | "openai" | "anthropic" | "openai-compatible";

export interface AgentLlmConfig {
  provider: AgentProviderId;
  model: string;
  baseUrl?: string;
  apiKey: string;
}

const DEFAULT_MODEL_BY_PROVIDER: Record<AgentProviderId, string> = {
  deepseek: "deepseek-chat",
  openai: "gpt-4o-mini",
  anthropic: "claude-sonnet-4-20250514",
  "openai-compatible": "deepseek-chat",
};

/** 从 app_settings 读取当前外部模型配置并用宿主机 master.key 解密 API Key（强制 is_secret=1）。 */
export function loadAgentLlmConfig(db: DatabaseSync, masterKey: Buffer): AgentLlmConfig | null {
  const rows = db
    .prepare("SELECT key, value_enc, iv, tag, is_secret FROM app_settings WHERE key LIKE 'agent.%'")
    .all() as { key: string; value_enc: string; iv: string; tag: string; is_secret: number }[];
  const map = new Map(rows.map((r) => [r.key, r]));

  const apiKeyRow = map.get("agent.apiKey");
  if (!apiKeyRow) return null;
  if (apiKeyRow.is_secret !== 1 || !apiKeyRow.iv || !apiKeyRow.tag) {
    throw new AppError(500, "AGENT_KEY_STORAGE_INVALID", "外部模型 API Key 存储状态异常，请在系统设置页重新保存");
  }
  let apiKey: string;
  try {
    apiKey = decryptSecret(masterKey, { valueEnc: apiKeyRow.value_enc, iv: apiKeyRow.iv, tag: apiKeyRow.tag });
  } catch {
    throw new AppError(500, "AGENT_KEY_DECRYPT_FAILED", "外部模型 API Key 无法解密，请在系统设置页重新填写");
  }
  if (!apiKey.trim()) return null;

  const rawProvider = map.get("agent.provider")?.value_enc ?? "deepseek";
  const provider: AgentProviderId =
    rawProvider === "openai" || rawProvider === "anthropic" || rawProvider === "openai-compatible"
      ? rawProvider
      : "deepseek";
  const model = map.get("agent.model")?.value_enc?.trim() || DEFAULT_MODEL_BY_PROVIDER[provider];
  const baseUrl = map.get("agent.baseUrl")?.value_enc?.trim() || undefined;

  return { provider, model, baseUrl, apiKey: apiKey.trim() };
}
