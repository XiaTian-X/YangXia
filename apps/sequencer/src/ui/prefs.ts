// 本机偏好：只记用户在这台设备上动过的设置项（不是整份设置），换课程、刷新页面不丢。
// 存在这个浏览器里，不上传；读写失败（无痕模式、存储被禁）照常能用，只是不记。
import { normalizeSettings, type PlaybackSettings } from "@yangxia/course-core";

const KEY = "yangxia.sequencer.prefs.v1";

export function loadPrefs(): Partial<PlaybackSettings> {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "{}") as unknown;
    return typeof raw === "object" && raw !== null && !Array.isArray(raw) ? normalizeSettings(raw as Partial<PlaybackSettings>) : {};
  } catch {
    return {};
  }
}

/** 记下这次和上一份设置不同的项。 */
export function savePrefs(before: PlaybackSettings, after: PlaybackSettings): void {
  const changed = (Object.keys(after) as (keyof PlaybackSettings)[]).filter((k) => after[k] !== before[k]);
  if (!changed.length) return;
  try {
    const cur = loadPrefs() as Record<string, unknown>;
    for (const k of changed) cur[k] = after[k];
    localStorage.setItem(KEY, JSON.stringify(cur));
  } catch {
    // 存不了就不记
  }
}
