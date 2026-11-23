// 冒烟测试：打开 dist-e2e/养夏跟练编排器.html（npm run e2e 用离线样例的动图打包） → 导入短课程 → 跟练（暂停、切后台自动暂停、
// 从"这节课"列表跳过第一个动作）、练完、保存练习记录 → 在"更多 → 导出"里导出 SRT / WAV / WebM，
// 并和核心库在 Node 里算出的时间轴对数（SRT 最后一条时间码、WAV 时长）。
import { buildSrt, buildTimeline, validateSession, type Course } from "@yangxia/course-core";
import { expect, test, type Download, type Page } from "@playwright/test";
import { ALL_FORMATS, BufferSource, Input } from "mediabunny";
import { readFileSync } from "node:fs";
import { VoiceBank } from "../src/audio/voice-bank.ts";
import { APP, liveButton, loadCourse, openMore, openSettings, pressed, startLive } from "./ui.ts";

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
  // 用户看得到的地方不出现 Keep（打包进来的第三方库、授权全文不算）
  const visible = await page.evaluate(() => {
    const body = document.body.cloneNode(true) as HTMLElement;
    body.querySelectorAll("script, style, [data-notices]").forEach((x) => x.remove());
    const options = [...document.querySelectorAll("option")].map((o) => `${o.value} ${o.textContent}`);
    return [document.title, body.textContent, ...options, ...Object.keys(localStorage)].join("\n");
  });
  expect(visible).not.toMatch(/keep/i);

  await loadCourse(page, COURSE, "冒烟测试");
  await openSettings(page);
  await expect(pressed(page, "voiceEngine")).toHaveAttribute("data-value", "embedded");

  // 跟练：全屏页盖住整个页面，声明常驻
  await startLive(page);
  await expect(page.locator("[data-live]")).toContainText("未经专业审核，不是医学建议，不能替代医生的判断。疼、头晕、胸闷马上停下。");
  const clock = () => page.locator("[data-live] .clock").textContent();
  await page.waitForTimeout(1500);

  // 暂停：课程时间不走；继续以后接着走
  await liveButton(page, "[data-pause]").click();
  await expect(liveButton(page, "[data-resume]")).toBeVisible();
  await expect(page.locator("[data-live] .paused")).toBeVisible();
  const frozen = await clock();
  await page.waitForTimeout(1500);
  expect(await clock()).toBe(frozen);
  await liveButton(page, "[data-resume]").click();
  await expect.poll(clock, { timeout: 5_000 }).not.toBe(frozen);

  // 切到后台（锁屏、切应用）自动暂停
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
  });
  await expect(liveButton(page, "[data-resume]")).toBeVisible();
  // 空格继续（键盘）
  await page.keyboard.press("Space");
  await expect(liveButton(page, "[data-pause]")).toBeVisible();

  // 从"这节课"列表直接跳到第二个动作（第一个动作整组跳过），练到结束 → 练完页
  await page.locator('[data-live] [data-stage="ex-1-set-1"]').click();
  await expect(page.locator("[data-done]")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("heading", { name: "练完了" })).toBeVisible();
  // 每个动作的补充：找级的感受（照成品原话）、当场退回
  await page.locator('[data-item="1"] .options button', { hasText: "做到上限还很轻松" }).click();
  await page.locator('[data-item="0"] input[type="checkbox"]').check();
  // 有不适：马上提示
  await page.locator('[data-symptom="dizzy"]').click();
  await expect(page.getByRole("alert")).toContainText("尽快就医");
  await page.locator('[data-symptom="dizzy"]').click();
  const session = JSON.parse((await saved(page, () => page.locator("[data-save-record]").click())).toString("utf8"));
  expect(session.schema).toBe("yangxia.session/1");
  expect(session.feeling).toBe("正好");
  expect(session.items.map((i: any) => [i.exercise, i.setsPlanned, i.setsDone, i.skipped]))
    .toEqual([["squat", 1, 0, true], ["plank", 1, 1, false]]);
  expect(session.items[0].reverted).toBe(true);
  expect(session.items[1].feel).toBe("做到上限还很轻松");
  expect(session.items[0].feel).toBeUndefined();
  expect(validateSession(session)).toEqual([]);

  await expect(page.locator("[data-done]")).toHaveCount(0);
  const tl = expected();
  await openMore(page, "export");

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

  // WebM：EBML 文件头、封装器名字，读回轨道、时长（元数据里没有 Keep）
  const webm = await saved(page, () => page.locator('[data-export="webm"]').click(), 150_000);
  expect(webm.subarray(0, 4).toString("hex")).toBe("1a45dfa3");
  expect(webm.length).toBeGreaterThan(10_000);
  expect(webm.subarray(0, 4096).includes(Buffer.from("Mediabunny"))).toBe(true);
  expect(webm.subarray(0, 4096).toString("latin1")).not.toMatch(/keep/i);
  const file = new Input({ formats: ALL_FORMATS, source: new BufferSource(webm) });
  const videoTrack = (await file.getPrimaryVideoTrack())!;
  const audioTrack = (await file.getPrimaryAudioTrack())!;
  expect(["vp9", "vp8"]).toContain(videoTrack.codec);
  expect([await videoTrack.getCodedWidth(), await videoTrack.getCodedHeight()]).toEqual([1280, 720]);
  expect([audioTrack.codec, await audioTrack.getSampleRate(), await audioTrack.getNumberOfChannels()]).toEqual(["opus", 48000, 2]);
  expect(Math.abs(await file.computeDuration() - tl.totalDuration)).toBeLessThan(0.1);

  expect(errors).toEqual([]);
});
