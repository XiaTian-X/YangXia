// 和原版比对（基线由 e2e/baseline.mjs 从原版生成）：
// 1. 内置语音：固定随机种子后，每个音节的合成波形和原版逐采样一致（三种音色）
// 2. 每句语音的长度一致
// 3. 原版能表达的 4 个样例课程：事件时刻、打点类型、语音、总时长、SRT 条数和最后一条时间码都一致
import { buildSrt, buildTimeline, type Course, type CourseItem } from "@yangxia/course-core";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { VoiceBank, TIMBRE_F0, type Timbre } from "../src/audio/voice-bank.ts";
import { SYLLABLES, synthesizeSyllableLF } from "../src/audio/voice-synth.ts";

const base = JSON.parse(readFileSync(new URL("./fixtures/original-baseline.json", import.meta.url), "utf8"));

function mulberry32(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function digest(w: Float32Array) {
  let sum = 0;
  let sq = 0;
  for (let i = 0; i < w.length; i++) {
    sum += w[i];
    sq += w[i] * w[i];
  }
  const pick = (i: number) => (w.length ? w[Math.min(w.length - 1, Math.max(0, i))] : 0);
  return { length: w.length, sum, sq, probe: [0, 1, 100, Math.floor(w.length / 2), w.length - 2, w.length - 1].map(pick) };
}

describe("内置语音合成和原版逐采样一致（固定随机种子）", () => {
  for (const [key, expected] of Object.entries(base.syllables)) {
    it(key, () => {
      const [timbre, syl] = key.split(":");
      const w = synthesizeSyllableLF(SYLLABLES[syl], TIMBRE_F0[timbre as Timbre], 1.0, mulberry32(base.seed));
      // 基线存成 JSON 时 -0 会变成 0，实际结果也过一遍 JSON 再比（仍是逐位相等，不放宽）
      expect(JSON.parse(JSON.stringify(digest(w)))).toEqual(expected);
    });
  }
});

describe("每句语音长度和原版一致", () => {
  const bank = new VoiceBank("female", 60, mulberry32(1));
  for (const [text, len] of Object.entries(base.phrases as Record<string, number>)) {
    it(text, () => expect(bank.phrase(text)?.length).toBe(len));
  }
});

const PATTERN: Record<string, CourseItem["tempo"]> = {
  "1-1": { start: "up", up: 1, down: 1 },
  "1-2": { start: "up", up: 1, down: 2 },
  "1-1-2": { start: "up", up: 1, top: 1, down: 2 },
  "2-2": { start: "up", up: 2, down: 2 },
};

function toCourse(queue: any[]): Course {
  return {
    schema: "yangxia.course/1", id: "c_baseline", name: "基线", age: "a18", source: { product: "x", week: 1 },
    blocks: [{ kind: "sets", items: queue.map((q) => ({
      exercise: "x", name: q.name, mode: q.mode, sets: q.sets, rest: q.rest, quote: ["x"],
      ...(q.mode === "reps" ? { reps: q.reps, tempo: PATTERN[q.pattern] } : { duration: q.duration }),
    })) }],
  };
}

const SAMPLES: Record<string, any[]> = {
  "s1-reps-1-2": [{ name: "深蹲测试", mode: "reps", sets: 2, reps: 5, pattern: "1-2", rest: 10 }],
  "s2-timed": [{ name: "平板测试", mode: "timed", sets: 2, duration: 20, rest: 10 }],
  "s3-mixed-1-1-2": [
    { name: "臀桥测试", mode: "reps", sets: 2, reps: 4, pattern: "1-1-2", rest: 8 },
    { name: "静蹲测试", mode: "timed", sets: 1, duration: 15, rest: 8 },
  ],
  "s4-2-2-and-1-1": [
    { name: "推举测试", mode: "reps", sets: 1, reps: 4, pattern: "2-2", rest: 6 },
    { name: "卷腹测试", mode: "reps", sets: 1, reps: 4, pattern: "1-1", rest: 6 },
  ],
};

describe("样例课程的时间轴和原版一致", () => {
  const bank = new VoiceBank("female", 60, mulberry32(1));
  for (const [id, queue] of Object.entries(SAMPLES)) {
    it(id, () => {
      const exp = base.timelines[id];
      // 原版的报法：做完时报数、领呼 2 次 + 提示音、报数那一拍不拼呼吸口令
      const tl = buildTimeline(toCourse(queue), { voiceDuration: bank.seconds, legacy: true, settings: { countTiming: "on-rep", breathLead: 2, breathAfter: "pluck" } });
      const got = tl.events.map((e) => ({ t: +e.time.toFixed(6), cue: e.cueType, voice: e.voice, state: e.state, final: e.isSetFinalRep }));
      expect(got).toEqual(exp.events);
      expect(tl.totalDuration).toBeCloseTo(exp.totalDuration, 9);
      const srt = buildSrt(tl.events, tl.totalDuration).trim().split("\r\n\r\n");
      expect(srt.length).toBe(exp.srtCount);
      expect(srt[srt.length - 1].split("\r\n")[1]).toBe(exp.srtLast);
    });
  }
});
