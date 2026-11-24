// 存储无关的核心业务编排引擎（供命令行 cli.ts 与自托管服务端 apps/server 共用，保证规则 100% 同源）：
// - ProfileBundle：纯内存档案集合（无文件系统依赖）
// - auditProfileBundle：完整档案、复盘、进度、评估、目标、加项、课程与文档红线/声明核对
// - exportProfileCourse：门禁校验 + 导出 + 组装 CourseDeliveryEnvelope（含 follow、notes、动图哈希与免责声明）
// - detectInvalidatedCourses：判定因不适、降量、摔倒、医生门禁、换段或模板变更而作废的活跃课程
// - generateProfileSheet / evaluateAssessment / prepareSessionImport：计划单、评估重算与练习记录导入核对
import {
  ASSESS_FORMAT,
  type AssessContext,
  type AssessFile,
  ageAt,
  assessRules,
  balanceHold,
  cardioMode,
  checkAssessments,
  checkRecord,
  cycleEnd,
  doctorNeed,
  gap,
  productInfo,
  recordConclusion,
  segmentEnd,
  validateAssessment,
} from "./assess.ts";
import { checkCourse } from "./check.ts";
import { addDays, dateInZone, hhmmInZone, resolveTimeZone } from "./date.ts";
import { courseClips, type MotionsData } from "./figure-motion.ts";
import { cycleGoals, goalCardioHint, goalIssues, severeObese } from "./goals.ts";
import { checkProfileWithTemplates } from "./intake.ts";
import type { Manifest } from "./manifest.ts";
import { courseIdFor, currentSegment, exportCourse, type ExportResult, type PlansData, type RulesData } from "./plan.ts";
import { checkDeclaration, checkNotes, DECLARATION, validateProfile, validateSession } from "./profile.ts";
import { checkProgress, checkProgressLog, progressOn, REVIEW_FORMAT, type SessionFile, validateReview } from "./progress.ts";
import { activeAddOns, addOnIssues } from "./senior.ts";
import { buildSheet, checkSheet, sheetFile } from "./sheet.ts";
import type { Course, Issue } from "./types.ts";
import { SOURCE_KEYS, validateCourse } from "./validate.ts";

type Obj = Record<string, any>;

export const DELIVERY_FORMAT = "yangxia.delivery/1";
export const SYMPTOM_NAMES: Record<string, string> = { pain: "疼痛", dizzy: "头晕", chest: "胸闷" };
const SESSION_TOP = ["schema", "course", "startedAt", "endedAt", "items", "feeling", "symptoms", "edited", "note"] as const;
const SESSION_ITEM = ["exercise", "setsPlanned", "setsDone", "skipped", "feel", "spare", "reverted"] as const;

export interface TemplateBundle {
  manifest: Manifest;
  readProduct: (name: string) => string | null;
  plans: PlansData | null;
  rules: RulesData | null;
  motions?: MotionsData | null;
  templateHash?: string;
  motionHashes?: Record<string, string>;
}

export interface ProfileCourseItem {
  name: string;
  raw: Obj;
  archived?: boolean;
  archivedSegment?: number;
  /** 服务端可选：该课程导出/发布日期（YYYY-MM-DD，档案时区），供过重旧课作废判定。 */
  createdDate?: string;
  /** 服务端可选：该课程发布精确时间戳（ISO 8601），用于区分同日“先不适后重发的新课”与“发布前的迟到不适”。 */
  createdAt?: string;
}

export interface ProfileDocItem {
  name: string;
  text: string;
  kind: "plan" | "menu" | "review" | "monthly_summary" | "other";
  archived?: boolean;
  archivedSegment?: number;
  /** 迁入的历史只读计划单（A4 ②）：免于按新模板重跑 checkSheet 报错。 */
  legacyReadonly?: boolean;
}

export interface ProfileBundle {
  profile: Obj;
  timeZone?: string;
  sessions: SessionFile[];
  reviewData: Record<string, Obj>;
  /** 可选兜底：未在 docs 中提供的复盘 .md 文件名列表（通常自动从 docs 中 kind==="review" 派生）。 */
  reviews?: string[];
  courses: ProfileCourseItem[];
  assessments: AssessFile[];
  docs: ProfileDocItem[];
  /** CLI 目录层面的额外校验结果（如未知文件、未归类文件等）。 */
  extraIssues?: Issue[];
}

export interface CourseDeliveryEnvelope {
  schema: typeof DELIVERY_FORMAT;
  course: Course;
  follow: ExportResult["follow"];
  notes: string[];
  declaration: string;
  templateVersion: string;
  templateHash: string;
  motionHashes: Record<string, string>;
}

export interface InvalidatedCourse {
  name: string;
  courseId: string;
  reason: string;
}

/** 按 JSON 内容深比（忽略键顺序和缩进）。 */
export function sameJson(a: unknown, b: unknown): boolean {
  const norm = (v: unknown): unknown => Array.isArray(v)
    ? v.map(norm)
    : v && typeof v === "object"
      ? Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, norm((v as Record<string, unknown>)[k])]))
      : v;
  return JSON.stringify(norm(a)) === JSON.stringify(norm(b));
}

/** 按练习记录契约重写：只保留契约允许的字段与固定顺序，返回丢掉的字段名（不含值）。 */
export function normalizeSession(raw: Obj): { rec: Record<string, unknown>; dropped: string[] } {
  const dropped: string[] = [];
  const pick = (o: Obj, keys: readonly string[], where: string) => {
    for (const k of Object.keys(o)) if (!keys.includes(k)) dropped.push(`${where}${k}`);
    return Object.fromEntries(keys.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]));
  };
  const rec = pick(raw, SESSION_TOP, "");
  const c = raw.course as Obj;
  rec.course = { ...pick(c, ["id", "name", "source"], "course."), source: pick(c.source, SOURCE_KEYS, "course.source.") };
  rec.items = (raw.items as Obj[]).map((it, i) => pick(it, SESSION_ITEM, `items[${i}].`));
  rec.symptoms = pick(raw.symptoms, ["pain", "dizzy", "chest"], "symptoms.");
  return { rec, dropped };
}

/** 两份练习记录哪些顶层字段不一样（symptoms 排最前）。 */
export function diffSessionFields(a: Record<string, unknown>, b: Record<string, unknown>): string[] {
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])];
  const diff = keys.filter((k) => !sameJson(a[k], b[k]));
  return [...diff.filter((k) => k === "symptoms"), ...diff.filter((k) => k !== "symptoms")];
}

function basenameOf(path: string): string {
  const norm = path.replace(/\\/g, "/");
  const idx = norm.lastIndexOf("/");
  return idx >= 0 ? norm.slice(idx + 1) : norm;
}

function reviewNamesOf(bundle: ProfileBundle): string[] {
  const set = new Set<string>(bundle.reviews ?? []);
  for (const d of bundle.docs) {
    if (d.kind === "review") set.add(basenameOf(d.name));
  }
  return [...set];
}

export function buildAssessContext(bundle: ProfileBundle, templates: TemplateBundle, opts?: { now?: Date }): AssessContext {
  const timeZone = resolveTimeZone(bundle.timeZone, bundle.profile);
  return {
    profile: bundle.profile,
    manifest: templates.manifest,
    plans: templates.plans,
    rules: templates.rules,
    sessions: bundle.sessions,
    reviewData: bundle.reviewData,
    assessments: bundle.assessments,
    now: opts?.now,
    timeZone,
  };
}

function ownA65Ages(bundle: ProfileBundle, templates: TemplateBundle, today: string): string[] {
  const ar0 = assessRules(templates.rules);
  return ar0 && ageAt(bundle.profile, today, ar0.assess).age === "a65" ? ["a65"] : [];
}

/** 评估记录、复盘数据、练习记录本身的格式与红线校验（导出和计划单门禁也会先过这一关）。 */
export function collectRecordIssues(bundle: ProfileBundle, templates: TemplateBundle, opts?: { now?: Date }): Issue[] {
  const out: Issue[] = [];
  const tz = resolveTimeZone(bundle.timeZone, bundle.profile);
  const today = dateInZone(opts?.now ?? new Date(), tz);
  const own = ownA65Ages(bundle, templates, today);
  const tag = (name: string, xs: Issue[]) => xs.map((i) => ({ ...i, path: `${name}${i.path ? " " + i.path : ""}` }));
  for (const s of bundle.sessions) {
    out.push(...tag(s.name, validateSession(s.raw)));
  }
  for (const a of bundle.assessments) {
    out.push(...tag(a.name, validateAssessment(a.raw)));
    if (typeof a.raw?.note === "string") {
      out.push(...checkNotes(templates.manifest.redlines, [...new Set([bundle.profile.age, ...own])], a.name, a.raw.note));
    }
  }
  for (const [k, raw] of Object.entries(bundle.reviewData)) {
    const path = k.includes("/") ? k : `复盘/${k}`;
    out.push(...tag(path, validateReview(raw)));
  }
  return out;
}

/** 归档段号合法性校验（历史/第N段/ 仅允许 1 <= N < 当前段号，防止把当前段挪进历史躲检查）。 */
export function collectArchiveIssues(bundle: ProfileBundle): Issue[] {
  const out: Issue[] = [];
  const segN = currentSegment(bundle.profile)?.n ?? 1;
  const check = (name: string, archived?: boolean, archivedSegment?: number) => {
    if (!archived) return;
    let n = archivedSegment;
    if (n === undefined) {
      const m = /^历史[\\/]第(\d+)段[\\/]/.exec(name);
      if (m) n = Number(m[1]);
    }
    if (n === undefined || !Number.isInteger(n) || n < 1 || n >= segN) {
      out.push({ level: "error", path: name, message: `历史/ 下只放以前几段的文件（历史/第N段/，N 从 1 起、小于现在的第 ${segN} 段）` });
    }
  };
  for (const s of bundle.sessions) check(s.name, s.archived, s.archivedSegment);
  for (const c of bundle.courses) check(c.name, c.archived, c.archivedSegment);
  for (const a of bundle.assessments) check(a.name, a.archived, a.archivedSegment);
  for (const d of bundle.docs) check(d.name, d.archived, d.archivedSegment);
  return out;
}

/** 周次推进、个人进度、评估、目标、65+ 加项综合核对。 */
export function collectProgressIssues(bundle: ProfileBundle, templates: TemplateBundle, opts?: { now?: Date }): Issue[] {
  const now = opts?.now ?? new Date();
  const tz = resolveTimeZone(bundle.timeZone, bundle.profile);
  const reviews = reviewNamesOf(bundle);
  const ctx = buildAssessContext(bundle, templates, { now });
  const out = [...checkProgress(bundle.profile, bundle.sessions, reviews, now, bundle.reviewData, tz)];
  if (templates.plans && templates.rules) {
    out.push(...checkProgressLog(bundle.profile, templates.plans, templates.rules, bundle.sessions, bundle.reviewData, now, bundle.assessments, tz)
      .map((i) => ({ ...i, path: `档案.json ${i.path}` })));
  } else {
    out.push({ level: "warning", path: "档案.json", message: "模板还没有训练单（dist/data/）：个人进度没核对，先更新模板" });
  }
  out.push(...checkAssessments(ctx));
  out.push(...goalIssues(ctx));
  out.push(...addOnIssues(ctx));
  return out;
}

/** 档案文档（计划、菜单、复盘、月度总结 .md）的红线、声明与计划单逐字核对。 */
export function collectDocumentIssues(bundle: ProfileBundle, templates: TemplateBundle, opts?: { now?: Date }): Issue[] {
  const out: Issue[] = [];
  const now = opts?.now ?? new Date();
  const tz = resolveTimeZone(bundle.timeZone, bundle.profile);
  const today = dateInZone(now, tz);
  const own = ownA65Ages(bundle, templates, today);
  const ctx = buildAssessContext(bundle, templates, { now });
  for (const d of bundle.docs) {
    const isMenu = d.kind === "menu";
    if (isMenu && !Array.isArray(bundle.profile.household)) {
      out.push({ level: "error", path: d.name, message: "排菜单前要在档案里记下家庭成员的年龄段（household），菜单按每个人的红线检查" });
    }
    const ages = [...new Set(isMenu ? ["fam", bundle.profile.age, ...own, ...(bundle.profile.household ?? [])] : [bundle.profile.age, ...own])];
    out.push(...checkNotes(templates.manifest.redlines, ages, d.name, d.text));
    if (!d.archived && d.kind !== "other") {
      out.push(...checkDeclaration(d.name, d.text));
    }
    if (!d.archived && d.kind === "plan" && !d.legacyReadonly) {
      out.push(...checkSheet(ctx, d.name, d.text));
    }
  }
  return out;
}

/** 档案里已有课程的核对（含按历史日期重放 progressOn，以及降量/不适后过重旧课报 error）。 */
export function collectCourseIssues(bundle: ProfileBundle, templates: TemplateBundle, opts?: { now?: Date }): Issue[] {
  const out: Issue[] = [];
  const now = opts?.now ?? new Date();
  const tz = resolveTimeZone(bundle.timeZone, bundle.profile);
  const seg = currentSegment(bundle.profile);
  const cur = (bundle.profile.segments ?? []).at(-1);
  const ctx0 = buildAssessContext(bundle, templates, { now });
  const addOns = cur && typeof cur.start === "string" ? activeAddOns(ctx0, cur.start) : undefined;
  const checkCtx = (p: Obj) => ({
    manifest: templates.manifest,
    readProduct: templates.readProduct,
    profile: p,
    plans: templates.plans,
    rules: templates.rules,
    addOns,
  });
  for (const c of bundle.courses) {
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
    const got = checkCourse(c.raw, checkCtx(bundle.profile));
    if (got.some((i) => i.level === "error") && src.plan && templates.plans && templates.rules) {
      const dates = [...new Set((bundle.profile.progressLog ?? []).map((e: any) => e?.date).filter((d: unknown) => typeof d === "string"))].sort().reverse() as string[];
      const earlier = dates.map((d) => {
        const day = addDays(d, -1);
        return { day, progress: progressOn(bundle.profile, templates.plans!, templates.rules!, day, now, tz) };
      });
      const hit = earlier.find((e) => !checkCourse(c.raw, checkCtx({ ...bundle.profile, progress: e.progress })).some((i) => i.level === "error"));
      const downAfter = hit && (bundle.profile.progressLog ?? []).some((e: any) => e?.date > hit.day && (e.rule === "减量" || e.rule === "退回" || e.rule === "重来"
        || (e.rule === "找级" && Number(e.to) < Number(progressOn(bundle.profile, templates.plans!, templates.rules!, hit.day, now, tz)?.[e.move]?.[e.field] ?? Infinity))));
      const sickAfter = hit && bundle.sessions.some((s) => {
        const st = Date.parse(s.raw?.startedAt);
        return !Number.isNaN(st) && dateInZone(new Date(st), tz) >= hit.day
          && !!(s.raw?.symptoms?.pain || s.raw?.symptoms?.dizzy || s.raw?.symptoms?.chest);
      });
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

/** 完整档案核对（替代 cli.ts profileCheck 的业务核心，零文件系统耦合）。 */
export function auditProfileBundle(bundle: ProfileBundle, templates: TemplateBundle, opts?: { now?: Date }): Issue[] {
  const now = opts?.now ?? new Date();
  const tz = resolveTimeZone(bundle.timeZone, bundle.profile);
  const inProfile = (xs: Issue[]) => xs.map((i) => ({ ...i, path: `档案.json${i.path ? " " + i.path : ""}` }));
  return [
    ...inProfile(validateProfile(bundle.profile, { now, timeZone: tz })),
    ...inProfile(checkProfileWithTemplates(bundle.profile, templates.manifest)),
    ...collectArchiveIssues(bundle),
    ...collectRecordIssues(bundle, templates, { now }),
    ...collectDocumentIssues(bundle, templates, { now }),
    ...collectCourseIssues(bundle, templates, { now }),
    ...collectProgressIssues(bundle, templates, { now }),
    ...(bundle.extraIssues ?? []),
  ];
}

/** 导出或生成计划单前的档案门禁错误（仅返回 error 级别）。 */
export function preExportErrors(bundle: ProfileBundle, templates: TemplateBundle, opts?: { now?: Date }): Issue[] {
  const now = opts?.now ?? new Date();
  const tz = resolveTimeZone(bundle.timeZone, bundle.profile);
  return [
    ...validateProfile(bundle.profile, { now, timeZone: tz }).map((i) => ({ ...i, path: `档案.json ${i.path}` })),
    ...checkProfileWithTemplates(bundle.profile, templates.manifest).map((i) => ({ ...i, path: `档案.json ${i.path}` })),
    ...collectArchiveIssues(bundle),
    ...collectProgressIssues(bundle, templates, { now }),
    ...collectRecordIssues(bundle, templates, { now }),
  ].filter((i) => i.level === "error");
}

export interface ExportProfileCourseInput {
  week: number;
  day: string;
  picks?: Record<string, string>;
  half?: boolean;
  now?: Date;
}

export interface ExportProfileCourseResult {
  envelope: CourseDeliveryEnvelope | null;
  course: Course | null;
  follow: ExportResult["follow"];
  notes: string[];
  issues: Issue[];
  preGateFailed: boolean;
}

/** 门禁校验 + 导出一天课程 + 组装完整交付信封（含 follow、notes、动图片段哈希与免责声明）。 */
export function exportProfileCourse(
  bundle: ProfileBundle,
  templates: TemplateBundle,
  input: ExportProfileCourseInput,
): ExportProfileCourseResult {
  const now = input.now ?? new Date();
  const tz = resolveTimeZone(bundle.timeZone, bundle.profile);
  if (!templates.plans || !templates.rules) {
    return {
      envelope: null, course: null, follow: [], notes: [], preGateFailed: true,
      issues: [{ level: "error", path: "", message: "模板还没有训练单（dist/data/plans.json、rules.json）：先更新模板仓库" }],
    };
  }
  const pre = preExportErrors(bundle, templates, { now });
  if (pre.length) {
    return { envelope: null, course: null, follow: [], notes: [], issues: pre, preGateFailed: true };
  }
  const seg = currentSegment(bundle.profile)!;
  const sessionsDone = bundle.sessions.filter((s) => s.raw.course?.source?.day === input.day && s.raw.course?.source?.segment === seg.n).length;
  const half = input.half === true;
  const ctx = buildAssessContext(bundle, templates, { now });
  const wkStart = (bundle.profile.segments as any[]).filter((s) => s.n === seg.n && s.week === input.week).pop()?.start;
  const addOns = typeof wkStart === "string" ? activeAddOns(ctx, wkStart) : undefined;
  const r = exportCourse({
    plans: templates.plans,
    rules: templates.rules,
    manifest: templates.manifest,
    profile: bundle.profile,
    week: input.week,
    day: input.day,
    picks: input.picks,
    sessionsDone,
    half,
    addOns,
  });
  const doc = doctorNeed(ctx);
  if (r.course && doc.needed && !doc.ok) {
    r.issues.push({ level: "error", path: "screening", message: `医生同意之前不出课程（${doc.reason}：医生同意的日期 doctorDate 要不早于 ${doc.after}）` });
  }
  const today = dateInZone(now, tz);
  const weekStart = typeof wkStart === "string" ? wkStart : today;
  const info = productInfo(templates.manifest, seg.product);
  const cm = info
    ? cardioMode(templates.rules, bundle.profile, info, seg.n, input.week, bundle.reviewData, { severe: severeObese(ctx, weekStart, info.code) })
    : null;
  if (cm) r.notes.push(`有氧：这一周做${cm.mode}${cm.mode === "稳态" && cm.interval ? "，不做间歇" : ""}${cm.duration ? `，${cm.duration}` : ""}（${cm.why}）`);
  const gh = goalCardioHint(ctx, (bundle.profile.segments as any[]).length - 1);
  if (gh) r.notes.push(gh);
  if (balanceHold(ctx)) r.notes.push("摔倒过：医生同意之前不练平衡动作（6–9 号），照成品第十二章；力量动作也先问医生");
  const g = info ? gap(ctx, info.code, today) : null;
  if (g && g.days > g.remindDays && !half) {
    if (g.long) r.issues.push({ level: "error", path: "", message: `最后一次训练是 ${g.last}，断了 ${g.days} 天：回来第一次只做一半的量，加 --half 导出半量课` });
    else r.notes.push(`最后一次训练是 ${g.last}，断了 ${g.days} 天：照成品，回来第一次只做一半的量——加 --half 重新导出半量课`);
  }
  if (half && !(g && g.days > g.remindDays)) {
    r.notes.push("没有发现中断：半量课只用在中断、生病回来的第一次（照样算训练次数，不当加量依据）");
  }
  if (r.issues.some((i) => i.level === "error") || !r.course) {
    return { envelope: null, course: null, follow: r.follow, notes: r.notes, issues: r.issues, preGateFailed: false };
  }
  const checkIssues = checkCourse(r.course, {
    manifest: templates.manifest,
    readProduct: templates.readProduct,
    profile: bundle.profile,
    plans: templates.plans,
    rules: templates.rules,
    addOns,
  });
  const allIssues = [...r.issues, ...checkIssues];
  if (checkIssues.some((i) => i.level === "error")) {
    return { envelope: null, course: r.course, follow: r.follow, notes: r.notes, issues: allIssues, preGateFailed: false };
  }
  const motionHashes: Record<string, string> = {};
  if (templates.motions && templates.motionHashes) {
    for (const id of courseClips(r.course, templates.motions.clips)) {
      if (templates.motionHashes[id]) motionHashes[id] = templates.motionHashes[id];
    }
  }
  const envelope: CourseDeliveryEnvelope = {
    schema: DELIVERY_FORMAT,
    course: r.course,
    follow: r.follow,
    notes: r.notes,
    declaration: DECLARATION,
    templateVersion: templates.plans.version,
    templateHash: templates.templateHash ?? "",
    motionHashes,
  };
  return { envelope, course: r.course, follow: r.follow, notes: r.notes, issues: allIssues, preGateFailed: false };
}

/**
 * 判定哪些当周活跃课程必须强制作废（对应需求 M3 与 S6）：
 * 1. 档案需要医生同意且未获同意（含新筛查有"是"、摔倒、满一年复筛、跌倒自查高风险等）
 * 2. 65+ 摔倒后处于 balanceHold 状态
 * 3. 课程已落后于当前段/周/段型/成品（换段、推周或换成品）
 * 4. 课程导出之后发生了进度下调（减量/退回/重来/找级降级）或新增了不适记录（疼痛/头晕/胸闷）
 * 5. 按当前档案与模板重跑 checkCourse 报 error（含模板更新导致处方或安全下限变化）
 */
export function detectInvalidatedCourses(
  bundle: ProfileBundle,
  templates: TemplateBundle,
  activeCourses: ProfileCourseItem[],
  opts?: { now?: Date },
): InvalidatedCourse[] {
  const out: InvalidatedCourse[] = [];
  if (!activeCourses.length) return out;
  const now = opts?.now ?? new Date();
  const tz = resolveTimeZone(bundle.timeZone, bundle.profile);
  const ctx = buildAssessContext(bundle, templates, { now });
  const seg = currentSegment(bundle.profile);
  const doc = doctorNeed(ctx);
  const holdBal = balanceHold(ctx);
  const cur = (bundle.profile.segments ?? []).at(-1);
  const addOns = cur && typeof cur.start === "string" ? activeAddOns(ctx, cur.start) : undefined;
  const checkCtx = {
    manifest: templates.manifest,
    readProduct: templates.readProduct,
    profile: bundle.profile,
    plans: templates.plans,
    rules: templates.rules,
    addOns,
  };

  for (const c of activeCourses) {
    if (c.archived) continue;
    const cid = typeof c.raw?.id === "string" ? c.raw.id : "";
    const src = c.raw?.source ?? {};
    if (doc.needed && !doc.ok) {
      out.push({ name: c.name, courseId: cid, reason: `医生同意之前暂停训练（${doc.reason}）` });
      continue;
    }
    if (holdBal) {
      out.push({ name: c.name, courseId: cid, reason: "65 岁以上摔倒后在医生同意前暂停训练与平衡动作" });
      continue;
    }
    if (seg && (src.segment !== seg.n || src.week !== seg.week || src.type !== seg.type || src.product !== seg.product)) {
      out.push({ name: c.name, courseId: cid, reason: `档案已推进至第 ${seg.n} 段第 ${seg.week} 周（${seg.product}），旧课已过期` });
      continue;
    }
    if (c.createdDate && templates.plans && templates.rules) {
      const baseDate = c.createdDate;
      const baseMs = c.createdAt ? Date.parse(c.createdAt) : Number.NaN;
      const downAfter = (bundle.profile.progressLog ?? []).some((e: any) => e?.date >= baseDate && (e.rule === "减量" || e.rule === "退回" || e.rule === "重来"
        || (e.rule === "找级" && Number(e.to) < Number(progressOn(bundle.profile, templates.plans!, templates.rules!, addDays(baseDate, -1), now, tz)?.[e.move]?.[e.field] ?? Infinity))));
      const sickAfter = bundle.sessions.some((s) => {
        const st = Date.parse(s.raw?.startedAt);
        if (Number.isNaN(st)) return false;
        const isSick = !!(s.raw?.symptoms?.pain || s.raw?.symptoms?.dizzy || s.raw?.symptoms?.chest);
        if (!isSick) return false;
        // 若提供精确发布时间戳 createdAt，则仅当不适发生在发布之后才判 sickAfter，避免同日不适后管理员重发的轻课被误作废；
        // 迟到不适（发生在发布前但晚于发布回传）由服务端在 submitMobileSessionOp 入库时刻按入库时间即时作废旧课。
        return Number.isFinite(baseMs) ? st > baseMs : dateInZone(new Date(st), tz) >= baseDate;
      });
      if (downAfter || sickAfter) {
        out.push({ name: c.name, courseId: cid, reason: sickAfter ? "导出后出现疼痛、头晕或胸闷，旧课已作废" : "导出后个人进度已下调，旧课比现在重已作废" });
        continue;
      }
    }
    const courseErr = checkCourse(c.raw, checkCtx).find((i) => i.level === "error");
    if (courseErr) {
      out.push({ name: c.name, courseId: cid, reason: `课程校验未通过（${courseErr.message}），请重新生成` });
    }
  }
  return out;
}

/** 生成当前周个人计划单（门禁 + 医生同意 + buildSheet）。 */
export function generateProfileSheet(
  bundle: ProfileBundle,
  templates: TemplateBundle,
  opts?: { now?: Date },
): { text: string | null; file: string | null; issues: Issue[]; preGateFailed: boolean } {
  const now = opts?.now ?? new Date();
  if (!templates.plans || !templates.rules) {
    return { text: null, file: null, preGateFailed: true, issues: [{ level: "error", path: "", message: "模板还没有训练单（dist/data/）" }] };
  }
  const pre = preExportErrors(bundle, templates, { now });
  const ctx = buildAssessContext(bundle, templates, { now });
  const doc = doctorNeed(ctx);
  if (doc.needed && !doc.ok) {
    pre.push({ level: "error", path: "screening", message: `医生同意之前不出计划（${doc.reason}：医生同意的日期 doctorDate 要不早于 ${doc.after}）` });
  }
  if (pre.length) return { text: null, file: null, issues: pre, preGateFailed: true };
  const r = buildSheet(ctx);
  if (!r.text || r.issues.length) return { text: null, file: null, issues: r.issues, preGateFailed: false };
  const seg = currentSegment(bundle.profile)!;
  return { text: r.text, file: sheetFile(seg.n, seg.week), issues: [], preGateFailed: false };
}

/** 评估结论重算与核对（服务端与 CLI 共用）。 */
export function evaluateAssessment(
  bundle: ProfileBundle,
  templates: TemplateBundle,
  kind: string,
  file: AssessFile,
  opts?: { product?: string; now?: Date },
): { conclusion: Record<string, unknown> | null; issues: Issue[]; error?: string } {
  const ar = assessRules(templates.rules);
  if (!ar) return { conclusion: null, issues: [], error: "模板还没有评估规则（rules.json 的 assess）" };
  if (!["入门", "段末", "周期末", "触发"].includes(kind)) return { conclusion: null, issues: [], error: "种类写 入门 / 段末 / 周期末 / 触发" };
  const seg = currentSegment(bundle.profile);
  if (seg && kind === "周期末" && seg.phase !== "稳定" && !(bundle.profile.segments as any[]).some((x) => x.phase === "稳定")) {
    return { conclusion: null, issues: [], error: "周期末评估只在稳定期第 12 周之后做；起始期每段第 4 周之后做的是段末评估" };
  }
  const product = opts?.product ?? file.raw?.product ?? seg?.product ?? bundle.profile.product;
  const info = productInfo(templates.manifest, product);
  if (!info) return { conclusion: null, issues: [], error: `模板里没有成品「${product}」` };
  const baseCtx = buildAssessContext(bundle, templates, { now: opts?.now });
  const ctx: AssessContext = {
    ...baseCtx,
    assessments: [...bundle.assessments.filter((a) => a.name !== file.name), file],
  };
  const asEntry = kind === "入门" || (kind === "触发" && (file.raw.reasons ?? []).some((x: string) => x === "跨段" || x === "换场地"));
  const want = recordConclusion(ctx, file, product, asEntry) ?? {};
  const issues = [
    ...validateAssessment(file.raw),
    ...checkRecord(ctx, { ...file, raw: { ...file.raw, conclusion: file.raw.conclusion ?? want } }, product, asEntry),
  ];
  return { conclusion: want, issues };
}

/** 段末 / 周期末摘要查询（供网页端与 Agent 辅助展示，不含写操作）。 */
export function inspectEndSummary(bundle: ProfileBundle, templates: TemplateBundle, kind: "段末" | "周期末", opts?: { now?: Date }) {
  const ar = assessRules(templates.rules);
  const seg = currentSegment(bundle.profile);
  if (!ar || !seg) return null;
  const ctx = buildAssessContext(bundle, templates, { now: opts?.now });
  if (kind === "段末") {
    const info = productInfo(templates.manifest, seg.product);
    if (!info) return null;
    const n = seg.week === 4 || seg.n === 1 ? seg.n : seg.n - 1;
    return { segment: n, summary: segmentEnd(bundle.profile, n, bundle.reviewData, ar, info.code) };
  }
  const segs = bundle.profile.segments as any[];
  const stableNs = [...new Set(segs.filter((x) => x.phase === "稳定").map((x) => x.n))] as number[];
  const cycleWeeks = templates.rules?.stable?.cycleWeeks ?? 12;
  const done = stableNs.filter((n) => segs.some((x) => x.n === n && x.week === cycleWeeks));
  const n = done.length ? done[done.length - 1] : stableNs[stableNs.length - 1];
  const end = done.length ? cycleEnd(ctx, n) : null;
  const goals = end && !("error" in end) && end.next.phase === "稳定" ? cycleGoals(ctx, n) : null;
  return { segment: n, summary: end, goals };
}

export interface PrepareSessionImportOptions {
  replace?: boolean;
  now?: Date;
  maxFutureMs?: number;
}

export interface PrepareSessionImportResult {
  status: "accepted" | "duplicate" | "rejected" | "clock_skew_future";
  reason?: string;
  serverNow: string;
  hurt: string[];
  oddSymptoms: boolean;
  warnings: Issue[];
  validationIssues: Issue[];
  droppedFields: string[];
  record?: Record<string, unknown>;
  replaceTarget?: string;
  diff?: string[];
  suggestedName?: string;
}

/** 练习记录导入核心校验与去重（CLI 与服务端共用，保证症状/edited 不可抹除、时区准确、时钟漂移明确码）。 */
export function prepareSessionImport(
  bundle: ProfileBundle,
  raw: unknown,
  opts?: PrepareSessionImportOptions,
): PrepareSessionImportResult {
  const now = opts?.now ?? new Date();
  const maxFutureMs = opts?.maxFutureMs ?? 5 * 60_000;
  const tz = resolveTimeZone(bundle.timeZone, bundle.profile);
  const serverNow = now.toISOString();

  const obj = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Obj) : null;
  const sym = obj?.symptoms && typeof obj.symptoms === "object" ? obj.symptoms : null;
  const hurt = sym ? Object.keys(SYMPTOM_NAMES).filter((k) => sym[k] === true) : [];
  const oddSymptoms = !sym || Object.keys(SYMPTOM_NAMES).some((k) => sym[k] !== true && sym[k] !== false);

  const reject = (reason: string, validationIssues: Issue[] = [], status: "rejected" | "clock_skew_future" = "rejected"): PrepareSessionImportResult => ({
    status, reason, serverNow, hurt, oddSymptoms, warnings: [], validationIssues, droppedFields: [],
  });

  if (!obj) return reject("练习记录要是 JSON 对象");
  const v = validateSession(obj);
  if (v.some((i) => i.level === "error")) return reject("格式不对", v);
  const warnings = v.filter((i) => i.level === "warning" && i.path !== "symptoms");

  const src = obj.course.source as Obj;
  if (src.plan !== "yangxia.plans/1" || !Number.isInteger(src.segment)) {
    return reject("练的不是档案里导出的课程（样例课、手写的课），不导入");
  }
  if (courseIdFor(src.product, src.segment, src.type ?? "标准", src.week, src.day ?? "", src.half === true) !== obj.course.id) {
    return reject("课程 id 和出处对不上（记录被改过）");
  }
  const segs = ((bundle.profile.segments ?? []) as Obj[]).filter((x) => x.n === src.segment);
  const segOk = segs.length && segs.some((x) => (x.product ?? bundle.profile.product) === src.product && (x.type ?? "标准") === (src.type ?? "标准"))
    && Math.max(...segs.map((x) => Number(x.week) || 0)) >= src.week;
  if (!segOk) {
    return reject(`档案里没有这一段这一周（第 ${src.segment} 段第 ${src.week} 周，${src.product}）：练的不是这个档案的课`);
  }

  const started = new Date(obj.startedAt);
  const segStart = segs.map((x) => String(x.start ?? "")).filter(Boolean).sort()[0];
  if (started.getTime() > now.getTime() + maxFutureMs) {
    return reject("开始时间在将来（电脑或手机的时间不对？）", [], "clock_skew_future");
  }
  const startedDay = dateInZone(started, tz);
  if (segStart && startedDay < segStart) {
    return reject(`开始时间 ${startedDay} 早于这一段开始那天 ${segStart}`);
  }

  const { rec, dropped } = normalizeSession(obj);
  const known = bundle.sessions.map((x) => {
    let normRec: Record<string, unknown> | null = null;
    try {
      if (!validateSession(x.raw).some((i) => i.level === "error")) normRec = normalizeSession(x.raw).rec;
    } catch {
      normRec = null;
    }
    return { name: x.name, raw: x.raw, rec: normRec };
  });
  const same = known.find((k) => k.raw?.course?.id === obj.course.id && Date.parse(k.raw?.startedAt) === Date.parse(obj.startedAt));
  if (same) {
    if (same.rec && sameJson(same.rec, rec)) {
      return { status: "duplicate", serverNow, hurt, oddSymptoms, warnings, validationIssues: [], droppedFields: dropped, record: rec, replaceTarget: same.name };
    }
    const diff = same.rec ? diffSessionFields(same.rec, rec) : ["旧记录格式不对"];
    if (!opts?.replace) {
      return reject(same.rec
        ? `同一次练习（${same.name}）已经有记录，内容不一样：${diff.join("、")}。问过使用者确实要换，加 --replace 原地覆盖`
        : `档案里这次练习的旧记录（${same.name}）格式不对：先改好它，或者问过使用者加 --replace 用这份替换`);
    }
    const oldSym = same.raw?.symptoms ?? {};
    const lost = Object.keys(SYMPTOM_NAMES).filter((k) => !!oldSym[k] && (rec.symptoms as Record<string, boolean>)[k] !== true);
    if (lost.length || (!!same.raw?.edited && rec.edited !== true)) {
      return reject(lost.length
        ? `旧记录里的${lost.map((k) => SYMPTOM_NAMES[k]).join("、")}不能改成没有：使用者说当时点错了，照实写进周复盘，不改记录`
        : "手改过的课（edited，编排器自动记的）不能改成没改过：照实写进周复盘，不改记录");
    }
    return { status: "accepted", serverNow, hurt, oddSymptoms, warnings, validationIssues: [], droppedFields: dropped, record: rec, replaceTarget: same.name, diff };
  }

  const base = `养夏_练习记录_${startedDay}_${hhmmInZone(started, tz)}`;
  const existingNames = new Set(known.map((k) => k.name.replace(/\\/g, "/")));
  let n = 1;
  let suggestedName = `打卡/${base}.json`;
  while (existingNames.has(suggestedName)) suggestedName = `打卡/${base}_${++n}.json`;

  return {
    status: "accepted",
    serverNow,
    hurt,
    oddSymptoms,
    warnings,
    validationIssues: [],
    droppedFields: dropped,
    record: rec,
    suggestedName,
  };
}

export { ASSESS_FORMAT, REVIEW_FORMAT };
