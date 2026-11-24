// 纯 JSX 安全 Markdown 渲染器（零 dangerouslySetInnerHTML，彻底防 XSS），
// 自动将模板相对图解路径（img/xxx.svg）安全映射至 /api/templates/img/xxx.svg。
import type { ComponentChildren } from "preact";

function resolveImgSrc(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;
  if (/^(https?:|javascript:|data:)/i.test(s)) return null;
  const clean = s.replace(/^\.?\//, "").replace(/^img\//, "");
  if (!clean || clean.includes("..") || clean.includes("/")) return null;
  return `/api/templates/img/${encodeURIComponent(clean)}`;
}

function renderInline(text: string): ComponentChildren[] {
  const nodes: ComponentChildren[] = [];
  const re = /!\[([^\]]*)\]\(([^)]+)\)|\[([^\]]+)\]\(([^)]+)\)|`([^`]+)`|\*\*([^*]+)\*\*/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let key = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) nodes.push(text.slice(last, m.index));
    if (m[1] !== undefined && m[2] !== undefined) {
      const src = resolveImgSrc(m[2]);
      if (src) nodes.push(<img key={key++} src={src} alt={m[1] || "动作示意"} loading="lazy" />);
    } else if (m[3] !== undefined && m[4] !== undefined) {
      const href = m[4].trim();
      if (/^https?:\/\//i.test(href)) {
        nodes.push(
          <a key={key++} href={href} target="_blank" rel="noopener noreferrer">
            {m[3]}
          </a>,
        );
      } else {
        nodes.push(m[3]);
      }
    } else if (m[5] !== undefined) {
      nodes.push(<code key={key++}>{m[5]}</code>);
    } else if (m[6] !== undefined) {
      nodes.push(<strong key={key++}>{m[6]}</strong>);
    }
    last = re.lastIndex;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

export function MarkdownView({ content }: { content: string }) {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  const blocks: ComponentChildren[] = [];
  let i = 0;
  let k = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    if (/^---+$/.test(line.trim())) {
      blocks.push(<hr key={k++} />);
      i++;
      continue;
    }
    const h = /^(#{1,3})\s+(.+)$/.exec(line);
    if (h) {
      const lvl = h[1].length;
      if (lvl === 1) blocks.push(<h1 key={k++}>{renderInline(h[2])}</h1>);
      else if (lvl === 2) blocks.push(<h2 key={k++}>{renderInline(h[2])}</h2>);
      else blocks.push(<h3 key={k++}>{renderInline(h[2])}</h3>);
      i++;
      continue;
    }
    if (line.startsWith(">")) {
      const qlines: string[] = [];
      while (i < lines.length && lines[i].startsWith(">")) {
        qlines.push(lines[i].replace(/^>\s?/, ""));
        i++;
      }
      blocks.push(<blockquote key={k++}>{renderInline(qlines.join(" "))}</blockquote>);
      continue;
    }
    if (line.includes("|") && i + 1 < lines.length && /^\s*\|?[\s:-]+\|/.test(lines[i + 1])) {
      const parseCells = (row: string) =>
        row
          .trim()
          .replace(/^\|/, "")
          .replace(/\|$/, "")
          .split("|")
          .map((c) => c.trim());
      const headers = parseCells(line);
      i += 2;
      const bodyRows: string[][] = [];
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) {
        bodyRows.push(parseCells(lines[i]));
        i++;
      }
      blocks.push(
        <div key={k++} style={{ overflowX: "auto" }}>
          <table class="tbl">
            <thead>
              <tr>
                {headers.map((c, idx) => (
                  <th key={idx}>{renderInline(c)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {bodyRows.map((row, ri) => (
                <tr key={ri}>
                  {row.map((c, ci) => (
                    <td key={ci}>{renderInline(c)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*]\s+/, ""));
        i++;
      }
      blocks.push(
        <ul key={k++}>
          {items.map((it, idx) => (
            <li key={idx}>{renderInline(it)}</li>
          ))}
        </ul>,
      );
      continue;
    }
    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+\.\s+/, ""));
        i++;
      }
      blocks.push(
        <ol key={k++}>
          {items.map((it, idx) => (
            <li key={idx}>{renderInline(it)}</li>
          ))}
        </ol>,
      );
      continue;
    }
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^(#{1,3}\s|>\s?|---+$|\s*[-*]\s+|\s*\d+\.\s+)/.test(lines[i])
    ) {
      para.push(lines[i]);
      i++;
    }
    blocks.push(<p key={k++}>{renderInline(para.join(" "))}</p>);
  }

  return <div class="md-view">{blocks}</div>;
}
