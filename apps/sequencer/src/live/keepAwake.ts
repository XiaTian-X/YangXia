// 跟练时屏幕常亮：先用系统的屏幕常亮（Wake Lock）；不支持或被拒（安卓上从文件打开时常见）
// 就循环播放一段看不见的静音小视频（画布生成，不用文件、不联网），手机一般就不会自动锁屏。
type Sentinel = { release: () => Promise<void>; addEventListener: (t: "release", f: () => void) => void };

export class KeepAwake {
  mode: "lock" | "video" | "none" = "none";
  private lock: Sentinel | null = null;
  private video: HTMLVideoElement | null = null;
  private tick: ReturnType<typeof setInterval> | null = null;
  private active = false;
  private readonly onVisible = () => {
    // 切到后台时系统会收回常亮，回来再要一次
    if (this.active && document.visibilityState === "visible" && this.mode === "lock" && !this.lock) void this.requestLock();
  };

  async start(): Promise<void> {
    if (this.active) return;
    this.active = true;
    document.addEventListener("visibilitychange", this.onVisible);
    if (await this.requestLock()) return;
    this.startVideo();
  }

  async stop(): Promise<void> {
    this.active = false;
    document.removeEventListener("visibilitychange", this.onVisible);
    const lock = this.lock;
    this.lock = null;
    await lock?.release().catch(() => undefined);
    if (this.tick) clearInterval(this.tick);
    this.tick = null;
    this.video?.remove();
    this.video = null;
    this.mode = "none";
  }

  private async requestLock(): Promise<boolean> {
    const wl = (navigator as unknown as { wakeLock?: { request: (t: "screen") => Promise<Sentinel> } }).wakeLock;
    if (!wl) return false;
    try {
      const lock = await wl.request("screen");
      this.lock = lock;
      this.mode = "lock";
      lock.addEventListener("release", () => { if (this.lock === lock) this.lock = null; });
      return true;
    } catch {
      return false;
    }
  }

  private startVideo(): void {
    try {
      const c = document.createElement("canvas");
      c.width = 16;
      c.height = 16;
      const g = c.getContext("2d");
      const stream = (c as HTMLCanvasElement & { captureStream?: (fps: number) => MediaStream }).captureStream?.(2);
      if (!g || !stream) return;
      let n = 0;
      this.tick = setInterval(() => { g.fillStyle = n++ % 2 ? "#000" : "#010101"; g.fillRect(0, 0, 16, 16); }, 500);
      const v = document.createElement("video");
      v.muted = true;
      v.playsInline = true;
      v.loop = true;
      v.setAttribute("aria-hidden", "true");
      v.style.cssText = "position:fixed;width:2px;height:2px;opacity:0.01;pointer-events:none;left:0;bottom:0";
      v.srcObject = stream;
      document.body.appendChild(v);
      this.video = v;
      this.mode = "video";
      void v.play().catch(() => { this.mode = "none"; });
    } catch {
      this.mode = "none";
    }
  }
}
