// v4 阶段 8b 复审补的：暂停中跳段不念、结束要点两次、空格不抢按钮和动作卡、分享不行就下载、没有中文发音人时改用内置语音。
// 系统语音用替身（无头浏览器没有真的系统语音）：记下每次念了什么、当时是不是暂停中。
import { expect, test, type Page } from "@playwright/test";
import type { Course } from "@yangxia/course-core";
import { readFileSync } from "node:fs";
import { APP, liveButton, loadCourse, openSettings, startLive } from "./ui.ts";

const COURSE: Course = {
  schema: "yangxia.course/1", id: "c_livetest01", name: "跟练测试", age: "a18",
  source: { product: "18-39岁-居家版", week: 1 },
  blocks: [{ kind: "sets", items: [
    { exercise: "squat", name: "徒手深蹲", mode: "reps", sets: 2, reps: 3, tempo: { start: "down", down: 2, up: 1 }, rest: 10, quote: ["样例原文"] },
  ] }],
  presentation: { sequencer: { music: "none" } },   // 默认系统语音
};

/** 系统语音替身：voices 是发音人列表。 */
async function fakeTts(page: Page, voices: { lang: string; name: string }[]) {
  await page.addInitScript((voices) => {
    const said: string[] = [];
    (window as unknown as { __said: string[] }).__said = said;
    class U { text: string; lang = ""; voice: unknown = null; rate = 1; pitch = 1; volume = 1; onend: unknown = null; onerror: unknown = null;
      constructor(t: string) { this.text = t; } }
    const synth = {
      speaking: false, pending: false, paused: false,
      speak: (u: U) => { if (u.text.trim()) said.push(u.text); },
      cancel: () => undefined, resume: () => undefined, pause: () => undefined,
      getVoices: () => voices.map((v) => ({ ...v, voiceURI: v.name, default: false, localService: true })),
      addEventListener: () => undefined, removeEventListener: () => undefined,
    };
    Object.defineProperty(window, "speechSynthesis", { value: synth, configurable: true });
    Object.defineProperty(window, "SpeechSynthesisUtterance", { value: U, configurable: true });
  }, voices);
}
const said = (page: Page) => page.evaluate(() => (window as unknown as { __said: string[] }).__said.length);

test("暂停中跳段不念；结束点一次不会结束", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await fakeTts(page, [{ lang: "zh-CN", name: "Tingting" }]);
  await page.goto(APP);
  await loadCourse(page, COURSE, "跟练测试");
  await startLive(page);
  await expect.poll(() => said(page), { timeout: 10_000 }).toBeGreaterThan(0);   // 开头在念
  await liveButton(page, "[data-pause]").click();
  await expect(liveButton(page, "[data-resume]")).toBeVisible();
  const before = await said(page);
  // 暂停中往后跳两段、往前跳一段：都不念
  await liveButton(page, 'button[aria-label="下一段"]').click();
  await page.waitForTimeout(600);
  await liveButton(page, 'button[aria-label="下一段"]').click();
  await page.waitForTimeout(600);
  await liveButton(page, 'button[aria-label="上一段"]').click();
  await page.waitForTimeout(800);
  expect(await said(page), "暂停中没念").toBe(before);
  await expect(liveButton(page, "[data-resume]")).toBeVisible();
  // 继续以后接着念
  await liveButton(page, "[data-resume]").click();
  await expect.poll(() => said(page), { timeout: 10_000 }).toBeGreaterThan(before);

  // 结束点一次：只是提示再点一次，3 秒后复原，跟练还在
  const end = liveButton(page, "[data-end]");
  await end.click();
  await expect(end).toHaveText("再点一次结束");
  await page.waitForTimeout(3300);
  await expect(end).toHaveText(/^结束/);
  await expect(page.locator("[data-live]")).toBeVisible();
  // 跟练中背后的页面点不到（导航、开始按钮都不接焦点）
  expect(await page.evaluate(() => document.querySelector("main")!.inert && document.querySelector("nav")!.inert)).toBe(true);
  expect(errors).toEqual([]);
});

test("空格：没在跟练时，焦点在按钮或动作卡上是点它们自己", async ({ page }) => {
  await page.goto(APP);
  await loadCourse(page, COURSE, "跟练测试");
  await page.locator('[data-move="0"] summary').focus();
  await page.keyboard.press("Space");
  await expect(page.locator('[data-move="0"]')).toHaveAttribute("open", "");
  await expect(page.locator("[data-live]")).toHaveCount(0);
  await page.locator('[data-nav="settings"]').focus();
  await page.keyboard.press("Space");
  await expect(page.locator('[data-setting="breathLead"]')).toBeVisible();
  await expect(page.locator("[data-live]")).toHaveCount(0);
  // 焦点不在可点的东西上：空格开始
  await page.locator('[data-nav="today"]').click();
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press("Space");
  await expect(page.locator("[data-live]")).toBeVisible();
});

test("分享不行就改成下载练习记录", async ({ page }) => {
  await page.addInitScript(() => {
    const nav = navigator as Navigator & { canShare?: unknown; share?: unknown };
    Object.defineProperty(nav, "canShare", { value: () => true, configurable: true });
    Object.defineProperty(nav, "share", { value: () => Promise.reject(new DOMException("测试：不让分享", "NotAllowedError")), configurable: true });
  });
  await page.goto(APP);
  await loadCourse(page, { ...COURSE, presentation: { sequencer: { voiceEngine: "embedded", music: "none" } } }, "跟练测试");
  await startLive(page);
  const end = await page.locator("[data-live] [data-end], [data-live] .end-btn").filter({ visible: true }).first().elementHandle();
  await end!.click();
  await end!.click();
  await expect(page.locator("[data-done]")).toBeVisible();
  const [dl] = await Promise.all([page.waitForEvent("download"), page.locator("[data-share-record]").click()]);
  expect(dl.suggestedFilename()).toMatch(/^养夏_练习记录_\d{4}-\d{2}-\d{2}_\d{4}\.json$/);
  expect(JSON.parse(readFileSync((await dl.path())!, "utf8")).schema).toBe("yangxia.session/1");
  await expect(page.getByText("这台设备不能直接分享，已改成下载练习记录。")).toBeVisible();
});

test("系统语音只有别的语言的发音人：设置里写明，跟练改用内置语音、不拿别的语言念", async ({ page }) => {
  await fakeTts(page, [{ lang: "en-US", name: "Alex" }]);
  await page.goto(APP);
  await loadCourse(page, COURSE, "跟练测试");
  await openSettings(page);
  await expect(page.locator("[data-no-zh-voice]")).toContainText("没有中文发音人");
  await startLive(page);
  await page.waitForTimeout(2500);
  expect(await said(page), "没有用系统语音念").toBe(0);
});
