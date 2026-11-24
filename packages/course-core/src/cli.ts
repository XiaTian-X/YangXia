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
//   npm run course -- assess <档案目录> <入门|段末|周期末|触发> [记录.json]  评估：列出要问、要测的项；给了记录就重算结论、核对
//   npm run course -- plan <档案目录>                               生成现在这一周的个人计划单（计划/第N段-第N周.md）
//   npm run profile -- check <档案目录>                            检查档案（和模板核对）、练习记录、课程，以及写给这个人的复盘和菜单
//   npm run profile -- import <档案目录> <记录.json>… [--dry-run] [--replace]   按格式校验练习记录，写进 打卡/（不让 agent 手抄）
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { checkCourse } from "./check.ts";
import { failedRedlineCases } from "./redlines.ts";
import { buildSrt } from "./srt.ts";
import { buildTimeline, itemSpec } from "./timeline.ts";
import { SOURCE_KEYS, validateCourse } from "./validate.ts";
import { bedtimeFor, checkProfileWithTemplates } from "./intake.ts";
import { checkProgress, checkProgressLog, localDate, progressOn, REVIEW_FORMAT, type SessionFile, validateReview } from "./progress.ts";
import { loadTemplates, requirePlans, sequencerPath, sequencerStamp, type Templates } from "./node.ts";
import { PACKAGE_FORMAT, packageInfo, packCourse, unpackCourse } from "./package.ts";
import { courseIdFor, currentSegment, exportCourse, stableParam } from "./plan.ts";
import { fallRiskRules } from "./fallrisk.ts";
import { cycleGoals, goalCardioHint, goalIssues, severeObese } from "./goals.ts";
import { activeAddOns, addOnIssues } from "./senior.ts";
import { ASSESS_FORMAT, type AssessFile, ageAt, assessRules, cardioMode, cycleEnd, balanceHold, checkAssessments, checkRecord, doctorNeed, gap, param, productInfo, recordConclusion, segmentEnd, validateAssessment } from "./assess.ts";
import { checkDeclaration, checkNotes, DECLARATION, PROFILE_FORMAT, SESSION_FORMAT, validateProfile, validateSession } from "./profile.ts";
import { buildSheet, checkSheet, sheetFile } from "./sheet.ts";
import type { Course, Issue } from "./types.ts";

const USAGE = `用法：
  npm run course -- export <档案目录> <第几周> <哪天> [--out <文件>] [--pick 组=动作] [--half] [--no-package]
  npm run course -- assess <档案目录> <入门|段末|周期末|触发> [记录.json] [--product <成品名>]
  npm run course -- plan <档案目录>
  npm run course -- check <课程.json> --profile <档案.json>
  npm run course -- check <课程.json> --no-profile
  npm run course -- summary <课程.json>
  npm run course -- srt <课程.json>
  npm run course -- cases
  npm run course -- intake [年龄段]
  npm run course -- bedtime <阶段> <起床时间>
  npm run course -- moves <成品名>
  npm run profile -- check <档案目录>
  npm run profile -- import <档案目录> <记录.json>… [--dry-run] [--replace]`;

async function intake(age?: string): Promise<number> {
  const { manifest, rules } = await loadTemplates();
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
  const VENUE: Record<string, string> = { gym: "健身房", home: "居家（2.5kg 哑铃 + 动感单车）", bw: "纯徒手", play: "户外与游戏", chair: "椅子辅助", meal: "全家餐饮", book: "附册" };
  console.log("\n成品（档案的 product 写成品名）：");
  const books = manifest.products.filter((x) => (!age || x.age === age) && (x as Record<string, any>).phase === "附册");
  for (const p of manifest.products.filter((x) => (!age || x.age === age) && (x as Record<string, any>).phase !== "附册")) {
    const stable = (p as Record<string, any>).phase === "稳定";
    // 旧模板（v3.3 以前）没有"直接进入"：照有没有登记"有基础……"的门槛判断
    const fam = `${p.age}·${p.venue}`;
    const dp = stableParam(rules, fam, "直接进入");
    const direct = stable && (dp ? dp.value === "是" : stableParam(rules, fam, "有基础每周力量天数") !== undefined);
    console.log(`  ${p.name}（${p.age}·${p.venue}，${VENUE[p.venue] ?? p.venue}${!stable ? "" : direct ? "；稳定期：起始期段末到了进阶线、或者有基础的人直接进入才用，新手选起始期那一份" : "；稳定期：起始期段末到了进阶线才用，不设直接进入，建档选起始期那一份"}）`);
  }
  if (books.length) console.log(`\n附册（不是计划，不能选成档案的 product；超重、肥胖的人配合本年龄段的计划看）：${books.map((p) => p.name).join("、")}`);
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
  if ((p as { phase?: string }).phase === "附册") {
    console.log(`「${product}」是附册：配合同一年龄段的纯徒手、居家或健身房版看，没有训练，也不能选成档案的成品`);
    return 0;
  }
  const code = `${p.age}·${p.venue}`;
  const list = manifest.exercises.filter((e) => e.used.includes(code));
  if (!list.length) {
    console.log(`「${product}」没有可以导出的动作（6–12 岁版不用组数次数，全家餐饮、附册没有训练）`);
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
  const assessments: AssessFile[] = [];
  const sheets: { name: string; text: string }[] = [];
  const packages: PackageFile[] = [];
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
      else if (raw?.schema === ASSESS_FORMAT) {
        issues.push(...tag(validateAssessment(raw)));
        if (!name.startsWith(`评估${sep}`) && !archived) issues.push({ level: "error", path: name, message: "评估记录放在 评估/ 下：评估/<日期>-<种类>.json" });
        assessments.push({ name: name.split(sep).join("/"), raw });
        if (typeof raw?.note === "string") {
          const ar0 = assessRules(t.rules);
          const own = ar0 && ageAt(profile, localDate(new Date()), ar0.assess).age === "a65" ? ["a65"] : [];
          issues.push(...checkNotes(t.manifest.redlines, [...new Set([profile.age, ...own])], name, raw.note));
        }
      }
      else if (raw?.schema === REVIEW_FORMAT) {
        issues.push(...tag(validateReview(raw)));
        if (rv) reviewData[rv[1]] = raw;
      }
      else if (raw?.schema !== PROFILE_FORMAT) issues.push({ level: "warning", path: name, message: "不认识的 JSON 文件（不是课程、练习记录、复盘数据、评估记录）" });
    } else if (f.endsWith(".md") || f.endsWith(".txt")) {
      // 菜单给全家吃：按全家餐饮的红线，加上每个家庭成员年龄段的红线（家里有孩子，就不能谈体重、减重）
      const menu = name.startsWith(`菜单${sep}`);
      if (menu && !Array.isArray(profile.household)) {
        issues.push({ level: "error", path: name, message: "排菜单前要在档案里记下家庭成员的年龄段（household），菜单按每个人的红线检查" });
      }
      // 满 65 岁当月起按 65 岁以上的红线查（成品还没换过来的窗口里也一样）
      const ar0 = assessRules(t.rules);
      const own = ar0 && ageAt(profile, localDate(new Date()), ar0.assess).age === "a65" ? ["a65"] : [];
      const ages = [...new Set(menu ? ["fam", profile.age, ...own, ...(profile.household ?? [])] : [profile.age, ...own])];
      const text = readFileSync(f, "utf8");
      issues.push(...checkNotes(t.manifest.redlines, ages, name, text));
      // 计划、菜单、复盘都是生成的计划：开头要有声明（历史/ 里以前的不查）
      if (!archived && /^(计划|菜单|复盘)[\\/]/.test(name)) issues.push(...checkDeclaration(name, text));
      if (!archived && /^计划[\\/]/.test(name)) sheets.push({ name, text });
    } else if (f.endsWith(".html")) {
      // 课程包（v4 阶段 8c）：课程/ 和 历史/第N段/课程/ 下的才认；带课程包标记的放错地方报错
      const inCourses = /^(?:历史[\\/]第\d+段[\\/])?课程[\\/][^\\/]+$/.test(name);
      const html = readFileSync(f, "utf8");
      if (inCourses) packages.push({ name, archived, html });
      else if (packageInfo(html).info || /id="yangxia-course"/.test(html)) {
        const embedded = !unpackCourse(html).empty;
        issues.push({ level: "error", path: name, message: embedded ? "课程包放在 课程/ 下" : "编排器（没嵌课程）不放在档案目录里" });
      }
      else issues.push({ level: "warning", path: name, message: "不认识的文件：复盘、菜单写成 .md，课程、练习记录是 .json，课程包放在 课程/；别的文件不检查" });
    } else if (!name.split(sep).some((s) => s.startsWith("."))) {
      issues.push({ level: "warning", path: name, message: "不认识的文件：复盘、菜单写成 .md，课程、练习记录是 .json；别的文件不检查" });
    }
  }
  return { issues, sessions, reviews, reviewData, courses, assessments, sheets, packages };
}

interface PackageFile { name: string; archived: boolean; html: string }

/** 按 JSON 内容比（键的顺序、缩进不算）。 */
function sameJson(a: unknown, b: unknown): boolean {
  const norm = (v: unknown): unknown => Array.isArray(v) ? v.map(norm)
    : v && typeof v === "object" ? Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, norm((v as Record<string, unknown>)[k])])) : v;
  return JSON.stringify(norm(a)) === JSON.stringify(norm(b));
}

/**
 * 课程包（v4 阶段 8c 方案 2.3）：嵌的课程要和对应的课程 JSON 完全一样（课程检查只认 JSON，课程包躲不过检查），
 * 动图版本要等于课程的模板版本；以前几周的课程包提醒可以删。
 * 对应的 JSON：先找同名的，再按名字后半段（第N段-第N周-X日[-半量]）认，档案目录改过名也对得上。
 */
function packageIssues(profile: Record<string, any>, scan: ReturnType<typeof scanDir>): Issue[] {
  const out: Issue[] = [];
  const seg = currentSegment(profile);
  const byName = new Map(scan.courses.map((c) => [c.name, c]));
  for (const p of scan.packages) {
    const err = (message: string) => out.push({ level: "error", path: p.name, message });
    const info = packageInfo(p.html);
    const u = unpackCourse(p.html);
    if (!info.info || u.error || u.empty) {
      err(`不是养夏课程包（或者是旧版编排器）：删掉，或者重新导出${u.error ? `（${u.error}）` : info.error ? `（${info.error}）` : ""}`);
      continue;
    }
    const dirPart = p.name.slice(0, p.name.length - basename(p.name).length);
    const same = `${p.name.slice(0, -".html".length)}.json`;
    const tail = /^(?:.+-)?(第\d+段-第\d+周-.+日(?:-半量)?)\.html$/.exec(basename(p.name))?.[1];
    const json = byName.get(same) ?? (tail ? byName.get(`${dirPart}${tail}.json`) : undefined);
    if (!json) {
      err("没有对应的课程 JSON（课程检查只认 JSON）：删掉课程包，或者重新导出");
      continue;
    }
    if (!sameJson(u.course, json.raw)) {
      err(`课程包和课程 JSON（${json.name}）对不上：重新导出`);
      continue;
    }
    const src = (u.course as { source?: Record<string, any> }).source ?? {};
    if (info.info.motions !== src.templates) err(`课程包里的动作示意是模板 ${info.info.motions} 的，课程是 ${src.templates ?? "（没写）"} 的：重新打包编排器、重新导出`);
    if (p.archived) out.push({ level: "warning", path: p.name, message: "历史/ 里不留课程包：删掉就好（课程 JSON 留着）" });
    else if (seg && (src.segment !== seg.n || src.week !== seg.week)) {
      out.push({ level: "warning", path: p.name, message: "以前几周的课程包：复盘完可以删（课程 JSON 留着）" });
    }
  }
  return out;
}

/** 周次推进和个人进度（不复盘不进下一周、进度只能按规则改）：导出、检查课程之前都要过。 */
function progressIssues(t: Templates, profile: Record<string, any>, scan: ReturnType<typeof scanDir>): Issue[] {
  const out = [...checkProgress(profile, scan.sessions, scan.reviews, new Date(), scan.reviewData)];
  if (t.plans && t.rules) out.push(...checkProgressLog(profile, t.plans, t.rules, scan.sessions, scan.reviewData, new Date(), scan.assessments).map((i) => ({ ...i, path: `档案.json ${i.path}` })));
  else out.push({ level: "warning", path: "档案.json", message: "模板还没有训练单（dist/data/）：个人进度没核对，先更新模板" });
  out.push(...checkAssessments(assessCtx(t, profile, scan)));
  out.push(...goalIssues(assessCtx(t, profile, scan)));
  out.push(...addOnIssues(assessCtx(t, profile, scan)));
  return out;
}

/** 评估记录、复盘数据、练习记录本身的写法错误（导出、带档案的课程检查也要拦，不只是 profile check）。 */
function recordIssues(scan: ReturnType<typeof scanDir>): Issue[] {
  return scan.issues.filter((i) => /^(评估|复盘|打卡)[\\/]/.test(i.path) || /^历史[\\/]第\d+段[\\/](评估|复盘|打卡)[\\/]/.test(i.path));
}

const info0 = (t: Templates, name: string) => productInfo(t.manifest, name);

function assessCtx(t: Templates, profile: Record<string, any>, scan: ReturnType<typeof scanDir>) {
  return { profile, manifest: t.manifest, plans: t.plans, rules: t.rules, sessions: scan.sessions, reviewData: scan.reviewData, assessments: scan.assessments };
}

/** 按训练单和档案导出一天：agent 只选哪一天，组数、次数、级、节奏、休息都由训练单和个人进度定。 */
async function exportCmd(dir: string, weekArg: string, day: string, rest: string[]): Promise<number> {
  const t = await loadTemplates();
  const { plans, rules } = requirePlans(t);
  const profile = readJson(join(dir, "档案.json")) as Record<string, any>;
  const scan = scanDir(dir, t, profile);
  const pre = [...validateProfile(profile).map((i) => ({ ...i, path: `档案.json ${i.path}` })),
    ...checkProfileWithTemplates(profile, t.manifest).map((i) => ({ ...i, path: `档案.json ${i.path}` })),
    ...progressIssues(t, profile, scan), ...recordIssues(scan)].filter((i) => i.level === "error");
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
  const half = rest.includes("--half");
  const ctx = assessCtx(t, profile, scan);
  // 65 岁以上稳定期：这一周有效的加项（医生同意、看完医生回来清零都算上）
  const wkStart = (profile.segments as any[]).filter((s) => s.n === seg.n && s.week === Number(weekArg)).pop()?.start;
  const addOns = typeof wkStart === "string" ? activeAddOns(ctx, wkStart) : undefined;
  const r = exportCourse({ plans, rules, manifest: t.manifest, profile, week: Number(weekArg), day, picks, sessionsDone, half, addOns });
  const doc = doctorNeed(ctx);
  if (r.course && doc.needed && !doc.ok) {
    r.issues.push({ level: "error", path: "screening", message: `医生同意之前不出课程（${doc.reason}：医生同意的日期 doctorDate 要不早于 ${doc.after}）` });
  }
  // 重度肥胖按导出的这一周开始那天推（和计划单一样）
  const weekStart = wkStart ?? localDate(new Date());
  const cm = info0(t, seg.product) ? cardioMode(t.rules, profile, info0(t, seg.product)!, seg.n, Number(weekArg), scan.reviewData,
    { severe: severeObese(ctx, weekStart, info0(t, seg.product)!.code) }) : null;
  if (cm) r.notes.push(`有氧：这一周做${cm.mode}${cm.mode === "稳态" && cm.interval ? "，不做间歇" : ""}${cm.duration ? `，${cm.duration}` : ""}（${cm.why}）`);
  const gh = goalCardioHint(ctx, (profile.segments as any[]).length - 1);
  if (gh) r.notes.push(gh);
  if (balanceHold(ctx)) r.notes.push("摔倒过：医生同意之前不练平衡动作（6–9 号），照成品第十二章；力量动作也先问医生");
  const info = productInfo(t.manifest, seg.product);
  const today = localDate(new Date());
  const g = info ? gap(ctx, info.code, today) : null;
  if (g && g.days > g.remindDays && !half) {
    // 断了很久、做过"中断"触发评估之后的第一次：照成品"回来第一次只做一半的量"，必须半量
    if (g.long) r.issues.push({ level: "error", path: "", message: `最后一次训练是 ${g.last}，断了 ${g.days} 天：回来第一次只做一半的量，加 --half 导出半量课` });
    else r.notes.push(`最后一次训练是 ${g.last}，断了 ${g.days} 天：照成品，回来第一次只做一半的量——加 --half 重新导出半量课`);
  }
  if (half && !(g && g.days > g.remindDays)) r.notes.push("没有发现中断：半量课只用在中断、生病回来的第一次（照样算训练次数，不当加量依据）");
  for (const f of r.follow) console.log(`照成品做：${f.name}（${f.reason}）`);
  for (const n of r.notes) console.log(n);
  const errors = r.issues.filter((i) => i.level === "error");
  if (errors.length || !r.course) return print(r.issues);
  const issues = checkCourse(r.course, { manifest: t.manifest, readProduct: t.readProduct, profile, plans, rules, addOns });
  const oi = rest.indexOf("--out");
  const custom = oi >= 0 && rest[oi + 1] ? rest[oi + 1] : null;
  // 半量课和全量课 id 不同，文件名也分开（以前写同一个名字会互相覆盖）
  const stem = `第${seg.n}段-第${r.course.source.week}周-${day}日${r.course.source.half ? "-半量" : ""}`;
  const out = custom ?? join(dir, "课程", `${stem}.json`);
  if (!issues.some((i) => i.level === "error")) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify(r.course, null, 2) + "\n");
    console.log(`已导出：${out}`);
    const pkg = custom ? (/\.json$/i.test(custom) ? custom.replace(/\.json$/i, ".html") : `${custom}.html`)
      : join(dir, "课程", `${safeCode(String(profile.code ?? basename(dir)))}-${stem}.html`);
    // --out 指到编排器打包目录本身：课程包会覆盖打包好的编排器，不出
    if (resolve(pkg) === resolve(sequencerPath())) console.log(`没出课程包：${pkg} 就是打包好的编排器，换一个 --out 路径`);
    else await writePackage(t, r.course, pkg, rest.includes("--no-package"));
    console.log(DECLARATION.replace(/^> /, "声明："));
  }
  return print([...r.issues, ...issues]);
}

/** 代号放进课程包的文件名：部分手机文件系统不能用的字符换成 _。 */
const safeCode = (code: string) => code.replace(/[:*?"<>|\\/]/g, "_");

/**
 * 课程包（v4 阶段 8c 方案 2.2）：用打包好的编排器嵌这节课。编排器没打包、代码改过没重新打包、动图和模板对不上时
 * 不出课程包，只留 JSON，并删掉同名的旧课程包（免得旧的被发出去）。不影响命令成功与否。
 * 只删、只覆盖养夏自己的课程包（有打包标记的）：同名的别的文件（比如 --out 旁边使用者自己的网页）一律不动。
 */
async function writePackage(t: Templates, course: Course, path: string, skip: boolean): Promise<void> {
  const ours = () => {
    try {
      return !!packageInfo(readFileSync(path, "utf8")).info;
    } catch {
      return false;
    }
  };
  const dropOld = (why: string) => {
    if (existsSync(path)) {
      if (ours()) {
        unlinkSync(path);
        console.log(`旧课程包已删：${path}（不出新的课程包，旧的删掉，免得被发出去）`);
      } else console.log(`${path} 不是养夏课程包，没有动它`);
    }
    console.log(`没出课程包：${why}`);
  };
  if (skip) return dropOld("加了 --no-package");
  if (existsSync(path) && !ours()) {
    console.log(`没出课程包：${path} 已经有一个不是养夏课程包的文件，没有动它`);
    return;
  }
  const reason = await packageProblem(t, course);
  if (reason) return dropOld(`${reason}。先 npm run build 打包编排器，再重新导出`);
  const html = readFileSync(sequencerPath(), "utf8");
  const r = packCourse(html, course, localDate(new Date()));
  if (!r.html) return dropOld(`${r.error}`);
  writeFileSync(path, r.html);
  console.log(`已导出课程包：${path}`);
  console.log("课程包里只有这节课的内容；发给自己的手机（文件传输助手、AirDrop、数据线），不要发到群里。手机上先保存，再用浏览器打开。");
}

/** 打包好的编排器能不能出这节课的课程包；能就返回 null。 */
async function packageProblem(t: Templates, course: Course): Promise<string | null> {
  const file = sequencerPath();
  if (!existsSync(file)) return `没有找到打包好的编排器（${file}）`;
  const p = packageInfo(readFileSync(file, "utf8"));
  if (!p.info) return `编排器${p.error}`;
  if (p.info.format !== PACKAGE_FORMAT) return `编排器的打包格式是「${p.info.format}」，这里只认 ${PACKAGE_FORMAT}`;
  const mf = join(t.dir, "dist", "data", "motions.json");
  if (p.info.motions === "none" || !existsSync(mf)) return "编排器打包时没带动作示意动图";
  const stamp = await sequencerStamp();
  if (p.info.motionsHash !== stamp.motionsHash(readFileSync(mf, "utf8"))) return "编排器里的动作示意动图和现在的模板不一样（模板更新过）";
  if (p.info.motions !== course.source.templates) return `编排器的动图是模板 ${p.info.motions} 的，课程是 ${course.source.templates ?? "（没写）"} 的`;
  const src = stamp.sourceHash();
  if (!src) return "算不出源码哈希（不是 git 检出，或者没装 git），当作编排器过期";
  if (src !== p.info.source) return "编排器的代码改过，打包好的还是旧的";
  return null;
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
  // 65 岁以上稳定期：现在这一周有效的加项，和导出时同一个算法（看完医生回来清零、同意失效都算上）
  const cur = (profile.segments ?? []).at(-1);
  const addOns = cur && typeof cur.start === "string" ? activeAddOns(assessCtx(t, profile, scan), cur.start) : undefined;
  const ctx = (p: Record<string, any>) => ({ manifest: t.manifest, readProduct: t.readProduct, profile: p, plans: t.plans, rules: t.rules, addOns });
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
        out.push({ level: "error", path: c.name, message: `这份课程是按 ${hit.day} 的进度导出的，之后${sickAfter ? "有过疼痛、头晕或胸闷" : "进度往下调过"}：旧课程比现在重，连同对应的课程包一起删掉，或者重新导出` });
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

/** 评估：没给记录，列出这一种要问、要测的项（照规则层原文）；给了记录，重算结论、核对。 */
async function assessCmd(dir: string, kind: string, args: string[]): Promise<number> {
  const pi = args.indexOf("--product");
  const productArg = pi >= 0 ? args[pi + 1] : undefined;
  const file = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--product");
  const t = await loadTemplates();
  const profile = readJson(join(dir, "档案.json")) as Record<string, any>;
  const scan = scanDir(dir, t, profile);
  const ar = assessRules(t.rules);
  if (!ar) {
    console.log("模板还没有评估规则（rules.json 的 assess）：先把模板仓库更新到 v4 阶段 2 之后");
    return 2;
  }
  if (!["入门", "段末", "周期末", "触发"].includes(kind)) {
    console.log("种类写 入门 / 段末 / 周期末 / 触发");
    return 2;
  }
  const seg0 = currentSegment(profile);
  if (seg0 && kind === "周期末" && seg0.phase !== "稳定" && !(profile.segments as any[]).some((x) => x.phase === "稳定")) {
    console.log("周期末评估只在稳定期第 12 周之后做；起始期每段第 4 周之后做的是段末评估");
    return 2;
  }
  const seg = currentSegment(profile);
  const product = productArg ?? (file ? (readJson(file) as Record<string, any>).product : undefined) ?? seg?.product ?? profile.product;
  const info = productInfo(t.manifest, product);
  if (!info) {
    console.log(`模板里没有成品「${product}」`);
    return 2;
  }
  if (!file) {
    console.log(`${kind}评估 · ${product}（未经专业审核，不是医学建议${info.age === "a65" ? "；65 岁以上的测试在医生同意以后、家人在场时做" : ""}）`);
    if (kind === "触发") {
      console.log(`原因（reasons）：跨段 / 满一年 / 身体变化 / 生病住院 / 生病 / 摔倒 / 换场地 / 中断 / 看完医生回来 / 回起始期（稳定期的人自己要求）；摔倒、生病住院写那天 eventDate；医生建议从头来的加 doctorRestart: true`);
      console.log(`跨段、换场地：product 写新成品，带上新成品入门的项目（加 --product <新成品名> 列出来）${productArg ? "" : `；下面列的是「${product}」的`}`);
      const at = ageAt(profile, localDate(new Date()), ar.assess);
      if (at.age && at.age !== info.age) console.log(`现在推算是${at.stage}（${at.age}），「${product}」是 ${info.age}：跨段要换到 ${at.age} 的成品，用 --product 列它的项目`);
    }
    const timing = kind === "段末" || kind === "周期末" ? "段末" : "入门";
    for (const pr of ar.assess.prereqs.filter((x) => x.products.includes(info.code))) console.log(`开工前提 ${pr.id}：${pr.ask}（是 / 否；${pr.note}）`);
    if (kind === "入门" && ["a18", "a40", "a13"].includes(info.age)) console.log("训练基础 base：最近 3 个月平均每周几天力量练习（0、1、2 及以上；18–64 岁徒手、居家是直接进稳定期的门槛之一，其余只记录）");
    for (const x of ar.assess.tests.filter((x) => x.products.includes(info.code) && x.timing.includes(timing))) {
      if (x.id === "body" && profile.body !== "记") continue;
      console.log(`测试 ${x.id}：记 ${x.fields.join("、")}；${x.judge}（${x.note}）`);
      const cap = param(ar.assess, "高血压静蹲上限", info.code)?.number;
      if (x.id === "wallsit-test" && cap !== undefined && profile.conditions?.["高血压"] !== false) console.log(`  这个人有高血压或没确认：静蹲最多 ${cap} 秒`);
    }
    if (info.age === "a65" && kind === "段末") console.log("weightDrop：体重有没有明显下降（是 / 否，不记数字）");
    const fr = fallRiskRules(t.rules);
    if (fr && info.age === "a65" && kind !== "段末" && kind !== "周期末") {
      console.log(`\n跌倒风险自查（fallRisk；照 WS/T 887—2026 第 5 章，不是正式评估；${kind === "触发" ? "跨段、满一年、摔倒、生病住院、身体变化、跌倒自查到期都要做" : "建档时要做"}）`);
      console.log("第一部分 问卷（看医生之前可以做，原话照念）：");
      for (const q of fr.questions) console.log(`  ${q.id}（${q.clause}，问${q.who}${q.part === "严重程度" ? "；一般性有\"是\"或说不清才问" : ""}）：${q.quotes.map((x) => x.text).join("")}`);
      console.log(`  衰弱 5 条（${fr.frailMin} 条及以上算"是"）：${fr.frail.map((x) => `${x.id}「${x.quotes.map((q) => q.text).join("")}」`).join("；")}`);
      console.log("  另问：needsSupport（在家走路也要扶墙或用助行器）、hardToStand（扶着椅子也很难自己站起来）、dizzy（经常头晕，或者站起来时眼前发黑）");
      const dz = (profile.screening?.answers ?? []).find((x: any) => /经常头晕/.test(x?.item ?? ""));
      if (dz) console.log(`  （档案现在的安全筛查"经常头晕"是"${dz.answer}"，${profile.screening?.date ?? "没写日期"} 做的：问卷要和它对得上，不一样的先照实重做筛查；测步态那天有效的筛查是"是"的不在家测）`);
      console.log("第二部分 步态（医生同意以后、家人在场时做；过去 12 个月跌倒过、高风险（含正式评估说高风险）、走路要扶、站起困难、经常头晕的不在家测）：");
      console.log("  测之前照成品第〇章《跌倒风险自查》\"测之前\"那几条做：一人护在身边、一人计时，只有一个家人的先护后计时，护不过来就不测；地面防滑、清空、光线够，终点线外留减速的地方；穿包脚防滑的鞋，平时用手杖的照用；不把判定线念给老人听；头晕、腿软、身体晃立刻停下坐好");
      for (const g of fr.gait) console.log(`  ${g.id}：${g.id === "walk4m" ? `${g.distance} m，喊"开始"的同时按表、前脚脚跟超过终点线停表，用时超过 ${(g.distance ?? 4) / g.line} 秒阳性` : `背离开椅背时按表、背靠到椅背上时停表，超过 ${g.line} 秒阳性`}（按留余量的线 ${g.margin} 秒）；记 seconds（往大里取一位小数）、cane、siteOk${g.id === "tug" ? "、chairOk（有扶手和靠背、无轮子、约 46 cm）" : ""}、testedOn`);
      console.log("  测不了写 { result: \"没测成\", reason }（中途停下的写 stopReason）；按规则不测写 { result: \"按规则不测\", reason }。");
      console.log(`  看过结果的医生同意写 fallRiskSeen: true（同意的日期要在问卷之后 ${fr.askedValidDays} 天以内）；正式评估写 official { date, afterFall, level? }——自查前后 ${fr.officialRecentDays} 天以内的等级才并进结论`);
    }
    if (kind === "周期末") {
      const segs = profile.segments as any[];
      const stableNs = [...new Set(segs.filter((x) => x.phase === "稳定").map((x) => x.n))] as number[];
      const done = stableNs.filter((n) => segs.some((x) => x.n === n && x.week === (t.rules?.stable?.cycleWeeks ?? 12)));
      const n = done.length ? done[done.length - 1] : stableNs[stableNs.length - 1];
      const end = done.length ? cycleEnd(assessCtx(t, profile, scan), n) : null;
      if (!end) console.log(`周期末结论：现在是稳定期第 ${seg?.week} 周，第 ${t.rules?.stable?.cycleWeeks ?? 12} 周的周复盘做完才算`);
      else if ("error" in end) console.log(`周期末结论：${end.error}`);
      else {
        console.log(`第 ${n} 段（稳定期）：12 周训练 ${end.trainings} 次；达标周数 ${Object.entries(end.habitWeeks).map(([h, w]) => `${h} ${w}`).join("、")}`);
        const a65 = productInfo(t.manifest, (segs.find((x: any) => x.n === n) ?? {}).product)?.age === "a65";
        console.log(`结论：${end.result}；下一段：${end.next.phase === "不开" ? "先不开：周期末以后看医生，做触发评估\"看完医生回来\"写明 doctorRestart（true 回起始期第 1 周；false 照后面几条再算一次）"
          : end.next.phase === "稳定" ? `下一周期${end.next.hold ? (a65 ? "（第一轮不加项）" : "（第一轮不升级）") : ""}` : `回起始期${end.next.type}段`}`);
        for (const q of end.quotes) console.log(`  原文：${q}`);
        if (end.next.phase === "稳定") {
          const cg = cycleGoals(assessCtx(t, profile, scan), n);
          if (cg) console.log(`下一周期能选的目标（还没算周期末量的体重腰围；写好记录再跑一次，结论的 goals 照重算的写）：${cg.goals.join("、")}——${cg.why}。选减脂、增肌的，照第八章开头原话问一次进食困扰（eatingCheck），记 goal`);
        }
      }
    }
    if (kind === "段末" && seg) {
      // 刚练完的那一段：现在这一段到了第 4 周就是它，否则是上一段（已经开了下一段的第 1 周）
      const n = seg.week === 4 || seg.n === 1 ? seg.n : seg.n - 1;
      if (n !== seg.n) console.log(`（第 ${seg.n} 段已经开了，这里算的是第 ${n} 段的段末）`);
      const end = segmentEnd(profile, n, scan.reviewData, ar, info.code);
      if ("error" in end) console.log(`段末结论：${end.error}`);
      else {
        const capW = param(ar.assess, seg.type === "减量" ? "减量段每周排的训练" : "每周排的训练", info.code)?.value;
        const hab = Object.entries(end.numbers.habits).map(([h, xs]) => `${h} ${xs.map((x) => x.days).join("/")}`).join("；");
        console.log([capW ? `四周训练 ${end.numbers.trainings}（每周最多算 ${capW} 次）` : "", hab ? `打卡：${hab}` : "",
          end.numbers.sick ? `生病 ${end.numbers.sick} 天` : "", end.numbers.falls ? `摔倒、差点摔倒、头晕 ${end.numbers.falls} 次` : "",
          end.numbers.symptoms ? "这一段有过不适" : ""].filter(Boolean).join("；"));
        console.log(`结论：${end.result}${end.downgraded ? "（有不适，往上的结论降为原样）" : ""}；下一段：${end.next}${end.extras.length ? `；附加：${end.extras.join("、")}` : ""}${Object.keys(end.habitTargets).length ? `；习惯目标 ${JSON.stringify(end.habitTargets)}` : ""}`);
        for (const q of end.quotes) console.log(`  原文：${q}`);
        if (end.next === "不开") {
          const after = segmentEnd(profile, n, scan.reviewData, ar, info.code, { afterDoctor: true });
          if (!("error" in after)) console.log(`医生同意、做了"看完医生回来"的触发评估以后：照后面几条走——${after.result}${after.downgraded ? "（往上的降级）" : ""}；下一段：${after.next}${Object.keys(after.habitTargets).length ? `；习惯目标 ${JSON.stringify(after.habitTargets)}` : ""}`);
        }
      }
    }
    return 0;
  }
  const raw = readJson(file) as Record<string, any>;
  const f: AssessFile = { name: relative(dir, file).split(sep).join("/"), raw };
  const ctx = { ...assessCtx(t, profile, scan), assessments: [...scan.assessments.filter((a) => a.name !== f.name), f] };
  const asEntry = kind === "入门" || (kind === "触发" && (raw.reasons ?? []).some((x: string) => x === "跨段" || x === "换场地"));
  const want = recordConclusion(ctx, f, product, asEntry);
  console.log(`按规则重算的结论：${JSON.stringify(want ?? {})}`);
  return print([...validateAssessment(raw), ...checkRecord(ctx, { ...f, raw: { ...raw, conclusion: raw.conclusion ?? want } }, product, asEntry)]);
}

/** 个人计划单：现在这一周每天练什么、有氧、习惯、下次评估。档案目录先过检查，0 错误才写。 */
async function planCmd(dir: string): Promise<number> {
  const t = await loadTemplates();
  requirePlans(t);
  const profile = readJson(join(dir, "档案.json")) as Record<string, any>;
  const scan = scanDir(dir, t, profile);
  const pre = [...validateProfile(profile).map((i) => ({ ...i, path: `档案.json ${i.path}` })),
    ...checkProfileWithTemplates(profile, t.manifest).map((i) => ({ ...i, path: `档案.json ${i.path}` })),
    ...progressIssues(t, profile, scan), ...recordIssues(scan)].filter((i) => i.level === "error");
  const ctx = assessCtx(t, profile, scan);
  const doc = doctorNeed(ctx);
  if (doc.needed && !doc.ok) pre.push({ level: "error", path: "screening", message: `医生同意之前不出计划（${doc.reason}：医生同意的日期 doctorDate 要不早于 ${doc.after}）` });
  if (pre.length) {
    console.log("档案目录没通过检查，先改好再生成计划单（npm run profile -- check）：");
    return print(pre);
  }
  const r = buildSheet(ctx);
  if (!r.text || r.issues.length) return print(r.issues);
  const seg = currentSegment(profile)!;
  const out = join(dir, ...sheetFile(seg.n, seg.week).split("/"));
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, r.text);
  console.log(`已生成：${out}`);
  console.log(DECLARATION.replace(/^> /, "声明："));
  return 0;
}

async function profileCheck(dir: string): Promise<number> {
  const t = await loadTemplates();
  const profile = readJson(join(dir, "档案.json")) as Record<string, any>;
  const inProfile = (xs: Issue[]) => xs.map((i) => ({ ...i, path: `档案.json${i.path ? " " + i.path : ""}` }));
  const scan = scanDir(dir, t, profile);
  return print([
    ...inProfile(validateProfile(profile)), ...inProfile(checkProfileWithTemplates(profile, t.manifest)),
    ...scan.issues, ...courseIssues(t, profile, scan), ...packageIssues(profile, scan), ...progressIssues(t, profile, scan),
    ...scan.sheets.flatMap((x) => checkSheet(assessCtx(t, profile, scan), x.name, x.text)),
  ]);
}

// ---------------- 练习记录导入（v4 阶段 8c 方案 3.3） ----------------

const SYMPTOM_NAMES: Record<string, string> = { pain: "疼痛", dizzy: "头晕", chest: "胸闷" };
const SESSION_TOP = ["schema", "course", "startedAt", "endedAt", "items", "feeling", "symptoms", "edited", "note"];
const SESSION_ITEM = ["exercise", "setsPlanned", "setsDone", "skipped", "feel", "spare", "reverted"];

/** 按格式重写：只留格式里有的字段、固定顺序；返回丢掉的字段名（不带值）。 */
function normalizeSession(raw: Record<string, any>): { rec: Record<string, unknown>; dropped: string[] } {
  const dropped: string[] = [];
  const pick = (o: Record<string, any>, keys: readonly string[], where: string) => {
    for (const k of Object.keys(o)) if (!keys.includes(k)) dropped.push(`${where}${k}`);
    return Object.fromEntries(keys.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]));
  };
  const rec = pick(raw, SESSION_TOP, "");
  const c = raw.course as Record<string, any>;
  rec.course = { ...pick(c, ["id", "name", "source"], "course."), source: pick(c.source, SOURCE_KEYS, "course.source.") };
  rec.items = (raw.items as Record<string, any>[]).map((it, i) => pick(it, SESSION_ITEM, `items[${i}].`));
  rec.symptoms = pick(raw.symptoms, ["pain", "dizzy", "chest"], "symptoms.");
  return { rec, dropped };
}

/** 两份记录哪几个字段不一样（症状放最前）。 */
function diffFields(a: Record<string, unknown>, b: Record<string, unknown>): string[] {
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])];
  const diff = keys.filter((k) => !sameJson(a[k], b[k]));
  return [...diff.filter((k) => k === "symptoms"), ...diff.filter((k) => k !== "symptoms")];
}

const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;
const hhmm = (d: Date) => `${String(d.getHours()).padStart(2, "0")}${String(d.getMinutes()).padStart(2, "0")}`;

/**
 * 导入练习记录：校验格式、核对是这个档案导出的课（重算 id、档案里有这一段这一周）、时间、去重，
 * 按格式重写进 打卡/。有不适的不管收不收都先报。--dry-run 只看不写；--replace 同一次练习内容变了时原地覆盖。
 */
async function importCmd(dir: string, args: string[]): Promise<number> {
  const dry = args.includes("--dry-run");
  const replace = args.includes("--replace");
  const files = args.filter((a) => !a.startsWith("--"));
  const t = await loadTemplates();
  const profile = readJson(join(dir, "档案.json")) as Record<string, any>;
  const scan = scanDir(dir, t, profile);
  // 档案里已有的记录（含 历史/、格式不对的），按 课程 id + 开始时间 找；格式对的规范化以后比内容
  const known: { name: string; raw: Record<string, any>; rec: Record<string, unknown> | null }[] = scan.sessions.map((x) => {
    let rec: Record<string, unknown> | null = null;
    try {
      if (!validateSession(x.raw).some((i) => i.level === "error")) rec = normalizeSession(x.raw).rec;
    } catch {
      rec = null;
    }
    return { name: x.name, raw: x.raw, rec };
  });
  let rejected = 0;
  let written = 0;
  const now = Date.now();
  for (const file of files) {
    console.log(`\n— ${file}`);
    const reject = (why: string) => {
      rejected++;
      console.log(`拒收：${why}`);
    };
    let raw: Record<string, any>;
    try {
      if (!statSync(file).isFile()) {
        reject("不是文件");
        continue;
      }
      if (statSync(file).size > 1024 * 1024) {
        reject("文件大于 1 MB，不是练习记录");
        continue;
      }
      raw = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      reject("读不了或者解析不了（不是 JSON 文件）");
      continue;
    }
    // 不适先报：不管后面收不收
    const sym = raw && typeof raw === "object" && raw.symptoms && typeof raw.symptoms === "object" ? raw.symptoms : null;
    const hurt = sym ? Object.keys(SYMPTOM_NAMES).filter((k) => sym[k] === true) : [];
    if (hurt.length) console.log(`【注意】这次有${hurt.map((k) => SYMPTOM_NAMES[k]).join("、")}：下周不加量，按成品"疼了怎么办"处理；胸痛胸闷、头晕站不稳要建议就医。`);
    // 不适那一栏没写、或者写的不是 true / false：拒收时按可能有不适问使用者
    const odd = !sym || Object.keys(SYMPTOM_NAMES).some((k) => sym[k] !== true && sym[k] !== false);
    const hurtNote = () => {
      if (hurt.length) console.log("这份记录没导入：周复盘时把不适照实写进复盘数据的 symptoms。");
      else if (odd) console.log("【注意】这份记录的不适那一栏没写或写法不对：按可能有疼痛、头晕、胸闷问使用者，照实写进周复盘。");
    };
    const v = validateSession(raw);
    if (v.some((i) => i.level === "error")) {
      reject("格式不对");
      print(v);
      hurtNote();
      continue;
    }
    for (const w of v.filter((i) => i.level === "warning" && i.path !== "symptoms")) console.log(`[提醒] ${w.path}：${w.message}`);
    const src = raw.course.source as Record<string, any>;
    if (src.plan !== "yangxia.plans/1" || !Number.isInteger(src.segment)) {
      reject("练的不是档案里导出的课程（样例课、手写的课），不导入");
      hurtNote();
      continue;
    }
    if (courseIdFor(src.product, src.segment, src.type ?? "标准", src.week, src.day ?? "", src.half === true) !== raw.course.id) {
      reject("课程 id 和出处对不上（记录被改过）");
      hurtNote();
      continue;
    }
    const segs = ((profile.segments ?? []) as Record<string, any>[]).filter((x) => x.n === src.segment);
    const segOk = segs.length && segs.some((x) => (x.product ?? profile.product) === src.product && (x.type ?? "标准") === (src.type ?? "标准"))
      && Math.max(...segs.map((x) => Number(x.week) || 0)) >= src.week;
    if (!segOk) {
      reject(`档案里没有这一段这一周（第 ${src.segment} 段第 ${src.week} 周，${src.product}）：练的不是这个档案的课`);
      hurtNote();
      continue;
    }
    const started = new Date(raw.startedAt);
    const segStart = segs.map((x) => String(x.start ?? "")).filter(Boolean).sort()[0];
    if (started.getTime() > now + 5 * 60_000) {
      reject("开始时间在将来（电脑或手机的时间不对？）");
      hurtNote();
      continue;
    }
    if (segStart && localDate(started) < segStart) {
      reject(`开始时间 ${localDate(started)} 早于这一段开始那天 ${segStart}`);
      hurtNote();
      continue;
    }
    const { rec, dropped } = normalizeSession(raw);
    if (dropped.length) console.log(`丢掉了格式里没有的字段：${dropped.join("、").replace(CONTROL, "")}`);
    const same = known.find((k) => k.raw?.course?.id === raw.course.id && Date.parse(k.raw?.startedAt) === Date.parse(raw.startedAt));
    let target: string;
    if (same) {
      if (same.rec && sameJson(same.rec, rec)) {
        console.log(`已经导入过（${same.name}），跳过`);
        continue;
      }
      const diff = same.rec ? diffFields(same.rec, rec) : ["旧记录格式不对"];
      if (!replace) {
        reject(same.rec
          ? `同一次练习（${same.name}）已经有记录，内容不一样：${diff.join("、")}。问过使用者确实要换，加 --replace 原地覆盖`
          : `档案里这次练习的旧记录（${same.name}）格式不对：先改好它，或者问过使用者加 --replace 用这份替换`);
        hurtNote();
        continue;
      }
      // 记下的不适、手改过的课不能改成没有（"有不适就停止加量"不能靠改记录绕过去）
      const oldSym = same.raw?.symptoms ?? {};
      // 旧记录一侧按真值算（和档案检查判断"有不适"、进度依据判断 edited 一样），写法不对的旧记录也不能借替换抹掉
      const lost = Object.keys(SYMPTOM_NAMES).filter((k) => !!oldSym[k] && (rec.symptoms as Record<string, boolean>)[k] !== true);
      if (lost.length || (!!same.raw?.edited && rec.edited !== true)) {
        reject(lost.length
          ? `旧记录里的${lost.map((k) => SYMPTOM_NAMES[k]).join("、")}不能改成没有：使用者说当时点错了，照实写进周复盘，不改记录`
          : "手改过的课（edited，编排器自动记的）不能改成没改过：照实写进周复盘，不改记录");
        hurtNote();
        continue;
      }
      target = join(dir, ...same.name.split("/"));
      console.log(`原地覆盖 ${same.name}，改了：${diff.join("、")}`);
    } else {
      const base = `养夏_练习记录_${localDate(started)}_${hhmm(started)}`;
      let n = 1;
      target = join(dir, "打卡", `${base}.json`);
      while (existsSync(target) || known.some((k) => join(dir, ...k.name.split("/")) === target)) target = join(dir, "打卡", `${base}_${++n}.json`);
    }
    // 打印备注前去掉控制字符（记录里藏着的终端转义序列不能原样打到终端上）
    if (typeof rec.note === "string" && rec.note.trim()) console.log(`备注（照 AGENTS.md 隐私核对：有病名、用药、血压体重数字的，问使用者删掉再导入）：\n  ${rec.note.replace(CONTROL, "")}`);
    if (dry) {
      console.log(`（--dry-run）会写到：${relative(dir, target)}`);
      continue;
    }
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, JSON.stringify(rec, null, 2) + "\n");
    written++;
    const rel = relative(dir, target).split(sep).join("/");
    known.push({ name: rel, raw: rec as Record<string, any>, rec });
    console.log(`已导入：${rel}`);
  }
  if (written) {
    console.log("\n导入完了。原文件还在下载目录、手机、聊天记录里，可以删（个人数据只放在 profiles/）。");
    console.log("档案检查（导入不回滚；复盘过的那一周来了新记录，那一周的复盘数据要照实改）：");
    // 档案检查的问题照常列出来；退出码只看这次导入有没有拒收，所以有错误时再醒目地说一句
    if (await profileCheck(dir)) console.log("【注意】档案检查有错误：照上面改（多半是那一周的复盘数据——训练次数、有没有不适——和周次推进）。");
  }
  if (rejected) console.log(`\n有 ${rejected} 份记录没导入。`);
  return rejected ? 1 : 0;
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
    if (file === "import" && rest[0] && rest.slice(1).some((a) => !a.startsWith("--"))) return importCmd(rest[0], rest.slice(1));
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
  if (cmd === "plan") {
    if (!file) {
      console.log(USAGE);
      return 2;
    }
    if (rest.length) { console.log("计划单只生成现在这一周的（档案 segments 最后一项）：不用写周次"); return 2; }
    return planCmd(file);
  }
  if (cmd === "assess") {
    if (!file || !rest[0]) {
      console.log(USAGE);
      return 2;
    }
    return assessCmd(file, rest[0], rest.slice(1));
  }
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
    // 档案目录里的：65 岁以上稳定期按课程那一周有效的加项核对（和导出同一个算法）
    let addOns: string[] | undefined;
    if (profile && basename(rest[pi + 1]) === "档案.json") {
      const src = (raw as any)?.source ?? {};
      const wk = ((profile.segments ?? []) as any[]).filter((s) => s.n === src.segment && s.week === src.week).pop();
      if (wk && typeof wk.start === "string") addOns = activeAddOns(assessCtx(t, profile, scanDir(dirname(rest[pi + 1]), t, profile)), wk.start);
    }
    const issues = checkCourse(raw, { manifest: t.manifest, readProduct: t.readProduct, profile, plans: t.plans, rules: t.rules, addOns });
    if (profile) {
      // 档案目录里的周复盘、进度日志也要过：不复盘、不按规则改进度，课程就不能交出去
      if (basename(rest[pi + 1]) === "档案.json") {
        const scan = scanDir(dirname(rest[pi + 1]), t, profile);
        issues.push(...[...progressIssues(t, profile, scan), ...recordIssues(scan)].filter((i) => i.level === "error"));
        const doc = doctorNeed(assessCtx(t, profile, scan));
        if (doc.needed && !doc.ok) issues.push({ level: "error", path: "screening", message: `医生同意之前不出课程（${doc.reason}：医生同意的日期 doctorDate 要不早于 ${doc.after}）` });
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
