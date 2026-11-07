// 给原版编排器建基线（只读原版，结果写进 test/fixtures/original-baseline.json，供新版比对）：
//   node apps/sequencer/e2e/baseline.mjs
// - 随机数换成固定种子（原版语音合成里有两处随机噪声）
// - 记下每个音节的合成波形摘要、样例课程用到的每句语音的长度
// - 记下 4 个样例课程的时间轴（事件时刻、打点类型、语音、状态）、总时长、SRT 最后一条
import { chromium } from "@playwright/test";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const original = pathToFileURL(join(here, "..", "reference", "原版.html")).href;
const out = join(here, "..", "test", "fixtures", "original-baseline.json");

export const SAMPLES = {
  "s1-reps-1-2": [{ name: "深蹲测试", mode: "reps", sets: 2, reps: 5, bpm: 60, pattern: "1-2", rest: 10 }],
  "s2-timed": [{ name: "平板测试", mode: "timed", sets: 2, duration: 20, bpm: 60, pattern: "timed", rest: 10 }],
  "s3-mixed-1-1-2": [
    { name: "臀桥测试", mode: "reps", sets: 2, reps: 4, bpm: 60, pattern: "1-1-2", rest: 8 },
    { name: "静蹲测试", mode: "timed", sets: 1, duration: 15, bpm: 60, pattern: "timed", rest: 8 },
  ],
  "s4-2-2-and-1-1": [
    { name: "推举测试", mode: "reps", sets: 1, reps: 4, bpm: 60, pattern: "2-2", rest: 6 },
    { name: "卷腹测试", mode: "reps", sets: 1, reps: 4, bpm: 60, pattern: "1-1", rest: 6 },
  ],
};

const browser = await chromium.launch();
const page = await browser.newPage();
await page.addInitScript(() => {
  let s = 1;
  window.__reseed = (seed) => { s = seed >>> 0; };
  // mulberry32
  Math.random = () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
});
await page.goto(original);

const result = await page.evaluate((samples) => {
  const digest = (w) => {
    let sum = 0, sq = 0;
    for (let i = 0; i < w.length; i++) { sum += w[i]; sq += w[i] * w[i]; }
    const pick = (i) => (w.length ? w[Math.min(w.length - 1, Math.max(0, i))] : 0);
    return { length: w.length, sum, sq, probe: [0, 1, 100, Math.floor(w.length / 2), w.length - 2, w.length - 1].map(pick) };
  };
  const syllables = {};
  for (const [timbre, f0] of [["female", 235], ["male", 132], ["warm", 210]]) {
    for (const key of Object.keys(SYLLABLES)) {
      window.__reseed(20261108);
      syllables[`${timbre}:${key}`] = digest(synthesizeSyllableLF(SYLLABLES[key], f0, 1.0));
    }
  }
  const timelines = {};
  const phrases = {};
  for (const [id, queue] of Object.entries(samples)) {
    applyFullCourseConfig({ workoutQueue: queue, globalSettings: {
      soundStyle: "keep", preCountdown: true, lastThreeBoost: true, breathStyle: "keep-coach", breathVol: 65,
      countTiming: "on-rep-complete", voiceTimbre: "female", voiceEngineMode: "embedded-only", voiceVol: 92, voiceBake: true,
      bgmMode: "synth-groove", bgmVol: 45, duckDepth: 76, duckSubBeats: false } }, "基线");
    const { events, totalDuration } = buildTimeline();
    for (const ev of events) if (ev.voice) phrases[ev.voice] = ev.voiceWave.length;
    const srt = buildSrtStringFromTimeline(events, totalDuration).trim().split("\r\n\r\n");
    timelines[id] = {
      totalDuration,
      srtCount: srt.length,
      srtLast: srt[srt.length - 1].split("\r\n")[1],
      events: events.map((e) => ({ t: +e.time.toFixed(6), cue: e.cueType, voice: e.voice, state: e.state, final: !!e.isSetFinalRep })),
    };
  }
  return { syllables, phrases, timelines };
}, SAMPLES);

writeFileSync(out, JSON.stringify({ note: "由 apps/sequencer/e2e/baseline.mjs 从原版生成，不要手改", seed: 20261108, ...result }, null, 1) + "\n");
console.log(`音节 ${Object.keys(result.syllables).length} 个，语音 ${Object.keys(result.phrases).length} 句，样例课程 ${Object.keys(result.timelines).length} 个 → ${out}`);
await browser.close();
