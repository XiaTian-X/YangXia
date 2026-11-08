// 导出：WAV 音频、SRT 字幕、WebM 跟练视频（WebCodecs 离线高速合成）、练习记录 JSON。
// WebM 的流程照原版 exportWebmOfflineFast 移植：先离线渲染 48kHz 音轨，再按 60FPS 虚拟时钟逐帧画面、编码、封装。
import { buildSession, buildSrt, type Course, type SessionInput, type Timeline } from "@yangxia/course-core";
import { renderOffline, type RenderInput } from "../audio/render.ts";
import { audioBufferToWav } from "../audio/sounds.ts";
import { applyEvent, drawHud, HUD_HEIGHT, HUD_WIDTH, initialHud, stepHud, type HudState } from "../hud/draw.ts";
import { createSimpleWebmMuxer } from "./webm-muxer.js";

export async function exportWav(input: RenderInput): Promise<Blob> {
  return audioBufferToWav(await renderOffline(input));
}

export function exportSrt(timeline: Timeline): Blob {
  return new Blob([buildSrt(timeline.events, timeline.totalDuration)], { type: "application/x-subrip" });
}

export interface WebmSupport {
  videoCodec: string;
  videoWebmId: string;
}

export async function webmSupport(): Promise<WebmSupport | null> {
  if (typeof VideoEncoder !== "function" || typeof AudioEncoder !== "function" || typeof VideoFrame !== "function" || typeof AudioData !== "function") {
    return null;
  }
  try {
    const a = await AudioEncoder.isConfigSupported({ codec: "opus", sampleRate: 48000, numberOfChannels: 2, bitrate: 128000 });
    if (!a.supported) return null;
    for (const c of [{ codec: "vp09.00.10.08", webmId: "V_VP9" }, { codec: "vp8", webmId: "V_VP8" }]) {
      const v = await VideoEncoder.isConfigSupported({ codec: c.codec, width: HUD_WIDTH, height: HUD_HEIGHT, bitrate: 5_000_000, framerate: 60 });
      if (v.supported) return { videoCodec: c.codec, videoWebmId: c.webmId };
    }
  } catch {
    /* 不支持 */
  }
  return null;
}

export interface WebmOptions {
  hud: Pick<HudState, "bgMode" | "layoutMode">;
  onProgress?: (stage: "audio" | "video", pct: number) => void;
  signal?: AbortSignal;
}

export async function exportWebm(input: RenderInput, opts: WebmOptions): Promise<Blob> {
  const support = await webmSupport();
  if (!support) throw new Error("这个浏览器不支持 WebCodecs 视频编码，导不了视频。请用新版 Chrome 或 Edge。");
  const check = () => {
    if (opts.signal?.aborted) throw new DOMException("已取消", "AbortError");
  };
  const { timeline } = input;
  const fps = 60;
  const sr = 48000;
  const totalFrames = Math.max(1, Math.ceil(timeline.totalDuration * fps));
  opts.onProgress?.("audio", 0);
  const audio = await renderOffline(input, sr);
  check();
  const muxer = createSimpleWebmMuxer({ width: HUD_WIDTH, height: HUD_HEIGHT, fps, videoCodecId: support.videoWebmId,
    sampleRate: sr, channels: 2, durationMs: timeline.totalDuration * 1000 });
  let encoderError: unknown = null;
  const copy = (chunk: EncodedVideoChunk | EncodedAudioChunk) => {
    const buf = new Uint8Array(chunk.byteLength);
    chunk.copyTo(buf);
    return buf;
  };
  const vEnc = new VideoEncoder({ output: (c) => muxer.addVideoChunk(copy(c), c.timestamp, c.type === "key"), error: (e) => { encoderError = e; } });
  vEnc.configure({ codec: support.videoCodec, width: HUD_WIDTH, height: HUD_HEIGHT, bitrate: 5_000_000, framerate: fps });
  const aEnc = new AudioEncoder({ output: (c) => muxer.addAudioChunk(copy(c), c.timestamp), error: (e) => { encoderError = e; } });
  aEnc.configure({ codec: "opus", sampleRate: sr, numberOfChannels: 2, bitrate: 128000 });
  try {
    // 音频：每块 960 采样（20ms，标准 Opus 帧），队列积压时等一等
    const ch0 = audio.getChannelData(0);
    const ch1 = audio.numberOfChannels > 1 ? audio.getChannelData(1) : ch0;
    for (let off = 0; off < audio.length; off += 960) {
      check();
      if (encoderError) throw encoderError;
      const len = Math.min(960, audio.length - off);
      const planar = new Float32Array(len * 2);
      planar.set(ch0.subarray(off, off + len), 0);
      planar.set(ch1.subarray(off, off + len), len);
      const data = new AudioData({ format: "f32-planar", sampleRate: sr, numberOfFrames: len, numberOfChannels: 2,
        timestamp: Math.round((off / sr) * 1_000_000), data: planar });
      aEnc.encode(data);
      data.close();
      while (aEnc.encodeQueueSize > 24 && !encoderError) await new Promise((r) => setTimeout(r, 2));
    }
    // 画面：60FPS 虚拟时钟逐帧画
    const canvas = new OffscreenCanvas(HUD_WIDTH, HUD_HEIGHT);
    const ctx = canvas.getContext("2d") as unknown as CanvasRenderingContext2D;
    const hud: HudState = { ...initialHud(), ...opts.hud, pulseScale: 1 };
    const events = timeline.events;
    let cursor = 0;
    let last = -1;
    let voiceClear = 0;
    for (let f = 0; f < totalFrames; f++) {
      check();
      if (encoderError) throw encoderError;
      const t = f / fps;
      while (cursor < events.length && t >= events[cursor].time - 0.0001) {
        const ev = events[cursor];
        applyEvent(hud, ev);
        if (input.settings.voiceBake && ev.voice) {
          hud.voiceText = ev.voice;
          voiceClear = ev.time + Math.max(0.28, input.bank.seconds(ev.voice) || 0.35);
        }
        last = cursor++;
      }
      if (hud.voiceText && t >= voiceClear) hud.voiceText = "";
      stepHud(hud, last >= 0 ? events[last] : undefined, events[last + 1], t);
      drawHud(ctx, hud);
      const frame = new VideoFrame(canvas, { timestamp: Math.round((f * 1_000_000) / fps) });
      vEnc.encode(frame, { keyFrame: f % 60 === 0 });
      frame.close();
      if (vEnc.encodeQueueSize > 16 || f % 20 === 0) {
        opts.onProgress?.("video", Math.min(99, Math.round(((f + 1) / totalFrames) * 100)));
        while (vEnc.encodeQueueSize > 8 && !encoderError) await new Promise((r) => setTimeout(r, 4));
      }
    }
    await Promise.all([vEnc.flush(), aEnc.flush()]);
    if (encoderError) throw encoderError;
    opts.onProgress?.("video", 100);
    return muxer.finalize();
  } finally {
    if (vEnc.state !== "closed") vEnc.close();
    if (aEnc.state !== "closed") aEnc.close();
  }
}

export type { Feeling } from "@yangxia/course-core";

/** 练习记录 yangxia.session/1（个人数据：只保存到本地，放进 profiles/<代号>/打卡/）。
 *  内容由核心库 buildSession 生成：完成组数只数实际播放过的组。 */
export function sessionRecord(course: Course, input: SessionInput): Blob {
  return new Blob([JSON.stringify(buildSession(course, input), null, 2) + "\n"], { type: "application/json" });
}

export function download(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

/** 导出文件名：养夏_<课程名>.<扩展名>（去掉文件名里不能用的字符）。 */
export function exportName(course: Course, ext: string): string {
  return `养夏_${course.name.replace(/[\\/:*?"<>|\s·]+/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "")}.${ext}`;
}
