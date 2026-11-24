// 换机可用加密备份（.yxbackup）与定期自动备份轮转（对应需求 S8 与架构 3.5）：
// 1. 在 0o700 私有临时目录内用 VACUUM INTO 生成热一致 SQLite 快照；
// 2. 开启 PRAGMA secure_delete = ON 物理擦除 is_secret=1 项并再执行 VACUUM 清空空闲页；
// 3. 用用户独立备份口令（scrypt + AES-256-GCM，16B 强校验 Tag + AAD 认证头部）加密打包，换机 100% 无损恢复。
import { createCipheriv, createDecipheriv, randomBytes, scrypt } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { gunzipSync, gzipSync } from "node:zlib";
import { DEFAULT_SCRYPT, type ScryptOptions } from "../crypto/password.ts";
import { runMigrations } from "../db/database.ts";
import { AppError } from "../db/lock.ts";

const MAGIC = Buffer.from("YXBK0001", "ascii");
const MAX_RESTORED_DB_BYTES = 200 * 1024 * 1024;
const REQUIRED_TABLES = [
  "users",
  "auth_sessions",
  "pairing_codes",
  "profiles",
  "courses",
  "workout_sessions",
  "reviews",
  "assessments",
  "documents",
  "agent_threads",
  "agent_messages",
  "audit_logs",
  "app_settings",
] as const;

export const RESTORE_NOTICE_KEY = "system.restore_notice";
export const RESTORE_NOTICE_TEXT =
  "已从加密备份恢复：为保证换机安全，备份不包含原宿主机加密保存的外部模型 API Key，请在系统设置页重新填写。";

interface BackupHeader {
  schema: "yangxia.backup/1";
  createdAt: string;
  kdf: "scrypt";
  N: number;
  r: number;
  p: number;
  saltHex: string;
  ivHex: string;
  tagHex: string;
  strippedSecretCount: number;
}

/** 认证头 AAD（排除 tagHex 自身，保护 schema / createdAt / kdf 参数 / salt / iv / strippedSecretCount 防篡改）。 */
function aadFromHeader(h: Omit<BackupHeader, "tagHex">): Buffer {
  return Buffer.from(
    JSON.stringify({
      schema: h.schema,
      createdAt: h.createdAt,
      kdf: h.kdf,
      N: h.N,
      r: h.r,
      p: h.p,
      saltHex: h.saltHex,
      ivHex: h.ivHex,
      strippedSecretCount: h.strippedSecretCount,
    }),
    "utf8",
  );
}

function isPowerOfTwo(n: number): boolean {
  return Number.isInteger(n) && n > 0 && (n & (n - 1)) === 0;
}

function deriveKey(passphrase: string, salt: Buffer, opts: { N: number; r: number; p: number }): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(passphrase, salt, 32, { N: opts.N, r: opts.r, p: opts.p, maxmem: 128 * 1024 * 1024 }, (err, key) => {
      if (err) reject(err);
      else resolve(key);
    });
  });
}

function validatePassphrase(passphrase: string): void {
  if (typeof passphrase !== "string" || passphrase.length < 8) {
    throw new AppError(400, "WEAK_BACKUP_PASSPHRASE", "备份口令至少需要 8 位字符");
  }
}

function sqlString(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

function makePrivateTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  try {
    chmodSync(dir, 0o700);
  } catch {
    /* ignore */
  }
  return dir;
}

export async function exportEncryptedBackup(
  db: DatabaseSync,
  passphrase: string,
  opts: { scrypt?: ScryptOptions; now?: Date } = {},
): Promise<{ buffer: Buffer; strippedSecretCount: number; createdAt: string }> {
  validatePassphrase(passphrase);
  const now = opts.now ?? new Date();
  const scryptOpts = opts.scrypt ?? DEFAULT_SCRYPT;
  const workDir = makePrivateTempDir("yangxia-bkp-");
  const tempFile = join(workDir, "snapshot.sqlite");

  try {
    // 1. 一致性热快照写入 0o700 私有目录，避免 /tmp 共享权限泄露
    db.exec(`VACUUM INTO ${sqlString(tempFile)};`);
    try {
      chmodSync(tempFile, 0o600);
    } catch {
      /* ignore */
    }

    // 2. 在临时快照库中启用 secure_delete 物理覆写并剥离 is_secret=1 项，再 VACUUM 清空空闲页
    const snap = new DatabaseSync(tempFile);
    let strippedSecretCount = 0;
    try {
      snap.exec("PRAGMA secure_delete = ON;");
      const cnt = snap.prepare("SELECT COUNT(*) AS n FROM app_settings WHERE is_secret = 1").get() as { n: number };
      strippedSecretCount = cnt.n;
      snap.prepare("DELETE FROM app_settings WHERE is_secret = 1").run();
      snap
        .prepare(
          `INSERT INTO app_settings (key, value_enc, iv, tag, is_secret, updated_at)
           VALUES (?, ?, '', '', 0, ?)
           ON CONFLICT(key) DO UPDATE SET value_enc = excluded.value_enc, iv = '', tag = '', is_secret = 0, updated_at = excluded.updated_at`,
        )
        .run(RESTORE_NOTICE_KEY, RESTORE_NOTICE_TEXT, now.toISOString());
      snap.exec("VACUUM;");
      snap.exec("PRAGMA wal_checkpoint(TRUNCATE);");
    } finally {
      snap.close();
    }

    const rawDb = readFileSync(tempFile);
    const gz = gzipSync(rawDb, { level: 6 });

    // 3. 使用独立备份口令派生 AES-256-GCM 密钥（强制 16B Tag + AAD 认证头）
    const salt = randomBytes(16);
    const iv = randomBytes(12);
    const key = await deriveKey(passphrase, salt, scryptOpts);

    const headerBase: Omit<BackupHeader, "tagHex"> = {
      schema: "yangxia.backup/1",
      createdAt: now.toISOString(),
      kdf: "scrypt",
      N: scryptOpts.N,
      r: scryptOpts.r,
      p: scryptOpts.p,
      saltHex: salt.toString("hex"),
      ivHex: iv.toString("hex"),
      strippedSecretCount,
    };

    const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: 16 });
    cipher.setAAD(aadFromHeader(headerBase));
    const enc = Buffer.concat([cipher.update(gz), cipher.final()]);
    const tag = cipher.getAuthTag();

    const header: BackupHeader = { ...headerBase, tagHex: tag.toString("hex") };
    const headerBuf = Buffer.from(JSON.stringify(header), "utf8");
    const lenBuf = Buffer.alloc(4);
    lenBuf.writeUInt32BE(headerBuf.length, 0);

    return {
      buffer: Buffer.concat([MAGIC, lenBuf, headerBuf, enc]),
      strippedSecretCount,
      createdAt: header.createdAt,
    };
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

export async function decryptAndVerifyBackup(
  backupBuf: Buffer,
  passphrase: string,
): Promise<{ sqliteBytes: Buffer; header: BackupHeader }> {
  if (backupBuf.length < 16 || !backupBuf.subarray(0, 8).equals(MAGIC)) {
    throw new AppError(400, "BACKUP_INVALID_FORMAT", "不是有效的养夏加密备份文件（.yxbackup）");
  }
  const headerLen = backupBuf.readUInt32BE(8);
  if (headerLen <= 0 || headerLen > 64 * 1024 || 12 + headerLen >= backupBuf.length) {
    throw new AppError(400, "BACKUP_INVALID_FORMAT", "备份文件头损坏");
  }

  let header: BackupHeader;
  try {
    header = JSON.parse(backupBuf.subarray(12, 12 + headerLen).toString("utf8")) as BackupHeader;
  } catch {
    throw new AppError(400, "BACKUP_INVALID_FORMAT", "备份元数据无法解析");
  }
  if (header.schema !== "yangxia.backup/1" || header.kdf !== "scrypt") {
    throw new AppError(400, "BACKUP_UNSUPPORTED_VERSION", "不支持的备份文件版本");
  }

  // 严格校验 KDF 参数范围与 IV / Tag / Salt 精确长度（防 GCM 短 Tag 截断与 DoS）
  if (
    !isPowerOfTwo(header.N) ||
    header.N < 1024 ||
    header.N > 131072 ||
    !Number.isInteger(header.r) ||
    header.r < 1 ||
    header.r > 16 ||
    !Number.isInteger(header.p) ||
    header.p < 1 ||
    header.p > 4
  ) {
    throw new AppError(400, "BACKUP_INVALID_FORMAT", "备份密钥派生参数超出安全范围");
  }

  const salt = Buffer.from(header.saltHex ?? "", "hex");
  const iv = Buffer.from(header.ivHex ?? "", "hex");
  const tag = Buffer.from(header.tagHex ?? "", "hex");
  if (salt.length < 16 || iv.length !== 12 || tag.length !== 16) {
    throw new AppError(400, "BACKUP_INVALID_FORMAT", "备份加密参数长度异常");
  }

  const ciphertext = backupBuf.subarray(12 + headerLen);
  let plainGz: Buffer;
  try {
    const key = await deriveKey(passphrase, salt, { N: header.N, r: header.r, p: header.p });
    const decipher = createDecipheriv("aes-256-gcm", key, iv, { authTagLength: 16 });
    decipher.setAAD(
      aadFromHeader({
        schema: header.schema,
        createdAt: header.createdAt,
        kdf: header.kdf,
        N: header.N,
        r: header.r,
        p: header.p,
        saltHex: header.saltHex,
        ivHex: header.ivHex,
        strippedSecretCount: header.strippedSecretCount,
      }),
    );
    decipher.setAuthTag(tag);
    plainGz = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new AppError(400, "BACKUP_DECRYPT_FAILED", "备份解密失败：请检查备份口令是否正确或文件是否损坏");
  }

  let sqliteBytes: Buffer;
  try {
    sqliteBytes = gunzipSync(plainGz, { maxOutputLength: MAX_RESTORED_DB_BYTES });
  } catch {
    throw new AppError(400, "BACKUP_CORRUPTED", "备份压缩数据损坏或超出允许体积上限");
  }

  // 在 0o700 私有临时目录校验 SQLite 完整性与全部 12+1 张核心表
  const workDir = makePrivateTempDir("yangxia-restore-");
  const tempCheck = join(workDir, "check.sqlite");
  try {
    writeFileSync(tempCheck, sqliteBytes, { mode: 0o600 });
    const checkDb = new DatabaseSync(tempCheck);
    try {
      const integ = checkDb.prepare("PRAGMA integrity_check;").get() as { integrity_check: string };
      if (integ.integrity_check !== "ok") {
        throw new AppError(400, "BACKUP_CORRUPTED", `备份数据库完整性校验失败：${integ.integrity_check}`);
      }
      const tables = new Set(
        (checkDb.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((r) => r.name),
      );
      for (const req of REQUIRED_TABLES) {
        if (!tables.has(req)) {
          throw new AppError(400, "BACKUP_MISSING_TABLES", `备份数据库缺少核心表：${req}`);
        }
      }
      runMigrations(checkDb);
      checkDb.exec("PRAGMA secure_delete = ON;");
      checkDb.prepare("DELETE FROM app_settings WHERE is_secret = 1").run();
      checkDb.exec("PRAGMA wal_checkpoint(TRUNCATE);");
    } finally {
      checkDb.close();
    }
    return { sqliteBytes: readFileSync(tempCheck), header };
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

/**
 * 原子替换目标 SQLite 文件（同目录随机临时文件 + 原库 .bak 保护 + 原子 renameSync）。
 * 返回清理/回滚句柄，供调用方在重开数据库失败时回滚原库。
 */
export function atomicStageRestoreSqliteFile(targetDbPath: string, sqliteBytes: Buffer): {
  commit: () => void;
  rollback: () => void;
} {
  const dir = dirname(targetDbPath);
  mkdirSync(dir, { recursive: true });
  const rand = randomBytes(8).toString("hex");
  const tempStage = `${targetDbPath}.restore-${rand}.tmp`;
  const backupOld = `${targetDbPath}.pre-restore-${rand}.bak`;

  writeFileSync(tempStage, sqliteBytes, { mode: 0o600 });
  const hadOriginal = existsSync(targetDbPath);
  try {
    if (hadOriginal) {
      renameSync(targetDbPath, backupOld);
    }
    for (const suffix of ["-wal", "-shm"]) {
      if (existsSync(targetDbPath + suffix)) unlinkSync(targetDbPath + suffix);
    }
    renameSync(tempStage, targetDbPath);
    try {
      chmodSync(targetDbPath, 0o600);
    } catch {
      /* ignore */
    }
  } catch (err) {
    rmSync(tempStage, { force: true });
    if (hadOriginal && existsSync(backupOld) && !existsSync(targetDbPath)) {
      try {
        renameSync(backupOld, targetDbPath);
      } catch {
        /* ignore */
      }
    }
    throw err;
  }

  return {
    commit() {
      rmSync(backupOld, { force: true });
    },
    rollback() {
      for (const suffix of ["", "-wal", "-shm"]) {
        if (existsSync(targetDbPath + suffix)) rmSync(targetDbPath + suffix, { force: true });
      }
      if (hadOriginal && existsSync(backupOld)) {
        renameSync(backupOld, targetDbPath);
      }
    },
  };
}

/** 离线 CLI 使用的简单原子落盘接口。 */
export function writeRestoredSqliteFile(targetDbPath: string, sqliteBytes: Buffer): void {
  const tx = atomicStageRestoreSqliteFile(targetDbPath, sqliteBytes);
  tx.commit();
}

/** 定期自动备份并按保留份数轮转清理旧自动备份文件。 */
export async function runAutoBackup(
  db: DatabaseSync,
  backupDir: string,
  passphrase: string,
  keepCount = 7,
  opts: { scrypt?: ScryptOptions; now?: Date } = {},
): Promise<{ filePath: string; pruned: string[] }> {
  mkdirSync(backupDir, { recursive: true });
  const now = opts.now ?? new Date();
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\..*$/, "").replace("T", "-");
  const fileName = `yangxia-auto-${stamp}.yxbackup`;
  const filePath = join(backupDir, fileName);
  const { buffer } = await exportEncryptedBackup(db, passphrase, { scrypt: opts.scrypt, now });
  writeFileSync(filePath, buffer, { mode: 0o600 });

  const autoFiles = readdirSync(backupDir)
    .filter((f) => /^yangxia-auto-.*\.yxbackup$/.test(f))
    .sort();
  const pruned: string[] = [];
  const limit = Math.max(1, keepCount);
  while (autoFiles.length > limit) {
    const oldest = autoFiles.shift()!;
    rmSync(join(backupDir, oldest), { force: true });
    pruned.push(oldest);
  }
  return { filePath, pruned };
}
