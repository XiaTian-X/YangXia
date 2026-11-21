// 更多：不常用的功能收在这里，一行一个，点进去是子页（左上角返回）。子页内容由 App 传进来。
import type { ComponentChildren, JSX } from "preact";
import { Back, Chevron, Download, File, Info, ListCheck, Wind } from "./icons.tsx";

export type MoreSub = "export" | "editor" | "library" | "voice" | "notices";

const ROWS: { id: MoreSub; title: string; desc: string; icon: (p: { size?: number; color?: string }) => JSX.Element; needCourse?: boolean }[] = [
  { id: "export", title: "导出视频、音频、字幕", desc: "给剪辑软件用，或者拷到别的设备上跟练", icon: Download, needCourse: true },
  { id: "editor", title: "编辑课程", desc: "改了就不再保证和成品原文一致", icon: ListCheck, needCourse: true },
  { id: "library", title: "方案库", desc: "存在这台设备上的课程和设置", icon: File },
  { id: "voice", title: "录报数声", desc: "用自己的声音报数、喊口令", icon: Wind },
  { id: "notices", title: "关于和第三方授权", desc: "声明、用到的开源软件和字体", icon: Info },
];

interface Props {
  sub: MoreSub | null;
  onSub: (s: MoreSub | null) => void;
  hasCourse: boolean;
  children?: ComponentChildren;
}

export function MoreView({ sub, onSub, hasCourse, children }: Props) {
  const row = ROWS.find((r) => r.id === sub);
  if (row) {
    return (
      <div class="page" data-more={row.id}>
        <div class="back">
          <button class="icon-btn" aria-label="返回更多" onClick={() => onSub(null)}><Back size={20} /></button>
          <h1 class="h2" style={{ fontSize: 22 }}>{row.title}</h1>
        </div>
        {children}
      </div>
    );
  }
  return (
    <div class="page" data-more="">
      <h1 class="h1" style={{ fontSize: 30 }}>更多</h1>
      <div class="list">
        {ROWS.map((r) => (
          <button key={r.id} class="list-row" data-more-row={r.id} disabled={r.needCourse && !hasCourse} onClick={() => onSub(r.id)}>
            <r.icon size={22} color="var(--accent)" />
            <span style={{ flex: 1 }}>{r.title}<small>{r.needCourse && !hasCourse ? "先在\"今天\"载入课程" : r.desc}</small></span>
            <Chevron size={18} color="var(--ink-3)" />
          </button>
        ))}
      </div>
      <p class="disclaimer"><Info size={16} color="var(--warn)" /><span>养夏跟练按养夏计划模板的课程播报。计划未经专业审核，不是医学建议，不能替代医生的判断。</span></p>
    </div>
  );
}
