// 零依赖严格 ZIP 解析与构造工具（仅用 node:zlib）：
// 严格拦截 Zip Slip（绝对路径 / .. / 盘符 / NUL）、符号链接、单文件 > 2 MB、总解压 > 50 MB、文件数 > 2000。
import { deflateRawSync, inflateRawSync } from "node:zlib";
import { AppError } from "../db/lock.ts";

export interface ZipLimits {
  maxFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
}

export const DEFAULT_ZIP_LIMITS: ZipLimits = {
  maxFiles: 2000,
  maxFileBytes: 2 * 1024 * 1024,
  maxTotalBytes: 50 * 1024 * 1024,
};

export interface ZipEntry {
  path: string;
  data: Buffer;
}

const SIG_LOCAL = 0x04034b50;
const SIG_CD = 0x02014b50;
const SIG_EOCD = 0x06054b50;

function sanitizeZipPath(rawName: string): string {
  if (rawName.includes("\0")) {
    throw new AppError(400, "ZIP_UNSAFE_PATH", "压缩包包含非法路径字符");
  }
  const norm = rawName.replace(/\\/g, "/");
  if (norm.startsWith("/") || /^[a-zA-Z]:/.test(norm)) {
    throw new AppError(400, "ZIP_UNSAFE_PATH", `压缩包禁止绝对路径：${norm}`);
  }
  const parts = norm.split("/").filter((p) => p.length > 0);
  for (const part of parts) {
    if (part === ".." || part === ".") {
      throw new AppError(400, "ZIP_UNSAFE_PATH", `压缩包禁止路径穿越：${norm}`);
    }
  }
  return parts.join("/");
}

function findEocdOffset(buf: Buffer): number {
  const minPos = Math.max(0, buf.length - 65557);
  for (let i = buf.length - 22; i >= minPos; i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD && buf.readUInt16LE(i + 20) === buf.length - (i + 22)) {
      return i;
    }
  }
  return -1;
}

export function extractZipStrict(buf: Buffer, limits: ZipLimits = DEFAULT_ZIP_LIMITS): ZipEntry[] {
  if (buf.length < 22) {
    throw new AppError(400, "ZIP_INVALID", "不是有效的 ZIP 压缩包");
  }
  const eocdOff = findEocdOffset(buf);
  if (eocdOff < 0) {
    throw new AppError(400, "ZIP_INVALID", "找不到 ZIP 中心目录记录");
  }

  const totalEntries = buf.readUInt16LE(eocdOff + 10);
  const cdSize = buf.readUInt32LE(eocdOff + 12);
  const cdOffset = buf.readUInt32LE(eocdOff + 16);

  if (totalEntries > limits.maxFiles) {
    throw new AppError(400, "ZIP_TOO_MANY_FILES", `压缩包文件数超过上限（最多 ${limits.maxFiles} 个）`);
  }
  if (cdOffset + cdSize > buf.length) {
    throw new AppError(400, "ZIP_INVALID", "ZIP 中心目录越界");
  }

  const entries: ZipEntry[] = [];
  const seenPaths = new Set<string>();
  let totalUncompressed = 0;
  let pos = cdOffset;

  for (let i = 0; i < totalEntries; i++) {
    if (pos + 46 > buf.length || buf.readUInt32LE(pos) !== SIG_CD) {
      throw new AppError(400, "ZIP_INVALID", "ZIP 中心目录项损坏");
    }
    const versionMadeBy = buf.readUInt16LE(pos + 4);
    const flags = buf.readUInt16LE(pos + 8);
    const method = buf.readUInt16LE(pos + 10);
    const compSize = buf.readUInt32LE(pos + 20);
    const uncompSize = buf.readUInt32LE(pos + 24);
    const nameLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const commentLen = buf.readUInt16LE(pos + 32);
    const extAttrs = buf.readUInt32LE(pos + 38);
    const localHeaderOff = buf.readUInt32LE(pos + 42);

    const nameEnd = pos + 46 + nameLen;
    if (nameEnd + extraLen + commentLen > buf.length) {
      throw new AppError(400, "ZIP_INVALID", "ZIP 文件名长度越界");
    }
    const rawName = buf.subarray(pos + 46, nameEnd).toString("utf8");
    pos = nameEnd + extraLen + commentLen;

    // 拦截加密 ZIP（不支持带口令 ZIP）
    if ((flags & 0x01) !== 0) {
      throw new AppError(400, "ZIP_ENCRYPTED_UNSUPPORTED", "不支持加密的 ZIP 压缩包，请上传普通 ZIP");
    }

    // 拦截 Unix / macOS 符号链接（S_IFLNK = 0o120000）及设备/管道等特殊文件类型
    const hostOs = versionMadeBy >> 8;
    const isPosix = hostOs === 3 || hostOs === 19;
    const unixMode = (extAttrs >>> 16) & 0o170000;
    if (isPosix && unixMode === 0o120000) {
      throw new AppError(400, "ZIP_SYMLINK_FORBIDDEN", `压缩包禁止包含符号链接：${rawName}`);
    }
    if (isPosix && unixMode !== 0 && unixMode !== 0o100000 && unixMode !== 0o040000) {
      throw new AppError(400, "ZIP_UNSUPPORTED_FILE_TYPE", `压缩包包含不支持的特殊文件类型：${rawName}`);
    }

    // 跳过目录项
    if (rawName.endsWith("/") || (isPosix && unixMode === 0o040000)) {
      if (rawName.length > 0) sanitizeZipPath(rawName);
      continue;
    }

    const safePath = sanitizeZipPath(rawName);
    if (!safePath) continue;
    if (seenPaths.has(safePath)) {
      throw new AppError(400, "ZIP_DUPLICATE_ENTRY", `压缩包包含重复文件路径：${safePath}`);
    }
    seenPaths.add(safePath);

    if (entries.length >= limits.maxFiles) {
      throw new AppError(400, "ZIP_TOO_MANY_FILES", `压缩包文件数超过上限（最多 ${limits.maxFiles} 个）`);
    }
    if (uncompSize > limits.maxFileBytes) {
      throw new AppError(400, "ZIP_FILE_TOO_LARGE", `单文件超过大小限制（${safePath}）`);
    }
    if (totalUncompressed + uncompSize > limits.maxTotalBytes) {
      throw new AppError(400, "ZIP_TOTAL_TOO_LARGE", "压缩包解压总大小超过 50 MB 上限");
    }

    if (localHeaderOff + 30 > buf.length || buf.readUInt32LE(localHeaderOff) !== SIG_LOCAL) {
      throw new AppError(400, "ZIP_INVALID", `本地文件头损坏：${safePath}`);
    }
    const localNameLen = buf.readUInt16LE(localHeaderOff + 26);
    const localExtraLen = buf.readUInt16LE(localHeaderOff + 28);
    const dataStart = localHeaderOff + 30 + localNameLen + localExtraLen;
    const dataEnd = dataStart + compSize;
    if (dataEnd > buf.length) {
      throw new AppError(400, "ZIP_INVALID", `文件数据截断：${safePath}`);
    }
    const compressed = buf.subarray(dataStart, dataEnd);

    let data: Buffer;
    if (method === 0) {
      if (compSize > limits.maxFileBytes || totalUncompressed + compSize > limits.maxTotalBytes) {
        throw new AppError(400, "ZIP_BOMB_DETECTED", `未压缩条目体积超出限制：${safePath}`);
      }
      data = Buffer.from(compressed);
    } else if (method === 8) {
      const remaining = Math.max(0, limits.maxTotalBytes - totalUncompressed);
      const maxOut = Math.min(limits.maxFileBytes, remaining) + 1;
      try {
        data = inflateRawSync(compressed, { maxOutputLength: maxOut });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (/maxOutputLength|length/i.test(msg)) {
          throw new AppError(400, "ZIP_BOMB_DETECTED", `单文件解压后超过上限（疑似压缩炸弹）：${safePath}`);
        }
        throw new AppError(400, "ZIP_INVALID", `解压失败（${safePath}）：${msg}`);
      }
    } else {
      throw new AppError(400, "ZIP_UNSUPPORTED_METHOD", `不支持的压缩方式 ${method}（${safePath}）`);
    }

    if (data.length > limits.maxFileBytes) {
      throw new AppError(400, "ZIP_BOMB_DETECTED", `单文件解压后超过大小上限：${safePath}`);
    }
    totalUncompressed += data.length;
    if (totalUncompressed > limits.maxTotalBytes) {
      throw new AppError(400, "ZIP_TOTAL_TOO_LARGE", "压缩包解压后总大小超过 50 MB 上限");
    }

    entries.push({ path: safePath, data });
  }

  return entries;
}

// CRC32 查表（用于测试和辅助构造合法 ZIP）
const CRC_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let j = 0; j < 8; j++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[i] = c >>> 0;
}

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export interface CreateZipInput {
  path: string;
  data: Buffer | string;
  compress?: boolean;
  /** 仅测试用：写入 Unix 外部属性（如 0o120777 构造符号链接用例）。 */
  unixMode?: number;
}

export function createZipBuffer(files: CreateZipInput[]): Buffer {
  const localParts: Buffer[] = [];
  const cdParts: Buffer[] = [];
  let offset = 0;

  for (const f of files) {
    const raw = typeof f.data === "string" ? Buffer.from(f.data, "utf8") : f.data;
    const nameBuf = Buffer.from(f.path, "utf8");
    const useDeflate = f.compress !== false && raw.length > 0;
    const comp = useDeflate ? deflateRawSync(raw) : raw;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(raw);

    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(SIG_LOCAL, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    nameBuf.copy(local, 30);

    localParts.push(local, comp);

    const cd = Buffer.alloc(46 + nameBuf.length);
    cd.writeUInt32LE(SIG_CD, 0);
    cd.writeUInt16LE(f.unixMode !== undefined ? (3 << 8) | 20 : 20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt16LE(0, 12);
    cd.writeUInt16LE(0, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(comp.length, 20);
    cd.writeUInt32LE(raw.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);
    cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34);
    cd.writeUInt16LE(0, 36);
    cd.writeUInt32LE(f.unixMode !== undefined ? (f.unixMode << 16) >>> 0 : 0, 38);
    cd.writeUInt32LE(offset, 42);
    nameBuf.copy(cd, 46);
    cdParts.push(cd);

    offset += local.length + comp.length;
  }

  const cdBuf = Buffer.concat(cdParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(SIG_EOCD, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, cdBuf, eocd]);
}
