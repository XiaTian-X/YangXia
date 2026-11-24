// 课程包（v4 阶段 8c）：打包好的编排器里有一个嵌入块 <script type="application/json" id="yangxia-course">，
// course export 把课程写进去（packages/course-core/src/package.ts）。这里只用 DOM 读：选择器里不出现嵌入块的完整写法，
// 打包出来的页面里嵌入块才数得准（恰好一个）。读到的课程照样走 validateCourse。

export interface Embedded {
  /** 有没有嵌课程（普通编排器的嵌入块是空的） */
  found: boolean;
  raw?: unknown;
  /** 导出日期 YYYY-MM-DD（course export 写的 data-exported） */
  exported: string | null;
  error?: string;
}

export function embeddedCourse(root: ParentNode): Embedded {
  const blocks = root.querySelectorAll<HTMLScriptElement>("script#yangxia-course");
  if (blocks.length === 0) return { found: false, exported: null };
  if (blocks.length !== 1) return { found: true, exported: null, error: "课程包里的嵌入块不止一个（文件被改过）" };
  const b = blocks[0];
  const text = b.textContent ?? "";
  const exported = /^\d{4}-\d{2}-\d{2}$/.test(b.dataset.exported ?? "") ? b.dataset.exported! : null;
  if (!text.trim()) return { found: false, exported: null };
  try {
    return { found: true, raw: JSON.parse(text), exported };
  } catch {
    return { found: true, exported, error: "课程包里的课程不是合格的 JSON（文件被改过或者没传完整）" };
  }
}

/** "11 月 24 日" */
export const exportedLabel = (d: string) => `${Number(d.slice(5, 7))} 月 ${Number(d.slice(8, 10))} 日`;
