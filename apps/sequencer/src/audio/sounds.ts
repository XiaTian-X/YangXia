// 打点、换气提示音、鼓点、限幅、语音播放、WAV 编码、导入音乐的重采样、录音裁剪。
// 照原版编排器原样移植（apps/sequencer/reference/原版.html），只改了：加类型、设置项改名
// （synth-groove → groove，synth-power → beat，custom-file → file）、新增"换边"事件用开场提示音。
import type { CueType, PlaybackSettings, TimelineEvent } from "@yangxia/course-core";
import { SAMPLE_RATE } from "./voice-synth.ts";

export function createMasterChain(ctx: BaseAudioContext, extraStreamDest: AudioNode | null = null): GainNode {
  const now = ctx.currentTime || 0;
  const masterGain = ctx.createGain();
  masterGain.gain.setValueAtTime(0.92, now);

  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.setValueAtTime(-1.5, now);
  limiter.knee.setValueAtTime(3.0, now);
  limiter.ratio.setValueAtTime(14.0, now);
  limiter.attack.setValueAtTime(0.002, now);
  limiter.release.setValueAtTime(0.08, now);

  masterGain.connect(limiter);
  limiter.connect(ctx.destination);
  if (extraStreamDest) {
    limiter.connect(extraStreamDest);
  }
  return masterGain;
}

export function applyCleanEnvelope(gainNode: GainNode, time: number, peakGain: number, duration: number): void {
  const safeTime = Math.max(0.002, time);
  const attack = 0.0025;
  const safePeak = Math.max(0.0002, peakGain);
  const safeDur = Math.max(attack + 0.005, duration);
  gainNode.gain.setValueAtTime(0.0001, safeTime);
  gainNode.gain.linearRampToValueAtTime(safePeak, safeTime + attack);
  gainNode.gain.exponentialRampToValueAtTime(0.0001, safeTime + safeDur);
}

export function scheduleBreathRhythmPluck(ctx: BaseAudioContext, destNode: AudioNode, time: number, direction: "inhale" | "exhale", userVol = 0.65, isRestPhase = false): void {
  if (userVol <= 0.01) return;
  const safeTime = Math.max(0.005, time);
  const peak = 0.34 * userVol;

  if (isRestPhase) {
    const notes = direction === 'inhale'
      ? [523.25, 659.25, 783.99]
      : [783.99, 659.25, 523.25];
    notes.forEach((freq, idx) => {
      const t = safeTime + idx * 0.065;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, t);
      applyCleanEnvelope(gain, t, peak * 0.75, 0.085);
      osc.connect(gain);
      gain.connect(destNode);
      osc.start(t);
      osc.stop(t + 0.09);
    });
    return;
  }

  if (direction === 'inhale') {
    [587.33, 880.0].forEach((freq, idx) => {
      const t = safeTime + idx * 0.038;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, t);
      applyCleanEnvelope(gain, t, idx === 1 ? peak * 0.78 : peak * 0.52, 0.065);
      osc.connect(gain);
      gain.connect(destNode);
      osc.start(t);
      osc.stop(t + 0.07);
    });
  } else {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(523.25 * 1.18, safeTime);
    osc.frequency.exponentialRampToValueAtTime(523.25, safeTime + 0.015);
    applyCleanEnvelope(gain, safeTime, peak * 0.65, 0.055);
    osc.connect(gain);
    gain.connect(destNode);
    osc.start(safeTime);
    osc.stop(safeTime + 0.06);
  }
}

export function scheduleStudioKick(ctx: BaseAudioContext, destNode: AudioNode, time: number, intensity = 1.0): void {
  const safeTime = Math.max(0.005, time);
  const bodyOsc = ctx.createOscillator();
  const bodyGain = ctx.createGain();
  bodyOsc.type = 'sine';
  bodyOsc.frequency.setValueAtTime(150, safeTime);
  bodyOsc.frequency.exponentialRampToValueAtTime(52, safeTime + 0.040);
  bodyOsc.frequency.exponentialRampToValueAtTime(45, safeTime + 0.14);

  applyCleanEnvelope(bodyGain, safeTime, 0.76 * intensity, 0.15);
  bodyOsc.connect(bodyGain);
  bodyGain.connect(destNode);
  bodyOsc.start(safeTime);
  bodyOsc.stop(safeTime + 0.16);

  const clickOsc = ctx.createOscillator();
  const clickGain = ctx.createGain();
  clickOsc.type = 'triangle';
  clickOsc.frequency.setValueAtTime(780, safeTime);
  clickOsc.frequency.exponentialRampToValueAtTime(150, safeTime + 0.012);

  applyCleanEnvelope(clickGain, safeTime, 0.28 * intensity, 0.015);
  clickOsc.connect(clickGain);
  clickGain.connect(destNode);
  clickOsc.start(safeTime);
  clickOsc.stop(safeTime + 0.018);
}

export function scheduleCleanGrooveTick(ctx: BaseAudioContext, destNode: AudioNode, time: number, pitch = 1180, peak = 0.12): void {
  const safeTime = Math.max(0.005, time);
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'triangle';
  osc.frequency.setValueAtTime(pitch * 1.35, safeTime);
  osc.frequency.exponentialRampToValueAtTime(pitch, safeTime + 0.012);
  applyCleanEnvelope(gain, safeTime, peak, 0.026);
  osc.connect(gain);
  gain.connect(destNode);
  osc.start(safeTime);
  osc.stop(safeTime + 0.030);
}

export function scheduleCueSound(ctx: BaseAudioContext, destNode: AudioNode, time: number, cueType: CueType, style: PlaybackSettings["sound"], isLastThree: boolean, isSetFinalRep: boolean): void {
  if (!cueType || cueType === 'none') return;
  const safeTime = Math.max(0.005, time);

  if (cueType === 'intro-cue' || cueType === 'side-switch') {
    [523.25, 783.99].forEach((freq, idx) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      const t = safeTime + idx * 0.06;
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, t);
      applyCleanEnvelope(gain, t, 0.42, 0.16);
      osc.connect(gain);
      gain.connect(destNode);
      osc.start(t);
      osc.stop(t + 0.17);
    });

  } else if (cueType === 'count-321') {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(880, safeTime);
    applyCleanEnvelope(gain, safeTime, 0.46, 0.080);
    osc.connect(gain);
    gain.connect(destNode);
    osc.start(safeTime);
    osc.stop(safeTime + 0.085);

  } else if (cueType === 'count-go') {
    [880, 1318.5, 1760].forEach((freq, idx) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      const t = safeTime + idx * 0.042;
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(freq, t);
      applyCleanEnvelope(gain, t, 0.54, 0.15);
      osc.connect(gain);
      gain.connect(destNode);
      osc.start(t);
      osc.stop(t + 0.16);
    });

  } else if (cueType === 'up') {
    const baseFreq = style === 'marimba' ? 587.33 : (style === 'perc' ? 659.25 : 783.99);

    const osc1 = ctx.createOscillator();
    const gain1 = ctx.createGain();
    osc1.type = 'sine';
    osc1.frequency.setValueAtTime(baseFreq * 1.38, safeTime);
    osc1.frequency.exponentialRampToValueAtTime(baseFreq, safeTime + 0.018);
    applyCleanEnvelope(gain1, safeTime, 0.66, 0.062);
    osc1.connect(gain1);
    gain1.connect(destNode);
    osc1.start(safeTime);
    osc1.stop(safeTime + 0.068);

    const osc2 = ctx.createOscillator();
    const gain2 = ctx.createGain();
    osc2.type = 'triangle';
    osc2.frequency.setValueAtTime(baseFreq * 2.76, safeTime);
    applyCleanEnvelope(gain2, safeTime, 0.24, 0.022);
    osc2.connect(gain2);
    gain2.connect(destNode);
    osc2.start(safeTime);
    osc2.stop(safeTime + 0.025);

  } else if (cueType === 'hold' || cueType === 'sub') {
    const subFreq = cueType === 'hold' ? 659.25 : 523.25;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(subFreq * 1.22, safeTime);
    osc.frequency.exponentialRampToValueAtTime(subFreq, safeTime + 0.014);
    applyCleanEnvelope(gain, safeTime, 0.28, 0.036);
    osc.connect(gain);
    gain.connect(destNode);
    osc.start(safeTime);
    osc.stop(safeTime + 0.040);

  } else if (cueType === 'rep') {
    const pitchShift = isLastThree ? 1.12246 : 1.0;
    const note1 = 1046.50 * pitchShift;
    const note2 = 1567.98 * pitchShift;
    const mainDur = isSetFinalRep ? 0.34 : 0.18;

    [note1, note2].forEach((freq, idx) => {
      const t = safeTime + idx * 0.014;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, t);
      applyCleanEnvelope(gain, t, idx === 1 ? 0.58 : 0.42, mainDur);
      osc.connect(gain);
      gain.connect(destNode);
      osc.start(t);
      osc.stop(t + mainDur + 0.01);

      const shimmer = ctx.createOscillator();
      const sGain = ctx.createGain();
      shimmer.type = 'triangle';
      shimmer.frequency.setValueAtTime(freq * 2.0, t);
      applyCleanEnvelope(sGain, t, 0.15, 0.080);
      shimmer.connect(sGain);
      sGain.connect(destNode);
      shimmer.start(t);
      shimmer.stop(t + 0.085);
    });

    if (isSetFinalRep) {
      [1046.5, 1318.5, 1567.98, 2093.0].forEach((chordFreq, idx) => {
        const chordOsc = ctx.createOscillator();
        const chordGain = ctx.createGain();
        const startT = safeTime + (idx + 1) * 0.055;
        chordOsc.type = 'sine';
        chordOsc.frequency.setValueAtTime(chordFreq, startT);
        applyCleanEnvelope(chordGain, startT, 0.36, 0.40);
        chordOsc.connect(chordGain);
        chordGain.connect(destNode);
        chordOsc.start(startT);
        chordOsc.stop(startT + 0.42);
      });
    }

  } else if (cueType === 'rest-tick') {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(440, safeTime);
    applyCleanEnvelope(gain, safeTime, 0.12, 0.025);
    osc.connect(gain);
    gain.connect(destNode);
    osc.start(safeTime);
    osc.stop(safeTime + 0.03);
  }
}

const BASS_PROGRESSION: number[] = [55.0, 65.41, 73.42, 65.41];

export function scheduleSingleBeatGroove(ctx: BaseAudioContext, kickBus: AudioNode, duckableBgmBus: AudioNode, absTime: number, ev: TimelineEvent, beatDur: number, mode: PlaybackSettings["music"], actionBeatIdx: number): void {
  if (mode === 'none' || mode === 'file') return;

  if (ev.state === 'action') {
    if (ev.cueType === 'up') {
      scheduleStudioKick(ctx, kickBus, absTime, 1.0);
    } else if (ev.cueType === 'rep') {
      scheduleStudioKick(ctx, kickBus, absTime, 0.84);
    } else if (ev.cueType === 'sub' || ev.cueType === 'hold') {
      scheduleStudioKick(ctx, kickBus, absTime, 0.62);
    }

    if (mode === 'groove' || mode === 'beat') {
      const halfBeatTime = absTime + beatDur * 0.5;
      scheduleCleanGrooveTick(ctx, duckableBgmBus, halfBeatTime, 1180, mode === 'groove' ? 0.11 : 0.07);

      if (mode === 'groove') {
        const bassOsc = ctx.createOscillator();
        const bassGain = ctx.createGain();
        const noteFreq = BASS_PROGRESSION[actionBeatIdx % BASS_PROGRESSION.length];
        bassOsc.type = 'sine';
        bassOsc.frequency.setValueAtTime(noteFreq * 1.5, halfBeatTime);
        bassOsc.frequency.exponentialRampToValueAtTime(noteFreq, halfBeatTime + 0.025);

        applyCleanEnvelope(bassGain, halfBeatTime, 0.34, 0.11);
        bassOsc.connect(bassGain);
        bassGain.connect(duckableBgmBus);
        bassOsc.start(halfBeatTime);
        bassOsc.stop(halfBeatTime + 0.12);
      }
    }
  } else if (ev.state === 'rest') {
    if (ev.cueType === 'count-321') {
      scheduleStudioKick(ctx, kickBus, absTime, 0.45);
    }
  }
}

export function scheduleVoiceWaveform(ctx: BaseAudioContext, destNode: AudioNode, time: number, waveform: Float32Array | null, gainScale = 0.90): number {
  if (!waveform || waveform.length === 0) return 0;
  const safeTime = Math.max(0.005, time);
  const audioBuf = ctx.createBuffer(1, waveform.length, SAMPLE_RATE);
  audioBuf.getChannelData(0).set(waveform);

  const src = ctx.createBufferSource();
  src.buffer = audioBuf;

  const hpFilter = ctx.createBiquadFilter();
  hpFilter.type = 'highpass';
  hpFilter.frequency.setValueAtTime(125, safeTime);

  const warmthFilter = ctx.createBiquadFilter();
  warmthFilter.type = 'peaking';
  warmthFilter.frequency.setValueAtTime(280, safeTime);
  warmthFilter.Q.setValueAtTime(0.95, safeTime);
  warmthFilter.gain.setValueAtTime(1.8, safeTime);

  const presenceFilter = ctx.createBiquadFilter();
  presenceFilter.type = 'peaking';
  presenceFilter.frequency.setValueAtTime(2480, safeTime);
  presenceFilter.Q.setValueAtTime(1.05, safeTime);
  presenceFilter.gain.setValueAtTime(2.1, safeTime);

  const lpFilter = ctx.createBiquadFilter();
  lpFilter.type = 'lowpass';
  lpFilter.frequency.setValueAtTime(6800, safeTime);

  const gain = ctx.createGain();
  gain.gain.setValueAtTime(gainScale, safeTime);

  src.connect(hpFilter);
  hpFilter.connect(warmthFilter);
  warmthFilter.connect(presenceFilter);
  presenceFilter.connect(lpFilter);
  lpFilter.connect(gain);
  gain.connect(destNode);

  src.start(safeTime);
  return waveform.length / SAMPLE_RATE;
}

export function audioBufferToWav(buffer: AudioBuffer): Blob {
  const numOfChan = buffer.numberOfChannels;
  const length = buffer.length * numOfChan * 2 + 44;
  const out = new ArrayBuffer(length);
  const view = new DataView(out);
  const sampleRate = buffer.sampleRate;
  let pos = 0;

  const setUint16 = (data: number) => { view.setUint16(pos, data, true); pos += 2; };
  const setUint32 = (data: number) => { view.setUint32(pos, data, true); pos += 4; };

  setUint32(0x46464952);
  setUint32(length - 8);
  setUint32(0x45564157);
  setUint32(0x20746d66);
  setUint32(16);
  setUint16(1);
  setUint16(numOfChan);
  setUint32(sampleRate);
  setUint32(sampleRate * 2 * numOfChan);
  setUint16(numOfChan * 2);
  setUint16(16);
  setUint32(0x61746164);
  setUint32(length - pos - 4);

  const channels: Float32Array[] = [];
  for (let ch = 0; ch < numOfChan; ch++) {
    channels.push(buffer.getChannelData(ch));
  }

  for (let i = 0; i < buffer.length; i++) {
    for (let ch = 0; ch < numOfChan; ch++) {
      let s = channels[ch][i];
      if (!Number.isFinite(s)) s = 0;
      if (s > 0.95) s = 0.95 + 0.05 * Math.tanh((s - 0.95) / 0.05);
      else if (s < -0.95) s = -0.95 + 0.05 * Math.tanh((s + 0.95) / 0.05);
      const clamped = Math.max(-1, Math.min(1, s));
      view.setInt16(pos, clamped < 0 ? clamped * 0x8000 : clamped * 0x7FFF, true);
      pos += 2;
    }
  }
  return new Blob([out], { type: 'audio/wav' });
}

export async function decodeAndResampleTo44100(arrayBuf: ArrayBuffer): Promise<AudioBuffer> {
  const offlineDecoder = new OfflineAudioContext(2, 1, SAMPLE_RATE);
  const decoded = await offlineDecoder.decodeAudioData(arrayBuf);
  if (decoded.sampleRate === SAMPLE_RATE) return decoded;

  const targetLength = Math.max(1, Math.ceil(decoded.duration * SAMPLE_RATE));
  const resampleCtx = new OfflineAudioContext(
    decoded.numberOfChannels,
    targetLength,
    SAMPLE_RATE
  );
  const src = resampleCtx.createBufferSource();
  src.buffer = decoded;
  src.connect(resampleCtx.destination);
  src.start(0);
  return await resampleCtx.startRendering();
}

export function trimAndValidateMicRecording(floatArr: Float32Array, sr: number): Float32Array | null {
  let maxAbs = 0;
  for (let i = 0; i < floatArr.length; i++) {
    const a = Math.abs(floatArr[i]);
    if (a > maxAbs) maxAbs = a;
  }
  if (maxAbs < 0.025) return null;
  const threshold = Math.max(0.012, maxAbs * 0.12);
  let start = 0;
  let end = floatArr.length - 1;
  while (start < end && Math.abs(floatArr[start]) < threshold) start++;
  while (end > start && Math.abs(floatArr[end]) < threshold) end--;
  start = Math.max(0, start - Math.floor(0.010 * sr));
  end = Math.min(floatArr.length - 1, end + Math.floor(0.020 * sr));
  return floatArr.slice(start, end + 1);
}
