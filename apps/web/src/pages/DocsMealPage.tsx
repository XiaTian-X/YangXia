import { useEffect, useState } from "preact/hooks";
import { MarkdownView } from "../components/MarkdownView.tsx";
import { apiRequest, formatApiError } from "../lib/api.ts";
import { DECLARATION_TEXT, type ProfileSummary } from "../types.ts";

export function DocsMealPage({
  profile,
  initialDocHint,
}: {
  profile: ProfileSummary | null;
  initialDocHint?: string | null;
}) {
  const [meta, setMeta] = useState<{ version: string; docs: string[] } | null>(null);
  const [selectedDoc, setSelectedDoc] = useState<string>(initialDocHint || "");
  const [docContent, setDocContent] = useState<string>("");
  const [menus, setMenus] = useState<any[]>([]);

  const [menuTitle, setMenuTitle] = useState("第1周");
  const [menuMd, setMenuMd] = useState(
    `${DECLARATION_TEXT}\n\n# 全家一周菜单\n- 周一：杂粮饭、清蒸鱼、焯水西兰花、豆腐汤。\n- 周二：全麦面、番茄炒蛋、凉拌菠菜。`,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const m = await apiRequest<{ version: string; docs: string[] }>("/api/templates/meta");
        setMeta(m);
        const target = initialDocHint && m.docs.includes(initialDocHint) ? initialDocHint : m.docs[0] ?? "";
        if (target) setSelectedDoc(target);
      } catch (err) {
        setError(formatApiError(err));
      }
    })();
  }, [initialDocHint]);

  useEffect(() => {
    if (!selectedDoc) return;
    void (async () => {
      try {
        const d = await apiRequest<{ content: string }>(`/api/templates/docs/${encodeURIComponent(selectedDoc)}`);
        setDocContent(d.content);
      } catch (err) {
        setError(formatApiError(err));
      }
    })();
  }, [selectedDoc]);

  const loadMenus = async () => {
    if (!profile || !profile.canManage) {
      setMenus([]);
      return;
    }
    try {
      const res = await apiRequest<{ documents: any[] }>(`/api/profiles/${profile.id}/documents`);
      setMenus((res.documents ?? []).filter((d) => d.docType === "menu"));
    } catch (err) {
      setError(formatApiError(err));
    }
  };

  useEffect(() => {
    void loadMenus();
  }, [profile?.id]);

  const saveMenu = async (e: Event) => {
    e.preventDefault();
    if (!profile) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await apiRequest(`/api/profiles/${profile.id}/documents`, {
        method: "POST",
        body: { docType: "menu", title: menuTitle.trim(), contentMd: menuMd },
      });
      setNotice(`已通过免责声明与全家安全红线校验，保存菜单「${menuTitle.trim()}」`);
      await loadMenus();
    } catch (err) {
      setError(formatApiError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="stack" style={{ gap: "18px" }}>
      <div>
        <div class="eyebrow">模板原文 · 附册 · 官方食养指路 · 全家餐饮</div>
        <h1 class="h1">饮食与模板阅读</h1>
      </div>

      {error && (
        <div class="banner danger" role="alert" style={{ whiteSpace: "pre-wrap" }}>
          {error}
        </div>
      )}
      {notice && <div class="banner ok">{notice}</div>}

      {/* 全家排菜单编辑器 */}
      {profile && profile.canManage && (
        <div class="grid-2">
          <form class="card" onSubmit={saveMenu}>
            <h2 class="h2">保存全家一周菜单（{profile.code}）</h2>
            <p class="muted" style={{ margin: 0 }}>
              保存前自动检查档案已填写家庭成员年龄段（household）、开头带免责声明，并按全员年龄段拦截禁词（含儿童青少年禁谈体重/热量/减肥等）。
            </p>
            <label class="field">
              <span>菜单标题</span>
              <input type="text" required value={menuTitle} onInput={(e) => setMenuTitle((e.target as HTMLInputElement).value)} />
            </label>
            <label class="field">
              <span>菜单与采购清单正文</span>
              <textarea value={menuMd} onInput={(e) => setMenuMd((e.target as HTMLTextAreaElement).value)} required />
            </label>
            <button class="btn primary" type="submit" disabled={busy}>
              {busy ? "校验保存中..." : "校验红线并保存菜单"}
            </button>
          </form>

          <div class="card">
            <h2 class="h2">已保存的全家菜单（{menus.length}）</h2>
            {!menus.length ? (
              <p class="muted">暂无已保存菜单。可在左侧编辑，或打开「养夏助手」选用「全家排菜单」模式辅助生成。</p>
            ) : (
              <div class="stack" style={{ maxHeight: "360px", overflowY: "auto" }}>
                {menus.map((m) => (
                  <div class="card-soft" key={m.id}>
                    <div class="row-between">
                      <strong>{m.title}</strong>
                      <span class="tag">{String(m.updatedAt).slice(0, 10)}</span>
                    </div>
                    <MarkdownView content={m.contentMd} />
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* 模板成品与附册只读阅读器 */}
      <div class="card">
        <div class="row-between">
          <div>
            <h2 class="h2">计划模板原文（只读 · 版本 {meta?.version ?? "-"}）</h2>
            <div class="muted">支持阅读 6–12 岁家长版、热身/放松、超重与肥胖附册、官方食养指南与全家餐饮模板。</div>
          </div>
          <select
            style={{ maxWidth: "340px" }}
            value={selectedDoc}
            onChange={(e) => setSelectedDoc((e.target as HTMLSelectElement).value)}
          >
            {(meta?.docs ?? []).map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </div>

        <div style={{ maxHeight: "620px", overflowY: "auto", paddingRight: "6px" }}>
          {docContent ? <MarkdownView content={docContent} /> : <p class="muted">请选择文档查看。</p>}
        </div>
      </div>
    </div>
  );
}
