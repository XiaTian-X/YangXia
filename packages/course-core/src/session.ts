// 练习记录 yangxia.session/1：编排器练完导出，放进 profiles/<代号>/打卡/，周复盘读它。
// 生成规则放在核心库里，编排器和测试用同一份，保证"跟练了什么"和"记录里写了什么"一致。
import { SESSION_FORMAT } from "./profile.ts";
import { FEELS } from "./progress.ts";
import type { TimelineEvent } from "./timeline.ts";
import type { Course } from "./types.ts";

export type Feeling = "轻松" | "正好" | "吃力";
export interface Symptoms {
  pain: boolean;
  dizzy: boolean;
  chest: boolean;
}

/**
 * 实际播放过的事件里，每个动作完成了几组（循环里是几轮），键是时间轴的 itemIndex。
 * 只数每组"本组完成 / 全部完成"那一拍（cueType 为 rep 且 isSetFinalRep）；一次动作的其他拍、
 * 用 → 跳过没播的组都不算；倒回去重练同一组也只算一次。
 */
export function setsDoneFromPlayed(events: TimelineEvent[], played: Iterable<number>): Record<number, number> {
  const out: Record<number, number> = {};
  for (const i of new Set(played)) {
    const e = events[i];
    if (e && e.isSetFinalRep && e.cueType === "rep") out[e.itemIndex] = (out[e.itemIndex] ?? 0) + 1;
  }
  return out;
}

export interface SessionInput {
  startedAt: Date;
  endedAt: Date;
  feeling: Feeling;
  symptoms: Symptoms;
  note?: string;
  /** setsDoneFromPlayed 的结果。 */
  setsDone: Record<number, number>;
  /** 课程在编排器里手动改过（和成品原文可能不一致）。 */
  edited?: boolean;
  /**
   * 每个动作的补充（可选），键是 itemIndex：找级用的感受（照成品原话）、健身房"还能做几下"、升级做不到当场退回。
   * 周复盘和找级、调重量按它们核对（progressLog 的依据）。
   */
  perItem?: Record<number, ItemNote>;
}

export interface ItemNote {
  feel?: (typeof FEELS)[number];
  spare?: number;
  reverted?: boolean;
}

/** 生成练习记录对象（yangxia.session/1）。动作顺序和时间轴的 itemIndex 一致：按 blocks、items 的先后展开。 */
export function buildSession(course: Course, input: SessionInput): Record<string, unknown> {
  let index = 0;
  const items = course.blocks.flatMap((b) => b.items.map((it) => {
    const planned = b.kind === "circuit" ? b.rounds : it.sets ?? 1;
    const extra = input.perItem?.[index] ?? {};
    const done = Math.min(planned, input.setsDone[index++] ?? 0);
    return {
      exercise: it.exercise, setsPlanned: planned, setsDone: done, skipped: done === 0,
      ...(extra.feel ? { feel: extra.feel } : {}),
      ...(Number.isInteger(extra.spare) ? { spare: extra.spare } : {}),
      ...(extra.reverted ? { reverted: true } : {}),
    };
  }));
  const note = input.note?.trim().slice(0, 500);
  return {
    schema: SESSION_FORMAT,
    course: { id: course.id, name: course.name, source: course.source },
    startedAt: input.startedAt.toISOString(),
    endedAt: input.endedAt.toISOString(),
    items,
    feeling: input.feeling,
    symptoms: input.symptoms,
    ...(input.edited ? { edited: true } : {}),
    ...(note ? { note } : {}),
  };
}
