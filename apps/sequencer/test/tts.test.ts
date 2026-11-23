// 系统语音能不能念中文：有中文发音人 yes；发音人列表是空的 unknown（安卓 Edge，照 zh-CN 念）；只有别的语言 no（改用内置语音）。
import { afterEach, describe, expect, it } from "vitest";
import { chineseVoices, ttsChinese } from "../src/audio/tts.ts";

const g = globalThis as unknown as { window?: unknown };
function fakeVoices(list: { lang: string; name: string }[] | null) {
  if (!list) {
    delete g.window;
    return;
  }
  g.window = { speechSynthesis: { getVoices: () => list }, SpeechSynthesisUtterance: function SpeechSynthesisUtterance() {} };
}

describe("系统语音的中文检查", () => {
  afterEach(() => fakeVoices(null));

  it("有中文发音人", () => {
    fakeVoices([{ lang: "en-US", name: "Alex" }, { lang: "zh-CN", name: "Tingting" }]);
    expect(ttsChinese()).toBe("yes");
    expect(chineseVoices().map((v) => v.name)).toEqual(["Tingting"]);
  });

  it("发音人列表是空的：不知道，照 zh-CN 念", () => {
    fakeVoices([]);
    expect(ttsChinese()).toBe("unknown");
  });

  it("只有别的语言：不拿别的语言念中文", () => {
    fakeVoices([{ lang: "en-US", name: "Alex" }, { lang: "fr-FR", name: "Thomas" }]);
    expect(ttsChinese()).toBe("no");
    expect(chineseVoices()).toEqual([]);
  });

  it("浏览器没有系统语音", () => {
    expect(ttsChinese()).toBe("no");
  });
});
