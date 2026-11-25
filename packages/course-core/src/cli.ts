// 命令行（Node 24 直接运行 TypeScript）：薄壳层，全部业务规则与门禁校验委托给 engine.ts。
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
import {
  ASSESS_FORMAT,
  type AssessFile,
  assessRules,
  doctorNeed,
  productInfo,
} from "./assess.ts";
import { assessmentForm } from "./assess-form.ts";
import { checkCourse } from "./check.ts";
import { dateInZone, resolveTimeZone } from "./date.ts";
import {
  auditProfileBundle,
  buildAssessContext,
  collectProgressIssues,
  collectRecordIssues,
  evaluateAssessment,
  exportProfileCourse,
  generateProfileSheet,
  prepareSessionImport,
  type ProfileBundle,
  type ProfileCourseItem,
  type ProfileDocItem,
  sameJson,
  SYMPTOM_NAMES,
} from "./engine.ts";
import { bedtimeFor } from "./intake.ts";
import { loadTemplates, PACKAGE_FORMAT, packageInfo, packCourse, requirePlans, sequencerPath, sequencerStamp, type Templates, unpackCourse } from "./node.ts";
import { currentSegment, stableParam } from "./plan.ts";
import { DECLARATION, PROFILE_FORMAT, SESSION_FORMAT } from "./profile.ts";
import { REVIEW_FORMAT, type SessionFile } from "./progress.ts";
import { failedRedlineCases } from "./redlines.ts";
import { activeAddOns } from "./senior.ts";
import { buildSrt } from "./srt.ts";
import { buildTimeline, itemSpec } from "./timeline.ts";
import type { Course, Issue } from "./types.ts";
import { validateCourse } from "./validate.ts";

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

const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;
const safeCode = (code: string) => code.replace(/[:*?"<>|\\/]/g, "_");

interface PackageFile { name: string; archived: boolean; archivedSegment?: number; html: string }

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

/** 扫描本地档案目录，组装存储无关的 ProfileBundle 与 CLI 专用的课程包列表。 */
function loadProfileBundle(dir: string, profile: Record<string, any>): { bundle: ProfileBundle; packages: PackageFile[] } {
  const extraIssues: Issue[] = [];
  const sessions: SessionFile[] = [];
  const reviews: string[] = [];
  const reviewData: Record<string, Record<string, any>> = {};
  const courses: ProfileCourseItem[] = [];
  const assessments: AssessFile[] = [];
  const docs: ProfileDocItem[] = [];
  const packages: PackageFile[] = [];
  const segN = currentSegment(profile)?.n ?? 1;

  for (const f of walk(dir)) {
    const name = relative(dir, f);
    if (name === "档案.json") continue;
    const norm = name.split(sep).join("/");
    const archived = norm.startsWith("历史/");
    const archMatch = archived ? /^历史\/第(\d+)段\//.exec(norm) : null;
    const archivedSegment = archMatch ? Number(archMatch[1]) : undefined;
    const badArchive = archived && (archivedSegment === undefined || archivedSegment < 1 || archivedSegment >= segN);
    const rv = /(?:^|\/)复盘\/([^/]+)$/.exec(norm);
    const validRevPath = !!rv && (!archived || /^历史\/第\d+段\/复盘\//.test(norm));

    if (f.endsWith(".json")) {
      const raw = readJson(f) as Record<string, any>;
      if (raw?.schema === SESSION_FORMAT) {
        sessions.push({ name: norm, raw, archived, archivedSegment });
      } else if (raw?.schema === "yangxia.course/1") {
        courses.push({ name, raw, archived, archivedSegment });
      } else if (raw?.schema === ASSESS_FORMAT) {
        if (!norm.startsWith("评估/") && !archived) {
          extraIssues.push({ level: "error", path: name, message: "评估记录放在 评估/ 下：评估/<日期>-<种类>.json" });
        }
        assessments.push({ name: norm, raw, archived, archivedSegment });
      } else if (raw?.schema === REVIEW_FORMAT) {
        if (badArchive) extraIssues.push({ level: "error", path: name, message: `历史/ 下只放以前几段的文件（历史/第N段/，N 从 1 起、小于现在的第 ${segN} 段）` });
        if (validRevPath && rv) reviews.push(rv[1]);
        if (rv) reviewData[rv[1]] = raw;
      } else if (raw?.schema !== PROFILE_FORMAT) {
        if (badArchive) extraIssues.push({ level: "error", path: name, message: `历史/ 下只放以前几段的文件（历史/第N段/，N 从 1 起、小于现在的第 ${segN} 段）` });
        extraIssues.push({ level: "warning", path: name, message: "不认识的 JSON 文件（不是课程、练习记录、复盘数据、评估记录）" });
      }
    } else if (f.endsWith(".md") || f.endsWith(".txt")) {
      const text = readFileSync(f, "utf8");
      const isMenu = norm.startsWith("菜单/") || /^历史\/第\d+段\/菜单\//.test(norm);
      const isPlan = norm.startsWith("计划/") || /^历史\/第\d+段\/计划\//.test(norm);
      const isMonthly = validRevPath && rv![1] === "月度总结.md";
      const kind: ProfileDocItem["kind"] = isMenu ? "menu" : isPlan ? "plan" : isMonthly ? "monthly_summary" : validRevPath ? "review" : "other";
      docs.push({ name, text, kind, archived, archivedSegment });
    } else if (f.endsWith(".html")) {
      if (badArchive) extraIssues.push({ level: "error", path: name, message: `历史/ 下只放以前几段的文件（历史/第N段/，N 从 1 起、小于现在的第 ${segN} 段）` });
      const inCourses = /^(?:历史\/第\d+段\/)?课程\/[^/]+$/.test(norm);
      const html = readFileSync(f, "utf8");
      if (inCourses) packages.push({ name, archived, archivedSegment, html });
      else if (packageInfo(html).info || /id="yangxia-course"/.test(html)) {
        const embedded = !unpackCourse(html).empty;
        extraIssues.push({ level: "error", path: name, message: embedded ? "课程包放在 课程/ 下" : "编排器（没嵌课程）不放在档案目录里" });
      } else {
        extraIssues.push({ level: "warning", path: name, message: "不认识的文件：复盘、菜单写成 .md，课程、练习记录是 .json，课程包放在 课程/；别的文件不检查" });
      }
    } else if (!norm.split("/").some((s) => s.startsWith("."))) {
      if (badArchive) extraIssues.push({ level: "error", path: name, message: `历史/ 下只放以前几段的文件（历史/第N段/，N 从 1 起、小于现在的第 ${segN} 段）` });
      extraIssues.push({ level: "warning", path: name, message: "不认识的文件：复盘、菜单写成 .md，课程、练习记录是 .json；别的文件不检查" });
    }
  }

  return {
    bundle: {
      profile,
      timeZone: resolveTimeZone(undefined, profile),
      sessions,
      reviews,
      reviewData,
      courses,
      assessments,
      docs,
      extraIssues,
    },
    packages,
  };
}

/** 课程包检查（CLI 专用，v4 阶段 8c 方案 2.3）。 */
function packageIssues(profile: Record<string, any>, courses: ProfileCourseItem[], packages: PackageFile[]): Issue[] {
  const out: Issue[] = [];
  const seg = currentSegment(profile);
  const byName = new Map(courses.map((c) => [c.name, c]));
  for (const p of packages) {
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

async function exportCmd(dir: string, weekArg: string, day: string, rest: string[]): Promise<number> {
  const t = await loadTemplates();
  requirePlans(t);
  const profile = readJson(join(dir, "档案.json")) as Record<string, any>;
  const { bundle } = loadProfileBundle(dir, profile);
  const picks: Record<string, string> = {};
  rest.forEach((a, i) => {
    if (a === "--pick" && rest[i + 1]?.includes("=")) {
      const [g, v] = rest[i + 1].split("=");
      picks[g] = v;
    }
  });
  const half = rest.includes("--half");
  const r = exportProfileCourse(bundle, t, { week: Number(weekArg), day, picks, half });
  if (r.preGateFailed) {
    console.log("档案目录没通过检查（周复盘、个人进度、档案本身），先改好再导出（npm run profile -- check）：");
    return print(r.issues);
  }
  for (const f of r.follow) console.log(`照成品做：${f.name}（${f.reason}）`);
  for (const n of r.notes) console.log(n);
  if (!r.course || r.issues.some((i) => i.level === "error")) return print(r.issues);

  const seg = currentSegment(profile)!;
  const oi = rest.indexOf("--out");
  const custom = oi >= 0 && rest[oi + 1] ? rest[oi + 1] : null;
  const stem = `第${seg.n}段-第${r.course.source.week}周-${day}日${r.course.source.half ? "-半量" : ""}`;
  const out = custom ?? join(dir, "课程", `${stem}.json`);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(r.course, null, 2) + "\n");
  console.log(`已导出：${out}`);
  const pkg = custom
    ? (/\.json$/i.test(custom) ? custom.replace(/\.json$/i, ".html") : `${custom}.html`)
    : join(dir, "课程", `${safeCode(String(profile.code ?? basename(dir)))}-${stem}.html`);
  if (resolve(pkg) === resolve(sequencerPath())) console.log(`没出课程包：${pkg} 就是打包好的编排器，换一个 --out 路径`);
  else await writePackage(t, r.course, pkg, rest.includes("--no-package"), resolveTimeZone(undefined, profile));
  console.log(DECLARATION.replace(/^> /, "声明："));
  return print(r.issues);
}

async function writePackage(t: Templates, course: Course, path: string, skip: boolean, timeZone?: string): Promise<void> {
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
  const r = packCourse(html, course, dateInZone(new Date(), timeZone));
  if (!r.html) return dropOld(`${r.error}`);
  writeFileSync(path, r.html);
  console.log(`已导出课程包：${path}`);
  console.log("课程包里只有这节课的内容；发给自己的手机（文件传输助手、AirDrop、数据线），不要发到群里。手机上先保存，再用浏览器打开。");
}

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

async function assessCmd(dir: string, kind: string, args: string[]): Promise<number> {
  const pi = args.indexOf("--product");
  const productArg = pi >= 0 ? args[pi + 1] : undefined;
  const file = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--product");
  const t = await loadTemplates();
  const profile = readJson(join(dir, "档案.json")) as Record<string, any>;
  const { bundle } = loadProfileBundle(dir, profile);
  if (!file) {
    // 列出要问、要测的项：和网页评估表单同一份（assess-form.ts）
    const form = assessmentForm(bundle, t, kind, { product: productArg });
    if ("error" in form) {
      console.log(form.error);
      return 2;
    }
    for (const line of form.lines) console.log(line);
    return 0;
  }
  const ar = assessRules(t.rules);
  if (!ar) {
    console.log("模板还没有评估规则（rules.json 的 assess）：先把模板仓库更新到 v4 阶段 2 之后");
    return 2;
  }
  if (!["入门", "段末", "周期末", "触发"].includes(kind)) {
    console.log("种类写 入门 / 段末 / 周期末 / 触发");
    return 2;
  }
  const seg = currentSegment(profile);
  if (seg && kind === "周期末" && seg.phase !== "稳定" && !(profile.segments as any[]).some((x) => x.phase === "稳定")) {
    console.log("周期末评估只在稳定期第 12 周之后做；起始期每段第 4 周之后做的是段末评估");
    return 2;
  }
  const product = productArg ?? (readJson(file) as Record<string, any>).product ?? seg?.product ?? profile.product;
  const info = productInfo(t.manifest, product);
  if (!info) {
    console.log(`模板里没有成品「${product}」`);
    return 2;
  }
  const raw = readJson(file) as Record<string, any>;
  const f: AssessFile = { name: relative(dir, file).split(sep).join("/"), raw };
  const ev = evaluateAssessment(bundle, t, kind, f, { product });
  if (ev.error) {
    console.log(ev.error);
    return 2;
  }
  console.log(`按规则重算的结论：${JSON.stringify(ev.conclusion ?? {})}`);
  return print(ev.issues);
}

async function planCmd(dir: string): Promise<number> {
  const t = await loadTemplates();
  requirePlans(t);
  const profile = readJson(join(dir, "档案.json")) as Record<string, any>;
  const { bundle } = loadProfileBundle(dir, profile);
  const r = generateProfileSheet(bundle, t);
  if (r.preGateFailed) {
    console.log("档案目录没通过检查，先改好再生成计划单（npm run profile -- check）：");
    return print(r.issues);
  }
  if (!r.text || !r.file || r.issues.length) return print(r.issues);
  const out = join(dir, ...r.file.split("/"));
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, r.text);
  console.log(`已生成：${out}`);
  console.log(DECLARATION.replace(/^> /, "声明："));
  return 0;
}

async function profileCheck(dir: string): Promise<number> {
  const t = await loadTemplates();
  const profile = readJson(join(dir, "档案.json")) as Record<string, any>;
  const { bundle, packages } = loadProfileBundle(dir, profile);
  return print([
    ...auditProfileBundle(bundle, t),
    ...packageIssues(profile, bundle.courses, packages),
  ]);
}

async function importCmd(dir: string, args: string[]): Promise<number> {
  const dry = args.includes("--dry-run");
  const replace = args.includes("--replace");
  const files = args.filter((a) => !a.startsWith("--"));
  await loadTemplates();
  const profile = readJson(join(dir, "档案.json")) as Record<string, any>;
  const { bundle } = loadProfileBundle(dir, profile);
  let rejected = 0;
  let written = 0;
  const now = new Date();
  for (const file of files) {
    console.log(`\n— ${file}`);
    const reject = (why: string) => {
      rejected++;
      console.log(`拒收：${why}`);
    };
    let raw: unknown;
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
    const res = prepareSessionImport(bundle, raw, { replace, now });
    if (res.hurt.length) console.log(`【注意】这次有${res.hurt.map((k) => SYMPTOM_NAMES[k]).join("、")}：下周不加量，按成品"疼了怎么办"处理；胸痛胸闷、头晕站不稳要建议就医。`);
    const hurtNote = () => {
      if (res.hurt.length) console.log("这份记录没导入：周复盘时把不适照实写进复盘数据的 symptoms。");
      else if (res.oddSymptoms) console.log("【注意】这份记录的不适那一栏没写或写法不对：按可能有疼痛、头晕、胸闷问使用者，照实写进周复盘。");
    };
    if (res.status === "rejected" || res.status === "clock_skew_future") {
      reject(res.reason ?? "拒收");
      if (res.validationIssues.length) print(res.validationIssues);
      hurtNote();
      continue;
    }
    for (const w of res.warnings) console.log(`[提醒] ${w.path}：${w.message}`);
    if (res.droppedFields.length) console.log(`丢掉了格式里没有的字段：${res.droppedFields.join("、").replace(CONTROL, "")}`);
    if (res.status === "duplicate") {
      console.log(`已经导入过（${res.replaceTarget}），跳过`);
      continue;
    }
    const rec = res.record!;
    let relPath: string;
    if (res.replaceTarget) {
      relPath = res.replaceTarget;
      console.log(`原地覆盖 ${relPath}，改了：${(res.diff ?? []).join("、")}`);
    } else {
      relPath = res.suggestedName!;
      let n = 1;
      const baseNoExt = relPath.slice(0, -5);
      while (existsSync(join(dir, ...relPath.split("/")))) relPath = `${baseNoExt}_${++n}.json`;
    }
    const target = join(dir, ...relPath.split("/"));
    if (typeof rec.note === "string" && rec.note.trim()) console.log(`备注（照 AGENTS.md 隐私核对：有病名、用药、血压体重数字的，问使用者删掉再导入）：\n  ${rec.note.replace(CONTROL, "")}`);
    if (dry) {
      console.log(`（--dry-run）会写到：${relative(dir, target)}`);
      continue;
    }
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, JSON.stringify(rec, null, 2) + "\n");
    written++;
    const rel = relative(dir, target).split(sep).join("/");
    bundle.sessions = [...bundle.sessions.filter((s) => s.name !== rel), { name: rel, raw: rec as Record<string, any> }];
    console.log(`已导入：${rel}`);
  }
  if (written) {
    console.log("\n导入完了。原文件还在下载目录、手机、聊天记录里，可以删（个人数据只放在 profiles/）。");
    console.log("档案检查（导入不回滚；复盘过的那一周来了新记录，那一周的复盘数据要照实改）：");
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
    let addOns: string[] | undefined;
    let bundle: ProfileBundle | undefined;
    if (profile && basename(rest[pi + 1]) === "档案.json") {
      bundle = loadProfileBundle(dirname(rest[pi + 1]), profile).bundle;
      const src = (raw as any)?.source ?? {};
      const wk = ((profile.segments ?? []) as any[]).filter((s) => s.n === src.segment && s.week === src.week).pop();
      if (wk && typeof wk.start === "string") addOns = activeAddOns(buildAssessContext(bundle, t), wk.start);
    }
    const issues = checkCourse(raw, { manifest: t.manifest, readProduct: t.readProduct, profile, plans: t.plans, rules: t.rules, addOns });
    if (profile) {
      if (bundle) {
        issues.push(...[...collectProgressIssues(bundle, t), ...collectRecordIssues(bundle, t)].filter((i) => i.level === "error"));
        const doc = doctorNeed(buildAssessContext(bundle, t));
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
