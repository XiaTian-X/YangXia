// 课程包和练习记录导入（v4 阶段 8c）：course export 出课程包、profile check 认课程包、profile import 的每一条拦截。
// 用真模板（templates/ 或 YANGXIA_TEMPLATES）；模板不在时跳过。编排器用测试时现做的假页面（YANGXIA_SEQUENCER），
// 标记里的哈希用和打包时同一个函数现算，不依赖本机有没有打包。
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ASSESS_FORMAT } from "../src/assess.ts";
import { loadTemplates, sequencerStamp, templatesDir } from "../src/node.ts";
import { PACKAGE_FORMAT, unpackCourse } from "../src/package.ts";
import { courseIdFor } from "../src/plan.ts";
import { PROFILE_FORMAT, SESSION_FORMAT } from "../src/profile.ts";
import { REVIEW_FORMAT } from "../src/progress.ts";
import { buildSession } from "../src/session.ts";
import type { Course } from "../src/types.ts";

const REPO = new URL("../../../", import.meta.url).pathname;
const hasTemplates = !!(await templatesDir());
const t = hasTemplates ? await loadTemplates() : null;
const hasMotions = hasTemplates && existsSync(join(t!.dir, "dist", "data", "motions.json"));
const root = mkdtempSync(join(tmpdir(), "yangxia-pkg-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const today = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; })();
const PRODUCT = "18-39岁-纯徒手版";

/** 假编排器：改坏哪一项就是"过期""动图对不上"。 */
async function fakeSequencer(name: string, o: { source?: string; motionsHash?: string; motions?: string } = {}): Promise<string> {
  const stamp = await sequencerStamp();
  const motionsText = readFileSync(join(t!.dir, "dist", "data", "motions.json"), "utf8");
  const meta = `<meta name="yangxia-package" content="format=${PACKAGE_FORMAT};motions=${o.motions ?? t!.plans!.version};motionsHash=${o.motionsHash ?? stamp.motionsHash(motionsText)};source=${o.source ?? stamp.sourceHash()}">`;
  const html = `<!doctype html><html><head><meta charset="UTF-8">\n${meta}<title>养夏 · 跟练编排器</title></head><body><div id="app"></div><script type="application/json" id="yangxia-course"></script>\n</body></html>`;
  const f = join(root, `${name}.html`);
  writeFileSync(f, html);
  return f;
}

const DECL = "> 本计划由养夏计划模板生成，未经专业审核，不是医学建议，不能替代医生的判断。";
const back = (days: number) => { const x = new Date(Date.now() - days * 86_400_000); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`; };

/** 能导出第 1 周课程的档案（今天开始）；twoWeeks：第 1 周 8 天前开始、复盘过，现在是第 2 周。 */
function dir(name: string, code = name, twoWeeks = false) {
  const prod = t!.manifest.products.find((p) => p.name === PRODUCT)!;
  const items = t!.manifest.intake.screening.find((s) => s.age === prod.age)!.items;
  const p = {
    schema: PROFILE_FORMAT, code, stage: "18–39 岁", age: prod.age, venue: prod.venue, product: PRODUCT, startDate: today, birth: "1996-05", body: "不记",
    screening: { answers: items.map((item) => ({ item, answer: "否" })), doctorCleared: false, date: today },
    segments: twoWeeks ? [{ n: 1, type: "标准", week: 1, start: back(8), product: PRODUCT }, { n: 1, type: "标准", week: 2, start: back(1), product: PRODUCT }]
      : [{ n: 1, type: "标准", week: 1, start: today, product: PRODUCT }],
    conditions: { 高血压: false }, progress: {}, progressLog: [],
  };
  if (twoWeeks) (p as Record<string, unknown>).startDate = back(8);
  const d = join(root, name);
  mkdirSync(join(d, "评估"), { recursive: true });
  writeFileSync(join(d, "档案.json"), JSON.stringify(p));
  const entry = twoWeeks ? back(8) : today;
  writeFileSync(join(d, "评估", `${entry}-入门.json`), JSON.stringify({ schema: ASSESS_FORMAT, date: entry, kind: "入门",
    tests: [{ id: "pushup-test", level: 2, value: 12 }, { id: "wallsit-test", value: 30 }], conclusion: {} }));
  if (twoWeeks) {
    mkdirSync(join(d, "复盘"), { recursive: true });
    writeFileSync(join(d, "复盘", `${back(8)}-第1周.json`), JSON.stringify({ schema: REVIEW_FORMAT, start: back(8), week: 1, trainings: 0, checkinDays: 6,
      symptoms: false, moves: [], habits: { 散步: 5, 冥想: 5 } }));
    writeFileSync(join(d, "复盘", `${back(8)}-第1周.md`), `# 第 1 周复盘\n\n${DECL}\n\n训练 0 次，没有不适。\n`);
  }
  return d;
}
const run = (env: Record<string, string>, ...args: string[]) =>
  spawnSync("node", [join(REPO, "packages/course-core/src/cli.ts"), ...args], { encoding: "utf8", env: { ...process.env, ...env } });

describe.skipIf(!hasMotions)("course export 出课程包", () => {
  it("编排器能用：课程 JSON 和带代号的课程包，嵌的课程和 JSON 一样，档案检查认得", async () => {
    const seq = await fakeSequencer("ok");
    const d = dir("pkg-ok", "小夏");
    const r = run({ YANGXIA_SEQUENCER: seq }, "export", d, "1", "A");
    expect(r.stdout, r.stdout).toMatch(/已导出课程包/);
    expect(r.stdout).toMatch(/不要发到群里/);
    const json = JSON.parse(readFileSync(join(d, "课程", "第1段-第1周-A日.json"), "utf8"));
    const html = readFileSync(join(d, "课程", "小夏-第1段-第1周-A日.html"), "utf8");
    const u = unpackCourse(html);
    expect(u.course).toEqual(json);
    expect(u.exported).toBe(today);
    const c = run({}, "profile", "check", d);
    expect(c.stdout).not.toMatch(/课程包|不认识的文件/);
    expect(c.status, c.stdout).toBe(0);
  });

  it("编排器过期、动图对不上、没打包：只出 JSON，删掉同名旧课程包", async () => {
    const d = dir("pkg-stale", "老夏");
    const pkg = join(d, "课程", "老夏-第1段-第1周-A日.html");
    run({ YANGXIA_SEQUENCER: await fakeSequencer("stale-ok") }, "export", d, "1", "A");
    const good = readFileSync(pkg, "utf8");   // 真的旧课程包
    for (const [env, why] of [
      [{ YANGXIA_SEQUENCER: await fakeSequencer("stale", { source: "0".repeat(64) }) }, /代码改过/],
      [{ YANGXIA_SEQUENCER: await fakeSequencer("motions", { motionsHash: "0".repeat(64) }) }, /动作示意动图和现在的模板不一样/],
      [{ YANGXIA_SEQUENCER: await fakeSequencer("version", { motions: "v0.1" }) }, /动图是模板 v0\.1 的/],
      [{ YANGXIA_SEQUENCER: join(root, "没有.html") }, /没有找到打包好的编排器/],
    ] as const) {
      mkdirSync(join(d, "课程"), { recursive: true });
      writeFileSync(pkg, good);
      const r = run(env, "export", d, "1", "A");
      expect(r.stdout).toMatch(/已导出：/);
      expect(r.stdout).toMatch(why);
      expect(r.stdout).toMatch(/旧课程包已删/);
      expect(existsSync(pkg)).toBe(false);
      expect(r.status).toBe(0);
    }
  });

  it("同名的文件不是养夏课程包：不删、不覆盖", async () => {
    const seq = await fakeSequencer("mine");
    const d = dir("pkg-mine");
    const out = join(root, "pkg-mine-out", "report.json");
    mkdirSync(join(root, "pkg-mine-out"), { recursive: true });
    const mine = join(root, "pkg-mine-out", "report.html");
    writeFileSync(mine, "我自己的网页");
    const a = run({ YANGXIA_SEQUENCER: seq }, "export", d, "1", "A", "--out", out, "--no-package");
    expect(a.stdout).toMatch(/不是养夏课程包，没有动它/);
    expect(readFileSync(mine, "utf8")).toBe("我自己的网页");
    const b = run({ YANGXIA_SEQUENCER: seq }, "export", d, "1", "A", "--out", out);
    expect(b.stdout).toMatch(/已经有一个不是养夏课程包的文件，没有动它/);
    expect(readFileSync(mine, "utf8")).toBe("我自己的网页");
  });

  it("--no-package 不出课程包；--out 的课程包同目录同名；半量课文件名带 -半量", async () => {
    const seq = await fakeSequencer("ok2");
    const d = dir("pkg-opts");
    const a = run({ YANGXIA_SEQUENCER: seq }, "export", d, "1", "A", "--no-package");
    expect(a.stdout).toMatch(/没出课程包：加了 --no-package/);
    expect(readdirSync(join(d, "课程")).filter((f) => f.endsWith(".html"))).toEqual([]);
    const out = join(root, "pkg-opts-out.json");
    run({ YANGXIA_SEQUENCER: seq }, "export", d, "1", "A", "--out", out);
    expect(existsSync(join(root, "pkg-opts-out.html"))).toBe(true);
    const h = run({ YANGXIA_SEQUENCER: seq }, "export", d, "1", "A", "--half");
    expect(h.stdout, h.stdout).toMatch(/第1段-第1周-A日-半量\.json/);
    expect(existsSync(join(d, "课程", "pkg-opts-第1段-第1周-A日-半量.html"))).toBe(true);
  });
});

describe.skipIf(!hasMotions)("profile check 认课程包", () => {
  it("和 JSON 对不上、没有 JSON、放错地方、动图版本不对、不是课程包：报错", async () => {
    const seq = await fakeSequencer("ok3");
    const d = dir("pkg-check", "检查");
    run({ YANGXIA_SEQUENCER: seq }, "export", d, "1", "A");
    const jsonPath = join(d, "课程", "第1段-第1周-A日.json");
    const pkgPath = join(d, "课程", "检查-第1段-第1周-A日.html");
    const good = readFileSync(pkgPath, "utf8");
    const json = JSON.parse(readFileSync(jsonPath, "utf8"));
    // 课程 JSON 改了（重新导出成了别的样子），课程包还是旧的
    writeFileSync(jsonPath, JSON.stringify({ ...json, name: "改过的名字" }));
    expect(run({}, "profile", "check", d).stdout).toMatch(/课程包和课程 JSON.*对不上/);
    writeFileSync(jsonPath, JSON.stringify(json));
    // 档案目录改名（代号变了）：按名字后半段照样对得上
    const renamed = join(d, "课程", "别的代号-第1段-第1周-A日.html");
    writeFileSync(renamed, good);
    expect(run({}, "profile", "check", d).stdout).not.toMatch(/别的代号.*(对不上|没有对应)/);
    rmSync(renamed);
    // 没有对应的 JSON
    writeFileSync(join(d, "课程", "检查-第1段-第1周-B日.html"), good);
    expect(run({}, "profile", "check", d).stdout).toMatch(/B日\.html.*没有对应的课程 JSON/);
    rmSync(join(d, "课程", "检查-第1段-第1周-B日.html"));
    // 放错地方
    mkdirSync(join(d, "打卡"), { recursive: true });
    writeFileSync(join(d, "打卡", "x.html"), good);
    expect(run({}, "profile", "check", d).stdout).toMatch(/x\.html.*课程包放在 课程\/ 下/);
    rmSync(join(d, "打卡", "x.html"));
    // 动图版本和课程的模板版本不一样
    writeFileSync(pkgPath, good.replace(/motions=[^;]+;/, "motions=v0.1;"));
    expect(run({}, "profile", "check", d).stdout).toMatch(/模板 v0\.1 的/);
    // 不是课程包
    writeFileSync(pkgPath, "<html>随便什么</html>");
    expect(run({}, "profile", "check", d).stdout).toMatch(/不是养夏课程包/);
  });

  it("以前几周的课程包：提醒可以删", async () => {
    const seq = await fakeSequencer("old");
    const d = dir("pkg-old", "旧", true);
    run({ YANGXIA_SEQUENCER: seq }, "export", d, "2", "A");
    const json = JSON.parse(readFileSync(join(d, "课程", "第1段-第2周-A日.json"), "utf8"));
    const html = readFileSync(join(d, "课程", "旧-第1段-第2周-A日.html"), "utf8");
    // 造一份"第 1 周"的课程和课程包（内容照第 2 周的改周次、重算 id）
    const w1 = { ...json, id: courseIdFor(json.source.product, 1, "标准", 1, "A", false), source: { ...json.source, week: 1 } };
    writeFileSync(join(d, "课程", "第1段-第1周-A日.json"), JSON.stringify(w1));
    const { packCourse } = await import("../src/package.ts");
    const plain = html.replace(/<script type="application\/json" id="yangxia-course"[^>]*>[\s\S]*?<\/script>/, '<script type="application/json" id="yangxia-course"></script>');
    writeFileSync(join(d, "课程", "旧-第1段-第1周-A日.html"), packCourse(plain, w1, today).html!);
    expect(run({}, "profile", "check", d).stdout).toMatch(/旧-第1段-第1周-A日\.html.*以前几周的课程包/);
  });
});

describe.skipIf(!hasMotions)("profile import", () => {
  const setup = async (name: string) => {
    const seq = await fakeSequencer(`imp-${name}`);
    const d = dir(`imp-${name}`);
    run({ YANGXIA_SEQUENCER: seq }, "export", d, "1", "A");
    const course = JSON.parse(readFileSync(join(d, "课程", "第1段-第1周-A日.json"), "utf8")) as Course;
    const started = new Date(Date.now() - 3600_000);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rec = (o: Record<string, unknown> = {}): Record<string, any> => ({ ...buildSession(course, {
      startedAt: started, endedAt: new Date(started.getTime() + 1200_000), feeling: "正好",
      symptoms: { pain: false, dizzy: false, chest: false }, setsDone: { 0: 2, 1: 2 },
    }), ...o });
    const file = (n: string, v: unknown) => {
      const f = join(root, `${name}-${n}.json`);
      writeFileSync(f, typeof v === "string" ? v : JSON.stringify(v));
      return f;
    };
    const imp = (...args: string[]) => run({}, "profile", "import", d, ...args);
    const checkins = () => (existsSync(join(d, "打卡")) ? readdirSync(join(d, "打卡")) : []);
    return { d, course, rec, file, imp, checkins, started };
  };

  it("合格的记录：按格式重写进 打卡/，丢掉多余字段；再导一次跳过", async () => {
    const s = await setup("ok");
    const r = s.imp(s.file("a", { ...s.rec(), extra: "多出来的", course: { ...s.rec().course, who: "x" } }));
    expect(r.stdout, r.stdout).toMatch(/已导入：打卡\/养夏_练习记录_/);
    expect(r.stdout).toMatch(/丢掉了格式里没有的字段：extra、course\.who/);
    expect(r.stdout).not.toMatch(/多出来的/);
    expect(r.status).toBe(0);
    const [f] = s.checkins();
    const saved = JSON.parse(readFileSync(join(s.d, "打卡", f), "utf8"));
    expect(saved.schema).toBe(SESSION_FORMAT);
    expect(Object.keys(saved)).not.toContain("extra");
    const again = s.imp(s.file("a2", s.rec()));
    expect(again.stdout).toMatch(/已经导入过/);
    expect(s.checkins().length).toBe(1);
  });

  it("同一次练习内容不一样：拒收并列出不同字段（症状在最前）；--replace 原地覆盖", async () => {
    const s = await setup("dup");
    s.imp(s.file("a", s.rec()));
    const [f] = s.checkins();
    const changed = s.rec({ feeling: "吃力", symptoms: { pain: true, dizzy: false, chest: false } });
    const r = s.imp(s.file("b", changed));
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/内容不一样：symptoms、feeling/);
    expect(r.stdout).toMatch(/【注意】这次有疼痛/);
    expect(r.stdout).toMatch(/这份记录没导入/);
    const rr = s.imp(s.file("c", changed), "--replace");
    expect(rr.stdout).toMatch(/原地覆盖.*改了：symptoms、feeling/);
    expect(s.checkins()).toEqual([f]);
    expect(JSON.parse(readFileSync(join(s.d, "打卡", f), "utf8")).symptoms.pain).toBe(true);
  });

  it("同一分钟两份记录（全量课、半量课）：都收下，文件名加 _2", async () => {
    const s = await setup("minute");
    s.imp(s.file("a", s.rec()));
    run({}, "export", s.d, "1", "A", "--half", "--no-package");
    const half = JSON.parse(readFileSync(join(s.d, "课程", "第1段-第1周-A日-半量.json"), "utf8")) as Course;
    const h = buildSession(half, { startedAt: s.started, endedAt: new Date(s.started.getTime() + 600_000), feeling: "正好",
      symptoms: { pain: false, dizzy: false, chest: false }, setsDone: {} });
    const r = s.imp(s.file("h", h));
    expect(r.stdout, r.stdout).toMatch(/_2\.json/);
    expect(s.checkins().length).toBe(2);
  });

  it("拦得住：格式不对、不是档案的课、id 被改、档案里没有这一周、时间在将来或早于这一段、解析不了；--dry-run 不写", async () => {
    const s = await setup("bad");
    const cases: [string, unknown, RegExp][] = [
      ["schema", s.rec({ schema: "x" }), /格式不对/],
      ["source-extra", s.rec({ course: { ...s.rec().course, source: { ...s.rec().course.source, who: "x" } } }), /格式不对/],
      ["half-yes", s.rec({ course: { ...s.rec().course, source: { ...s.rec().course.source, half: "yes" } } }), /格式不对/],
      ["sets", s.rec({ items: [{ exercise: "squat", setsPlanned: 1, setsDone: 3, skipped: false }] }), /格式不对/],
      ["sample", s.rec({ course: { id: "c_sample0001", name: "样例", source: { product: PRODUCT, week: 1 } } }), /不是档案里导出的课程/],
      ["id", s.rec({ course: { ...s.rec().course, id: "c_tampered01" } }), /id 和出处对不上/],
      ["week", (() => { const c = s.rec().course; const src = { ...c.source, week: 3 } as Record<string, unknown>; return s.rec({ course: { ...c, source: src, id: s.rec().course.id } }); })(), /id 和出处对不上|没有这一段这一周/],
      ["future", s.rec({ startedAt: new Date(Date.now() + 3600_000).toISOString(), endedAt: new Date(Date.now() + 7200_000).toISOString() }), /将来/],
      ["early", s.rec({ startedAt: "2020-01-01T08:00:00.000Z", endedAt: "2020-01-01T08:20:00.000Z" }), /早于这一段开始那天/],
      ["parse", "{坏的", /解析不了/],
    ];
    for (const [n, v, why] of cases) {
      const r = s.imp(s.file(n, v));
      expect(r.stdout, n).toMatch(why);
      expect(r.status, n).toBe(1);
    }
    expect(s.checkins()).toEqual([]);
    // 拒收的记录有不适：照样提醒
    const hurt = s.imp(s.file("hurt", s.rec({ schema: "x", symptoms: { pain: false, dizzy: true, chest: false } })));
    expect(hurt.stdout).toMatch(/【注意】这次有头晕/);
    const dry = s.imp(s.file("dry", s.rec({ note: "今天腿有点酸" })), "--dry-run");
    expect(dry.stdout).toMatch(/会写到：打卡/);
    expect(dry.stdout).toMatch(/今天腿有点酸/);
    expect(s.checkins()).toEqual([]);
  });

  it("--replace 不能把不适、手改过的课改成没有", async () => {
    const s = await setup("down");
    s.imp(s.file("a", s.rec({ symptoms: { pain: true, dizzy: false, chest: false }, edited: true })));
    const [f] = s.checkins();
    const r = s.imp(s.file("b", s.rec({ symptoms: { pain: false, dizzy: false, chest: false }, edited: true })), "--replace");
    expect(r.stdout).toMatch(/旧记录里的疼痛不能改成没有/);
    expect(r.status).toBe(1);
    const e = s.imp(s.file("c", s.rec({ symptoms: { pain: true, dizzy: false, chest: false } })), "--replace");
    expect(e.stdout).toMatch(/手改过的课.*不能改成没改过/);
    // 新记录换报了头晕、不疼：整份拒收，也提醒把头晕写进复盘
    const swap = s.imp(s.file("e", s.rec({ symptoms: { pain: false, dizzy: true, chest: false }, edited: true })), "--replace");
    expect(swap.stdout).toMatch(/不能改成没有/);
    expect(swap.stdout).toMatch(/这份记录没导入：周复盘时把不适照实写进/);
    const saved = JSON.parse(readFileSync(join(s.d, "打卡", f), "utf8"));
    expect(saved.symptoms.pain).toBe(true);
    expect(saved.edited).toBe(true);
    // 往上加不适照常可以
    const up = s.imp(s.file("d", s.rec({ symptoms: { pain: true, dizzy: true, chest: false }, edited: true })), "--replace");
    expect(up.stdout).toMatch(/原地覆盖/);
  });

  it("旧记录的不适写法不对（\"是\"）：--replace 也不能借替换抹掉", async () => {
    const s = await setup("truthy");
    s.imp(s.file("a", s.rec()));
    const [f] = s.checkins();
    const p = join(s.d, "打卡", f);
    const old = JSON.parse(readFileSync(p, "utf8"));
    old.symptoms.pain = "是";
    writeFileSync(p, JSON.stringify(old));
    const r = s.imp(s.file("b", s.rec()), "--replace");
    expect(r.stdout).toMatch(/疼痛不能改成没有/);
    expect(JSON.parse(readFileSync(p, "utf8")).symptoms.pain).toBe("是");
  });

  it("档案里的旧记录格式不对：不重复导入，提示先改好", async () => {
    const s = await setup("broken");
    s.imp(s.file("a", s.rec()));
    const [f] = s.checkins();
    const p = join(s.d, "打卡", f);
    const bad = JSON.parse(readFileSync(p, "utf8"));
    bad.course.source.who = "x";
    writeFileSync(p, JSON.stringify(bad));
    const r = s.imp(s.file("b", s.rec()));
    expect(r.stdout).toMatch(/旧记录.*格式不对/);
    expect(s.checkins()).toEqual([f]);
  });

  it("档案里没有这一周（id 照算）、不是文件、大于 1 MB、不适一栏写法不对：拦下", async () => {
    const s = await setup("more");
    const c = s.rec().course;
    const w3 = s.rec({ course: { ...c, source: { ...c.source, week: 3 }, id: courseIdFor(c.source.product, c.source.segment, c.source.type, 3, c.source.day, false) } });
    const a = s.imp(s.file("w3", w3));
    expect(a.stdout).toMatch(/档案里没有这一段这一周/);
    expect(s.imp(root).stdout).toMatch(/不是文件/);
    const big = join(root, "more-big.json");
    writeFileSync(big, " ".repeat(1024 * 1024 + 1));
    expect(s.imp(big).stdout).toMatch(/大于 1 MB/);
    const odd = s.imp(s.file("odd", s.rec({ symptoms: { pain: "是", dizzy: false, chest: false } })));
    expect(odd.stdout).toMatch(/格式不对/);
    expect(odd.stdout).toMatch(/不适那一栏没写或写法不对/);
    expect(s.checkins()).toEqual([]);
  });

  it("半量课的记录导入后 half 还在；复盘过的那一周晚到的记录：档案检查报复盘要改", async () => {
    const seq = await fakeSequencer("late");
    const d = dir("imp-late", "imp-late", true);
    run({ YANGXIA_SEQUENCER: seq }, "export", d, "2", "A", "--half", "--no-package");
    const half = JSON.parse(readFileSync(join(d, "课程", "第1段-第2周-A日-半量.json"), "utf8")) as Course;
    const startedH = new Date(Date.now() - 600_000);
    const recH = buildSession(half, { startedAt: startedH, endedAt: new Date(), feeling: "正好", symptoms: { pain: false, dizzy: false, chest: false }, setsDone: {} });
    const fh = join(root, "late-half.json");
    writeFileSync(fh, JSON.stringify(recH));
    const r = run({}, "profile", "import", d, fh);
    expect(r.stdout, r.stdout).toMatch(/已导入/);
    const saved = readdirSync(join(d, "打卡")).map((f) => JSON.parse(readFileSync(join(d, "打卡", f), "utf8")));
    expect(saved[0].course.source.half).toBe(true);
    // 第 1 周（已经复盘过，训练 0 次）晚到一份记录
    const w1 = { ...half, id: courseIdFor(half.source.product, 1, "标准", 1, "A", false), source: { ...half.source, week: 1, half: undefined } };
    delete (w1.source as Record<string, unknown>).half;
    const started1 = new Date(Date.now() - 6 * 86_400_000);
    const rec1 = buildSession(w1 as Course, { startedAt: started1, endedAt: new Date(started1.getTime() + 600_000), feeling: "正好",
      symptoms: { pain: false, dizzy: false, chest: false }, setsDone: {} });
    const f1 = join(root, "late-w1.json");
    writeFileSync(f1, JSON.stringify(rec1));
    const late = run({}, "profile", "import", d, f1);
    expect(late.stdout, late.stdout).toMatch(/已导入/);
    expect(late.stdout).toMatch(/档案检查有错误/);
    expect(late.stdout).toMatch(/复盘/);
  });

  it("一批里有坏的：别的照样导入，退出码非 0", async () => {
    const s = await setup("batch");
    const r = s.imp(s.file("good", s.rec()), s.file("bad", s.rec({ feeling: "很好" })));
    expect(r.stdout).toMatch(/已导入/);
    expect(r.stdout).toMatch(/有 1 份记录没导入/);
    expect(r.status).toBe(1);
    expect(s.checkins().length).toBe(1);
  });
});
