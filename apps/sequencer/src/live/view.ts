// 跟练页每一刻显示什么：纯函数，从课程、时间轴、当前事件和课程时间算出来，界面只管画。
// 段落编号由核心库的时间轴给：ex-<动作下标>-prep / ex-<动作下标>-set-<第几组> / ex-<动作下标>-rest-<第几组>。
import { courseItems, itemSpec, type Course, type CourseItem, type Timeline, type TimelineEvent } from "@yangxia/course-core";

export type Breath = "inhale" | "exhale" | null;

export interface StageInfo {
  kind: "prep" | "set" | "rest";
  itemIndex: number;
  set: number;
}

export function parseStage(id: string): StageInfo | null {
  const m = /^ex-(\d+)-(prep|set|rest)(?:-(\d+))?$/.exec(id);
  return m ? { kind: m[2] as StageInfo["kind"], itemIndex: Number(m[1]), set: m[3] ? Number(m[3]) : 0 } : null;
}

/** 呼吸提示文字里是吸还是呼；"均匀呼吸""自然呼吸""别把气停住"这类不分。 */
export function breathOf(text: string): Breath {
  if (/均匀|自然|别把气停住/.test(text)) return null;
  const inhale = text.includes("吸");
  const exhale = text.includes("呼");
  return inhale && !exhale ? "inhale" : exhale && !inhale ? "exhale" : null;
}

/** 第 i 段从第几秒到第几秒。 */
export function stageSpan(tl: Timeline, i: number): [number, number] {
  const start = tl.events[tl.stages[i].firstEventIdx]?.time ?? 0;
  const next = tl.stages[i + 1];
  return [start, next ? tl.events[next.firstEventIdx]?.time ?? tl.totalDuration : tl.totalDuration];
}

export interface LiveSeg {
  id: string;
  label: string;
  rest: boolean;
  /** 0–1：这一段走了多少 */
  fill: number;
  /** 这一段多少秒（给"整节课"列表显示；休息段按课程写的休息时间） */
  seconds: number;
  now: boolean;
  past: boolean;
}

export interface LiveFrame {
  mode: "prep" | "action" | "rest";
  title: string;
  sub: string;
  /** 圈里的大数字和下面的小字；over 是大数字上面的一行 */
  big: string;
  small: string;
  over: string;
  /** 0–1：环走了多少（按次、计时是做了多少，休息是还剩多少） */
  ring: number;
  breath: Breath;
  phase: string;
  phaseSec: string;
  next: string;
  /** 休息时预告下一组 */
  nextItem: { name: string; detail: string; set: string; itemIndex: number } | null;
  itemIndex: number;
  stageIndex: number;
  segs: LiveSeg[];
}

const stripLead = (s: string) => s.replace(/^[^\p{L}\p{N}]+/u, "").trim();

function tempoSeconds(item: CourseItem | undefined, label: string): string {
  const tp = item?.tempo;
  if (!tp) return "";
  const sec = /下放/.test(label) ? tp.down : /发力/.test(label) ? tp.up : /顶点/.test(label) ? tp.top : /底部/.test(label) ? tp.bottom : undefined;
  return sec ? `${sec} 秒` : "";
}

function tempoText(item: CourseItem): string {
  const tp = item.tempo;
  if (item.mode === "timed" || !tp) return `${item.duration ?? ""} 秒`;
  const parts = tp.start === "down" ? [`下 ${tp.down} 秒`, tp.bottom ? `停 ${tp.bottom} 秒` : "", `起 ${tp.up} 秒`] : [`起 ${tp.up} 秒`, tp.top ? `停 ${tp.top} 秒` : "", `下 ${tp.down} 秒`];
  return `${item.reps ?? ""} 次 · ${parts.filter(Boolean).join("、")}`;
}

/** 某一组一共几组（按次、计时动作）：数这个动作的组段。 */
function setTotalOf(tl: Timeline, itemIndex: number): number {
  return tl.stages.filter((s) => {
    const p = parseStage(s.id);
    return p?.kind === "set" && p.itemIndex === itemIndex;
  }).length;
}

/** 休息段一共几秒：段里第一个"90s"那样的显示（课程写的休息时间；段本身还含着组前的 3、2、1）。 */
function restSeconds(tl: Timeline, stageIndex: number): number | null {
  const st = tl.stages[stageIndex];
  if (!st) return null;
  for (let i = st.firstEventIdx; i < tl.events.length && tl.events[i].phaseGroup === st.id; i++) {
    const m = /^(\d+)s$/.exec(tl.events[i].display);
    if (m) return Number(m[1]);
  }
  return null;
}

export function liveFrame(course: Course, tl: Timeline, idx: number, t: number): LiveFrame {
  const items = courseItems(course);
  const ev: TimelineEvent = tl.events[Math.max(0, Math.min(idx, tl.events.length - 1))];
  const stageIndex = Math.max(0, tl.stages.findIndex((s) => s.id === ev.phaseGroup));
  const info = parseStage(tl.stages[stageIndex]?.id ?? "") ?? { kind: "set", itemIndex: ev.itemIndex, set: 1 };
  const item = items[ev.itemIndex];
  const unit = /第 \d+\/\d+ 轮/.test(ev.tag) ? "轮" : "组";
  const total = setTotalOf(tl, info.itemIndex) || 1;
  const head = `${info.itemIndex + 1} / ${items.length}`;
  const [start, end] = stageSpan(tl, stageIndex);
  const breath = breathOf(ev.breathText);
  const breathWord = breath === "inhale" ? "吸气" : breath === "exhale" ? "呼气" : "";

  const frame: LiveFrame = {
    mode: ev.state, title: item?.name ?? "", sub: "", big: "", small: "", over: "", ring: 0, breath, phase: "", phaseSec: "",
    next: "", nextItem: null, itemIndex: info.itemIndex, stageIndex, segs: [],
  };

  if (ev.state === "rest") {
    // 休息按时间轴每秒的显示倒数（"90s"），和报数、视频一致；休息末尾的"准备第 2 组 3、2、1"单独显示
    const all = restSeconds(tl, stageIndex) ?? Math.max(1, Math.round(end - start));
    const sec = /^(\d+)s$/.exec(ev.display);
    frame.title = tl.stages[stageIndex].label === "换项休" ? "换项休息" : `组间休息`;
    frame.sub = `${head} · 第 ${info.set} ${unit}做完了`;
    frame.phase = stripLead(ev.breathText);
    if (sec) {
      const left = Math.max(0, Number(sec[1]) - Math.max(0, t - ev.time));
      frame.over = "还剩";
      frame.big = String(Math.ceil(left - 0.001));
      frame.small = `秒，共 ${all} 秒`;
      frame.ring = Math.min(1, Math.max(0, left / all));
    } else {
      frame.over = stripLead(ev.label);
      frame.big = /^\d+$/.test(ev.display) ? ev.display : "";
      frame.ring = 0;
    }
  } else if (ev.state === "prep") {
    frame.sub = `${head} · 准备`;
    frame.big = /^\d+$/.test(ev.display) ? ev.display : "";
    frame.over = frame.big ? "" : "准备";
    frame.phase = stripLead(ev.label);
  } else if (ev.isTimedMode) {
    const left = Number(/\d+/.exec(ev.display)?.[0] ?? 0);
    frame.sub = `${head} · 第 ${info.set} / ${total} ${unit}`;
    frame.big = String(left);
    frame.small = "秒";
    frame.ring = Math.min(1, Math.max(0, 1 - (ev.timedProgressRatio ?? 1)));
    frame.phase = breathWord ? `撑住 · ${breathWord}` : "撑住";
  } else {
    const m = /(\d+) \/ (\d+)/.exec(ev.display);
    const r = m ? Number(m[1]) : 0;
    const n = m ? Number(m[2]) : item?.reps ?? 0;
    frame.sub = `${head} · 第 ${info.set} / ${total} ${unit}`;
    frame.big = String(r);
    frame.small = `/ ${n}`;
    frame.ring = n ? Math.min(1, r / n) : 0;
    const label = stripLead(ev.label).replace(/^第 \d+ 次 · /, "").replace(/\s*\(\+1\)/, "");
    frame.phase = breathWord && !label.includes(breathWord) ? `${label} · ${breathWord}` : label;
    frame.phaseSec = tempoSeconds(item, label);
  }

  // 接下来
  const nextStage = tl.stages[stageIndex + 1];
  const after = tl.stages[stageIndex + 2];
  const nInfo = nextStage ? parseStage(nextStage.id) : null;
  const describe = (s: StageInfo) => (s.itemIndex === info.itemIndex ? `第 ${s.set} ${unit}` : `下一个：${items[s.itemIndex]?.name ?? ""}`);
  if (!nextStage || !nInfo) frame.next = "最后一段，做完就练完了";
  else if (nInfo.kind === "rest") {
    const [a, b] = stageSpan(tl, stageIndex + 1);
    const aInfo = after ? parseStage(after.id) : null;
    frame.next = `休息 ${restSeconds(tl, stageIndex + 1) ?? Math.round(b - a)} 秒` + (aInfo ? (aInfo.itemIndex === info.itemIndex ? `，然后第 ${aInfo.set} ${unit}` : `，然后：${items[aInfo.itemIndex]?.name ?? ""}`) : "");
  } else frame.next = describe(nInfo);
  if (ev.state === "rest" && nInfo && nInfo.kind !== "rest") {
    const ni = items[nInfo.itemIndex];
    if (ni) frame.nextItem = { name: ni.name, detail: tempoText(ni), set: `第 ${nInfo.set} / ${setTotalOf(tl, nInfo.itemIndex) || 1} ${unit}`, itemIndex: nInfo.itemIndex };
  }

  // 顶部的分段进度和"整节课"列表：准备段不单列
  frame.segs = tl.stages.flatMap((s, i) => {
    const p = parseStage(s.id);
    if (p?.kind === "prep") return [];
    const [a, b] = stageSpan(tl, i);
    const fill = i < stageIndex ? 1 : i > stageIndex ? 0 : Math.min(1, Math.max(0, (t - a) / Math.max(0.001, b - a)));
    return [{ id: s.id, label: s.label, rest: s.isRest, fill, seconds: (s.isRest ? restSeconds(tl, i) : null) ?? Math.round(b - a), now: i === stageIndex, past: i < stageIndex }];
  });
  return frame;
}

/** "整节课"列表里一段的名字：动作名 · 第几组，或者休息。 */
export function segTitle(course: Course, tl: Timeline, id: string): string {
  const p = parseStage(id);
  const items = courseItems(course);
  if (!p) return id;
  if (p.kind === "rest") return tl.stages.find((s) => s.id === id)?.label === "换项休" ? "换项休息" : "休息";
  const it = items[p.itemIndex];
  return it ? `${it.name} · 第 ${p.set} 组` : id;
}

export const fmtClock = (s: number) => `${String(Math.floor(Math.max(0, s) / 60)).padStart(2, "0")}:${String(Math.floor(Math.max(0, s) % 60)).padStart(2, "0")}`;
export { itemSpec };
