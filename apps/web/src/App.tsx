import { useEffect, useState } from "preact/hooks";
import { apiRequest } from "./lib/api.ts";
import { AdminOpsPage } from "./pages/AdminOpsPage.tsx";
import { AgentChatPage } from "./pages/AgentChatPage.tsx";
import { AssessReviewPage } from "./pages/AssessReviewPage.tsx";
import { DocsMealPage } from "./pages/DocsMealPage.tsx";
import { FamilyProfilesPage } from "./pages/FamilyProfilesPage.tsx";
import { SchedulePage } from "./pages/SchedulePage.tsx";
import { SetupLoginView } from "./pages/SetupLoginView.tsx";
import { DECLARATION_TEXT, type AuthMe, type ProfileSummary, type SetupStatusResponse, type TabId } from "./types.ts";

const NAV_ITEMS: { id: TabId; label: string; adminOnly?: boolean }[] = [
  { id: "schedule", label: "排课中心" },
  { id: "assess", label: "评估与复盘" },
  { id: "profiles", label: "家庭与档案" },
  { id: "docs", label: "饮食与模板" },
  { id: "agent", label: "养夏助手" },
  { id: "admin", label: "系统管理", adminOnly: true },
];

export function App() {
  const [booting, setBooting] = useState(true);
  const [initialized, setInitialized] = useState(true);
  const [me, setMe] = useState<AuthMe | null>(null);
  const [profiles, setProfiles] = useState<ProfileSummary[]>([]);
  const [selectedProfileId, setSelectedProfileId] = useState<string>("");
  const [tab, setTab] = useState<TabId>("schedule");
  const [docHint, setDocHint] = useState<string | null>(null);

  const loadProfiles = async () => {
    try {
      const res = await apiRequest<{ profiles: ProfileSummary[] }>("/api/profiles");
      const list = res.profiles ?? [];
      setProfiles(list);
      setSelectedProfileId((prev) => {
        if (prev && list.some((p) => p.id === prev)) return prev;
        return list[0]?.id ?? "";
      });
    } catch {
      setProfiles([]);
    }
  };

  const boot = async () => {
    setBooting(true);
    try {
      const status = await apiRequest<SetupStatusResponse>("/api/setup/status");
      setInitialized(!status.needsSetup);
      if (status.needsSetup) {
        setMe(null);
        return;
      }
      try {
        const who = await apiRequest<AuthMe>("/api/auth/me");
        setMe(who);
        // 自动滑动续期会话
        void apiRequest("/api/auth/refresh", { method: "POST" }).catch(() => {});
        await loadProfiles();
      } catch {
        setMe(null);
      }
    } finally {
      setBooting(false);
    }
  };

  useEffect(() => {
    void boot();
  }, []);

  const logout = async () => {
    try {
      await apiRequest("/api/auth/logout", { method: "POST" });
    } catch {
      /* ignore */
    }
    setMe(null);
    setProfiles([]);
    setSelectedProfileId("");
    setTab("schedule");
  };

  if (booting) {
    return (
      <div class="auth-wrap">
        <div class="card auth-card">正在连接养夏服务端...</div>
      </div>
    );
  }

  if (!me) {
    return <SetupLoginView initialized={initialized} onSuccess={() => void boot()} />;
  }

  const selectedProfile = profiles.find((p) => p.id === selectedProfileId) ?? null;
  const visibleNav = NAV_ITEMS.filter((item) => !item.adminOnly || me.user.role === "admin");

  const handleNavigate = (nextTab: TabId, nextDocHint?: string) => {
    if (nextDocHint) setDocHint(nextDocHint);
    setTab(nextTab);
  };

  return (
    <div class="app-shell">
      <nav class="nav" aria-label="主导航">
        <div class="brand-box">
          <span style={{ color: "var(--accent)" }}>●</span>
          <span>养夏 · 自托管</span>
        </div>

        <div class="nav-list">
          {visibleNav.map((item) => (
            <button
              key={item.id}
              class={tab === item.id ? "nav-btn on" : "nav-btn"}
              aria-current={tab === item.id ? "page" : undefined}
              onClick={() => setTab(item.id)}
            >
              {item.label}
            </button>
          ))}
        </div>

        <div class="nav-foot">
          <div>
            当前账号：<strong>{me.user.username}</strong> ({me.user.role === "admin" ? "管理员" : me.isTeen ? "青少年只读" : "成员"})
          </div>
          <button class="btn small" onClick={() => void logout()}>
            退出登录
          </button>
        </div>
      </nav>

      <div class="main-wrap">
        <div class="disclaimer-bar" role="note">
          <span>{DECLARATION_TEXT}</span>
          <span class="muted">所有数据仅存自有服务器，无任何第三方外联资源</span>
        </div>

        <header class="topbar">
          <div class="row" style={{ flex: 1 }}>
            <span class="muted">当前档案：</span>
            {profiles.length > 0 ? (
              <select
                aria-label="切换当前档案"
                style={{ maxWidth: "300px" }}
                value={selectedProfileId}
                onChange={(e) => setSelectedProfileId((e.target as HTMLSelectElement).value)}
              >
                {profiles.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.code} · {p.product}
                    {p.isManaged ? "（代管）" : ""}
                    {p.hasConflict ? " [冲突]" : ""}
                  </option>
                ))}
              </select>
            ) : (
              <span class="tag warn">尚未建档</span>
            )}
          </div>
          <div class="row">
            <span class="muted">{me.user.username}</span>
            <button class="btn small" onClick={() => void logout()}>
              退出
            </button>
          </div>
        </header>

        <main class="page">
          {tab === "schedule" && (
            <SchedulePage
              profile={selectedProfile}
              onNavigate={handleNavigate}
              onRefreshProfiles={() => void loadProfiles()}
            />
          )}
          {tab === "assess" && (
            <AssessReviewPage profile={selectedProfile} isAdmin={me.user.role === "admin"} onRefreshProfiles={() => void loadProfiles()} />
          )}
          {tab === "profiles" && (
            <FamilyProfilesPage
              me={me}
              profiles={profiles}
              selectedProfile={selectedProfile}
              onSelectProfile={(id) => setSelectedProfileId(id)}
              onRefreshProfiles={() => void loadProfiles()}
            />
          )}
          {tab === "docs" && <DocsMealPage profile={selectedProfile} initialDocHint={docHint} />}
          {tab === "agent" && (
            <AgentChatPage
              me={me}
              profile={selectedProfile}
              onNavigate={handleNavigate}
              onRefreshProfiles={() => void loadProfiles()}
            />
          )}
          {tab === "admin" && me.user.role === "admin" && (
            <AdminOpsPage onRefreshProfiles={() => void loadProfiles()} />
          )}
        </main>
      </div>
    </div>
  );
}
