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
  const [moreOpen, setMoreOpen] = useState(false);
  const [llmConfigured, setLlmConfigured] = useState(false);

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
        void apiRequest<{ configured: boolean }>("/api/agent/info").then((r) => setLlmConfigured(!!r.configured)).catch(() => {});
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

  const BOTTOM: { id: TabId; label: string; icon: string }[] = [
    { id: "schedule", label: "排课", icon: "M3 5h18v16H3zM3 10h18M8 3v4M16 3v4" },
    { id: "assess", label: "评估复盘", icon: "M9 11l3 3 8-8M20 12v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h9" },
    { id: "profiles", label: "档案", icon: "M9 8a3 3 0 1 0 0-.01M3 20a6 6 0 0 1 12 0M17 9a2.5 2.5 0 1 0 0-.01M15 15a5 5 0 0 1 6 5" },
  ];
  const moreItems = visibleNav.filter((n) => !BOTTOM.some((b) => b.id === n.id));
  const go = (id: TabId) => {
    setTab(id);
    setMoreOpen(false);
  };

  return (
    <div class="app-shell">
      <header class="appbar">
        <div class="appbar-in">
          <div class="brand">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 19c0-8 5-13 14-14-1 9-6 14-14 14z"></path><path d="M5 19l7-7"></path></svg>
            养夏
          </div>
          <nav class="topnav" aria-label="主导航">
            {visibleNav.map((item) => (
              <button key={item.id} class="nav-btn" aria-current={tab === item.id ? "page" : undefined} onClick={() => go(item.id)}>
                {item.label}
              </button>
            ))}
          </nav>
          <div class="appbar-right">
            {profiles.length > 0 ? (
              <select aria-label="切换当前档案" value={selectedProfileId} onChange={(e) => setSelectedProfileId((e.target as HTMLSelectElement).value)}>
                {profiles.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.code} · {p.product ?? "还没选成品"}
                    {p.isManaged ? "（代管）" : ""}
                    {p.hasConflict ? "（有冲突）" : ""}
                  </option>
                ))}
              </select>
            ) : (
              <span class="tag warn">还没建档</span>
            )}
            <span class="who muted">{me.user.username}{me.user.role === "admin" ? " · 管理员" : me.isTeen ? " · 只能看" : ""}</span>
            <button class="btn small logout" onClick={() => void logout()}>退出</button>
          </div>
        </div>
        <div class="declbar" role="note">
          <div class="declbar-in">
            <strong>{DECLARATION_TEXT}</strong>
            <span>{llmConfigured ? "配置了大模型：和助手对话时，档案摘要会发给你配置的模型服务商" : "没有配置大模型：档案只存在这台服务器上，不发往别处"}</span>
          </div>
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

      <nav class="bottomnav" aria-label="手机导航">
        {BOTTOM.map((b) => (
          <button key={b.id} aria-current={tab === b.id ? "page" : undefined} onClick={() => go(b.id)}>
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d={b.icon}></path></svg>
            {b.label}
          </button>
        ))}
        <button aria-expanded={moreOpen} aria-current={moreItems.some((m) => m.id === tab) ? "page" : undefined} onClick={() => setMoreOpen(!moreOpen)}>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.8"></circle><circle cx="12" cy="12" r="1.8"></circle><circle cx="19" cy="12" r="1.8"></circle></svg>
          更多
        </button>
      </nav>
      {moreOpen && (
        <div class="sheet-mask" onClick={() => setMoreOpen(false)}>
          <div class="sheet" role="dialog" aria-label="更多" onClick={(e) => e.stopPropagation()}>
            <div class="row-between"><strong>更多</strong><button class="btn small" onClick={() => setMoreOpen(false)}>关闭</button></div>
            {moreItems.map((m) => (
              <button key={m.id} class="sheet-item" onClick={() => go(m.id)}>{m.label}</button>
            ))}
            <button class="sheet-item danger" onClick={() => void logout()}>退出登录</button>
          </div>
        </div>
      )}
    </div>
  );
}
