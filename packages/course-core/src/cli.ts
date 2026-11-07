// 命令行（Node 24 直接运行 TypeScript）：
//   npm run course -- check <课程.json> [--profile <档案.json>]   检查课程，有错误时退出码 1
//   npm run course -- summary <课程.json>                         总时长、动作、组数
//   npm run course -- srt <课程.json>                             打印 SRT 字幕
//   npm run course -- cases                                       跑模板 manifest 里的红线校验样例
//   npm run course -- intake [年龄段]                              入口问卷：问题、阶段和目标睡眠、这个年龄段的筛查项
//   npm run course -- bedtime <阶段> <起床时间>                    按公式算上床时间（如 初中 06:30）
//   npm run course -- moves <成品名>                               这份成品能导出的动作：ID、短名、处方原文、呼吸节奏
//   npm run profile -- check <档案目录>                            检查档案、练习记录、课程，以及写给这个人的复盘和菜单
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { checkCourse } from "./check.ts";
import { failedRedlineCases } from "./redlines.ts";
import { buildSrt } from "./srt.ts";
import { buildTimeline, itemSpec } from "./timeline.ts";
import { validateCourse } from "./validate.ts";
import { loadTemplates } from "./node.ts";
import { checkNotes, PROFILE_FORMAT, SESSION_FORMAT, validateProfile, validateSession } from "./profile.ts";
import type { Issue } from "./types.ts";

const USAGE = `用法：
  npm run course -- check <课程.json> [--profile <档案.json>]
  npm run course -- summary <课程.json>
  npm run course -- srt <课程.json>
  npm run course -- cases
  npm run course -- intake [年龄段]
  npm run course -- bedtime <阶段> <起床时间>
  npm run course -- moves <成品名>
  npm run profile -- check <档案目录>`;

async function intake(age?: string): Promise<number> {
  const { manifest } = await loadTemplates();
  const it = manifest.intake as any;
  console.log("问题：");
  for (const q of it.questions) console.log(`  ${q.id} ${q.question}：${q.options.join(" / ")}（${q.purpose}）`);
  console.log(`\n上床时间 = ${it.bedtime.formula}（入睡缓冲 ${it.bedtime.buffer_minutes} 分钟）`);
  for (const st of it.stages) {
    console.log(`  ${st.stage}：${st.age ? `${st.age}，目标睡眠 ${st.sleep_hours} 小时，官方最晚就寝：${st.official_bedtime.text}` : "不覆盖"}`);
  }
  for (const sc of it.screening.filter((x: any) => !age || x.age === age)) {
    console.log(`\n安全筛查 ${sc.age}（${sc.kind === "all" ? "所有人开始前都要先问医生" : "任一项是就先问医生"}）：${sc.rule}`);
    sc.items.forEach((x: string, i: number) => console.log(`  ${i + 1}. ${x}`));
  }
  console.log("\n不覆盖的人群：");
  for (const n of it.not_covered) console.log(`  ${n.group}：${n.advice}`);
  return 0;
}

async function bedtime(stage: string, wake: string): Promise<number> {
  const { manifest } = await loadTemplates();
  const it = manifest.intake as any;
  const st = it.stages.find((x: any) => x.stage === stage);
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(wake ?? "");
  if (!st || !st.age || !m) {
    console.log(`阶段要写 ${it.stages.filter((x: any) => x.age).map((x: any) => x.stage).join(" / ")}，起床时间写成 HH:MM`);
    return 2;
  }
  let min = Number(m[1]) * 60 + Number(m[2]) - Math.round(st.sleep_hours * 60) - it.bedtime.buffer_minutes;
  min = ((min % 1440) + 1440) % 1440;
  const hhmm = `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
  console.log(`${stage}，${wake} 起床 → 上床 ${hhmm}（目标睡眠 ${st.sleep_hours} 小时 + 入睡缓冲 ${it.bedtime.buffer_minutes} 分钟）；官方最晚就寝：${st.official_bedtime.text}`);
  return 0;
}

async function moves(product: string): Promise<number> {
  const { manifest } = await loadTemplates();
  const p = manifest.products.find((x) => x.name === product);
  if (!p) {
    console.log(`没有成品「${product}」。可用：${manifest.products.map((x) => x.name).join("、")}`);
    return 2;
  }
  const code = `${p.age}·${p.venue}`;
  const list = manifest.exercises.filter((e) => e.used.includes(code));
  if (!list.length) {
    console.log(`「${product}」没有可以导出的动作（6–12 岁版不用组数次数，全家餐饮没有训练）`);
    return 0;
  }
  for (const e of list) {
    console.log(`\n${e.id} · ${e.short}（${e.mode === "timed" ? "计时" : "按次"}${e.per_side ? "，每侧" : ""}）`);
    for (const u of e.used_in.filter((x) => x.product === product)) {
      console.log(`  第 ${u.line} 行「${u.title}」${u.prescription ? ` 处方：${u.prescription}` : ""}`);
      if (u.breathing) console.log(`    呼吸节奏：${u.breathing}`);
    }
  }
  return 0;
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

function print(issues: Issue[]): number {
  for (const i of issues) console.log(`[${i.level === "error" ? "错误" : "警告"}] ${i.path || "课程"}：${i.message}`);
  const errors = issues.filter((i) => i.level === "error").length;
  console.log(`\n检查完：${errors} 个错误，${issues.length - errors} 个警告`);
  return errors ? 1 : 0;
}

async function profileCheck(dir: string): Promise<number> {
  const t = await loadTemplates();
  const issues: Issue[] = [];
  const profile = readJson(join(dir, "档案.json")) as Record<string, any>;
  issues.push(...validateProfile(profile).map((i) => ({ ...i, path: `档案.json${i.path ? " " + i.path : ""}` })));
  for (const f of walk(dir)) {
    const name = relative(dir, f);
    if (name === "档案.json") continue;
    if (f.endsWith(".json")) {
      const raw = readJson(f) as Record<string, any>;
      const tag = (xs: Issue[]) => xs.map((i) => ({ ...i, path: `${name}${i.path ? " " + i.path : ""}` }));
      if (raw?.schema === SESSION_FORMAT) issues.push(...tag(validateSession(raw)));
      else if (raw?.schema === "yangxia.course/1") issues.push(...tag(checkCourse(raw, { manifest: t.manifest, readProduct: t.readProduct, profile })));
      else if (raw?.schema !== PROFILE_FORMAT) issues.push({ level: "warning", path: name, message: "不认识的 JSON 文件（不是课程、练习记录）" });
    } else if (f.endsWith(".md")) {
      const ages = name.startsWith("菜单") ? ["fam", profile.age] : [profile.age];
      issues.push(...checkNotes(t.manifest.redlines, ages, name, readFileSync(f, "utf8")));
    }
  }
  return print(issues);
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new Error(`读不了 ${path}：${(e as Error).message}`);
  }
}

function mmss(sec: number): string {
  const s = Math.round(sec);
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

async function main(argv: string[]): Promise<number> {
  const [cmd, file, ...rest] = argv;
  if (cmd === "profile") {
    if (file !== "check" || !rest[0]) {
      console.log(USAGE);
      return 2;
    }
    return profileCheck(rest[0]);
  }
  if (cmd === "intake") return intake(file);
  if (cmd === "bedtime") return bedtime(file, rest[0]);
  if (cmd === "moves") {
    if (!file) {
      console.log(USAGE);
      return 2;
    }
    return moves(file);
  }
  if (cmd === "cases") {
    const t = await loadTemplates();
    const bad = failedRedlineCases(t.manifest.redlines);
    for (const c of bad) console.log(`不符：${c.age}·${c.scope}「${c.text}」应该${c.blocked ? "拦下" : "通过"}`);
    console.log(`红线校验样例 ${t.manifest.redlines.cases.length} 条，不符 ${bad.length} 条`);
    return bad.length ? 1 : 0;
  }
  if (!file || !["check", "summary", "srt"].includes(cmd ?? "")) {
    console.log(USAGE);
    return 2;
  }
  const raw = readJson(file);
  if (cmd === "check") {
    const t = await loadTemplates();
    const pi = rest.indexOf("--profile");
    const profile = pi >= 0 ? readJson(rest[pi + 1]) : undefined;
    return print(checkCourse(raw, { manifest: t.manifest, readProduct: t.readProduct, profile }));
  }
  const { course, issues } = validateCourse(raw);
  if (!course) {
    for (const i of issues) console.log(`[错误] ${i.path}：${i.message}`);
    return 1;
  }
  const tl = buildTimeline(course);
  if (cmd === "srt") {
    process.stdout.write(buildSrt(tl.events, tl.totalDuration));
    return 0;
  }
  console.log(`${course.name}（${course.source.product} · 第 ${course.source.week} 周${course.source.day ? " · " + course.source.day + " 日" : ""}）`);
  console.log(`总时长约 ${mmss(tl.totalDuration)}`);
  for (const b of course.blocks) {
    const head = b.kind === "circuit" ? `循环 ${b.rounds} 轮` : "逐个动作";
    console.log(`- ${head}：${b.items.map((it) => `${it.name} ${itemSpec(it, b.kind === "circuit" ? b.rounds : it.sets ?? 1)}`).join("；")}`);
  }
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e) => {
    console.error((e as Error).message);
    process.exit(2);
  },
);
