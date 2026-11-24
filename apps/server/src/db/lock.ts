// 单档案串行事务与乐观锁门禁（BEGIN IMMEDIATE + expectedVersion 校验）。
import type { DatabaseSync } from "node:sqlite";

export class AppError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export interface ProfileRowMeta {
  id: string;
  code: string;
  owner_user_id: string;
  is_managed: number;
  member_user_id: string | null;
  timezone: string;
  profile_json: string;
  age: string | null;
  stage: string | null;
  product: string | null;
  version: number;
  has_conflict: number;
  conflict_json: string | null;
  updated_at: string;
  created_at: string;
}

/**
 * 在 SQLite BEGIN IMMEDIATE 事务内对单个档案执行原子读写：
 * - 验证档案存在
 * - 如提供 expectedVersion，严格校验乐观锁（不匹配抛出 409 VERSION_CONFLICT）
 * - 回调抛错则自动 ROLLBACK
 */
export function withProfileLock<T>(
  db: DatabaseSync,
  profileId: string,
  expectedVersion: number | undefined,
  fn: (meta: ProfileRowMeta) => T,
): T {
  db.exec("BEGIN IMMEDIATE;");
  try {
    const row = db.prepare("SELECT * FROM profiles WHERE id = ?").get(profileId) as ProfileRowMeta | undefined;
    if (!row) {
      throw new AppError(404, "PROFILE_NOT_FOUND", "找不到对应档案");
    }
    if (expectedVersion !== undefined && row.version !== expectedVersion) {
      throw new AppError(409, "VERSION_CONFLICT", "档案已被其他操作更新，请刷新后重试", {
        expectedVersion,
        currentVersion: row.version,
      });
    }
    const result = fn(row);
    db.exec("COMMIT;");
    return result;
  } catch (err) {
    try {
      db.exec("ROLLBACK;");
    } catch {
      /* ignore rollback error */
    }
    throw err;
  }
}

/** 在 SQLite BEGIN IMMEDIATE 事务内执行普通写操作（如建档、建用户、迁移导入）。 */
export function withTransaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE;");
  try {
    const result = fn();
    db.exec("COMMIT;");
    return result;
  } catch (err) {
    try {
      db.exec("ROLLBACK;");
    } catch {
      /* ignore rollback error */
    }
    throw err;
  }
}
