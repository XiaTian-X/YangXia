// 自己录报数声要录的话：按句列，不按字；"12，本组完成"拆成数字和口令。
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { RECORD_WORDS, recordUnits } from "../src/voice.ts";
import { buildTimeline } from "../src/timeline.ts";
import type { Course } from "../src/types.ts";

const sample = JSON.parse(readFileSync(new URL("../../../contracts/fixtures/courses/ok-a18-home-w1-a.json", import.meta.url), "utf8")) as Course;

describe("recordUnits", () => {
  it("没有课程时列 1–10 和全部固定口令", () => {
    const u = recordUnits([]);
    expect(u.numbers).toEqual(["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"]);
    expect(u.words).toEqual([...RECORD_WORDS]);
    expect(u.counted).toEqual([]);
  });

  it("按句列：整句口令不拆字，数字和本组完成分开，带数字的话整句", () => {
    const u = recordUnits(["准备", "3", "开始", "12，本组完成", "10，全部完成", "休息 60 秒", "30秒", "准备下一组", null, "吸", "左侧", "12"]);
    expect(u.words).toEqual(["准备", "开始", "吸", "本组完成", "全部完成", "准备下一组"]);
    expect(u.numbers).toEqual(["3", "10", "12"]);
    expect(u.counted).toEqual(["30秒", "休息 60 秒"]);
  });

  it("带数字的话按数字排", () => {
    expect(recordUnits(["休息 90 秒", "5秒", "休息 30 秒", "15秒"]).counted).toEqual(["5秒", "15秒", "休息 30 秒", "休息 90 秒"]);
  });

  it("真实课程：列出的每一句都在时间轴里说到，单字词元（第、组、秒、下、百）不出现", () => {
    const voices = buildTimeline(sample).events.map((e) => e.voice);
    const u = recordUnits(voices);
    const said = new Set(voices.filter(Boolean) as string[]);
    for (const w of [...u.words, ...u.counted]) expect(said.has(w), w).toBe(true);
    for (const single of ["第", "组", "秒", "下", "百", "0"]) expect([...u.words, ...u.numbers, ...u.counted]).not.toContain(single);
    expect(u.words).toContain("准备");
    expect(u.numbers.length).toBeGreaterThan(0);
  });
});
