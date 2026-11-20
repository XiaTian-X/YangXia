// 声音和画面设置。选项和默认值沿用原版编排器（名字换成了描述性的说法）。
import type { PlaybackSettings } from "@yangxia/course-core";
import { useEffect, useState } from "preact/hooks";
import { chineseVoices, ttsAvailable } from "../audio/tts.ts";

interface Props {
  settings: PlaybackSettings;
  onChange: (s: PlaybackSettings) => void;
  ttsVoice: string | null;
  onTtsVoice: (uri: string | null) => void;
  musicName: string | null;
  onMusicFile: (f: File | null) => void;
  section: "sound" | "screen";
  /** 这节课呼吸提示的下限：领完以后至少响提示音（65 岁以上，或者课程写了） */
  floor?: boolean;
  /** 课程带了档案里的播放偏好 */
  fromProfile?: boolean;
}

type K = keyof PlaybackSettings;

export function Settings({ settings: s, onChange, ttsVoice, onTtsVoice, musicName, onMusicFile, section, floor, fromProfile }: Props) {
  const set = <T extends K>(k: T, v: PlaybackSettings[T]) => onChange({ ...s, [k]: v });
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  useEffect(() => {
    if (!ttsAvailable()) return;
    const load = () => setVoices(chineseVoices());
    load();
    window.speechSynthesis.addEventListener("voiceschanged", load);
    return () => window.speechSynthesis.removeEventListener("voiceschanged", load);
  }, []);

  const select = (k: K, label: string, options: [string, string][]) => (
    <label class="field"><span>{label}</span>
      <select value={String(s[k])} onChange={(e) => set(k, e.currentTarget.value as never)} data-setting={k}>
        {options.map(([v, t]) => <option key={v} value={v}>{t}</option>)}
      </select>
    </label>
  );
  const range = (k: K, label: string, min: number, max: number, step: number, unit = "%") => (
    <label class="field"><span>{label}<b>{String(s[k])}{unit}</b></span>
      <input type="range" min={min} max={max} step={step} value={Number(s[k])} onInput={(e) => set(k, Number(e.currentTarget.value) as never)} />
    </label>
  );
  const check = (k: K, label: string) => (
    <label class="check"><input type="checkbox" checked={Boolean(s[k])} onChange={(e) => set(k, e.currentTarget.checked as never)} />{label}</label>
  );

  if (section === "screen") {
    return (
      <div>
        {select("background", "画面背景", [["dark", "深色（直接看）"], ["green", "绿幕（剪辑时抠像）"], ["magenta", "品红幕（剪辑时抠像，保护绿色元素）"], ["black", "纯黑"]])}
        {select("layout", "布局", [["overlay", "左下角卡片（叠在视频上）"], ["center", "居中大字"]])}
        <label class="check"><input type="checkbox" data-setting="motionFigure" checked={s.motionFigure !== false} onChange={(e) => set("motionFigure", e.currentTarget.checked)} />显示动作示意（跟练和导出的视频都带）</label>
        <p class="note">导出视频默认用当前背景；深色背景导出时自动换成品红幕，方便在剪辑软件里抠像。动作示意里有绿色时，绿幕抠像可能受影响，用品红幕更稳；卡片是不透明的，会盖住它后面的画面，不想要就关掉。</p>
      </div>
    );
  }
  return (
    <div>
      {select("sound", "打点音色", [["woodblock", "木鱼 + 水晶铃"], ["marimba", "马林巴 + 钟琴"], ["perc", "木质边击 + 三角铁"]])}
      {check("preCountdown", "开头 3、2、1 倒数")}
      {check("lastThreeBoost", "最后三次加强提示")}
      <label class="field"><span>每组领几次"呼、吸"</span>
        <select value={String(s.breathLead)} data-setting="breathLead"
          onChange={(e) => set("breathLead", e.currentTarget.value === "all" ? "all" : Number(e.currentTarget.value))}>
          {[["0", "不领"], ["1", "1 次"], ["2", "2 次"], ["3", "3 次"], ["5", "5 次"], ["all", "全程（适合新手）"]].map(([v, t]) => <option key={v} value={v}>{t}</option>)}
        </select>
      </label>
      <label class="field"><span>领完以后</span>
        <select value={s.breathAfter} data-setting="breathAfter" onChange={(e) => set("breathAfter", e.currentTarget.value as PlaybackSettings["breathAfter"])}>
          <option value="pluck">在换气的时候响提示音</option>
          <option value="quiet" disabled={floor && s.breathLead !== "all"}>安静</option>
        </select>
      </label>
      {floor && <p class="note" data-floor>这节课至少保留换气提示音：用力时容易不自觉憋气，提示音帮你记得换气。</p>}
      {range("breathVolume", "呼吸提示音量", 15, 100, 5)}
      {select("countTiming", "报数时机", [["on-up", "每次开始时报数"], ["on-rep", "每次做完时报数"]])}
      {fromProfile && <p class="note" data-from-profile>这节课按你档案里的设置播报；在这里改的只对这台设备上没写进课程的项长期有效。</p>}
      {select("voiceTimbre", "内置语音音色", [["female", "清亮女声"], ["male", "沉稳男声"], ["warm", "柔和女声"]])}
      {select("voiceEngine", "跟练时的语音", [["tts", "系统语音（更自然；导出时仍用内置语音）"], ["embedded", "只用内置语音"]])}
      {s.voiceEngine === "tts" && ttsAvailable() && (
        <label class="field"><span>系统发音人</span>
          <select value={ttsVoice ?? "auto"} onChange={(e) => onTtsVoice(e.currentTarget.value === "auto" ? null : e.currentTarget.value)}>
            <option value="auto">自动挑选中文发音人</option>
            {voices.map((v) => <option key={v.voiceURI || v.name} value={v.voiceURI || v.name}>{v.name}（{v.lang}）</option>)}
          </select>
        </label>
      )}
      {check("voiceBake", "语音报数（关掉就只有打点）")}
      {range("voiceVolume", "语音音量", 20, 100, 2)}
      {range("bpm", "背景鼓点速度", 40, 110, 2, " BPM")}
      {select("music", "背景音乐", [["groove", "干爽鼓点"], ["beat", "极简稳拍"], ["file", "导入的音乐"], ["none", "关闭"]])}
      {s.music === "file" && (
        <div class="row" style={{ marginBottom: 10 }}>
          <label class="btn small">选择 MP3 / WAV
            <input type="file" accept="audio/*" style={{ display: "none" }} onChange={(e) => onMusicFile(e.currentTarget.files?.[0] ?? null)} />
          </label>
          <span class="note">{musicName ?? "还没导入，先用干爽鼓点"}</span>
          {musicName && <button class="btn small" onClick={() => onMusicFile(null)}>清除</button>}
        </div>
      )}
      {range("musicVolume", "背景音乐音量", 10, 85, 2)}
      {range("duckDepth", "说话、打点时背景音乐压低", 0, 92, 2)}
      {check("duckSubBeats", "下放、停顿的拍子也压低")}
    </div>
  );
}
