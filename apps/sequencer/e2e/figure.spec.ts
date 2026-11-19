// 动作示意动图：导出的课程显示动图，手写课程、关掉设置、改过动作名不显示；全程不访问外部地址。
import { expect, test, type Page } from "@playwright/test";
import type { Course } from "@yangxia/course-core";
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

  // 关掉设置就不显示，打开又回来
  await page.getByRole("button", { name: "画面" }).click();
  const box = page.locator('input[data-setting="motionFigure"]');
  await expect(box).toBeChecked();
  await box.uncheck();
  await expect.poll(() => shown(page)).toBe(false);
  await box.check();
  await expect.poll(() => shown(page)).toBe(true);
  await page.getByRole("button", { name: "课程" }).click();

  // 跟练：下放的过程中画面在变
  await page.getByRole("button", { name: "开始跟练" }).click();
  await expect(page.getByText("跟练中", { exact: true })).toBeVisible();
  const seen = new Set<number>();
  await expect.poll(async () => { seen.add((await card(page)).hash); return seen.size; }, { timeout: 25_000, intervals: [120] }).toBeGreaterThan(4);
  await page.getByRole("button", { name: "停止" }).click();
  await page.getByRole("button", { name: "不记录" }).click();

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
