// v4 阶段 8b：五种尺寸（手机竖屏、手机横屏、小屏安卓、平板、电脑）——没有横向滚动，"开始跟练"在第一屏，
// 正文（动作名、成品原文、声明）不小于 16 像素；跟练页各块都在屏幕里、两两不重叠（练和休息两种状态）；
// 练完页、设置、更多也不横向滚动。另加几种手机浏览器带工具栏时的实际可视高度，只查跟练页。
import { expect, test, type Page } from "@playwright/test";
import type { Course } from "@yangxia/course-core";
import { APP, endLive, liveButton, loadCourse, openMore, openSettings, startLive } from "./ui.ts";

const COURSE: Course = {
  schema: "yangxia.course/1", id: "c_layouttest", name: "尺寸测试", age: "a18",
  source: { product: "18-39岁-居家版", week: 1, day: "A", plan: "yangxia.plans/1" },
  blocks: [{ kind: "sets", items: [
    { exercise: "squat", name: "徒手深蹲", mode: "reps", sets: 2, reps: 15, tempo: { start: "down", down: 2, up: 1 }, rest: 90, quote: ["样例原文"], figure: "squat" },
    { exercise: "split-squat", name: "原地分腿蹲", mode: "reps", sets: 2, reps: 10, perSide: true, tempo: { start: "down", down: 2, up: 1 }, rest: 90, quote: ["样例原文"] },
    { exercise: "glute-bridge", name: "臀桥", mode: "reps", sets: 2, reps: 20, tempo: { start: "up", up: 1, top: 2, down: 2 }, rest: 60, quote: ["样例原文"] },
    { exercise: "wall-sit", name: "靠墙静蹲", mode: "timed", sets: 2, duration: 30, rest: 60, quote: ["样例原文"] },
  ] }],
  presentation: { sequencer: { voiceEngine: "embedded", music: "none" } },
};

const SIZES = [
  { name: "手机竖屏", width: 390, height: 844 },
  { name: "手机横屏", width: 844, height: 390 },
  { name: "小屏安卓", width: 360, height: 800 },
  { name: "平板", width: 820, height: 1180 },
  { name: "电脑", width: 1440, height: 900 },
];

/** 手机浏览器带工具栏时的实际可视高度、矮的横屏窗口：只查跟练页。 */
const VIEWPORTS = [
  { name: "iPhone Safari 带工具栏", width: 390, height: 664 },
  { name: "安卓 Chrome", width: 360, height: 720 },
  { name: "小 iPhone", width: 375, height: 667 },
  { name: "矮的横屏窗口", width: 1280, height: 560 },
  { name: "小横屏平板", width: 960, height: 600 },
  { name: "很矮的手机横屏", width: 780, height: 300 },
];

const LIVE_PARTS = [".live-head", ".live-figure", ".ring", ".live-center .info", ".live-next", ".controls", ".live-foot", ".live-list", ".live-end"];

/** 跟练页看得见的各块：都在屏幕里、两两不重叠（横屏时按钮和声明在右栏，各算一块）。 */
async function liveLayout(page: Page, what: string) {
  const boxes = await page.evaluate((sels) => {
    const out: { sel: string; x: number; y: number; w: number; h: number }[] = [];
    for (const sel of sels) {
      for (const el of document.querySelectorAll<HTMLElement>(`[data-live] ${sel}`)) {
        const r = el.getBoundingClientRect();
        if (el.offsetParent === null || r.width === 0 || r.height === 0) continue;
        // .info 用里面实际内容的范围（它本身占满一格的宽度）
        const kids = sel.endsWith(".info") ? [...el.children].map((c) => c.getBoundingClientRect()).filter((b) => b.width && b.height) : [r];
        if (!kids.length) continue;
        const x = Math.min(...kids.map((b) => b.left)), y = Math.min(...kids.map((b) => b.top));
        out.push({ sel, x, y, w: Math.max(...kids.map((b) => b.right)) - x, h: Math.max(...kids.map((b) => b.bottom)) - y });
      }
    }
    return out;
  }, LIVE_PARTS);
  const vp = page.viewportSize()!;
  for (const b of boxes) {
    expect(b.x >= -0.5 && b.y >= -0.5 && b.x + b.w <= vp.width + 0.5 && b.y + b.h <= vp.height + 0.5, `${what}：${b.sel} 在屏幕里`).toBe(true);
  }
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i], b = boxes[j];
      const ov = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) > 0.5 && Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) > 0.5;
      expect(ov, `${what}：${a.sel} 和 ${b.sel} 不重叠`).toBe(false);
    }
  }
  // 环里的字不出环
  const ringOk = await page.evaluate(() => {
    const ring = document.querySelector("[data-live] .ring")!.getBoundingClientRect();
    return [...document.querySelectorAll("[data-live] .ring .val > *")].every((e) => {
      const r = e.getBoundingClientRect();
      return r.width === 0 || (r.left >= ring.left - 0.5 && r.right <= ring.right + 0.5 && r.top >= ring.top - 0.5 && r.bottom <= ring.bottom + 0.5);
    });
  });
  expect(ringOk, `${what}：环里的字不出环`).toBe(true);
}

/** 看得见的这些元素字号都不小于 min。 */
async function minFont(page: Page, sel: string, min: number) {
  const sizes = await page.evaluate((sel) => [...document.querySelectorAll<HTMLElement>(sel)].filter((e) => e.offsetParent !== null).map((e) => parseFloat(getComputedStyle(e).fontSize)), sel);
  expect(sizes.length, `${sel} 看得见`).toBeGreaterThan(0);
  for (const s of sizes) expect(s, `${sel} 字号`).toBeGreaterThanOrEqual(min);
}

const noHScroll = async (page: Page, where: string) =>
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), `${where}没有横向滚动`).toBeLessThanOrEqual(0);

/** 元素整个在屏幕里。 */
async function inView(page: Page, sel: ReturnType<Page["locator"]>, what: string) {
  const box = await sel.boundingBox();
  const vp = page.viewportSize()!;
  expect(box, `${what}看得见`).not.toBeNull();
  expect(box!.x, `${what}没出左边`).toBeGreaterThanOrEqual(0);
  expect(box!.y, `${what}没出上边`).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width, `${what}没出右边`).toBeLessThanOrEqual(vp.width + 0.5);
  expect(box!.y + box!.height, `${what}没出下边`).toBeLessThanOrEqual(vp.height + 0.5);
}

for (const size of SIZES) {
  test(`${size.name} ${size.width}×${size.height}`, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.setViewportSize({ width: size.width, height: size.height });
    await page.goto(APP);
    await noHScroll(page, "导入页");
    expect(await page.evaluate(() => parseFloat(getComputedStyle(document.body).fontSize)), "正文字号").toBeGreaterThanOrEqual(16);

    await loadCourse(page, COURSE, "尺寸测试");
    await noHScroll(page, "今天的课");
    await inView(page, page.locator("[data-start]"), "开始跟练");
    await expect(page.locator(".today .disclaimer")).toContainText("未经专业审核，不是医学建议，不能替代医生的判断");
    // 正文字号：动作名、声明、点开后的成品原文
    await minFont(page, ".move .name", 16);
    await minFont(page, ".today .disclaimer span", 16);
    await page.locator('[data-move="0"] summary').click();
    await minFont(page, ".move .quote", 16);

    await startLive(page);
    for (const [sel, what] of [["[data-pause]", "暂停"], ['button[aria-label="上一段"]', "上一段"], ['button[aria-label="下一段"]', "下一段"]] as const) {
      await inView(page, liveButton(page, sel), what);
    }
    await inView(page, page.locator("[data-live] .ring"), "次数环");
    await inView(page, page.locator("[data-live] [data-end], [data-live] .end-btn").filter({ visible: true }).first(), "结束");
    await expect(page.locator("[data-live] .disc").filter({ visible: true }).first()).toHaveText("未经专业审核，不是医学建议，不能替代医生的判断。疼、头晕、胸闷马上停下。");
    await liveLayout(page, "练");
    // 休息：倒数按课程写的秒数
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    await expect(page.locator("[data-live]")).toHaveAttribute("data-mode", "rest");
    await expect(page.locator("[data-live] .ring .small")).toHaveText("秒，共 90 秒");
    await liveLayout(page, "休息");
    await endLive(page);

    await expect(page.locator("[data-done]")).toBeVisible();
    await noHScroll(page, "练完页");
    // 跟练页关掉的那一帧页面还锁着滚动，等它放开再量
    await expect(async () => inView(page, page.locator("[data-save-record]"), "保存练习记录")).toPass({ timeout: 3_000 });
    await page.getByRole("button", { name: "不记录" }).click();

    await openSettings(page);
    await noHScroll(page, "设置");
    await openMore(page, "export");
    await noHScroll(page, "导出");
    expect(errors).toEqual([]);
  });
}

for (const size of VIEWPORTS) {
  test(`跟练页 ${size.name} ${size.width}×${size.height}`, async ({ page }) => {
    await page.setViewportSize({ width: size.width, height: size.height });
    await page.goto(APP);
    await loadCourse(page, COURSE, "尺寸测试");
    await startLive(page);
    await liveLayout(page, "练");
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    await expect(page.locator("[data-live]")).toHaveAttribute("data-mode", "rest");
    await liveLayout(page, "休息");
    // 暂停（标记在顶部）
    await page.keyboard.press("Space");
    await expect(page.locator("[data-live] .paused")).toBeVisible();
    await liveLayout(page, "暂停");
    await endLive(page);
  });
}
