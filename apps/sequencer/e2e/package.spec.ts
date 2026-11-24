// 课程包（v4 阶段 8c）：打包好的编排器里标记和嵌入块各恰好一个；嵌了课程的编排器断网打开就是这节课，
// 能练、能保存记录、能导出；嵌的课程不合格时显示错误不载入；"换一节课"能选课程包；普通编排器不受影响。
import { expect, test, type Page } from "@playwright/test";
import type { Course } from "@yangxia/course-core";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { packageInfo, packCourse } from "../../../packages/course-core/src/package.ts";
import { APP, endLive, openMore, startLive } from "./ui.ts";

const COURSE: Course = {
  schema: "yangxia.course/1", id: "c_packagetest", name: "课程包测试 </script> 第 1 周", age: "a18",
  source: { product: "18-39岁-居家版", week: 1, day: "A", plan: "yangxia.plans/1" },
  blocks: [{ kind: "sets", items: [
    { exercise: "squat", name: "徒手深蹲", mode: "reps", sets: 1, reps: 3, tempo: { start: "down", down: 2, up: 1 }, rest: 5, quote: ["样例原文"], figure: "squat" },
    { exercise: "plank", name: "平板支撑", mode: "timed", sets: 1, duration: 6, rest: 0, quote: ["样例原文"], figure: "plank" },
  ] }],
  presentation: { sequencer: { voiceEngine: "embedded", music: "none" } },
};

const plain = readFileSync(new URL(APP));
const dir = mkdtempSync(join(tmpdir(), "yangxia-package-"));
function pkg(name: string, course: unknown): string {
  const r = packCourse(plain.toString("utf8"), course, "2026-11-24");
  if (!r.html) throw new Error(r.error);
  const f = join(dir, name);
  writeFileSync(f, r.html);
  return f;
}
const offline = (page: Page) => {
  const external: string[] = [];
  page.on("request", (r) => { if (!/^(file|data|blob):/.test(r.url())) external.push(r.url()); });
  return external;
};

test("打包好的编排器：标记和空嵌入块各恰好一个", () => {
  const html = plain.toString("utf8");
  expect(html.split('<meta name="yangxia-package"').length - 1).toBe(1);
  expect(html.split('id="yangxia-course"').length - 1).toBe(1);
  expect(packageInfo(html).info).toMatchObject({ format: "yangxia.package/1" });
  expect(html).toMatch(/<script type="application\/json" id="yangxia-course"><\/script>/);
});

test("打包标记和 course export 用同一个算法：源码哈希、动图哈希都对得上", async () => {
  const stamp = (await import(new URL("../../../scripts/sequencer-stamp.mjs", import.meta.url).href)) as {
    sourceHash: () => string | null; motionsHash: (t: string) => string;
  };
  const info = packageInfo(plain.toString("utf8")).info!;
  expect(info.source).toBe(stamp.sourceHash());
  const motions = readFileSync(new URL("../../../contracts/fixtures/data/motions.json", import.meta.url), "utf8");
  expect(info.motionsHash).toBe(stamp.motionsHash(motions));
  expect(info.motions).toBe((JSON.parse(motions) as { version: string }).version);
});

test("课程包：断网打开就是这节课，能练、能保存记录、能导出字幕", async ({ page, context }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const external = offline(page);
  await context.setOffline(true);
  await page.goto(pathToFileURL(pkg("小夏-第1段-第1周-A日.html", COURSE)).href);
  await expect(page).toHaveTitle("养夏 · 课程包测试 </script> 第 1 周");
  await expect(page.locator("[data-packaged]")).toHaveText("课程包 · 11 月 24 日导出");
  await expect(page.locator('[data-move="0"] .name')).toHaveText("徒手深蹲");
  await startLive(page);
  await page.waitForTimeout(500);
  await endLive(page);
  await expect(page.locator("[data-done]")).toBeVisible();
  const [rec] = await Promise.all([page.waitForEvent("download"), page.locator("[data-save-record]").click()]);
  const session = JSON.parse(readFileSync((await rec.path())!, "utf8"));
  expect(session.course.id).toBe("c_packagetest");
  await expect(page.getByText("发回电脑（发给自己，不要发到群里），交给 agent 导入").first()).toBeVisible();
  await openMore(page, "export");
  const [srt] = await Promise.all([page.waitForEvent("download"), page.locator('[data-export="srt"]').click()]);
  expect(readFileSync((await srt.path())!, "utf8")).toMatch(/-->/);
  expect(external).toEqual([]);
  expect(errors).toEqual([]);
});

test("嵌的课程不合格：显示错误、不载入", async ({ page }) => {
  await page.goto(pathToFileURL(pkg("坏的.html", { ...COURSE, id: "x" })).href);
  await expect(page.getByText("课程包里的课程不是合格的课程")).toBeVisible();
  await expect(page.locator("[data-start]")).toHaveCount(0);
  await expect(page).toHaveTitle("养夏 · 跟练编排器");
});

test("普通编排器不受影响；换一节课能选课程包", async ({ page }) => {
  await page.goto(APP);
  await expect(page).toHaveTitle("养夏 · 跟练编排器");
  await expect(page.locator("[data-packaged]")).toHaveCount(0);
  await page.setInputFiles('input[data-input="course"]', pkg("换课.html", COURSE));
  await expect(page.locator("[data-packaged]")).toBeVisible();
  await expect(page).toHaveTitle("养夏 · 课程包测试 </script> 第 1 周");
  // 不是课程包的网页
  await page.setInputFiles('input[data-input="course"]', { name: "别的.html", mimeType: "text/html", buffer: Buffer.from("<html><body>hi</body></html>") });
  await expect(page.getByText("「别的.html」不是养夏课程包。")).toBeVisible();
});
