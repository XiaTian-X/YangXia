import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { buildGoldenFixture, GOLDEN_PATH, type GoldenFixtureFile } from "./golden-player.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const RUNTIME_JS = join(ROOT, "packages", "course-core", "dist", "player-runtime.js");
const MOTIONS_JSON = join(ROOT, "contracts", "fixtures", "data", "motions.json");

describe("跨端黄金测试集（golden-player.json）与纯净沙箱 player-runtime.js 核对", () => {
  it("提交的 contracts/fixtures/golden-player.json 与当前核心库逐项一致", () => {
    expect(existsSync(GOLDEN_PATH)).toBe(true);
    const saved = JSON.parse(readFileSync(GOLDEN_PATH, "utf8")) as GoldenFixtureFile;
    const fresh = buildGoldenFixture();
    expect(saved).toEqual(fresh);
    // 关键约束自检：Emoji 备注精确截断为 500 个 Unicode 码点（不被拆成半个代理对）
    const c0 = saved.cases.find((c) => c.id === "home-default-on-up")!;
    expect([...(c0.expected.sessionCheck!.expectedSession.note as string)]).toHaveLength(500);
    // 有下限 + 关语音退回领 0 次 + 提示音音量 >= 15
    const floorVoiceOff = saved.cases.find((c) => c.id === "floor-voice-off-forces-pluck")!;
    expect(floorVoiceOff.expected.effectiveSettings.breathLead).toBe(0);
    expect(floorVoiceOff.expected.effectiveSettings.breathAfter).toBe("pluck");
    expect(floorVoiceOff.expected.effectiveSettings.breathVolume).toBeGreaterThanOrEqual(15);
    // 动图样例覆盖 squat / plank / gym-farmer-walk 与无效 figure(null)
    const mCase = saved.cases.find((c) => c.id === "motions-wrap-hold-loop-perside")!;
    const clipsSeen = new Set(mCase.expected.frameSamples.map((s) => s.motion?.clip ?? null));
    expect(clipsSeen.has("squat")).toBe(true);
    expect(clipsSeen.has("plank")).toBe(true);
    expect(clipsSeen.has("gym-farmer-walk")).toBe(true);
    expect(clipsSeen.has(null)).toBe(true);
  });

  it("dist/player-runtime.js 在无 Node/DOM API 的纯净 node:vm 沙箱中跑通全部黄金用例 0 偏差", () => {
    expect(existsSync(RUNTIME_JS)).toBe(true);
    const code = readFileSync(RUNTIME_JS, "utf8");
    const sandbox: Record<string, any> = {};
    vm.createContext(sandbox);
    vm.runInContext(code, sandbox);
    const P = sandbox.YangXiaPlayer;
    expect(P).toBeTruthy();

    const golden = JSON.parse(readFileSync(GOLDEN_PATH, "utf8")) as GoldenFixtureFile;
    const motions = JSON.parse(readFileSync(MOTIONS_JSON, "utf8"));
    const clips = motions.clips;

    for (const c of golden.cases) {
      const plan = P.buildPlayerPlan(c.course, c.devicePrefs, c.userPatch);
      expect(plan.floor, c.id).toBe(c.expected.floor);
      expect(plan.effectiveSettings, c.id).toEqual(c.expected.effectiveSettings);
      expect(plan.units, c.id).toEqual(c.expected.units);
      expect(Number(plan.timeline.totalDuration.toFixed(4)), c.id).toBe(c.expected.totalDuration);
      expect(plan.timeline.events.length, c.id).toBe(c.expected.eventCount);
      expect(plan.timeline.stages.length, c.id).toBe(c.expected.stageCount);

      for (const se of c.expected.sampleEvents) {
        expect(plan.timeline.events[se.index], `${c.id} ev[${se.index}]`).toEqual(se.event);
      }
      for (const fs of c.expected.frameSamples) {
        const frame = P.liveFrame(c.course, plan.timeline, fs.idx, fs.t);
        expect(frame, `${c.id} frame[${fs.idx}]`).toEqual(fs.frame);
        const m = P.motionAt(plan.timeline, c.course, clips, fs.t);
        const gotMotion = m && clips[m.clip]
          ? {
              clip: m.clip,
              frame: Number(m.frame.toFixed(4)),
              progress: Number(P.motionProgress(clips[m.clip], m.frame).toFixed(6)),
              note: m.note,
              perSide: m.perSide,
              itemIndex: m.itemIndex,
            }
          : null;
        expect(gotMotion, `${c.id} motion[${fs.idx}]`).toEqual(fs.motion);
      }
      if (c.expected.sessionCheck) {
        const sc = c.expected.sessionCheck;
        const gotSess = P.buildPlayerSession(c.course, plan.timeline, sc.playedIndices, {
          startedAt: sc.startedAt,
          endedAt: sc.endedAt,
          feeling: sc.feeling,
          symptoms: sc.symptoms,
          note: sc.note,
          edited: sc.edited,
        });
        expect(gotSess, `${c.id} session`).toEqual(sc.expectedSession);
      }
    }
  });
});
