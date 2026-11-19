// 没在跟练时，动作示意停在哪：记成"哪一段、段里第几秒"，不记绝对秒数。
// 预览或停下以后再改组数、休息、倒数，时间轴重算了，图还对着原来那一段；那一段没了就回开头。
import type { Timeline } from "@yangxia/course-core";

export type FigureAnchor =
  | { kind: "start" }
  | { kind: "end" }
  | { kind: "stage"; stage: string; offset: number; preview: boolean };

/** 第 i 段从第几秒到第几秒。 */
function stageSpan(tl: Timeline, i: number): [number, number] {
  const start = tl.events[tl.stages[i].firstEventIdx]?.time ?? 0;
  const next = tl.stages[i + 1];
  return [start, next ? tl.events[next.firstEventIdx]?.time ?? tl.totalDuration : tl.totalDuration];
}

/** t 秒落在哪一段，记成锚点。 */
export function anchorAt(tl: Timeline, t: number, preview = false): FigureAnchor {
  for (let i = tl.stages.length - 1; i >= 0; i--) {
    const [start] = stageSpan(tl, i);
    if (t >= start) return { kind: "stage", stage: tl.stages[i].id, offset: t - start, preview };
  }
  return { kind: "start" };
}

/** 锚点在这条时间轴上是第几秒，不超出那一段；那一段没了返回 null。 */
export function anchorTime(tl: Timeline, a: FigureAnchor): number | null {
  if (a.kind === "start") return 0;
  if (a.kind === "end") return tl.totalDuration;
  const i = tl.stages.findIndex((s) => s.id === a.stage);
  if (i < 0) return null;
  const [start, end] = stageSpan(tl, i);
  return start + Math.min(a.offset, Math.max(0, end - start - 0.001));
}
