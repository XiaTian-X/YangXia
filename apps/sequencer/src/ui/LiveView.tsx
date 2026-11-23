// 跟练（全屏，深色）：呼吸环套着大字次数，下面是这一拍的口令；休息时是倒计时环和下一组预告。
// 手机竖屏一栏；手机横屏三栏（示意、次数、按钮）；电脑上多一栏"整节课"（点一段就跳过去）。布局由 styles.css 切换。
import type { Course, Timeline } from "@yangxia/course-core";
import type { Ref } from "preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { fmtClock, segTitle, type LiveFrame } from "../live/view.ts";
import { Expand, Next, Pause, Play, Prev } from "./icons.tsx";

interface Props {
  course: Course;
  timeline: Timeline;
  frame: LiveFrame;
  elapsed: number;
  paused: boolean;
  /** 动作示意：画布、外框（画的时候写 data-fig，没有图就显示文字）、图下的说明，都由 App 每帧画 */
  figureRef: Ref<HTMLCanvasElement>;
  figureWrapRef: Ref<HTMLDivElement>;
  captionRef: Ref<HTMLSpanElement>;
  onPause: () => void;
  onResume: () => void;
  onPrev: () => void;
  onNext: () => void;
  onEnd: () => void;
  onJump: (stageId: string) => void;
  onFullscreen: (() => void) | null;
  /** 自动暂停的原因（切到后台），暂停标记上写明 */
  pauseWhy: string;
  /** 这节课有没有动作示意（没有就不留示意那一栏） */
  hasFigure: boolean;
}

const C = 2 * Math.PI * 108;

function Ring({ f }: { f: LiveFrame }) {
  const rest = f.mode === "rest";
  const disc = f.breath === "inhale" ? ["var(--inhale-soft)", "var(--inhale)"] : f.breath === "exhale" ? ["var(--exhale-soft)", "var(--exhale)"] : ["var(--surface)", "none"];
  return (
    <div class="ring" data-ring={f.ring.toFixed(3)}>
      <svg viewBox="0 0 236 236" aria-hidden="true">
        <circle cx="118" cy="118" r="108" fill="none" stroke="var(--surface-2)" stroke-width="10" />
        <circle cx="118" cy="118" r="108" fill="none" stroke={rest ? "var(--ink-2)" : "var(--accent)"} stroke-width="10" stroke-linecap="round"
          stroke-dasharray={`${(f.ring * C).toFixed(1)} ${C.toFixed(1)}`} transform="rotate(-90 118 118)" />
        {!rest && <circle cx="118" cy="118" r="86" fill={disc[0]} stroke={disc[1]} stroke-width="3" />}
        {!rest && f.breath && <circle cx="118" cy="118" r="70" fill="none" stroke={disc[1]} stroke-width="2" stroke-opacity="0.35" stroke-dasharray="3 7" />}
      </svg>
      <div class="val">
        {f.over && <div class="over">{f.over}</div>}
        <div class="big" data-count>{f.big}</div>
        {f.small && <div class="small">{f.small}</div>}
      </div>
    </div>
  );
}

const DISCLAIMER = "未经专业审核，不是医学建议，不能替代医生的判断。疼、头晕、胸闷马上停下。";

export function LiveView(p: Props) {
  const f = p.frame;
  const rest = f.mode === "rest";
  // "结束"要点两次（3 秒内）：趴在地上做动作时容易误碰
  const [arm, setArm] = useState(false);
  const armTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const end = () => {
    if (arm) return p.onEnd();
    setArm(true);
    if (armTimer.current) clearTimeout(armTimer.current);
    armTimer.current = setTimeout(() => setArm(false), 3000);
  };
  useEffect(() => () => { if (armTimer.current) clearTimeout(armTimer.current); }, []);
  const root = useRef<HTMLElement>(null);
  // 环的大小 = 中间一格的高度减去口令那一块的实际高度（口令折行时环跟着变小），由样式里的 --info-h 用
  const center = useRef<HTMLDivElement>(null);
  const info = useRef<HTMLDivElement>(null);
  const measure = () => {
    const c = center.current;
    const i = info.current;
    if (c && i) c.style.setProperty("--info-h", `${Math.ceil(i.getBoundingClientRect().height)}px`);
  };
  // 口令换了（每次重画）当场量；窗口变了（转屏）由 ResizeObserver 量
  useLayoutEffect(measure);
  useEffect(() => {
    const i = info.current;
    if (!i || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(i);
    return () => ro.disconnect();
  }, []);
  // 打开时把焦点放到看得见的"暂停"上（读屏、键盘从这里开始；横屏时按钮在右栏）
  useEffect(() => {
    const btn = [...(root.current?.querySelectorAll<HTMLButtonElement>("button.pause") ?? [])].find((b) => b.offsetParent !== null);
    btn?.focus({ preventScroll: true });
  }, []);
  const pauseBtn = p.paused
    ? <button class="pause resume" onClick={p.onResume} data-resume><Play size={24} />继续</button>
    : <button class="pause" onClick={p.onPause} data-pause><Pause size={24} />暂停</button>;
  const controls = (
    <div class="controls">
      <button onClick={p.onPrev} aria-label="上一段" title="快捷键 ←"><Prev size={20} />上一段</button>
      {pauseBtn}
      <button onClick={p.onNext} aria-label="下一段" title="快捷键 →"><Next size={20} />下一段</button>
    </div>
  );
  const foot = (
    <div class="live-foot">
      <span class="disc">{DISCLAIMER}</span>
    </div>
  );
  const nowSeg = f.segs.findIndex((s) => s.now);
  const nextCard = rest && f.nextItem && (
    <><b>{f.nextItem.name}</b> · {f.nextItem.set}<br /><span class="detail">{f.nextItem.detail}</span></>
  );

  return (
    <section ref={root} class="live" role="dialog" aria-modal="true" aria-label={`跟练：${f.title}`} data-live data-mode={f.mode} data-figure={p.hasFigure ? "1" : "0"}>
      <header class="live-head">
        <div class="top">
          <div>
            <div class="sub">{f.sub}</div>
            <div class="title">{f.title}</div>
          </div>
          <div class="head-tools">
            {p.paused && <span class="paused" role="status">{p.pauseWhy ? "切到后台，已暂停" : "已暂停"}</span>}
            {p.onFullscreen && <button class="tool" onClick={p.onFullscreen} aria-label="全屏"><Expand size={20} /></button>}
            <button class="end" data-end onClick={end}>{arm ? "再点一次结束" : "结束"}</button>
          </div>
        </div>
        <div class="segs-row">
          <div class="segs" role="img" aria-label={nowSeg < 0 ? `准备中，这节课共 ${f.segs.length} 段` : `这节课第 ${nowSeg + 1} 段，共 ${f.segs.length} 段`}>
            {f.segs.map((s) => <div key={s.id} class={s.rest ? "rest" : ""} style={{ flex: s.rest ? 0.5 : 1 }}><i style={{ width: `${Math.round(s.fill * 100)}%` }} /></div>)}
          </div>
          <div class="clock num">{fmtClock(p.elapsed)} <small>/ {fmtClock(p.timeline.totalDuration)}</small></div>
        </div>
      </header>

      <div class="live-figure" ref={p.figureWrapRef} data-fig="0">
        <canvas ref={p.figureRef} width={840} height={540} aria-label="动作示意" />
        <div class="none">{rest ? "休息一下，下一组准备好再开始" : f.title}</div>
        <span class="cap" ref={p.captionRef} />
        {nextCard && <div class="fig-next"><span>下一组</span> {nextCard}</div>}
      </div>

      <div class="live-center" ref={center}>
        <Ring f={f} />
        <div class="info" ref={info}>
          {rest ? (
            <>
              <div class="cue">跟着慢慢呼吸</div>
              <div class="breath-pills">
                <span class={`in ${f.breath === "inhale" ? "on" : ""}`}><i style={{ background: "var(--inhale)" }} />深吸气 2 秒</span>
                <span class={`ex ${f.breath === "exhale" ? "on" : ""}`}><i style={{ background: "var(--exhale)" }} />慢呼气 2 秒</span>
              </div>
              {nextCard && <div class="next-inline"><span>下一组</span> {nextCard}</div>}
            </>
          ) : (
            f.phase && (
              <div class={`phase ${f.breath ?? ""}`} data-phase>
                <i />
                <b>{f.phase}</b>
                {f.phaseSec && <span class="sec">{f.phaseSec}</span>}
              </div>
            )
          )}
        </div>
      </div>

      {nextCard ? (
        <div class="live-next card-next">
          <span>下一组</span>
          <span style={{ textAlign: "right" }}>{nextCard}</span>
        </div>
      ) : (
        <div class="live-next"><span>接下来</span><span>{f.next}</span></div>
      )}

      {controls}
      {foot}

      <div class="live-side">{controls}{foot}</div>

      <aside class="live-list" aria-label="整节课">
        <div class="lab">这节课</div>
        {f.segs.map((s) => (
          <button key={s.id} data-stage={s.id} class={`${s.rest ? "rest" : ""} ${s.now ? "now" : ""} ${s.past ? "past" : ""}`} onClick={() => p.onJump(s.id)}>
            <span>{segTitle(p.course, p.timeline, s.id)}</span><span class="num">{s.seconds} 秒</span>
          </button>
        ))}
        <div class="keys">键盘：空格 暂停 / 继续 · ← → 换段</div>
      </aside>
      <div class="live-end">
        {p.onFullscreen && <button class="tool" onClick={p.onFullscreen}>全屏</button>}
        <button class="end-btn" data-end onClick={end}>{arm ? "再点一次结束" : "结束这节课"}</button>
      </div>
    </section>
  );
}
