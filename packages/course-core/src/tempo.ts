// 一次动作拆成"拍"：每拍最长 1 秒（0.5 秒的停顿就是半拍）。最后一拍是"完成一次"（rep），报数落在这里。
// 和原版四种节奏完全对得上（以 60 BPM、从发力开始为准）：
//   1-1   = up 1, down 1          → 发力(呼气) · 完成(吸气)
//   1-2   = up 1, down 2          → 发力(呼气) · 下放(吸气) · 完成
//   1-1-2 = up 1, top 1, down 2   → 发力(呼气) · 顶点停 · 下放(吸气) · 完成
//   2-2   = up 2, down 2          → 发力(呼气) · 继续发力 · 下放(吸气) · 完成
import type { Age, Tempo } from "./types.ts";

export type BeatType = "up" | "sub" | "hold" | "rep";
export type Breath = "exhale" | "inhale" | "none";
export type Phase = "up" | "top" | "down" | "bottom";

export interface Beat {
  phase: Phase;
  type: BeatType;
  breath: Breath;
  dur: number;
  label: string;
  breathText: string;
  progress: number;
}

const ORDER: Record<Tempo["start"], Phase[]> = {
  up: ["up", "top", "down", "bottom"],
  down: ["down", "bottom", "up", "top"],
};

export function holdBreathText(age: Age): string {
  // 65 岁以上版要求写"别把气停住"（字幕和画面不用白名单，"不憋气"也不能写）
  return age === "a65" ? "🌬️ 自然呼吸，别把气停住" : "🌬️ 停住时自然呼吸";
}

function chunks(seconds: number): number[] {
  const out: number[] = [];
  let left = Math.round(seconds * 2) / 2;
  while (left > 0) {
    const d = Math.min(1, left);
    out.push(d);
    left = Math.round((left - d) * 2) / 2;
  }
  return out;
}

export function repBeats(tempo: Tempo, age: Age): Beat[] {
  const secs: Record<Phase, number> = { up: tempo.up, top: tempo.top ?? 0, down: tempo.down, bottom: tempo.bottom ?? 0 };
  const beats: Beat[] = [];
  for (const phase of ORDER[tempo.start]) {
    chunks(secs[phase]).forEach((dur, i) => {
      const first = i === 0;
      if (phase === "up") {
        beats.push(first
          ? { phase, type: "up", breath: "exhale", dur, label: "发力", breathText: "💨 发力呼气", progress: 100 }
          : { phase, type: "sub", breath: "none", dur, label: "继续发力", breathText: "💨 继续呼气", progress: 100 });
      } else if (phase === "down") {
        beats.push(first
          ? { phase, type: "sub", breath: "inhale", dur, label: "下放控制", breathText: "🌬️ 慢放吸气", progress: 55 }
          : { phase, type: "sub", breath: "none", dur, label: "继续下放", breathText: "🌬️ 继续吸气", progress: 35 });
      } else {
        beats.push({ phase, type: "hold", breath: "none", dur, label: phase === "top" ? "顶点停住" : "底部停住",
          breathText: holdBreathText(age), progress: phase === "top" ? 100 : 12 });
      }
    });
  }
  const last = beats[beats.length - 1];
  beats[beats.length - 1] = { ...last, type: "rep", label: "完成一次 (+1)",
    breathText: last.breath === "none" ? "🔔 完成一次" : last.breathText, progress: 12 };
  return beats;
}
