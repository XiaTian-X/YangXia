// 课程编辑：导入的课程原样显示，也可以手动调整（调整后不再保证和成品原文一致，界面会提示）。
import type { Block, Course, CourseItem, Tempo } from "@yangxia/course-core";

interface Props {
  course: Course;
  playingItem: number;
  onChange: (c: Course) => void;
}

const num = (v: string, fallback: number) => (Number.isFinite(Number(v)) && v !== "" ? Number(v) : fallback);

function newItem(): CourseItem {
  return { exercise: "custom", name: "新动作", mode: "reps", sets: 2, reps: 10, tempo: { start: "up", up: 1, down: 2 }, rest: 60, quote: ["手动添加"] };
}

export function Editor({ course, playingItem, onChange }: Props) {
  let flat = -1;
  const update = (fn: (c: Course) => void) => {
    const c: Course = JSON.parse(JSON.stringify(course));
    fn(c);
    onChange(c);
  };
  // 改了动作名或计次方式，就不再是导出时的那个动作了：动作示意跟着去掉
  const setItem = (bi: number, ii: number, patch: Partial<CourseItem>) =>
    update((c) => {
      const item = Object.assign(c.blocks[bi].items[ii], patch);
      if ("name" in patch || "mode" in patch || "exercise" in patch) delete item.figure;
    });
  const setTempo = (bi: number, ii: number, patch: Partial<Tempo>) =>
    update((c) => Object.assign(c.blocks[bi].items[ii].tempo ??= { start: "up", up: 1, down: 2 }, patch));
  const move = (bi: number, ii: number, d: number) =>
    update((c) => {
      const items = c.blocks[bi].items;
      const j = ii + d;
      if (j < 0 || j >= items.length) return;
      [items[ii], items[j]] = [items[j], items[ii]];
    });

  return (
    <div>
      {course.blocks.map((block: Block, bi) => (
        <div key={bi}>
          {block.kind === "circuit" && (
            <div class="row note" style={{ marginBottom: 8 }}>
              循环
              <input type="number" min={1} max={10} style={{ width: 64 }} value={block.rounds}
                onInput={(e) => update((c) => { (c.blocks[bi] as typeof block).rounds = num(e.currentTarget.value, 1); })} />
              轮，轮间休息
              <input type="number" min={0} max={300} style={{ width: 72 }} value={block.restBetweenRounds ?? 0}
                onInput={(e) => update((c) => { (c.blocks[bi] as typeof block).restBetweenRounds = num(e.currentTarget.value, 0); })} />
              秒
            </div>
          )}
          {block.items.map((it, ii) => {
            flat++;
            return (
              <div class={`item ${flat === playingItem ? "playing" : ""}`} key={`${bi}-${ii}`}>
                <div class="item-head">
                  <input type="text" maxLength={24} value={it.name} onInput={(e) => setItem(bi, ii, { name: e.currentTarget.value })} />
                  <div class="row" style={{ flexWrap: "nowrap" }}>
                    <button class="btn small" title="上移" onClick={() => move(bi, ii, -1)}>↑</button>
                    <button class="btn small" title="下移" onClick={() => move(bi, ii, 1)}>↓</button>
                    <button class="btn small danger" title="删除" disabled={block.items.length === 1 && course.blocks.length === 1}
                      onClick={() => update((c) => {
                        c.blocks[bi].items.splice(ii, 1);
                        if (!c.blocks[bi].items.length) c.blocks.splice(bi, 1);
                      })}>✕</button>
                  </div>
                </div>
                <div class="item-grid">
                  <label>方式
                    <select value={it.mode} onChange={(e) => setItem(bi, ii, e.currentTarget.value === "timed"
                      ? { mode: "timed", duration: it.duration ?? 30 } : { mode: "reps", reps: it.reps ?? 10, tempo: it.tempo ?? { start: "up", up: 1, down: 2 } })}>
                      <option value="reps">按次</option>
                      <option value="timed">计时</option>
                    </select>
                  </label>
                  {block.kind === "sets" && (
                    <label>组数<input type="number" min={1} max={10} value={it.sets ?? 1} onInput={(e) => setItem(bi, ii, { sets: num(e.currentTarget.value, 1) })} /></label>
                  )}
                  {it.mode === "reps"
                    ? <label>次数<input type="number" min={1} max={60} value={it.reps} onInput={(e) => setItem(bi, ii, { reps: num(e.currentTarget.value, 1) })} /></label>
                    : <label>秒数<input type="number" min={5} max={600} value={it.duration} onInput={(e) => setItem(bi, ii, { duration: num(e.currentTarget.value, 30) })} /></label>}
                  <label>休息(秒)<input type="number" min={0} max={300} value={it.rest} onInput={(e) => setItem(bi, ii, { rest: num(e.currentTarget.value, 0) })} /></label>
                  <label>每侧
                    <select value={it.perSide ? "1" : "0"} onChange={(e) => setItem(bi, ii, { perSide: e.currentTarget.value === "1" })}>
                      <option value="0">否</option>
                      <option value="1">左右各做</option>
                    </select>
                  </label>
                  {it.mode === "reps" && it.tempo && (
                    <>
                      <label>先
                        <select value={it.tempo.start} onChange={(e) => setTempo(bi, ii, { start: e.currentTarget.value as Tempo["start"] })}>
                          <option value="up">发力</option>
                          <option value="down">下放</option>
                        </select>
                      </label>
                      {(["up", "top", "down", "bottom"] as const).map((k) => (
                        <label key={k}>{{ up: "发力", top: "顶点停", down: "下放", bottom: "底部停" }[k]}(秒)
                          <input type="number" step={0.5} min={k === "up" || k === "down" ? 0.5 : 0} max={10} value={it.tempo![k] ?? 0}
                            onInput={(e) => setTempo(bi, ii, { [k]: num(e.currentTarget.value, 0) })} />
                        </label>
                      ))}
                    </>
                  )}
                </div>
                {it.quote.length > 0 && <div class="note" style={{ marginTop: 6 }}>原文：{it.quote.join(" ｜ ")}</div>}
              </div>
            );
          })}
        </div>
      ))}
      <button class="btn small" onClick={() => update((c) => {
        const last = c.blocks[c.blocks.length - 1];
        if (last && last.kind === "sets") last.items.push(newItem());
        else c.blocks.push({ kind: "sets", items: [newItem()] });
      })}>＋ 加一个动作</button>
    </div>
  );
}
