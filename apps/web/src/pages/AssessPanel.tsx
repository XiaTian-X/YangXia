// 评估（设计稿"网页 · 评估"）：四种评估要问、要测什么由核心 assessmentForm 给，网页照着渲染；
// 记录由核心 buildAssessmentRecord 组装，结论由服务端重算、照 conclusionLines 翻成人话。
import { buildAssessmentRecord, conclusionLines, missingFields, type AssessmentForm } from "@yangxia/course-core";
import { useEffect, useState } from "preact/hooks";
import { FormRenderer, type FormValues } from "../components/FormRenderer.tsx";
import { apiRequest, formatApiError } from "../lib/api.ts";
import type { AssessmentFormResponse, AssessmentListItem, ProfileSummary } from "../types.ts";

type Kind = "入门" | "段末" | "周期末" | "触发";
const KINDS: Kind[] = ["入门", "段末", "周期末", "触发"];

function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function AssessPanel({ profile, isAdmin, initialKind, onChanged }: {
  profile: ProfileSummary;
  isAdmin: boolean;
  initialKind?: Kind;
  onChanged: () => void;
}) {
  const [kind, setKind] = useState<Kind>(initialKind ?? "入门");
  const [product, setProduct] = useState<string>("");
  const [form, setForm] = useState<Omit<AssessmentForm, "lines"> | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [values, setValues] = useState<FormValues>({});
  const [date, setDate] = useState(todayIso());
  const [list, setList] = useState<AssessmentListItem[]>([]);
  const [version, setVersion] = useState<number | undefined>(undefined);
  const [result, setResult] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [rawJson, setRawJson] = useState("");

  useEffect(() => { if (initialKind) setKind(initialKind); }, [initialKind]);

  const load = async () => {
    setFormError(null);
    setForm(null);
    try {
      const q = `kind=${encodeURIComponent(kind)}${product ? `&product=${encodeURIComponent(product)}` : ""}`;
      const [f, l, d] = await Promise.all([
        apiRequest<AssessmentFormResponse>(`/api/profiles/${profile.id}/assessments/form?${q}`).catch((e) => { setFormError(formatApiError(e)); return null; }),
        apiRequest<{ assessments: AssessmentListItem[] }>(`/api/profiles/${profile.id}/assessments`),
        apiRequest<{ version: number }>(`/api/profiles/${profile.id}`),
      ]);
      if (f) setForm(f.form);
      setList(l.assessments ?? []);
      setVersion(d.version);
    } catch (e) {
      setError(formatApiError(e));
    }
  };

  useEffect(() => {
    setValues({});
    setResult(null);
    void load();
  }, [profile.id, kind, product]);

  const missing = form ? missingFields({ ...form, lines: [] }, values) : [];
  const switching = kind === "触发" && Array.isArray(values.reasons) && (values.reasons as string[]).some((r) => r === "跨段" || r === "换场地");

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const record = advanced ? JSON.parse(rawJson) : buildAssessmentRecord({ ...form!, lines: [] }, values, date, { switched: !!product });
      const res = await apiRequest<{ assessment: { conclusion: Record<string, any> } }>(`/api/profiles/${profile.id}/assessments`, {
        method: "POST",
        body: { expectedVersion: version, record },
      });
      setResult(conclusionLines(res.assessment?.conclusion));
      setValues({});
      onChanged();
      await load();
    } catch (e) {
      setError(e instanceof SyntaxError ? "高级填写里的内容不是合法的记录" : formatApiError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="stack" style={{ gap: "18px" }}>
      <div class="page-head">
        <div>
          <div class="crumb">评估与复盘 · {profile.code} · {product || form?.product || profile.product}</div>
          <h1>{kind}评估</h1>
        </div>
        <div class="pills" role="tablist" aria-label="评估种类" style={{ background: "var(--surface-2)", padding: "4px", borderRadius: "14px" }}>
          {KINDS.map((k) => (
            <button key={k} type="button" role="tab" aria-selected={k === kind} class="pill" aria-pressed={k === kind}
              style={{ minHeight: "40px", border: 0 }} onClick={() => { setKind(k); setProduct(""); }}>{k}</button>
          ))}
        </div>
      </div>

      {error && <div class="banner danger" role="alert" style={{ whiteSpace: "pre-wrap" }}>{error}</div>}
      {formError && <div class="notice plain">{formError}</div>}

      {form && (
        <div class="two-col">
          <div class="main">
            {form.summary.length > 0 && (
              <section class="section">
                <h2>{kind === "周期末" ? "这个周期" : "这一段"}的汇总</h2>
                <div class="stack" style={{ gap: "4px", fontSize: "15px" }}>
                  {form.summary.map((l, i) => <div key={i}>{l.trim()}</div>)}
                </div>
              </section>
            )}
            <section class="section">
              <h2>评估日期</h2>
              <label class="field2" for="as-date" style={{ maxWidth: "240px" }}>
                哪天做的
                <input id="as-date" type="date" value={date} onInput={(e) => setDate((e.target as HTMLInputElement).value)} />
              </label>
              {switching && form.switchProducts.length > 0 && (
                <label class="field2" for="as-prod" style={{ maxWidth: "360px" }}>
                  换成哪份成品<span class="hint">跨段、换场地：选了以后列出新成品要问、要测的项</span>
                  <select id="as-prod" value={product} onChange={(e) => setProduct((e.target as HTMLSelectElement).value)}>
                    <option value="">请选择</option>
                    {form.switchProducts.map((p) => <option key={p} value={p}>{p}</option>)}
                  </select>
                </label>
              )}
            </section>
            {!advanced && (
              <FormRenderer sections={form.sections} values={values} onChange={(k, v) => setValues((cur) => ({ ...cur, [k]: v }))} />
            )}
            {isAdmin && (
              <details class="section" style={{ gap: "10px" }} onToggle={(e) => setAdvanced((e.target as HTMLDetailsElement).open)}>
                <summary class="h3" style={{ cursor: "pointer" }}>高级：直接填完整的评估记录（管理员）</summary>
                <label class="field2" for="as-raw">评估记录<span class="hint">结论照样由服务端重算</span>
                  <textarea id="as-raw" value={rawJson} onInput={(e) => setRawJson((e.target as HTMLTextAreaElement).value)} />
                </label>
              </details>
            )}
          </div>

          <aside class="side">
            <section class="section">
              <h2>还要填</h2>
              <div class="num" style={{ fontSize: "40px", fontWeight: 700, lineHeight: 1 }}>{advanced ? "—" : missing.length}</div>
              <div class="muted">项（只算现在要问的）</div>
              {!advanced && missing.length > 0 && (
                <ul style={{ margin: 0, paddingLeft: "18px", fontSize: "13px", color: "var(--ink-2)" }}>
                  {missing.slice(0, 6).map((f) => <li key={f.key}>{f.label}</li>)}
                </ul>
              )}
              <button class="btn primary big" disabled={busy || !date || (!advanced && missing.length > 0)} onClick={() => void submit()}>
                {busy ? "正在提交…" : "提交，由服务端重算结论"}
              </button>
            </section>
            {result && (
              <section class="section" aria-live="polite">
                <h2>结论</h2>
                <ul style={{ margin: 0, paddingLeft: "18px", display: "flex", flexDirection: "column", gap: "6px" }}>
                  {result.map((l, i) => <li key={i}>{l}</li>)}
                </ul>
              </section>
            )}
            {list.length > 0 && (
              <section class="section">
                <h2>做过的评估</h2>
                {list.slice(0, 8).map((a) => (
                  <div key={String(a.id)} class="notice plain">
                    <strong style={{ color: "var(--ink)" }}>{String(a.date)} · {String(a.kind)}</strong>
                    <div>{a.conclusionText.join("；")}</div>
                  </div>
                ))}
              </section>
            )}
          </aside>
        </div>
      )}
    </div>
  );
}
