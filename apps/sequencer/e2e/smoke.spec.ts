// 冒烟测试：打开 dist/养夏跟练编排器.html → 导入短课程 → 跟练、停止、导出练习记录 → 导出 SRT / WAV / WebM，
// 并和核心库在 Node 里算出的时间轴对数（SRT 最后一条时间码、WAV 时长）。
import { buildSrt, buildTimeline, type Course } from "@yangxia/course-core";
import { expect, test, type Download, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { VoiceBank } from "../src/audio/voice-bank.ts";

const here = dirname(fileURLToPath(import.meta.url));
const APP = pathToFileURL(join(here, "..", "dist", "养夏跟练编排器.html")).href;

const COURSE: Course = {
  schema: "yangxia.course/1", id: "c_smoketest1", name: "冒烟测试", age: "a18",
  source: { product: "18-39岁-居家版", week: 1 },
  blocks: [{ kind: "sets", items: [
    { exercise: "squat", name: "徒手深蹲", mode: "reps", sets: 1, reps: 3, tempo: { start: "down", down: 2, up: 1 }, rest: 5, quote: ["样例"] },
    { exercise: "plank", name: "平板支撑", mode: "timed", sets: 1, duration: 6, rest: 0, quote: ["样例"] },
  ] }],
  presentation: { sequencer: { voiceEngine: "embedded" } },
};

const expected = () => {
  const bank = new VoiceBank("female", 60, () => 0.5);
  return buildTimeline(COURSE, { voiceDuration: bank.seconds });
};

async function saved(page: Page, click: () => Promise<void>, timeout = 60_000): Promise<Buffer> {
  const [dl]: [Download, void] = await Promise.all([page.waitForEvent("download", { timeout }), click()]);
  return readFileSync((await dl.path())!);
}

test("养夏跟练编排器：导入、跟练、导出", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.goto(APP);
  await expect(page).toHaveTitle("养夏 · 跟练编排器");
  expect(await page.content()).not.toMatch(/keep/i);

  await page.setInputFiles('input[data-input="course"]', { name: "course.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(COURSE)) });
  await expect(page.getByText("已载入：冒烟测试")).toBeVisible();
  await expect(page.locator('select[data-setting="voiceEngine"]')).toHaveCount(0); // 设置在"声音"标签页里
  await page.getByRole("button", { name: "声音" }).click();
  await expect(page.locator('select[data-setting="voiceEngine"]')).toHaveValue("embedded");
  await page.getByRole("button", { name: "课程" }).click();

  // 跟练一小段再停止 → 练习记录
  await page.getByRole("button", { name: "开始跟练" }).click();
  await expect(page.getByText("跟练中")).toBeVisible();
  await page.waitForTimeout(2500);
  await page.getByRole("button", { name: "停止" }).click();
  await expect(page.getByText("练习记录", { exact: true })).toBeVisible();
  const session = JSON.parse((await saved(page, () => page.getByRole("button", { name: "导出练习记录" }).click())).toString("utf8"));
  expect(session.schema).toBe("yangxia.session/1");
  expect(session.items).toHaveLength(2);
  expect(session.feeling).toBe("正好");

  const tl = expected();

  // SRT：条数和最后一条时间码与核心库一致
  const srt = (await saved(page, () => page.locator('[data-export="srt"]').click())).toString("utf8");
  const want = buildSrt(tl.events, tl.totalDuration).trim().split("\r\n\r\n");
  const got = srt.trim().split("\r\n\r\n");
  expect(got.length).toBe(want.length);
  expect(got.at(-1)!.split("\r\n")[1]).toBe(want.at(-1)!.split("\r\n")[1]);

  // WAV：44.1kHz 双声道 16 位，时长等于时间轴总时长
  const wav = await saved(page, () => page.locator('[data-export="wav"]').click());
  expect(wav.toString("ascii", 0, 4)).toBe("RIFF");
  const sr = wav.readUInt32LE(24);
  const ch = wav.readUInt16LE(22);
  const seconds = (wav.length - 44) / (sr * ch * 2);
  expect(sr).toBe(44100);
  expect(ch).toBe(2);
  expect(Math.abs(seconds - tl.totalDuration)).toBeLessThan(2 / sr);

  // WebM：EBML 文件头、封装器名字
  const webm = await saved(page, () => page.locator('[data-export="webm"]').click(), 150_000);
  expect(webm.subarray(0, 4).toString("hex")).toBe("1a45dfa3");
  expect(webm.length).toBeGreaterThan(10_000);
  expect(webm.includes(Buffer.from("YangXia-Sequencer"))).toBe(true);

  expect(errors).toEqual([]);
});
