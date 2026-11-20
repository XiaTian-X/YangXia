// 本机偏好：只记动过的项；读写失败照常能用；读进来的照样清洗。
import { DEFAULT_SETTINGS } from "@yangxia/course-core";
import { beforeEach, describe, expect, it } from "vitest";
import { loadPrefs, savePrefs } from "../src/ui/prefs.ts";

const store = new Map<string, string>();
const fake = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) };

describe("本机偏好", () => {
  beforeEach(() => {
    store.clear();
    (globalThis as { localStorage?: unknown }).localStorage = fake;
  });
  it("只记这次改了的项，下次读回来", () => {
    savePrefs(DEFAULT_SETTINGS, { ...DEFAULT_SETTINGS, breathAfter: "quiet" });
    savePrefs(DEFAULT_SETTINGS, { ...DEFAULT_SETTINGS, countTiming: "on-rep" });
    expect(loadPrefs()).toEqual({ breathAfter: "quiet", countTiming: "on-rep" });
  });
  it("存的东西坏了、写错了：读不出的丢掉", () => {
    store.set("yangxia.sequencer.prefs.v1", JSON.stringify({ bpm: 999, breathLead: 3, breath: "off" }));
    expect(loadPrefs()).toEqual({ breathLead: 3, breathAfter: "quiet" });
    store.set("yangxia.sequencer.prefs.v1", "{不是 JSON");
    expect(loadPrefs()).toEqual({});
  });
  it("存储用不了（无痕模式、被禁）照常能用", () => {
    (globalThis as { localStorage?: unknown }).localStorage = { getItem: () => { throw new Error("禁用"); }, setItem: () => { throw new Error("禁用"); } };
    expect(loadPrefs()).toEqual({});
    expect(() => savePrefs(DEFAULT_SETTINGS, { ...DEFAULT_SETTINGS, bpm: 70 })).not.toThrow();
  });
});
