// 使用仓库已安装的 Vite + Playwright 无头 Chromium，在真实 Web Audio OfflineAudioContext 中
// 原封不动执行 apps/sequencer 的 sounds.ts + voice-bank.ts（含 4 级 EQ 与限幅器，固定随机种子），
// 输出 22.05kHz 16-bit mono 离线音效（16 个打点与换气提示音）与全部 27 个可达词元兜底语音包：
//   apps/android/app/src/main/assets/audio/audio_manifest.json
//   apps/android/app/src/main/assets/audio/audio_pcm.gz
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { chromium } from "@playwright/test";
import { build } from "vite";

const REPO_ROOT = resolve(new URL("..", import.meta.url).pathname);
const OUT_DIR = join(REPO_ROOT, "apps/android/app/src/main/assets/audio");
const TARGET_SR = 22050;

// 构造临时 Vite 入口文件，打包 sounds.ts + voice-bank.ts + TOKEN_SYLLABLES 为单段浏览器 IIFE
const tmpDir = mkdtempSync(join(tmpdir(), "yangxia-audio-bundle-"));
const entryPath = join(tmpDir, "entry.ts");
writeFileSync(
  entryPath,
  `
import { TOKEN_SYLLABLES } from "${join(REPO_ROOT, "packages/course-core/src/voice.ts")}";
import { createMasterChain, scheduleBreathRhythmPluck, scheduleCueSound, scheduleVoiceWaveform } from "${join(REPO_ROOT, "apps/sequencer/src/audio/sounds.ts")}";
import { VoiceBank } from "${join(REPO_ROOT, "apps/sequencer/src/audio/voice-bank.ts")}";
import { SAMPLE_RATE } from "${join(REPO_ROOT, "apps/sequencer/src/audio/voice-synth.ts")}";

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function floatToInt16Base64(f32: Float32Array): { b64: string; samples: number } {
  // 去掉末尾纯静音（保留 6ms 尾韵）与开头前导零
  const threshold = 0.0005;
  let end = f32.length - 1;
  while (end > 220 && Math.abs(f32[end]) < threshold) end--;
  const trimmedLen = Math.min(f32.length, end + Math.floor(0.008 * ${TARGET_SR}));
  const bytes = new Uint8Array(trimmedLen * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < trimmedLen; i++) {
    let s = f32[i];
    if (!Number.isFinite(s)) s = 0;
    if (s > 0.95) s = 0.95 + 0.05 * Math.tanh((s - 0.95) / 0.05);
    else if (s < -0.95) s = -0.95 + 0.05 * Math.tanh((s + 0.95) / 0.05);
    const clamped = Math.max(-1, Math.min(1, s));
    view.setInt16(i * 2, clamped < 0 ? Math.round(clamped * 0x8000) : Math.round(clamped * 0x7fff), true);
  }
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return { b64: btoa(bin), samples: trimmedLen };
}

async function renderClip(durationSec: number, scheduleFn: (ctx: OfflineAudioContext, master: GainNode) => void) {
  const sr44 = SAMPLE_RATE;
  const ctx44 = new OfflineAudioContext(1, Math.ceil(durationSec * sr44), sr44);
  const master = createMasterChain(ctx44);
  scheduleFn(ctx44, master);
  const rendered44 = await ctx44.startRendering();

  // 用真实 Web Audio 抗混叠重采样到 22.05kHz mono
  const len22 = Math.max(1, Math.ceil(rendered44.duration * ${TARGET_SR}));
  const ctx22 = new OfflineAudioContext(1, len22, ${TARGET_SR});
  const src = ctx22.createBufferSource();
  src.buffer = rendered44;
  src.connect(ctx22.destination);
  src.start(0);
  const rendered22 = await ctx22.startRendering();
  return floatToInt16Base64(rendered22.getChannelData(0));
}

(globalThis as any).__renderYangXiaAndroidAudio = async () => {
  const results: Record<string, { b64: string; samples: number; category: "cue" | "voice" }> = {};

  const cueDefs: { id: string; dur: number; fn: (ctx: OfflineAudioContext, dest: GainNode) => void }[] = [
    { id: "cue_intro", dur: 0.45, fn: (c, d) => scheduleCueSound(c, d, 0.01, "intro-cue", "bell", false, false) },
    { id: "cue_count_321", dur: 0.20, fn: (c, d) => scheduleCueSound(c, d, 0.01, "count-321", "bell", false, false) },
    { id: "cue_count_go", dur: 0.42, fn: (c, d) => scheduleCueSound(c, d, 0.01, "count-go", "bell", false, false) },
    { id: "cue_up_bell", dur: 0.16, fn: (c, d) => scheduleCueSound(c, d, 0.01, "up", "bell", false, false) },
    { id: "cue_up_marimba", dur: 0.16, fn: (c, d) => scheduleCueSound(c, d, 0.01, "up", "marimba", false, false) },
    { id: "cue_up_perc", dur: 0.16, fn: (c, d) => scheduleCueSound(c, d, 0.01, "up", "perc", false, false) },
    { id: "cue_hold", dur: 0.12, fn: (c, d) => scheduleCueSound(c, d, 0.01, "hold", "bell", false, false) },
    { id: "cue_sub", dur: 0.12, fn: (c, d) => scheduleCueSound(c, d, 0.01, "sub", "bell", false, false) },
    { id: "cue_rep", dur: 0.36, fn: (c, d) => scheduleCueSound(c, d, 0.01, "rep", "bell", false, false) },
    { id: "cue_rep_last3", dur: 0.36, fn: (c, d) => scheduleCueSound(c, d, 0.01, "rep", "bell", true, false) },
    { id: "cue_rep_final", dur: 0.85, fn: (c, d) => scheduleCueSound(c, d, 0.01, "rep", "bell", false, true) },
    { id: "cue_rest_tick", dur: 0.10, fn: (c, d) => scheduleCueSound(c, d, 0.01, "rest-tick", "bell", false, false) },
    { id: "breath_action_inhale", dur: 0.22, fn: (c, d) => scheduleBreathRhythmPluck(c, d, 0.01, "inhale", 1.0, false) },
    { id: "breath_action_exhale", dur: 0.18, fn: (c, d) => scheduleBreathRhythmPluck(c, d, 0.01, "exhale", 1.0, false) },
    { id: "breath_rest_inhale", dur: 0.36, fn: (c, d) => scheduleBreathRhythmPluck(c, d, 0.01, "inhale", 1.0, true) },
    { id: "breath_rest_exhale", dur: 0.36, fn: (c, d) => scheduleBreathRhythmPluck(c, d, 0.01, "exhale", 1.0, true) },
  ];

  for (const def of cueDefs) {
    const r = await renderClip(def.dur, def.fn);
    results[def.id] = { ...r, category: "cue" };
  }

  // 合成全部 27 个可达语音词元（排除 "第" 外的实际可达集合，也全量渲染 TOKEN_SYLLABLES 保证零缺失）
  const rng = mulberry32(20261124);
  const bank = new VoiceBank("warm", 60, rng);
  for (const tokenKey of Object.keys(TOKEN_SYLLABLES)) {
    if (tokenKey === "第") continue; // 27 个实际可达词元（voice.ts 不产生 "第"）
    const wave = bank.token(tokenKey);
    const dur = wave.length / SAMPLE_RATE + 0.08;
    const r = await renderClip(dur, (ctx, master) => {
      scheduleVoiceWaveform(ctx, master, 0.008, wave, 0.92);
    });
    results["tok:" + tokenKey] = { ...r, category: "voice" };
  }
  return results;
};
`,
  "utf8",
);

try {
  const outBundleDir = join(tmpDir, "dist");
  await build({
    configFile: false,
    logLevel: "silent",
    build: {
      outDir: outBundleDir,
      lib: {
        entry: entryPath,
        name: "YangXiaAudioRenderer",
        formats: ["iife"],
        fileName: () => "bundle.js",
      },
      rollupOptions: { output: { inlineDynamicImports: true } },
    },
  });

  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent("<!doctype html><html><body></body></html>");
    await page.addScriptTag({ path: join(outBundleDir, "bundle.js") });
    const rendered = await page.evaluate(() => globalThis.__renderYangXiaAndroidAudio());

    mkdirSync(OUT_DIR, { recursive: true });
    const chunks = [];
    const entries = {};
    let sampleOffset = 0;
    let cueCount = 0;
    let voiceCount = 0;

    for (const [id, item] of Object.entries(rendered)) {
      const pcm = Buffer.from(item.b64, "base64");
      chunks.push(pcm);
      entries[id] = {
        offsetSamples: sampleOffset,
        lengthSamples: item.samples,
        category: item.category,
      };
      sampleOffset += item.samples;
      if (item.category === "cue") cueCount++;
      else voiceCount++;
    }

    const rawPcm = Buffer.concat(chunks);
    const gzPcm = gzipSync(rawPcm, { level: 9 });
    const sha256 = createHash("sha256").update(rawPcm).digest("hex");

    const manifest = {
      schema: "yangxia.android-audio/1",
      sampleRate: TARGET_SR,
      channels: 1,
      bitDepth: 16,
      totalSamples: sampleOffset,
      totalDurationSec: Number((sampleOffset / TARGET_SR).toFixed(2)),
      cueCount,
      voiceCount,
      pcmSha256: sha256,
      entries,
    };

    writeFileSync(join(OUT_DIR, "audio_manifest.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");
    writeFileSync(join(OUT_DIR, "audio_pcm.gz"), gzPcm);

    console.log(
      `Rendered ${cueCount} cues + ${voiceCount} voice tokens (${manifest.totalDurationSec}s @ ${TARGET_SR}Hz): ` +
        `raw ${(rawPcm.length / 1024).toFixed(1)} KB, gzip ${(gzPcm.length / 1024).toFixed(1)} KB`,
    );
  } finally {
    await browser.close();
  }
} finally {
  rmSync(tmpDir, { recursive: true, force: true });
}
