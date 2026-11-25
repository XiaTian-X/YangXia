import { ASSESS_FORMAT, REASONS, REVIEW_FORMAT } from "@yangxia/course-core";
import { useEffect, useState } from "preact/hooks";
import { apiRequest, formatApiError } from "../lib/api.ts";
import { DECLARATION_TEXT, type ProfileSummary } from "../types.ts";

function todayIso(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** 练习记录开始时刻在档案时区里是哪一天（YYYY-MM-DD）。 */
function localDate(iso: string, timeZone: string): string {
  try {
    return new Date(iso).toLocaleDateString("sv-SE", { timeZone });
  } catch {
    return iso.slice(0, 10);
  }
}

function addDaysStr(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().slice(0, 10);
}

export function AssessReviewPage({
  profile,
  onRefreshProfiles,
}: {
  profile: ProfileSummary | null;
  onRefreshProfiles: () => void;
}) {
  const [assessments, setAssessments] = useState<any[]>([]);
  const [reviews, setReviews] = useState<any[]>([]);
  const [sessions, setSessions] = useState<any[]>([]);
  const [profileDetail, setProfileDetail] = useState<any>(null);
  const [endSummary, setEndSummary] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // 评估表单状态
  const [assessKind, setAssessKind] = useState<"入门" | "段末" | "周期末" | "触发">("入门");
  const [assessDate, setAssessDate] = useState(todayIso());
  // 测量值一律不预填：没测的不能变成"测过"
  const [baseDays, setBaseDays] = useState("");
  const [pushupLevel, setPushupLevel] = useState("");
  const [pushupReps, setPushupReps] = useState("");
  const [chairReps, setChairReps] = useState("");
  const [chairHands, setChairHands] = useState("");
  const [chairDone, setChairDone] = useState<"" | "是" | "否">("");
  const [chairStop, setChairStop] = useState("");
  const [companion, setCompanion] = useState(false);
  const [heightCm, setHeightCm] = useState("");
  const [weightKg, setWeightKg] = useState("");
  const [waistCm, setWaistCm] = useState("");
  const [triggerReason, setTriggerReason] = useState("");
  const [advancedJson, setAdvancedJson] = useState("");
  const [useAdvancedJson, setUseAdvancedJson] = useState(false);

  // 周复盘表单状态
  const [revStart, setRevStart] = useState(todayIso());
  const [revWeek, setRevWeek] = useState(1);
  // 复盘不预填编出来的数：训练次数、不适从这一周的练习记录带入，习惯和正文由使用者填
  const [revTrainings, setRevTrainings] = useState("");
  const [revSymptoms, setRevSymptoms] = useState(false);
  const [revHabits, setRevHabits] = useState("");
  const [revMd, setRevMd] = useState(`${DECLARATION_TEXT}\n\n`);
  const [advanceNextWeek, setAdvanceNextWeek] = useState(false);

  const load = async () => {
    if (!profile || !profile.canManage) return;
    setError(null);
    try {
      const [pDetail, aRes, rRes] = await Promise.all([
        apiRequest<any>(`/api/profiles/${profile.id}`),
        apiRequest<any>(`/api/profiles/${profile.id}/assessments?kind=${encodeURIComponent(assessKind)}`),
        apiRequest<any>(`/api/profiles/${profile.id}/reviews`),
      ]);
      setProfileDetail(pDetail);
      setAssessments(aRes.assessments ?? []);
      setEndSummary(aRes.endSummary ?? null);
      setReviews(rRes.reviews ?? []);
      setSessions(rRes.sessions ?? []);
      const seg = pDetail.profile?.segments?.[pDetail.profile.segments.length - 1];
      if (seg) {
        setRevStart(seg.start);
        setRevWeek(seg.week);
        const tz = pDetail.timezone || profile.timezone;
        const end = addDaysStr(seg.start, 6);
        const n = ((rRes.sessions ?? []) as any[]).filter((x) => {
          const d = localDate(String(x.startedAt), tz);
          return d >= seg.start && d <= end;
        }).length;
        setRevTrainings(String(n));
        if (aRes.assessments?.length === 0) setAssessDate(seg.start);
      }
    } catch (err) {
      setError(formatApiError(err));
    }
  };

  useEffect(() => {
    void load();
  }, [profile?.id, assessKind]);

  if (!profile) {
    return <div class="card">请先选择或创建档案。</div>;
  }
  if (!profile.canManage) {
    return (
      <div class="card">
        <h2 class="h2">只读权限</h2>
        <p class="muted">当前账号对该档案仅具只读查看权限，评估与周复盘需由家长/管理员或档案本人操作。</p>
      </div>
    );
  }

  const isAdult = profile.age === "a18" || profile.age === "a40";
  const recordBody = isAdult && profileDetail?.profile?.body === "记";
  const segs: any[] = profileDetail?.profile?.segments ?? [];
  const curSegN: number | undefined = segs[segs.length - 1]?.n;
  // 这一周（档案时区）的练习记录：训练次数不能少于它，有不适的记录时"有不适"锁定
  const tzName = profileDetail?.timezone || profile.timezone;
  const weekSessions = sessions.filter((x) => {
    const d = localDate(String(x.startedAt), tzName);
    return d >= revStart && d <= addDaysStr(revStart, 6);
  });
  const weekSymptoms = weekSessions.some((x) => x.hasSymptoms);
  const symptomsChecked = revSymptoms || weekSymptoms;

  const submitAssessment = async (e: Event) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      let record: Record<string, any>;
      if (useAdvancedJson) {
        record = JSON.parse(advancedJson);
      } else {
        record = {
          schema: ASSESS_FORMAT,
          kind: assessKind,
          date: assessDate,
          tests:
            profile.age === "a13" || profile.age === "a06"
              ? []
              : profile.age === "a65"
                ? [
                    {
                      id: "chair-stand-30s",
                      value: Number(chairReps),
                      hands: chairHands,
                      done: chairDone === "是",
                      ...(chairDone === "否" && chairStop ? { stopReason: chairStop } : {}),
                    },
                  ]
                : [{ id: "pushup-test", level: Number(pushupLevel), value: Number(pushupReps) }],
          conclusion: {},
        };
        if (profile.age === "a65") record.companion = companion;
        if ((assessKind === "段末" || assessKind === "周期末") && Number.isInteger(curSegN)) {
          record.segment = curSegN;
        }
        if (assessKind === "入门" && ["a18", "a40", "a13"].includes(profile.age)) {
          record.base = Number(baseDays);
        }
        if (assessKind === "触发") {
          record.reasons = [triggerReason];
        }
        if (recordBody && heightCm && weightKg) {
          record.body = {
            height: Number(heightCm),
            weight: Number(weightKg),
            ...(waistCm ? { waist: Number(waistCm) } : {}),
          };
        }
      }

      const res = await apiRequest<{ assessment: { conclusion: any } }>(`/api/profiles/${profile.id}/assessments`, {
        method: "POST",
        body: { expectedVersion: profileDetail?.version, record },
      });
      setNotice(`已提交「${assessKind}」评估，服务端重算结论：${JSON.stringify(res.assessment.conclusion)}`);
      onRefreshProfiles();
      await load();
    } catch (err) {
      setError(formatApiError(err));
    } finally {
      setBusy(false);
    }
  };

  const submitReview = async (e: Event) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const habitsObj: Record<string, number> = {};
      for (const part of revHabits.split(/[,，]/)) {
        const [k, v] = part.split(/[:：]/).map((s) => s.trim());
        if (k && v && !Number.isNaN(Number(v))) habitsObj[k] = Number(v);
      }
      const curSeg = profileDetail?.profile?.segments?.[profileDetail.profile.segments.length - 1];
      const maxWeek = curSeg?.phase === "稳定" ? 12 : 4;
      const canAdvance = advanceNextWeek && !symptomsChecked && curSeg && revWeek < maxWeek;
      // habitTargets、restart 只写在一段的第一项，推到下一周时不能抄过去
      const { habitTargets: _ht, restart: _rs, ...segBase } = curSeg ?? {};
      const nextSegmentEntry = canAdvance
        ? {
            ...segBase,
            week: revWeek + 1,
            start: addDaysStr(revStart, 7),
          }
        : undefined;

      await apiRequest(`/api/profiles/${profile.id}/reviews`, {
        method: "POST",
        body: {
          expectedVersion: profileDetail?.version,
          startDate: revStart,
          week: Number(revWeek),
          reviewJson: {
            schema: REVIEW_FORMAT,
            start: revStart,
            week: Number(revWeek),
            trainings: Number(revTrainings),
            symptoms: symptomsChecked,
            habits: habitsObj,
            moves: [],
          },
          reviewMd: revMd,
          ...(nextSegmentEntry ? { nextSegmentEntry } : {}),
        },
      });
      setNotice(
        nextSegmentEntry
          ? `已保存第 ${revWeek} 周复盘，并同事务推进至第 ${nextSegmentEntry.week} 周（${nextSegmentEntry.start} 起）`
          : `已保存第 ${revWeek} 周复盘`,
      );
      onRefreshProfiles();
      await load();
    } catch (err) {
      setError(formatApiError(err));
    } finally {
      setBusy(false);
    }
  };

  const handleArchivePrev = async () => {
    const curN = profile.currentSegment?.n ?? 1;
    if (curN <= 1) return;
    setBusy(true);
    setError(null);
    try {
      await apiRequest(`/api/profiles/${profile.id}/archive-segment`, {
        method: "POST",
        body: { expectedVersion: profileDetail?.version, segment: curN - 1 },
      });
      setNotice(`已将第 ${curN - 1} 段历史记录归档`);
      onRefreshProfiles();
      await load();
    } catch (err) {
      setError(formatApiError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="stack" style={{ gap: "18px" }}>
      <div class="row-between">
        <div>
          <div class="eyebrow">无大模型独立闭环</div>
          <h1 class="h1">评估与周复盘 · {profile.code}</h1>
        </div>
        {(profile.currentSegment?.n ?? 1) > 1 && (
          <button class="btn small" onClick={handleArchivePrev} disabled={busy}>
            归档上一已完成段（第 {(profile.currentSegment?.n ?? 2) - 1} 段）
          </button>
        )}
      </div>

      {error && (
        <div class="banner danger" role="alert" style={{ whiteSpace: "pre-wrap" }}>
          {error}
        </div>
      )}
      {notice && <div class="banner ok">{notice}</div>}

      <div class="grid-2">
        {/* 评估提交表单 */}
        <form class="card" onSubmit={submitAssessment}>
          <div class="row-between">
            <h2 class="h2">提交评估（后端权威重算结论）</h2>
            <label class="check" style={{ fontSize: "12px" }}>
              <input type="checkbox" checked={useAdvancedJson} onChange={(e) => setUseAdvancedJson((e.target as HTMLInputElement).checked)} />
              <span>高级 JSON 模式</span>
            </label>
          </div>

          <div class="grid-2">
            <label class="field">
              <span>评估类型</span>
              <select value={assessKind} onChange={(e) => setAssessKind((e.target as HTMLSelectElement).value as any)}>
                <option value="入门">入门评估</option>
                <option value="段末">段末评估</option>
                <option value="周期末">周期末评估</option>
                <option value="触发">触发评估</option>
              </select>
            </label>
            <label class="field">
              <span>评估日期</span>
              <input type="date" value={assessDate} onInput={(e) => setAssessDate((e.target as HTMLInputElement).value)} required />
            </label>
          </div>

          {endSummary && (
            <div class="banner info">
              <strong>后端汇总参考</strong>
              <pre class="code-box">{JSON.stringify(endSummary, null, 2)}</pre>
            </div>
          )}

          {useAdvancedJson ? (
            <label class="field">
              <span>完整评估 JSON（conclusion 将由服务端自动重算覆盖）</span>
              <textarea
                value={advancedJson}
                onInput={(e) => setAdvancedJson((e.target as HTMLTextAreaElement).value)}
                placeholder='{"kind":"入门","date":"2026-11-02","base":0,"tests":[{"id":"pushup-test","level":2,"value":8}]}'
              />
            </label>
          ) : (
            <div class="stack">
              {assessKind === "入门" && ["a18", "a40", "a13"].includes(profile.age) && (
                <label class="field">
                  <span>近 3 个月每周规律力量练习天数（0–7）</span>
                  <input type="number" min={0} max={7} required value={baseDays} onInput={(e) => setBaseDays((e.target as HTMLInputElement).value)} />
                </label>
              )}

              {isAdult && (
                <div class="grid-2">
                  <label class="field">
                    <span>俯卧撑测试做的是第几级（照成品动作库的分级）</span>
                    <input type="number" min={1} required value={pushupLevel} onInput={(e) => setPushupLevel((e.target as HTMLInputElement).value)} />
                  </label>
                  <label class="field">
                    <span>完成次数</span>
                    <input type="number" min={0} max={100} required value={pushupReps} onInput={(e) => setPushupReps((e.target as HTMLInputElement).value)} />
                  </label>
                </div>
              )}

              {profile.age === "a65" && (
                <div class="stack">
                  <label class="check">
                    <input type="checkbox" checked={companion} onChange={(e) => setCompanion((e.target as HTMLInputElement).checked)} />
                    <span>测试时有家人在旁边（医生同意以后、家人在场时才做）</span>
                  </label>
                  <div class="grid-2">
                    <label class="field">
                      <span>30 秒坐站：做了几次</span>
                      <input type="number" min={0} max={60} required value={chairReps} onInput={(e) => setChairReps((e.target as HTMLInputElement).value)} />
                    </label>
                    <label class="field">
                      <span>用手的方式</span>
                      <select required value={chairHands} onChange={(e) => setChairHands((e.target as HTMLSelectElement).value)}>
                        <option value="">请选择</option>
                        <option value="不用手">不用手</option>
                        <option value="扶椅子">扶椅子</option>
                        <option value="手撑">手撑</option>
                      </select>
                    </label>
                    <label class="field">
                      <span>30 秒做完了吗</span>
                      <select required value={chairDone} onChange={(e) => setChairDone((e.target as HTMLSelectElement).value as "" | "是" | "否")}>
                        <option value="">请选择</option>
                        <option value="是">做完了</option>
                        <option value="否">中途停下了</option>
                      </select>
                    </label>
                    {chairDone === "否" && (
                      <label class="field">
                        <span>停下的原因</span>
                        <select required value={chairStop} onChange={(e) => setChairStop((e.target as HTMLSelectElement).value)}>
                          <option value="">请选择</option>
                          <option value="头晕">头晕</option>
                          <option value="腿软">腿软</option>
                          <option value="身体晃">身体晃</option>
                        </select>
                      </label>
                    )}
                  </div>
                </div>
              )}

              {assessKind === "触发" && (
                <label class="field">
                  <span>触发原因</span>
                  <select required value={triggerReason} onChange={(e) => setTriggerReason((e.target as HTMLSelectElement).value)}>
                    <option value="">请选择</option>
                    {REASONS.map((r) => (
                      <option key={r} value={r}>
                        {r}
                      </option>
                    ))}
                  </select>
                </label>
              )}

              {recordBody && (
                <div class="grid-3">
                  <label class="field">
                    <span>身高 (cm)</span>
                    <input type="number" value={heightCm} onInput={(e) => setHeightCm((e.target as HTMLInputElement).value)} />
                  </label>
                  <label class="field">
                    <span>体重 (kg)</span>
                    <input type="number" step="0.1" value={weightKg} onInput={(e) => setWeightKg((e.target as HTMLInputElement).value)} />
                  </label>
                  <label class="field">
                    <span>腰围 (cm，可选)</span>
                    <input type="number" step="0.1" value={waistCm} onInput={(e) => setWaistCm((e.target as HTMLInputElement).value)} />
                  </label>
                </div>
              )}
            </div>
          )}

          <button class="btn primary" type="submit" disabled={busy}>
            {busy ? "校验提交中..." : `提交「${assessKind}」评估`}
          </button>

          {assessments.length > 0 && (
            <div class="stack" style={{ marginTop: "8px" }}>
              <h3 class="h3">已有评估记录（{assessments.length}）</h3>
              {assessments.map((a) => (
                <div class="card-soft" key={a.id}>
                  <div class="row-between">
                    <strong>{a.date} · {a.kind}</strong>
                    <span class="tag">{a.logicalPath}</span>
                  </div>
                  <div class="muted">服务端结论：<code>{JSON.stringify(a.record?.conclusion ?? {})}</code></div>
                </div>
              ))}
            </div>
          )}
        </form>

        {/* 周复盘表单 */}
        <form class="card" onSubmit={submitReview}>
          <h2 class="h2">提交周复盘</h2>
          <div class="grid-3">
            <label class="field">
              <span>本周起始日</span>
              <input type="date" value={revStart} onInput={(e) => setRevStart((e.target as HTMLInputElement).value)} required />
            </label>
            <label class="field">
              <span>周次</span>
              <input type="number" min={1} max={12} value={revWeek} onInput={(e) => setRevWeek(Number((e.target as HTMLInputElement).value))} required />
            </label>
            <label class="field">
              <span>本周完成训练次</span>
              <input
                type="number"
                min={weekSessions.length}
                max={14}
                value={revTrainings}
                onInput={(e) => setRevTrainings((e.target as HTMLInputElement).value)}
                required
              />
            </label>
          </div>
          <p class="muted" style={{ fontSize: "13px" }}>
            这一周（{revStart} 起 7 天）手机回传的练习记录：{weekSessions.length} 条
            {weekSymptoms ? "，其中有记录写了疼痛、头晕或胸闷" : ""}。训练次数不能少于记录数。
          </p>

          <label class="field">
            <span>习惯达标天数（格式：习惯名:天数，逗号分隔；照打卡记录填，记不清的按没做到填）</span>
            <input type="text" value={revHabits} placeholder="如 散步:4, 按时上床:5" onInput={(e) => setRevHabits((e.target as HTMLInputElement).value)} />
          </label>

          <label class="check">
            <input
              type="checkbox"
              checked={symptomsChecked}
              disabled={weekSymptoms}
              onChange={(e) => setRevSymptoms((e.target as HTMLInputElement).checked)}
            />
            <span>
              本周出现过疼痛、头晕或胸闷（勾选后不推进周次，按成品"疼了怎么办"处理）
              {weekSymptoms ? "——练习记录里有，不能取消" : ""}
            </span>
          </label>

          <label class="check">
            <input
              type="checkbox"
              checked={advanceNextWeek && !symptomsChecked}
              disabled={symptomsChecked}
              onChange={(e) => setAdvanceNextWeek((e.target as HTMLInputElement).checked)}
            />
            <span>没有不适、没到段末时，同时推进到下一周（+7 天）</span>
          </label>

          <label class="field">
            <span>复盘正文（必须保留开头免责声明）</span>
            <textarea value={revMd} onInput={(e) => setRevMd((e.target as HTMLTextAreaElement).value)} required />
          </label>

          <button class="btn primary" type="submit" disabled={busy}>
            {busy ? "提交中..." : `提交第 ${revWeek} 周复盘`}
          </button>

          {reviews.length > 0 && (
            <div class="stack" style={{ marginTop: "8px" }}>
              <h3 class="h3">历史周复盘（{reviews.length}）· 同步记录（{sessions.length}）</h3>
              {reviews.map((r) => (
                <div class="card-soft" key={r.id}>
                  <div class="row-between">
                    <strong>第 {r.segment} 段第 {r.week} 周（{r.startDate}）</strong>
                    <span class={r.reviewJson?.symptoms ? "tag danger" : "tag ok"}>
                      {r.reviewJson?.symptoms ? "有不适" : "无不适"} · {r.reviewJson?.trainings ?? 0} 练
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </form>
      </div>
    </div>
  );
}
