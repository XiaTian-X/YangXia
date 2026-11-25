// 评估与复盘：两块——评估（AssessPanel）、周复盘与个人进度（ReviewPanel），都照核心库算好的表单渲染。
import { useState } from "preact/hooks";
import { apiRequest, formatApiError } from "../lib/api.ts";
import type { ProfileSummary } from "../types.ts";
import { AssessPanel } from "./AssessPanel.tsx";
import { ReviewPanel } from "./ReviewPanel.tsx";

export function AssessReviewPage({
  profile,
  isAdmin,
  onRefreshProfiles,
}: {
  profile: ProfileSummary | null;
  isAdmin: boolean;
  onRefreshProfiles: () => void;
}) {
  const [part, setPart] = useState<"review" | "assess">("review");
  const [assessKind, setAssessKind] = useState<"入门" | "段末" | "周期末" | "触发" | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  if (!profile) {
    return <div class="section">先在"家庭与档案"选一份档案，或者新建一份。</div>;
  }
  if (!profile.canManage) {
    return (
      <div class="section">
        <h2>只能看</h2>
        <p class="muted">这个账号对这份档案只能看，评估和周复盘由家长、管理员或档案本人来做。</p>
      </div>
    );
  }

  const prevN = (profile.currentSegment?.n ?? 1) - 1;
  const archivePrev = async () => {
    if (prevN < 1 || !window.confirm(`把第 ${prevN} 段的记录归档？归档以后这一段的课程、复盘只读。`)) return;
    setBusy(true);
    setError(null);
    try {
      const d = await apiRequest<{ version: number }>(`/api/profiles/${profile.id}`);
      await apiRequest(`/api/profiles/${profile.id}/archive-segment`, { method: "POST", body: { expectedVersion: d.version, segment: prevN } });
      setNotice(`已把第 ${prevN} 段的记录归档`);
      onRefreshProfiles();
    } catch (e) {
      setError(formatApiError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="stack" style={{ gap: "16px" }}>
      <div class="row-between">
        <div class="pills" role="tablist" aria-label="评估与复盘" style={{ background: "var(--surface-2)", padding: "4px", borderRadius: "14px" }}>
          <button type="button" role="tab" class="pill" style={{ border: 0, minHeight: "40px" }} aria-selected={part === "review"} aria-pressed={part === "review"} onClick={() => setPart("review")}>周复盘与个人进度</button>
          <button type="button" role="tab" class="pill" style={{ border: 0, minHeight: "40px" }} aria-selected={part === "assess"} aria-pressed={part === "assess"} onClick={() => setPart("assess")}>评估</button>
        </div>
        {prevN >= 1 && (
          <button class="btn small" onClick={() => void archivePrev()} disabled={busy}>归档第 {prevN} 段</button>
        )}
      </div>
      {error && <div class="banner danger" role="alert" style={{ whiteSpace: "pre-wrap" }}>{error}</div>}
      {notice && <div class="banner ok">{notice}</div>}
      {part === "review" ? (
        <ReviewPanel profile={profile} onChanged={onRefreshProfiles} onGoAssess={(k) => { setAssessKind(k); setPart("assess"); }} />
      ) : (
        <AssessPanel profile={profile} isAdmin={isAdmin} initialKind={assessKind} onChanged={onRefreshProfiles} />
      )}
    </div>
  );
}
