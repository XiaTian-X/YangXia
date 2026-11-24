import { useEffect, useRef, useState } from "preact/hooks";
import { apiRequest, formatApiError, streamSsePost } from "../lib/api.ts";
import type { AuthMe, ProfileSummary, TabId } from "../types.ts";

interface AgentInfo {
  configured: boolean;
  provider: string | null;
  model: string | null;
  declaration: string;
  disclosure: string;
  minModelRequirement: string;
  skills: string[];
}

interface PendingCard {
  id: string;
  toolName: string;
  summary: string;
  preview?: Record<string, unknown> | null;
  warnings?: { path: string; message: string }[];
}

const SKILL_LABELS: Record<string, string> = {
  general: "综合助手",
  onboard: "新档建档引导",
  "course-export": "排课发布",
  "weekly-review": "每周复盘",
  assess: "阶段评估",
  "meal-plan": "全家排菜单",
};

export function AgentChatPage({
  me,
  profile,
  onNavigate,
  onRefreshProfiles,
}: {
  me: AuthMe;
  profile: ProfileSummary | null;
  onNavigate: (tab: TabId) => void;
  onRefreshProfiles: () => void;
}) {
  const [info, setInfo] = useState<AgentInfo | null>(null);
  const [threads, setThreads] = useState<any[]>([]);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [messages, setMessages] = useState<any[]>([]);
  const [pendingCards, setPendingCards] = useState<PendingCard[]>([]);
  const [skill, setSkill] = useState<string>("general");
  const [inputText, setInputText] = useState("");
  const [streamingText, setStreamingText] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [circuitNotice, setCircuitNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyConfirm, setBusyConfirm] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const loadInfoAndThreads = async () => {
    try {
      const [inf, th] = await Promise.all([
        apiRequest<AgentInfo>("/api/agent/info"),
        apiRequest<{ threads: any[] }>("/api/agent/threads"),
      ]);
      setInfo(inf);
      setThreads(th.threads ?? []);
      if (th.threads?.length && !activeThreadId) {
        setActiveThreadId(th.threads[0].id);
      }
    } catch (err) {
      setError(formatApiError(err));
    }
  };

  const loadThreadDetail = async (tid: string) => {
    try {
      const det = await apiRequest<{
        thread: any;
        messages: any[];
        pendingConfirmations: PendingCard[];
      }>(`/api/agent/threads/${tid}`);
      setMessages(det.messages ?? []);
      setPendingCards(det.pendingConfirmations ?? []);
      setSkill(det.thread?.skill ?? "general");
    } catch (err) {
      setError(formatApiError(err));
    }
  };

  useEffect(() => {
    void loadInfoAndThreads();
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    if (activeThreadId) void loadThreadDetail(activeThreadId);
    else {
      setMessages([]);
      setPendingCards([]);
    }
  }, [activeThreadId]);

  const createNewThread = async (chosenSkill = skill, bindCurrent = chosenSkill !== "onboard") => {
    setError(null);
    setCircuitNotice(null);
    try {
      const res = await apiRequest<{ thread: any }>("/api/agent/threads", {
        method: "POST",
        body: {
          profileId: bindCurrent && profile ? profile.id : null,
          skill: chosenSkill,
          title: `${SKILL_LABELS[chosenSkill] ?? "对话"}${bindCurrent && profile ? ` · ${profile.code}` : ""}`,
        },
      });
      await loadInfoAndThreads();
      setActiveThreadId(res.thread.id);
      return res.thread.id as string;
    } catch (err) {
      setError(formatApiError(err));
      return null;
    }
  };

  const deleteCurrentThread = async () => {
    if (!activeThreadId) return;
    setError(null);
    try {
      await apiRequest(`/api/agent/threads/${activeThreadId}`, { method: "DELETE" });
      setActiveThreadId(null);
      await loadInfoAndThreads();
    } catch (err) {
      setError(formatApiError(err));
    }
  };

  const sendMessage = async (e: Event) => {
    e.preventDefault();
    const text = inputText.trim();
    if (!text || streaming) return;
    setError(null);
    setCircuitNotice(null);

    let tid = activeThreadId;
    if (!tid) {
      tid = await createNewThread(skill, skill !== "onboard");
      if (!tid) return;
    }

    setInputText("");
    setMessages((prev) => [...prev, { id: `local-${Date.now()}`, role: "user", content: { text } }]);
    setStreaming(true);
    setStreamingText("");

    const ac = new AbortController();
    abortRef.current = ac;

    try {
      await streamSsePost(
        `/api/agent/threads/${tid}/messages`,
        { text, skill },
        (ev) => {
          if (ev.event === "text_delta" && typeof ev.data?.text === "string") {
            setStreamingText((prev) => prev + ev.data.text);
          } else if (ev.event === "confirmation_required") {
            setPendingCards((prev) => [
              {
                id: ev.data.confirmationId,
                toolName: ev.data.toolName,
                summary: ev.data.summary,
                preview: ev.data.preview,
                warnings: ev.data.warnings,
              },
              ...prev.filter((c) => c.id !== ev.data.confirmationId),
            ]);
          } else if (ev.event === "circuit_breaker") {
            setCircuitNotice(ev.data?.message ?? "工具多次校验失败已自动熔断，请改用网页可视表单");
          } else if (ev.event === "error") {
            setError(ev.data?.message ?? "模型响应异常");
          }
        },
        ac.signal,
      );
      await loadThreadDetail(tid);
      onRefreshProfiles();
    } catch (err: any) {
      if (err?.name !== "AbortError") {
        setError(formatApiError(err));
      }
    } finally {
      abortRef.current = null;
      setStreaming(false);
      setStreamingText("");
    }
  };

  const handleConfirm = async (confirmationId: string, decision: "confirm" | "cancel") => {
    if (!activeThreadId) return;
    setBusyConfirm(confirmationId);
    setError(null);
    try {
      await apiRequest(`/api/agent/threads/${activeThreadId}/confirm`, {
        method: "POST",
        body: { confirmationId, decision },
      });
      await loadThreadDetail(activeThreadId);
      onRefreshProfiles();
    } catch (err) {
      setError(formatApiError(err));
    } finally {
      setBusyConfirm(null);
    }
  };

  return (
    <div class="stack" style={{ gap: "16px" }}>
      <div class="row-between">
        <div>
          <div class="eyebrow">受控业务工具 · 高危双阶段确认 · 3 次失败熔断</div>
          <h1 class="h1">养夏助手</h1>
        </div>
        <div class="row">
          <button class="btn small" onClick={() => onNavigate("assess")}>
            高敏感数据改用可视表单（不经外发模型）
          </button>
          {me.user.role === "admin" && !info?.configured && (
            <button class="btn small primary" onClick={() => onNavigate("admin")}>
              去配置外部模型 API Key
            </button>
          )}
        </div>
      </div>

      {/* 必显隐私披露与最低模型提示 */}
      {info && (
        <div class="banner info">
          <strong>隐私披露与模型说明</strong>
          <span>{info.disclosure}</span>
          <span style={{ fontSize: "13px", opacity: 0.9 }}>{info.minModelRequirement}</span>
        </div>
      )}

      {info && !info.configured && (
        <div class="banner warn">
          <strong>尚未配置外部大模型 API Key</strong>
          <span>
            养夏不强依赖大模型：你仍可通过「排课中心」「评估与复盘」「家庭与档案」「饮食与模板阅读」完成全部日常流程；如需对话辅助，请管理员在「系统管理」中填写模型 API Key。
          </span>
        </div>
      )}

      {error && (
        <div class="banner danger" role="alert">
          {error}
        </div>
      )}
      {circuitNotice && (
        <div class="banner warn" role="alert">
          <strong>触发校验熔断护栏</strong>
          <span>{circuitNotice}</span>
          <div>
            <button class="btn small primary" onClick={() => onNavigate("assess")}>
              立即切换至网页可视表单
            </button>
          </div>
        </div>
      )}

      <div class="chat-layout">
        {/* 左侧对话列表 */}
        <div class="card">
          <label class="field">
            <span>场景模式（Skill）</span>
            <select value={skill} onChange={(e) => setSkill((e.target as HTMLSelectElement).value)}>
              {Object.entries(SKILL_LABELS).map(([k, label]) => (
                <option key={k} value={k}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <button class="btn primary small" onClick={() => void createNewThread(skill, skill !== "onboard")}>
            + 新建对话
          </button>
          <div class="stack" style={{ maxHeight: "420px", overflowY: "auto" }}>
            {threads.map((t) => (
              <button
                key={t.id}
                class={activeThreadId === t.id ? "btn small primary" : "btn small"}
                style={{ justifyContent: "flex-start", textAlign: "left" }}
                onClick={() => setActiveThreadId(t.id)}
              >
                {t.title}
              </button>
            ))}
          </div>
        </div>

        {/* 右侧对话窗口 */}
        <div class="card">
          <div class="row-between">
            <div class="row">
              <strong>{threads.find((t) => t.id === activeThreadId)?.title ?? "新对话"}</strong>
              <span class="tag">{SKILL_LABELS[skill] ?? skill}</span>
              {me.isTeen && <span class="tag info">青少年只读保护模式</span>}
            </div>
            {activeThreadId && (
              <button class="btn small danger" onClick={() => void deleteCurrentThread()} disabled={streaming}>
                一键清空删除对话
              </button>
            )}
          </div>

          <div class="chat-messages">
            {messages
              .filter((m) => m.role !== "tool")
              .map((m) => (
                <div class={`bubble ${m.role}`} key={m.id}>
                  {m.content?.text ?? ""}
                </div>
              ))}
            {streamingText && <div class="bubble assistant">{streamingText}</div>}
          </div>

          {/* 高危写入两阶段确认卡（展示防盲签结构化 preview） */}
          {pendingCards.map((card) => (
            <div class="confirm-card" key={card.id} data-testid="agent-confirm-card">
              <div class="row-between">
                <strong>高危写入待你确认（{card.toolName}）</strong>
                <span class="tag warn">未落库 · 需显式确认</span>
              </div>
              <div>{card.summary}</div>
              {card.preview && <pre class="code-box">{JSON.stringify(card.preview, null, 2)}</pre>}
              {card.warnings && card.warnings.length > 0 && (
                <div class="muted">
                  提醒：{card.warnings.map((w) => w.message).join("；")}
                </div>
              )}
              <div class="row">
                <button
                  class="btn primary small"
                  disabled={busyConfirm === card.id}
                  onClick={() => void handleConfirm(card.id, "confirm")}
                >
                  {busyConfirm === card.id ? "提交中..." : "确认并保存"}
                </button>
                <button
                  class="btn danger small"
                  disabled={busyConfirm === card.id}
                  onClick={() => void handleConfirm(card.id, "cancel")}
                >
                  取消
                </button>
              </div>
            </div>
          ))}

          <form class="row" onSubmit={sendMessage}>
            <input
              type="text"
              style={{ flex: 1 }}
              value={inputText}
              disabled={streaming}
              onInput={(e) => setInputText((e.target as HTMLInputElement).value)}
              placeholder={info?.configured ? "输入问题或指令，如：帮我生成本周计划单并发布 A 日课程..." : "请先配置外部模型 API Key，或使用上方网页可视表单"}
            />
            {streaming ? (
              <button type="button" class="btn danger" onClick={() => abortRef.current?.abort()}>
                停止生成
              </button>
            ) : (
              <button type="submit" class="btn primary" disabled={!inputText.trim()}>
                发送
              </button>
            )}
          </form>
        </div>
      </div>
    </div>
  );
}
