// 内置语音词库：按音色和节拍合成每个词元，再按 @yangxia/course-core 的读法拼成一句话。
// 拼接方式照原版 rebuildSynthVoiceBank / buildVoicePhraseWaveform 移植。
import { TOKEN_SYLLABLES, voiceTokens } from "@yangxia/course-core";
import { SAMPLE_RATE, SYLLABLES, crossfadeConcatFloat32, synthesizeSyllableLF } from "./voice-synth.ts";

export type Timbre = "female" | "male" | "warm";
export const TIMBRE_F0: Record<Timbre, number> = { female: 235, male: 132, warm: 210 };
const TOKEN_OVERLAP: Record<string, number> = { 开始: 0.018, 休息: 0.018, 准备: 0.018 };

export class VoiceBank {
  private readonly synth = new Map<string, Float32Array>();
  private readonly phrases = new Map<string, Float32Array | null>();
  /** 自己录的报数声（词元 → 波形），优先于合成音。 */
  readonly custom = new Map<string, Float32Array>();

  readonly timbre: Timbre;
  readonly bpm: number;

  constructor(timbre: Timbre, bpm: number, rng: () => number = Math.random) {
    this.timbre = timbre;
    this.bpm = bpm;
    const f0 = TIMBRE_F0[timbre];
    const tempoScale = bpm > 76 ? Math.max(0.78, 76 / bpm) : 1.0;
    for (const [token, syllables] of Object.entries(TOKEN_SYLLABLES)) {
      const waves = syllables.map((s) => synthesizeSyllableLF(SYLLABLES[s], f0, tempoScale, rng));
      this.synth.set(token, waves.length === 1 ? waves[0] : crossfadeConcatFloat32(waves, TOKEN_OVERLAP[token] ?? 0.016));
    }
  }

  token(key: string): Float32Array {
    if (this.custom.has(key)) return this.custom.get(key)!;
    if (key === "10_short" && this.custom.has("10")) return this.custom.get("10")!;
    return this.synth.get(key) ?? this.synth.get("1")!;
  }

  /** 一句话的波形；说不出来返回 null。 */
  phrase(text: string): Float32Array | null {
    if (!this.phrases.has(text)) {
      const tokens = voiceTokens(text);
      this.phrases.set(text, tokens ? crossfadeConcatFloat32(tokens.map((k) => this.token(k)), 0.012) : null);
    }
    return this.phrases.get(text)!;
  }

  /** 一句话有多长（秒），给时间轴算总时长、给背景音乐算压低时间。 */
  seconds = (text: string): number => (this.phrase(text)?.length ?? 0) / SAMPLE_RATE;

  /** 录了新的报数声后要清掉已拼好的句子。 */
  clearPhraseCache(): void {
    this.phrases.clear();
  }
}
