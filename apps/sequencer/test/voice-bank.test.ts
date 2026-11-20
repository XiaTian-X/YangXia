// 自己录的报数声：整句优先；能全部用录音拼出来才拼；拼不全整句用合成音，一句话不混用两种声音。
import { describe, expect, it } from "vitest";
import { VoiceBank } from "../src/audio/voice-bank.ts";

const rng = () => 0.5;
const fresh = () => new VoiceBank("female", 60, rng);
const wave = (n: number, v: number) => new Float32Array(n).fill(v);
const same = (a: Float32Array | null, b: Float32Array | null) => !!a && !!b && a.length === b.length && a.every((x, i) => x === b[i]);

describe("VoiceBank：自己录的报数声", () => {
  it("整句录过就用整句", () => {
    const bank = fresh();
    const mine = wave(800, 0.3);
    bank.custom.set("准备下一组", mine);
    expect(bank.phrase("准备下一组")).toBe(mine);
    expect(bank.seconds("准备下一组")).toBeCloseTo(800 / 44100);
  });

  it("录了数字不会混进合成的句子里", () => {
    const bank = fresh();
    bank.custom.set("1", wave(500, 0.4));
    expect(bank.own("准备下一组")).toBeNull();
    expect(same(bank.phrase("准备下一组"), fresh().phrase("准备下一组"))).toBe(true);
  });

  it("没单独录的数用录过的 1–10 拼，缺一个就整句用合成音", () => {
    const bank = fresh();
    bank.custom.set("1", wave(300, 0.1));
    bank.custom.set("2", wave(300, 0.2));
    bank.custom.set("10", wave(300, 0.3));
    expect(bank.own("12")).not.toBeNull();
    expect(bank.own("11")).not.toBeNull();
    expect(bank.own("21")).not.toBeNull();
    expect(bank.own("13")).toBeNull();
    expect(same(bank.phrase("13"), fresh().phrase("13"))).toBe(true);
    const whole = wave(400, 0.9);
    bank.custom.set("12", whole);
    bank.clearPhraseCache();
    expect(bank.own("12")).toBe(whole);
  });

  it("“12，本组完成”用数字和口令拼；口令没录就整句用合成音", () => {
    const bank = fresh();
    bank.custom.set("12", wave(400, 0.5));
    expect(bank.own("12，本组完成")).toBeNull();
    expect(same(bank.phrase("12，本组完成"), fresh().phrase("12，本组完成"))).toBe(true);
    bank.custom.set("本组完成", wave(600, 0.6));
    bank.clearPhraseCache();
    const got = bank.phrase("12，本组完成")!;
    expect(got.length).toBeGreaterThan(600);     // 两段录音交叠拼接：比单段长，不超过两段之和
    expect(got.length).toBeLessThanOrEqual(1000);
    expect(same(got, fresh().phrase("12，本组完成"))).toBe(false);
  });

  it("删掉录音、清缓存后回到合成音", () => {
    const bank = fresh();
    bank.custom.set("开始", wave(700, 0.2));
    expect(bank.phrase("开始")!.length).toBe(700);
    bank.custom.delete("开始");
    bank.clearPhraseCache();
    expect(same(bank.phrase("开始"), fresh().phrase("开始"))).toBe(true);
  });

  it("带数字的话整句录", () => {
    const bank = fresh();
    const mine = wave(1200, 0.2);
    bank.custom.set("休息 60 秒", mine);
    expect(bank.phrase("休息 60 秒")).toBe(mine);
    expect(bank.own("休息 30 秒")).toBeNull();
  });

  it("“3，吸”用录过的数字和口令拼；口令没录就整句用合成音", () => {
    const bank = fresh();
    bank.custom.set("3", wave(300, 0.3));
    expect(bank.own("3，吸")).toBeNull();
    bank.custom.set("吸", wave(300, 0.4));
    bank.clearPhraseCache();
    expect(bank.own("3，吸")).not.toBeNull();
    expect(same(bank.phrase("3，吸"), fresh().phrase("3，吸"))).toBe(false);
  });
});
