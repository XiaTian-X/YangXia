// 宿主机独立 master.key（AES-256-GCM），用于加密 app_settings 中的外部模型 API Key 等机密配置。
// 备份时主动剥离本机 master.key 加密项，避免换机恢复无法解密。
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { dirname } from "node:path";

export function loadOrCreateMasterKey(filePath: string): Buffer {
  if (existsSync(filePath)) {
    const raw = readFileSync(filePath, "utf8").trim();
    const buf = Buffer.from(raw, "hex");
    if (buf.length !== 32) {
      throw new Error(`master.key 格式异常（期望 32 字节 hex）：${filePath}`);
    }
    return buf;
  }
  mkdirSync(dirname(filePath), { recursive: true });
  const key = randomBytes(32);
  writeFileSync(filePath, `${key.toString("hex")}\n`, { mode: 0o600 });
  try {
    chmodSync(filePath, 0o600);
  } catch {
    /* 某些文件系统不支持 chmod，尽力即可 */
  }
  return key;
}

export interface EncryptedBlob {
  valueEnc: string;
  iv: string;
  tag: string;
}

export function encryptSecret(key: Buffer, plaintext: string): EncryptedBlob {
  if (key.length !== 32) throw new Error("AES-256-GCM 密钥必须为 32 字节");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: 16 });
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    valueEnc: enc.toString("base64"),
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
  };
}

export function decryptSecret(key: Buffer, blob: EncryptedBlob): string {
  if (key.length !== 32) throw new Error("AES-256-GCM 密钥必须为 32 字节");
  const iv = Buffer.from(blob.iv, "base64");
  const tag = Buffer.from(blob.tag, "base64");
  if (iv.length !== 12) throw new Error("AES-256-GCM IV 长度必须为 12 字节");
  if (tag.length !== 16) throw new Error("AES-256-GCM AuthTag 长度必须为 16 字节");
  const data = Buffer.from(blob.valueEnc, "base64");
  const decipher = createDecipheriv("aes-256-gcm", key, iv, { authTagLength: 16 });
  decipher.setAuthTag(tag);
  const out = Buffer.concat([decipher.update(data), decipher.final()]);
  return out.toString("utf8");
}
