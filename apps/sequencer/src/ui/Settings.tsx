// 设置：按设计稿分组。呼吸提示、报数各配一张小图，直接画出"一组里哪几次说口令""每次在哪一拍报数"。
// 选项和默认值见 course-core 的 settings.ts；改了的项记在本机（App 里的 savePrefs），不低于这节课的下限。
import type { PlaybackSettings } from "@yangxia/course-core";
import type { JSX } from "preact";
import { useEffect, useState } from "preact/hooks";
import { chineseVoices, ttsAvailable, ttsChinese } from "../audio/tts.ts";
import { Lock } from "./icons.tsx";

interface Props {
  settings: PlaybackSettings;
  onChange: (s: PlaybackSettings) => void;
  ttsVoice: string | null;
  onTtsVoice: (uri: string | null) => void;
  musicName: string | null;
  onMusicFile: (f: File | null) => void;
  /** 这节课呼吸提示的下限：领完以后至少响提示音（65 岁以上，或者课程写了） */
  floor?: boolean;
  /** 课程带了档案里的播放偏好 */
  fromProfile?: boolean;
}

type K = keyof PlaybackSettings;

/** "每组领几次"的选项；课程或档案写了别的次数（比如 4 次）也列出来。 */
function leadOptions(cur: PlaybackSettings["breathLead"]): [string, string][] {
  const base: [string, string][] = [["0", "不领"], ["1", "1"], ["2", "2"], ["3", "3"], ["all", "全程"]];
  return base.some(([v]) => v === String(cur)) ? base : [...base.slice(0, -1), [String(cur), String(cur)], base[base.length - 1]];
}

export function Settings({ settings: s, onChange, ttsVoice, onTtsVoice, musicName, onMusicFile, floor, fromProfile }: Props) {
  const set = <T extends K>(k: T, v: PlaybackSettings[T]) => onChange({ ...s, [k]: v });
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [zh, setZh] = useState(ttsChinese);
  useEffect(() => {
    if (!ttsAvailable()) return;
    const load = () => { setVoices(chineseVoices()); setZh(ttsChinese()); };
    load();
    window.speechSynthesis.addEventListener("voiceschanged", load);
    return () => window.speechSynthesis.removeEventListener("voiceschanged", load);
  }, []);

  /** 分段按钮：外层写设置项名，每个按钮写取值，aria-pressed 表示选中。 */
  const seg = <T extends K>(k: T, options: [string, string, boolean?][], parse: (v: string) => PlaybackSettings[T], label: string) => (
    <div class="seg" role="group" aria-label={label} data-setting={k}>
      {options.map(([v, t, disabled]) => (
        <button key={v} type="button" data-value={v} aria-pressed={String(s[k]) === v} disabled={disabled} onClick={() => set(k, parse(v))}>
          {disabled && <Lock size={14} />}{t}
        </button>
      ))}
    </div>
  );
  const str = (v: string) => v as never;
  const range = (k: K, label: string, min: number, max: number, step: number, unit = "%") => (
    <label class="field"><span>{label}<b class="num">{String(s[k])}{unit}</b></span>
      <input type="range" min={min} max={max} step={step} value={Number(s[k])} data-setting={k} onInput={(e) => set(k, Number(e.currentTarget.value) as never)} />
    </label>
  );
  const check = (k: K, label: string, extra: JSX.HTMLAttributes<HTMLInputElement> = {}) => (
    <label class="check">{label}<input type="checkbox" data-setting={k} checked={k === "motionFigure" ? s[k] !== false : Boolean(s[k])} onChange={(e) => set(k, e.currentTarget.checked as never)} {...extra} /></label>
  );

  // 一组 15 次里哪几次说口令：领的那几次说，之后按"领完以后"响提示音或安静
  const lead = s.breathLead === "all" ? 15 : s.breathLead;
  const quietLocked = floor && s.breathLead !== "all";
  const bars = Array.from({ length: 15 }, (_, i) => (i < lead && s.voiceBake ? "voice" : s.breathAfter === "pluck" || i < lead ? "pluck" : "quiet"));

  return (
    <div class="groups">
      {fromProfile && <p class="issue warning" style={{ gridColumn: "1 / -1", background: "var(--accent-soft)", color: "#2D3B33" }} data-from-profile>这节课按你档案里的设置播报；在这里改的，记在这台设备上。</p>}

      <section class="card group" aria-labelledby="g-breath">
        <h2 class="h2" id="g-breath">呼吸提示</h2>
        <div class="sub-label">每组领几次"呼、吸"</div>
        {seg("breathLead", leadOptions(s.breathLead).map(([v, t]) => [v, t, floor && !s.voiceBake] as [string, string, boolean]), (v) => (v === "all" ? "all" : Number(v)) as never, "每组领几次")}
        <div class="sub-label">领完以后</div>
        {seg("breathAfter", [["pluck", "换气时响提示音"], ["quiet", "安静", quietLocked]], str, "领完以后")}
        <div class="viz">
          <div class="note">一组 15 次，会这样提示</div>
          <div class="reps-viz" aria-label={`前 ${Math.min(lead, 15)} 次说口令，之后${s.breathAfter === "pluck" ? "响提示音" : "安静"}`}>
            {bars.map((b, i) => <span key={i} class={b} />)}
          </div>
          <div class="legend">
            <span><i style={{ background: "var(--accent)", height: 14 }} />说"呼、吸"</span>
            <span><i style={{ background: "#B5AE9F", height: 6 }} />换气提示音</span>
            <span><i style={{ background: "var(--line)", height: 4 }} />安静</span>
          </div>
        </div>
        {floor && (
          <p class="floor-note" data-floor><Lock size={16} /><span>这节课至少保留换气提示音：用力时容易不自觉憋气，提示音帮你记得换气。{!s.voiceBake && "关掉语音报数时，每个换气的拍都响提示音。"}</span></p>
        )}
        {range("breathVolume", "提示音音量", 15, 100, 5)}
      </section>

      <section class="card group" aria-labelledby="g-count">
        <h2 class="h2" id="g-count">报数</h2>
        {seg("countTiming", [["on-up", "每次开始时"], ["on-rep", "每次做完时"]], str, "什么时候报数")}
        <div class="viz">
          <div class="timing-viz" aria-hidden="true">
            <div style={{ flex: 2, background: "var(--inhale-soft)", color: "var(--inhale-ink)", borderRadius: "8px 4px 4px 8px" }}>下放 2 秒 · 吸</div>
            <div style={{ flex: 1, background: "var(--exhale-soft)", color: "var(--exhale-ink)", borderRadius: "4px 8px 8px 4px" }}>起 1 秒 · 呼</div>
          </div>
          <div class="note" style={{ color: "var(--ink)" }}>
            {s.countTiming === "on-up" ? "一开始就报\"三，吸\"：这是第 3 次，跟着往下放" : "站起来时报\"三，呼\"：第 3 次快做完了"}
          </div>
        </div>
        {check("preCountdown", "开头 3、2、1 倒数")}
        {check("lastThreeBoost", "最后三次加强提示")}
      </section>

      <section class="card group" aria-labelledby="g-voice">
        <h2 class="h2" id="g-voice">语音</h2>
        {seg("voiceEngine", [["tts", "系统语音"], ["embedded", "内置语音"]], str, "跟练时的语音")}
        {s.voiceEngine === "tts" && zh === "no" && (
          <p class="floor-note" data-no-zh-voice><Lock size={16} /><span>{ttsAvailable() ? "这台设备的系统语音没有中文发音人" : "这个浏览器没有系统语音"}，跟练改用内置语音。</span></p>
        )}
        {s.voiceEngine === "tts" && zh !== "no" && (
          <label class="field"><span>系统发音人</span>
            <select value={ttsVoice ?? "auto"} onChange={(e) => onTtsVoice(e.currentTarget.value === "auto" ? null : e.currentTarget.value)}>
              <option value="auto">自动挑选中文发音人</option>
              {voices.map((v) => <option key={v.voiceURI || v.name} value={v.voiceURI || v.name}>{v.name}（{v.lang}）</option>)}
            </select>
          </label>
        )}
        <div class="sub-label">内置语音音色</div>
        {seg("voiceTimbre", [["female", "清亮女声"], ["male", "沉稳男声"], ["warm", "柔和女声"]], str, "内置语音音色")}
        {check("voiceBake", "语音报数（关掉就只有打点）")}
        {range("voiceVolume", "语音音量", 20, 100, 2)}
        <p class="note" style={{ margin: 0 }}>导出的音频和视频用内置语音；这台设备没有中文系统语音时，跟练也用内置语音。</p>
      </section>

      <section class="card group" aria-labelledby="g-video">
        <h2 class="h2" id="g-video">视频导出</h2>
        <div class="sub-label">背景</div>
        {seg("background", [["magenta", "品红幕"], ["green", "绿幕"], ["dark", "深色"], ["black", "纯黑"]], str, "画面背景")}
        <div class="sub-label">布局</div>
        {seg("layout", [["overlay", "左下角卡片"], ["center", "居中大字"]], str, "布局")}
        {check("motionFigure", "显示动作示意")}
        <p class="note" style={{ margin: 0 }}>深色背景导出时自动换成品红幕，方便在剪辑软件里抠像；动作示意里有绿色时，用品红幕更稳。</p>
      </section>

      <section class="card group" aria-labelledby="g-sound" style={{ gridColumn: "1 / -1" }}>
        <h2 class="h2" id="g-sound">声音和音乐</h2>
        <div class="sub-label">打点音色</div>
        {seg("sound", [["woodblock", "木鱼"], ["marimba", "马林巴"], ["perc", "木质边击"]], str, "打点音色")}
        <label class="field"><span>背景音乐</span>
          <select value={s.music} data-setting="music" onChange={(e) => set("music", e.currentTarget.value as PlaybackSettings["music"])}>
            <option value="groove">干爽鼓点</option><option value="beat">极简稳拍</option><option value="file">导入的音乐</option><option value="none">关闭</option>
          </select>
        </label>
        {s.music === "file" && (
          <div class="row">
            <label class="btn small">选择 MP3 / WAV
              <input type="file" accept="audio/*" style={{ display: "none" }} onChange={(e) => onMusicFile(e.currentTarget.files?.[0] ?? null)} />
            </label>
            <span class="note">{musicName ?? "还没导入，先用干爽鼓点"}</span>
            {musicName && <button class="btn small" onClick={() => onMusicFile(null)}>清除</button>}
          </div>
        )}
        {range("bpm", "背景鼓点速度", 40, 110, 2, " BPM")}
        {range("musicVolume", "背景音乐音量", 10, 85, 2)}
        {range("duckDepth", "说话、打点时背景音乐压低", 0, 92, 2)}
        {check("duckSubBeats", "下放、停顿的拍子也压低")}
      </section>
    </div>
  );
}
