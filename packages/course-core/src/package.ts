// 课程包（v4 阶段 8c）：打包好的编排器单文件里嵌一份课程，打开就是这节课。
// 只在 Node 里用（course export、profile check、测试），不从 index.ts 导出：编排器的包里不能出现嵌入块的完整写法，
// 否则"嵌入块恰好一个"就数不准。编排器那边只用 DOM 读（querySelectorAll）。
//
// 打包时编排器（apps/sequencer/vite.config.ts）写进两样东西，各恰好一个：
//   <meta name="yangxia-package" content="format=yangxia.package/1;motions=v3.4;motionsHash=…;source=…">
//   <script type="application/json" id="yangxia-course"></script>          （空的嵌入块）
// 课程包就是把课程 JSON 写进这个嵌入块（并加 data-exported="YYYY-MM-DD"）。

export const PACKAGE_FORMAT = "yangxia.package/1";

const META = '<meta name="yangxia-package" content="';
const BLOCK_ID = 'id="yangxia-course"';
const BLOCK_OPEN = '<script type="application/json" id="yangxia-course"';
const CLOSE = "</script>";

export interface PackageInfo {
  format: string;
  /** 嵌的动图的模板版本号（没带动图是 none） */
  motions: string;
  /** 嵌的动图内容的哈希 */
  motionsHash: string;
  /** 打包时的源码哈希（scripts/sequencer-stamp.mjs） */
  source: string;
}

function count(text: string, part: string): number {
  let n = 0;
  for (let i = text.indexOf(part); i >= 0; i = text.indexOf(part, i + part.length)) n++;
  return n;
}

/** 读打包标记。不是养夏编排器（没有标记、标记不止一个、写法不对）返回 error。 */
export function packageInfo(html: string): { info: PackageInfo | null; error?: string } {
  const n = count(html, META);
  if (n !== 1) return { info: null, error: n ? "打包标记不止一个" : "没有打包标记（不是养夏编排器，或者是 8c 以前打包的）" };
  const start = html.indexOf(META) + META.length;
  const end = html.indexOf('"', start);
  if (end < 0) return { info: null, error: "打包标记写法不对" };
  const kv = Object.fromEntries(html.slice(start, end).split(";").map((p) => {
    const i = p.indexOf("=");
    return i < 0 ? [p, ""] : [p.slice(0, i), p.slice(i + 1)];
  }));
  const info = { format: kv.format ?? "", motions: kv.motions ?? "", motionsHash: kv.motionsHash ?? "", source: kv.source ?? "" };
  if (!info.format || !info.motions || !info.motionsHash || !info.source) return { info: null, error: "打包标记缺项（format、motions、motionsHash、source）" };
  return { info };
}

/** 找嵌入块：要恰好一个；返回开标签的起止和内容的起止。 */
function block(html: string): { open: number; openEnd: number; close: number; tag: string } | { error: string } {
  const n = count(html, BLOCK_ID);
  if (n !== 1) return { error: n ? "嵌入块不止一个" : "没有嵌入块（不是养夏编排器，或者是 8c 以前打包的）" };
  const open = html.indexOf(BLOCK_OPEN);
  if (open < 0) return { error: "嵌入块写法不对" };
  const openEnd = html.indexOf(">", open);
  const close = openEnd < 0 ? -1 : html.indexOf(CLOSE, openEnd);
  if (openEnd < 0 || close < 0) return { error: "嵌入块没有结束" };
  return { open, openEnd, close, tag: html.slice(open, openEnd + 1) };
}

/**
 * 把课程嵌进空的编排器。课程 JSON 里的每个 < 写成"反斜杠 u003c"六个字符，</script>、<!-- 都截不断；
 * 用下标切片拼接，不用 String.replace（避免 $&、$' 被当成替换模式）。
 */
export function packCourse(html: string, course: unknown, exportedAt: string): { html: string | null; error?: string } {
  const p = packageInfo(html);
  if (!p.info) return { html: null, error: p.error };
  if (p.info.format !== PACKAGE_FORMAT) return { html: null, error: `编排器的打包格式是「${p.info.format}」，这里只认 ${PACKAGE_FORMAT}` };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(exportedAt)) return { html: null, error: "导出日期要写成 YYYY-MM-DD" };
  const b = block(html);
  if ("error" in b) return { html: null, error: b.error };
  if (html.slice(b.openEnd + 1, b.close) !== "" || b.tag.includes("data-exported")) return { html: null, error: "这个编排器里已经嵌了课程：只从空的编排器出课程包" };
  const json = JSON.stringify(course).split("<").join("\\u003c");
  const tag = `${BLOCK_OPEN} data-exported="${exportedAt}">`;
  return { html: html.slice(0, b.open) + tag + json + html.slice(b.close) };
}

/**
 * 读出嵌的课程。empty：嵌入块是空的（普通编排器）；error：不是养夏课程包、嵌入块不止一个、
 * 内容里有生的 <（不是 packCourse 写的）、JSON 解析不了。
 */
export function unpackCourse(html: string): { course: unknown; exported: string | null; empty: boolean; error?: string } {
  const b = block(html);
  if ("error" in b) return { course: null, exported: null, empty: false, error: b.error };
  const text = html.slice(b.openEnd + 1, b.close);
  const exported = /data-exported="(\d{4}-\d{2}-\d{2})"/.exec(b.tag)?.[1] ?? null;
  if (!text.trim()) return { course: null, exported, empty: true };
  if (text.includes("<")) return { course: null, exported, empty: false, error: "嵌入块里有没转义的 <（课程包被改过）" };
  try {
    return { course: JSON.parse(text), exported, empty: false };
  } catch {
    return { course: null, exported, empty: false, error: "嵌的课程不是合格的 JSON" };
  }
}
