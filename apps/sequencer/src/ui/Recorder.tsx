// 自己录报数声：给每个词元录一段（数字、开始、本组完成……），录了的优先于合成音。
// 录音只留在这个页面的内存里，不保存、不上传；关掉页面就没了。
import { TOKEN_SYLLABLES } from "@yangxia/course-core";
import { useState } from "preact/hooks";
import { decodeAndResampleTo44100, trimAndValidateMicRecording } from "../audio/sounds.ts";
import type { VoiceBank } from "../audio/voice-bank.ts";
import { SAMPLE_RATE } from "../audio/voice-synth.ts";

const TOKENS = Object.keys(TOKEN_SYLLABLES).filter((t) => t !== "10_short");

export function Recorder({ bank, onChanged }: { bank: VoiceBank; onChanged: () => void }) {
  const [recording, setRecording] = useState<string | null>(null);
  const [msg, setMsg] = useState("");
  const [, force] = useState(0);

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

  const record = async (token: string) => {
    setMsg("");
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      setMsg("没拿到麦克风权限。");
      return;
    }
    const rec = new MediaRecorder(stream);
    const chunks: Blob[] = [];
    rec.ondataavailable = (e) => chunks.push(e.data);
    rec.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());
      setRecording(null);
      try {
        const audio = await decodeAndResampleTo44100(await new Blob(chunks).arrayBuffer());
        const wave = trimAndValidateMicRecording(audio.getChannelData(0), SAMPLE_RATE);
        if (!wave) {
          setMsg("没录到清楚的声音，靠近麦克风再试一次。");
          return;
        }
        bank.custom.set(token, wave);
        bank.clearPhraseCache();
        onChanged();
        force((n) => n + 1);
      } catch {
        setMsg("录音解码失败，请再试一次。");
      }
    };
    setRecording(token);
    rec.start();
    setTimeout(() => rec.state === "recording" && rec.stop(), 1600);
  };

  return (
    <div>
      <p class="note">每个词点"录"后说一遍（1.6 秒），录了的优先用你的声音。录音只留在这个页面里，不保存、不上传。</p>
      {msg && <div class="issue warning">{msg}</div>}
      <div class="tokens">
        {TOKENS.map((t) => {
          const custom = bank.custom.get(t);
          return (
            <div class={`token ${custom ? "custom" : ""}`} key={t}>
              <b>{t}</b>
              <div class="row">
                <button class="btn small" disabled={!!recording} onClick={() => void record(t)}>{recording === t ? "录音中…" : "录"}</button>
                <button class="btn small" onClick={() => play(bank.token(t))}>听</button>
                {custom && <button class="btn small danger" onClick={() => { bank.custom.delete(t); bank.clearPhraseCache(); onChanged(); force((n) => n + 1); }}>删</button>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
