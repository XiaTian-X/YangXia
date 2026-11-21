// 线条图标（内联 SVG，跟着文字颜色走）。装饰用的都 aria-hidden；只有图标的按钮由按钮自己写 aria-label。
import type { JSX } from "preact";

type P = { size?: number; color?: string; style?: JSX.CSSProperties };
const line = (d: JSX.Element, { size = 20, color = "currentColor", style }: P, sw = 2) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} stroke-width={sw} stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style={style}>{d}</svg>
);

export const Leaf = (p: P) => line(<><path d="M5 19c0-8 5-13 14-14-1 9-6 14-14 14z" /><path d="M5 19l7-7" /></>, p);
export const Gear = (p: P) => line(<><circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1" /></>, p, 1.8);
export const Dots = (p: P) => line(<><circle cx="5" cy="12" r="1.2" /><circle cx="12" cy="12" r="1.2" /><circle cx="19" cy="12" r="1.2" /></>, p, 2.4);
export const Play = ({ size = 20, color = "currentColor" }: P) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill={color} aria-hidden="true"><path d="M7 4.5v15a1 1 0 0 0 1.5.86l12.5-7.5a1 1 0 0 0 0-1.72L8.5 3.64A1 1 0 0 0 7 4.5z" /></svg>
);
export const Pause = ({ size = 20, color = "currentColor" }: P) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill={color} aria-hidden="true"><rect x="6" y="4" width="4" height="16" rx="1.5" /><rect x="14" y="4" width="4" height="16" rx="1.5" /></svg>
);
export const Prev = (p: P) => line(<><path d="M19 5L9 12l10 7z" /><path d="M5 5v14" /></>, p);
export const Next = (p: P) => line(<><path d="M5 5l10 7-10 7z" /><path d="M19 5v14" /></>, p);
export const Download = (p: P) => line(<><path d="M12 3v12" /><path d="M7 10l5 5 5-5" /><path d="M5 21h14" /></>, p);
export const Share = (p: P) => line(<><path d="M12 15V3" /><path d="M7 8l5-5 5 5" /><path d="M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6" /></>, p);
export const Clock = (p: P) => line(<><circle cx="12" cy="13" r="8" /><path d="M12 9v4l2.5 2" /><path d="M10 2h4" /></>, p);
export const Info = (p: P) => line(<><circle cx="12" cy="12" r="9" /><path d="M12 8v5" /><path d="M12 16.5v.01" /></>, p);
export const Lock = (p: P) => line(<><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></>, p);
export const Check = (p: P) => line(<path d="M5 12l5 5 9-10" />, p, 2.6);
export const Cross = (p: P) => line(<><path d="M6 6l12 12" /><path d="M18 6L6 18" /></>, p, 2.5);
export const Bolt = (p: P) => line(<path d="M13 2L4 14h7l-1 8 9-12h-7z" />, p);
export const Wind = (p: P) => line(<><path d="M3 8h11a3 3 0 1 0-3-3" /><path d="M3 12h16a3 3 0 1 1-3 3" /><path d="M3 16h7" /></>, p);
export const ListCheck = (p: P) => line(<><path d="M9 6h11M9 12h11M9 18h11" /><path d="M4 6l1 1 2-2M4 12l1 1 2-2M4 18l1 1 2-2" /></>, p);
export const Chevron = (p: P) => line(<path d="M9 6l6 6-6 6" />, p);
export const Back = (p: P) => line(<path d="M15 6l-6 6 6 6" />, p);
export const Expand = (p: P) => line(<><path d="M4 9V4h5" /><path d="M20 9V4h-5" /><path d="M4 15v5h5" /><path d="M20 15v5h-5" /></>, p);
export const Warn = (p: P) => line(<><path d="M12 3l9 16H3z" /><path d="M12 10v4" /><path d="M12 17v.01" /></>, p);
export const File = (p: P) => line(<><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5" /></>, p);
