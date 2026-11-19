// 自己录报数声：按句录（"准备下一组""休息 60 秒"），数字一个数录一段。录了的优先于合成音，跟练和导出都用；
// 一句话要么整句用录音，要么整句用内置语音，不混用（见 audio/voice-bank.ts）。
// 录音只留在这个页面的内存里，不保存、不上传；关掉页面就没了。
import { recordUnits } from "@yangxia/course-core";
import { useMemo, useRef, useState } from "preact/hooks";
import { decodeAndResampleTo44100, trimAndValidateMicRecording } from "../audio/sounds.ts";
import type { VoiceBank } from "../audio/voice-bank.ts";
import { SAMPLE_RATE } from "../audio/voice-synth.ts";

/** 一段最长录几毫秒：最长的一句"休息 120 秒"慢慢说也够。 */
const MAX_MS = 4000;

export function Recorder({ bank, phrases, onChanged }: { bank: VoiceBank; phrases: (string | null)[]; onChanged: () => void }) {
  const [recording, setRecording] = useState<string | null>(null);
  const [msg, setMsg] = useState("");
  const [, force] = useState(0);
  const rec = useRef<MediaRecorder | null>(null);
  const units = useMemo(() => recordUnits(phrases), [phrases]);
  const fromCourse = phrases.some((p) => p);

  const play = (wave: Float32Array) => {
    const ctx = new AudioContext();
    const buf = ctx.createBuffer(1, wave.length, SAMPLE_RATE);
    buf.getChannelData(0).set(wave);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    src.onended = () => void ctx.close();
    src.start();
  };

  const changed = () => {
    bank.clearPhraseCache();
    onChanged();
    force((n) => n + 1);
  };

  const stop = () => {
    if (rec.current?.state === "recording") rec.current.stop();
  };

  const record = async (key: string) => {
    setMsg("");
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      setMsg("没拿到麦克风权限。");
      return;
    }
    const r = new MediaRecorder(stream);
    const chunks: Blob[] = [];
    const timer = setTimeout(stop, MAX_MS);
    r.ondataavailable = (e) => chunks.push(e.data);
    r.onstop = async () => {
      clearTimeout(timer);
      stream.getTracks().forEach((t) => t.stop());
      rec.current = null;
      setRecording(null);
      try {
        const audio = await decodeAndResampleTo44100(await new Blob(chunks).arrayBuffer());
        const wave = trimAndValidateMicRecording(audio.getChannelData(0), SAMPLE_RATE);
        if (!wave) {
          setMsg("没录到清楚的声音，靠近麦克风再试一次。");
          return;
        }
        bank.custom.set(key, wave);
        changed();
      } catch {
        setMsg("录音解码失败，请再试一次。");
      }
    };
    rec.current = r;
    setRecording(key);
    r.start();
  };

  const card = (t: string) => {
    const mine = bank.custom.get(t);
    const pieced = !mine && !!bank.own(t);
    return (
      <div class={`token ${mine || pieced ? "custom" : ""}`} key={t} data-phrase={t}>
        <b>{t}</b>
        {pieced && <span class="note">用你录的数字拼</span>}
        <div class="row">
          {recording === t
            ? <button class="btn small primary" onClick={stop}>停</button>
            : <button class="btn small" disabled={!!recording} onClick={() => void record(t)}>录</button>}
          <button class="btn small" disabled={!!recording} onClick={() => { const w = bank.phrase(t); if (w) play(w); }}>听</button>
          {mine && <button class="btn small danger" disabled={!!recording} onClick={() => { bank.custom.delete(t); changed(); }}>删</button>}
        </div>
      </div>
    );
  };

  return (
    <div>
      <p class="note">
        按句录：点"录"，把整句说一遍，说完点"停"（最长 4 秒，前后的空白自动去掉）。录了的句子跟练和导出都用你的声音；
        没录的跟练时用系统语音（选了的话），导出时用内置语音。一句话不会一半是你的声音、一半是合成音。
        录音只留在这个页面里，不保存、不上传。
      </p>
      <p class="note">{fromCourse ? "下面是这节课要说的话。" : "还没载入课程，先列出数字和常用口令；载入课程后列这节课要说的话。"}</p>
      {msg && <div class="issue warning">{msg}</div>}
      <h4>口令</h4>
      <div class="tokens">{units.words.map(card)}</div>
      <h4>数字</h4>
      <p class="note">一个数录一段；没单独录的数，会用你录的 1–10 拼出来（比如"十二"用"十"和"二"）。</p>
      <div class="tokens">{units.numbers.map(card)}</div>
      {units.counted.length > 0 && (
        <>
          <h4>带数字的话</h4>
          <div class="tokens">{units.counted.map(card)}</div>
        </>
      )}
    </div>
  );
}
