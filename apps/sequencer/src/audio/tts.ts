// 系统语音（只在实时播放时用；导出的音频、视频一律用内置语音，因为系统语音录不进去）。
// 选发音人、语速、音高、"先取消再延迟 12ms 播"的写法照原版 speakSystemNativeTTS 移植。
import type { PlaybackSettings } from "@yangxia/course-core";

const PREFERRED = /natural|neural|xiaoxiao|yunxi|tingting|ting-ting|siri|premium|enhanced/i;
const pool: SpeechSynthesisUtterance[] = [];
let pending: ReturnType<typeof setTimeout> | null = null;

export function ttsAvailable(): boolean {
  return typeof window !== "undefined" && "speechSynthesis" in window && typeof window.SpeechSynthesisUtterance === "function";
}

/** 能念中文的发音人；一个都没有就是空的（不拿别的语言的发音人念中文）。 */
export function chineseVoices(): SpeechSynthesisVoice[] {
  if (!ttsAvailable()) return [];
  return window.speechSynthesis.getVoices().filter((v) => /zh|cmn|chinese/i.test(v.lang) || /zh|chinese|晓|云|婷|美佳|善怡|普通话|国语|粤语/i.test(v.name));
}

/**
 * 系统语音能不能念中文：yes 有中文发音人；unknown 发音人列表是空的（安卓 Edge 上常见，默认发音人一般能念中文，
 * 照 zh-CN 念）；no 只有别的语言的发音人——这时跟练改用内置语音。
 */
export function ttsChinese(): "yes" | "unknown" | "no" {
  if (!ttsAvailable()) return "no";
  const all = window.speechSynthesis.getVoices();
  return chineseVoices().length ? "yes" : all.length ? "no" : "unknown";
}

/** 在点按钮的那一刻念一句听不见的话：有的浏览器（iPhone）只在用户操作里放行系统语音。 */
export function unlockTts(): void {
  if (!ttsAvailable()) return;
  try {
    const u = new SpeechSynthesisUtterance(" ");
    u.volume = 0;
    u.lang = "zh-CN";
    window.speechSynthesis.speak(u);
  } catch {
    /* 忽略 */
  }
}

export function pickVoice(uri: string | null): SpeechSynthesisVoice | null {
  const list = chineseVoices();
  if (uri) {
    const hit = list.find((v) => (v.voiceURI || v.name) === uri);
    if (hit) return hit;
  }
  return list.find((v) => PREFERRED.test(v.name)) ?? list[0] ?? null;
}

export function speak(text: string, opts: { rate: number; volScale: number; settings: PlaybackSettings; voice: SpeechSynthesisVoice | null }): void {
  if (!ttsAvailable() || !text) return;
  const synth = window.speechSynthesis;
  if (pending) {
    clearTimeout(pending);
    pending = null;
  }
  if (synth.paused) synth.resume();
  const u = new SpeechSynthesisUtterance(text);
  pool.push(u);
  u.lang = opts.voice?.lang || "zh-CN";
  if (opts.voice) u.voice = opts.voice;
  u.rate = Math.min(1.75, Math.max(1.08, opts.rate * (text.length >= 4 ? 1.12 : 1.05)));
  u.pitch = opts.settings.voiceTimbre === "male" ? 0.85 : opts.settings.voiceTimbre === "warm" ? 0.98 : 1.06;
  u.volume = Math.min(1, Math.max(0.05, (opts.settings.voiceVolume / 100) * opts.volScale));
  const cleanup = () => {
    const i = pool.indexOf(u);
    if (i !== -1) pool.splice(i, 1);
  };
  u.onend = cleanup;
  u.onerror = cleanup;
  // 上一句还在说时先取消、延迟 12ms 再说，避免 Chromium 同步 cancel + speak 吞字
  if (synth.speaking || synth.pending) {
    try {
      synth.cancel();
    } catch {
      /* 忽略 */
    }
    pending = setTimeout(() => {
      pending = null;
      synth.speak(u);
    }, 12);
  } else {
    synth.speak(u);
  }
}

export function stopSpeaking(): void {
  if (pending) {
    clearTimeout(pending);
    pending = null;
  }
  if (ttsAvailable()) {
    try {
      window.speechSynthesis.cancel();
    } catch {
      /* 忽略 */
    }
  }
  pool.length = 0;
}
