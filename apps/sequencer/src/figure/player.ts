// 动作示意的播放器：每段动图一个 dotLottie，画在离屏画布上，按帧号取画面。不自己播放，帧号由核心库 motionAt 算。
import { DotLottie } from "@lottiefiles/dotlottie-web";
import type { MotionClip } from "@yangxia/course-core";
import { wasmUrl } from "./assets.ts";

const CANVAS_W = 840;
const CANVAS_H = 540;
const LOAD_TIMEOUT_MS = 20_000;

interface Entry {
  player: DotLottie;
  canvas: OffscreenCanvas;
}

export class FigurePlayer {
  private entries = new Map<string, Entry>();
  private engine: Promise<void> | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  /** 必须在创建播放器之前指向内嵌的引擎，否则库会去 CDN 下载。 */
  private prepareEngine(): Promise<void> {
    this.engine ??= wasmUrl().then((url) => DotLottie.setWasmUrl(url));
    return this.engine;
  }

  private loadOne(id: string, clip: MotionClip): Promise<void> {
    return new Promise((resolve, reject) => {
      const canvas = new OffscreenCanvas(CANVAS_W, CANVAS_H);
      const timer = setTimeout(() => reject(new Error("加载超时")), LOAD_TIMEOUT_MS);
      const player = new DotLottie({ canvas, data: JSON.stringify(clip.lottie), autoplay: false, loop: false, useFrameInterpolation: true,
        renderConfig: { autoResize: false, devicePixelRatio: 1, freezeOnOffscreen: false } });
      player.addEventListener("load", () => {
        clearTimeout(timer);
        this.entries.set(id, { player, canvas });
        resolve();
      });
      player.addEventListener("loadError", (e) => {
        clearTimeout(timer);
        player.destroy();
        reject(e.error);
      });
    });
  }

  /** 只留这节课要用的片段。返回没加载成功的片段号：它们只是不显示，不影响跟练。 */
  prepare(ids: string[], clips: Record<string, MotionClip>): Promise<string[]> {
    const run = async () => {
      const failed: string[] = [];
      for (const [id, e] of this.entries) {
        if (!ids.includes(id)) {
          e.player.destroy();
          this.entries.delete(id);
        }
      }
      if (!ids.length) return failed;
      try {
        await this.prepareEngine();
      } catch {
        this.engine = null;
        return ids;
      }
      for (const id of ids) {
        if (this.entries.has(id)) continue;
        try {
          await this.loadOne(id, clips[id]);
        } catch {
          failed.push(id);
        }
      }
      return failed;
    };
    const job = this.queue.then(run, run);
    this.queue = job.catch(() => undefined);
    return job;
  }

  /** 定到某一帧并返回画面；还没加载好就是 null。 */
  frame(id: string, frame: number): OffscreenCanvas | null {
    const e = this.entries.get(id);
    if (!e) return null;
    try {
      e.player.setFrame(frame);
      return e.canvas;
    } catch {
      return null;
    }
  }
}
