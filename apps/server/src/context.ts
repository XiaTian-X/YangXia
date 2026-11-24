// 服务端依赖容器：封装 SQLite 连接（原子恢复热替换 + 互斥锁）、配置、模板管理器、master.key、限速器与可注入时钟。
import type { DatabaseSync } from "node:sqlite";
import type { ServerConfig } from "./config.ts";
import { AUTH_LIMIT_POLICY, PAIR_LIMIT_POLICY, RateLimiter } from "./auth/rate-limit.ts";
import { atomicStageRestoreSqliteFile } from "./backup/backup.ts";
import { DEFAULT_SCRYPT, type ScryptOptions } from "./crypto/password.ts";
import { openDatabase } from "./db/database.ts";
import { AppError } from "./db/lock.ts";
import type { TemplatesManager } from "./templates/manager.ts";

export interface ServerContext {
  config: ServerConfig;
  templates: TemplatesManager;
  masterKey: Buffer;
  scrypt: ScryptOptions;
  now: () => Date;
  authLimiter: RateLimiter;
  pairLimiter: RateLimiter;
  setupLimiter: RateLimiter;
  getDb(): DatabaseSync;
  restoreSqliteBytes(sqliteBytes: Buffer): void;
  close(): void;
}

export interface CreateServerContextOptions {
  db: DatabaseSync;
  config: ServerConfig;
  templates: TemplatesManager;
  masterKey: Buffer;
  scrypt?: ScryptOptions;
  now?: () => Date;
  /** 测试用自定义恢复回调（例如使用内存库时替换成临时文件库）。 */
  onRestoreDb?: (sqliteBytes: Buffer, currentDb: DatabaseSync) => DatabaseSync;
}

export function createServerContext(opts: CreateServerContextOptions): ServerContext {
  let currentDb = opts.db;
  let restoring = false;

  return {
    config: opts.config,
    templates: opts.templates,
    masterKey: opts.masterKey,
    scrypt: opts.scrypt ?? DEFAULT_SCRYPT,
    now: opts.now ?? (() => new Date()),
    authLimiter: new RateLimiter(AUTH_LIMIT_POLICY),
    pairLimiter: new RateLimiter(PAIR_LIMIT_POLICY),
    setupLimiter: new RateLimiter(AUTH_LIMIT_POLICY),
    getDb() {
      return currentDb;
    },
    restoreSqliteBytes(sqliteBytes: Buffer) {
      if (restoring) {
        throw new AppError(409, "RESTORE_IN_PROGRESS", "已有备份恢复正在执行，请稍后再试");
      }
      restoring = true;
      try {
        if (opts.onRestoreDb) {
          currentDb = opts.onRestoreDb(sqliteBytes, currentDb);
          return;
        }
        if (opts.config.dbPath === ":memory:") {
          throw new AppError(400, "MEMORY_DB_RESTORE_UNSUPPORTED", "内存数据库不支持文件级恢复");
        }
        // 1. 先关闭原连接，原子 rename 暂存原库为 .bak 并切入新库
        currentDb.close();
        const staged = atomicStageRestoreSqliteFile(opts.config.dbPath, sqliteBytes);
        try {
          // 2. 打开并校验新库成功后再删除 .bak
          currentDb = openDatabase(opts.config.dbPath);
          staged.commit();
        } catch (err) {
          // 3. 若打开新库失败，立刻回滚 .bak 并重开原库，确保服务永不处于悬空已关闭状态
          staged.rollback();
          currentDb = openDatabase(opts.config.dbPath);
          throw err;
        }
      } finally {
        restoring = false;
      }
    },
    close() {
      try {
        currentDb.close();
      } catch {
        /* ignore */
      }
    },
  };
}
