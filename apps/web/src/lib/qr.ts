// 纯本地零依赖 ISO/IEC 18004 二维码生成（Byte 模式、容错级别 M、支持 Version 1–10，最多 213 字节 UTF-8），
// 用于网页端 5 分钟扫码配对弹窗，确保 0 外部网络请求。

const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];
})();

function gfMul(a: number, b: number): number {
  return a === 0 || b === 0 ? 0 : GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

function rsGenerator(ecCount: number): Uint8Array {
  let poly = new Uint8Array([1]);
  for (let i = 0; i < ecCount; i++) {
    const next = new Uint8Array(poly.length + 1);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], GF_EXP[i]);
    }
    poly = next;
  }
  return poly;
}

function rsEncode(data: Uint8Array, ecCount: number): Uint8Array {
  const gen = rsGenerator(ecCount);
  const rem = new Uint8Array(data.length + ecCount);
  rem.set(data);
  for (let i = 0; i < data.length; i++) {
    const factor = rem[i];
    if (factor === 0) continue;
    for (let j = 0; j < gen.length; j++) {
      rem[i + j] ^= gfMul(gen[j], factor);
    }
  }
  return rem.subarray(data.length);
}

// Level M 容量表（Version 1..10）：[version, totalDataBytes, ecPerBlock, blocksG1, dataG1, blocksG2, dataG2, alignCoords]
const VERSION_M: [number, number, number, number, number, number, number, number[]][] = [
  [1, 16, 10, 1, 16, 0, 0, []],
  [2, 28, 16, 1, 28, 0, 0, [6, 18]],
  [3, 44, 26, 1, 44, 0, 0, [6, 22]],
  [4, 64, 18, 2, 32, 0, 0, [6, 26]],
  [5, 86, 24, 2, 43, 0, 0, [6, 30]],
  [6, 108, 16, 4, 27, 0, 0, [6, 34]],
  [7, 124, 18, 4, 31, 0, 0, [6, 22, 38]],
  [8, 154, 22, 2, 38, 2, 39, [6, 24, 42]],
  [9, 182, 22, 3, 36, 2, 37, [6, 26, 46]],
  [10, 216, 26, 4, 43, 1, 44, [6, 28, 50]],
];

// Level M (00) + Mask 0..7 预计算 15 位格式串（已异或 0x5412）
const FORMAT_M = [0x5412, 0x5125, 0x5e7c, 0x5b4b, 0x45f9, 0x40ce, 0x4f97, 0x4aa0];

// Version 7..10 的 18 位版本信息
const VERSION_BITS: Record<number, number> = {
  7: 0x07c94,
  8: 0x085bc,
  9: 0x09a99,
  10: 0x0a4d3,
};

export interface QrMatrix {
  size: number;
  modules: boolean[][];
}

export function encodeQrMatrix(text: string): QrMatrix {
  const bytes = new TextEncoder().encode(text);
  const spec = VERSION_M.find(([v, cap]) => {
    const headerBits = 4 + (v <= 9 ? 8 : 16);
    return Math.ceil((headerBits + bytes.length * 8) / 8) <= cap;
  });
  if (!spec) throw new Error("二维码内容超出容量上限");
  const [ver, totalData, ecPerBlock, b1, d1, b2, d2, align] = spec;
  const size = 17 + ver * 4;

  // 1. 构造 Byte 模式数据比特流
  const bits: number[] = [];
  const pushBits = (val: number, len: number) => {
    for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1);
  };
  pushBits(0b0100, 4); // Byte mode
  pushBits(bytes.length, ver <= 9 ? 8 : 16);
  for (const b of bytes) pushBits(b, 8);
  const capBits = totalData * 8;
  for (let i = 0; i < 4 && bits.length < capBits; i++) bits.push(0);
  while (bits.length % 8 !== 0) bits.push(0);
  const padBytes = [0xec, 0x11];
  let pi = 0;
  while (bits.length < capBits) {
    pushBits(padBytes[pi++ & 1], 8);
  }
  const dataBytes = new Uint8Array(totalData);
  for (let i = 0; i < totalData; i++) {
    let v = 0;
    for (let j = 0; j < 8; j++) v = (v << 1) | bits[i * 8 + j];
    dataBytes[i] = v;
  }

  // 2. 分块 RS 编码与交错
  const dataBlocks: Uint8Array[] = [];
  const ecBlocks: Uint8Array[] = [];
  let off = 0;
  for (let i = 0; i < b1; i++) {
    const blk = dataBytes.subarray(off, off + d1);
    off += d1;
    dataBlocks.push(blk);
    ecBlocks.push(rsEncode(blk, ecPerBlock));
  }
  for (let i = 0; i < b2; i++) {
    const blk = dataBytes.subarray(off, off + d2);
    off += d2;
    dataBlocks.push(blk);
    ecBlocks.push(rsEncode(blk, ecPerBlock));
  }

  const finalBytes: number[] = [];
  const maxD = Math.max(d1, d2);
  for (let i = 0; i < maxD; i++) {
    for (const blk of dataBlocks) if (i < blk.length) finalBytes.push(blk[i]);
  }
  for (let i = 0; i < ecPerBlock; i++) {
    for (const blk of ecBlocks) finalBytes.push(blk[i]);
  }

  // 3. 绘制功能图形与保留位
  const grid: boolean[][] = Array.from({ length: size }, () => Array<boolean>(size).fill(false));
  const reserved: boolean[][] = Array.from({ length: size }, () => Array<boolean>(size).fill(false));
  const setFunc = (r: number, c: number, val: boolean) => {
    if (r < 0 || c < 0 || r >= size || c >= size) return;
    grid[r][c] = val;
    reserved[r][c] = true;
  };

  const drawFinder = (tr: number, tc: number) => {
    for (let dr = -1; dr <= 7; dr++) {
      for (let dc = -1; dc <= 7; dc++) {
        const r = tr + dr;
        const c = tc + dc;
        if (r < 0 || c < 0 || r >= size || c >= size) continue;
        const inBorder = dr === 0 || dr === 6 || dc === 0 || dc === 6;
        const inCore = dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4;
        const inPattern = dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6;
        setFunc(r, c, inPattern && (inBorder || inCore));
      }
    }
  };
  drawFinder(0, 0);
  drawFinder(0, size - 7);
  drawFinder(size - 7, 0);

  for (let i = 8; i < size - 8; i++) {
    if (!reserved[6][i]) setFunc(6, i, i % 2 === 0);
    if (!reserved[i][6]) setFunc(i, 6, i % 2 === 0);
  }

  for (const ar of align) {
    for (const ac of align) {
      // 仅跳过与三个定位角重叠的坐标，绝不能因定时线 reserved[6][x]/reserved[x][6] 跳过第 7–10 版的校正图形
      const inFinder =
        (ar <= 8 && ac <= 8) ||
        (ar <= 8 && ac >= size - 8) ||
        (ar >= size - 8 && ac <= 8);
      if (inFinder) continue;
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const on = Math.max(Math.abs(dr), Math.abs(dc)) !== 1;
          setFunc(ar + dr, ac + dc, on);
        }
      }
    }
  }

  // 保留格式位与暗点
  setFunc(size - 8, 8, true);
  for (let i = 0; i < 9; i++) {
    if (!reserved[8][i]) reserved[8][i] = true;
    if (!reserved[i][8]) reserved[i][8] = true;
  }
  for (let i = size - 8; i < size; i++) {
    reserved[8][i] = true;
    reserved[i][8] = true;
  }
  if (ver >= 7) {
    const vb = VERSION_BITS[ver];
    for (let i = 0; i < 18; i++) {
      const bit = ((vb >>> i) & 1) === 1;
      const r = Math.floor(i / 3);
      const c = size - 11 + (i % 3);
      setFunc(r, c, bit);
      setFunc(c, r, bit);
    }
  }

  // 4. 之字形填充数据比特
  let bitIdx = 0;
  let upward = true;
  for (let col = size - 1; col >= 1; col -= 2) {
    if (col === 6) col = 5;
    for (let step = 0; step < size; step++) {
      const row = upward ? size - 1 - step : step;
      for (let dx = 0; dx < 2; dx++) {
        const c = col - dx;
        if (reserved[row][c]) continue;
        const b = bitIdx < finalBytes.length * 8 ? ((finalBytes[bitIdx >> 3] >>> (7 - (bitIdx & 7))) & 1) === 1 : false;
        bitIdx++;
        grid[row][c] = b;
      }
    }
    upward = !upward;
  }

  // 5. 按 ISO 18004 评估 8 种掩码并选最低惩罚分，提升手机镜头对焦与反光屏幕扫码成功率
  const maskPred = (m: number, r: number, c: number): boolean => {
    switch (m) {
      case 0: return (r + c) % 2 === 0;
      case 1: return r % 2 === 0;
      case 2: return c % 3 === 0;
      case 3: return (r + c) % 3 === 0;
      case 4: return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0;
      case 5: return ((r * c) % 2) + ((r * c) % 3) === 0;
      case 6: return (((r * c) % 2) + ((r * c) % 3)) % 2 === 0;
      default: return (((r + c) % 2) + ((r * c) % 3)) % 2 === 0;
    }
  };

  const applyFormat = (g: boolean[][], maskId: number) => {
    const fmt = FORMAT_M[maskId];
    const bitAt = (i: number) => ((fmt >>> i) & 1) === 1;
    const topLeftH = [0, 1, 2, 3, 4, 5, 7, 8];
    for (let i = 0; i < 8; i++) g[8][topLeftH[i]] = bitAt(14 - i);
    const topLeftV = [7, 5, 4, 3, 2, 1, 0];
    for (let i = 0; i < 7; i++) g[topLeftV[i]][8] = bitAt(6 - i);
    for (let i = 0; i < 7; i++) g[size - 1 - i][8] = bitAt(14 - i);
    for (let i = 0; i < 8; i++) g[8][size - 8 + i] = bitAt(7 - i);
  };

  const penalty = (g: boolean[][]): number => {
    let score = 0;
    // 规则 1：同行/列连续 5 个以上同色
    for (let r = 0; r < size; r++) {
      let runH = 1;
      let runV = 1;
      for (let c = 1; c < size; c++) {
        if (g[r][c] === g[r][c - 1]) runH++;
        else {
          if (runH >= 5) score += 3 + (runH - 5);
          runH = 1;
        }
        if (g[c][r] === g[c - 1][r]) runV++;
        else {
          if (runV >= 5) score += 3 + (runV - 5);
          runV = 1;
        }
      }
      if (runH >= 5) score += 3 + (runH - 5);
      if (runV >= 5) score += 3 + (runV - 5);
    }
    // 规则 2：2x2 同色块
    for (let r = 0; r < size - 1; r++) {
      for (let c = 0; c < size - 1; c++) {
        const v = g[r][c];
        if (v === g[r][c + 1] && v === g[r + 1][c] && v === g[r + 1][c + 1]) score += 3;
      }
    }
    // 规则 4：深浅模块比例平衡
    let dark = 0;
    for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) if (g[r][c]) dark++;
    const k = Math.floor(Math.abs((dark * 100) / (size * size) - 50) / 5);
    score += k * 10;
    return score;
  };

  let bestGrid = grid;
  let bestScore = Infinity;
  for (let m = 0; m < 8; m++) {
    const cand = grid.map((row, r) =>
      row.map((val, c) => (!reserved[r][c] && maskPred(m, r, c) ? !val : val)),
    );
    applyFormat(cand, m);
    const sc = penalty(cand);
    if (sc < bestScore) {
      bestScore = sc;
      bestGrid = cand;
    }
  }

  return { size, modules: bestGrid };
}

export function qrSvgPath(text: string): { size: number; quiet: number; path: string } {
  const { size, modules } = encodeQrMatrix(text);
  const quiet = 4;
  const parts: string[] = [];
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (modules[r][c]) {
        parts.push(`M${c + quiet},${r + quiet}h1v1h-1z`);
      }
    }
  }
  return { size: size + quiet * 2, quiet, path: parts.join("") };
}
