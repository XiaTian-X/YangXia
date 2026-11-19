// 导出：WAV 音频、SRT 字幕、WebM 跟练视频（WebCodecs 离线高速合成）、练习记录 JSON。
// WebM：先离线渲染 48kHz 音轨，再按 60FPS 虚拟时钟逐帧画面；编码、封装交给 Mediabunny。
import { buildSession, buildSrt, type Course, type SessionInput, type Timeline } from "@yangxia/course-core";
import { AudioBufferSource, BufferTarget, canEncodeAudio, canEncodeVideo, CanvasSource, Output, WebMOutputFormat } from "mediabunny";
import { renderOffline, type RenderInput } from "../audio/render.ts";
import { audioBufferToWav } from "../audio/sounds.ts";
import { applyEvent, drawHud, HUD_HEIGHT, HUD_WIDTH, initialHud, stepHud, type HudFigure, type HudState } from "../hud/draw.ts";

export async function exportWav(input: RenderInput): Promise<Blob> {
  return audioBufferToWav(await renderOffline(input));
}

export function exportSrt(timeline: Timeline): Blob {
  return new Blob([buildSrt(timeline.events, timeline.totalDuration)], { type: "application/x-subrip" });
}

export interface WebmSupport {
  videoCodec: "vp9" | "vp8";
}

const VIDEO_BITRATE = 5_000_000;
const AUDIO_BITRATE = 128_000;
const FPS = 60;
const SAMPLE_RATE = 48_000;

export async function webmSupport(): Promise<WebmSupport | null> {
  if (typeof VideoEncoder !== "function" || typeof AudioEncoder !== "function" || typeof VideoFrame !== "function" || typeof AudioData !== "function") {
    return null;
  }
  try {
    if (!(await canEncodeAudio("opus", { sampleRate: SAMPLE_RATE, numberOfChannels: 2, bitrate: AUDIO_BITRATE }))) return null;
    for (const videoCodec of ["vp9", "vp8"] as const) {
      if (await canEncodeVideo(videoCodec, { width: HUD_WIDTH, height: HUD_HEIGHT, bitrate: VIDEO_BITRATE, frameRate: FPS })) return { videoCodec };
    }
  } catch {
    /* 不支持 */
  }
  return null;
}

export interface WebmOptions {
  hud: Pick<HudState, "bgMode" | "layoutMode">;
  /** 这一刻的动作示意；不传或返回 null 就不画。和实时跟练用同一个函数。 */
  figure?: (t: number) => HudFigure | null;
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
  const totalFrames = Math.max(1, Math.ceil(timeline.totalDuration * FPS));
  opts.onProgress?.("audio", 0);
  const audio = await renderOffline(input, SAMPLE_RATE);
  check();
  const canvas = new OffscreenCanvas(HUD_WIDTH, HUD_HEIGHT);
  const ctx = canvas.getContext("2d") as unknown as CanvasRenderingContext2D;
  const target = new BufferTarget();
  const output = new Output({ format: new WebMOutputFormat(), target });
  const video = new CanvasSource(canvas, { codec: support.videoCodec, bitrate: VIDEO_BITRATE, keyFrameInterval: 1 });
  const sound = new AudioBufferSource({ codec: "opus", bitrate: AUDIO_BITRATE });
  output.addVideoTrack(video, { frameRate: FPS });
  output.addAudioTrack(sound);
  try {
    await output.start();
    // 音轨和画面同时写：封装器要按时间交错，先把一条写完可能卡住
    let audioError: unknown = null;
    const audioDone = sound.add(audio).catch((e: unknown) => { audioError = e; });
    // 画面：60FPS 虚拟时钟逐帧画
    const hud: HudState = { ...initialHud(), ...opts.hud, pulseScale: 1 };
    const events = timeline.events;
    let cursor = 0;
    let last = -1;
    let voiceClear = 0;
    for (let f = 0; f < totalFrames; f++) {
      check();
      if (audioError) throw audioError;
      const t = f / FPS;
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
      drawHud(ctx, hud, HUD_WIDTH, HUD_HEIGHT, opts.figure?.(t));
      await video.add(t, 1 / FPS);
      if (f % 20 === 0) {
        opts.onProgress?.("video", Math.min(99, Math.round(((f + 1) / totalFrames) * 100)));
        await new Promise((r) => setTimeout(r));     // 让进度条和"取消"按钮有机会响应
      }
    }
    await audioDone;
    if (audioError) throw audioError;
    await output.finalize();
    opts.onProgress?.("video", 100);
    return new Blob([target.buffer!], { type: "video/webm" });
  } catch (e) {
    await output.cancel().catch(() => undefined);
    throw e;
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
