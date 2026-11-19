// 动作示意动图：时间轴上每一段显示什么，某一时刻该定到哪段动图的第几帧。纯函数，不碰页面。
// 动图数据（yangxia.motions/1）由模板 tools/motions.py 生成；只有 course export 导出的课程才用 figure，
// 片段还要写明能给这个动作用，防止错图号。按次动作必须对得上节拍，计时动作停在撑住的那一帧或循环。
import type { Phase } from "./tempo.ts";
import type { Timeline } from "./timeline.ts";
import type { Course, CourseItem } from "./types.ts";

export const MOTIONS_FORMAT = "yangxia.motions/1";

export type MotionNote = "ready" | "doing" | "switch-side" | "next-set" | "next-item" | "done";

export type MotionSpan = { itemIndex: number; start: number; end: number; note: MotionNote } & (
  | { kind: "phase"; phase: Phase }
  | { kind: "timed" }
  | { kind: "pose"; pose: "start" | "last" }
);

export interface MotionClip {
  exercises: string[];
  frames: number;
  dur: number;
  w: number;
  h: number;
  /** 按次动作：{相位: [从第几帧出发, 走几帧]}，可以跨循环点。 */
  phases?: Partial<Record<Phase, [number, number]>>;
  /** 计时动作撑住的那一帧。 */
  hold?: number;
  /** 计时的连续动作：原速循环。 */
  loop?: boolean;
  lottie?: unknown;
}

export interface MotionsData {
  format: string;
  version: string;
  clips: Record<string, MotionClip>;
}

export interface FigureFrame {
  clip: string;
  frame: number;
  note: MotionNote;
  perSide: boolean;
  itemIndex: number;
}

/** 课程里的动作，下标和时间轴的 itemIndex 一致。 */
export function courseItems(course: Course): CourseItem[] {
  return course.blocks.flatMap((b) => b.items);
}

/** 这个动作能不能用这段片段：导出的课程、片段存在、片段写明给这个动作用、计次方式对得上。 */
export function usableClip(course: Course, item: CourseItem | undefined, clips: Record<string, MotionClip>): MotionClip | null {
  if (!course.source.plan || !item?.figure) return null;
  const clip = Object.prototype.hasOwnProperty.call(clips, item.figure) ? clips[item.figure] : undefined;
  if (!clip || !clip.exercises.includes(item.exercise) || !(clip.frames > 0)) return null;
  if (item.mode === "reps") return clip.phases?.up && clip.phases?.down && item.tempo ? clip : null;
  return clip.loop || Number.isFinite(clip.hold) ? clip : null;
}

/** 这节课用到的片段（去重），编排器载入课程时预载。 */
export function courseClips(course: Course, clips: Record<string, MotionClip>): string[] {
  const out = new Set<string>();
  for (const item of courseItems(course)) if (usableClip(course, item, clips)) out.add(item.figure!);
  return [...out];
}

const wrap = (frame: number, n: number) => ((frame % n) + n) % n;
const endOf = (seg: [number, number]) => seg[0] + seg[1];

function startPose(item: CourseItem, clip: MotionClip): number {
  if (item.mode === "timed") return clip.hold ?? 0;
  return clip.phases![item.tempo!.start]![0];
}

function lastPose(item: CourseItem, clip: MotionClip): number {
  if (item.mode === "timed") return clip.hold ?? 0;
  // 一次动作从发力开始就结束在下放的终点，从下放开始就结束在发力的终点
  return endOf(clip.phases![item.tempo!.start === "up" ? "down" : "up"]!);
}

function phaseFrame(phase: Phase, progress: number, clip: MotionClip): number {
  const p = clip.phases!;
  const seg = p[phase];
  if (seg) return seg[0] + seg[1] * progress;
  // 课程有这个停顿、片段没有：停在分界那一帧
  return endOf(phase === "top" ? p.up! : p.down!);
}

/** t 秒落在哪一段（二分）。 */
export function spanAt(spans: MotionSpan[], t: number): MotionSpan | null {
  let lo = 0;
  let hi = spans.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const s = spans[mid];
    if (t < s.start) hi = mid - 1;
    else if (t >= s.end) lo = mid + 1;
    else return s;
  }
  const last = spans[spans.length - 1];
  return last && t >= last.end ? last : null;
}

/** 某一时刻显示哪段动图的第几帧；这一刻不显示就返回 null。 */
export function motionAt(timeline: Pick<Timeline, "motion">, course: Course, clips: Record<string, MotionClip>, t: number): FigureFrame | null {
  const span = spanAt(timeline.motion, t);
  if (!span) return null;
  const item = courseItems(course)[span.itemIndex];
  const clip = usableClip(course, item, clips);
  if (!clip) return null;
  const n = clip.frames;
  let frame: number;
  if (span.kind === "phase") {
    const len = span.end - span.start;
    const progress = len > 0 ? Math.min(1, Math.max(0, (t - span.start) / len)) : 1;
    frame = phaseFrame(span.phase, progress, clip);
  } else if (span.kind === "timed") {
    frame = clip.loop ? ((t - span.start) / clip.dur) * n : clip.hold!;
  } else {
    frame = span.pose === "start" ? startPose(item, clip) : lastPose(item, clip);
  }
  return { clip: item.figure!, frame: wrap(frame, n), note: span.note, perSide: !!item.perSide, itemIndex: span.itemIndex };
}
