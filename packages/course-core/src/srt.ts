// SRT 字幕：照原版编排器的 buildSrtStringFromTimeline 移植。
import type { TimelineEvent } from "./timeline.ts";

export function srtTimecode(seconds: number): string {
  const safe = Math.max(0, Number.isFinite(seconds) ? seconds : 0);
  const ms = Math.round(safe * 1000);
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(Math.floor(ms / 3600000))}:${p(Math.floor((ms % 3600000) / 60000))}:${p(Math.floor((ms % 60000) / 1000))},${p(ms % 1000, 3)}`;
}

export interface SrtCue {
  index: number;
  start: number;
  end: number;
  text: string;
}

export function srtCues(events: TimelineEvent[], totalDuration: number): SrtCue[] {
  const subs = events.filter((ev) => ev.srtText && ev.srtText.trim().length > 0);
  return subs.map((ev, i) => {
    const next = i < subs.length - 1 ? subs[i + 1].time : totalDuration - 0.1;
    return { index: i + 1, start: ev.time, end: Math.max(ev.time + 0.12, Math.min(next - 0.02, ev.time + 3.8)), text: ev.srtText! };
  });
}

export function buildSrt(events: TimelineEvent[], totalDuration: number): string {
  return srtCues(events, totalDuration)
    .map((c) => `${c.index}\r\n${srtTimecode(c.start)} --> ${srtTimecode(c.end)}\r\n${c.text}\r\n`)
    .join("\r\n");
}
