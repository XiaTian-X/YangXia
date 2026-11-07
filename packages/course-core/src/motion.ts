// 画面上进度条的目标值、背景音乐压低的时间窗：原版里实时播放和离线导出各写了一遍，这里合成一份纯函数。
import type { TimelineEvent } from "./timeline.ts";

/** 当前事件 cur（下一事件 next）在时刻 t 时，竖条应该到的高度（0–1）。照原版 drawHudCanvasOnce 移植。 */
export function barTarget(cur: TimelineEvent, next: TimelineEvent | undefined, t: number): number {
  const segDur = next ? Math.max(0.1, next.time - cur.time) : 1;
  const p = Math.min(1, Math.max(0, (t - cur.time) / segDur));
  if (cur.state !== "action") return (cur.barProgress || 0) / 100;
  if (cur.isTimedMode) {
    const r0 = cur.timedProgressRatio ?? 1;
    const r1 = cur.timedNextRatio ?? r0;
    return Math.max(0.06, r0 + (r1 - r0) * p);
  }
  if (cur.cueType === "up") return 0.15 + 0.85 * Math.sin(p * Math.PI * 0.5);
  if (cur.cueType === "hold") return 1;
  if (cur.cueType === "sub") return 1 - 0.72 * p;
  if (cur.cueType === "rep") return 0.28 - 0.14 * p;
  return (cur.barProgress || 0) / 100;
}

export interface DuckWindow {
  start: number;
  holdEnd: number;
  releaseEnd: number;
  depth: number;
}

export function isPrimaryCue(ev: TimelineEvent): boolean {
  return ["intro-cue", "count-321", "count-go", "up", "rep", "side-switch"].includes(ev.cueType);
}

export function isSubCue(ev: TimelineEvent): boolean {
  return ev.cueType === "sub" || ev.cueType === "hold";
}

/** 打点和说话时把背景音乐压低的时间窗（相邻的合并）。照原版 scheduleOfflineFullBgm 移植。 */
export function duckWindows(
  events: TimelineEvent[],
  opts: { depth: number; includeSub: boolean; voice: boolean; voiceDuration: (text: string) => number },
): DuckWindow[] {
  if (opts.depth <= 0) return [];
  const raw: DuckWindow[] = [];
  for (const ev of events) {
    const hasVoice = opts.voice && !!ev.voice && opts.voiceDuration(ev.voice) > 0;
    if (!(isPrimaryCue(ev) || hasVoice || (opts.includeSub && isSubCue(ev)))) continue;
    const vDur = hasVoice ? opts.voiceDuration(ev.voice!) : 0;
    const hold = Math.max(ev.isSetFinalRep ? 0.52 : 0.08, vDur);
    raw.push({ start: ev.time, holdEnd: ev.time + hold, releaseEnd: ev.time + hold + 0.22,
      depth: isSubCue(ev) && !hasVoice ? opts.depth * 0.55 : opts.depth });
  }
  const merged: DuckWindow[] = [];
  for (const w of raw) {
    const prev = merged[merged.length - 1];
    if (prev && w.start <= prev.releaseEnd + 0.025) {
      prev.holdEnd = Math.max(prev.holdEnd, w.holdEnd);
      prev.releaseEnd = Math.max(prev.releaseEnd, w.releaseEnd);
      prev.depth = Math.max(prev.depth, w.depth);
    } else {
      merged.push({ ...w });
    }
  }
  return merged;
}
