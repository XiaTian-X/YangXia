// 自有 SQLite 对话存储（agent_threads / agent_messages / agent_pending_confirmations）：
// 与任何 Agent 框架解耦，强制按 user_id 隔离，支持一键清空、原子确认卡状态机与按 retention_days 自动清理。
import type { DatabaseSync } from "node:sqlite";
import { newId } from "../../crypto/tokens.ts";
import { AppError } from "../../db/lock.ts";
import type { SkillName } from "../prompts/skills.ts";

export interface ThreadRow {
  id: string;
  user_id: string;
  profile_id: string | null;
  skill: SkillName;
  title: string;
  created_at: string;
  updated_at: string;
}

export interface MessageRow {
  id: string;
  thread_id: string;
  role: "user" | "assistant" | "tool" | "system";
  content_json: string;
  created_at: string;
}

export interface ConfirmationRow {
  id: string;
  thread_id: string;
  user_id: string;
  profile_id: string | null;
  expected_version: number | null;
  tool_name: string;
  summary: string;
  preview_json: string | null;
  payload_json: string;
  status: "pending" | "processing" | "confirmed" | "cancelled" | "expired";
  expires_at: string;
  created_at: string;
}

export function createThread(
  db: DatabaseSync,
  input: { userId: string; profileId: string | null; skill?: SkillName; title?: string; now?: Date },
): ThreadRow {
  const id = newId();
  const nowIso = (input.now ?? new Date()).toISOString();
  const skill = input.skill ?? "general";
  const title = (input.title?.trim() || "新对话").slice(0, 80);
  db.prepare(
    `INSERT INTO agent_threads (id, user_id, profile_id, skill, title, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, input.userId, input.profileId, skill, title, nowIso, nowIso);
  return { id, user_id: input.userId, profile_id: input.profileId, skill, title, created_at: nowIso, updated_at: nowIso };
}

export function listThreads(db: DatabaseSync, userId: string, profileId?: string): ThreadRow[] {
  if (profileId) {
    return db
      .prepare("SELECT * FROM agent_threads WHERE user_id = ? AND profile_id = ? ORDER BY updated_at DESC LIMIT 50")
      .all(userId, profileId) as unknown as ThreadRow[];
  }
  return db
    .prepare("SELECT * FROM agent_threads WHERE user_id = ? ORDER BY updated_at DESC LIMIT 50")
    .all(userId) as unknown as ThreadRow[];
}

export function getOwnedThread(db: DatabaseSync, threadId: string, userId: string): ThreadRow {
  const row = db.prepare("SELECT * FROM agent_threads WHERE id = ?").get(threadId) as ThreadRow | undefined;
  if (!row) throw new AppError(404, "THREAD_NOT_FOUND", "找不到对应对话");
  if (row.user_id !== userId) throw new AppError(403, "FORBIDDEN", "无权访问其他账号的对话记录");
  return row;
}

/** 仅允许未绑档对话一次性绑定到新建档案，禁止已绑档对话被覆盖改绑。 */
export function bindThreadProfile(db: DatabaseSync, threadId: string, profileId: string, now = new Date()): boolean {
  const res = db
    .prepare("UPDATE agent_threads SET profile_id = ?, updated_at = ? WHERE id = ? AND profile_id IS NULL")
    .run(profileId, now.toISOString(), threadId);
  return Number(res.changes ?? 0) === 1;
}

export function deleteThread(db: DatabaseSync, threadId: string, userId: string): void {
  getOwnedThread(db, threadId, userId);
  db.prepare("DELETE FROM agent_threads WHERE id = ? AND user_id = ?").run(threadId, userId);
}

export function appendMessage(
  db: DatabaseSync,
  input: { threadId: string; role: MessageRow["role"]; content: unknown; now?: Date },
): MessageRow {
  const id = newId();
  const nowIso = (input.now ?? new Date()).toISOString();
  const contentJson = JSON.stringify(input.content);
  db.prepare(
    `INSERT INTO agent_messages (id, thread_id, role, content_json, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(id, input.threadId, input.role, contentJson, nowIso);
  db.prepare("UPDATE agent_threads SET updated_at = ? WHERE id = ?").run(nowIso, input.threadId);
  return { id, thread_id: input.threadId, role: input.role, content_json: contentJson, created_at: nowIso };
}

/** 按时间倒序取最近 limit 条消息，再反转为时间正序返回（避免长对话丢弃最新消息）。 */
export function listMessages(db: DatabaseSync, threadId: string, limit = 100): MessageRow[] {
  const rows = db
    .prepare("SELECT * FROM agent_messages WHERE thread_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?")
    .all(threadId, limit) as unknown as MessageRow[];
  return rows.reverse();
}

/** 专用于拼装模型上下文：取最近 limit 条 user/assistant/system 消息并按正序返回，不被 tool 日志挤出窗口。 */
export function listRecentConversationMessages(db: DatabaseSync, threadId: string, limit = 40): MessageRow[] {
  const rows = db
    .prepare(
      `SELECT * FROM agent_messages
       WHERE thread_id = ? AND role IN ('user', 'assistant', 'system')
       ORDER BY created_at DESC, rowid DESC
       LIMIT ?`,
    )
    .all(threadId, limit) as unknown as MessageRow[];
  return rows.reverse();
}

export function createPendingConfirmation(
  db: DatabaseSync,
  input: {
    threadId: string;
    userId: string;
    profileId: string | null;
    expectedVersion?: number | null;
    toolName: string;
    summary: string;
    preview?: Record<string, unknown>;
    payload: unknown;
    ttlMs?: number;
    now?: Date;
  },
): ConfirmationRow {
  const id = newId();
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const expiresAt = new Date(now.getTime() + (input.ttlMs ?? 15 * 60_000)).toISOString();
  const payloadJson = JSON.stringify(input.payload);
  const previewJson = input.preview ? JSON.stringify(input.preview) : null;
  const expectedVersion = input.expectedVersion ?? null;
  db.prepare(
    `INSERT INTO agent_pending_confirmations
      (id, thread_id, user_id, profile_id, expected_version, tool_name, summary, preview_json, payload_json, status, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
  ).run(
    id,
    input.threadId,
    input.userId,
    input.profileId,
    expectedVersion,
    input.toolName,
    input.summary,
    previewJson,
    payloadJson,
    expiresAt,
    nowIso,
  );
  return {
    id,
    thread_id: input.threadId,
    user_id: input.userId,
    profile_id: input.profileId,
    expected_version: expectedVersion,
    tool_name: input.toolName,
    summary: input.summary,
    preview_json: previewJson,
    payload_json: payloadJson,
    status: "pending",
    expires_at: expiresAt,
    created_at: nowIso,
  };
}

export function getPendingConfirmation(db: DatabaseSync, confirmationId: string, threadId: string, userId: string): ConfirmationRow {
  const row = db
    .prepare("SELECT * FROM agent_pending_confirmations WHERE id = ? AND thread_id = ?")
    .get(confirmationId, threadId) as ConfirmationRow | undefined;
  if (!row) throw new AppError(404, "CONFIRMATION_NOT_FOUND", "找不到对应的待确认操作");
  if (row.user_id !== userId) throw new AppError(403, "FORBIDDEN", "无权确认他人的待确认操作");
  return row;
}

/** 查询当前有效待确认卡（顺带将已超时的 pending 标记为 expired，前端不会渲染过期按钮）。 */
export function listActivePendingConfirmations(db: DatabaseSync, threadId: string, now = new Date()) {
  const nowIso = now.toISOString();
  db.prepare(
    "UPDATE agent_pending_confirmations SET status = 'expired' WHERE thread_id = ? AND status = 'pending' AND expires_at <= ?",
  ).run(threadId, nowIso);
  const rows = db
    .prepare(
      `SELECT id, tool_name, summary, preview_json, expected_version, status, expires_at, created_at
       FROM agent_pending_confirmations
       WHERE thread_id = ? AND status = 'pending' AND expires_at > ?
       ORDER BY created_at DESC`,
    )
    .all(threadId, nowIso) as {
    id: string;
    tool_name: string;
    summary: string;
    preview_json: string | null;
    expected_version: number | null;
    status: string;
    expires_at: string;
    created_at: string;
  }[];
  return rows.map((r) => ({
    id: r.id,
    toolName: r.tool_name,
    summary: r.summary,
    preview: r.preview_json ? JSON.parse(r.preview_json) : null,
    expectedVersion: r.expected_version,
    status: r.status,
    expiresAt: r.expires_at,
    createdAt: r.created_at,
  }));
}

/** 原子抢占待确认卡（pending -> processing），杜绝并发双击或重放。 */
export function claimPendingConfirmation(db: DatabaseSync, confirmationId: string): boolean {
  const res = db
    .prepare("UPDATE agent_pending_confirmations SET status = 'processing' WHERE id = ? AND status = 'pending'")
    .run(confirmationId);
  return Number(res.changes ?? 0) === 1;
}

export function finishProcessingConfirmation(
  db: DatabaseSync,
  confirmationId: string,
  nextStatus: "confirmed" | "pending" | "expired" | "cancelled",
): boolean {
  const res = db
    .prepare("UPDATE agent_pending_confirmations SET status = ? WHERE id = ? AND status = 'processing'")
    .run(nextStatus, confirmationId);
  return Number(res.changes ?? 0) === 1;
}

export function markConfirmationStatusIfPending(
  db: DatabaseSync,
  confirmationId: string,
  status: "cancelled" | "expired",
): boolean {
  const res = db
    .prepare("UPDATE agent_pending_confirmations SET status = ? WHERE id = ? AND status = 'pending'")
    .run(status, confirmationId);
  return Number(res.changes ?? 0) === 1;
}

/** 按保留天数清理过期对话（retentionDays <= 0 时不自动清理；可排除当前活跃对话防止外键崩溃）。 */
export function cleanupExpiredThreads(
  db: DatabaseSync,
  retentionDays: number,
  now = new Date(),
  excludeThreadId?: string,
): number {
  if (!Number.isFinite(retentionDays) || retentionDays <= 0) return 0;
  const cutoff = new Date(now.getTime() - retentionDays * 86_400_000).toISOString();
  const res = excludeThreadId
    ? db.prepare("DELETE FROM agent_threads WHERE updated_at < ? AND id != ?").run(cutoff, excludeThreadId)
    : db.prepare("DELETE FROM agent_threads WHERE updated_at < ?").run(cutoff);
  return Number(res.changes ?? 0);
}
