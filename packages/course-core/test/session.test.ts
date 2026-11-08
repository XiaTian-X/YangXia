// 练习记录：编排器"跟练了什么"和记录里"完成了几组"要对得上；生成的记录要能通过档案检查。
import { describe, expect, it } from "vitest";
import { validateSession } from "../src/profile.ts";
import { buildSession, setsDoneFromPlayed } from "../src/session.ts";
import { buildTimeline } from "../src/timeline.ts";
import type { Course } from "../src/types.ts";
import { courseFixtures } from "./helpers.ts";

const base = { startedAt: new Date("2026-11-09T19:00:00Z"), endedAt: new Date("2026-11-09T19:40:00Z"), feeling: "正好" as const,
  symptoms: { pain: false, dizzy: false, chest: false } };
const all = (n: number) => Array.from({ length: n }, (_, i) => i);

describe("练习记录的完成组数", () => {
  for (const [name, raw] of courseFixtures("ok-")) {
    const course = raw as Course;
    it(`${name}：完整跟练一遍，每个动作完成组数 = 计划组数`, () => {
      const tl = buildTimeline(course);
      const rec = buildSession(course, { ...base, setsDone: setsDoneFromPlayed(tl.events, all(tl.events.length)) }) as any;
      for (const it of rec.items) expect(it.setsDone, it.exercise).toBe(it.setsPlanned);
      expect(validateSession(rec)).toEqual([]);
    });
  }

  it("跳过的组不算完成，倒回去重练也只算一次", () => {
    const [, raw] = courseFixtures("ok-").find(([n]) => n === "ok-a18-home-w1-a.json")!;
    const course = raw as Course;
    const tl = buildTimeline(course);
    const firstItem = tl.events.map((e, i) => (e.itemIndex === 0 ? i : -1)).filter((i) => i >= 0);
    const played = [...firstItem, ...firstItem];                    // 只练了第一个动作，而且练了两遍
    const rec = buildSession(course, { ...base, setsDone: setsDoneFromPlayed(tl.events, played) }) as any;
    expect(rec.items[0].setsDone).toBe(rec.items[0].setsPlanned);
    for (const it of rec.items.slice(1)) {
      expect(it.setsDone).toBe(0);
      expect(it.skipped).toBe(true);
    }
  });

  it("循环：完成的是轮数", () => {
    const [, raw] = courseFixtures("ok-").find(([n]) => n === "ok-a18-home-w1-d-circuit.json")!;
    const course = raw as Course;
    const tl = buildTimeline(course);
    const rec = buildSession(course, { ...base, setsDone: setsDoneFromPlayed(tl.events, all(tl.events.length)) }) as any;
    const circuit = course.blocks.find((b) => b.kind === "circuit")!;
    expect(circuit.kind === "circuit" && rec.items.some((it: any) => it.setsPlanned === circuit.rounds)).toBe(true);
  });

  it("记录里完成组数多于计划时，档案检查报错", () => {
    const [, raw] = courseFixtures("ok-")[0];
    const rec = buildSession(raw as Course, { ...base, setsDone: {} }) as any;
    rec.items[0].setsDone = rec.items[0].setsPlanned + 1;
    expect(validateSession(rec).some((i) => i.level === "error" && i.path === "items[0].setsDone")).toBe(true);
  });
});
