// v4 阶段 8b：五种尺寸（手机竖屏、手机横屏、小屏安卓、平板、电脑）——没有横向滚动，"开始跟练"在第一屏，
// 正文字号不小于 16 像素；跟练页的暂停、上一段、下一段、结束和声明都在屏幕里；练完页、设置、更多也不横向滚动。
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
    await expect(page.locator(".today .disclaimer")).toContainText("未经专业审核");
    // 动作名、规格的字号
    expect(await page.locator(".move .name").first().evaluate((e) => parseFloat(getComputedStyle(e).fontSize))).toBeGreaterThanOrEqual(16);

    await startLive(page);
    for (const [sel, what] of [["[data-pause]", "暂停"], ['button[aria-label="上一段"]', "上一段"], ['button[aria-label="下一段"]', "下一段"]] as const) {
      await inView(page, liveButton(page, sel), what);
    }
    await inView(page, page.locator("[data-live] .ring"), "次数环");
    await inView(page, page.locator("[data-live] [data-end], [data-live] .end-btn").filter({ visible: true }).first(), "结束");
    await expect(page.locator("[data-live] .disc").filter({ visible: true }).first()).toContainText("未经专业审核");
    // 环和按钮不重叠
    const ring = (await page.locator("[data-live] .ring").boundingBox())!;
    const pause = (await liveButton(page, "[data-pause]").boundingBox())!;
    const overlap = ring.x < pause.x + pause.width && pause.x < ring.x + ring.width && ring.y < pause.y + pause.height && pause.y < ring.y + ring.height;
    expect(overlap, "次数环和暂停按钮不重叠").toBe(false);
    // 休息：倒数按课程写的秒数
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    await expect(page.locator("[data-live]")).toHaveAttribute("data-mode", "rest");
    await expect(page.locator("[data-live] .ring .small")).toHaveText("秒，共 90 秒");
    await inView(page, page.locator("[data-live] .ring"), "休息倒数环");
    await endLive(page);

    await expect(page.locator("[data-done]")).toBeVisible();
    await noHScroll(page, "练完页");
    await inView(page, page.locator("[data-save-record]"), "保存练习记录");
    await page.getByRole("button", { name: "不记录" }).click();

    await openSettings(page);
    await noHScroll(page, "设置");
    await openMore(page, "export");
    await noHScroll(page, "导出");
    expect(errors).toEqual([]);
  });
}
