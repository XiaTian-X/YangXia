// 照核心库给的表单（评估、复盘）渲染：要问什么、怎么填全来自服务端算好的 FormSection，这里只负责显示和收值。
// 不认识的取值类型照实说"网页还不支持"，不悄悄丢掉。
import { fieldVisible, type FormField, type FormSection } from "@yangxia/course-core";
import { Pills } from "./Pills.tsx";

export type FormValues = Record<string, unknown>;

type GaitValue = Record<string, unknown>;

function GaitInput({ field, value, onChange }: { field: FormField; value: GaitValue | undefined; onChange: (v: GaitValue | undefined) => void }) {
  if (field.input.type !== "gait") return null;
  const inp = field.input;
  const mode = value?.result === "没测成" ? "untested" : value?.result === "按规则不测" ? "skipped" : value ? "tested" : "";
  const set = (patch: GaitValue) => onChange({ ...(value ?? {}), ...patch });
  const id = `g-${field.key.replace(/[^\w\u4e00-\u9fff]/g, "-")}`;
  return (
    <div class="stack" style={{ gap: "12px" }}>
      <Pills
        label={`${field.label}：测了没有`}
        value={mode}
        options={[
          { value: "tested", label: "测了" },
          { value: "untested", label: "没测成" },
          { value: "skipped", label: "按规则不测" },
        ]}
        onChange={(m) =>
          onChange(m === "tested" ? { cane: false, siteOk: false, ...(inp.chair ? { chairOk: false } : {}) } : m === "untested" ? { result: "没测成" } : { result: "按规则不测" })
        }
      />
      {mode === "tested" && (
        <div class="row" style={{ gap: "16px", alignItems: "flex-end" }}>
          <label class="field2" for={`${id}-s`} style={{ width: "170px" }}>
            用时（秒，往大里取一位小数）
            <input id={`${id}-s`} type="number" step="0.1" min="0" value={(value?.seconds as number | undefined) ?? ""}
              onInput={(e) => { const v = (e.target as HTMLInputElement).value; set({ seconds: v === "" ? undefined : Number(v) }); }}
              onBlur={() => { if (typeof value?.seconds === "number") set({ seconds: Math.ceil(value.seconds * 10 - 1e-9) / 10 }); }} />
          </label>
          <label class="field2" for={`${id}-d`} style={{ width: "180px" }}>
            测的日期
            <input id={`${id}-d`} type="date" value={(value?.testedOn as string | undefined) ?? ""} onInput={(e) => set({ testedOn: (e.target as HTMLInputElement).value })} />
          </label>
          <label class="check"><input type="checkbox" checked={value?.cane === true} onChange={(e) => set({ cane: (e.target as HTMLInputElement).checked })} />平时用手杖，测时照用</label>
          <label class="check"><input type="checkbox" checked={value?.siteOk === true} onChange={(e) => set({ siteOk: (e.target as HTMLInputElement).checked })} />场地防滑、清空，终点线外留了减速的地方</label>
          {inp.chair && (
            <label class="check"><input type="checkbox" checked={value?.chairOk === true} onChange={(e) => set({ chairOk: (e.target as HTMLInputElement).checked })} />椅子有扶手和靠背、无轮子、约 46 cm 高</label>
          )}
        </div>
      )}
      {mode === "untested" && (
        <div class="row" style={{ gap: "16px", alignItems: "flex-end" }}>
          <label class="field2" for={`${id}-r`} style={{ width: "240px" }}>
            没测成的原因
            <select id={`${id}-r`} value={(value?.reason as string | undefined) ?? ""} onChange={(e) => set({ reason: (e.target as HTMLSelectElement).value || undefined })}>
              <option value="">请选择</option>
              {inp.untested.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          </label>
          {value?.reason === "中途停下" && (
            <label class="field2" for={`${id}-st`} style={{ width: "200px" }}>
              停下的原因
              <select id={`${id}-st`} value={(value?.stopReason as string | undefined) ?? ""} onChange={(e) => set({ stopReason: (e.target as HTMLSelectElement).value || undefined })}>
                <option value="">请选择</option>
                {inp.stops.map((r) => <option key={r} value={r}>{r}</option>)}
              </select>
            </label>
          )}
        </div>
      )}
      {mode === "skipped" && (
        <label class="field2" for={`${id}-k`} style={{ width: "260px" }}>
          按规则不在家测的原因
          <select id={`${id}-k`} value={(value?.reason as string | undefined) ?? ""} onChange={(e) => set({ reason: (e.target as HTMLSelectElement).value || undefined })}>
            <option value="">请选择</option>
            {inp.skipped.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
        </label>
      )}
    </div>
  );
}

/** 一项输入。 */
export function FieldInput({ field, value, onChange }: { field: FormField; value: unknown; onChange: (v: unknown) => void }) {
  const id = `f-${field.key.replace(/[^\w\u4e00-\u9fff]/g, "-")}`;
  const inp = field.input;
  if (field.readonly) {
    return (
      <div class="qrow">
        <span class="q">{field.label}{field.note && <span class="note">{field.note}</span>}</span>
        <strong class="num">{field.value === true ? "是" : field.value === false ? "否" : String(field.value ?? "—")}</strong>
      </div>
    );
  }
  switch (inp.type) {
    case "yesno":
    case "yesnoUnsure": {
      const opts = [{ value: "true", label: "是" }, { value: "false", label: "否" }, ...(inp.type === "yesnoUnsure" ? [{ value: "null", label: "说不清" }] : [])];
      return (
        <div class="qrow">
          <span class="q">{field.label}{field.note && <span class="note">{field.note}</span>}</span>
          <Pills label={field.label} value={value === undefined ? "" : String(value)} options={opts}
            onChange={(v) => onChange(v === "true" ? true : v === "false" ? false : null)} />
        </div>
      );
    }
    case "enum": {
      const short = inp.options.length <= 4 && inp.options.every((o) => o.label.length <= 8);
      if (short) {
        return (
          <div class="qrow">
            <span class="q">{field.label}{field.note && <span class="note">{field.note}</span>}</span>
            <Pills label={field.label} value={value === undefined ? "" : String(value)} options={inp.options.map((o) => ({ value: String(o.value), label: o.label }))}
              onChange={(v) => onChange(inp.options.find((o) => String(o.value) === v)?.value)} />
          </div>
        );
      }
      return (
        <label class="field2" for={id}>
          {field.label}
          <select id={id} value={value === undefined ? "" : String(value)} onChange={(e) => {
            const v = (e.target as HTMLSelectElement).value;
            onChange(v === "" ? undefined : inp.options.find((o) => String(o.value) === v)?.value);
          }}>
            <option value="">请选择</option>
            {inp.options.map((o) => <option key={String(o.value)} value={String(o.value)}>{o.label}</option>)}
          </select>
          {field.note && <span class="hint">{field.note}</span>}
        </label>
      );
    }
    case "multi": {
      const cur = Array.isArray(value) ? (value as string[]) : [];
      return (
        <div class="stack" style={{ gap: "8px" }}>
          <span class="field2">{field.label}</span>
          <div class="pills" role="group" aria-label={field.label}>
            {inp.options.map((o) => {
              const on = cur.includes(o.value);
              return (
                <button key={o.value} type="button" class="pill" aria-pressed={on}
                  onClick={() => onChange(on ? cur.filter((x) => x !== o.value) : [...cur, o.value])}>{o.label}</button>
              );
            })}
          </div>
          {field.note && <span class="muted">{field.note}</span>}
        </div>
      );
    }
    case "int":
    case "decimal":
      return (
        <label class="field2" for={id}>
          {field.label}
          <input id={id} type="number" min={inp.min} max={inp.max} step={inp.type === "decimal" ? inp.step : 1}
            value={typeof value === "number" ? value : ""} style={{ maxWidth: "220px" }}
            onInput={(e) => { const v = (e.target as HTMLInputElement).value; onChange(v === "" ? undefined : Number(v)); }} />
          {field.note && <span class="hint">{field.note}</span>}
        </label>
      );
    case "date":
      return (
        <label class="field2" for={id}>
          {field.label}
          <input id={id} type="date" value={typeof value === "string" ? value : ""} style={{ maxWidth: "220px" }}
            onInput={(e) => onChange((e.target as HTMLInputElement).value || undefined)} />
          {field.note && <span class="hint">{field.note}</span>}
        </label>
      );
    case "dates": {
      const cur = Array.isArray(value) ? (value as string[]) : [""];
      return (
        <div class="stack" style={{ gap: "8px" }}>
          <span class="field2">{field.label}{field.note && <span class="hint">{field.note}</span>}</span>
          {cur.map((d, i) => (
            <div class="row" key={i}>
              <input type="date" aria-label={`${field.label} 第 ${i + 1} 个`} value={d} style={{ maxWidth: "220px" }}
                onInput={(e) => { const next = cur.slice(); next[i] = (e.target as HTMLInputElement).value; onChange(next.filter(Boolean).length ? next : undefined); }} />
              {cur.length > 1 && <button type="button" class="btn small" onClick={() => onChange(cur.filter((_, j) => j !== i))}>去掉</button>}
            </div>
          ))}
          <button type="button" class="btn small" style={{ alignSelf: "flex-start" }} onClick={() => onChange([...cur, ""])}>再加一个日期</button>
        </div>
      );
    }
    case "text":
      return (
        <label class="field2" for={id}>
          {field.label}
          <input id={id} type="text" maxLength={inp.maxLength} value={typeof value === "string" ? value : ""}
            onInput={(e) => onChange((e.target as HTMLInputElement).value || undefined)} />
          {field.note && <span class="hint">{field.note}</span>}
        </label>
      );
    case "gait":
      return (
        <div class="stack" style={{ gap: "8px", border: "1px solid var(--line-2)", borderRadius: "16px", padding: "14px 16px" }}>
          <span class="field2">{field.label}{field.note && <span class="hint">{field.note}</span>}</span>
          <GaitInput field={field} value={value as GaitValue | undefined} onChange={onChange} />
        </div>
      );
    default:
      return <div class="notice warn">「{(field as FormField).label}」这一项网页还不支持，请用命令行或助手填写</div>;
  }
}

/** 渲染整张表单：每节一张卡；showIf 不成立的项不显示。 */
export function FormRenderer({ sections, values, onChange, skip = [] }: {
  sections: FormSection[];
  values: FormValues;
  onChange: (key: string, v: unknown) => void;
  /** 由页面自己放的节（如复盘的"这一周"）。 */
  skip?: string[];
}) {
  return (
    <>
      {sections.filter((s) => !skip.includes(s.id)).map((s) => {
        const fields = s.fields.filter((f) => fieldVisible(f, values));
        if (!fields.length && !s.notes.length) return null;
        return (
          <section class="section" key={s.id}>
            <h2>{s.title}</h2>
            {s.notes.length > 0 && <div class="sub">{s.notes.join("；")}</div>}
            <div class="stack" style={{ gap: "12px" }}>
              {fields.map((f) => <FieldInput key={f.key} field={f} value={values[f.key]} onChange={(v) => onChange(f.key, v)} />)}
            </div>
          </section>
        );
      })}
    </>
  );
}
