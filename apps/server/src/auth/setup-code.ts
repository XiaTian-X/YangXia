// 首次初始化口令（v2 第一轮审查 P1-12）：还没有任何账号时生成一次性口令，写进服务日志和数据目录里权限 600 的文件；
// 初始化（创建第一个管理员）必须带上它，防"谁先访问谁当管理员"。口令不进数据库、不进备份，用过就删。
import { randomInt, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const SETUP_CODE_FILE = "setup-code.txt";
/** 去掉容易看错的 0/O、1/I/L。 */
const ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

export function generateSetupCode(): string {
  const chars = Array.from({ length: 12 }, () => ALPHABET[randomInt(ALPHABET.length)]);
  return `${chars.slice(0, 4).join("")}-${chars.slice(4, 8).join("")}-${chars.slice(8).join("")}`;
}

export interface SetupCodeStore {
  /** 现在有效的口令；已经初始化过的为 null。 */
  current(): string | null;
  /** 口令对不对（大小写、空格不敏感，等长比较）。 */
  matches(input: string | undefined): boolean;
  /** 初始化成功以后删掉。 */
  consume(): void;
}

const norm = (s: string) => s.replace(/[\s-]/g, "").toUpperCase();

/** 内存里的口令（测试、或者没有数据目录时）。 */
export function memorySetupCode(code: string | null): SetupCodeStore {
  let cur = code;
  return {
    current: () => cur,
    matches: (input) => !!cur && typeof input === "string" && safeEqual(norm(input), norm(cur)),
    consume: () => { cur = null; },
  };
}

/**
 * 数据目录里的口令文件：没有账号时，有文件就沿用（重启不换口令），没有就生成并写入（权限 600）；
 * 已经有账号的删掉残留的文件。返回的 store 每次比较都重新读文件（管理员可以删文件让它重新生成）。
 */
export function fileSetupCode(dataDir: string, initialized: boolean): { store: SetupCodeStore; code: string | null; path: string } {
  const path = join(dataDir, SETUP_CODE_FILE);
  if (initialized) {
    if (existsSync(path)) rmSync(path, { force: true });
    return { store: memorySetupCode(null), code: null, path };
  }
  mkdirSync(dataDir, { recursive: true });
  let code = existsSync(path) ? readFileSync(path, "utf8").trim() : "";
  if (!/^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(code)) {
    code = generateSetupCode();
    writeFileSync(path, `${code}\n`, { mode: 0o600 });
  }
  let used = false;
  const store: SetupCodeStore = {
    current: () => (used ? null : code),
    matches: (input) => !used && typeof input === "string" && safeEqual(norm(input), norm(code)),
    consume: () => {
      used = true;
      rmSync(path, { force: true });
    },
  };
  return { store, code, path };
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
