// 按训练单导出课程、按训练单和档案进度核对课程。只用 contracts/fixtures/（训练单是离线样例节选），模板仓库不在也会跑。
import { describe, expect, it } from "vitest";
import { checkCourse } from "../src/check.ts";
import { baseTempo, checkPlanCourse, exportCourse, isStartCourse } from "../src/plan.ts";
import type { Course } from "../src/types.ts";
import { FIX, clone, fitAge, fixtureManifest, fixturePlans, fixtureReadProduct, fixtureRules, readJson } from "./helpers.ts";

const manifest = fixtureManifest();
const plans = fixturePlans();
const rules = fixtureRules();
const STAGE: Record<string, string> = { a13: "初中", a18: "18–39 岁", a40: "40–64 岁", a65: "65 岁以上" };
const DATES = ["2026-10-12", "2026-10-19", "2026-10-26", "2026-11-02"];

/** 某份成品、练到第 week 周的档案（筛查全答"否"，医生同意），条件默认按正文那一边。 */
function profile(product: string, week = 1, extra: Record<string, any> = {}) {
  const p = readJson<Record<string, any>>(`${FIX}profiles/ok-a18-home.json`);
  const prod = manifest.products.find((x) => x.name === product)!;
  Object.assign(p, { age: prod.age, stage: STAGE[prod.age], product, venue: prod.venue, startDate: DATES[0] });
  delete p.wake;
  delete p.bedtime;
  p.screening = { answers: manifest.intake.screening.find((s) => s.age === prod.age)!.items.map((item) => ({ item, answer: "否" })), doctorCleared: true, date: DATES[0], doctorDate: DATES[0] };
  fitAge(p, prod.age);
  p.segments = Array.from({ length: week }, (_, i) => ({ n: 1, type: "标准", week: i + 1, start: DATES[i], product }));
  if (plans.products[product]?.phase === "稳定") {
    // 稳定期：一段 12 周，日期从今天往前排（开始日期不能是将来）
    const day = (n: number) => new Date(new Date("2026-11-02T12:00:00Z").getTime() + n * 86_400_000).toISOString().slice(0, 10);
    p.segments = Array.from({ length: week }, (_, i) => ({ n: 1, phase: "稳定", type: "标准", week: i + 1, start: day(-7 * (week - 1 - i)), product }));
    p.startDate = p.segments[0].start;
    p.screening.date = p.screening.doctorDate = p.startDate;
  }
  p.conditions = Object.fromEntries(Object.entries(rules.conditions).map(([k, v]) => [k, v.text]));
  p.choices = ["table-row", "door-row", "a13-bar-row"];
  return Object.assign(p, extra);
}
const ex = (product: string, week: number, day: string, extra: Record<string, any> = {}, opts: Record<string, any> = {}) =>
  exportCourse({ plans, rules, manifest, profile: profile(product, week, extra), week, day, ...opts });
const errors = (c: Course, p: Record<string, any>) =>
  checkCourse(c, { manifest, readProduct: fixtureReadProduct, profile: p, plans, rules }).filter((i) => i.level === "error").map((i) => i.message);

describe("每份成品、每周每天都能导出，导出的课程按训练单核对 0 错误", () => {
  for (const [product, p] of Object.entries(plans.products)) {
    it(product, () => {
      const stable = p.phase === "稳定";
      for (let w = 1; w <= (stable ? 12 : 4); w++) {
        for (const day of p.segments[stable ? "稳定" : "标准"].days) {
          const r = ex(product, w, day);
          expect(r.issues.filter((i) => i.level === "error"), `${product} 第 ${w} 周 ${day} 日`).toEqual([]);
          expect(r.course, `${product} 第 ${w} 周 ${day} 日`).not.toBeNull();
          expect(errors(r.course!, profile(product, w)), `${product} 第 ${w} 周 ${day} 日`).toEqual([]);
        }
      }
    });
  }
});

describe("导出的内容照训练单", () => {
  it("18–39 纯徒手第 1 周 A 日：组数、次数下限、休息、起始级；交替动作照成品做", () => {
    const r = ex("18-39岁-纯徒手版", 1, "A");
    const items = r.course!.blocks[0].items;
    expect(items.slice(0, 3).map((i) => [i.exercise, i.sets, i.reps ?? i.duration, i.rest])).toEqual([
      ["squat", 2, 15, 90], ["split-squat", 2, 10, 90], ["glute-bridge", 2, 20, 60]]);
    expect(r.follow.map((f) => f.name)).toEqual(expect.arrayContaining(["dead-bug"]));
    // 单腿罗马尼亚硬拉的起始级是"屈髋练习"，照成品做
    expect(r.follow.some((f) => f.name.startsWith("sl-rdl"))).toBe(true);
  });
  it("第 3 周有下放的动作下放 3 秒，循环照常速", () => {
    const a = ex("18-39岁-纯徒手版", 3, "A").course!;
    expect(a.blocks[0].items[0].tempo).toMatchObject({ down: 3, up: 1 });
    const d = ex("18-39岁-纯徒手版", 3, "D").course!;
    const circuit = d.blocks.find((b) => b.kind === "circuit")!;
    expect(circuit.items[0].tempo).toMatchObject({ down: 2 });
    expect(circuit).toMatchObject({ rounds: 2, restBetweenRounds: 90 });
  });
  it("个人进度：难度级换动作名和节奏，次数取档案的", () => {
    const r = ex("18-39岁-纯徒手版", 2, "B", { progress: { pushup: { level: 5, reps: 10 } } });
    const push = r.course!.blocks[0].items[0];
    expect(push).toMatchObject({ exercise: "pushup", reps: 10, tempo: { down: 3 } });
    expect(push.name).toMatch(/下放 3 秒/);
  });
  it("拦下：这一周不能用的级（第 1 周分腿蹲第 2 级）、超出区间的次数", () => {
    expect(ex("18-39岁-纯徒手版", 1, "A", { progress: { "split-squat": { level: 2 } } }).issues.map((i) => i.message).join()).toMatch(/第 2 级第 1 段第 1 周不能用/);
    expect(ex("18-39岁-纯徒手版", 1, "B", { progress: { pushup: { reps: 20 } } }).issues.map((i) => i.message).join()).toMatch(/区间是 8–15/);
  });
  it("拦下：档案还没到这一周", () => {
    expect(exportCourse({ plans, rules, manifest, profile: profile("18-39岁-纯徒手版", 1), week: 2, day: "A" }).issues.map((i) => i.message).join()).toMatch(/只能导出第 1–1 周/);
  });
});

describe("条件、器材、轮换、减量段", () => {
  it("有高血压：静蹲、平板撑得短，派克换成照成品做，毛巾类不做", () => {
    const r = ex("18-39岁-纯徒手版", 2, "A", { conditions: { 高血压: true } });
    const by = Object.fromEntries(r.course!.blocks[0].items.map((i) => [i.exercise, i.duration]));
    expect(by["wall-sit"]).toBe(30);
    expect(by.plank).toBe(30);
    const b = ex("18-39岁-纯徒手版", 2, "B", { conditions: { 高血压: true } });
    expect(b.course!.blocks[0].items.map((i) => i.exercise)).not.toContain("pike-pushup");
    expect(b.follow.some((f) => /手撑得高一点/.test(f.reason))).toBe(true);
    const c = ex("18-39岁-纯徒手版", 2, "C", { conditions: { 高血压: true } });
    expect(c.notes.join()).toMatch(/本周不做：towel-curl/);
  });
  it("条件没确认：按规则层的保守版本（高血压按有）", () => {
    const r = ex("18-39岁-纯徒手版", 2, "B", { conditions: {} });
    expect(r.course!.blocks[0].items.map((i) => i.exercise)).not.toContain("pike-pushup");
  });
  it("按器材选一个：取档案 choices 里第一个能用的；没选就拦下", () => {
    expect(ex("18-39岁-纯徒手版", 1, "C", { choices: ["door-row"] }).course!.blocks[0].items[0].exercise).toBe("door-row");
    expect(ex("18-39岁-纯徒手版", 1, "C", { choices: [] }).issues.map((i) => i.message).join()).toMatch(/按器材选一个/);
  });
  it("13–17 岁家长不在旁边：不用桌下划船", () => {
    const r = ex("13-17岁-纯徒手版", 1, "C", { conditions: { 家长在旁边: false }, choices: ["table-row", "door-row"] });
    expect(r.course!.blocks[0].items[0].exercise).toBe("door-row");
  });
  it("每周轮换：13–17 岁核心第 1 周平板、第 2 周死虫式（交替动作照成品做）", () => {
    expect(ex("13-17岁-纯徒手版", 1, "A").course!.blocks[0].items.map((i) => i.exercise)).toContain("plank");
    const w2 = ex("13-17岁-纯徒手版", 2, "A");
    expect(w2.course!.blocks[0].items.map((i) => i.exercise)).not.toContain("plank");
    expect(w2.follow.map((f) => f.name)).toContain("dead-bug");
  });
  it("每次轮换：健身房 A6、A7 按这一段练过几次轮流；课程里记下选了哪个", () => {
    const one = ex("18-39岁-健身房版", 2, "A", {}, { sessionsDone: 0 });
    const two = ex("18-39岁-健身房版", 2, "A", {}, { sessionsDone: 1 });
    expect(one.course!.source.picks).toEqual({ A6A7: "plank" });
    expect(two.course!.source.picks).toEqual({ A6A7: "dead-bug" });
  });
  it("减量段原文有歧义的那天：不出课程，整天照成品做", () => {
    const p = profile("18-39岁-纯徒手版", 1);
    p.segments[0].type = "减量";
    const r = exportCourse({ plans, rules, manifest, profile: p, week: 1, day: "B+C" });
    expect(r.course).toBeNull();
    expect(r.follow.length).toBeGreaterThan(0);
    expect(r.issues.every((i) => i.level === "warning")).toBe(true);
  });
});

describe("课程按训练单和档案进度核对：改了就拦下", () => {
  const P = () => profile("18-39岁-居家版", 3);
  const C = () => clone(exportCourse({ plans, rules, manifest, profile: P(), week: 3, day: "A" }).course!);
  const cases: [string, (c: Course) => void, RegExp][] = [
    ["组数加一组", (c) => (c.blocks[0].items[0].sets = 4), /sets|应该是 3/],
    ["次数改成上限", (c) => (c.blocks[0].items[0].reps = 20), /应该是 15/],
    ["休息改短", (c) => (c.blocks[0].items[0].rest = 60), /应该是 90/],
    ["换了动作", (c) => (c.blocks[0].items[0].exercise = "glute-bridge"), /动作和顺序应该是/],
    ["节奏没放慢", (c) => (c.blocks[0].items[0].tempo!.down = 2), /节奏应该是/],
    ["少了一个动作", (c) => c.blocks[0].items.pop(), /动作和顺序应该是/],
  ];
  for (const [name, f, re] of cases) {
    it(`拦下：${name}`, () => {
      const c = C();
      f(c);
      expect(errors(c, P()).join("\n")).toMatch(re);
    });
  }
  it("拦下：档案进度变了，旧课程要重新导出", () => {
    const c = C();
    const p = P();
    p.progress = { squat: { level: 3 } };   // 底部停 2 秒那一级
    expect(checkPlanCourse(c, plans, rules, manifest, p).map((i) => i.message).join()).toMatch(/节奏应该是/);
  });
  it("没有带档案：从训练单导出的课程不放行", () => {
    expect(checkCourse(C(), { manifest, readProduct: fixtureReadProduct, plans, rules }).filter((i) => i.level === "error").map((i) => i.message).join()).toMatch(/要连同档案一起检查/);
  });
  it("起点课程再跑一遍原文核对（第二层）：出处原文不在成品里是错误，认不出的写法记警告；带进度的课程不跑", () => {
    const p = P();
    const c = C();
    expect(isStartCourse(plans, rules, p, c)).toBe(true);
    c.blocks[0].items[0].quote = ["随便写的一句"];
    const issues = checkCourse(c, { manifest, readProduct: fixtureReadProduct, profile: p, plans, rules });
    expect(issues.filter((i) => i.level === "error").map((i) => i.message).join()).toMatch(/原文核对（第二层）：原文在「/);
    expect(issues.some((i) => i.level === "warning" && /原文核对（第二层）/.test(i.message))).toBe(true);
    const p2 = profile("18-39岁-居家版", 3, { progress: { squat: { level: 2 } } });
    const c2 = exportCourse({ plans, rules, manifest, profile: p2, week: 3, day: "A" }).course!;
    expect(isStartCourse(plans, rules, p2, c2)).toBe(false);
  });
});

describe("呼吸节奏读成课程节奏", () => {
  it("下放开始：吸气下蹲 2 秒、呼气站起 1 秒", () => expect(baseTempo("吸气，下蹲约 2 秒 → 呼气，站起约 1 秒。")).toEqual({ start: "down", down: 2, up: 1 }));
  it("发力开始、顶点停顿", () => expect(baseTempo("呼气，往上顶约 1 秒 → 顶点停 2 秒，停住时自然呼吸 → 吸气，慢慢放下约 2 秒")).toEqual({ start: "up", up: 1, top: 2, down: 2 }));
  it("括号里写着周次的不算平时；（约 N 秒）照常读", () => {
    expect(baseTempo("吸气，蹲下控制住约 2 秒（第 3 周起放慢到 3 秒）→ 呼气，站起约 1 秒")).toEqual({ start: "down", down: 2, up: 1 });
    expect(baseTempo("吸气，身体往前倾（约 1 秒）→ 呼气，双腿用力站起来（约 2 秒）→ 吸气，慢慢坐下（约 2–3 秒）")).toEqual({ start: "up", up: 2, down: 2 });
  });
  it("读不出秒数：不出节奏（导出时照成品做）", () => expect(baseTempo("吸气，微蹲 → 呼气，摆臂起跳")).toBeNull());
});

describe("审查后补的拦截", () => {
  it("带档案时，手写的课程（没有 source.plan）不放行", () => {
    const p = profile("18-39岁-纯徒手版", 1, { conditions: {} });
    const c = clone(exportCourse({ plans, rules, manifest, profile: profile("18-39岁-纯徒手版", 1, { conditions: { 高血压: false } }), week: 1, day: "B" }).course!) as any;
    for (const k of ["plan", "segment", "type", "phase"]) delete c.source[k];
    expect(errors(c, p).join()).toMatch(/不是用 course export 从训练单导出的/);
  });
  it("改课程名称冒充别的难度级（40–64 岁背包那一级）：拦下", () => {
    const p = profile("40-64岁-纯徒手版", 1);
    const c = clone(exportCourse({ plans, rules, manifest, profile: p, week: 1, day: "A" }).course!);
    c.blocks[0].items[0].name = "徒手深蹲·抱装书的背包";
    expect(errors(c, p).join()).toMatch(/名称应该是/);
  });
  it("循环用循环那里写的呼吸节奏：顶点不停", () => {
    const d = ex("18-39岁-纯徒手版", 1, "D").course!;
    const circuit = d.blocks.find((b) => b.kind === "circuit")!;
    const bridge = circuit.items.find((i) => i.exercise === "glute-bridge")!;
    const row = circuit.items.find((i) => i.exercise === "door-row" || i.exercise === "table-row")!;
    expect(bridge.tempo?.top).toBeUndefined();
    expect(row.tempo?.top).toBeUndefined();
    const a = ex("18-39岁-纯徒手版", 1, "A").course!;
    expect(a.blocks[0].items.find((i) => i.exercise === "glute-bridge")!.tempo?.top).toBe(2);
  });
  it("括号里写“进阶”的不算平时的节奏；停半秒读成 0.5 秒", () => {
    expect(baseTempo("呼气，屈膝弯起约 1 秒 → 顶点停半秒（进阶停 1 秒）→ 吸气，慢慢放下约 2 秒")).toEqual({ start: "up", up: 1, top: 0.5, down: 2 });
  });
  it("第 2 段第 1 周：难度级照上一段定下的接着用（18–39 岁第 4 周换的矮凳）", () => {
    const p = profile("18-39岁-纯徒手版", 1, { progress: { "split-squat": { level: 2 } } });
    p.segments = [1, 2, 3, 4].map((w, i) => ({ n: 1, type: "标准", week: w, start: DATES[i], product: p.product })).concat([{ n: 2, type: "标准", week: 1, start: "2026-11-09", product: p.product }]);
    const r = exportCourse({ plans, rules, manifest, profile: p, week: 1, day: "A" });
    expect(r.issues.filter((i) => i.level === "error")).toEqual([]);
    expect(r.course!.blocks[0].items.map((i) => i.exercise)).toContain("split-squat-stool");
  });
  it("每次要确认的条件（家长在旁边）：导出时提醒", () => {
    const r = ex("13-17岁-纯徒手版", 1, "C", { conditions: { 家长在旁边: true } });
    expect(r.notes.join()).toMatch(/每次练之前确认/);
  });
});

describe("按器材选一个：节奏和计量", () => {
  const name = "18-39岁-纯徒手版";
  const changed = (change: (e: (typeof manifest.exercises)[number]) => void) => {
    const m = clone(manifest);
    change(m.exercises.find((x) => x.id === "door-row")!);
    return m;
  };
  const run = (m: typeof manifest, week: number, day: string) =>
    exportCourse({ plans, rules, manifest: m, profile: profile(name, week, { choices: ["door-row"] }), week, day });
  const door = (r: ReturnType<typeof run>) => r.course!.blocks.flatMap((b) => b.items).find((i) => i.exercise === "door-row");
  const breathing = (e: (typeof manifest.exercises)[number]) => e.used_in.forEach((u) => { u.breathing = "呼气，拉约 2 秒 → 吸气，放回约 4 秒；不憋气。"; });

  it("逐组训练：用选中的动作自己写的呼吸节奏", () => {
    const t = door(run(changed(breathing), 1, "C"))!.tempo!;
    expect([t.up, t.down]).toEqual([2, 4]);
  });
  it("循环：照旧用循环那里写的节奏，不受选项影响", () => {
    expect(door(run(changed(breathing), 1, "D"))!.tempo).toEqual(door(run(manifest, 1, "D"))!.tempo);
  });
  it("拦下：计时动作放进按次数写的行，不能把次数当秒数", () => {
    const r = run(changed((e) => { e.mode = "timed"; }), 1, "C");
    expect(r.issues.some((i) => i.level === "error" && i.message.includes("计时动作"))).toBe(true);
    expect(r.course).toBeNull();
  });
});

describe("v4 阶段 8：课程导出写进档案里的播放偏好和呼吸提示的下限", () => {
  it("档案写了播放偏好：导出的课程带 coaching.prefs，课程检查 0 错误", () => {
    const p = profile("18-39岁-居家版", 1, { playback: { breathLead: 2, breathAfter: "quiet", countTiming: "on-rep" } });
    const r = exportCourse({ plans, rules, manifest, profile: p, week: 1, day: "A" });
    expect(r.course!.coaching).toEqual({ prefs: { breathLead: 2, breathAfter: "quiet", countTiming: "on-rep" } });
    expect(errors(r.course!, p)).toEqual([]);
  });
  it("没写播放偏好的成人课不带 coaching", () => {
    expect(ex("18-39岁-居家版", 1, "A").course!.coaching).toBeUndefined();
  });
  it("65 岁以上的课写下限：领完以后至少响提示音", () => {
    const c = ex("65岁以上-椅子辅助版", 1, "A").course!;
    expect(c.coaching?.floor).toBe("pluck");
  });
});
