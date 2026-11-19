// 内置语音词库：按音色和节拍合成每个词元，再按 @yangxia/course-core 的读法拼成一句话。
// 拼接方式照原版 rebuildSynthVoiceBank / buildVoicePhraseWaveform 移植。
// 自己录的报数声按句存（"准备下一组""休息 60 秒"、数字），一句话要么整句用录音，要么整句用合成音，不混用。
import { numberTokens, TOKEN_SYLLABLES, voiceTokens } from "@yangxia/course-core";
import { SAMPLE_RATE, SYLLABLES, crossfadeConcatFloat32, synthesizeSyllableLF } from "./voice-synth.ts";

export type Timbre = "female" | "male" | "warm";
export const TIMBRE_F0: Record<Timbre, number> = { female: 235, male: 132, warm: 210 };
const TOKEN_OVERLAP: Record<string, number> = { 开始: 0.018, 休息: 0.018, 准备: 0.018 };

export class VoiceBank {
  private readonly synth = new Map<string, Float32Array>();
  private readonly phrases = new Map<string, Float32Array | null>();
  private readonly owned = new Map<string, Float32Array | null>();
  /** 自己录的报数声：键是要说的那句话（"准备下一组""休息 60 秒""12"），优先于合成音。 */
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

  /** 合成音的一个词元。 */
  token(key: string): Float32Array {
    return this.synth.get(key) ?? this.synth.get("1")!;
  }

  /**
   * 用自己的录音说这句话：整句录过；或者能全部用录过的部分拼出来（没单独录的数用录过的 1–10 拼，
   * "12，本组完成"用"12"和"本组完成"拼）。拼不全返回 null，这句整句用合成音。
   */
  own(text: string): Float32Array | null {
    if (!this.owned.has(text)) {
      let wave = this.custom.get(text) ?? null;
      const m = text.match(/^(\d+)，(本组完成|全部完成)$/);
      if (!wave && m) {
        const n = this.ownNumber(Number(m[1]));
        const w = this.custom.get(m[2]);
        wave = n && w ? crossfadeConcatFloat32([n, w], 0.012) : null;
      } else if (!wave && /^\d+$/.test(text)) wave = this.ownNumber(Number(text));
      this.owned.set(text, wave);
    }
    return this.owned.get(text)!;
  }

  private ownNumber(n: number): Float32Array | null {
    const whole = this.custom.get(String(n));
    if (whole) return whole;
    const waves = (numberTokens(n) ?? []).map((k) => this.custom.get(k === "10_short" ? "10" : k));
    return waves.length && waves.every((w) => w) ? crossfadeConcatFloat32(waves as Float32Array[], 0.012) : null;
  }

  /** 一句话的波形：自己录的优先，否则用合成音；说不出来返回 null。 */
  phrase(text: string): Float32Array | null {
    if (!this.phrases.has(text)) {
      const mine = this.own(text);
      const tokens = mine ? null : voiceTokens(text);
      this.phrases.set(text, mine ?? (tokens ? crossfadeConcatFloat32(tokens.map((k) => this.token(k)), 0.012) : null));
    }
    return this.phrases.get(text)!;
  }

  /** 一句话有多长（秒），给时间轴算总时长、给背景音乐算压低时间。 */
  seconds = (text: string): number => (this.phrase(text)?.length ?? 0) / SAMPLE_RATE;

  /** 录了新的报数声后要清掉已拼好的句子。 */
  clearPhraseCache(): void {
    this.phrases.clear();
    this.owned.clear();
  }
}
