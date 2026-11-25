// 周复盘与个人进度（设计稿"网页 · 周复盘与个人进度"）：要填什么、下一周能怎么走由核心 reviewForm 给；
// 训练次数、不适从这一周的练习记录带入，有不适锁定、不能推周；下一周由服务端排。
// 个人进度照核心 progressForm 选动作、规则、依据，写入后服务端重放核对，不合规则的拒。
import { buildReviewRecord, type NextChoice, type ProgressForm, type ReviewForm } from "@yangxia/course-core";
import { useEffect, useState } from "preact/hooks";
import { FormRenderer, type FormValues } from "../components/FormRenderer.tsx";
import { Pills } from "../components/Pills.tsx";
import { apiRequest, formatApiError } from "../lib/api.ts";
import { DECLARATION_TEXT, type ProfileSummary, type ProgressFormResponse, type ReviewFormResponse } from "../types.ts";

function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const FIELD_NAME: Record<string, string> = { level: "难度级", reps: "次数", weight: "重量（公斤）" };

export function ReviewPanel({ profile, onChanged, onGoAssess }: {
  profile: ProfileSummary;
  onChanged: () => void;
  onGoAssess: (kind: "段末" | "周期末") => void;
}) {
  const [form, setForm] = useState<ReviewForm | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [values, setValues] = useState<FormValues>({});
  const [selfSymptoms, setSelfSymptoms] = useState<"" | "有" | "没有">("");
  const [md, setMd] = useState(`${DECLARATION_TEXT}\n\n`);
  const [next, setNext] = useState<NextChoice | "">("");
  const [version, setVersion] = useState<number | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // 个人进度
  const [pf, setPf] = useState<ProgressForm | null>(null);
  const [move, setMove] = useState("");
  const [rule, setRule] = useState("");
  const [field, setField] = useState<"level" | "reps" | "weight" | "">("");
  const [to, setTo] = useState("");
  const [evidence, setEvidence] = useState("");
  const [pDate, setPDate] = useState(todayIso());
  const [pError, setPError] = useState<string | null>(null);
  const [pNotice, setPNotice] = useState<string | null>(null);

  const symptoms = !!form?.symptomsLocked || selfSymptoms === "有";

  const loadForm = async (sym: boolean) => {
    try {
      const r = await apiRequest<ReviewFormResponse>(`/api/profiles/${profile.id}/reviews/form`, { method: "POST", body: { symptoms: sym } });
      setForm(r.form);
      setFormError(null);
    } catch (e) {
      setForm(null);
      setFormError(formatApiError(e));
    }
  };
  const loadProgress = async () => {
    try {
      const r = await apiRequest<ProgressFormResponse>(`/api/profiles/${profile.id}/progress/form`);
      setPf(r.form);
      setVersion(r.version);
    } catch {
      setPf(null);
    }
  };

  useEffect(() => {
    setValues({});
    setSelfSymptoms("");
    setNext("");
    setMd(`${DECLARATION_TEXT}\n\n`);
    void loadForm(false);
    void loadProgress();
  }, [profile.id]);

  // 自己勾了有没有不适：下一周能怎么走跟着变
  useEffect(() => {
    if (!form || form.symptomsLocked) return;
    void loadForm(selfSymptoms === "有");
    if (selfSymptoms === "有" && next === "advance") setNext("");
  }, [selfSymptoms]);

  const trainings = typeof values.trainings === "number" ? values.trainings : form?.minTrainings;
  const missing = (form?.sections ?? []).flatMap((s) => s.fields)
    .filter((f) => f.required && !f.readonly && f.key !== "trainings" && f.key !== "symptoms" && (values[f.key] === undefined || values[f.key] === ""));
  const ready = !!form && !!next && (form.symptomsLocked || selfSymptoms !== "") && missing.length === 0 && typeof trainings === "number" && trainings >= form.minTrainings;

  const save = async () => {
    if (!form || !next) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const reviewJson = buildReviewRecord(form, { ...values, trainings, symptoms });
      const d = await apiRequest<{ version: number }>(`/api/profiles/${profile.id}`);
      await apiRequest(`/api/profiles/${profile.id}/reviews`, {
        method: "POST",
        body: { expectedVersion: d.version, startDate: form.start, week: form.week, reviewJson, reviewMd: md, next },
      });
      setNotice(next === "advance" ? `已保存第 ${form.week} 周复盘，推到第 ${form.week + 1} 周。到"排课中心"发布这一周的课程。`
        : next === "repeat" ? `已保存第 ${form.week} 周复盘，第 ${form.week} 周重来一次。到"排课中心"重新发布课程。`
        : `已保存第 ${form.week} 周复盘。接着做${form.phase === "稳定" ? "周期末" : "段末"}评估。`);
      onChanged();
      if (next === "end") onGoAssess(form.phase === "稳定" ? "周期末" : "段末");
      setValues({});
      setSelfSymptoms("");
      setNext("");
      await loadForm(false);
      await loadProgress();
    } catch (e) {
      setError(formatApiError(e));
    } finally {
      setBusy(false);
    }
  };

  const curMove = pf?.moves.find((m) => m.move === move);
  const curRule = pf?.rules.find((r) => r.rule === rule);
  const ruleFields = curRule && curMove ? curRule.fields.filter((f) => curMove.fields.includes(f)) : [];
  const evOptions = !curRule?.evidence ? [] : curRule.evidence === "session" ? pf!.evidence.sessions
    : curRule.evidence === "review" ? pf!.evidence.reviews : curRule.evidence === "assessment" ? pf!.evidence.assessments
    : [...pf!.evidence.sessions, ...pf!.evidence.reviews];
  const useField = ruleFields.length === 1 ? ruleFields[0] : field;

  const writeProgress = async () => {
    if (!curMove || !curRule || !useField || !to) return;
    setPError(null);
    setPNotice(null);
    try {
      await apiRequest(`/api/profiles/${profile.id}/progress-log`, {
        method: "POST",
        body: { expectedVersion: version, entries: [{ date: pDate, move: curMove.move, field: useField, to: Number(to), rule: curRule.rule, ...(evidence ? { evidence } : {}) }] },
      });
      setPNotice(`已照"${curRule.rule}"改了「${curMove.name}」的${FIELD_NAME[useField]}`);
      setRule("");
      setTo("");
      setEvidence("");
      onChanged();
      await loadProgress();
    } catch (e) {
      setPError(formatApiError(e));
    }
  };

  if (formError && !form) return <div class="notice plain">{formError}</div>;
  if (!form) return <div class="muted">正在按规则算这一周要填什么…</div>;
  const hurt = form.sessions.filter((s) => s.symptoms.length);

  return (
    <div class="stack" style={{ gap: "18px" }}>
      <div class="page-head">
        <div>
          <div class="crumb">评估与复盘 · {profile.code} · {form.product}</div>
          <h1>第 {form.segment} 段第 {form.week} 周复盘</h1>
          <div class="muted num">{form.start} — {form.end}</div>
        </div>
      </div>

      {error && <div class="banner danger" role="alert" style={{ whiteSpace: "pre-wrap" }}>{error}</div>}
      {notice && <div class="banner ok">{notice}</div>}
      {form.symptomsLocked && (
        <div class="notice danger" role="alert">
          {hurt.map((s) => `${s.date.slice(5)} 的练习记录写了${s.symptoms.join("、")}`).join("；")}：这一周按"有不适"复盘，不能推到下一周，个人进度只能往下调。
          照成品"疼了怎么办"处理；胸痛胸闷、头晕站不稳要去看医生。
        </div>
      )}

      <div class="two-col">
        <div class="main">
          <section class="section">
            <h2>这一周的练习记录 <span class="muted">手机回传 {form.sessions.length} 条</span></h2>
            {form.sessions.length === 0 && <div class="notice plain">这一周手机没有传回练习记录。没带手机练的，下面照实填次数。</div>}
            {form.sessions.map((s, i) => (
              <div key={i} class={`rec ${s.symptoms.length ? "hurt" : ""}`}>
                <div class="row-between">
                  <strong>{s.date.slice(5)} · {s.course}</strong>
                  <span class="row">
                    {s.symptoms.length ? s.symptoms.map((x) => <span key={x} class="tag danger">{x}</span>) : <span class="tag ok">无不适</span>}
                    {s.feeling && <span class="tag">整体：{s.feeling}</span>}
                    {s.half && <span class="tag warn">半量课</span>}
                    {s.edited && <span class="tag warn">手改过的课</span>}
                  </span>
                </div>
                <div class="items">
                  {s.items.map((it) => (
                    <span key={it.exercise}>{it.name} {it.setsDone}/{it.setsPlanned} 组{it.feel ? ` · ${it.feel}` : ""}{it.spare !== undefined ? ` · 还能做 ${it.spare} 下` : ""}{it.reverted ? " · 当场退回" : ""}</span>
                  ))}
                </div>
              </div>
            ))}
          </section>

          <section class="section">
            <h2>这一周</h2>
            <div class="row" style={{ gap: "24px", alignItems: "flex-end" }}>
              <label class="field2" for="rv-tr" style={{ width: "220px" }}>
                这一周练了几次
                <input id="rv-tr" type="number" min={form.minTrainings} max={14} value={trainings ?? ""}
                  onInput={(e) => { const v = (e.target as HTMLInputElement).value; setValues((c) => ({ ...c, trainings: v === "" ? undefined : Number(v) })); }} />
                <span class="hint">不能少于记录数 {form.minTrainings}；没带手机练的照实加上</span>
              </label>
              <div class="field2">
                有没有疼痛、头晕、胸闷
                {form.symptomsLocked ? (
                  <span class="row"><span class="tag danger" style={{ fontSize: "15px", padding: "8px 14px" }}>有 · 记录里写了，不能取消</span></span>
                ) : (
                  <Pills label="有没有疼痛、头晕、胸闷" value={selfSymptoms} tone={{ 有: "danger" }}
                    options={[{ value: "没有", label: "没有" }, { value: "有", label: "有" }]} onChange={(v) => setSelfSymptoms(v as "有" | "没有")} />
                )}
              </div>
            </div>
          </section>

          <FormRenderer sections={form.sections} values={values} skip={["week"]} onChange={(k, v) => setValues((cur) => ({ ...cur, [k]: v }))} />

          <section class="section">
            <h2>复盘正文</h2>
            <label class="field2" for="rv-md">写给自己看的几句：这一周怎么样、下周注意什么
              <textarea id="rv-md" rows={4} value={md} onInput={(e) => setMd((e.target as HTMLTextAreaElement).value)} />
            </label>
          </section>

          <section class="section">
            <h2>下一周怎么走 <span class="muted">由服务端照规则排</span></h2>
            <div class="next-opts" role="group" aria-label="下一周怎么走">
              {form.next.map((o) => (
                <button key={o.value} type="button" class="next-opt" aria-pressed={next === o.value} disabled={!o.allowed || (o.value === "advance" && symptoms)}
                  onClick={() => setNext(o.value)}>
                  <span class="t">{o.label}</span>
                  <span class="s">{!o.allowed || (o.value === "advance" && symptoms) ? o.reason ?? "这一周有不适：不能往上走" : o.value === "repeat" ? "照这一周的量再练一周" : o.value === "advance" ? "这一周没有不适" : "复盘存好以后接着做"}</span>
                </button>
              ))}
            </div>
            <div class="row">
              <button class="btn primary big" disabled={busy || !ready} onClick={() => void save()}>{busy ? "正在保存…" : "保存复盘"}</button>
              {!ready && <span class="muted">{!next ? "选下一周怎么走" : !form.symptomsLocked && !selfSymptoms ? "答有没有不适" : missing.length ? `还有 ${missing.length} 项没填：${missing.slice(0, 3).map((f) => f.label).join("、")}` : ""}</span>}
            </div>
          </section>

          {pf && pf.moves.length > 0 && (
            <section class="section">
              <h2>个人进度</h2>
              <div class="sub">照成品规则改难度级、次数、重量；写进去以后服务端重放核对，不合规则的会被拒并说明原因</div>
              {pError && <div class="banner danger" role="alert" style={{ whiteSpace: "pre-wrap" }}>{pError}</div>}
              {pNotice && <div class="banner ok">{pNotice}</div>}
              <div style={{ overflowX: "auto" }}>
                <table class="tbl" style={{ fontSize: "15px" }}>
                  <thead><tr><th>动作</th><th>现在</th><th><span class="sr-only">操作</span></th></tr></thead>
                  <tbody>
                    {pf.moves.map((m) => (
                      <tr key={m.move}>
                        <td><strong>{m.name}</strong></td>
                        <td>{m.fields.map((f) => {
                          const v = m.current[f];
                          if (v === undefined) return `${FIELD_NAME[f]}还没记`;
                          return f === "level" ? `第 ${v} 级${m.levels.find((l) => l.level === v) ? ` · ${m.levels.find((l) => l.level === v)!.name}` : ""}` : `${FIELD_NAME[f]} ${v}`;
                        }).join("；")}</td>
                        <td style={{ textAlign: "right" }}>
                          <button type="button" class="pill" aria-pressed={move === m.move} onClick={() => { setMove(m.move); setRule(""); setTo(""); setEvidence(""); setField(""); }}>改</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {curMove && (
                <div class="notice plain stack" style={{ gap: "12px" }}>
                  <strong style={{ color: "var(--ink)", fontSize: "16px" }}>改「{curMove.name}」</strong>
                  <div class="pills" role="group" aria-label="照哪条规则改">
                    {pf.rules.filter((r) => r.fields.some((f) => curMove.fields.includes(f))).map((r) => (
                      <button key={r.rule} type="button" class="pill" aria-pressed={rule === r.rule} disabled={symptoms && r.up && r.rule !== "找级"}
                        onClick={() => { setRule(r.rule); setEvidence(""); }}>{r.rule}</button>
                    ))}
                  </div>
                  {symptoms && <div class="muted">这一周有不适：只能往下调（减量、退回、找级降一级）</div>}
                  {curRule && <div style={{ color: "var(--ink)" }}>{curRule.when}</div>}
                  {curRule && (
                    <div class="row" style={{ gap: "16px", alignItems: "flex-end" }}>
                      {ruleFields.length > 1 && (
                        <div class="field2">改哪一项
                          <Pills label="改哪一项" value={field} options={ruleFields.map((f) => ({ value: f, label: FIELD_NAME[f] }))} onChange={(v) => setField(v as "level" | "reps" | "weight")} />
                        </div>
                      )}
                      {useField === "level" ? (
                        <label class="field2" for="pg-to" style={{ width: "260px" }}>改成
                          <select id="pg-to" value={to} onChange={(e) => setTo((e.target as HTMLSelectElement).value)}>
                            <option value="">请选择</option>
                            {curMove.levels.map((l) => <option key={l.level} value={String(l.level)}>第 {l.level} 级 · {l.name}</option>)}
                          </select>
                        </label>
                      ) : useField ? (
                        <label class="field2" for="pg-to" style={{ width: "200px" }}>改成（{FIELD_NAME[useField]}）
                          <input id="pg-to" type="number" min={0} step={useField === "weight" ? 0.5 : 1} value={to} onInput={(e) => setTo((e.target as HTMLInputElement).value)} />
                        </label>
                      ) : null}
                      <label class="field2" for="pg-date" style={{ width: "180px" }}>哪天改的
                        <input id="pg-date" type="date" value={pDate} onInput={(e) => setPDate((e.target as HTMLInputElement).value)} />
                      </label>
                      {evOptions.length > 0 && (
                        <label class="field2" for="pg-ev" style={{ flex: "1 1 260px" }}>依据
                          <select id="pg-ev" value={evidence} onChange={(e) => setEvidence((e.target as HTMLSelectElement).value)}>
                            <option value="">请选择</option>
                            {evOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                          </select>
                        </label>
                      )}
                      {curRule.evidence && evOptions.length === 0 && <span class="muted">还没有能当依据的记录</span>}
                      <button type="button" class="btn primary" disabled={!useField || !to || !pDate || (!!curRule.evidence && !evidence)} onClick={() => void writeProgress()}>照规则核对后写入</button>
                    </div>
                  )}
                </div>
              )}
            </section>
          )}
        </div>

        <aside class="side">
          <section class="section">
            <h2>这一周</h2>
            <div class="muted" style={{ fontSize: "14px" }}>
              {form.phase === "稳定" ? "稳定期" : "起始期"}第 {form.segment} 段 · {form.type}段 · 第 {form.week} 周
            </div>
            <div class="muted" style={{ fontSize: "14px" }}>保存以后到"排课中心"发布下一周的课程</div>
          </section>
        </aside>
      </div>
    </div>
  );
}

