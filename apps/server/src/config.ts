// 服务端配置：端口、数据目录、受信任反代与迁移白名单。
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export interface TrustedProxyMatcher {
  isTrusted(remoteIp: string | undefined): boolean;
}

function normalizeIp(ip: string): string {
  const s = ip.trim();
  return s.startsWith("::ffff:") ? s.slice(7) : s;
}

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let out = 0;
  for (const p of parts) {
    if (!/^\d+$/.test(p)) return null;
    const n = Number(p);
    if (n < 0 || n > 255) return null;
    out = (out << 8) | n;
  }
  return out >>> 0;
}

export function createTrustedProxyMatcher(spec?: string): TrustedProxyMatcher {
  const entries = (spec ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!entries.length) return { isTrusted: () => false };

  const exact = new Set<string>();
  const cidrs: { base: number; mask: number }[] = [];
  for (const e of entries) {
    if (e.includes("/")) {
      const [ip, bitsStr] = e.split("/");
      const bits = Number(bitsStr);
      const base = ipv4ToInt(normalizeIp(ip));
      if (base !== null && Number.isInteger(bits) && bits >= 0 && bits <= 32) {
        const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
        cidrs.push({ base: (base & mask) >>> 0, mask });
      }
    } else {
      exact.add(e);
      exact.add(normalizeIp(e));
    }
  }

  return {
    isTrusted(remoteIp: string | undefined): boolean {
      if (!remoteIp) return false;
      const raw = remoteIp.trim();
      const norm = normalizeIp(raw);
      if (exact.has(raw) || exact.has(norm)) return true;
      const v4 = ipv4ToInt(norm);
      if (v4 === null) return false;
      return cidrs.some((c) => ((v4 & c.mask) >>> 0) === c.base);
    },
  };
}

export interface ServerConfig {
  host: string;
  port: number;
  dataDir: string;
  dbPath: string;
  masterKeyPath: string;
  backupDir: string;
  templatesDir?: string;
  migrateDir?: string;
  trustedProxies: TrustedProxyMatcher;
  backupPassphrase?: string;
  defaultTimezone: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const dataDir = resolve(env.YANGXIA_DATA_DIR || env.DATA_DIR || "./data");
  const dbPath = resolve(env.YANGXIA_DB_PATH || `${dataDir}/yangxia.sqlite`);
  const masterKeyPath = resolve(env.YANGXIA_MASTER_KEY_PATH || `${dataDir}/master.key`);
  const backupDir = resolve(env.YANGXIA_BACKUP_DIR || `${dataDir}/backups`);

  let backupPassphrase = env.YANGXIA_BACKUP_PASSPHRASE?.trim() || undefined;
  const passFile = env.YANGXIA_BACKUP_PASSPHRASE_FILE?.trim();
  if (!backupPassphrase && passFile && existsSync(passFile)) {
    backupPassphrase = readFileSync(passFile, "utf8").trim() || undefined;
  }

  return {
    host: env.HOST || "0.0.0.0",
    port: Number(env.PORT || 3000),
    dataDir,
    dbPath,
    masterKeyPath,
    backupDir,
    templatesDir: env.YANGXIA_TEMPLATES?.trim() || undefined,
    migrateDir: env.YANGXIA_MIGRATE_DIR?.trim() ? resolve(env.YANGXIA_MIGRATE_DIR.trim()) : undefined,
    trustedProxies: createTrustedProxyMatcher(env.TRUSTED_PROXIES),
    backupPassphrase,
    defaultTimezone: env.YANGXIA_DEFAULT_TIMEZONE?.trim() || "Asia/Shanghai",
  };
}
