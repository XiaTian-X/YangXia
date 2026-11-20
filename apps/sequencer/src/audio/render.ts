// 离线渲染整套课程的音频（WAV 和 WebM 视频共用同一份），以及背景音乐和压低。
// 照原版 renderCourseOfflineBuffer / scheduleOfflineFullBgm 移植；不读页面，只吃时间轴和设置。
import { duckWindows, type PlaybackSettings, type Timeline, type TimelineEvent } from "@yangxia/course-core";
import {
  createMasterChain, scheduleBreathRhythmPluck, scheduleCueSound, scheduleSingleBeatGroove, scheduleVoiceWaveform,
} from "./sounds.ts";
import type { VoiceBank } from "./voice-bank.ts";
import { SAMPLE_RATE } from "./voice-synth.ts";

export interface RenderInput {
  timeline: Timeline;
  settings: PlaybackSettings;
  bank: VoiceBank;
  /** 导入的背景音乐（已重采样到 44.1kHz）；没有时"导入音乐"模式退回鼓点。 */
  music?: AudioBuffer | null;
}

export function effectiveMusic(settings: PlaybackSettings, music?: AudioBuffer | null): PlaybackSettings["music"] {
  return settings.music === "file" && !music ? "groove" : settings.music;
}

/** 背景鼓点或导入音乐，带开头淡入、结尾淡出和打点 / 说话时的压低。 */
export function scheduleMusic(ctx: BaseAudioContext, dest: AudioNode, start: number, input: RenderInput): void {
  const { timeline, settings, bank, music } = input;
  const mode = effectiveMusic(settings, music);
  if (mode === "none") return;
  const { events, totalDuration } = timeline;
  const kickBus = ctx.createGain();
  const kickDuck = ctx.createGain();
  const duckable = ctx.createGain();
  const duck = ctx.createGain();
  const fade = ctx.createGain();
  const trim = ctx.createGain();
  kickBus.connect(kickDuck);
  kickDuck.connect(fade);
  duckable.connect(duck);
  duck.connect(fade);
  fade.connect(trim);
  trim.connect(dest);
  trim.gain.setValueAtTime(settings.musicVolume / 100, start);
  fade.gain.setValueAtTime(0.0001, start);
  fade.gain.linearRampToValueAtTime(1.0, start + 0.1);
  const fadeOutStart = start + Math.max(0.3, totalDuration - 0.55);
  fade.gain.setValueAtTime(1.0, fadeOutStart);
  fade.gain.linearRampToValueAtTime(0.0001, start + totalDuration);
  duck.gain.setValueAtTime(1.0, start);
  kickDuck.gain.setValueAtTime(1.0, start);

  for (const w of duckWindows(events, { depth: settings.duckDepth / 100, includeSub: settings.duckSubBeats, voice: settings.voiceBake,
    voiceDuration: bank.seconds })) {
    const t = start + w.start;
    const pre = Math.max(start + 0.01, t - 0.005);
    const ducked = Math.max(0.02, 1.0 - w.depth);
    const kickDucked = Math.max(0.76, 1.0 - w.depth * 0.2);
    for (const [node, ratio] of [[duck, ducked], [kickDuck, kickDucked]] as const) {
      node.gain.setValueAtTime(1.0, pre);
      node.gain.linearRampToValueAtTime(ratio, t + 0.012);
      node.gain.setValueAtTime(ratio, start + w.holdEnd);
      node.gain.linearRampToValueAtTime(1.0, start + w.releaseEnd);
    }
  }

  if (mode === "file" && music) {
    const src = ctx.createBufferSource();
    src.buffer = cloneBuffer(ctx, music);
    src.loop = true;
    src.connect(duckable);
    src.start(start);
    src.stop(start + totalDuration);
  } else {
    let actionIdx = 0;
    for (const ev of events) {
      scheduleSingleBeatGroove(ctx, kickBus, duckable, start + ev.time, ev, ev.beatDur || 60 / settings.bpm, mode, actionIdx);
      if (ev.state === "action") actionIdx++;
    }
  }
}

export function cloneBuffer(ctx: BaseAudioContext, buf: AudioBuffer): AudioBuffer {
  const out = ctx.createBuffer(buf.numberOfChannels, buf.length, buf.sampleRate);
  for (let ch = 0; ch < buf.numberOfChannels; ch++) out.getChannelData(ch).set(buf.getChannelData(ch));
  return out;
}

/** 一个事件的打点、换气提示音、语音（离线渲染和实时播放共用）。 */
export function scheduleEventSounds(ctx: BaseAudioContext, dest: AudioNode, at: number, ev: TimelineEvent, input: RenderInput,
  opts: { voice: boolean; breathDest?: AudioNode; voiceDest?: AudioNode; breathGain?: number; voiceGain?: number }): void {
  const { settings, bank } = input;
  scheduleCueSound(ctx, dest, at, ev.cueType, settings.sound, ev.isLastThree, ev.isSetFinalRep);
  if (ev.breathPluck) {   // 响不响提示音由时间轴按呼吸提示的设置定
    scheduleBreathRhythmPluck(ctx, opts.breathDest ?? dest, at + 0.015, ev.breathPluck.direction,
      opts.breathGain ?? settings.breathVolume / 100, ev.breathPluck.isRestPhase);
  }
  if (opts.voice && ev.voice) {
    scheduleVoiceWaveform(ctx, opts.voiceDest ?? dest, Math.max(0.005, at + (ev.voiceOffset || 0)), bank.phrase(ev.voice),
      (opts.voiceGain ?? settings.voiceVolume / 100) * (ev.voiceVolScale || 1));
  }
}

/** 离线渲染整套课程（双声道）。WAV 用 44.1kHz，WebM 的 Opus 用 48kHz。 */
export async function renderOffline(input: RenderInput, sampleRate = SAMPLE_RATE): Promise<AudioBuffer> {
  const frames = Math.max(1, Math.ceil(sampleRate * input.timeline.totalDuration));
  const ctx = new OfflineAudioContext(2, frames, sampleRate);
  const master = createMasterChain(ctx);
  scheduleMusic(ctx, master, 0, input);
  for (const ev of input.timeline.events) scheduleEventSounds(ctx, master, ev.time, ev, input, { voice: input.settings.voiceBake });
  return ctx.startRendering();
}
