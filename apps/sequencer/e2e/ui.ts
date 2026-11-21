// e2e 共用：打开打包好的单文件、按新界面（今天 / 设置 / 更多，跟练全屏页、练完页）操作。
import { expect, type Page } from "@playwright/test";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const APP = pathToFileURL(join(here, "..", "dist-e2e", "养夏跟练编排器.html")).href;

/** 回到"今天"（练完页先选"不记录"），导入一节课。给了名字就等"已载入"出来。 */
export async function loadCourse(page: Page, course: unknown, name?: string): Promise<void> {
  await page.locator('[data-nav="today"]').click();
  if (await page.locator("[data-done]").count()) await page.getByRole("button", { name: "不记录" }).click();
  await page.setInputFiles('input[data-input="course"]', { name: "course.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(course)) });
  if (name) await expect(page.getByText(`已载入：${name}`).first()).toBeVisible();
}

export async function openSettings(page: Page): Promise<void> {
  await page.locator('[data-nav="settings"]').click();
}

/** 打开"更多"里的一项：export / editor / library / voice / notices。 */
export async function openMore(page: Page, row: string): Promise<void> {
  await page.locator('[data-nav="more"]').click();
  await page.locator(`[data-more-row="${row}"]`).click();
  await expect(page.locator(`[data-more="${row}"]`)).toBeVisible();
}

/** 分段按钮里选中的那个（data-value 是取值）。 */
export const pressed = (page: Page, key: string) => page.locator(`[data-setting="${key}"] button[aria-pressed="true"]`);
export const option = (page: Page, key: string, value: string) => page.locator(`[data-setting="${key}"] button[data-value="${value}"]`);

/** 跟练页上看得见的按钮（横屏时按钮在右栏，竖屏在下面，各有一份）。 */
export const liveButton = (page: Page, sel: string) => page.locator(`[data-live] ${sel}`).filter({ visible: true }).first();

export async function startLive(page: Page): Promise<void> {
  await page.locator('[data-nav="today"]').click();
  await page.locator("[data-start]").click();
  await expect(page.locator("[data-live]")).toBeVisible();
}

/** 结束跟练：结束要点两次。 */
export async function endLive(page: Page): Promise<void> {
  const end = page.locator("[data-live] [data-end], [data-live] .end-btn").filter({ visible: true }).first();
  const h = await end.elementHandle();
  await h!.click();
  await h!.click();
  await expect(page.locator("[data-live]")).toHaveCount(0);
}
