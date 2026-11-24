import { useEffect, useState } from "preact/hooks";
import { apiRequest, formatApiError } from "../lib/api.ts";

export function AdminOpsPage({ onRefreshProfiles }: { onRefreshProfiles: () => void }) {
  const [settings, setSettings] = useState<any[]>([]);
  const [users, setUsers] = useState<any[]>([]);
  const [tplMeta, setTplMeta] = useState<any>(null);

  // 外部大模型设置
  const [provider, setProvider] = useState("deepseek");
  const [model, setModel] = useState("deepseek-chat");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [retentionDays, setRetentionDays] = useState("30");

  // 新增家庭成员
  const [newUsername, setNewUsername] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [newRole, setNewRole] = useState<"member" | "admin">("member");

  // 迁移与备份
  const [migrateFile, setMigrateFile] = useState<File | null>(null);
  const [migrateDir, setMigrateDir] = useState("");
  const [migrateManaged, setMigrateManaged] = useState(false);
  const [migrateReport, setMigrateReport] = useState<any>(null);
  const [exportPass, setExportPass] = useState("");
  const [restoreFile, setRestoreFile] = useState<File | null>(null);
  const [restorePass, setRestorePass] = useState("");

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = async () => {
    try {
      const [sRes, uRes, tRes] = await Promise.all([
        apiRequest<{ settings: any[] }>("/api/admin/settings"),
        apiRequest<{ users: any[] }>("/api/admin/users"),
        apiRequest<any>("/api/templates/meta"),
      ]);
      const list = sRes.settings ?? [];
      setSettings(list);
      setUsers(uRes.users ?? []);
      setTplMeta(tRes);
      const getVal = (k: string) => list.find((x: any) => x.key === k)?.value ?? "";
      if (getVal("agent.provider")) setProvider(getVal("agent.provider"));
      if (getVal("agent.model")) setModel(getVal("agent.model"));
      setBaseUrl(getVal("agent.baseUrl"));
      if (getVal("agent.retentionDays")) setRetentionDays(getVal("agent.retentionDays"));
    } catch (err) {
      setError(formatApiError(err));
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const hasApiKeyConfigured = settings.some((s) => s.key === "agent.apiKey" && s.configured);
  const restoreNotice = settings.find((s) => s.key === "system.restore_notice")?.value;

  const saveAgentSettings = async (e: Event) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const items: { key: string; value: string | null; isSecret?: boolean }[] = [
        { key: "agent.provider", value: provider },
        { key: "agent.model", value: model.trim() || "deepseek-chat" },
        { key: "agent.baseUrl", value: baseUrl.trim() || null },
        { key: "agent.retentionDays", value: retentionDays.trim() || "0" },
      ];
      if (apiKey.trim()) {
        items.push({ key: "agent.apiKey", value: apiKey.trim(), isSecret: true });
      }
      await apiRequest("/api/admin/settings", { method: "PATCH", body: { items } });
      setApiKey("");
      setNotice("已加密保存外部大模型与对话保留配置（API Key 仅以 AES-256-GCM 密文落库，永不明文回显）");
      await load();
    } catch (err) {
      setError(formatApiError(err));
    } finally {
      setBusy(false);
    }
  };

  const createUser = async (e: Event) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await apiRequest("/api/admin/users", {
        method: "POST",
        body: { username: newUsername.trim(), password: newPassword, role: newRole },
      });
      setNewUsername("");
      setNewPassword("");
      setNotice("已创建家庭成员账号");
      await load();
    } catch (err) {
      setError(formatApiError(err));
    } finally {
      setBusy(false);
    }
  };

  const reloadTemplates = async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await apiRequest<{ version: string; invalidatedCount: number }>("/api/admin/templates/reload", {
        method: "POST",
        body: {},
      });
      setNotice(`已原子热重载模板至版本 ${res.version}，受影响旧课程已自动作废 ${res.invalidatedCount} 节`);
      await load();
      onRefreshProfiles();
    } catch (err) {
      setError(formatApiError(err));
    } finally {
      setBusy(false);
    }
  };

  const runV1Migrate = async (e: Event) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    setMigrateReport(null);
    try {
      let res: { report: any };
      if (migrateFile) {
        const fd = new FormData();
        fd.append("file", migrateFile);
        fd.append("isManaged", String(migrateManaged));
        res = await apiRequest<{ report: any }>("/api/profiles/import-v1", { method: "POST", formData: fd });
      } else if (migrateDir.trim()) {
        res = await apiRequest<{ report: any }>("/api/profiles/import-v1", {
          method: "POST",
          body: { directoryPath: migrateDir.trim(), isManaged: migrateManaged },
        });
      } else {
        setError("请选择 v1.0.0 档案 ZIP 压缩包，或填写白名单目录名");
        setBusy(false);
        return;
      }
      setMigrateReport(res.report);
      setNotice("已完成 v1.0.0 档案迁移导入");
      onRefreshProfiles();
    } catch (err) {
      setError(formatApiError(err));
    } finally {
      setBusy(false);
    }
  };

  const exportBackup = async (e: Event) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await apiRequest<Response>("/api/admin/backup/export", {
        method: "POST",
        body: { passphrase: exportPass },
        rawResponse: true,
      });
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `yangxia-backup-${new Date().toISOString().slice(0, 10)}.yxbackup`;
      a.click();
      URL.revokeObjectURL(url);
      setNotice("已生成并下载换机可用加密备份（已自动物理剥离外部模型 API Key）");
    } catch (err) {
      setError(formatApiError(err));
    } finally {
      setBusy(false);
    }
  };

  const triggerAutoBackup = async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await apiRequest<{ fileName: string; prunedCount: number }>("/api/admin/backup/run-auto", {
        method: "POST",
        body: {},
      });
      setNotice(`已完成服务端自动备份（${res.fileName}，轮转清理 ${res.prunedCount} 份旧备份）`);
    } catch (err) {
      setError(formatApiError(err));
    } finally {
      setBusy(false);
    }
  };

  const restoreBackup = async (e: Event) => {
    e.preventDefault();
    if (!restoreFile) {
      setError("请先选择 .yxbackup 加密备份文件");
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const fd = new FormData();
      fd.append("file", restoreFile);
      fd.append("passphrase", restorePass);
      const res = await apiRequest<{ restoredFrom: string; notice: string }>("/api/admin/backup/restore", {
        method: "POST",
        formData: fd,
      });
      setNotice(`已恢复自 ${res.restoredFrom} 的备份。${res.notice}`);
      await load();
      onRefreshProfiles();
    } catch (err) {
      setError(formatApiError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="stack" style={{ gap: "18px" }}>
      <div>
        <div class="eyebrow">管理员控制台</div>
        <h1 class="h1">系统设置、迁移与加密备份</h1>
      </div>

      {restoreNotice && <div class="banner warn">{restoreNotice}</div>}
      {error && (
        <div class="banner danger" role="alert" style={{ whiteSpace: "pre-wrap" }}>
          {error}
        </div>
      )}
      {notice && <div class="banner ok">{notice}</div>}

      <div class="grid-2">
        {/* 外部模型与对话设置 */}
        <form class="card" onSubmit={saveAgentSettings}>
          <div class="row-between">
            <h2 class="h2">外部大模型配置（可选）</h2>
            <span class={hasApiKeyConfigured ? "tag ok" : "tag warn"}>
              {hasApiKeyConfigured ? "API Key 已加密存储" : "未配置 Key"}
            </span>
          </div>
          <div class="grid-2">
            <label class="field">
              <span>模型提供方</span>
              <select value={provider} onChange={(e) => setProvider((e.target as HTMLSelectElement).value)}>
                <option value="deepseek">DeepSeek</option>
                <option value="openai">OpenAI</option>
                <option value="anthropic">Anthropic (Claude)</option>
                <option value="openai-compatible">OpenAI 兼容（含本地 Ollama/vLLM）</option>
              </select>
            </label>
            <label class="field">
              <span>模型名称</span>
              <input type="text" value={model} onInput={(e) => setModel((e.target as HTMLInputElement).value)} />
            </label>
          </div>
          <label class="field">
            <span>自定义 Base URL（可选，默认使用官方地址）</span>
            <input type="text" value={baseUrl} onInput={(e) => setBaseUrl((e.target as HTMLInputElement).value)} placeholder="留空走默认地址" />
          </label>
          <div class="grid-2">
            <label class="field">
              <span>新 API Key（留空表示不修改）</span>
              <input
                type="password"
                value={apiKey}
                onInput={(e) => setApiKey((e.target as HTMLInputElement).value)}
                placeholder={hasApiKeyConfigured ? "已保存，如需更换请填写新 Key" : "填写外部模型 API Key"}
              />
            </label>
            <label class="field">
              <span>历史对话自动清理天数（0 = 不自动删）</span>
              <input type="number" min={0} max={3650} value={retentionDays} onInput={(e) => setRetentionDays((e.target as HTMLInputElement).value)} />
            </label>
          </div>
          <button class="btn primary" type="submit" disabled={busy}>
            保存模型配置
          </button>
        </form>

        {/* 模板管理 & 家庭账号 */}
        <div class="stack" style={{ gap: "16px" }}>
          <div class="card">
            <div class="row-between">
              <div>
                <h2 class="h2">计划模板版本与热重载</h2>
                <div class="muted">
                  当前版本：<code>{tplMeta?.version ?? "-"}</code> · 校验摘要：<code>{String(tplMeta?.templateHash ?? "").slice(0, 12)}</code>
                </div>
              </div>
              <button class="btn primary small" onClick={reloadTemplates} disabled={busy}>
                重新加载模板
              </button>
            </div>
          </div>

          <form class="card" onSubmit={createUser}>
            <h2 class="h2">家庭成员账号（{users.length}）</h2>
            <div class="grid-3">
              <input
                type="text"
                required
                placeholder="新用户名"
                value={newUsername}
                onInput={(e) => setNewUsername((e.target as HTMLInputElement).value)}
              />
              <input
                type="password"
                required
                placeholder="初始密码（>=8位含字母数字）"
                value={newPassword}
                onInput={(e) => setNewPassword((e.target as HTMLInputElement).value)}
              />
              <select value={newRole} onChange={(e) => setNewRole((e.target as HTMLSelectElement).value as any)}>
                <option value="member">家庭成员 (member)</option>
                <option value="admin">管理员 (admin)</option>
              </select>
            </div>
            <button class="btn primary small" type="submit" disabled={busy}>
              创建成员账号
            </button>
            <div class="row">
              {users.map((u) => (
                <span class="tag" key={u.id}>
                  {u.username} ({u.role})
                </span>
              ))}
            </div>
          </form>
        </div>
      </div>

      {/* v1.0.0 迁移与换机加密备份 */}
      <div class="grid-2">
        <form class="card" onSubmit={runV1Migrate}>
          <h2 class="h2">v1.0.0 本地档案迁移导入</h2>
          <p class="muted" style={{ margin: 0 }}>
            将原 <code>profiles/&lt;代号&gt;/</code> 打包成 ZIP 上传（保留 <code>打卡/</code>、<code>复盘/</code>、<code>评估/</code>、<code>历史/第N段/</code> 全部相对路径依据）。
          </p>
          <label class="field">
            <span>上传 ZIP 压缩包</span>
            <input type="file" accept=".zip" onChange={(e) => setMigrateFile((e.target as HTMLInputElement).files?.[0] ?? null)} />
          </label>
          <label class="field">
            <span>或从服务端白名单目录（YANGXIA_MIGRATE_DIR）导入</span>
            <input type="text" value={migrateDir} onInput={(e) => setMigrateDir((e.target as HTMLInputElement).value)} placeholder="子目录名（如 小夏）" />
          </label>
          <label class="check">
            <input type="checkbox" checked={migrateManaged} onChange={(e) => setMigrateManaged((e.target as HTMLInputElement).checked)} />
            <span>导入为管理员代管子档案</span>
          </label>
          <button class="btn primary" type="submit" disabled={busy}>
            开始校验并导入
          </button>
          {migrateReport && <pre class="code-box">{JSON.stringify(migrateReport, null, 2)}</pre>}
        </form>

        <div class="card">
          <h2 class="h2">换机可用加密备份与恢复（.yxbackup）</h2>
          <p class="muted" style={{ margin: 0 }}>
            使用独立备份口令（scrypt + AES-256-GCM）加密导出，自动物理剥离原宿主机保存的模型 API Key，支持跨机器无损恢复。
          </p>
          <form class="row" onSubmit={exportBackup}>
            <input
              type="password"
              required
              minLength={8}
              style={{ flex: 1 }}
              value={exportPass}
              onInput={(e) => setExportPass((e.target as HTMLInputElement).value)}
              placeholder="设置备份口令（至少 8 位）"
            />
            <button class="btn primary small" type="submit" disabled={busy}>
              导出 .yxbackup
            </button>
            <button type="button" class="btn small" onClick={triggerAutoBackup} disabled={busy}>
              触发自动备份
            </button>
          </form>

          <hr style={{ border: 0, borderTop: "1px solid var(--line)", width: "100%" }} />

          <form class="stack" onSubmit={restoreBackup}>
            <label class="field">
              <span>从加密备份恢复（将覆盖当前数据库，并在失败时自动回滚）</span>
              <input type="file" accept=".yxbackup" onChange={(e) => setRestoreFile((e.target as HTMLInputElement).files?.[0] ?? null)} />
            </label>
            <div class="row">
              <input
                type="password"
                required
                minLength={8}
                style={{ flex: 1 }}
                value={restorePass}
                onInput={(e) => setRestorePass((e.target as HTMLInputElement).value)}
                placeholder="输入该备份文件的解密口令"
              />
              <button class="btn danger small" type="submit" disabled={busy}>
                校验并恢复备份
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}
