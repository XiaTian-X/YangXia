// 不透明会话 Token（256-bit 熵）、SHA-256 哈希与 128-bit 扫码绑定码生成。
import { createHash, randomBytes, randomUUID } from "node:crypto";

export const newId = (): string => randomUUID();

export const sha256Hex = (input: string | Buffer): string =>
  createHash("sha256").update(input).digest("hex");

/** 256-bit 不透明认证 Token（仅发给客户端，服务端只存 sha256Hex）。 */
export const generateOpaqueToken = (): string => randomBytes(32).toString("base64url");

/** 128-bit 一次性扫码绑定码（32 位十六进制，防暴力枚举）。 */
export const generatePairingCode = (): string => randomBytes(16).toString("hex");

export const normalizePairingCode = (code: string): string =>
  code.trim().toLowerCase().replace(/[\s-]+/g, "");
