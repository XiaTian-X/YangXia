// 动作示意动图：导出的课程显示动图，手写课程、关掉设置、改过动作名不显示；全程不访问外部地址。
import { expect, test, type Page } from "@playwright/test";
import { buildTimeline, type Course } from "@yangxia/course-core";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const APP = pathToFileURL(join(here, "..", "dist-e2e", "养夏跟练编排器.html")).href;

const COURSE: Course = {
  schema: "yangxia.course/1", id: "c_figuretest", name: "动图测试", age: "a18",
  source: { product: "18-39岁-居家版", week: 1, plan: "yangxia.plans/1" },
  blocks: [{ kind: "sets", items: [
    { exercise: "squat", name: "徒手深蹲", mode: "reps", sets: 1, reps: 3, tempo: { start: "down", down: 2, up: 1 }, rest: 5, quote: ["样例"], figure: "squat" },
    { exercise: "plank", name: "平板支撑", mode: "timed", sets: 1, duration: 6, rest: 0, quote: ["样例"], figure: "plank" },
  ] }],
  presentation: { sequencer: { voiceEngine: "embedded", music: "none" } },
};

async function load(page: Page, course: unknown) {
  await page.setInputFiles('input[data-input="course"]', { name: "course.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(course)) });
}

/** 图卡区域的统计：浅色底的像素占比，和用来比较两帧的指纹。 */
const card = (page: Page) => page.evaluate(() => {
  const c = document.querySelector("canvas.hud") as HTMLCanvasElement;
  const { data } = c.getContext("2d")!.getImageData(626, 218, 588, 378);
  let light = 0;
  let hash = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i] > 235 && data[i + 1] > 235 && data[i + 2] > 235) light++;
    hash = (Math.imul(hash, 31) + (data[i] >> 3)) | 0;
  }
  return { light: light / (data.length / 4), hash };
});
const shown = async (page: Page) => (await card(page)).light > 0.5;

test("动作示意：显示、不显示、动起来，不访问外部地址", async ({ page }) => {
  const errors: string[] = [];
  const external: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("request", (r) => { if (!/^(file|data|blob):/.test(r.url())) external.push(r.url()); });
  await page.goto(APP);

  // 导入课程后显示第一个动作的起始姿势
  await load(page, COURSE);
  await expect.poll(() => shown(page), { timeout: 20_000 }).toBe(true);
  const ready = (await card(page)).hash;

  // 路线图预览哪一段，图就显示哪个动作
  await page.locator('[data-stage="ex-1-set-1"]').click();
  await expect.poll(async () => (await card(page)).hash).not.toBe(ready);
  await page.locator('[data-stage="ex-0-set-1"]').click();
  await expect.poll(async () => (await card(page)).hash).toBe(ready);

  // 预览以后改组数：时间轴重算了，图还对着预览的那一段；那一段没了就回到开头
  await page.locator('[data-stage="ex-1-set-1"]').click();
  await expect.poll(async () => (await card(page)).hash).not.toBe(ready);
  const plank = (await card(page)).hash;
  const sets = page.getByLabel("组数");
  await sets.first().fill("2");           // 深蹲多一组，平板往后挪
  await page.waitForTimeout(300);
  expect((await card(page)).hash, "改了前面的组数，图还是预览的平板").toBe(plank);
  await sets.nth(1).fill("2");
  await page.locator('[data-stage="ex-1-set-2"]').click();
  await expect.poll(async () => (await card(page)).hash).toBe(plank);
  await sets.nth(1).fill("1");            // 预览的第 2 组没了
  await expect.poll(async () => (await card(page)).hash).toBe(ready);
  await load(page, COURSE);
  await expect.poll(async () => (await card(page)).hash).toBe(ready);

  // 关掉设置就不显示，打开又回来
  await page.getByRole("button", { name: "画面" }).click();
  const box = page.locator('input[data-setting="motionFigure"]');
  await expect(box).toBeChecked();
  await box.uncheck();
  await expect.poll(() => shown(page)).toBe(false);
  await box.check();
  await expect.poll(() => shown(page)).toBe(true);
  await page.getByRole("button", { name: "课程" }).click();

  // 跟练中关掉开头倒数：声音还按开始时的时间轴走，图也一样，还停在准备姿势
  await page.getByRole("button", { name: "开始跟练" }).click();
  await expect(page.getByText("跟练中", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "声音" }).click();
  await page.getByLabel("开头 3、2、1 倒数").uncheck();
  await page.waitForTimeout(400);
  expect((await card(page)).hash).toBe(ready);
  await page.getByRole("button", { name: "课程" }).click();

  // 下放的过程中画面在变
  const seen = new Set<number>();
  await expect.poll(async () => { seen.add((await card(page)).hash); return seen.size; }, { timeout: 25_000, intervals: [120] }).toBeGreaterThan(4);
  await page.getByRole("button", { name: "停止" }).click();
  await page.getByRole("button", { name: "不记录" }).click();
  expect((await card(page)).hash, "停下以后图留在停下的那一刻").not.toBe(ready);
  await load(page, COURSE);       // 恢复设置里的开头倒数
  await expect.poll(async () => (await card(page)).hash).toBe(ready);

  // 导出：可以取消；导出的视频里图在动，并且和同一时刻重画的图卡一致
  await page.locator('[data-export="webm"]').click();
  await page.getByRole("button", { name: "取消" }).click();
  await expect(page.getByText("已取消导出")).toBeVisible({ timeout: 30_000 });
  // 导出途中换一节课：正在导出的视频不受影响
  const finished = page.waitForEvent("download", { timeout: 150_000 });
  await page.locator('[data-export="webm"]').click();
  await expect(page.locator(".progress")).toBeVisible();
  await load(page, { ...COURSE, name: "中途换的课", source: { product: COURSE.source.product, week: 1 } });
  await expect(page.getByText("已载入：中途换的课")).toBeVisible();
  const dl = await finished;
  const webm = readFileSync((await dl.path())!).toString("base64");
  await load(page, COURSE);
  await expect.poll(() => shown(page)).toBe(true);
  const tl = buildTimeline(COURSE);
  const down = tl.motion.find((s) => s.kind === "phase" && s.phase === "down")!;
  const hold = tl.motion.find((s) => s.kind === "timed")!;
  const times = [down.start + 0.4, down.start + 1.6, hold.start + 1, hold.start + 4].map((t) => Math.round(t * 60) / 60);
  const got = await page.evaluate(async ({ webm, times }) => {
    const bytes = Uint8Array.from(atob(webm), (c) => c.charCodeAt(0));
    const v = document.createElement("video");
    v.muted = true;
    v.src = URL.createObjectURL(new Blob([bytes], { type: "video/webm" }));
    await new Promise((ok, no) => { v.onloadeddata = ok; v.onerror = no; });
    const [X, Y, W, H] = [626, 218, 588, 378];
    const read = (src: CanvasImageSource) => {
      const c = new OffscreenCanvas(W, H);
      const g = c.getContext("2d", { willReadFrequently: true })!;
      g.drawImage(src, X, Y, W, H, 0, 0, W, H);
      return g.getImageData(0, 0, W, H).data;
    };
    const diff = (a: Uint8ClampedArray, b: Uint8ClampedArray) => {
      let sum = 0;
      for (let i = 0; i < a.length; i += 4) sum += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
      return sum / (a.length / 4) / 3;
    };
    const frames: Uint8ClampedArray[] = [];
    const vsHud: number[] = [];
    for (const t of times) {
      await new Promise((ok) => { v.onseeked = ok; v.currentTime = t + 0.002; });
      const f = read(v);
      frames.push(f);
      vsHud.push(diff(f, read((window as unknown as { __hudAt: (t: number) => OffscreenCanvas }).__hudAt(t))));
    }
    return { vsHud, moved: diff(frames[0], frames[1]), held: diff(frames[2], frames[3]) };
  }, { webm, times });
  for (const d of got.vsHud) expect(d, "换课程以后的画面也要有图，并和重画的一致").toBeLessThan(6);
  expect(got.moved).toBeGreaterThan(1);      // 下放过程中人在动
  expect(got.held).toBeLessThan(1);          // 平板撑住不动

  // 编辑器改了动作名：这个动作不再显示
  await page.locator(".item-head input[type=text]").first().fill("别的动作");
  await expect.poll(() => shown(page)).toBe(false);

  // 手写课程（没有 source.plan）写了 figure 也不显示
  await load(page, { ...COURSE, source: { product: COURSE.source.product, week: 1 } });
  await expect(page.getByText("已载入：动图测试")).toBeVisible();
  await page.waitForTimeout(300);
  expect(await shown(page)).toBe(false);

  // 图号和动作对不上也不显示
  const wrong = structuredClone(COURSE);
  wrong.blocks[0].items[0].figure = "plank";
  await load(page, wrong);
  await page.waitForTimeout(300);
  expect(await shown(page)).toBe(false);

  // 第三方授权能打开
  await page.locator("[data-notices] summary").click();
  await expect(page.locator("[data-notices] pre")).toContainText("Mozilla Public License");

  expect(external).toEqual([]);
  expect(errors).toEqual([]);
});

test("动图引擎加载失败：不显示图，跟练和导出照常；导入音乐不受安全策略影响", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.addInitScript(() => {
    const fail = () => Promise.reject(new Error("测试：wasm 不可用"));
    WebAssembly.instantiate = fail as typeof WebAssembly.instantiate;
    WebAssembly.instantiateStreaming = fail as typeof WebAssembly.instantiateStreaming;
    WebAssembly.compile = fail as typeof WebAssembly.compile;
  });
  await page.goto(APP);
  await load(page, COURSE);
  await expect(page.locator("[data-figure-issue]")).toContainText("不显示动图", { timeout: 20_000 });
  expect(await shown(page)).toBe(false);
  await page.getByRole("button", { name: "开始跟练" }).click();
  await expect(page.getByText("跟练中", { exact: true })).toBeVisible();
  await page.waitForTimeout(500);
  await page.getByRole("button", { name: "停止" }).click();
  await page.getByRole("button", { name: "不记录" }).click();

  await page.getByRole("button", { name: "声音" }).click();
  await page.locator('select[data-setting="music"]').selectOption("file");
  const rate = 44100;
  const wav = Buffer.alloc(44 + rate * 2);
  wav.write("RIFF", 0); wav.writeUInt32LE(36 + rate * 2, 4); wav.write("WAVEfmt ", 8); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 2, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write("data", 36); wav.writeUInt32LE(rate * 2, 40);
  await page.locator('input[type=file][accept="audio/*"]').setInputFiles({ name: "音乐.wav", mimeType: "audio/wav", buffer: wav });
  await expect(page.getByText("音乐.wav")).toBeVisible();

  const [dl] = await Promise.all([page.waitForEvent("download", { timeout: 150_000 }), page.locator('[data-export="webm"]').click()]);
  expect(readFileSync((await dl.path())!).subarray(0, 4).toString("hex")).toBe("1a45dfa3");
  await expect(page.getByText(/已导出 WEBM（有 2 段动作示意没加载成功/)).toBeVisible();
  expect(errors).toEqual([]);
});

test("动图数据解不开：载入课程后提示还在，导出写明视频里没有动作示意", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.addInitScript(() => {
    (window as unknown as { DecompressionStream: unknown }).DecompressionStream = class {
      constructor() { throw new Error("测试：解不开"); }
    };
  });
  await page.goto(APP);
  await expect(page.locator("[data-figure-issue]")).toContainText("动作示意加载失败");
  await load(page, COURSE);
  await expect(page.getByText("已载入：动图测试")).toBeVisible();
  await page.waitForTimeout(500);
  await expect(page.locator("[data-figure-issue]")).toContainText("动作示意加载失败");
  expect(await shown(page)).toBe(false);
  const [dl] = await Promise.all([page.waitForEvent("download", { timeout: 150_000 }), page.locator('[data-export="webm"]').click()]);
  expect(readFileSync((await dl.path())!).subarray(0, 4).toString("hex")).toBe("1a45dfa3");
  await expect(page.getByText("已导出 WEBM（动作示意没加载成功，视频里不显示）")).toBeVisible();
  expect(errors).toEqual([]);
});
