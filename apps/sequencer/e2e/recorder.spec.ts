// 录报数声：按句列这节课要说的话（不按字），点"录"开始、点"停"结束，录了的句子标出来、能删。
// 用 Chromium 的假麦克风（一段提示音），只测流程，不测音质。
import { expect, test } from "@playwright/test";
import type { Course } from "@yangxia/course-core";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const APP = pathToFileURL(join(here, "..", "dist-e2e", "养夏跟练编排器.html")).href;

test.use({
  launchOptions: { args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] },
  permissions: ["microphone"],
});

const COURSE: Course = {
  schema: "yangxia.course/1", id: "c_recordertest", name: "录音测试", age: "a18",
  source: { product: "18-39岁-居家版", week: 1 },
  blocks: [{ kind: "sets", items: [
    { exercise: "squat", name: "徒手深蹲", mode: "reps", sets: 2, reps: 3, tempo: { start: "down", down: 2, up: 1 }, rest: 12, quote: ["样例"] },
  ] }],
  presentation: { sequencer: { voiceEngine: "embedded", music: "none" } },
};

test("录报数声：按句列这节课要说的话，点停结束录音", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(APP);
  await page.getByRole("button", { name: "录报数声" }).click();
  await expect(page.getByText("还没载入课程")).toBeVisible();
  await expect(page.locator('[data-phrase="准备下一组"]')).toBeVisible();

  await page.getByRole("button", { name: "课程", exact: true }).click();
  await page.setInputFiles('input[data-input="course"]', { name: "course.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(COURSE)) });
  await expect(page.getByText("已载入：录音测试")).toBeVisible();
  await page.getByRole("button", { name: "录报数声" }).click();
  await expect(page.getByText("下面是这节课要说的话")).toBeVisible();
  for (const p of ["准备", "开始", "本组完成", "全部完成", "准备下一组", "休息 12 秒", "3"]) await expect(page.locator(`[data-phrase="${p}"]`), p).toBeVisible();
  for (const p of ["第", "组", "下", "秒", "准备下一项", "3，本组完成"]) await expect(page.locator(`[data-phrase="${p}"]`), p).toHaveCount(0);

  const card = page.locator('[data-phrase="准备下一组"]');
  await card.getByRole("button", { name: "录" }).click();
  await expect(card.getByRole("button", { name: "停" })).toBeVisible();
  await expect(page.locator('[data-phrase="开始"]').getByRole("button", { name: "录" })).toBeDisabled();
  await page.waitForTimeout(1200);
  await card.getByRole("button", { name: "停" }).click();
  await expect(card).toHaveClass(/custom/, { timeout: 10_000 });
  await card.getByRole("button", { name: "删" }).click();
  await expect(card).not.toHaveClass(/custom/);
  expect(errors).toEqual([]);
});
