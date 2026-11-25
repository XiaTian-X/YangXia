import { useState } from "preact/hooks";
import { apiRequest, formatApiError } from "../lib/api.ts";
import { DECLARATION_TEXT } from "../types.ts";

export function SetupLoginView({
  initialized,
  onSuccess,
}: {
  initialized: boolean;
  onSuccess: () => void;
}) {
  const [username, setUsername] = useState(initialized ? "" : "admin");
  const [password, setPassword] = useState("");
  const [confirmPw, setConfirmPw] = useState("");
  const [setupCode, setSetupCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: Event) => {
    e.preventDefault();
    setError(null);
    if (!initialized && password !== confirmPw) {
      setError("两次输入的密码不一致");
      return;
    }
    setBusy(true);
    try {
      if (!initialized) {
        await apiRequest("/api/setup/init", {
          method: "POST",
          body: { username: username.trim(), password, setupCode: setupCode.trim() },
        });
      } else {
        await apiRequest("/api/auth/login", {
          method: "POST",
          body: { username: username.trim(), password, kind: "web" },
        });
      }
      onSuccess();
    } catch (err) {
      setError(formatApiError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="auth-wrap">
      <div class="card auth-card">
        <div class="stack" style={{ gap: "4px" }}>
          <span class="eyebrow">养夏 · 自托管版</span>
          <h1 class="h1">{initialized ? "登录家庭排课台" : "首次初始化管理员"}</h1>
          <p class="muted" style={{ margin: 0 }}>
            {initialized
              ? "输入家庭成员或管理员账号登录。个人健康数据仅保存在你的自有服务端。"
              : "欢迎使用养夏自托管版。请先创建管理员账号（密码至少 8 位且包含字母与数字）。"}
          </p>
        </div>

        <div class="banner info">{DECLARATION_TEXT}</div>

        {error && (
          <div class="banner danger" role="alert">
            {error}
          </div>
        )}

        <form class="stack" onSubmit={submit}>
          {!initialized && (
            <label class="field">
              <span>初始化口令（在服务启动日志里，也写在数据目录的 setup-code.txt 里）</span>
              <input
                type="text"
                name="setupCode"
                required
                autoComplete="off"
                spellcheck={false}
                value={setupCode}
                onInput={(e) => setSetupCode((e.target as HTMLInputElement).value)}
                placeholder="如 ABCD-EFGH-JKMN"
              />
            </label>
          )}
          <label class="field">
            <span>用户名</span>
            <input
              type="text"
              name="username"
              required
              autoComplete="username"
              value={username}
              onInput={(e) => setUsername((e.target as HTMLInputElement).value)}
              placeholder={initialized ? "输入用户名" : "如 admin"}
            />
          </label>
          <label class="field">
            <span>密码</span>
            <input
              type="password"
              name="password"
              required
              autoComplete={initialized ? "current-password" : "new-password"}
              value={password}
              onInput={(e) => setPassword((e.target as HTMLInputElement).value)}
              placeholder="至少 8 位，含字母与数字"
            />
          </label>
          {!initialized && (
            <label class="field">
              <span>确认密码</span>
              <input
                type="password"
                name="confirmPassword"
                required
                autoComplete="new-password"
                value={confirmPw}
                onInput={(e) => setConfirmPw((e.target as HTMLInputElement).value)}
                placeholder="再次输入密码"
              />
            </label>
          )}
          <button class="btn primary" type="submit" disabled={busy}>
            {busy ? "提交中..." : initialized ? "登录" : "创建管理员并进入"}
          </button>
        </form>
      </div>
    </div>
  );
}
