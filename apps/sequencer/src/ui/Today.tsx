// 今天的课：这节课的概要、"这节课怎么走"、每个动作（点开看原文）、开始按钮；没课程时是导入页。
import { itemSpec, usableClip, type Course, type CourseItem, type Issue, type MotionClip, type Timeline } from "@yangxia/course-core";
import { useEffect, useRef } from "preact/hooks";
import { exportedLabel } from "../live/embedded.ts";
import type { FigurePlayer } from "../figure/player.ts";
import { Chevron, Clock, Download, File, Info, Play } from "./icons.tsx";

interface Props {
  course: Course | null;
  timeline: Timeline | null;
  clips: Record<string, MotionClip>;
  figures: FigurePlayer;
  /** 动图预载好了一次就加 1，小图跟着重画 */
  figuresReady: number;
  issues: Issue[];
  notice: string;
  figureIssue: string;
  edited: boolean;
  dragOver: boolean;
  busy: boolean;
  /** 课程包打开的：导出日期（没写是 ""）；不是课程包是 null */
  packagedOn: string | null;
  onStart: () => void;
  onExport: () => void;
  onReadFile: (f: File) => void;
  onSample: () => void;
  onLibrary: () => void;
}

const minutes = (s: number) => Math.max(1, Math.round(s / 60));

/** 动作的节奏标签：下放吸气、发力呼气（成品的通用规矩），停顿另标；计时动作照时间轴的口令"呼 2 秒、吸 2 秒"。 */
function tempoTags(it: CourseItem): { text: string; cls: string }[] {
  if (it.mode === "timed" || !it.tempo) return [{ text: "呼 2 秒", cls: "exhale" }, { text: "吸 2 秒", cls: "inhale" }];
  const t = it.tempo;
  const down = { text: `下 ${t.down} 秒 · 吸`, cls: "inhale" };
  const up = { text: `起 ${t.up} 秒 · 呼`, cls: "exhale" };
  const hold = (n?: number) => (n ? [{ text: `停 ${n} 秒`, cls: "" }] : []);
  return t.start === "down" ? [down, ...hold(t.bottom), up] : [up, ...hold(t.top), down];
}

/** 动作的小图：动图里这个动作的起始姿势；没有动图就是简笔图标。 */
function Thumb({ course, item, clips, figures, ready }: { course: Course; item: CourseItem; clips: Record<string, MotionClip>; figures: FigurePlayer; ready: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const clip = usableClip(course, item, clips);
  useEffect(() => {
    const c = ref.current;
    if (!c || !clip || !item.figure) return;
    const frame = item.mode === "timed" ? clip.hold ?? 0 : clip.phases?.[item.tempo!.start]?.[0] ?? 0;
    const img = figures.frame(item.figure, frame);
    const g = c.getContext("2d");
    if (!img || !g) return;
    g.clearRect(0, 0, c.width, c.height);
    const k = Math.min(c.width / img.width, c.height / img.height);
    g.drawImage(img, (c.width - img.width * k) / 2, (c.height - img.height * k) / 2, img.width * k, img.height * k);
  }, [clip, item.figure, ready]);
  if (clip) return <canvas ref={ref} width={272} height={272} aria-hidden="true" />;
  return (
    <svg width="44" height="44" viewBox="0 0 64 64" fill="none" stroke="var(--ink-2)" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <line x1="10" y1="56" x2="54" y2="56" stroke="#B5AE9F" stroke-width="2" /><circle cx="32" cy="12" r="5" /><polyline points="32,18 32,36 22,55" /><polyline points="32,36 42,55" /><polyline points="20,26 44,26" />
    </svg>
  );
}

export function Today(p: Props) {
  const { course, timeline } = p;
  if (!course || !timeline) {
    return (
      <div class="page">
        <div>
          <div class="eyebrow">养夏 · 跟练</div>
          <h1 class="h1">今天练什么？</h1>
        </div>
        <div class={`drop ${p.dragOver ? "over" : ""}`}>
          <File size={36} color="var(--accent)" />
          <div style={{ fontSize: 16, color: "var(--ink)" }}>把 agent 给你的课程文件（.json 或课程包 .html）拖到这里</div>
          <div class="row" style={{ justifyContent: "center" }}>
            <label class="btn primary">选择课程文件
              <input type="file" accept=".json,.html,application/json,text/html" style={{ display: "none" }} data-input="course"
                onChange={(e) => { const f = e.currentTarget.files?.[0]; e.currentTarget.value = ""; if (f) p.onReadFile(f); }} />
            </label>
            <button class="btn" onClick={p.onSample}>载入样例课程</button>
            <button class="btn" onClick={p.onLibrary}>从方案库载入</button>
          </div>
        </div>
        {p.notice && <p class="status-line" role="status">{p.notice}</p>}
        {p.figureIssue && <p class="status-line" role="status" data-figure-issue>{p.figureIssue}</p>}
        {p.issues.map((i, k) => <p key={k} class={`issue ${i.level}`}>{i.path || "课程"}：{i.message}</p>)}
        <p class="disclaimer"><Info size={16} color="var(--warn)" /><span>课程按养夏计划模板生成，计划未经专业审核，不是医学建议，不能替代医生的判断。练的时候疼、头晕、胸闷，马上停下。</span></p>
      </div>
    );
  }

  const src = course.source;
  const items = course.blocks.flatMap((b) => b.items.map((it) => ({ it, total: b.kind === "circuit" ? b.rounds : it.sets ?? 1, circuit: b.kind === "circuit" })));
  const part = (src as { part?: { n: number; of: number } }).part;
  const phase = src.phase === "稳定" ? "稳定期" : "起始期";
  const title = src.day ? `第 ${src.week} 周 · ${src.day} 日` : course.name;
  const eyebrow = [src.plan ? "今天" : "手写课程", src.product.replace(/岁-/, " 岁").replace(/（.*）$/, ""), src.segment ? `${phase}第 ${src.segment} 段` : ""].filter(Boolean).join(" · ");
  const comp = timeline.stages.map((s, i) => {
    const start = timeline.events[s.firstEventIdx]?.time ?? 0;
    const next = timeline.stages[i + 1];
    const end = next ? timeline.events[next.firstEventIdx]?.time ?? timeline.totalDuration : timeline.totalDuration;
    return { id: s.id, cls: s.id.endsWith("-prep") ? "prep" : s.isRest ? "rest" : "act", w: Math.max(0.5, end - start) };
  });

  return (
    <div class="page with-dock">
      <div class="today">
        <div class="today-main">
          <section style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <div class="eyebrow">{eyebrow}</div>
            <h1 class="h1">{title}</h1>
            <div class="meta">
              <span><Clock size={16} />约 {minutes(timeline.totalDuration)} 分钟</span>
              <span>{items.length} 个动作</span>
              {part && <span>第 {part.n} / {part.of} 部分</span>}
              {p.packagedOn !== null && <span data-packaged>课程包{p.packagedOn ? ` · ${exportedLabel(p.packagedOn)}导出` : ""}</span>}
              {src.half && <span>半量课</span>}
            </div>
          </section>


          <section style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <div class="eyebrow">这节课怎么走</div>
            <div class="compbar" aria-label="开头准备、每组和中间的休息，按时长排开">
              {comp.map((c) => <div key={c.id} class={c.cls} style={{ flex: c.w }} />)}
            </div>
            <div class="legend">
              <span><i style={{ background: "var(--accent)" }} />练</span>
              <span><i style={{ background: "var(--line)" }} />休息</span>
              <span><i style={{ background: "#B9CFC2" }} />准备</span>
            </div>
          </section>

          <div class="dock">
            <button class="btn primary big" data-start disabled={p.busy} onClick={p.onStart}><Play size={20} />开始跟练</button>
            <button class="icon-btn big" aria-label="导出视频、音频、字幕" data-open-export onClick={p.onExport}><Download size={22} /></button>
          </div>

          {p.notice && <p class="status-line" role="status">{p.notice}</p>}
          {p.figureIssue && <p class="status-line" role="status" data-figure-issue>{p.figureIssue}</p>}
          {p.edited && <p class="issue warning">已手动修改：和成品原文可能不一致，交给 agent 前请重新检查。</p>}
          {p.issues.filter((i) => i.level === "warning").map((i, k) => <p key={k} class="issue warning">{i.path || "课程"}：{i.message}</p>)}
          <p class="disclaimer"><Info size={16} color="var(--warn)" /><span>计划未经专业审核，不是医学建议，不能替代医生的判断。练的时候疼、头晕、胸闷，马上停下。</span></p>
          <div class="row">
            <label class="btn">换一节课
              <input type="file" accept=".json,.html,application/json,text/html" style={{ display: "none" }} data-input="course"
                onChange={(e) => { const f = e.currentTarget.files?.[0]; e.currentTarget.value = ""; if (f) p.onReadFile(f); }} />
            </label>
            <span class="note">也可以把课程文件拖进来</span>
          </div>
        </div>

        <section class="today-side">
          <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between" }}>
            <h2 class="h2">今天练什么</h2>
            <span class="note">点开看原文</span>
          </div>
          <div class="moves">
            {items.map(({ it, total }, i) => (
              <details class="move" key={i} data-move={i}>
                <summary>
                  <div class="thumb"><Thumb course={course} item={it} clips={p.clips} figures={p.figures} ready={p.figuresReady} /></div>
                  <div class="body">
                    <div class="name">{it.name}</div>
                    <div class="spec">{itemSpec(it, total)}{it.rest ? ` · 休息 ${it.rest} 秒` : ""}</div>
                    <div class="tags">{tempoTags(it).map((t, k) => <span key={k} class={`tag ${t.cls}`}>{t.text}</span>)}</div>
                  </div>
                  <span class="chev"><Chevron size={18} /></span>
                </summary>
                <div class="quotes">
                  {it.quote.map((q, k) => <div class="quote" key={k}>{q}</div>)}
                  {!src.plan && <div class="note">手写课程：原文不经检查。</div>}
                </div>
              </details>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}

