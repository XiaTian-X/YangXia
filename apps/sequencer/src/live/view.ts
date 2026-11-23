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

/**
 * 呼吸提示文字里是吸还是呼。领呼写成 `🗣️ 领呼"吸"`，按引号里的字算（"领呼"本身带"呼"）；
 * "均匀呼吸""自然呼吸""别把气停住"这类不分。
 */
export function breathOf(text: string): Breath {
  const lead = /领呼"(吸|呼)"/.exec(text);
  if (lead) return lead[1] === "吸" ? "inhale" : "exhale";
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
/** 这一拍的呼吸口令写成给人看的话：领呼"吸"写成"吸气"。 */
const breathPhrase = (text: string) => {
  const lead = /领呼"(吸|呼)"/.exec(text);
  return lead ? (lead[1] === "吸" ? "吸气" : "呼气") : stripLead(text);
};

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
  if (!tl.events.length || !tl.stages.length) return emptyFrame();
  const ev: TimelineEvent = tl.events[Math.max(0, Math.min(idx, tl.events.length - 1))];
  const stageIndex = Math.max(0, tl.stages.findIndex((s) => s.id === ev.phaseGroup));
  const info = parseStage(tl.stages[stageIndex]?.id ?? "") ?? { kind: "set", itemIndex: ev.itemIndex, set: 1 };
  // 休息段末尾的"开始""马上开始 X"已经是下一段的准备：标题、单位按下一段的动作算
  const nextOfStage = tl.stages[stageIndex + 1] ? parseStage(tl.stages[stageIndex + 1].id) : null;
  const itemIndex = ev.state === "prep" && info.kind === "rest" && nextOfStage ? nextOfStage.itemIndex : info.itemIndex;
  const item = items[itemIndex];
  const units = unitsOf(course);
  const unit = units[info.itemIndex] ?? "组";
  const total = setTotalOf(tl, info.itemIndex) || 1;
  const head = `${itemIndex + 1} / ${items.length}`;
  const side = /· (左侧|右侧)/.exec(ev.tag)?.[1];
  const [start, end] = stageSpan(tl, stageIndex);
  const breath = breathOf(ev.breathText);
  const breathWord = breath === "inhale" ? "吸气" : breath === "exhale" ? "呼气" : "";

  const frame: LiveFrame = {
    mode: ev.state, title: item?.name ?? "", sub: "", big: "", small: "", over: "", ring: 0, breath, phase: "", phaseSec: "",
    next: "", nextItem: null, itemIndex, stageIndex, segs: [],
  };

  if (ev.state === "rest") {
    // 休息按时间轴每秒的显示倒数（"90s"），和报数、视频一致；休息末尾的"准备第 2 组 3、2、1"单独显示
    const all = restSeconds(tl, stageIndex) ?? Math.max(1, Math.round(end - start));
    const sec = /^(\d+)s$/.exec(ev.display);
    frame.title = tl.stages[stageIndex].label === "换项休" ? "换项休息" : `${unit}间休息`;
    // 循环里一轮中间换动作：这一轮还没做完，只是这个动作做完了
    frame.sub = unit === "轮" && tl.stages[stageIndex].label === "换项休"
      ? `${head} · 这一轮的${items[info.itemIndex]?.name ?? "动作"}做完了`
      : `${head} · 第 ${info.set} ${unit}做完了`;
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
    frame.title = item?.name ?? "";
    frame.big = /^\d+$/.test(ev.display) ? ev.display : "";
    frame.over = frame.big ? "" : "准备";
    frame.phase = stripLead(ev.label);
  } else if (/^(左侧|右侧)$/.test(ev.display)) {
    // 每侧动作中间换边（不休息）
    frame.sub = `${head} · 第 ${info.set} / ${total} ${unit}`;
    frame.over = "换边";
    frame.big = ev.display;
    frame.small = "不休息";
    frame.ring = 0;
    frame.phase = stripLead(ev.label);
  } else if (ev.isTimedMode) {
    const done = /✓/.test(ev.display);
    const left = Number(/\d+/.exec(ev.display)?.[0] ?? 0);
    // 每侧的计时动作做完那一拍，时间轴标签里没有左右侧：两侧都做完了
    const sideText = side ? ` · ${side}` : done && item?.perSide ? " · 两侧做完" : "";
    frame.sub = `${head} · 第 ${info.set} / ${total} ${unit}${sideText}`;
    frame.big = String(left);
    frame.small = "秒";
    // 环按做了多少走；做完那一拍是满的
    frame.ring = done ? 1 : Math.min(1, Math.max(0, 1 - (ev.timedProgressRatio ?? 1)));
    frame.phase = done ? stripLead(ev.label) : breathPhrase(ev.breathText);
  } else {
    const m = /(\d+) \/ (\d+)/.exec(ev.display);
    const r = m ? Number(m[1]) : 0;
    const n = m ? Number(m[2]) : item?.reps ?? 0;
    frame.sub = `${head} · 第 ${info.set} / ${total} ${unit}${side ? ` · ${side}` : ""}`;
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
  // 准备段（含休息末尾的准备）：接下来就是这一段要做的那一组
  if (ev.state === "prep" && nextOfStage && nextOfStage.kind === "set" && info.kind !== "set") {
    frame.next = `${items[nextOfStage.itemIndex]?.name ?? ""} · 第 ${nextOfStage.set} ${units[nextOfStage.itemIndex] ?? "组"}`;
  } else if (!nextStage || !nInfo) frame.next = "最后一段，做完就练完了";
  else if (nInfo.kind === "rest") {
    const [a, b] = stageSpan(tl, stageIndex + 1);
    const aInfo = after ? parseStage(after.id) : null;
    frame.next = `休息 ${restSeconds(tl, stageIndex + 1) ?? Math.round(b - a)} 秒` + (aInfo ? (aInfo.itemIndex === info.itemIndex ? `，然后第 ${aInfo.set} ${unit}` : `，然后：${items[aInfo.itemIndex]?.name ?? ""}`) : "");
  } else frame.next = describe(nInfo);
  if (ev.state === "rest" && nInfo && nInfo.kind !== "rest") {
    const ni = items[nInfo.itemIndex];
    if (ni) frame.nextItem = { name: ni.name, detail: tempoText(ni), set: `第 ${nInfo.set} / ${setTotalOf(tl, nInfo.itemIndex) || 1} ${units[nInfo.itemIndex] ?? "组"}`, itemIndex: nInfo.itemIndex };
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

/** 每个动作按"组"还是"轮"数：循环（circuit）里的动作是轮。下标和 courseItems 一致。 */
export function unitsOf(course: Course): ("组" | "轮")[] {
  return course.blocks.flatMap((b) => b.items.map(() => (b.kind === "circuit" ? "轮" : "组") as "组" | "轮"));
}

function emptyFrame(): LiveFrame {
  return { mode: "prep", title: "", sub: "", big: "", small: "", over: "", ring: 0, breath: null, phase: "", phaseSec: "", next: "", nextItem: null, itemIndex: 0, stageIndex: 0, segs: [] };
}

/** "整节课"列表里一段的名字：动作名 · 第几组（循环里是第几轮），或者休息。 */
export function segTitle(course: Course, tl: Timeline, id: string): string {
  const p = parseStage(id);
  const items = courseItems(course);
  if (!p) return id;
  if (p.kind === "rest") return tl.stages.find((s) => s.id === id)?.label === "换项休" ? "换项休息" : `${unitsOf(course)[p.itemIndex] ?? "组"}间休息`;
  const it = items[p.itemIndex];
  return it ? `${it.name} · 第 ${p.set} ${unitsOf(course)[p.itemIndex] ?? "组"}` : id;
}

export const fmtClock = (s: number) => `${String(Math.floor(Math.max(0, s) / 60)).padStart(2, "0")}:${String(Math.floor(Math.max(0, s) % 60)).padStart(2, "0")}`;
export { itemSpec };
