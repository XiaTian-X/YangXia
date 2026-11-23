// 练完（或中途结束）：这次练了多久、几组，填整体感受、每个动作的感受、有没有不适，存成练习记录文件交给 agent。
// 记录只存成使用者自己的文件；能分享的设备（手机）可以直接分享回电脑，不能就下载。
import { FEELS, type Course, type ItemNote } from "@yangxia/course-core";
import { useEffect, useRef } from "preact/hooks";
import { unitsOf } from "../live/view.ts";
import { download, sessionRecord, type Feeling } from "../export/exporters.ts";
import { Check, Share, Warn } from "./icons.tsx";

/** 一次跟练：练的是哪份课程（开始时的快照）、开始结束时间、有没有练完、每个动作实际完成了几组（核心库 setsDoneFromPlayed 算）。 */
export type Session = { course: Course; edited: boolean; startedAt: Date; endedAt: Date; completed: boolean; setsDone: Record<number, number> };

/** 本地日期 YYYY-MM-DD（toISOString 是 UTC，北京时间凌晨会差一天）。 */
const localDate = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
/** 本地时分 HHMM：一天练两次，文件名也不会重名。 */
const localTime = (d: Date) => `${String(d.getHours()).padStart(2, "0")}${String(d.getMinutes()).padStart(2, "0")}`;
export const recordName = (s: Session) => `养夏_练习记录_${localDate(s.startedAt)}_${localTime(s.startedAt)}.json`;

const SYMPTOMS = [["pain", "关节疼"], ["dizzy", "头晕、眼前发黑"], ["chest", "胸痛、胸闷、心慌"]] as const;

/** 练完页填的内容。放在 App 里：去"设置"看一眼再回来，填的不丢。 */
export interface DoneForm {
  feeling: Feeling;
  symptoms: { pain: boolean; dizzy: boolean; chest: boolean };
  note: string;
  perItem: Record<number, ItemNote>;
}
export const emptyDoneForm = (): DoneForm => ({ feeling: "正好", symptoms: { pain: false, dizzy: false, chest: false }, note: "", perItem: {} });

interface Props {
  session: Session;
  form: DoneForm;
  onForm: (f: DoneForm) => void;
  onDone: () => void;
  onNotice: (s: string) => void;
}

/** 能把文件分享出去（手机系统的分享面板）就分享；不能、被拒就退回下载。用户自己取消分享不算失败。 */
async function shareOrDownload(blob: Blob, name: string): Promise<"shared" | "downloaded" | "cancelled"> {
  const file = new File([blob], name, { type: "application/json" });
  const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean };
  if (nav.share && nav.canShare?.({ files: [file] })) {
    try {
      await nav.share({ files: [file], title: name });
      return "shared";
    } catch (e) {
      if ((e as Error).name === "AbortError") return "cancelled";
    }
  }
  download(blob, name);
  return "downloaded";
}

export function DoneView({ session, form, onForm, onDone, onNotice }: Props) {
  const { feeling, symptoms, note, perItem } = form;
  const setFeeling = (f: Feeling) => onForm({ ...form, feeling: f });
  const setSymptoms = (x: DoneForm["symptoms"]) => onForm({ ...form, symptoms: x });
  const setNote = (x: string) => onForm({ ...form, note: x });
  const setPerItem = (x: Record<number, ItemNote>) => onForm({ ...form, perItem: x });
  const anySymptom = symptoms.pain || symptoms.dizzy || symptoms.chest;
  const units = unitsOf(session.course);
  // 跟练页关掉以后焦点落到标题上（读屏从这里接着读）
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { heading.current?.focus({ preventScroll: true }); }, [session]);
  // 动作顺序和时间轴的 itemIndex 一致：按 blocks、items 的先后展开
  const rows = session.course.blocks.flatMap((b) => b.items.map((it) => ({ it, planned: b.kind === "circuit" ? b.rounds : it.sets ?? 1 })));
  const gym = /健身房/.test(session.course.source.product);
  const set = (i: number, patch: Partial<ItemNote>) => setPerItem({ ...perItem, [i]: { ...perItem[i], ...patch } });
  const secs = Math.max(0, Math.round((session.endedAt.getTime() - session.startedAt.getTime()) / 1000));
  const allCircuit = units.length > 0 && units.every((u) => u === "轮");
  const setsDone = rows.reduce((n, r, i) => n + Math.min(r.planned, session.setsDone[i] ?? 0), 0);
  const setsPlanned = rows.reduce((n, r) => n + r.planned, 0);
  const src = session.course.source;
  const blob = () => sessionRecord(session.course, { ...session, feeling, symptoms, note, perItem });

  return (
    <div class="page with-dock" data-done>
      <section style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div style={{ width: 52, height: 52, borderRadius: 18, background: "var(--accent-soft)", display: "flex", alignItems: "center", justifyContent: "center" }}>
          <Check size={28} color="var(--accent)" />
        </div>
        <div>
          <h1 class="h1" style={{ fontSize: 30, outline: "none" }} ref={heading} tabIndex={-1}>{session.completed ? "练完了" : "这次先练到这里"}</h1>
          <div class="eyebrow" style={{ fontSize: 14, marginTop: 2 }}>{src.day ? `第 ${src.week} 周 · ${src.day} 日` : session.course.name}</div>
        </div>
        <div class="stats">
          <div><b>{`${String(Math.floor(secs / 60)).padStart(2, "0")}:${String(secs % 60).padStart(2, "0")}`}</b><span>用时</span></div>
          <div><b>{setsDone}<small style={{ fontSize: 14, color: "var(--ink-2)" }}> / {setsPlanned}</small></b><span>{allCircuit ? "轮" : "组"}</span></div>
          <div><b>{rows.length}</b><span>个动作</span></div>
        </div>
      </section>

      <section style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <h2 class="h2">整体感受</h2>
        <div class="choice" role="group" aria-label="整体感受" data-feeling>
          {(["轻松", "正好", "吃力"] as Feeling[]).map((f) => <button key={f} type="button" aria-pressed={feeling === f} onClick={() => setFeeling(f)}>{f}</button>)}
        </div>
      </section>

      <section style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <h2 class="h2">练的时候有没有这些情况</h2>
        <div class="choice symptom" role="group" aria-label="不适">
          {SYMPTOMS.map(([k, t]) => (
            <button key={k} type="button" data-symptom={k} aria-pressed={symptoms[k]} onClick={() => setSymptoms({ ...symptoms, [k]: !symptoms[k] })}>{t}</button>
          ))}
        </div>
        {anySymptom && (
          <div class="warn-panel" role="alert"><Warn size={20} color="var(--danger)" />
            <span>有不适：下周先不加量，按计划里"疼了怎么办"处理；胸痛、胸闷、头晕站不稳要尽快就医。</span>
          </div>
        )}
      </section>

      <section style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <div>
          <h2 class="h2">每个动作（可不填）</h2>
          <div class="note" style={{ marginTop: 2 }}>第 1–2 周找级：照计划原话选最接近的一句，下次训练按它调一级；升级后做不到下限，勾"当场退回"，下次用原来那一级。</div>
        </div>
        {rows.map(({ it }, i) => (
          <div class="card" key={i} data-item={i} style={{ display: "flex", flexDirection: "column", gap: 8, padding: 12, borderRadius: 18 }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
              <b style={{ fontSize: 16 }}>{it.name}</b>
              <span class="note num">{Math.min(rows[i].planned, session.setsDone[i] ?? 0)} / {rows[i].planned} {units[i] ?? "组"}</span>
            </div>
            <div class="options" role="group" aria-label={`${it.name} 的感受`}>
              {FEELS.map((f) => {
                const on = perItem[i]?.feel === f;
                return <button key={f} type="button" aria-pressed={on} onClick={() => set(i, { feel: on ? undefined : f })}><i />{f}</button>;
              })}
            </div>
            <div class="row">
              {gym && (
                <label class="field" style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>还能做几下
                  <input aria-label={`${it.name} 还能做几下`} type="number" min={0} max={30} style={{ width: 90 }} value={perItem[i]?.spare ?? ""}
                    onInput={(e) => set(i, { spare: e.currentTarget.value === "" ? undefined : Math.max(0, Math.min(30, Math.round(Number(e.currentTarget.value)))) })} />
                </label>
              )}
              <label class="check" style={{ justifyContent: "flex-start", minHeight: 44 }}>
                <input type="checkbox" aria-label={`${it.name} 当场退回`} checked={!!perItem[i]?.reverted} onChange={(e) => set(i, { reverted: e.currentTarget.checked })} />当场退回
              </label>
            </div>
          </div>
        ))}
      </section>

      <label class="field"><span>备注（可不填）</span>
        <textarea rows={2} maxLength={500} value={note} onInput={(e) => setNote(e.currentTarget.value)} />
      </label>

      <div class="dock done-dock">
        <div class="row" style={{ flexWrap: "nowrap", width: "100%" }}>
          <button class="btn primary big" style={{ flex: 1 }} data-save-record onClick={() => { download(blob(), recordName(session)); onNotice("练习记录已保存：放进 profiles/<代号>/打卡/，周复盘会读它。"); onDone(); }}>保存练习记录</button>
          <button class="icon-btn big" aria-label="分享练习记录" data-share-record onClick={async () => {
            const r = await shareOrDownload(blob(), recordName(session));
            if (r === "cancelled") return;
            onNotice(r === "shared" ? "练习记录已分享。" : "这台设备不能直接分享，已改成下载练习记录。");
            onDone();
          }}><Share size={22} /></button>
        </div>
        <div class="row" style={{ justifyContent: "space-between", width: "100%", flexWrap: "nowrap" }}>
          <span class="note">记录只存成你自己的文件，周复盘时交给 agent。</span>
          <button class="btn" style={{ border: 0, background: "none", color: "var(--accent)", flex: "none" }} onClick={onDone}>不记录</button>
        </div>
      </div>
    </div>
  );
}
