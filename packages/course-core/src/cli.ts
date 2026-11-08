// 命令行（Node 24 直接运行 TypeScript）：
//   npm run course -- check <课程.json> --profile <档案.json>     检查课程（连同安全筛查），有错误时退出码 1
//   npm run course -- check <课程.json> --no-profile              只检查课程本身（样例、开发用；不能据此交给使用者）
//   npm run course -- summary <课程.json>                         总时长、动作、组数
//   npm run course -- srt <课程.json>                             打印 SRT 字幕
//   npm run course -- cases                                       跑模板 manifest 里的红线校验样例
//   npm run course -- intake [年龄段]                              入口问卷：问题、阶段和目标睡眠、这个年龄段的筛查项
//   npm run course -- bedtime <阶段> <起床时间>                    按公式算上床时间（如 初中 06:30）
//   npm run course -- moves <成品名>                               这份成品能导出的动作：ID、短名、处方原文、呼吸节奏
//   npm run profile -- check <档案目录>                            检查档案（和模板核对）、练习记录、课程，以及写给这个人的复盘和菜单
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { checkCourse } from "./check.ts";
import { failedRedlineCases } from "./redlines.ts";
import { buildSrt } from "./srt.ts";
import { buildTimeline, itemSpec } from "./timeline.ts";
import { validateCourse } from "./validate.ts";
import { bedtimeFor, checkProfileWithTemplates } from "./intake.ts";
import { checkProgress } from "./progress.ts";
import { loadTemplates } from "./node.ts";
import { checkNotes, PROFILE_FORMAT, SESSION_FORMAT, validateProfile, validateSession } from "./profile.ts";
import type { Issue } from "./types.ts";

const USAGE = `用法：
  npm run course -- check <课程.json> --profile <档案.json>
  npm run course -- check <课程.json> --no-profile
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
  const VENUE: Record<string, string> = { gym: "健身房", home: "居家（2.5kg 哑铃 + 动感单车）", bw: "纯徒手", play: "户外与游戏", chair: "椅子辅助", meal: "全家餐饮" };
  console.log("\n成品（档案的 product 写成品名）：");
  for (const p of manifest.products.filter((x) => !age || x.age === age)) console.log(`  ${p.name}（${p.age}·${p.venue}，${VENUE[p.venue] ?? p.venue}）`);
  console.log("\n不覆盖的人群：");
  for (const n of it.not_covered) console.log(`  ${n.group}：${n.advice}`);
  return 0;
}

async function bedtime(stage: string, wake: string): Promise<number> {
  const { manifest } = await loadTemplates();
  const it = manifest.intake as any;
  const st = it.stages.find((x: any) => x.stage === stage);
  const hhmm = bedtimeFor(manifest, stage, wake);
  if (!st || !hhmm) {
    console.log(`阶段要写 ${it.stages.filter((x: any) => x.age).map((x: any) => x.stage).join(" / ")}，起床时间写成 HH:MM`);
    return 2;
  }
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
  const inProfile = (xs: Issue[]) => xs.map((i) => ({ ...i, path: `档案.json${i.path ? " " + i.path : ""}` }));
  issues.push(...inProfile(validateProfile(profile)), ...inProfile(checkProfileWithTemplates(profile, t.manifest)));
  const sessions: { name: string; raw: Record<string, any>; archived: boolean }[] = [];
  const reviews: string[] = [];
  for (const f of walk(dir)) {
    const name = relative(dir, f);
    if (name === "档案.json") continue;
    const archived = name.startsWith(`历史${sep}`);
    if (archived) {
      // 历史/ 只放以前几轮的东西：历史/第R轮/…，R 比现在的轮次小（不能把这一轮的课程挪进去躲检查）
      const r = new RegExp(`^历史\\${sep}第(\\d+)轮\\${sep}`).exec(name);
      if (!r || Number(r[1]) >= (Number.isInteger(profile.round) ? profile.round : 1)) {
        issues.push({ level: "error", path: name, message: `历史/ 下只放以前几轮的文件（历史/第R轮/，R 小于现在的第 ${profile.round ?? 1} 轮）` });
      }
    }
    if (!archived && name.startsWith(`复盘${sep}`)) reviews.push(name.slice(`复盘${sep}`.length));
    if (f.endsWith(".json")) {
      const raw = readJson(f) as Record<string, any>;
      const tag = (xs: Issue[]) => xs.map((i) => ({ ...i, path: `${name}${i.path ? " " + i.path : ""}` }));
      if (raw?.schema === SESSION_FORMAT) {
        issues.push(...tag(validateSession(raw)));
        sessions.push({ name, raw, archived });
      }
      else if (raw?.schema === "yangxia.course/1") {
        // 历史/ 下是以前几轮的课程：周次、成品可能和现在的档案不同，模板也可能更新过，只核对格式
        issues.push(...tag(name.startsWith(`历史${sep}`) ? validateCourse(raw).issues
          : checkCourse(raw, { manifest: t.manifest, readProduct: t.readProduct, profile })));
      }
      else if (raw?.schema !== PROFILE_FORMAT) issues.push({ level: "warning", path: name, message: "不认识的 JSON 文件（不是课程、练习记录）" });
    } else if (f.endsWith(".md") || f.endsWith(".txt")) {
      // 菜单给全家吃：按全家餐饮的红线，加上每个家庭成员年龄段的红线（家里有孩子，就不能谈体重、减重）
      const menu = name.startsWith(`菜单${sep}`);
      if (menu && !Array.isArray(profile.household)) {
        issues.push({ level: "error", path: name, message: "排菜单前要在档案里记下家庭成员的年龄段（household），菜单按每个人的红线检查" });
      }
      const ages = [...new Set(menu ? ["fam", profile.age, ...(profile.household ?? [])] : [profile.age])];
      issues.push(...checkNotes(t.manifest.redlines, ages, name, readFileSync(f, "utf8")));
    } else if (!name.split(sep).some((s) => s.startsWith("."))) {
      issues.push({ level: "warning", path: name, message: "不认识的文件：复盘、菜单写成 .md，课程、练习记录是 .json；别的文件不检查" });
    }
  }
  issues.push(...checkProgress(profile, sessions, reviews));
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
    if (pi >= 0 && !rest[pi + 1]) {
      console.log("--profile 后面要写档案文件，如 profiles/<代号>/档案.json");
      return 2;
    }
    if (pi < 0 && !rest.includes("--no-profile")) {
      console.log("课程要连同档案一起检查（安全筛查、成品、周次）：加 --profile profiles/<代号>/档案.json。\n只检查课程本身（样例、开发用）加 --no-profile，这样的结果不能据此把课程交给使用者。");
      return 2;
    }
    const profile = pi >= 0 ? readJson(rest[pi + 1]) : undefined;
    const issues = checkCourse(raw, { manifest: t.manifest, readProduct: t.readProduct, profile });
    if (pi < 0) issues.push({ level: "warning", path: "", message: "没有带档案：没核对安全筛查、成品和周次" });
    return print(issues);
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
