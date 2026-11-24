// 脱敏审计日志：严格按白名单仅记录操作名、变更字段名和系统预设短标签；
// 严禁写入体重、腰围、进食困扰、医生意见或任何自由备注原文。
import type { DatabaseSync } from "node:sqlite";
import { newId } from "../crypto/tokens.ts";

export interface AuditEntry {
  actorUserId?: string | null;
  actorSessionId?: string | null;
  profileId?: string | null;
  action: string;
  fields?: string[];
  ruleOrReason?: string;
  now?: Date;
}

const SAFE_FIELD_RE = /^[a-zA-Z0-9_.\u4e00-\u9fa5\-/]{1,80}$/;
// rule_or_reason 仅允许系统短码/规则标签（不含空白、标点长句或体征数字）
const SAFE_REASON_RE = /^[a-zA-Z0-9_.:->\-\u4e00-\u9fa5/]{1,64}$/;

function sanitizeFieldNames(fields: string[] | undefined): string[] {
  if (!fields?.length) return [];
  const out = new Set<string>();
  for (const raw of fields) {
    const clean = String(raw).trim();
    if (SAFE_FIELD_RE.test(clean)) out.add(clean);
  }
  return [...out].slice(0, 40);
}

/** 仅允许系统预设标签或短规则码；命中体征数字/非白名单字符一律替换为安全占位，绝不存自由文本。 */
function sanitizeRuleReason(raw: string | undefined): string {
  if (!raw) return "";
  const clean = String(raw).trim();
  if (/\d+(?:\.\d+)?\s*(?:kg|公斤|斤|cm|厘米|mmHg)/i.test(clean) || /\d{2,3}\s*\/\s*\d{2,3}/.test(clean)) {
    return "redacted_rule";
  }
  if (!SAFE_REASON_RE.test(clean)) {
    return "system_action";
  }
  return clean;
}

export function writeAuditLog(db: DatabaseSync, entry: AuditEntry): void {
  const fields = sanitizeFieldNames(entry.fields);
  const reason = sanitizeRuleReason(entry.ruleOrReason);
  const nowIso = (entry.now ?? new Date()).toISOString();
  db.prepare(
    `INSERT INTO audit_logs (id, actor_user_id, actor_session_id, profile_id, action, fields_json, rule_or_reason, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    newId(),
    entry.actorUserId ?? null,
    entry.actorSessionId ?? null,
    entry.profileId ?? null,
    entry.action,
    JSON.stringify(fields),
    reason,
    nowIso,
  );
}
