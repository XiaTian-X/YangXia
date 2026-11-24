import { PROFILE_FORMAT } from "@yangxia/course-core";
import { useEffect, useState } from "preact/hooks";
import { apiRequest, formatApiError } from "../lib/api.ts";
import { qrSvgPath } from "../lib/qr.ts";
import type { AuthMe, ProfileSummary } from "../types.ts";

function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

interface IntakeResp {
  intake: {
    stages: { label: string; age: string }[];
    screening: { age: string; items: string[] }[];
  };
  products: { name: string; age: string; venue: string; phase?: string }[];
}

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
  const [intake, setIntake] = useState<IntakeResp | null>(null);
  const [devices, setDevices] = useState<any[]>([]);
  const [auditData, setAuditData] = useState<{ issues: any[]; auditLogs: any[] } | null>(null);
  const [profileDetail, setProfileDetail] = useState<any>(null);
  const [users, setUsers] = useState<any[]>([]);

  const [showCreate, setShowCreate] = useState(profiles.length === 0);
  const [pairModal, setPairModal] = useState<{ code: string; profileCode: string; expiresAt: string; payload: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // 新建档案向导表单状态
  const [code, setCode] = useState("");
  const [stage, setStage] = useState("18–39 岁");
  const [age, setAge] = useState("a18");
  const [product, setProduct] = useState("18-39岁-居家版");
  const [birth, setBirth] = useState("1995-05");
  const [schoolStage, setSchoolStage] = useState("初中");
  const [schoolEntry, setSchoolEntry] = useState(2025);
  const [wake, setWake] = useState("07:00");
  const [bedtime, setBedtime] = useState("");
  const [timezone, setTimezone] = useState("Asia/Shanghai");
  const [startDate, setStartDate] = useState(todayIso());
  const [screenAnswers, setScreenAnswers] = useState<Record<string, "是" | "否" | "">>({});
  const [condState, setCondState] = useState<Record<string, "未确认" | "是" | "否">>({});
  const [doctorCleared, setDoctorCleared] = useState(false);
  const [doctorDate, setDoctorDate] = useState(todayIso());
  const [isManaged, setIsManaged] = useState(false);
  const [memberUserId, setMemberUserId] = useState("");
  const [household, setHousehold] = useState<string[]>([]);

  // 受控编辑当前档案字段
  const [editHousehold, setEditHousehold] = useState<string[]>([]);
  const [editBody, setEditBody] = useState<"记" | "不记" | "停记">("不记");
  const [editWake, setEditWake] = useState("");
  const [editBedtime, setEditBedtime] = useState("");
  const [editDoctorCleared, setEditDoctorCleared] = useState(false);

  const loadCommon = async () => {
    try {
      const [inRes, devRes] = await Promise.all([
        apiRequest<IntakeResp>("/api/intake"),
        apiRequest<{ devices: any[] }>("/api/auth/devices"),
      ]);
      setIntake(inRes);
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
      setEditDoctorCleared(Boolean(det.profile?.screening?.doctorCleared));
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

  // 根据所选年龄段过滤起始期成品
  const startProducts = (intake?.products ?? []).filter((p) => p.age === age && p.phase !== "稳定");
  const screeningItems = intake?.intake.screening.find((s) => s.age === age)?.items ?? [];

  // 按年龄段展示对应的训练安全条件项（未确认时不写入，交由核心规则层导出保守版本）
  const conditionFields: { key: string; label: string }[] =
    age === "a18" || age === "a40"
      ? [
          { key: "高血压", label: "是否有高血压（未确认将按保守版：稳态有氧 + 保留换气提示音）" },
          { key: "骨质疏松", label: "是否有骨质疏松" },
          { key: "重度肥胖", label: "BMI 是否达到 37.5 及以上（仅记是/否，不记身高体重数字）" },
          { key: "没地方跳", label: "是否没有跳跃场地" },
        ]
      : age === "a65"
        ? [
            { key: "家里没有别人", label: "训练时家里是否没有其他人陪同" },
            { key: "高血压", label: "是否有高血压" },
            { key: "骨质疏松", label: "是否有骨质疏松" },
          ]
        : age === "a13"
          ? [
              { key: "家长在旁边", label: "训练时家长是否在旁边" },
              { key: "没地方跳", label: "是否没有跳跃场地" },
            ]
          : [];

  useEffect(() => {
    if (startProducts.length && !startProducts.some((p) => p.name === product)) {
      setProduct(startProducts[0].name);
    }
    const initAns: Record<string, "是" | "否" | ""> = {};
    for (const item of screeningItems) initAns[item] = screenAnswers[item] ?? "";
    setScreenAnswers(initAns);
  }, [age, intake]);

  const calcBedtime = async (st: string, wk: string, setter: (v: string) => void) => {
    setError(null);
    try {
      const res = await apiRequest<{ bedtime: string }>(
        `/api/bedtime?stage=${encodeURIComponent(st)}&wake=${encodeURIComponent(wk)}`,
      );
      setter(res.bedtime);
    } catch (err) {
      setError(formatApiError(err));
    }
  };

  const handleCreateProfile = async (e: Event) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const unanswered = screeningItems.filter((item) => screenAnswers[item] !== "是" && screenAnswers[item] !== "否");
      if (unanswered.length > 0) {
        setError(`请先逐项明确勾选全部安全筛查问题（尚有 ${unanswered.length} 项未选择「是 / 否」）`);
        setBusy(false);
        return;
      }
      const resolvedConditions: Record<string, boolean> = {};
      for (const f of conditionFields) {
        const v = condState[f.key];
        if (v === "是") resolvedConditions[f.key] = true;
        else if (v === "否") resolvedConditions[f.key] = false;
      }
      const prodObj = startProducts.find((p) => p.name === product);
      const venue = prodObj?.venue ?? "home";
      const profilePayload: Record<string, any> = {
        schema: PROFILE_FORMAT,
        code: code.trim(),
        stage,
        age,
        venue,
        product,
        timezone,
        startDate,
        segments: [{ n: 1, type: "标准", week: 1, start: startDate, product }],
        screening: {
          answers: screeningItems.map((item) => ({ item, answer: screenAnswers[item] as "是" | "否" })),
          doctorCleared,
          date: startDate,
          ...(doctorCleared ? { doctorDate } : {}),
        },
        ...(wake ? { wake } : {}),
        ...(bedtime ? { bedtime } : {}),
        ...(household.length ? { household } : {}),
      };
      if (age === "a06" || age === "a13") {
        profilePayload.school = { stage: schoolStage, entry: Number(schoolEntry) };
        if (age === "a13") {
          if (Object.keys(resolvedConditions).length) profilePayload.conditions = resolvedConditions;
          profilePayload.choices = ["table-row"];
          profilePayload.progress = {};
          profilePayload.progressLog = [];
        }
      } else if (age === "a65") {
        profilePayload.birth = birth;
        profilePayload.habitBase = { 散步: 20 };
        if (Object.keys(resolvedConditions).length) profilePayload.conditions = resolvedConditions;
        profilePayload.progress = {};
        profilePayload.progressLog = [];
      } else {
        profilePayload.birth = birth;
        profilePayload.body = "不记";
        if (Object.keys(resolvedConditions).length) profilePayload.conditions = resolvedConditions;
        profilePayload.choices = ["table-row"];
        profilePayload.progress = {};
        profilePayload.progressLog = [];
      }

      const res = await apiRequest<{ id: string; warnings: any[] }>("/api/profiles", {
        method: "POST",
        body: {
          profile: profilePayload,
          timezone,
          isManaged: me.user.role === "admin" ? isManaged : false,
          ...(me.user.role === "admin" && isManaged && memberUserId ? { memberUserId } : {}),
        },
      });
      setNotice(
        res.warnings?.length
          ? `已建档「${code.trim()}」（提示：${res.warnings.map((w: any) => w.message).join("；")}）`
          : `已成功建档「${code.trim()}」，接下来请前往「评估与复盘」完成入门评估`,
      );
      setCode("");
      setShowCreate(false);
      onRefreshProfiles();
      onSelectProfile(res.id);
    } catch (err) {
      setError(formatApiError(err));
    } finally {
      setBusy(false);
    }
  };

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
      if (editHousehold.length) patch.household = editHousehold;
      if (selectedProfile.age === "a18" || selectedProfile.age === "a40") {
        patch.body = editBody;
      }
      if (editDoctorCleared !== Boolean(profileDetail.profile?.screening?.doctorCleared)) {
        const nextScreening: Record<string, any> = {
          ...(profileDetail.profile?.screening ?? {}),
          doctorCleared: editDoctorCleared,
        };
        if (editDoctorCleared) nextScreening.doctorDate = todayIso();
        else delete nextScreening.doctorDate;
        patch.screening = nextScreening;
      }
      await apiRequest(`/api/profiles/${selectedProfile.id}`, {
        method: "PATCH",
        body: { expectedVersion: profileDetail.version, patch },
      });
      setNotice("已保存档案设置");
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
      const payload = JSON.stringify({
        type: "yangxia_pair",
        serverUrl: window.location.origin,
        code: res.code,
        profileCode: res.profileCode,
      });
      setPairModal({ code: res.code, profileCode: res.profileCode, expiresAt: res.expiresAt, payload });
      await loadCommon();
    } catch (err) {
      setError(formatApiError(err));
    } finally {
      setBusy(false);
    }
  };

  const revokeDevice = async (devId: string) => {
    setBusy(true);
    setError(null);
    try {
      await apiRequest(`/api/auth/devices/${devId}`, { method: "DELETE" });
      setNotice("已吊销该设备会话");
      await loadCommon();
    } catch (err) {
      setError(formatApiError(err));
    } finally {
      setBusy(false);
    }
  };

  const toggleArr = (arr: string[], val: string, setter: (v: string[]) => void) => {
    setter(arr.includes(val) ? arr.filter((x) => x !== val) : [...arr, val]);
  };

  return (
    <div class="stack" style={{ gap: "18px" }}>
      <div class="row-between">
        <div>
          <div class="eyebrow">成员隔离与手机扫码配对</div>
          <h1 class="h1">家庭与档案</h1>
        </div>
        {!me.isTeen && (
          <button class="btn primary" onClick={() => setShowCreate(!showCreate)}>
            {showCreate ? "收起建档向导" : "+ 可视向导新建档案"}
          </button>
        )}
      </div>

      {error && (
        <div class="banner danger" role="alert" style={{ whiteSpace: "pre-wrap" }}>
          {error}
        </div>
      )}
      {notice && <div class="banner ok">{notice}</div>}

      {/* 可视建档向导 */}
      {showCreate && !me.isTeen && (
        <form class="card" onSubmit={handleCreateProfile}>
          <h2 class="h2">新建档案向导（无需大模型，严格按入口问卷与筛查规则）</h2>
          <div class="grid-3">
            <label class="field">
              <span>档案代号（建议勿用真实姓名）</span>
              <input type="text" required value={code} onInput={(e) => setCode((e.target as HTMLInputElement).value)} placeholder="如 小夏、爸爸" />
            </label>
            <label class="field">
              <span>年龄 / 学段</span>
              <select
                value={`${stage}|${age}`}
                onChange={(e) => {
                  const [st, ag] = (e.target as HTMLSelectElement).value.split("|");
                  setStage(st);
                  setAge(ag);
                  if (ag === "a06") setSchoolStage("小学");
                  if (ag === "a13") setSchoolStage(st.includes("高") ? "高中" : "初中");
                }}
              >
                {(intake?.intake.stages ?? []).map((s) => (
                  <option key={`${s.label}-${s.age}`} value={`${s.label}|${s.age}`}>
                    {s.label} ({s.age})
                  </option>
                ))}
              </select>
            </label>
            <label class="field">
              <span>起始期计划成品</span>
              <select value={product} onChange={(e) => setProduct((e.target as HTMLSelectElement).value)}>
                {startProducts.map((p) => (
                  <option key={p.name} value={p.name}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div class="grid-3">
            {age === "a06" || age === "a13" ? (
              <>
                <label class="field">
                  <span>学段</span>
                  <select value={schoolStage} onChange={(e) => setSchoolStage((e.target as HTMLSelectElement).value)}>
                    <option value="小学">小学</option>
                    <option value="初中">初中</option>
                    <option value="高中">高中</option>
                  </select>
                </label>
                <label class="field">
                  <span>入学年份</span>
                  <input type="number" min={2010} max={2035} value={schoolEntry} onInput={(e) => setSchoolEntry(Number((e.target as HTMLInputElement).value))} />
                </label>
              </>
            ) : (
              <label class="field">
                <span>出生年月（仅记到月）</span>
                <input type="text" required pattern="\d{4}-\d{2}" value={birth} onInput={(e) => setBirth((e.target as HTMLInputElement).value)} placeholder="YYYY-MM" />
              </label>
            )}
            <label class="field">
              <span>开始日期</span>
              <input type="date" required value={startDate} onInput={(e) => setStartDate((e.target as HTMLInputElement).value)} />
            </label>
            <label class="field">
              <span>所在时区（IANA）</span>
              <input type="text" required value={timezone} onInput={(e) => setTimezone((e.target as HTMLInputElement).value)} />
            </label>
          </div>

          <div class="grid-3">
            <label class="field">
              <span>习惯起床时间</span>
              <input type="time" value={wake} onInput={(e) => setWake((e.target as HTMLInputElement).value)} />
            </label>
            <label class="field">
              <span>建议上床时间（由公式计算）</span>
              <div class="row">
                <input type="text" value={bedtime} readOnly placeholder="点击右侧计算" style={{ flex: 1 }} />
                <button type="button" class="btn small" onClick={() => void calcBedtime(stage, wake, setBedtime)}>
                  按公式计算
                </button>
              </div>
            </label>
            {me.user.role === "admin" && (
              <div class="stack">
                <label class="check">
                  <input type="checkbox" checked={isManaged} onChange={(e) => setIsManaged((e.target as HTMLInputElement).checked)} />
                  <span>设为管理员代管子档案（老人/儿童/青少年）</span>
                </label>
                {isManaged && (
                  <select value={memberUserId} onChange={(e) => setMemberUserId((e.target as HTMLSelectElement).value)}>
                    <option value="">不关联成员账号（仅扫码手机绑定）</option>
                    {users.filter((u) => u.role === "member").map((u) => (
                      <option key={u.id} value={u.id}>
                        关联只读成员：{u.username}
                      </option>
                    ))}
                  </select>
                )}
              </div>
            )}
          </div>

          {/* 逐字安全筛查 */}
          <div class="card-soft">
            <h3 class="h3">安全筛查（请如实逐项勾选「否 / 是」，不记录诊断或用药细节）</h3>
            {screeningItems.map((item) => (
              <div class="row-between" key={item} style={{ borderBottom: "1px solid var(--line)", padding: "6px 0" }}>
                <span style={{ flex: 1, fontSize: "14px" }}>{item}</span>
                <div class="row">
                  <label class="check">
                    <input
                      type="radio"
                      name={`scr-${item}`}
                      checked={screenAnswers[item] === "否"}
                      onChange={() => setScreenAnswers({ ...screenAnswers, [item]: "否" })}
                    />
                    <span>否</span>
                  </label>
                  <label class="check">
                    <input
                      type="radio"
                      name={`scr-${item}`}
                      checked={screenAnswers[item] === "是"}
                      onChange={() => setScreenAnswers({ ...screenAnswers, [item]: "是" })}
                    />
                    <span>是</span>
                  </label>
                </div>
              </div>
            ))}
            {conditionFields.length > 0 && (
              <div style={{ marginTop: "10px", paddingTop: "8px", borderTop: "1px solid var(--line)" }}>
                <div style={{ fontWeight: 600, fontSize: "14px", marginBottom: "6px" }}>
                  训练安全条件（可选，只记是/否；选「未确认」将自动导出保守版本）
                </div>
                {conditionFields.map((f) => (
                  <div class="row-between" key={f.key} style={{ borderBottom: "1px solid var(--line)", padding: "5px 0" }}>
                    <span style={{ flex: 1, fontSize: "13px" }}>{f.label}</span>
                    <div class="row">
                      {(["未确认", "否", "是"] as const).map((opt) => (
                        <label class="check" key={opt}>
                          <input
                            type="radio"
                            name={`cond-${f.key}`}
                            checked={(condState[f.key] ?? "未确认") === opt}
                            onChange={() => setCondState({ ...condState, [f.key]: opt })}
                          />
                          <span>{opt}</span>
                        </label>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
            <div class="row" style={{ marginTop: "6px" }}>
              <label class="check">
                <input type="checkbox" checked={doctorCleared} onChange={(e) => setDoctorCleared((e.target as HTMLInputElement).checked)} />
                <span>已咨询医生并获同意开始本计划（筛查有“是”或 65 岁以上须获同意后才可出课）</span>
              </label>
              {doctorCleared && (
                <input type="date" style={{ width: "160px" }} value={doctorDate} onInput={(e) => setDoctorDate((e.target as HTMLInputElement).value)} />
              )}
            </div>
          </div>

          <div class="row">
            <span class="muted">家庭同桌成员年龄段（排全家菜单用，可选）：</span>
            {(["a06", "a13", "a18", "a40", "a65"] as const).map((a) => (
              <label class="check" key={a}>
                <input type="checkbox" checked={household.includes(a)} onChange={() => toggleArr(household, a, setHousehold)} />
                <span>{a}</span>
              </label>
            ))}
          </div>

          <div class="row">
            <button class="btn primary" type="submit" disabled={busy}>
              {busy ? "创建中..." : "校验并创建档案"}
            </button>
          </div>
        </form>
      )}

      {/* 档案列表 */}
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
                {p.isManaged ? <span class="tag info">代管</span> : <span class="tag ok">个人</span>}
                {p.hasConflict && <span class="tag danger">冲突</span>}
              </div>
            </div>
            <div class="muted">{p.product}</div>
            <div class="muted">
              {p.currentSegment ? `第 ${p.currentSegment.n} 段 · 第 ${p.currentSegment.week} 周` : "未开始"} · {p.timezone}
            </div>
            <div class="row">
              <button class="btn small primary" onClick={() => onSelectProfile(p.id)}>
                {selectedProfile?.id === p.id ? "当前选中" : "切换此档案"}
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

      {/* 当前档案受控编辑 & 审计日志 */}
      {selectedProfile && selectedProfile.canManage && profileDetail && (
        <div class="grid-2">
          <form class="card" onSubmit={handleSaveEdit}>
            <h2 class="h2">档案受控设置 · {selectedProfile.code}（版本 v{profileDetail.version}）</h2>
            <div class="grid-2">
              <label class="field">
                <span>起床时间</span>
                <input type="time" value={editWake} onInput={(e) => setEditWake((e.target as HTMLInputElement).value)} />
              </label>
              <label class="field">
                <span>建议上床时间</span>
                <div class="row">
                  <input type="text" value={editBedtime} readOnly style={{ flex: 1 }} />
                  <button
                    type="button"
                    class="btn small"
                    onClick={() => void calcBedtime(selectedProfile.stage, editWake || "07:00", setEditBedtime)}
                  >
                    重算
                  </button>
                </div>
              </label>
            </div>

            {(selectedProfile.age === "a18" || selectedProfile.age === "a40") && (
              <label class="field">
                <span>体重腰围记录开关（仅 18–64 岁可选，出现焦虑可随时停记）</span>
                <select value={editBody} onChange={(e) => setEditBody((e.target as HTMLSelectElement).value as any)}>
                  <option value="不记">不记</option>
                  <option value="记">记</option>
                  <option value="停记">停记</option>
                </select>
              </label>
            )}

            <label class="check">
              <input type="checkbox" checked={editDoctorCleared} onChange={(e) => setEditDoctorCleared((e.target as HTMLInputElement).checked)} />
              <span>医生已同意开始 / 继续计划（doctorCleared）</span>
            </label>

            <div class="row">
              <span class="muted">家庭成员年龄段（household）：</span>
              {(["a06", "a13", "a18", "a40", "a65"] as const).map((a) => (
                <label class="check" key={a}>
                  <input type="checkbox" checked={editHousehold.includes(a)} onChange={() => toggleArr(editHousehold, a, setEditHousehold)} />
                  <span>{a}</span>
                </label>
              ))}
            </div>

            <button class="btn primary" type="submit" disabled={busy}>
              保存设置
            </button>
          </form>

          <div class="card">
            <h2 class="h2">规则核对与操作留痕</h2>
            {auditData?.issues?.length ? (
              <div class="stack">
                {auditData.issues.slice(0, 6).map((iss, idx) => (
                  <div class={iss.level === "error" ? "banner danger" : "banner warn"} key={idx}>
                    {iss.path ? `${iss.path}: ` : ""}
                    {iss.message}
                  </div>
                ))}
              </div>
            ) : (
              <div class="banner ok">当前档案与记录规则核对 0 错误。</div>
            )}

            <div style={{ maxHeight: "220px", overflowY: "auto" }}>
              <table class="tbl">
                <thead>
                  <tr>
                    <th>时间</th>
                    <th>操作</th>
                    <th>变更字段</th>
                  </tr>
                </thead>
                <tbody>
                  {(auditData?.auditLogs ?? []).slice(0, 15).map((l) => (
                    <tr key={l.id}>
                      <td>{String(l.createdAt).replace("T", " ").slice(0, 16)}</td>
                      <td><code>{l.action}</code></td>
                      <td>{Array.isArray(l.fields) ? l.fields.join(", ") : "-"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* 已登录与配对设备管理 */}
      <div class="card">
        <div class="row-between">
          <h2 class="h2">已登录与已配对设备（{devices.length}）</h2>
          <button class="btn small" onClick={() => void loadCommon()}>
            刷新设备
          </button>
        </div>
        <div style={{ overflowX: "auto" }}>
          <table class="tbl">
            <thead>
              <tr>
                <th>设备名称</th>
                <th>类型</th>
                <th>绑定档案</th>
                <th>最近活跃</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {devices.map((d) => (
                <tr key={d.id}>
                  <td>
                    {d.deviceName || "未命名设备"} {d.isCurrent && <span class="tag ok">当前</span>}
                  </td>
                  <td><code>{d.kind}</code></td>
                  <td>{d.boundProfileCode ?? "账号全权限"}</td>
                  <td>{String(d.lastUsedAt).replace("T", " ").slice(0, 16)}</td>
                  <td>
                    {!d.isCurrent && (
                      <button class="btn small danger" onClick={() => void revokeDevice(d.id)} disabled={busy}>
                        吊销下线
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* 纯本地 5 分钟扫码配对弹窗（0 外部网络请求） */}
      {pairModal && (
        <div class="modal-mask" onClick={() => setPairModal(null)}>
          <div class="modal-box" onClick={(e) => e.stopPropagation()}>
            <div class="row-between">
              <h2 class="h2">扫码绑定手机 · {pairModal.profileCode}</h2>
              <button class="btn small" onClick={() => setPairModal(null)}>
                关闭
              </button>
            </div>
            <p class="muted" style={{ margin: 0 }}>
              128 位单次有效绑定码，5 分钟内有效（截止 {pairModal.expiresAt.replace("T", " ").slice(11, 19)} UTC）。手机端绑定后仅能拉取「{pairModal.profileCode}」的课程并同步练习记录。
            </p>
            <div class="qr-wrap">
              {(() => {
                try {
                  const qr = qrSvgPath(pairModal.payload);
                  return (
                    <svg
                      width="220"
                      height="220"
                      viewBox={`0 0 ${qr.size} ${qr.size}`}
                      role="img"
                      aria-label="手机扫码配对二维码"
                    >
                      <rect width={qr.size} height={qr.size} fill="#FFFFFF" />
                      <path d={qr.path} fill="#1D2B24" />
                    </svg>
                  );
                } catch {
                  return <div class="muted">当前服务地址过长，无法渲染二维码，请直接复制下方配对码手动绑定。</div>;
                }
              })()}
            </div>
            <label class="field">
              <span>或手动输入配对码</span>
              <input type="text" readOnly value={pairModal.code} />
            </label>
          </div>
        </div>
      )}
    </div>
  );
}
