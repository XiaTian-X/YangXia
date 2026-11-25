// 分步建档（设计稿"网页 · 分步建档"）：每走一步把已答的发给服务端，由核心库 intakeForm 照入口问卷、
// 规则层、训练单算下一步要问什么；不预选、不预填；档案由服务端组装（/api/profiles/from-intake）。
import { buildAssessmentRecord, missingFields, uncoveredChoiceGroups, type AssessmentForm, type IntakeAnswers, type IntakeForm } from "@yangxia/course-core";
import { useEffect, useMemo, useState } from "preact/hooks";
import { FormRenderer, type FormValues } from "../components/FormRenderer.tsx";
import { BmiCheck } from "../components/BmiCheck.tsx";
import { Pills } from "../components/Pills.tsx";
import { apiRequest, formatApiError } from "../lib/api.ts";
import type { AssessmentFormResponse, IntakeFormResponse } from "../types.ts";

const STEPS: [string, string][] = [
  ["建档告知", "不是医学建议、记什么"],
  ["学段和场地", "入口问卷 Q1、Q3"],
  ["计划成品", "按场地标推荐"],
  ["安全筛查", "原话逐项问"],
  ["条件和器材", "只问用得到的"],
  ["基本信息", "出生、上床时间"],
  ["入门评估", "测一次起点"],
  ["核对", "创建档案"],
];

const VENUE_NAME: Record<string, string> = { gym: "健身房", home: "居家", bw: "纯徒手", chair: "椅子辅助", play: "户外与游戏" };

function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function OnboardWizard({ isAdmin, members, onCreated, onCancel }: {
  isAdmin: boolean;
  members: { id: string; username: string }[];
  onCreated: (id: string, code: string) => void;
  onCancel?: () => void;
}) {
  const [step, setStep] = useState(0);
  const [code, setCode] = useState("");
  const [ack, setAck] = useState(false);
  const [answers, setAnswers] = useState<IntakeAnswers>({});
  const [form, setForm] = useState<IntakeForm | null>(null);
  const [choices, setChoices] = useState<string[]>([]);
  const [doctorCleared, setDoctorCleared] = useState<"" | "是" | "否">("");
  const [doctorDate, setDoctorDate] = useState("");
  const [birth, setBirth] = useState("");
  const [schoolStage, setSchoolStage] = useState("");
  const [schoolEntry, setSchoolEntry] = useState("");
  const [schoolSystem, setSchoolSystem] = useState<"" | "63" | "54">("");
  const [body, setBody] = useState<"" | "记" | "不记">("");
  const [walkBase, setWalkBase] = useState("");
  const [focus, setFocus] = useState<string[]>([]);
  const [wake, setWake] = useState("");
  const [bedtime, setBedtime] = useState<string | null>(null);
  const [startDate, setStartDate] = useState(todayIso());
  const [timezone, setTimezone] = useState(Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Shanghai");
  const [isManaged, setIsManaged] = useState(false);
  const [memberUserId, setMemberUserId] = useState("");
  const [entryForm, setEntryForm] = useState<Omit<AssessmentForm, "lines"> | null>(null);
  const [entryValues, setEntryValues] = useState<FormValues>({});
  const [entryDate, setEntryDate] = useState("");
  const [entryLater, setEntryLater] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 每次回答变了，照规则重算要问什么（上一次的报错跟着清掉）
  useEffect(() => {
    let alive = true;
    apiRequest<IntakeFormResponse>("/api/intake/form", { method: "POST", body: answers })
      .then((r) => { if (alive) { setForm(r.form); setError(null); } })
      .catch((e) => alive && setError(formatApiError(e)));
    return () => { alive = false; };
  }, [JSON.stringify(answers)]);

  // 换了阶段：跟着阶段走的选择都重来（器材、方向、医生同意、学段、身体数据记不记、散步分钟）；
  // 学段就是第 2 步选的那个，不再问一次
  useEffect(() => {
    setChoices([]);
    setFocus([]);
    setDoctorCleared("");
    setDoctorDate("");
    setBody("");
    setWalkBase("");
    setSchoolEntry("");
    setSchoolSystem("");
    setSchoolStage(answers.stage === "小学" || answers.stage === "初中" || answers.stage === "高中" ? answers.stage : "");
    setEntryValues({});
  }, [answers.stage]);

  useEffect(() => {
    if (!answers.stage || !/^\d{2}:\d{2}$/.test(wake)) { setBedtime(null); return; }
    apiRequest<{ bedtime: string }>(`/api/bedtime?stage=${encodeURIComponent(answers.stage)}&wake=${encodeURIComponent(wake)}`)
      .then((r) => setBedtime(r.bedtime)).catch(() => setBedtime(null));
  }, [answers.stage, wake]);

  // 手机宽度时步骤条横向滚动：把当前这一步滚进视野
  useEffect(() => {
    document.querySelector('.stepper [aria-current="step"]')?.scrollIntoView({ block: "nearest", inline: "center" });
  }, [step]);

  const set = (patch: Partial<IntakeAnswers>) => setAnswers((a) => ({ ...a, ...patch }));
  const direct = !!(answers.direct && form?.direct);
  const uncovered = form ? uncoveredChoiceGroups(form.choiceGroups, choices) : [];
  const options = useMemo(() => (form?.choiceGroups ?? []).flatMap((g) => g.options).filter((o, i, all) => all.findIndex((x) => x.value === o.value) === i), [form]);

  const input = () => ({
    answers,
    code: code.trim(),
    startDate,
    timezone,
    ...(wake ? { wake } : {}),
    ...(form?.basics.birth && birth ? { birth } : {}),
    ...(form?.basics.school && schoolStage && schoolEntry ? { school: { stage: schoolStage, entry: Number(schoolEntry), ...(schoolSystem ? { system: schoolSystem } : {}) } } : {}),
    ...(form?.basics.body && body ? { body } : {}),
    ...(form?.basics.walkBase && walkBase ? { walkBase: Number(walkBase) } : {}),
    ...(choices.length ? { choices } : {}),
    ...(direct && focus.length ? { focus } : {}),
    ...(doctorCleared === "是" ? { doctorCleared: true, ...(doctorDate ? { doctorDate } : {}) } : doctorCleared === "否" ? { doctorCleared: false } : {}),
  });

  // 第 7 步：按草稿档案取入门评估表单
  useEffect(() => {
    if (step !== 6) return;
    setEntryForm(null);
    apiRequest<AssessmentFormResponse>("/api/intake/entry-form", { method: "POST", body: { input: input() } })
      .then((r) => { setEntryForm(r.form); if (!entryDate) setEntryDate(startDate); })
      .catch((e) => setError(formatApiError(e)));
  }, [step]);

  const entryMissing = entryForm ? missingFields({ ...entryForm, lines: [] }, entryValues) : [];
  const needDoctor = !!form?.screeningOutcome?.needDoctor;
  const canNext: boolean[] = [
    code.trim().length > 0 && ack,
    !!form?.age && !form.blocked && (!form.venueAsk || !!answers.venue),
    !!answers.product && form?.products.some((p) => p.name === answers.product) === true,
    !!form?.screeningOutcome && !form.blocked && (!needDoctor || doctorCleared === "否" || (doctorCleared === "是" && !!doctorDate)),
    uncovered.length === 0,
    !!startDate && (!form?.basics.birth || /^\d{4}-\d{2}$/.test(birth)) && (!form?.basics.school || (!!schoolStage && !!schoolEntry))
      && (!form?.basics.body || !!body) && (!form?.basics.walkBase || Number(walkBase) > 0) && (!direct || focus.includes("训练")),
    entryLater ? !direct : !!entryForm && entryMissing.length === 0 && !!entryDate,
    true,
  ];
  const reason = [
    "填代号，勾上\"看过了\"",
    form?.blocked ?? (form?.venueAsk && !answers.venue ? "选能用的场地" : "选阶段"),
    "选一份计划成品",
    form?.blocked ?? (!form?.screeningOutcome ? "逐项答完筛查" : "记下医生同意没有"),
    uncovered.length ? `器材每组至少选一个：${uncovered.map((g) => g.options.map((o) => o.name).join(" / ")).join("；")}` : "",
    direct && !focus.includes("训练") ? "直接进稳定期的方向要含\"训练\"" : "把这一页的必填项填上",
    direct && entryLater ? "直接进稳定期要当场做入门评估" : `入门评估还有 ${entryMissing.length} 项没填`,
    "",
  ];

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const initialAssessment = !entryLater && entryForm ? buildAssessmentRecord({ ...entryForm, lines: [] }, entryValues, entryDate) : undefined;
      const res = await apiRequest<{ id: string }>("/api/profiles/from-intake", {
        method: "POST",
        body: { input: input(), ...(initialAssessment ? { initialAssessment } : {}), isManaged: isAdmin ? isManaged : false, ...(isAdmin && isManaged && memberUserId ? { memberUserId } : {}) },
      });
      onCreated(res.id, code.trim());
    } catch (e) {
      setError(formatApiError(e));
    } finally {
      setBusy(false);
    }
  };

  const product = form?.products.find((p) => p.name === answers.product);
  const summary: [string, string][] = [
    ["代号", code || "—"],
    ["阶段", answers.stage ?? "还没选"],
    ["成品", product ? `${product.name}${direct ? `（直接进 ${form?.direct?.product}）` : ""}` : "还没选"],
    ["安全筛查", !form?.screeningOutcome ? "还没答完" : needDoctor ? (doctorCleared === "是" ? `医生 ${doctorDate} 同意` : "先问医生：同意之前不出计划和课程") : "都是\"否\""],
    ["训练条件", (form?.conditions ?? []).map((c) => `${c.name}：${answers.conditions?.[c.name] === true ? "是" : answers.conditions?.[c.name] === false ? "否" : "没确认（按保守版）"}`).join("；") || "这份成品不用问"],
    ["器材", choices.length ? choices.map((v) => options.find((o) => o.value === v)?.name ?? v).join(" → ") : "这份成品不用选"],
    ["上床时间", bedtime ?? "没填起床时间"],
    ["入门评估", entryLater ? "以后在「评估与复盘」做" : entryForm ? "一起交，结论由服务端重算" : "—"],
  ];

  return (
    <div class="stack" style={{ gap: "16px" }}>
      <div class="page-head">
        <div>
          <div class="crumb">家庭与档案</div>
          <h1>新建档案</h1>
        </div>
        <div class="row">
          <span class="muted">照入口问卷一步一步问 · 不预选、不预填 · 没确认的按保守版</span>
          {onCancel && <button class="btn small" onClick={onCancel}>收起</button>}
        </div>
      </div>
      {error && <div class="banner danger" role="alert" style={{ whiteSpace: "pre-wrap" }}>{error}</div>}

      <div class="wizard">
        <nav class="stepper" aria-label="建档步骤">
          {STEPS.map(([label, hint], i) => (
            <button key={label} type="button" class={`step-btn ${i < step ? "done" : ""}`} aria-current={i === step ? "step" : undefined}
              disabled={i > step && !canNext.slice(0, i).every(Boolean)} onClick={() => setStep(i)}>
              <span class="dot">{i < step ? "✓" : i + 1}</span>
              <span class="lbl">{label}<small>{hint}</small></span>
            </button>
          ))}
        </nav>

        <div class="wizard-body">
          <div class="wizard-card">
            {step === 0 && (
              <>
                <div><div class="eyebrow2">第 1 步</div><h2>建档之前先说清楚</h2></div>
                <div class="grid-2">
                  <div class="notice warn"><strong>不是医学建议</strong><br />计划来自养夏计划模板，未经专业审核，不能替代医生的判断。练的时候疼、头晕、胸闷，马上停下。</div>
                  <div class="notice plain"><strong>记什么、不记什么</strong><br />筛查只记"是 / 否"，不记诊断和用药；出生只记到月；身体数据只给成年人、而且要你选"记"才记。</div>
                  <div class="notice plain"><strong>数据去哪</strong><br />档案只存在这台服务器上。配置了大模型时，和助手对话会把档案摘要发给你配置的模型服务商。</div>
                  <div class="notice plain"><strong>代号</strong><br />课程、练习记录的名字会带代号：别用能认出人的称呼。</div>
                </div>
                <label class="field2" for="wz-code" style={{ maxWidth: "360px" }}>
                  档案代号
                  <input id="wz-code" type="text" maxLength={20} placeholder="如 小夏" value={code} onInput={(e) => setCode((e.target as HTMLInputElement).value)} />
                </label>
                <label class="check"><input type="checkbox" checked={ack} onChange={(e) => setAck((e.target as HTMLInputElement).checked)} />我看过上面四条</label>
              </>
            )}

            {step === 1 && form && (
              <>
                <div><div class="eyebrow2">第 2 步 · 入口问卷</div><h2>使用者处于哪个阶段</h2><div class="muted">未成年人按学段选，不按年龄</div></div>
                <div class="opts" role="group" aria-label="使用者处于哪个阶段">
                  {form.stages.map((s) => (
                    <button key={s.stage} type="button" class="opt" aria-pressed={answers.stage === s.stage} disabled={!s.age}
                      onClick={() => setAnswers({ stage: s.stage })}>
                      <span class="t">{s.stage}</span>
                      <span class="s">{!s.age ? "不覆盖" : s.age === "a65" ? "开始前都要先问医生" : s.age === "a06" ? "家长版" : ""}</span>
                    </button>
                  ))}
                </div>
                {form.venueAsk && (
                  <div class="stack">
                    <div class="h2">{form.venueAsk.question}</div>
                    <div class="opts" role="group" aria-label={form.venueAsk.question}>
                      {form.venueAsk.options.map((o) => (
                        <button key={o.value} type="button" class="opt" aria-pressed={answers.venue === o.value} onClick={() => set({ venue: o.value, product: undefined, direct: false })}>
                          <span class="t">{o.label}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                {form.blocked && <div class="notice danger">{form.blocked}</div>}
                <div class="muted">不在覆盖范围：{form.notCovered.map((n) => `${n.group}（${n.advice}）`).join("；")}</div>
              </>
            )}

            {step === 2 && form && (
              <>
                <div><div class="eyebrow2">第 3 步</div><h2>选计划成品</h2><div class="muted">按入口问卷标了推荐，选哪份由你定；附册不是计划，不在这里</div></div>
                <div class="opts" role="group" aria-label="计划成品">
                  {form.products.map((p) => (
                    <button key={p.name} type="button" class="opt" style={{ minHeight: "112px" }} aria-pressed={answers.product === p.name}
                      onClick={() => { set({ product: p.name, direct: false }); setChoices([]); }}>
                      <span class="row" style={{ justifyContent: "space-between", width: "100%" }}>
                        <span class="t">{p.name}</span>{p.recommended && <span class="badge">推荐</span>}
                      </span>
                      <span class="s">{VENUE_NAME[p.venue] ?? p.venue} · {p.for}</span>
                    </button>
                  ))}
                </div>
                {form.direct && (
                  <div class="notice ok">
                    <label class="check" style={{ fontWeight: 700, fontSize: "16px" }}>
                      <input type="checkbox" checked={!!answers.direct} onChange={(e) => { set({ direct: (e.target as HTMLInputElement).checked }); setChoices([]); }} />
                      有训练基础，直接从稳定期开始
                    </label>
                    <div style={{ marginTop: "6px", color: "var(--ink)" }}>
                      门槛：最近 3 个月平均每周 {form.direct.days} 天以上力量练习，俯卧撑测试做到第 {form.direct.level} 级或更高、做满 {form.direct.reps} 次，方向含"训练"。
                      入门评估当场核对，不够的走起始期。
                    </div>
                  </div>
                )}
              </>
            )}

            {step === 3 && form?.screening && (
              <>
                <div><div class="eyebrow2">第 4 步 · 安全筛查</div><h2>{form.screening.heading}</h2><div class="muted">{form.screening.rule}。原话逐项问，只记是 / 否</div></div>
                <div class="qbox">
                  {form.screening.items.map((item) => (
                    <div class="qrow" key={item}>
                      <span class="q">{item}</span>
                      <Pills label={item} value={answers.screening?.[item] ?? ""} tone={{ 是: "warn" }}
                        options={[{ value: "否", label: "否" }, { value: "是", label: "是" }]}
                        onChange={(v) => set({ screening: { ...(answers.screening ?? {}), [item]: v as "是" | "否" } })} />
                    </div>
                  ))}
                </div>
                {form.blocked ? <div class="notice danger">{form.blocked}：不建档。</div>
                  : !form.screeningOutcome ? <div class="notice plain">还有 {form.screening.items.filter((x) => !answers.screening?.[x]).length} 项没答：逐项答完才有结论。</div>
                  : <div class={`notice ${needDoctor ? "warn" : "ok"}`}>{form.screeningOutcome.message}</div>}
                {needDoctor && form.screeningOutcome && (
                  <div class="stack">
                    <div class="qrow">
                      <span class="q">医生同意按这份计划练了吗</span>
                      <Pills label="医生同意了吗" value={doctorCleared} options={[{ value: "是", label: "同意了" }, { value: "否", label: "还没问" }]} onChange={(v) => setDoctorCleared(v as "是" | "否")} />
                    </div>
                    {doctorCleared === "是" && (
                      <label class="field2" for="wz-dd" style={{ maxWidth: "280px" }}>医生同意的日期<span class="hint">不早于筛查那天（开始日期）</span><input id="wz-dd" type="date" value={doctorDate} onInput={(e) => setDoctorDate((e.target as HTMLInputElement).value)} /></label>
                    )}
                    {doctorCleared === "否" && <div class="muted">可以先建档；医生同意之前不出计划和课程，同意以后在档案设置里记下日期。</div>}
                  </div>
                )}
              </>
            )}

            {step === 4 && form && (
              <>
                <div><div class="eyebrow2">第 5 步</div><h2>训练条件和器材</h2><div class="muted">只问这份成品用得到的；没确认的照规则按保守版导出</div></div>
                {form.conditions.length === 0 && <div class="notice plain">这份成品不用问训练条件。</div>}
                {form.conditions.map((c) => {
                  const v = answers.conditions?.[c.name];
                  return (
                    <div class="qbox" key={c.name} style={{ padding: "14px 16px" }}>
                      <div class="h2" style={{ fontSize: "16px" }}>{c.ask}</div>
                      <Pills label={c.ask} value={v === true ? "是" : v === false ? "否" : "没确认"}
                        options={[{ value: "是", label: "是" }, { value: "否", label: "否" }, { value: "没确认", label: "没确认" }]}
                        onChange={(x) => {
                          const next = { ...(answers.conditions ?? {}) };
                          if (x === "没确认") delete next[c.name]; else next[c.name] = x === "是";
                          set({ conditions: next });
                        }} />
                      {typeof c.bmiAtLeast === "number" && (
                        <BmiCheck line={c.bmiAtLeast} idPrefix={`wz-bmi-${c.name}`} onResult={(yes) => set({ conditions: { ...(answers.conditions ?? {}), [c.name]: yes } })} />
                      )}
                      {/* 规则层的说明只给"没确认的按……导出"那一种（其余是写给维护者的推法） */}
                      <div class="muted" style={{ marginTop: "8px" }}>{c.note.startsWith("没确认") ? c.note : ""}{c.perSession ? "（每次练之前手机上还会再问一次）" : ""}</div>
                    </div>
                  );
                })}
                {form.choiceGroups.length > 0 && (
                  <div class="stack">
                    <div class="h2">能用的器材 <span class="muted">成品写的是"按器材选一个"：勾能用的，先勾的先用</span></div>
                    <div class="row" style={{ gap: "10px" }}>
                      {options.map((o) => {
                        const idx = choices.indexOf(o.value);
                        return (
                          <button key={o.value} type="button" class="opt" style={{ minHeight: "64px", flexDirection: "row", alignItems: "center", gap: "12px" }} aria-pressed={idx >= 0}
                            onClick={() => setChoices((cur) => (idx >= 0 ? cur.filter((x) => x !== o.value) : [...cur, o.value]))}>
                            <span class={idx >= 0 ? "badge" : "tag"}>{idx >= 0 ? `第 ${idx + 1} 选` : "未选"}</span>
                            <span class="stack" style={{ gap: "0" }}><span class="t">{o.name}</span><span class="s">{o.exportable ? "能导出成跟练" : "不能导出成跟练，照成品原文做"}</span></span>
                          </button>
                        );
                      })}
                    </div>
                    {uncovered.map((g) => (
                      <div class="notice warn" key={g.key}>还没选：{g.options.map((o) => o.name).join(" / ")}{g.condition ? `（${g.condition.name}为"${g.condition.value ? "是" : "否"}"时用）` : ""}</div>
                    ))}
                  </div>
                )}
              </>
            )}

            {step === 5 && form && (
              <>
                <div><div class="eyebrow2">第 6 步</div><h2>基本信息</h2></div>
                <div class="grid-2">
                  {form.basics.birth && (
                    <label class="field2" for="wz-birth">出生年月<span class="hint">只记到月：满 40 岁、满 65 岁换版靠它推算</span>
                      <input id="wz-birth" type="month" value={birth} onInput={(e) => setBirth((e.target as HTMLInputElement).value)} />
                    </label>
                  )}
                  {form.basics.school && (
                    <>
                      <div class="field2" id="wz-ss">学段<span class="hint">第 2 步选的；不对就回第 2 步改</span>
                        <strong>{schoolStage || "—"}</strong>
                      </div>
                      <label class="field2" for="wz-se">这个学段的入学年份
                        <input id="wz-se" type="number" min={2000} max={2100} value={schoolEntry} onInput={(e) => setSchoolEntry((e.target as HTMLInputElement).value)} />
                      </label>
                      <div class="field2">学制<span class="hint">升学换版按它推算；不知道的按六三制</span>
                        <Pills label="学制" value={schoolSystem} options={form.basics.school.systems.map((s) => ({ value: s.value, label: s.label }))} onChange={(v) => setSchoolSystem(v as "63" | "54")} />
                      </div>
                    </>
                  )}
                  <label class="field2" for="wz-start">开始日期<input id="wz-start" type="date" value={startDate} onInput={(e) => setStartDate((e.target as HTMLInputElement).value)} /></label>
                  <label class="field2" for="wz-tz">所在时区<span class="hint">练习记录按这个时区算哪一天</span>
                    <input id="wz-tz" type="text" value={timezone} onInput={(e) => setTimezone((e.target as HTMLInputElement).value)} />
                  </label>
                </div>
                {form.basics.body && (
                  <div class="field2">体重、腰围记不记<span class="hint">选"记"的，入门、段末评估时量；出现节食、焦虑就停记</span>
                    <Pills label="体重、腰围记不记" value={body} options={[{ value: "记", label: "记" }, { value: "不记", label: "不记" }]} onChange={(v) => setBody(v as "记" | "不记")} />
                  </div>
                )}
                {form.basics.walkBase && (
                  <label class="field2" for="wz-walk" style={{ maxWidth: "300px" }}>现在每天散步大约几分钟<span class="hint">"散步减 5 分钟"按它算</span>
                    <input id="wz-walk" type="number" min={1} max={300} value={walkBase} onInput={(e) => setWalkBase((e.target as HTMLInputElement).value)} />
                  </label>
                )}
                {form.basics.focus && (
                  <div class="field2">想先从哪方面入手<span class="hint">直接进稳定期的人要含"训练"</span>
                    <div class="pills" role="group" aria-label="想先从哪方面入手">
                      {["作息", "饮食", "训练"].map((a) => (
                        <button key={a} type="button" class="pill" aria-pressed={focus.includes(a)} onClick={() => setFocus((f) => (f.includes(a) ? f.filter((x) => x !== a) : [...f, a]))}>{a}</button>
                      ))}
                    </div>
                  </div>
                )}
                <div class="notice plain row" style={{ gap: "16px", alignItems: "flex-end" }}>
                  <label class="field2" for="wz-wake" style={{ width: "200px" }}>平时几点起床<input id="wz-wake" type="time" value={wake} onInput={(e) => setWake((e.target as HTMLInputElement).value)} /></label>
                  <div class="stack" style={{ gap: "2px" }}>
                    <span class="muted">上床时间 = 起床 − 目标睡眠 − 入睡缓冲（照入口问卷的公式）</span>
                    <span class="num" style={{ fontSize: "28px", fontWeight: 700, color: "var(--accent-strong)" }}>{bedtime ?? "—"}</span>
                  </div>
                </div>
                {isAdmin && (
                  <div class="stack">
                    <label class="check"><input type="checkbox" checked={isManaged} onChange={(e) => setIsManaged((e.target as HTMLInputElement).checked)} />设为家里代管的档案（老人、孩子）</label>
                    {isManaged && (
                      <label class="field2" for="wz-member" style={{ maxWidth: "360px" }}>关联的成员账号
                        <select id="wz-member" value={memberUserId} onChange={(e) => setMemberUserId((e.target as HTMLSelectElement).value)}>
                          <option value="">不关联（只用手机扫码绑定）</option>
                          {members.map((u) => <option key={u.id} value={u.id}>{u.username}</option>)}
                        </select>
                      </label>
                    )}
                  </div>
                )}
              </>
            )}

            {step === 6 && (
              <>
                <div><div class="eyebrow2">第 7 步 · 入门评估</div><h2>测一次起点</h2><div class="muted">只测成品里已有的项；结论由服务端照规则重算</div></div>
                {!direct && (
                  <label class="check"><input type="checkbox" checked={entryLater} onChange={(e) => setEntryLater((e.target as HTMLInputElement).checked)} />以后再做（比如要等医生同意、家人在场）：先建档，到「评估与复盘」做</label>
                )}
                {!entryLater && !entryForm && <div class="muted">正在按这份成品算要测的项…</div>}
                {!entryLater && entryForm && (
                  <>
                    <label class="field2" for="wz-ad" style={{ maxWidth: "240px" }}>评估日期<span class="hint">不晚于开始日期</span>
                      <input id="wz-ad" type="date" value={entryDate} max={startDate} onInput={(e) => setEntryDate((e.target as HTMLInputElement).value)} />
                    </label>
                    {entryForm.sections.every((s) => !s.fields.length) && <div class="notice plain">这份成品的入门评估不用测，只记一下。</div>}
                    <FormRenderer sections={entryForm.sections} values={entryValues} onChange={(k, v) => setEntryValues((cur) => ({ ...cur, [k]: v }))} />
                  </>
                )}
              </>
            )}

            {step === 7 && (
              <>
                <div><div class="eyebrow2">最后一步</div><h2>核对一遍</h2></div>
                <div class="grid-2">
                  {summary.map(([k, v]) => (
                    <div class="notice plain" key={k}><div class="muted">{k}</div><strong style={{ color: "var(--ink)" }}>{v}</strong></div>
                  ))}
                </div>
                <div class="muted">创建以后：到"排课中心"生成这一周的计划单、发布课程，用手机扫码绑定跟练。</div>
              </>
            )}
          </div>

          <div class="wizard-nav">
            <button type="button" class="btn big" disabled={step === 0} onClick={() => setStep((s) => Math.max(0, s - 1))}>上一步</button>
            <div class="row">
              {!canNext[step] && reason[step] && <span class="muted">{reason[step]}</span>}
              {step < 7 ? (
                <button type="button" class="btn primary big" disabled={!canNext[step]} onClick={() => setStep((s) => s + 1)}>下一步</button>
              ) : (
                <button type="button" class="btn primary big" disabled={busy || !canNext.slice(0, 7).every(Boolean)} onClick={() => void create()}>{busy ? "正在创建…" : "创建档案"}</button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
