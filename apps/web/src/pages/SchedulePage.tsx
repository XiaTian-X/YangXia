import { useEffect, useState } from "preact/hooks";
import { MarkdownView } from "../components/MarkdownView.tsx";
import { apiRequest, formatApiError } from "../lib/api.ts";
import type { ProfileSummary, TabId } from "../types.ts";

interface ScheduleData {
  profileId: string;
  code: string;
  age: string;
  version: number;
  hasConflict: boolean;
  conflict: Record<string, any> | null;
  currentSegment: { n: number; week: number; start: string; product: string; phase?: string; type?: string } | null;
  supportedForWorkout: boolean;
  days: string[];
  pickGroupsByDay: Record<string, Record<string, string[]>>;
  activeCourses: {
    id: string;
    courseId: string;
    segment: number;
    week: number;
    day: string;
    half: boolean;
    envelope: {
      course: { name: string };
      follow: string[];
      notes: string[];
      templateVersion: string;
    };
    updatedAt: string;
  }[];
  invalidatedCourses: {
    id: string;
    courseId: string;
    segment: number;
    week: number;
    day: string;
    half: boolean;
    invalidatedReason: string | null;
    updatedAt: string;
  }[];
  recentSessions: {
    id: string;
    course_id: string;
    started_at: string;
    ended_at: string | null;
    has_symptoms: number;
    edited: number;
    stale_course: number;
  }[];
}

export function SchedulePage({
  profile,
  onNavigate,
  onRefreshProfiles,
}: {
  profile: ProfileSummary | null;
  onNavigate: (tab: TabId, docHint?: string) => void;
  onRefreshProfiles: () => void;
}) {
  const [data, setData] = useState<ScheduleData | null>(null);
  const [planDoc, setPlanDoc] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // 排课选项
  const [day, setDay] = useState("");
  const [half, setHalf] = useState(false);
  const [picks, setPicks] = useState<Record<string, string>>({});
  const [confirmedNoFall, setConfirmedNoFall] = useState(false);

  const load = async () => {
    if (!profile) {
      setData(null);
      setPlanDoc(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const [sched, docs] = await Promise.all([
        apiRequest<ScheduleData>(`/api/profiles/${profile.id}/schedule`),
        apiRequest<{ documents: { docType: string; contentMd: string; archivedSegment: number | null }[] }>(
          `/api/profiles/${profile.id}/documents`,
        ),
      ]);
      setData(sched);
      const latestPlan = docs.documents.find((d) => d.docType === "plan" && d.archivedSegment == null);
      setPlanDoc(latestPlan?.contentMd ?? null);
      if (sched.days.length && (!day || !sched.days.includes(day))) {
        setDay(sched.days[0]);
      }
    } catch (err) {
      setError(formatApiError(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    setNotice(null);
    setConfirmedNoFall(false);
    setPicks({});
    void load();
  }, [profile?.id]);

  if (!profile) {
    return (
      <div class="card">
        <h2 class="h2">尚未建立或选择档案</h2>
        <p class="muted">
          请先前往「家庭与档案」使用可视向导建档（无需配置大模型），或打开「养夏助手」引导建档。
        </p>
        <div class="row">
          <button class="btn primary" onClick={() => onNavigate("profiles")}>
            前往可视向导建档
          </button>
          <button class="btn" onClick={() => onNavigate("agent")}>
            使用养夏助手建档
          </button>
        </div>
      </div>
    );
  }

  const handleGeneratePlan = async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await apiRequest<{ contentMd: string; file: string }>(`/api/profiles/${profile.id}/plan-sheet`, {
        method: "POST",
        body: { expectedVersion: data?.version },
      });
      setPlanDoc(res.contentMd);
      setNotice(`已确定性生成本周个人计划单（${res.file}）`);
      onRefreshProfiles();
      await load();
    } catch (err) {
      setError(formatApiError(err));
    } finally {
      setBusy(false);
    }
  };

  const handlePublish = async () => {
    if (!data?.currentSegment || !day) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const cleanPicks = Object.fromEntries(Object.entries(picks).filter(([, v]) => Boolean(v)));
      const res = await apiRequest<{ envelope: { course: { name: string } } }>(
        `/api/profiles/${profile.id}/courses/publish`,
        {
          method: "POST",
          body: {
            expectedVersion: data.version,
            week: data.currentSegment.week,
            day,
            half,
            ...(Object.keys(cleanPicks).length ? { picks: cleanPicks } : {}),
            ...(data.age === "a65" ? { confirmedNoFall } : {}),
          },
        },
      );
      setNotice(`已发布跟练课程「${res.envelope.course.name}」，手机端打开即可拉取跟练`);
      onRefreshProfiles();
      await load();
    } catch (err) {
      setError(formatApiError(err));
    } finally {
      setBusy(false);
    }
  };

  const handleInvalidate = async (courseRecordId: string) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await apiRequest(`/api/profiles/${profile.id}/courses/${courseRecordId}/invalidate`, {
        method: "POST",
        body: { expectedVersion: data?.version, reason: "由排课台手动撤回作废" },
      });
      setNotice("已作废该课程，手机端下次同步将自动锁定移除");
      await load();
    } catch (err) {
      setError(formatApiError(err));
    } finally {
      setBusy(false);
    }
  };

  const rotateGroups = day && data ? data.pickGroupsByDay[day] ?? {} : {};
  const canManage = profile.canManage;

  return (
    <div class="stack" style={{ gap: "18px" }}>
      <div class="row-between">
        <div>
          <div class="eyebrow">排课中心</div>
          <h1 class="h1">
            {profile.code} · {data?.currentSegment ? `第 ${data.currentSegment.n} 段第 ${data.currentSegment.week} 周` : profile.product}
          </h1>
          <div class="row" style={{ marginTop: "6px" }}>
            <span class="tag ok">{profile.product}</span>
            <span class="tag">时区：{profile.timezone}</span>
            {!canManage && <span class="tag info">只读视图</span>}
          </div>
        </div>
        <div class="row">
          <button class="btn" onClick={() => void load()} disabled={loading}>
            {loading ? "刷新中..." : "刷新"}
          </button>
          {canManage && (
            <button class="btn primary" onClick={handleGeneratePlan} disabled={busy}>
              生成 / 更新本周计划单
            </button>
          )}
        </div>
      </div>

      {data?.hasConflict && (
        <div class="banner danger" role="alert">
          <strong>存在未处理的迟到不适或状态冲突，当前已暂停发布新课程</strong>
          <span>
            {data.conflict?.message ?? "手机端同步了带疼痛/头晕/胸闷的练习记录，请先前往「评估与复盘」核对复盘或调整周次与进度。"}
          </span>
          <div class="row">
            <button class="btn small danger" onClick={() => onNavigate("assess")}>
              前往复盘修复冲突
            </button>
            <button class="btn small" onClick={() => onNavigate("profiles")}>
              查看档案审计
            </button>
          </div>
        </div>
      )}

      {error && (
        <div class="banner danger" role="alert" style={{ whiteSpace: "pre-wrap" }}>
          {error}
        </div>
      )}
      {notice && <div class="banner ok">{notice}</div>}

      {data && !data.supportedForWorkout && (
        <div class="banner info">
          <strong>6–12 岁户外与游戏版（家长版）不导出手机跟练课程</strong>
          <span>该年龄段以亲子户外活动与游戏引导为主，请直接阅读家长指导文档。</span>
          <div>
            <button class="btn small primary" onClick={() => onNavigate("docs", profile.product ?? undefined)}>
              打开《{profile.product}》阅读
            </button>
          </div>
        </div>
      )}

      {/* 发布跟练课程卡片 */}
      {data && data.supportedForWorkout && canManage && (
        <div class="card">
          <div class="row-between">
            <div>
              <h2 class="h2">发布跟练课程到手机</h2>
              <div class="muted">严格按模板训练单、档案安全条件与当前进度确定性导出，自带免责声明与动作示意动图哈希。</div>
            </div>
          </div>

          <div class="grid-3">
            <label class="field">
              <span>训练日</span>
              <select value={day} onChange={(e) => { setDay((e.target as HTMLSelectElement).value); setPicks({}); }}>
                {data.days.map((d) => (
                  <option key={d} value={d}>
                    {d} 日
                  </option>
                ))}
              </select>
            </label>

            {Object.entries(rotateGroups).map(([group, moves]) => (
              <label class="field" key={group}>
                <span>轮换动作（{group}）</span>
                <select
                  value={picks[group] ?? ""}
                  onChange={(e) => setPicks({ ...picks, [group]: (e.target as HTMLSelectElement).value })}
                >
                  <option value="">默认按轮换首项</option>
                  {moves.map((mv) => (
                    <option key={mv} value={mv}>
                      {mv}
                    </option>
                  ))}
                </select>
              </label>
            ))}

            <div class="stack" style={{ justifyContent: "center" }}>
              <label class="check">
                <input type="checkbox" checked={half} onChange={(e) => setHalf((e.target as HTMLInputElement).checked)} />
                <span>半量课（中断后回来的第一次：组数减半向上取整，次数、秒数、休息不变）</span>
              </label>
            </div>
          </div>

          {data.age === "a65" && (
            <div class="banner warn">
              <label class="check">
                <input
                  type="checkbox"
                  checked={confirmedNoFall}
                  onChange={(e) => setConfirmedNoFall((e.target as HTMLInputElement).checked)}
                />
                <span>
                  <strong>65 岁以上发课前必确认</strong>：本人或家人确认最近未发生摔倒、差点摔倒或头晕
                </span>
              </label>
            </div>
          )}

          <div class="row">
            <button
              class="btn primary"
              onClick={handlePublish}
              disabled={busy || !day || data.hasConflict || (data.age === "a65" && !confirmedNoFall)}
            >
              {busy ? "发布中..." : `发布第 ${data.currentSegment?.week ?? 1} 周 ${day} 日课程`}
            </button>
          </div>
        </div>
      )}

      {/* 活跃课程 & 计划单 */}
      <div class="grid-2">
        <div class="card">
          <div class="row-between">
            <h2 class="h2">当前可跟练课程（{data?.activeCourses.length ?? 0}）</h2>
          </div>
          {!data?.activeCourses.length ? (
            <p class="muted">暂无已发布活跃课程。先完成入门评估后，即可在上方选择训练日一键发布。</p>
          ) : (
            <div class="stack">
              {data.activeCourses.map((c) => (
                <div class="card-soft" key={c.id}>
                  <div class="row-between">
                    <strong>{c.envelope.course.name}</strong>
                    <div class="row">
                      <span class="tag ok">第 {c.week} 周 · {c.day} 日{c.half ? " · 半量" : ""}</span>
                      {canManage && (
                        <button class="btn small danger" onClick={() => void handleInvalidate(c.id)} disabled={busy}>
                          作废
                        </button>
                      )}
                    </div>
                  </div>
                  {c.envelope.follow.length > 0 && (
                    <div class="muted">
                      <strong>配套有氧/习惯：</strong>
                      {c.envelope.follow
                        .map((item: any) =>
                          typeof item === "string" ? item : [item?.name, item?.reason ?? item?.text].filter(Boolean).join("："),
                        )
                        .filter(Boolean)
                        .join("；")}
                    </div>
                  )}
                  {c.envelope.notes.length > 0 && (
                    <div class="muted">
                      <strong>注意事项：</strong>
                      {c.envelope.notes
                        .map((item: any) =>
                          typeof item === "string" ? item : [item?.name, item?.reason ?? item?.text].filter(Boolean).join("："),
                        )
                        .filter(Boolean)
                        .join("；")}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          {data && data.invalidatedCourses.length > 0 && (
            <div class="stack" style={{ marginTop: "8px" }}>
              <h3 class="h3">已作废旧课（手机同步时强制撤回）</h3>
              {data.invalidatedCourses.map((ic) => (
                <div class="banner warn" key={ic.id}>
                  <span>
                    第 {ic.segment} 段第 {ic.week} 周 {ic.day} 日{ic.half ? "（半量）" : ""} —{" "}
                    {ic.invalidatedReason || "规则已变更"}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div class="card">
          <div class="row-between">
            <h2 class="h2">本周个人计划单</h2>
            {canManage && (
              <button class="btn small" onClick={handleGeneratePlan} disabled={busy}>
                重新生成
              </button>
            )}
          </div>
          {planDoc ? (
            <MarkdownView content={planDoc} />
          ) : (
            <p class="muted">尚未生成本周计划单。完成入门评估后点击「生成 / 更新本周计划单」，系统将自动按规则生成每日安排、有氧要求与习惯达标线。</p>
          )}
        </div>
      </div>

      {/* 近期手机同步练习记录 */}
      <div class="card">
        <h2 class="h2">近期练习记录（{data?.recentSessions.length ?? 0}）</h2>
        {!data?.recentSessions.length ? (
          <p class="muted">暂无练习记录。手机端完成跟练并同步后会自动显示在这里。</p>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table class="tbl">
              <thead>
                <tr>
                  <th>开始时间</th>
                  <th>课程标识</th>
                  <th>状态标记</th>
                </tr>
              </thead>
              <tbody>
                {data.recentSessions.map((s) => (
                  <tr key={s.id}>
                    <td>{s.started_at.replace("T", " ").slice(0, 16)}</td>
                    <td><code>{s.course_id}</code></td>
                    <td class="row">
                      {s.has_symptoms === 1 ? <span class="tag danger">记录了不适</span> : <span class="tag ok">无不适</span>}
                      {s.edited === 1 && <span class="tag warn">手工改动</span>}
                      {s.stale_course === 1 && <span class="tag warn">基于旧版课</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
