// 密码哈希：Node 内置 crypto.scrypt + 16 字节随机盐 + timingSafeEqual 校验。
import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

export interface ScryptOptions {
  N: number;
  r: number;
  p: number;
  keylen: number;
}

export const DEFAULT_SCRYPT: ScryptOptions = { N: 16384, r: 8, p: 1, keylen: 64 };

function scryptAsync(password: string, salt: Buffer, keylen: number, opts: { N: number; r: number; p: number }): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keylen, { N: opts.N, r: opts.r, p: opts.p, maxmem: 64 * 1024 * 1024 }, (err, derived) => {
      if (err) reject(err);
      else resolve(derived);
    });
  });
}

export function validatePassword(password: string): string | null {
  if (typeof password !== "string" || password.length < 8) return "密码至少需要 8 位字符";
  if (password.length > 128) return "密码不能超过 128 位字符";
  return null;
}

export async function hashPassword(password: string, opts: ScryptOptions = DEFAULT_SCRYPT): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scryptAsync(password, salt, opts.keylen, opts);
  return `scrypt$${opts.N}$${opts.r}$${opts.p}$${salt.toString("hex")}$${derived.toString("hex")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p) || N < 1024 || r < 1 || p < 1) return false;
  const salt = Buffer.from(parts[4], "hex");
  const expected = Buffer.from(parts[5], "hex");
  if (salt.length < 16 || expected.length < 32) return false;
  const actual = await scryptAsync(password, salt, expected.length, { N, r, p });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
