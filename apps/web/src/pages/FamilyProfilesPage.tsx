import { useEffect, useState } from "preact/hooks";
import { Pills } from "../components/Pills.tsx";
import { apiRequest, formatApiError } from "../lib/api.ts";
import { qrSvgPath } from "../lib/qr.ts";
import type { AuthMe, ProfileSummary } from "../types.ts";
import { OnboardWizard } from "./OnboardWizard.tsx";

function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** 家里还有谁（全家餐饮模板按人数换算用）：年龄段的说法。 */
const HOUSEHOLD: [string, string][] = [["a06", "6–12 岁"], ["a13", "13–17 岁"], ["a18", "18–39 岁"], ["a40", "40–64 岁"], ["a65", "65 岁以上"]];

/** 操作留痕的代号换成说法（不认识的照原样）。 */
const ACTIONS: Record<string, string> = {
  "setup.init": "初始化管理员",
  "profile.create": "建档",
  create_profile: "建档（助手）",
  "profile.update": "改档案设置",
  "profile.playback_update": "改播放偏好",
  "assessment.submit": "交评估",
  submit_assessment: "交评估（助手）",
  "review.submit": "交周复盘",
  "review.submit_and_advance": "交周复盘并推到下一周",
  submit_weekly_review: "交周复盘（助手）",
  "plan_sheet.generate": "生成计划单",
  "course.publish": "发布课程",
  "course.invalidate": "作废课程",
  "courses.invalidated_by_template_reload": "模板更新后作废旧课",
  "session.submit": "手机回传练习记录",
  "session.replace": "手机改了练习记录",
  "segment.archive": "归档一段",
  archive_segment: "归档一段（助手）",
  "pairing_code.create": "生成扫码绑定码",
  "auth.pair_redeem": "手机扫码绑定",
  "auth.device_revoke": "下线设备",
  update_conditions_and_choices: "改训练条件和器材（助手）",
  update_schedule_and_segment: "改排期（助手）",
  update_screening_and_doctor: "改筛查和医生同意（助手）",
  publish_course_senior_no_fall: "发布课程（确认没有摔倒）",
};

const KIND_NAME: Record<string, string> = { web: "网页", mobile_bound: "绑定的手机", mobile: "手机" };

export function FamilyProfilesPage({
  me,
  profiles,
  selectedProfile,
  onSelectProfile,
  onRefreshProfiles,
}: {
  me: AuthMe;
  profiles: ProfileSummary[];
  selectedProfile: ProfileSummary | null;
  onSelectProfile: (id: string) => void;
  onRefreshProfiles: () => void;
}) {
  const [devices, setDevices] = useState<any[]>([]);
  const [auditData, setAuditData] = useState<{ issues: any[]; auditLogs: any[] } | null>(null);
  const [profileDetail, setProfileDetail] = useState<any>(null);
  const [users, setUsers] = useState<any[]>([]);

  const [showCreate, setShowCreate] = useState(profiles.length === 0);
  const [pairModal, setPairModal] = useState<{ code: string; profileCode: string; expiresAt: string; payload: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // 当前档案能改的设置
  const [editHousehold, setEditHousehold] = useState<string[]>([]);
  const [editBody, setEditBody] = useState<"记" | "不记" | "停记">("不记");
  const [editWake, setEditWake] = useState("");
  const [editBedtime, setEditBedtime] = useState("");
  const [editDoctor, setEditDoctor] = useState<"" | "是" | "否">("");
  const [editDoctorDate, setEditDoctorDate] = useState("");

  const loadCommon = async () => {
    try {
      const devRes = await apiRequest<{ devices: any[] }>("/api/auth/devices");
      setDevices(devRes.devices ?? []);
      if (me.user.role === "admin") {
        const uRes = await apiRequest<{ users: any[] }>("/api/admin/users");
        setUsers(uRes.users ?? []);
      }
    } catch (err) {
      setError(formatApiError(err));
    }
  };

  const loadSelected = async () => {
    if (!selectedProfile || !selectedProfile.canManage) {
      setProfileDetail(null);
      setAuditData(null);
      return;
    }
    try {
      const [det, aud] = await Promise.all([
        apiRequest<any>(`/api/profiles/${selectedProfile.id}`),
        apiRequest<any>(`/api/profiles/${selectedProfile.id}/audit`),
      ]);
      setProfileDetail(det);
      setAuditData(aud);
      setEditHousehold(Array.isArray(det.profile?.household) ? det.profile.household : []);
      setEditBody(det.profile?.body ?? "不记");
      setEditWake(det.profile?.wake ?? "");
      setEditBedtime(det.profile?.bedtime ?? "");
      const sc = det.profile?.screening;
      setEditDoctor(sc?.doctorCleared === true ? "是" : sc ? "否" : "");
      setEditDoctorDate(sc?.doctorDate ?? "");
    } catch (err) {
      setError(formatApiError(err));
    }
  };

  useEffect(() => {
    void loadCommon();
  }, []);

  useEffect(() => {
    void loadSelected();
  }, [selectedProfile?.id]);

  // 改了起床时间就按公式重算上床时间
  useEffect(() => {
    if (!selectedProfile?.stage || !/^\d{2}:\d{2}$/.test(editWake)) return;
    apiRequest<{ bedtime: string }>(`/api/bedtime?stage=${encodeURIComponent(selectedProfile.stage)}&wake=${encodeURIComponent(editWake)}`)
      .then((r) => setEditBedtime(r.bedtime))
      .catch(() => {});
  }, [editWake, selectedProfile?.stage]);

  const handleSaveEdit = async (e: Event) => {
    e.preventDefault();
    if (!selectedProfile || !profileDetail) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const patch: Record<string, any> = {};
      if (editWake) patch.wake = editWake;
      if (editBedtime) patch.bedtime = editBedtime;
      patch.household = editHousehold;
      if (selectedProfile.age === "a18" || selectedProfile.age === "a40") {
        patch.body = editBody;
        if (editBody === "停记" && profileDetail.profile?.body !== "停记") patch.bodyStopDate = todayIso();
      }
      const before = profileDetail.profile?.screening ?? {};
      const cleared = editDoctor === "是";
      if (cleared !== (before.doctorCleared === true) || (cleared && editDoctorDate !== before.doctorDate)) {
        const next: Record<string, any> = { ...before, doctorCleared: cleared };
        if (cleared) next.doctorDate = editDoctorDate;
        else delete next.doctorDate;
        patch.screening = next;
      }
      await apiRequest(`/api/profiles/${selectedProfile.id}`, {
        method: "PATCH",
        body: { expectedVersion: profileDetail.version, patch },
      });
      setNotice("档案设置已保存");
      onRefreshProfiles();
      await loadSelected();
    } catch (err) {
      setError(formatApiError(err));
    } finally {
      setBusy(false);
    }
  };

  const openPairModal = async (pid: string) => {
    setBusy(true);
    setError(null);
    try {
      const res = await apiRequest<{ code: string; profileCode: string; expiresAt: string }>(
        `/api/profiles/${pid}/pairing-code`,
        { method: "POST", body: {} },
      );
      // 安卓扫码端认这个格式（apps/android 的配对解析），不要改字段名
      const payload = JSON.stringify({
        type: "yangxia_pair",
        serverUrl: window.location.origin,
        code: res.code,
        profileCode: res.profileCode,
      });
      setPairModal({ code: res.code, profileCode: res.profileCode, expiresAt: res.expiresAt, payload });
    } catch (err) {
      setError(formatApiError(err));
    } finally {
      setBusy(false);
    }
  };

  const revokeDevice = async (devId: string) => {
    if (!window.confirm("让这台设备下线？下线后它要重新登录或扫码绑定。")) return;
    setBusy(true);
    try {
      await apiRequest(`/api/auth/devices/${devId}`, { method: "DELETE" });
      setNotice("已让这台设备下线");
      await loadCommon();
    } catch (err) {
      setError(formatApiError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="stack" style={{ gap: "18px" }}>
      {!showCreate && (
        <div class="page-head">
          <div>
            <div class="crumb">家里每个人一份档案</div>
            <h1>家庭与档案</h1>
          </div>
          {!me.isTeen && (
            <button class="btn primary" onClick={() => setShowCreate(true)}>新建档案</button>
          )}
        </div>
      )}

      {error && (
        <div class="banner danger" role="alert" style={{ whiteSpace: "pre-wrap" }}>
          {error}
        </div>
      )}
      {notice && <div class="banner ok">{notice}</div>}

      {showCreate && !me.isTeen && (
        <OnboardWizard
          isAdmin={me.user.role === "admin"}
          members={users.filter((u) => u.role === "member")}
          onCancel={profiles.length ? () => setShowCreate(false) : undefined}
          onCreated={(id, code) => {
            setShowCreate(false);
            setNotice(`已建档「${code}」。下一步：到"排课中心"生成这一周的计划单、发布课程。`);
            onRefreshProfiles();
            onSelectProfile(id);
          }}
        />
      )}

      {!showCreate && (
        <>
          <div class="grid-3">
            {profiles.map((p) => (
              <div
                class="card"
                key={p.id}
                style={{
                  borderColor: selectedProfile?.id === p.id ? "var(--accent)" : undefined,
                  boxShadow: selectedProfile?.id === p.id ? "0 0 0 2px var(--accent-soft)" : undefined,
                }}
              >
                <div class="row-between">
                  <strong style={{ fontSize: "17px" }}>{p.code}</strong>
                  <div class="row">
                    {p.isManaged ? <span class="tag info">代管</span> : <span class="tag ok">自己管</span>}
                    {p.hasConflict && <span class="tag danger">有冲突</span>}
                  </div>
                </div>
                <div class="muted">{p.product ?? "还没选成品"}</div>
                <div class="muted">{p.currentSegment ? `第 ${p.currentSegment.n} 段 · 第 ${p.currentSegment.week} 周` : "还没开始"}</div>
                <div class="row">
                  <button class="btn small primary" onClick={() => onSelectProfile(p.id)} disabled={selectedProfile?.id === p.id}>
                    {selectedProfile?.id === p.id ? "正在看这份" : "切到这份"}
                  </button>
                  {p.canManage && p.age !== "a06" && (
                    <button class="btn small" onClick={() => void openPairModal(p.id)} disabled={busy}>
                      手机扫码绑定
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>

          {selectedProfile && selectedProfile.canManage && profileDetail && (
            <div class="two-col">
              <form class="section main" onSubmit={handleSaveEdit}>
                <h2>{selectedProfile.code} 的设置</h2>
                <div class="grid-2">
                  <label class="field2" for="ed-wake">
                    平时几点起床
                    <input id="ed-wake" type="time" value={editWake} onInput={(e) => setEditWake((e.target as HTMLInputElement).value)} />
                  </label>
                  <div class="field2">
                    上床时间<span class="hint">按公式算，改起床时间会跟着变</span>
                    <span class="num" style={{ fontSize: "24px", color: "var(--accent-strong)" }}>{editBedtime || "—"}</span>
                  </div>
                </div>

                {(selectedProfile.age === "a18" || selectedProfile.age === "a40") && (
                  <div class="field2">
                    体重、腰围记不记<span class="hint">出现节食、焦虑就停记：以前记的保留，之后不再记</span>
                    <Pills label="体重、腰围记不记" value={editBody} options={[{ value: "记", label: "记" }, { value: "不记", label: "不记" }, { value: "停记", label: "停记" }]}
                      onChange={(v) => setEditBody(v as "记" | "不记" | "停记")} />
                  </div>
                )}

                <div class="field2">
                  医生同意按这份计划练了吗
                  <Pills label="医生同意了吗" value={editDoctor} options={[{ value: "是", label: "同意了" }, { value: "否", label: "还没有" }]} onChange={(v) => setEditDoctor(v as "是" | "否")} />
                </div>
                {editDoctor === "是" && (
                  <label class="field2" for="ed-dd" style={{ maxWidth: "240px" }}>
                    医生同意的日期
                    <input id="ed-dd" type="date" value={editDoctorDate} max={todayIso()} onInput={(e) => setEditDoctorDate((e.target as HTMLInputElement).value)} />
                  </label>
                )}

                <div class="field2">
                  家里一起吃饭的还有谁<span class="hint">全家菜单按人数换算用，只记年龄段</span>
                  <div class="pills" role="group" aria-label="家里一起吃饭的还有谁">
                    {HOUSEHOLD.map(([a, label]) => (
                      <button key={a} type="button" class="pill" aria-pressed={editHousehold.includes(a)}
                        onClick={() => setEditHousehold((cur) => (cur.includes(a) ? cur.filter((x) => x !== a) : [...cur, a]))}>{label}</button>
                    ))}
                  </div>
                </div>

                <button class="btn primary big" type="submit" disabled={busy || (editDoctor === "是" && !editDoctorDate)} style={{ alignSelf: "flex-start" }}>
                  保存设置
                </button>
              </form>

              <div class="section side">
                <h2>规则核对</h2>
                {auditData?.issues?.length ? (
                  <div class="stack">
                    {auditData.issues.slice(0, 8).map((iss, idx) => (
                      <div class={`notice ${iss.level === "error" ? "danger" : "warn"}`} key={idx}>{iss.message}</div>
                    ))}
                  </div>
                ) : (
                  <div class="notice ok">这份档案和记录照规则核对没有问题。</div>
                )}
                <details>
                  <summary class="h3" style={{ cursor: "pointer" }}>操作留痕（最近 15 条）</summary>
                  <div style={{ maxHeight: "240px", overflowY: "auto", marginTop: "8px" }}>
                    <table class="tbl">
                      <thead>
                        <tr><th>时间</th><th>做了什么</th></tr>
                      </thead>
                      <tbody>
                        {(auditData?.auditLogs ?? []).slice(0, 15).map((l) => (
                          <tr key={l.id}>
                            <td class="num">{String(l.createdAt).replace("T", " ").slice(0, 16)}</td>
                            <td>{ACTIONS[l.action] ?? l.action}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </details>
              </div>
            </div>
          )}

          <div class="section">
            <div class="row-between">
              <h2>登录和绑定的设备（{devices.length}）</h2>
              <button class="btn small" onClick={() => void loadCommon()}>刷新</button>
            </div>
            <div style={{ overflowX: "auto" }}>
              <table class="tbl">
                <thead>
                  <tr><th>设备</th><th>类型</th><th>能看的档案</th><th>最近用过</th><th><span class="sr-only">操作</span></th></tr>
                </thead>
                <tbody>
                  {devices.map((d) => (
                    <tr key={d.id}>
                      <td>{d.deviceName || "没起名的设备"} {d.isCurrent && <span class="tag ok">这台</span>}</td>
                      <td>{KIND_NAME[d.kind] ?? d.kind}</td>
                      <td>{d.boundProfileCode ?? "这个账号能看的全部"}</td>
                      <td class="num">{String(d.lastUsedAt).replace("T", " ").slice(0, 16)}</td>
                      <td>
                        {!d.isCurrent && (
                          <button class="btn small danger" onClick={() => void revokeDevice(d.id)} disabled={busy}>下线</button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      {pairModal && (
        <div class="modal-mask" onClick={() => setPairModal(null)}>
          <div class="modal-box" role="dialog" aria-label={`扫码绑定手机 · ${pairModal.profileCode}`} onClick={(e) => e.stopPropagation()}>
            <div class="row-between">
              <h2 class="h2">扫码绑定手机 · {pairModal.profileCode}</h2>
              <button class="btn small" onClick={() => setPairModal(null)}>关闭</button>
            </div>
            <p class="muted" style={{ margin: 0 }}>
              绑定码只能用一次，5 分钟内有效。绑定后这台手机只能取「{pairModal.profileCode}」的课程、传回练习记录。
            </p>
            <div class="qr-wrap">
              {(() => {
                try {
                  const qr = qrSvgPath(pairModal.payload);
                  return (
                    <svg width="220" height="220" viewBox={`0 0 ${qr.size} ${qr.size}`} role="img" aria-label="手机扫码配对二维码">
                      <rect width={qr.size} height={qr.size} fill="#FFFFFF" />
                      <path d={qr.path} fill="#1D2B24" />
                    </svg>
                  );
                } catch {
                  return <div class="muted">服务地址太长，画不出二维码：在手机上手动输入下面的绑定码。</div>;
                }
              })()}
            </div>
            <label class="field2" for="pair-code">
              或者手动输入绑定码
              <input id="pair-code" type="text" readOnly value={pairModal.code} />
            </label>
          </div>
        </div>
      )}
    </div>
  );
}
