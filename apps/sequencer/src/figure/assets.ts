// 动作示意的内嵌资源：动图数据和动画引擎都压缩后打进单文件，用的时候在浏览器里解开，不联网。
import type { MotionClip, MotionsData } from "@yangxia/course-core";
import { motionsGz, wasmGz } from "virtual:yangxia-figures";

async function gunzip(base64: string): Promise<Uint8Array<ArrayBuffer>> {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** 动图片段；这个版本没有内嵌动图（构建时模板不在）就是空表。 */
export async function loadClips(): Promise<Record<string, MotionClip>> {
  if (!motionsGz) return {};
  const data = JSON.parse(new TextDecoder().decode(await gunzip(motionsGz))) as MotionsData;
  return data.clips;
}

export async function wasmUrl(): Promise<string> {
  return URL.createObjectURL(new Blob([await gunzip(wasmGz)], { type: "application/wasm" }));
}
