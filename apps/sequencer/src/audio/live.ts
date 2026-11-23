// 实时跟练播放：每 16ms 往前看一小段，把打点、换气、鼓点、压低、语音排进 AudioContext；
// 画面按事件刷新。照原版 startLivePlayback 的调度移植（去掉了实时录制：导出视频改用离线高速合成）。
import { isPrimaryCue, isSubCue, type TimelineEvent } from "@yangxia/course-core";
import { cloneBuffer, effectiveMusic, type RenderInput, scheduleEventSounds } from "./render.ts";
import { createMasterChain, scheduleSingleBeatGroove } from "./sounds.ts";
import { pickVoice, speak, stopSpeaking, ttsAvailable, ttsChinese } from "./tts.ts";

export interface LiveCallbacks {
  onEvent: (ev: TimelineEvent, index: number) => void;
  onEnd: (completed: boolean) => void;
}

export class LivePlayer {
  private ctx: AudioContext | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private startOffset = 0;
  private warp = 0;
  private audioCursor = 0;
  private uiCursor = 0;
  private ttsCursor = 0;
  private duck: GainNode | null = null;
  private kickDuck: GainNode | null = null;
  private musicTrim: GainNode | null = null;
  private readonly input: RenderInput;
  private readonly cb: LiveCallbacks;
  private readonly ttsVoiceUri: string | null;

  constructor(input: RenderInput, cb: LiveCallbacks, ttsVoiceUri: string | null = null) {
    this.input = input;
    this.cb = cb;
    this.ttsVoiceUri = ttsVoiceUri;
  }

  private pausedFlag = false;

  get running(): boolean {
    return this.ctx !== null;
  }

  /** 暂停中：声音、课程时间、动图一起停（AudioContext 挂起，时间就不走）。 */
  get paused(): boolean {
    return this.ctx !== null && this.pausedFlag;
  }

  async pause(): Promise<void> {
    if (!this.ctx || this.pausedFlag) return;
    this.pausedFlag = true;
    // 安卓上系统语音的 pause 不可靠：直接取消，继续时不补念
    stopSpeaking();
    await this.ctx.suspend().catch(() => undefined);
  }

  async resume(): Promise<void> {
    if (!this.ctx || !this.pausedFlag) return;
    await this.ctx.resume().catch(() => undefined);
    this.pausedFlag = false;
  }

  /** 从开始到现在过了多少秒（课程时间）。 */
  elapsed(): number {
    return this.ctx ? this.ctx.currentTime - this.startOffset + this.warp : 0;
  }

  async start(): Promise<void> {
    const { settings, timeline, music } = this.input;
    const ctx = new AudioContext();
    this.ctx = ctx;
    if (ctx.state === "suspended") await ctx.resume().catch(() => undefined);
    const master = createMasterChain(ctx);
    this.startOffset = ctx.currentTime + 0.12;
    const voiceTrim = ctx.createGain();
    voiceTrim.gain.setValueAtTime(settings.voiceVolume / 100, this.startOffset);
    voiceTrim.connect(master);
    const breathTrim = ctx.createGain();
    breathTrim.gain.setValueAtTime(settings.breathVolume / 100, this.startOffset);
    breathTrim.connect(master);
    const kickBus = ctx.createGain();
    const duckable = ctx.createGain();
    this.kickDuck = ctx.createGain();
    this.duck = ctx.createGain();
    this.musicTrim = ctx.createGain();
    kickBus.connect(this.kickDuck);
    this.kickDuck.connect(this.musicTrim);
    duckable.connect(this.duck);
    this.duck.connect(this.musicTrim);
    this.musicTrim.connect(master);
    this.musicTrim.gain.setValueAtTime(settings.musicVolume / 100, this.startOffset);
    const mode = effectiveMusic(settings, music);
    if (mode === "file" && music) {
      const src = ctx.createBufferSource();
      src.buffer = cloneBuffer(ctx, music);
      src.loop = true;
      src.connect(duckable);
      src.start(this.startOffset);
    }
    // 系统语音只有别的语言的发音人时改用内置语音，不拿别的语言念中文
    const useTts = settings.voiceEngine === "tts" && ttsAvailable() && ttsChinese() !== "no";
    const voice = useTts ? pickVoice(this.ttsVoiceUri) : null;
    const events = timeline.events;
    let fadedOut = false;

    this.timer = setInterval(() => {
      // 暂停中什么都不排、不念（AudioContext 挂起要一会儿才生效；暂停中跳段也不能把下一句念出来）
      if (!this.ctx || this.pausedFlag) return;
      const now = this.ctx.currentTime;
      const t = this.elapsed();
      if (!fadedOut && t >= timeline.totalDuration - 0.6) {
        fadedOut = true;
        this.musicTrim?.gain.setTargetAtTime(0.0001, now, 0.15);
      }
      if (settings.voiceBake && useTts) {
        while (this.ttsCursor < events.length && t >= events[this.ttsCursor].time - 0.12) {
          const ev = events[this.ttsCursor++];
          // 自己录过的句子放录音（下面和打点一起排），没录的才用系统语音
          // 系统语音念"3，吸""3，全部完成"时逗号会停顿，下一拍可能把它切掉，所以去掉逗号
          if (ev.voice && !this.input.bank.own(ev.voice)) speak(ev.voice.replace(/，/g, ""), { rate: ev.bpm > 78 ? 1.42 : 1.28, volScale: ev.voiceVolScale || 1, settings, voice });
        }
      }
      while (this.audioCursor < events.length && t >= events[this.audioCursor].time - 0.08) {
        const ev = events[this.audioCursor++];
        const at = Math.max(now + 0.005, now + (ev.time - t));
        const recorded = !!ev.voice && !!this.input.bank.own(ev.voice);
        scheduleEventSounds(ctx, master, at, ev, this.input, { voice: settings.voiceBake && (!useTts || recorded), breathDest: breathTrim,
          voiceDest: voiceTrim, breathGain: 1, voiceGain: 1 });
        if (mode !== "none") {
          scheduleSingleBeatGroove(ctx, kickBus, duckable, at, ev, ev.beatDur || 1, mode, ev.actionBeatIdx || 0);
          this.duckAt(ev, at);
        }
      }
      while (this.uiCursor < events.length && t >= events[this.uiCursor].time - 0.005) {
        this.cb.onEvent(events[this.uiCursor], this.uiCursor);
        this.uiCursor++;
      }
      if (t >= timeline.totalDuration && !(useTts && window.speechSynthesis.speaking)) void this.stop(true);
    }, 16);
  }

  private duckAt(ev: TimelineEvent, at: number) {
    const { settings, bank } = this.input;
    const depth = settings.duckDepth / 100;
    const hasVoice = settings.voiceBake && !!ev.voice;
    if (depth <= 0 || !(isPrimaryCue(ev) || hasVoice || (settings.duckSubBeats && isSubCue(ev)))) return;
    const hold = Math.max(ev.isSetFinalRep ? 0.48 : 0.08, hasVoice ? bank.seconds(ev.voice!) : 0);
    const eff = isSubCue(ev) && !hasVoice ? depth * 0.55 : depth;
    for (const [node, ratio] of [[this.duck, Math.max(0.02, 1 - eff)], [this.kickDuck, Math.max(0.76, 1 - eff * 0.2)]] as const) {
      if (!node) continue;
      node.gain.cancelScheduledValues(at);
      node.gain.setTargetAtTime(ratio, at, 0.008);
      node.gain.setTargetAtTime(1.0, at + hold, 0.065);
    }
  }

  /** 跳到路线图上的某一段。 */
  jumpTo(stageId: string): void {
    const events = this.input.timeline.events;
    const idx = events.findIndex((e) => e.phaseGroup === stageId);
    if (!this.ctx || idx < 0) return;
    stopSpeaking();
    const now = this.ctx.currentTime;
    for (const n of [this.duck, this.kickDuck]) {
      n?.gain.cancelScheduledValues(now);
      n?.gain.setTargetAtTime(1.0, now, 0.02);
    }
    // 播放中提前 0.05 秒，让这一段第一拍照常排上；暂停中正好停在这一段开头，动图也显示这一段
    this.warp = events[idx].time - (now - this.startOffset) - (this.pausedFlag ? 0 : 0.05);
    this.audioCursor = this.uiCursor = this.ttsCursor = idx;
  }

  async stop(completed = false): Promise<void> {
    this.pausedFlag = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (!completed) stopSpeaking();
    const ctx = this.ctx;
    this.ctx = null;
    if (ctx && ctx.state !== "closed") await ctx.close().catch(() => undefined);
    this.cb.onEnd(completed);
  }
}
