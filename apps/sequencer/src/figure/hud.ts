// 把"这一刻该显示哪一帧"变成画面要用的东西。实时跟练和导出视频都走这里。
import { motionAt, type Course, type MotionClip, type MotionNote, type Timeline } from "@yangxia/course-core";
import type { HudFigure } from "../hud/draw.ts";
import type { FigurePlayer } from "./player.ts";

const NOTE: Record<MotionNote, string> = {
  ready: "准备 · 起始姿势", doing: "动作示意", "switch-side": "换另一侧", "next-set": "下一组 · 起始姿势", "next-item": "下一个动作", done: "完成",
};

export function hudFigure(course: Course, timeline: Timeline, clips: Record<string, MotionClip>, player: FigurePlayer, t: number): HudFigure | null {
  const f = motionAt(timeline, course, clips, Math.max(0, t));
  if (!f) return null;
  const image = player.frame(f.clip, f.frame);
  if (!image) return null;
  return { image, width: image.width, height: image.height, label: f.perSide && f.note === "doing" ? "动作示意 · 示意一侧" : NOTE[f.note] };
}
