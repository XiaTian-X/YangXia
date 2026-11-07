export interface WebmMuxerOptions {
  width: number;
  height: number;
  fps: number;
  /** "V_VP9" 或 "V_VP8" */
  videoCodecId: string;
  sampleRate: number;
  channels: number;
  durationMs: number;
}

export interface WebmMuxer {
  addVideoChunk(data: Uint8Array, timestampUs: number, isKey: boolean): void;
  addAudioChunk(data: Uint8Array, timestampUs: number): void;
  finalize(): Blob;
}

export function createSimpleWebmMuxer(opts: WebmMuxerOptions): WebmMuxer;
