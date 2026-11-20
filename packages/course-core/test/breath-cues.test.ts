// v4 阶段 8a：报数时机、呼吸提示的两个设置（领几次 + 领完以后）、报数和呼吸口令拼句、下限、设置校验。
import { describe, expect, it } from "vitest";
import { applyFloor, breathFloor, DEFAULT_SETTINGS, normalizeSettings, settingsOf } from "../src/settings.ts";
import { buildTimeline, type TimelineEvent } from "../src/timeline.ts";
import type { Course, CourseItem, PlaybackSettings } from "../src/types.ts";
import { validateCourse } from "../src/validate.ts";
import { canSpeak, recordUnits, voiceTokens } from "../src/voice.ts";

function course(items: CourseItem[], extra: Partial<Course> = {}): Course {
  return { schema: "yangxia.course/1", id: "c_breathtest", name: "测试", age: "a18",
    source: { product: "18-39岁-居家版", week: 1 }, blocks: [{ kind: "sets", items }], ...extra };
}
/** 深蹲：先下放 2 秒、再发力 1 秒；每组 5 次，2 组，休息 30 秒。 */
const squat: CourseItem = { exercise: "squat", name: "徒手深蹲", mode: "reps", sets: 2, reps: 5,
  tempo: { start: "down", down: 2, up: 1 }, rest: 30, quote: ["样例原文"] };
/** 平板：撑 20 秒，2 组。 */
const plank: CourseItem = { exercise: "plank", name: "平板支撑", mode: "timed", sets: 2, duration: 20, rest: 30, quote: ["样例原文"] };

const run = (items: CourseItem[], settings: Partial<PlaybackSettings>, legacy = false) =>
  buildTimeline(course(items), { settings, legacy }).events;
const BREATH_WORDS = /^(呼|吸|深吸气|慢呼气)$|，(呼|吸)$/;
const breathVoices = (evs: TimelineEvent[]) => evs.filter((e) => e.voice && BREATH_WORDS.test(e.voice));
/** 某一组（第 s 组）的动作拍。 */
const setBeats = (evs: TimelineEvent[], s: number) => evs.filter((e) => e.state === "action" && e.tag.includes(`第 ${s}/`));
/** 第几次：按次动作的拍子标签写着"第 r 次"。 */
const repOf = (e: TimelineEvent) => Number(/第 (\d+) 次/.exec(e.label)?.[1] ?? 0);

describe("旧的四档对应到两个新设置", () => {
  it("normalizeSettings 照对应读，新设置已经写了的不动", () => {
    expect(normalizeSettings({ breath: "coach" } as never)).toEqual({ breathLead: 2, breathAfter: "pluck" });
    expect(normalizeSettings({ breath: "full-voice" } as never)).toEqual({ breathLead: "all", breathAfter: "pluck" });
    expect(normalizeSettings({ breath: "pluck" } as never)).toEqual({ breathLead: 0, breathAfter: "pluck" });
    expect(normalizeSettings({ breath: "off" } as never)).toEqual({ breathLead: 0, breathAfter: "quiet" });
    expect(normalizeSettings({ breath: "off", breathLead: 3 } as never)).toEqual({ breathLead: 3, breathAfter: "quiet" });
  });
  it("课程 presentation 里的旧值照样读", () => {
    const st = settingsOf(course([squat], { presentation: { sequencer: { breath: "full-voice" } as never } }));
    expect([st.breathLead, st.breathAfter]).toEqual(["all", "pluck"]);
  });
  it("默认：每次开始时报数，领 2 次 + 提示音（等于原来的领呼）", () => {
    expect([DEFAULT_SETTINGS.countTiming, DEFAULT_SETTINGS.breathLead, DEFAULT_SETTINGS.breathAfter]).toEqual(["on-up", 2, "pluck"]);
  });
});

describe("呼吸提示：按次、撑住、组间休息", () => {
  it("关闭（0 次 + 安静）：完全没有呼吸口令和提示音，休息时也不出声", () => {
    const evs = run([squat, plank], { breathLead: 0, breathAfter: "quiet" });
    expect(breathVoices(evs)).toEqual([]);
    expect(evs.filter((e) => e.breathPluck)).toEqual([]);
  });
  it("只用提示音（0 次 + 提示音）：没有口令，按次、撑住、休息都有提示音", () => {
    const evs = run([squat, plank], { breathLead: 0, breathAfter: "pluck" });
    expect(breathVoices(evs)).toEqual([]);
    expect(evs.some((e) => e.breathPluck && !e.breathPluck.isRestPhase && e.isTimedMode)).toBe(true);
    expect(evs.some((e) => e.breathPluck && !e.breathPluck.isRestPhase && !e.isTimedMode)).toBe(true);
    expect(evs.some((e) => e.breathPluck?.isRestPhase)).toBe(true);
  });
  it("领 2 次 + 提示音：每组前 2 次说口令，之后提示音；每组重新领", () => {
    const evs = run([squat], { breathLead: 2, breathAfter: "pluck", countTiming: "on-rep" });
    for (const s of [1, 2]) {
      const beats = setBeats(evs, s);
      const spokenReps = new Set(beats.filter((e) => e.voice && /呼|吸/.test(e.voice)).map(repOf));
      expect([...spokenReps].sort()).toEqual([1, 2]);
      expect(beats.filter((e) => repOf(e) > 2 && e.breathPluck).length).toBeGreaterThan(0);
    }
  });
  it("领 2 次 + 安静：领完以后不响提示音", () => {
    const evs = run([squat], { breathLead: 2, breathAfter: "quiet" });
    const beats = setBeats(evs, 1).filter((e) => !e.isTimedMode);
    expect(beats.filter((e) => repOf(e) > 2 && (e.breathPluck || (e.voice && BREATH_WORDS.test(e.voice))))).toEqual([]);
  });
  it("全程：每一次换气的拍都有口令或拼句", () => {
    const evs = run([squat], { breathLead: "all", breathAfter: "pluck", lastThreeBoost: false });
    const reps = new Set(setBeats(evs, 1).filter((e) => e.voice && /呼|吸/.test(e.voice)).map(repOf));
    expect(reps.size).toBe(5);
  });
  it("撑住类：领 2 次就是开始后第 2、4 秒（开头报秒数那一拍不算），之后按设置", () => {
    const pluck = run([plank], { breathLead: 2, breathAfter: "pluck" }).filter((e) => e.isTimedMode && e.tag.includes("第 1/"));
    const t0 = pluck[0].time;
    expect(pluck.filter((e) => e.voice === "呼" || e.voice === "吸").map((e) => [Math.round(e.time - t0), e.voice])).toEqual([[2, "吸"], [4, "呼"]]);
    expect(pluck.filter((e) => e.breathPluck && e.time - t0 > 5).length).toBeGreaterThan(0);
    const quiet = run([plank], { breathLead: 2, breathAfter: "quiet" }).filter((e) => e.isTimedMode && e.tag.includes("第 1/"));
    expect(quiet.filter((e) => e.breathPluck && e.time - t0 > 5)).toEqual([]);
  });
  it("组间休息：0 次不说话；全程和领完响提示音的说满；领完安静的只说开头一个呼吸循环", () => {
    const restVoices = (st: Partial<PlaybackSettings>) =>
      run([squat], st).filter((e) => e.state === "rest" && (e.voice === "深吸气" || e.voice === "慢呼气")).length;
    expect(restVoices({ breathLead: 0, breathAfter: "pluck" })).toBe(0);
    const full = restVoices({ breathLead: "all", breathAfter: "pluck" });
    expect(full).toBeGreaterThan(4);
    expect(restVoices({ breathLead: 2, breathAfter: "pluck" })).toBe(full);
    expect(restVoices({ breathLead: 2, breathAfter: "quiet" })).toBe(2);
    const quietRest = run([squat], { breathLead: 2, breathAfter: "quiet" }).filter((e) => e.state === "rest");
    expect(quietRest.filter((e) => e.breathPluck).length).toBe(2);
  });
});

describe("报数时机和拼句", () => {
  it("每次开始时报：数字落在每次的第一拍；最后一次做完报本组完成", () => {
    const evs = setBeats(run([squat], { countTiming: "on-up", lastThreeBoost: false, breathLead: 0 }), 1);
    const firsts = evs.filter((e) => e.dotIdx === 0);
    expect(firsts.map((e) => e.voice)).toEqual(["1", "2", "3", "4", "5"]);
    expect(evs.filter((e) => e.cueType === "rep").at(-1)!.voice).toBe("本组完成");
  });
  it("报数那一拍正好要说口令：连着说\"一，吸\"；兼容开关下不拼、口令降成提示音", () => {
    const evs = setBeats(run([squat], { countTiming: "on-up", lastThreeBoost: false, breathLead: 2 }), 1);
    expect(evs.filter((e) => e.dotIdx === 0).map((e) => e.voice)).toEqual(["1，吸", "2，吸", "3", "4", "5"]);
    const old = setBeats(run([squat], { countTiming: "on-up", lastThreeBoost: false, breathLead: 2 }, true), 1);
    const first = old.find((e) => e.dotIdx === 0)!;
    expect([first.voice, first.breathPluck?.direction]).toEqual(["1", "inhale"]);
  });
  it("\"最后三次\"不拼，照响提示音", () => {
    const evs = setBeats(run([{ ...squat, reps: 3 }], { countTiming: "on-up", breathLead: "all" }), 1);
    const first = evs.find((e) => e.dotIdx === 0)!;
    expect([first.voice, first.breathPluck?.direction]).toEqual(["最后三次", "inhale"]);
  });
  it("做完时报数时，发力那一拍的\"呼\"也拼上（以前会丢）", () => {
    const evs = setBeats(run([squat], { countTiming: "on-rep", lastThreeBoost: false, breathLead: 2 }), 1);
    expect(evs.filter((e) => e.cueType === "rep").map((e) => e.voice).slice(0, 3)).toEqual(["1，呼", "2，呼", "3"]);
  });
  it("所有设置组合下的语音都在内置词表里", () => {
    for (const countTiming of ["on-up", "on-rep"] as const) {
      for (const breathLead of [0, 1, 2, "all"] as const) {
        for (const breathAfter of ["quiet", "pluck"] as const) {
          const bad = run([squat, plank], { countTiming, breathLead, breathAfter }).filter((e) => e.voice && !canSpeak(e.voice));
          expect(bad.map((e) => e.voice)).toEqual([]);
        }
      }
    }
  });
  it("拼句的读法；录报数声把它拆成数字和口令", () => {
    expect(voiceTokens("12，吸")).toEqual(["10_short", "2", "吸"]);
    expect(voiceTokens("3，呼")).toEqual(["3", "呼"]);
    const u = recordUnits(["3，吸", "12，呼"]);
    expect(u.numbers).toEqual(["3", "12"]);
    expect(u.words).toEqual(["呼", "吸"]);
  });
});

describe("下限和档案里的播放偏好", () => {
  const quiet = { breathLead: 2, breathAfter: "quiet" } as const;
  it("65 岁以上的课：就算没写 coaching，领完以后也至少响提示音", () => {
    const c = course([squat], { age: "a65" });
    expect(breathFloor(c)).toBe("pluck");
    expect(settingsOf(c, quiet).breathAfter).toBe("pluck");
  });
  it("课程写了下限的成人课也一样；全程满足下限", () => {
    const c = course([squat], { coaching: { floor: "pluck" } });
    expect(settingsOf(c, quiet).breathAfter).toBe("pluck");
    expect(applyFloor({ ...DEFAULT_SETTINGS, breathLead: "all", breathAfter: "quiet" }, "pluck").breathAfter).toBe("quiet");
    expect(settingsOf(course([squat]), quiet).breathAfter).toBe("quiet");
  });
  it("档案里的播放偏好盖过课程的 presentation，编排器这次的设置再盖过它", () => {
    const c = course([squat], { presentation: { sequencer: { countTiming: "on-up" } }, coaching: { prefs: { countTiming: "on-rep" } } });
    expect(settingsOf(c).countTiming).toBe("on-rep");
    expect(settingsOf(c, { countTiming: "on-up" }).countTiming).toBe("on-up");
  });
});

describe("课程里设置的取值校验", () => {
  const issues = (extra: Record<string, unknown>) => validateCourse({ ...course([squat]), ...extra }).issues;
  it("和安全有关的写错报错，外观项写错只提醒", () => {
    expect(issues({ presentation: { sequencer: { breathAfter: "loud" } } }).some((i) => i.level === "error")).toBe(true);
    expect(issues({ presentation: { sequencer: { breathLead: -1 } } }).some((i) => i.level === "error")).toBe(true);
    expect(issues({ presentation: { sequencer: { breath: "loud" } } }).some((i) => i.level === "error")).toBe(true);
    const looks = issues({ presentation: { sequencer: { bpm: 500, background: "pink" } } });
    expect(looks.filter((i) => i.level === "error")).toEqual([]);
    expect(looks.filter((i) => i.level === "warning").length).toBe(2);
    expect(issues({ presentation: { sequencer: { breath: "coach", breathLead: "all", breathAfter: "quiet" } } }).filter((i) => i.level === "error")).toEqual([]);
  });
  it("coaching：下限只能是 pluck；档案偏好只能写三项", () => {
    expect(issues({ coaching: { floor: "quiet" } }).some((i) => i.level === "error")).toBe(true);
    expect(issues({ coaching: { prefs: { bpm: 60 } } }).some((i) => i.level === "error")).toBe(true);
    expect(issues({ coaching: { prefs: { countTiming: "later" } } }).some((i) => i.level === "error")).toBe(true);
    expect(issues({ coaching: { floor: "pluck", prefs: { breathLead: 0, breathAfter: "quiet", countTiming: "on-rep" } } }).filter((i) => i.level === "error")).toEqual([]);
  });
});
