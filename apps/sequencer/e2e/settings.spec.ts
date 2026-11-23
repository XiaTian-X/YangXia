// v4 阶段 8a、8b：报数时机和呼吸提示的设置（分段按钮）、设置记在本机、65 岁以上的下限、档案里的播放偏好优先。
import { expect, test, type Page } from "@playwright/test";
import type { Course } from "@yangxia/course-core";
import { APP, loadCourse, openSettings, option, pressed } from "./ui.ts";

const COURSE: Course = {
  schema: "yangxia.course/1", id: "c_settingstest", name: "设置测试", age: "a18",
  source: { product: "18-39岁-居家版", week: 1 },
  blocks: [{ kind: "sets", items: [
    { exercise: "squat", name: "徒手深蹲", mode: "reps", sets: 1, reps: 3, tempo: { start: "down", down: 2, up: 1 }, rest: 0, quote: ["样例原文"] },
  ] }],
  presentation: { sequencer: { voiceEngine: "embedded", music: "none" } },
};

async function load(page: Page, course: unknown, name: string) {
  await loadCourse(page, course, name);
  await openSettings(page);
}
const value = (page: Page, key: string) => pressed(page, key).getAttribute("data-value");

test("报数默认开始时报；呼吸提示的设置记在本机；65 岁以上不能选安静；档案偏好优先", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(APP);
  await load(page, COURSE, "设置测试");
  await expect.poll(() => value(page, "countTiming")).toBe("on-up");
  await expect.poll(() => value(page, "breathLead")).toBe("2");
  await expect.poll(() => value(page, "breathAfter")).toBe("pluck");
  // "视频导出""声音和音乐"平时收着，标题行写着现在的选择
  await expect(page.locator('[data-fold="video"]')).not.toHaveAttribute("open", "");
  await expect(page.locator('[data-fold="video"] summary')).toContainText("深色 · 左下角卡片");
  await expect(page.locator('[data-fold="sound"] summary')).toContainText("木鱼 · 背景音乐关闭");
  await page.locator('[data-fold="video"] summary').click();
  await option(page, "layout", "center").click();
  await expect(page.locator('[data-fold="video"] summary')).toContainText("深色 · 居中大字");
  await option(page, "layout", "overlay").click();
  // 示意图：一组 15 次，前 2 次说口令，之后响提示音
  await expect(page.locator(".reps-viz .voice")).toHaveCount(2);
  await expect(page.locator(".reps-viz .pluck")).toHaveCount(13);

  // 改了以后刷新页面、再载入课程，还是改过的值
  await option(page, "breathLead", "1").click();
  await option(page, "breathAfter", "quiet").click();
  await option(page, "countTiming", "on-rep").click();
  await expect(page.locator(".reps-viz .quiet")).toHaveCount(14);
  await page.reload();
  await load(page, COURSE, "设置测试");
  await expect.poll(() => value(page, "breathLead")).toBe("1");
  await expect.poll(() => value(page, "breathAfter")).toBe("quiet");
  await expect.poll(() => value(page, "countTiming")).toBe("on-rep");

  // 65 岁以上的课：本机偏好是"安静"，也按下限响提示音，"安静"选不了
  await load(page, { ...COURSE, id: "c_settingsold", name: "老人课", age: "a65" }, "老人课");
  await expect.poll(() => value(page, "breathAfter")).toBe("pluck");
  await expect(page.locator("[data-floor]")).toBeVisible();
  await expect(option(page, "breathAfter", "quiet")).toBeDisabled();
  // 关掉语音报数时连"领几次"也锁住（每个换气的拍都响提示音）
  await page.locator('input[data-setting="voiceBake"]').uncheck();
  await expect(option(page, "breathLead", "all")).toBeDisabled();
  await page.locator('input[data-setting="voiceBake"]').check();

  // 课程带档案里的播放偏好：盖过本机偏好，页面提示一句
  await load(page, { ...COURSE, id: "c_settingsprof", name: "档案课", coaching: { prefs: { countTiming: "on-up", breathLead: "all" } } }, "档案课");
  await expect.poll(() => value(page, "countTiming")).toBe("on-up");
  await expect.poll(() => value(page, "breathLead")).toBe("all");
  await expect.poll(() => value(page, "breathAfter")).toBe("quiet");
  await expect(page.locator("[data-from-profile]")).toBeVisible();
  expect(errors).toEqual([]);
});
