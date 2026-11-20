// v4 阶段 8a：报数时机和呼吸提示的新设置、设置记在本机、65 岁以上的下限、档案里的播放偏好优先。
import { expect, test, type Page } from "@playwright/test";
import type { Course } from "@yangxia/course-core";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const APP = pathToFileURL(join(here, "..", "dist-e2e", "养夏跟练编排器.html")).href;

const COURSE: Course = {
  schema: "yangxia.course/1", id: "c_settingstest", name: "设置测试", age: "a18",
  source: { product: "18-39岁-居家版", week: 1 },
  blocks: [{ kind: "sets", items: [
    { exercise: "squat", name: "徒手深蹲", mode: "reps", sets: 1, reps: 3, tempo: { start: "down", down: 2, up: 1 }, rest: 0, quote: ["样例原文"] },
  ] }],
  presentation: { sequencer: { voiceEngine: "embedded", music: "none" } },
};

async function load(page: Page, course: unknown, name: string) {
  await page.getByRole("button", { name: "课程", exact: true }).click();
  await page.setInputFiles('input[data-input="course"]', { name: "course.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(course)) });
  await expect(page.getByText(`已载入：${name}`)).toBeVisible();
  await page.getByRole("button", { name: "声音" }).click();
}

test("报数默认开始时报；呼吸提示的设置记在本机；65 岁以上不能选安静；档案偏好优先", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(APP);
  await load(page, COURSE, "设置测试");
  const timing = page.locator('select[data-setting="countTiming"]');
  const lead = page.locator('select[data-setting="breathLead"]');
  const after = page.locator('select[data-setting="breathAfter"]');
  await expect(timing).toHaveValue("on-up");
  await expect(lead).toHaveValue("2");
  await expect(after).toHaveValue("pluck");

  // 改了以后刷新页面、再载入课程，还是改过的值
  await lead.selectOption("1");
  await after.selectOption("quiet");
  await timing.selectOption("on-rep");
  await page.reload();
  await load(page, COURSE, "设置测试");
  await expect(lead).toHaveValue("1");
  await expect(after).toHaveValue("quiet");
  await expect(timing).toHaveValue("on-rep");

  // 65 岁以上的课：本机偏好是"安静"，也按下限响提示音，"安静"选不了
  await load(page, { ...COURSE, id: "c_settingsold", name: "老人课", age: "a65" }, "老人课");
  await expect(after).toHaveValue("pluck");
  await expect(page.locator("[data-floor]")).toBeVisible();
  // Playwright 的 toBeDisabled 对 <option> 判断不准，直接读属性
  await expect.poll(() => after.locator('option[value="quiet"]').evaluate((o) => (o as HTMLOptionElement).disabled)).toBe(true);

  // 课程带档案里的播放偏好：盖过本机偏好，页面提示一句
  await load(page, { ...COURSE, id: "c_settingsprof", name: "档案课", coaching: { prefs: { countTiming: "on-up", breathLead: "all" } } }, "档案课");
  await expect(timing).toHaveValue("on-up");
  await expect(lead).toHaveValue("all");
  await expect(after).toHaveValue("quiet");
  await expect(page.locator("[data-from-profile]")).toBeVisible();
  expect(errors).toEqual([]);
});
