// SQLite 连接管理与顺序迁移执行器（Node 24 内置 node:sqlite）。
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { MIGRATIONS } from "./schema.ts";

export function openDatabase(dbPath: string): DatabaseSync {
  if (dbPath !== ":memory:") {
    mkdirSync(dirname(dbPath), { recursive: true });
  }
  const db = new DatabaseSync(dbPath);
  if (dbPath !== ":memory:") {
    db.exec("PRAGMA journal_mode = WAL;");
  }
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA busy_timeout = 5000;");
  runMigrations(db);
  return db;
}

export function runMigrations(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);
  const applied = new Set(
    (db.prepare("SELECT version FROM schema_migrations").all() as { version: number }[]).map((r) => r.version),
  );
  for (const m of MIGRATIONS) {
    if (applied.has(m.version)) continue;
    // 按 SQLite 官方 12-step 规范：涉及重建表的迁移须在事务外部临时关闭 foreign_keys，防止 DROP TABLE 级联删历史子表
    if (m.disableForeignKeys) {
      db.exec("PRAGMA foreign_keys = OFF;");
    }
    try {
      db.exec("BEGIN IMMEDIATE;");
      try {
        db.exec(m.sql);
        db.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)").run(
          m.version,
          m.name,
          new Date().toISOString(),
        );
        db.exec("COMMIT;");
      } catch (err) {
        try {
          db.exec("ROLLBACK;");
        } catch {
          /* ignore rollback failure */
        }
        throw err;
      }
      if (m.disableForeignKeys) {
        const violations = db.prepare("PRAGMA foreign_key_check;").all();
        if (violations.length > 0) {
          throw new Error(`数据库迁移 ${m.name} 后存在外键完整性错误`);
        }
      }
    } finally {
      if (m.disableForeignKeys) {
        db.exec("PRAGMA foreign_keys = ON;");
      }
    }
  }
}
