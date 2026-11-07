// 内置语音合成：用共振峰模型一个音节一个音节地合成中文报数（离线、不需要系统语音）。
// 照原版编排器原样移植（apps/sequencer/reference/原版.html），只改了三处：
// 随机噪声改成可注入的 rng（测试时固定种子，和原版逐采样比对），采样率改成常量，加了类型。
// 能说哪些话由 @yangxia/course-core 的 voice.ts（词表和读法）决定。

export const SAMPLE_RATE = 44100;

export interface SyllableDef {
  dur: number;
  tone: number;
  vot?: number;
  nasalCoda?: boolean;
  noiseFreq?: number;
  noiseBw?: number;
  noiseAmp?: number;
  f1: number[];
  f2: number[];
  f3: number[];
}

function createNormalizedResonator() {
  let y1 = 0, y2 = 0;  // 全极点滤波器只用输出的历史值；原版另有只写不读的 x1、x2，删掉不影响输出
  return {
    process(x: number, freq: number, bw: number, sr: number): number {
      const r = Math.exp(-Math.PI * bw / sr);
      const theta = (2 * Math.PI * freq) / sr;
      const a1 = -2 * r * Math.cos(theta);
      const a2 = r * r;
      const b0 = (1 - r) * Math.sqrt(1 - 2 * r * Math.cos(2 * theta) + r * r);
      const y = b0 * x - a1 * y1 - a2 * y2;
      y2 = y1; y1 = y;
      return y;
    }
  };
}

function getNaturalMandarinTone(tone: number, t: number): number {
  if (tone === 1) return 1.16 + 0.03 * Math.sin(Math.PI * t);
  if (tone === 2) {
    const dip = t < 0.25 ? -0.04 * Math.sin((t / 0.25) * Math.PI) : 0;
    return 0.88 + dip + 0.36 * Math.pow(Math.max(0, (t - 0.15) / 0.85), 1.25);
  }
  if (tone === 3) {
    return t < 0.58
      ? 0.90 - 0.22 * Math.sin((t / 0.58) * (Math.PI * 0.5))
      : 0.68 + 0.34 * Math.pow((t - 0.58) / 0.42, 1.15);
  }
  if (tone === 4) {
    if (t < 0.10) return 1.28 + 0.08 * (t / 0.10);
    return 1.36 - 0.64 * Math.pow((t - 0.10) / 0.90, 0.88);
  }
  return 0.88 - 0.14 * t;
}

export function cleanAndNormalizeWave(floatArr: Float32Array, targetPeak = 0.84): Float32Array {
  const len = floatArr.length;
  if (len === 0) return floatArr;

  let sum = 0;
  for (let i = 0; i < len; i++) {
    const val = Number.isFinite(floatArr[i]) ? floatArr[i] : 0;
    sum += val;
  }
  const mean = sum / len;

  let maxAbs = 0;
  const out = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    const raw = Number.isFinite(floatArr[i]) ? floatArr[i] : 0;
    const v = raw - mean;
    out[i] = v;
    const a = Math.abs(v);
    if (a > maxAbs) maxAbs = a;
  }

  if (maxAbs < 1e-5) return out;

  const scale = targetPeak / maxAbs;
  const edgeSamples = Math.max(1, Math.min(Math.floor(len * 0.06), Math.floor(0.003 * SAMPLE_RATE)));
  for (let i = 0; i < len; i++) {
    let env = 1.0;
    if (i < edgeSamples) {
      env = 0.5 * (1 - Math.cos((Math.PI * i) / edgeSamples));
    } else if (i >= len - edgeSamples) {
      const rem = len - 1 - i;
      env = 0.5 * (1 - Math.cos((Math.PI * rem) / edgeSamples));
    }
    out[i] = out[i] * scale * env;
  }
  return out;
}

function interpMultiPoint(arr: number[], vt: number): number {
  if (!arr || arr.length === 0) return 500;
  if (arr.length === 1) return arr[0];
  const scaled = vt * (arr.length - 1);
  const idx = Math.min(arr.length - 2, Math.floor(scaled));
  const frac = scaled - idx;
  const smoothFrac = 0.5 * (1 - Math.cos(Math.PI * frac));
  return arr[idx] * (1 - smoothFrac) + arr[idx + 1] * smoothFrac;
}

export function synthesizeSyllableLF(def: SyllableDef, baseF0: number, tempoScale = 1.0, rng: () => number = Math.random): Float32Array {
  const effectiveDur = Math.max(0.16, def.dur * tempoScale);
  const totalSamples = Math.floor(effectiveDur * SAMPLE_RATE);
  const out = new Float32Array(totalSamples);

  const resF1 = createNormalizedResonator();
  const resF2 = createNormalizedResonator();
  const resF3 = createNormalizedResonator();
  const resF4 = createNormalizedResonator();
  const resNasal = createNormalizedResonator();
  const resNoise = createNormalizedResonator();

  let phase = 0;
  let prevGlottal = 0;
  let glottalTilt = 0;
  const votRatio = Math.max(0, Math.min(0.22, ((def.vot || 0) * 0.70 * tempoScale) / effectiveDur));
  const f4Center = Math.min(4100, Math.max(3300, 3580 * Math.pow(baseF0 / 210, 0.18)));

  for (let i = 0; i < totalSamples; i++) {
    const t = i / totalSamples;
    const timeSec = i / SAMPLE_RATE;

    let consonantSignal = 0;
    if (def.noiseFreq && t < votRatio + 0.03) {
      let cEnv = 0;
      if (votRatio > 0.001 && t < votRatio) {
        cEnv = Math.sin((t / votRatio) * Math.PI);
      } else {
        cEnv = Math.max(0, 1 - (t - votRatio) / 0.03) * 0.20;
      }
      const white = rng() * 2 - 1;
      consonantSignal = resNoise.process(white, def.noiseFreq, def.noiseBw || 1100, SAMPLE_RATE) * cEnv * (def.noiseAmp || 0.28);
    }

    let vowelSignal = 0;
    const voiceStart = votRatio * 0.55;
    if (t >= voiceStart) {
      const vt = Math.min(1, (t - voiceStart) / Math.max(0.01, 1 - voiceStart));
      const vibrato = Math.sin(2 * Math.PI * 5.4 * timeSec) * 0.0055 * vt;
      const f0 = baseF0 * getNaturalMandarinTone(def.tone, vt) * (1 + vibrato);

      phase += f0 / SAMPLE_RATE;
      if (phase >= 1) phase -= 1;

      let rawFlow = 0;
      if (phase < 0.44) {
        rawFlow = 0.5 * (1 - Math.cos((Math.PI * phase) / 0.44));
      } else if (phase < 0.62) {
        rawFlow = Math.cos((Math.PI * (phase - 0.44)) / (2 * 0.18));
      }
      const rawDeriv = (rawFlow - prevGlottal) * 6.0 + (rng() * 2 - 1) * 0.012;
      prevGlottal = rawFlow;
      glottalTilt = glottalTilt * 0.34 + rawDeriv * 0.66;

      const f1 = interpMultiPoint(def.f1, vt);
      const f2 = interpMultiPoint(def.f2, vt);
      const f3 = interpMultiPoint(def.f3, vt);

      const p1 = resF1.process(glottalTilt, f1, 78, SAMPLE_RATE) * 0.66;
      const p2 = resF2.process(glottalTilt, f2, 108, SAMPLE_RATE) * 0.56;
      const p3 = resF3.process(glottalTilt, f3, 150, SAMPLE_RATE) * 0.27;
      const p4 = resF4.process(glottalTilt, f4Center, 190, SAMPLE_RATE) * 0.11;

      let nasal = 0;
      if (def.nasalCoda && vt > 0.42) {
        const nEnv = Math.min(1, (vt - 0.42) / 0.35);
        nasal = resNasal.process(glottalTilt, 265, 70, SAMPLE_RATE) * 0.45 * nEnv;
      }

      const chest = Math.sin(2 * Math.PI * phase) * 0.22 + Math.sin(4 * Math.PI * phase) * 0.075;
      vowelSignal = p1 + p2 + p3 + p4 + nasal + chest;

      let vEnv = 1.0;
      if (vt < 0.045) vEnv = 0.5 * (1 - Math.cos((Math.PI * vt) / 0.045));
      else if (vt > 0.80) vEnv = 0.5 * (1 + Math.cos((Math.PI * (vt - 0.80)) / 0.20));
      vowelSignal *= vEnv;
    }

    out[i] = vowelSignal + consonantSignal;
  }
  return cleanAndNormalizeWave(out, 0.86);
}

export const SYLLABLES: Record<string, SyllableDef> = {
  yi1:   { dur: 0.27, tone: 1, vot: 0.004, f1: [270, 285, 280], f2: [2320, 2280, 2310], f3: [3180, 3150, 3160] },
  er4:   { dur: 0.29, tone: 4, vot: 0.004, f1: [590, 490, 420], f2: [1420, 1340, 1260], f3: [2420, 1850, 1580] },
  san1:  { dur: 0.30, tone: 1, vot: 0.032, nasalCoda: true, noiseFreq: 6600, noiseBw: 1400, noiseAmp: 0.34, f1: [720, 780, 520, 310], f2: [1380, 1320, 1480, 1680], f3: [2520, 2480, 2450, 2420] },
  si4:   { dur: 0.28, tone: 4, vot: 0.034, noiseFreq: 6800, noiseBw: 1300, noiseAmp: 0.36, f1: [340, 355, 350], f2: [1640, 1580, 1560], f3: [2580, 2540, 2520] },
  wu3:   { dur: 0.29, tone: 3, vot: 0.006, f1: [300, 345, 330], f2: [650, 730, 700],     f3: [2320, 2380, 2360] },
  liu4:  { dur: 0.29, tone: 4, vot: 0.012, f1: [320, 295, 420, 340], f2: [1650, 2180, 960, 740], f3: [2650, 2920, 2420, 2340] },
  qi1:   { dur: 0.29, tone: 1, vot: 0.035, noiseFreq: 4300, noiseBw: 1200, noiseAmp: 0.36, f1: [285, 280, 280], f2: [2260, 2310, 2320], f3: [3120, 3180, 3180] },
  ba1:   { dur: 0.28, tone: 1, vot: 0.010, noiseFreq: 1150, noiseBw: 900,  noiseAmp: 0.28, f1: [480, 810, 790], f2: [1120, 1290, 1270], f3: [2450, 2540, 2520] },
  jiu3:  { dur: 0.30, tone: 3, vot: 0.018, noiseFreq: 4200, noiseBw: 1100, noiseAmp: 0.28, f1: [295, 390, 335], f2: [2180, 980, 740],   f3: [2950, 2420, 2340] },
  shi2:  { dur: 0.28, tone: 2, vot: 0.032, noiseFreq: 2950, noiseBw: 1000, noiseAmp: 0.36, f1: [370, 390, 385], f2: [1520, 1460, 1450], f3: [1950, 1910, 1900] },
  shi2_short: { dur: 0.16, tone: 2, vot: 0.020, noiseFreq: 2950, noiseBw: 1000, noiseAmp: 0.32, f1: [370, 390], f2: [1500, 1460], f3: [1940, 1910] },
  hu1:   { dur: 0.28, tone: 1, vot: 0.035, noiseFreq: 1550, noiseBw: 900,  noiseAmp: 0.26, f1: [340, 330, 320], f2: [760, 720, 700],     f3: [2350, 2320, 2300] },
  xi1:   { dur: 0.28, tone: 1, vot: 0.038, noiseFreq: 4300, noiseBw: 1150, noiseAmp: 0.30, f1: [285, 280, 280], f2: [2240, 2300, 2310], f3: [3080, 3150, 3160] },
  shen1: { dur: 0.24, tone: 1, vot: 0.035, nasalCoda: true, noiseFreq: 3100, noiseBw: 1050, noiseAmp: 0.32, f1: [460, 420, 320], f2: [1480, 1560, 1650], f3: [2420, 2450, 2420] },
  man4:  { dur: 0.24, tone: 4, vot: 0.010, nasalCoda: true, f1: [380, 780, 340], f2: [1150, 1340, 1580], f3: [2420, 2480, 2420] },
  qi4:   { dur: 0.25, tone: 4, vot: 0.038, noiseFreq: 4300, noiseBw: 1150, noiseAmp: 0.34, f1: [290, 285, 280], f2: [2240, 2300, 2310], f3: [3100, 3160, 3160] },
  kai1:  { dur: 0.24, tone: 1, vot: 0.028, noiseFreq: 1850, noiseBw: 1100, noiseAmp: 0.32, f1: [780, 620, 360], f2: [1320, 1750, 2120], f3: [2480, 2680, 2880] },
  shi3:  { dur: 0.26, tone: 3, vot: 0.035, noiseFreq: 2950, noiseBw: 1000, noiseAmp: 0.34, f1: [375, 410, 390], f2: [1510, 1450, 1460], f3: [1950, 1910, 1920] },
  zui4:  { dur: 0.22, tone: 4, vot: 0.026, noiseFreq: 5600, noiseBw: 1200, noiseAmp: 0.30, f1: [350, 410, 310], f2: [880, 1650, 2150],  f3: [2360, 2620, 2880] },
  hou4:  { dur: 0.23, tone: 4, vot: 0.026, noiseFreq: 1650, noiseBw: 950,  noiseAmp: 0.28, f1: [540, 440, 350], f2: [1040, 860, 740],   f3: [2420, 2380, 2340] },
  ci4:   { dur: 0.25, tone: 4, vot: 0.036, noiseFreq: 6300, noiseBw: 1300, noiseAmp: 0.36, f1: [355, 350, 345], f2: [1640, 1600, 1580], f3: [2550, 2520, 2500] },
  ben3:  { dur: 0.22, tone: 3, vot: 0.010, nasalCoda: true, noiseFreq: 1000, noiseBw: 800, noiseAmp: 0.25, f1: [480, 440, 320], f2: [1360, 1480, 1620], f3: [2450, 2430, 2410] },
  zu3:   { dur: 0.23, tone: 3, vot: 0.024, noiseFreq: 5500, noiseBw: 1200, noiseAmp: 0.30, f1: [340, 350, 340], f2: [790, 750, 740],     f3: [2380, 2350, 2340] },
  quan2: { dur: 0.23, tone: 2, vot: 0.032, nasalCoda: true, noiseFreq: 4200, noiseBw: 1100, noiseAmp: 0.32, f1: [310, 580, 330], f2: [2080, 1520, 1650], f3: [2820, 2520, 2450] },
  bu4:   { dur: 0.22, tone: 4, vot: 0.010, noiseFreq: 950,  noiseBw: 800,  noiseAmp: 0.26, f1: [350, 340, 335], f2: [760, 730, 720],     f3: [2360, 2340, 2340] },
  wan2:  { dur: 0.23, tone: 2, vot: 0.008, nasalCoda: true, f1: [340, 680, 330], f2: [750, 1340, 1620], f3: [2360, 2460, 2420] },
  cheng2:{ dur: 0.27, tone: 2, vot: 0.032, nasalCoda: true, noiseFreq: 3100, noiseBw: 1050, noiseAmp: 0.34, f1: [490, 440, 340], f2: [1420, 1550, 1680], f3: [2360, 2420, 2450] },
  xiu1:  { dur: 0.23, tone: 1, vot: 0.035, noiseFreq: 4300, noiseBw: 1150, noiseAmp: 0.34, f1: [300, 390, 340], f2: [2150, 960, 760],   f3: [2920, 2420, 2350] },
  xi0:   { dur: 0.23, tone: 0, vot: 0.028, noiseFreq: 4300, noiseBw: 1150, noiseAmp: 0.28, f1: [295, 305, 310], f2: [2220, 2180, 2140], f3: [3050, 3000, 2980] },
  zhun3: { dur: 0.23, tone: 3, vot: 0.022, nasalCoda: true, noiseFreq: 3000, noiseBw: 1050, noiseAmp: 0.32, f1: [350, 380, 320], f2: [880, 1350, 1580], f3: [2150, 2320, 2380] },
  bei4:  { dur: 0.25, tone: 4, vot: 0.010, noiseFreq: 1000, noiseBw: 800,  noiseAmp: 0.26, f1: [490, 410, 305], f2: [1680, 1980, 2220], f3: [2550, 2780, 2920] },
  di4:   { dur: 0.20, tone: 4, vot: 0.010, noiseFreq: 1800, noiseBw: 950,  noiseAmp: 0.28, f1: [300, 285, 280], f2: [2200, 2290, 2310], f3: [3020, 3140, 3160] },
  miao3: { dur: 0.25, tone: 3, vot: 0.010, nasalCoda: true, f1: [310, 720, 420], f2: [2120, 1280, 820], f3: [2850, 2450, 2360] },
  xia4:  { dur: 0.22, tone: 4, vot: 0.030, noiseFreq: 4200, noiseBw: 1100, noiseAmp: 0.32, f1: [310, 790, 760], f2: [2150, 1320, 1280], f3: [2900, 2480, 2450] },
  xiang4:{ dur: 0.25, tone: 4, vot: 0.035, nasalCoda: true, noiseFreq: 4200, noiseBw: 1100, noiseAmp: 0.34, f1: [310, 720, 380], f2: [2150, 1380, 1580], f3: [2900, 2480, 2420] },
  bai3:  { dur: 0.24, tone: 3, vot: 0.010, noiseFreq: 1050, noiseBw: 850, noiseAmp: 0.26, f1: [520, 760, 380], f2: [1180, 1420, 1980], f3: [2450, 2560, 2780] },
  ling2: { dur: 0.24, tone: 2, vot: 0.012, nasalCoda: true, f1: [310, 295, 320], f2: [2150, 2240, 1750], f3: [2920, 3050, 2550] }
};

export function crossfadeConcatFloat32(arrays: Float32Array[], overlapSec = 0.016): Float32Array {
  const valid = arrays.filter(a => a && a.length > 0);
  if (valid.length === 0) return new Float32Array(0);
  if (valid.length === 1) return valid[0];

  const overlapSamples = Math.floor(overlapSec * SAMPLE_RATE);
  let totalLen = valid[0].length;
  for (let i = 1; i < valid.length; i++) {
    const ov = Math.min(overlapSamples, Math.floor(valid[i - 1].length * 0.25), Math.floor(valid[i].length * 0.25));
    totalLen += valid[i].length - ov;
  }

  const res = new Float32Array(totalLen);
  res.set(valid[0], 0);
  let writePos = valid[0].length;

  for (let i = 1; i < valid.length; i++) {
    const cur = valid[i];
    const ov = Math.min(overlapSamples, Math.floor(valid[i - 1].length * 0.25), Math.floor(cur.length * 0.25));
    const startPos = writePos - ov;

    for (let j = 0; j < ov; j++) {
      const w = 0.5 * (1 - Math.cos((Math.PI * j) / Math.max(1, ov)));
      res[startPos + j] = res[startPos + j] * (1 - w) + cur[j] * w;
    }
    res.set(cur.subarray(ov), writePos);
    writePos += cur.length - ov;
  }
  return res;
}
