// 命令行（Node 24 直接运行 TypeScript）：
//   npm run course -- export <档案目录> <第几周> <哪天> [--out <文件>] [--pick 组=动作]  按训练单和档案导出一天的课程
//   npm run course -- check <课程.json> --profile <档案.json>     检查课程（连同安全筛查），有错误时退出码 1
//   npm run course -- check <课程.json> --no-profile              只检查课程本身（样例、开发用；不能据此交给使用者）
//   npm run course -- summary <课程.json>                         总时长、动作、组数
//   npm run course -- srt <课程.json>                             打印 SRT 字幕
//   npm run course -- cases                                       跑模板 manifest 里的红线校验样例
//   npm run course -- intake [年龄段]                              入口问卷：问题、阶段和目标睡眠、这个年龄段的筛查项
//   npm run course -- bedtime <阶段> <起床时间>                    按公式算上床时间（如 初中 06:30）
//   npm run course -- moves <成品名>                               这份成品能导出的动作：ID、短名、处方原文、呼吸节奏
//   npm run profile -- check <档案目录>                            检查档案（和模板核对）、练习记录、课程，以及写给这个人的复盘和菜单
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";
import { checkCourse } from "./check.ts";
import { failedRedlineCases } from "./redlines.ts";
import { buildSrt } from "./srt.ts";
import { buildTimeline, itemSpec } from "./timeline.ts";
import { validateCourse } from "./validate.ts";
import { bedtimeFor, checkProfileWithTemplates } from "./intake.ts";
import { checkProgress, checkProgressLog, progressOn, REVIEW_FORMAT, type SessionFile, validateReview } from "./progress.ts";
import { loadTemplates, requirePlans, type Templates } from "./node.ts";
import { currentSegment, exportCourse } from "./plan.ts";
import { checkNotes, PROFILE_FORMAT, SESSION_FORMAT, validateProfile, validateSession } from "./profile.ts";
import type { Issue } from "./types.ts";

const USAGE = `用法：
  npm run course -- export <档案目录> <第几周> <哪天> [--out <文件>] [--pick 组=动作]
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

/** 按训练单和档案导出一天：agent 只选哪一天，组数、次数、级、节奏、休息都由训练单和个人进度定。 */
/** 读整个档案目录：练习记录、复盘（文件名和复盘数据）、课程，以及逐个文件的格式和红线问题。 */
function scanDir(dir: string, t: Templates, profile: Record<string, any>) {
  const issues: Issue[] = [];
  const sessions: SessionFile[] = [];
  const reviews: string[] = [];
  const reviewData: Record<string, Record<string, any>> = {};
  const courses: { name: string; raw: Record<string, any>; archived: boolean }[] = [];
  const segN = currentSegment(profile)?.n ?? 1;
  for (const f of walk(dir)) {
    const name = relative(dir, f);
    if (name === "档案.json") continue;
    const archived = name.startsWith(`历史${sep}`);
    if (archived) {
      // 历史/ 只放以前几段的东西：历史/第N段/…，1 ≤ N < 现在的段（不能把这一段的课程挪进去躲检查）
      const r = new RegExp(`^历史\\${sep}第(\\d+)段\\${sep}`).exec(name);
      if (!r || Number(r[1]) < 1 || Number(r[1]) >= segN) {
        issues.push({ level: "error", path: name, message: `历史/ 下只放以前几段的文件（历史/第N段/，N 从 1 起、小于现在的第 ${segN} 段）` });
      }
    }
    // 复盘：复盘/ 下的，和移进 历史/第N段/复盘/ 的（以前几段的复盘照样算数）
    const rv = /(?:^|[\\/])复盘[\\/]([^\\/]+)$/.exec(name);
    if (rv && (!archived || new RegExp(`^历史\\${sep}第\\d+段\\${sep}复盘\\${sep}`).test(name))) reviews.push(rv[1]);
    if (f.endsWith(".json")) {
      const raw = readJson(f) as Record<string, any>;
      const tag = (xs: Issue[]) => xs.map((i) => ({ ...i, path: `${name}${i.path ? " " + i.path : ""}` }));
      if (raw?.schema === SESSION_FORMAT) {
        issues.push(...tag(validateSession(raw)));
        sessions.push({ name: name.split(sep).join("/"), raw, archived });
      }
      else if (raw?.schema === "yangxia.course/1") courses.push({ name, raw, archived });
      else if (raw?.schema === REVIEW_FORMAT) {
        issues.push(...tag(validateReview(raw)));
        if (rv) reviewData[rv[1]] = raw;
      }
      else if (raw?.schema !== PROFILE_FORMAT) issues.push({ level: "warning", path: name, message: "不认识的 JSON 文件（不是课程、练习记录、复盘数据）" });
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
  return { issues, sessions, reviews, reviewData, courses };
}

/** 周次推进和个人进度（不复盘不进下一周、进度只能按规则改）：导出、检查课程之前都要过。 */
function progressIssues(t: Templates, profile: Record<string, any>, scan: ReturnType<typeof scanDir>): Issue[] {
  const out = [...checkProgress(profile, scan.sessions, scan.reviews, new Date(), scan.reviewData)];
  if (t.plans && t.rules) out.push(...checkProgressLog(profile, t.plans, t.rules, scan.sessions, scan.reviewData).map((i) => ({ ...i, path: `档案.json ${i.path}` })));
  else out.push({ level: "warning", path: "档案.json", message: "模板还没有训练单（dist/data/）：个人进度没核对，先更新模板" });
  return out;
}

/** 按训练单和档案导出一天：agent 只选哪一天，组数、次数、级、节奏、休息都由训练单和个人进度定。 */
async function exportCmd(dir: string, weekArg: string, day: string, rest: string[]): Promise<number> {
  const t = await loadTemplates();
  const { plans, rules } = requirePlans(t);
  const profile = readJson(join(dir, "档案.json")) as Record<string, any>;
  const scan = scanDir(dir, t, profile);
  const pre = [...validateProfile(profile).map((i) => ({ ...i, path: `档案.json ${i.path}` })),
    ...checkProfileWithTemplates(profile, t.manifest).map((i) => ({ ...i, path: `档案.json ${i.path}` })),
    ...progressIssues(t, profile, scan)].filter((i) => i.level === "error");
  if (pre.length) {
    console.log("档案目录没通过检查（周复盘、个人进度、档案本身），先改好再导出（npm run profile -- check）：");
    return print(pre);
  }
  const picks: Record<string, string> = {};
  rest.forEach((a, i) => {
    if (a === "--pick" && rest[i + 1]?.includes("=")) {
      const [g, v] = rest[i + 1].split("=");
      picks[g] = v;
    }
  });
  const seg = currentSegment(profile)!;
  // 每次轮换：这一段这一天已经练过几次（练习记录里的课程是同一段、同一天）
  const sessionsDone = scan.sessions.filter((s) => s.raw.course?.source?.day === day && s.raw.course?.source?.segment === seg.n).length;
  const r = exportCourse({ plans, rules, manifest: t.manifest, profile, week: Number(weekArg), day, picks, sessionsDone });
  const sc = profile.screening;
  if (r.course && sc && (profile.age === "a65" || sc.answers?.some((a: any) => a?.answer === "是")) && !sc.doctorCleared) {
    r.issues.push({ level: "error", path: "screening", message: "医生同意之前不出课程（65 岁以上都要先问医生；筛查有\"是\"的也要）" });
  }
  for (const f of r.follow) console.log(`照成品做：${f.name}（${f.reason}）`);
  for (const n of r.notes) console.log(n);
  const errors = r.issues.filter((i) => i.level === "error");
  if (errors.length || !r.course) return print(r.issues);
  const issues = checkCourse(r.course, { manifest: t.manifest, readProduct: t.readProduct, profile, plans, rules });
  const oi = rest.indexOf("--out");
  const out = oi >= 0 && rest[oi + 1] ? rest[oi + 1] : join(dir, "课程", `第${seg.n}段-第${r.course.source.week}周-${day}日.json`);
  if (!issues.some((i) => i.level === "error")) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify(r.course, null, 2) + "\n");
    console.log(`已导出：${out}`);
  }
  return print([...r.issues, ...issues]);
}

/**
 * 档案目录里的课程：
 * - 现在这一段这一周的，逐项核对；对不上的，如果和进度后来改动之前那一天的进度对得上，只提醒"要练就重新导出"；
 * - 以前几周、几段导出的，只核对格式（当时的进度、模板可能都不一样了），提醒一下；
 * - 历史/ 下的只核对格式。
 */
function courseIssues(t: Templates, profile: Record<string, any>, scan: ReturnType<typeof scanDir>): Issue[] {
  const out: Issue[] = [];
  const seg = currentSegment(profile);
  const ctx = (p: Record<string, any>) => ({ manifest: t.manifest, readProduct: t.readProduct, profile: p, plans: t.plans, rules: t.rules });
  for (const c of scan.courses) {
    const tag = (xs: Issue[]) => xs.map((i) => ({ ...i, path: `${c.name}${i.path ? " " + i.path : ""}` }));
    const src = c.raw?.source ?? {};
    if (c.archived) {
      out.push(...tag(validateCourse(c.raw).issues));
      continue;
    }
    if (src.plan && seg && (src.segment !== seg.n || src.week !== seg.week || src.type !== seg.type)) {
      out.push(...tag(validateCourse(c.raw).issues));
      out.push({ level: "warning", path: c.name, message: `以前导出的课程（第 ${src.segment} 段第 ${src.week} 周），只核对格式；要再练就重新导出` });
      continue;
    }
    const got = checkCourse(c.raw, ctx(profile));
    if (got.some((i) => i.level === "error") && src.plan && t.plans && t.rules) {
      const dates = [...new Set((profile.progressLog ?? []).map((e: any) => e?.date).filter((d: unknown) => typeof d === "string"))].sort().reverse() as string[];
      const earlier = dates.map((d) => {
        const prev = new Date(new Date(`${d}T12:00:00`).getTime() - 86_400_000);
        const day = `${prev.getFullYear()}-${String(prev.getMonth() + 1).padStart(2, "0")}-${String(prev.getDate()).padStart(2, "0")}`;
        return { day, progress: progressOn(profile, t.plans!, t.rules!, day) };
      });
      const hit = earlier.find((e) => !checkCourse(c.raw, ctx({ ...profile, progress: e.progress })).some((i) => i.level === "error"));
      // 那之后往下调过（减量、退回、找级降级），或者有过不适：旧课程比现在的进度重，不能只提醒
      const downAfter = hit && (profile.progressLog ?? []).some((e: any) => e?.date > hit.day && (e.rule === "减量" || e.rule === "退回"
        || (e.rule === "找级" && Number(e.to) < Number(progressOn(profile, t.plans!, t.rules!, hit.day)?.[e.move]?.[e.field] ?? Infinity))));
      const sickAfter = hit && scan.sessions.some((s) => { const st = Date.parse(s.raw?.startedAt); return !Number.isNaN(st) && st >= new Date(`${hit.day}T00:00:00`).getTime()
        && !!(s.raw?.symptoms?.pain || s.raw?.symptoms?.dizzy || s.raw?.symptoms?.chest); });
      if (hit && (downAfter || sickAfter)) {
        out.push({ level: "error", path: c.name, message: `这份课程是按 ${hit.day} 的进度导出的，之后${sickAfter ? "有过疼痛、头晕或胸闷" : "进度往下调过"}：旧课程比现在重，删掉或者重新导出` });
        continue;
      }
      if (hit) {
        out.push({ level: "warning", path: c.name, message: `档案进度在这份课程导出之后改过（它对得上 ${hit.day} 的进度）：要再练就重新导出` });
        continue;
      }
    }
    out.push(...tag(got));
  }
  return out;
}

async function profileCheck(dir: string): Promise<number> {
  const t = await loadTemplates();
  const profile = readJson(join(dir, "档案.json")) as Record<string, any>;
  const inProfile = (xs: Issue[]) => xs.map((i) => ({ ...i, path: `档案.json${i.path ? " " + i.path : ""}` }));
  const scan = scanDir(dir, t, profile);
  return print([
    ...inProfile(validateProfile(profile)), ...inProfile(checkProfileWithTemplates(profile, t.manifest)),
    ...scan.issues, ...courseIssues(t, profile, scan), ...progressIssues(t, profile, scan),
  ]);
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
  if (cmd === "export") {
    if (!file || !rest[0] || !rest[1]) {
      console.log(USAGE);
      return 2;
    }
    return exportCmd(file, rest[0], rest[1], rest.slice(2));
  }
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
    const profile = pi >= 0 ? readJson(rest[pi + 1]) as Record<string, any> : undefined;
    const issues = checkCourse(raw, { manifest: t.manifest, readProduct: t.readProduct, profile, plans: t.plans, rules: t.rules });
    if (profile) {
      // 档案目录里的周复盘、进度日志也要过：不复盘、不按规则改进度，课程就不能交出去
      if (basename(rest[pi + 1]) === "档案.json") {
        issues.push(...progressIssues(t, profile, scanDir(dirname(rest[pi + 1]), t, profile)).filter((i) => i.level === "error"));
      } else issues.push({ level: "error", path: "", message: "--profile 要给档案目录里的 档案.json（profiles/<代号>/档案.json）：周复盘和个人进度要连同目录一起核对" });
    }
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
