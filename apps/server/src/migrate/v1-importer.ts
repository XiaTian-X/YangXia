// v1.0.0 个人档案目录 / ZIP 迁移导入器（对应需求 A4 与架构 3.5）：
// - 完整扫描根目录与 历史/第N段/{课程,打卡,复盘,评估,计划,菜单}/
// - 保留归一化 legacy_path 与 logical_path，保证 progressLog[].evidence 和 segments[].restart 无损映射
// - 迁入的历史计划单标 readonly_legacy=1 豁免 checkSheet
// - 跳过 .html 课程包、.ics 日历与隐藏文件并输出报告；单事务内跑通 auditProfileBundle 0 错误落库
import { lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  ASSESS_FORMAT,
  auditProfileBundle,
  currentSegment,
  isValidTimeZone,
  PROFILE_FORMAT,
  REVIEW_FORMAT,
  SESSION_FORMAT,
  type AssessFile,
  type Issue,
  type ProfileBundle,
  type ProfileCourseItem,
  type ProfileDocItem,
  type SessionFile,
} from "@yangxia/course-core";
import type { AuthActor } from "../auth/permissions.ts";
import { isTeenMemberAccount } from "../auth/permissions.ts";
import { newId, sha256Hex } from "../crypto/tokens.ts";
import { writeAuditLog } from "../db/audit.ts";
import { AppError, withTransaction } from "../db/lock.ts";
import type { TemplatesSnapshot } from "../templates/manager.ts";
import { DEFAULT_ZIP_LIMITS, extractZipStrict, type ZipEntry } from "./zip.ts";

type Obj = Record<string, any>;

export interface ImportV1Options {
  timezone?: string;
  isManaged?: boolean;
  memberUserId?: string | null;
  codeOverride?: string;
  now?: Date;
}

export interface ImportV1Report {
  profileId: string;
  code: string;
  counts: {
    courses: number;
    sessions: number;
    reviews: number;
    assessments: number;
    documents: number;
  };
  skipped: { path: string; reason: string }[];
  warnings: Issue[];
  notes: string[];
}

function stripCommonRoot(entries: ZipEntry[]): ZipEntry[] {
  // 过滤 macOS 打包附加目录与隐藏文件
  const clean = entries.filter((e) => !e.path.startsWith("__MACOSX/") && !e.path.split("/").some((s) => s.startsWith(".")));
  if (clean.some((e) => e.path === "档案.json")) return clean;
  const profileEntry = clean.find((e) => /^[^/]+\/档案\.json$/.test(e.path));
  if (!profileEntry) return clean;
  const prefix = profileEntry.path.slice(0, profileEntry.path.indexOf("/") + 1);
  return clean
    .filter((e) => e.path.startsWith(prefix))
    .map((e) => ({ path: e.path.slice(prefix.length), data: e.data }));
}

function collectDirectoryEntries(dirPath: string, migrateRoot: string): ZipEntry[] {
  const realRoot = realpathSync(migrateRoot);
  const resolved = resolve(realRoot, dirPath);
  // 先做词法边界校验，避免对越界不存在路径返回 ENOENT 泄露宿主机文件系统存在性
  if (resolved !== realRoot && !resolved.startsWith(realRoot + sep)) {
    throw new AppError(403, "MIGRATE_PATH_FORBIDDEN", "迁移目录必须位于服务端允许的 YANGXIA_MIGRATE_DIR 白名单内");
  }
  let realTarget: string;
  try {
    realTarget = realpathSync(resolved);
  } catch {
    throw new AppError(404, "MIGRATE_PATH_NOT_FOUND", "指定的迁移目录不存在");
  }
  if (realTarget !== realRoot && !realTarget.startsWith(realRoot + sep)) {
    throw new AppError(403, "MIGRATE_PATH_FORBIDDEN", "迁移目录必须位于服务端允许的 YANGXIA_MIGRATE_DIR 白名单内");
  }
  if (!statSync(realTarget).isDirectory()) {
    throw new AppError(400, "MIGRATE_NOT_DIR", "指定的迁移路径不是目录");
  }

  const out: ZipEntry[] = [];
  let totalBytes = 0;

  const walk = (cur: string, depth: number) => {
    if (depth > 10) {
      throw new AppError(400, "MIGRATE_DEPTH_EXCEEDED", "迁移目录层级过深（最多 10 层）");
    }
    for (const name of readdirSync(cur)) {
      if (name.startsWith(".")) continue;
      const full = join(cur, name);
      const lst = lstatSync(full);
      if (lst.isSymbolicLink()) {
        throw new AppError(400, "MIGRATE_SYMLINK_FORBIDDEN", `迁移目录禁止包含符号链接：${relative(realTarget, full)}`);
      }
      if (lst.isDirectory()) {
        walk(full, depth + 1);
        continue;
      }
      if (!lst.isFile()) continue;
      if (out.length >= DEFAULT_ZIP_LIMITS.maxFiles) {
        throw new AppError(400, "MIGRATE_TOO_MANY_FILES", `文件数超过上限（${DEFAULT_ZIP_LIMITS.maxFiles}）`);
      }
      if (lst.size > DEFAULT_ZIP_LIMITS.maxFileBytes) {
        throw new AppError(400, "MIGRATE_FILE_TOO_LARGE", `单文件超过 2 MB：${relative(realTarget, full)}`);
      }
      totalBytes += lst.size;
      if (totalBytes > DEFAULT_ZIP_LIMITS.maxTotalBytes) {
        throw new AppError(400, "MIGRATE_TOTAL_TOO_LARGE", "迁移目录总大小超过 50 MB 上限");
      }
      const rel = relative(realTarget, full).split(sep).join("/");
      out.push({ path: rel, data: readFileSync(full) });
    }
  };
  walk(realTarget, 0);
  return out;
}

export function importV1Entries(
  db: DatabaseSync,
  templates: TemplatesSnapshot,
  actor: AuthActor,
  rawEntries: ZipEntry[],
  opts: ImportV1Options = {},
): ImportV1Report {
  if (actor.sessionKind === "mobile_bound") {
    throw new AppError(403, "FORBIDDEN", "扫码绑定设备不能执行迁移导入");
  }
  if (isTeenMemberAccount(db, actor)) {
    throw new AppError(403, "FORBIDDEN", "青少年账号无权执行迁移导入");
  }
  const isManaged = opts.isManaged === true;
  if (isManaged && actor.role !== "admin") {
    throw new AppError(403, "FORBIDDEN", "只有管理员可以导入代管子档案");
  }
  if (!isManaged && opts.memberUserId) {
    throw new AppError(400, "INVALID_INPUT", "独立档案不能关联代管成员账号");
  }

  const now = opts.now ?? new Date();
  const entries = stripCommonRoot(rawEntries);
  const profileFile = entries.find((e) => e.path === "档案.json");
  if (!profileFile) {
    throw new AppError(400, "MIGRATE_MISSING_PROFILE", "迁移包中缺少 档案.json");
  }

  let profile: Obj;
  try {
    profile = JSON.parse(profileFile.data.toString("utf8")) as Obj;
  } catch {
    throw new AppError(400, "MIGRATE_INVALID_JSON", "档案.json 不是合法 JSON");
  }
  if (profile.schema !== PROFILE_FORMAT) {
    throw new AppError(422, "MIGRATE_INVALID_PROFILE", `档案 schema 不匹配：${String(profile.schema)}`);
  }
  if (opts.codeOverride?.trim()) {
    profile.code = opts.codeOverride.trim();
  }
  const tz = opts.timezone ?? profile.timezone ?? "Asia/Shanghai";
  if (!isValidTimeZone(tz)) {
    throw new AppError(422, "INVALID_TIMEZONE", `非法 IANA 时区：${tz}`);
  }
  profile.timezone = tz;

  const segN = currentSegment(profile)?.n ?? 1;
  const skipped: { path: string; reason: string }[] = [];
  const sessions: SessionFile[] = [];
  const reviewData: Record<string, Obj> = {};
  const reviewJsons = new Map<string, { path: string; raw: Obj; archivedSegment?: number; key: string }>();
  const reviewMds = new Map<string, { path: string; text: string; archivedSegment?: number; key: string }>();
  const courses: ProfileCourseItem[] = [];
  const assessments: AssessFile[] = [];
  const docs: ProfileDocItem[] = [];

  for (const entry of entries) {
    const norm = entry.path;
    if (norm === "档案.json") continue;
    const lower = norm.toLowerCase();
    if (lower.endsWith(".html") || lower.endsWith(".htm")) {
      skipped.push({ path: norm, reason: "课程包 .html 无需迁移，服务端可随时按档案重新发布" });
      continue;
    }
    if (lower.endsWith(".ics")) {
      skipped.push({ path: norm, reason: "日历文件 .ics 不迁入数据库" });
      continue;
    }

    const archived = norm.startsWith("历史/");
    const archMatch = archived ? /^历史\/第(\d+)段\//.exec(norm) : null;
    const archivedSegment = archMatch ? Number(archMatch[1]) : undefined;
    const rv = /(?:^|\/)复盘\/([^/]+)$/.exec(norm);

    if (lower.endsWith(".json")) {
      let raw: Obj;
      try {
        raw = JSON.parse(entry.data.toString("utf8")) as Obj;
      } catch {
        throw new AppError(422, "MIGRATE_INVALID_JSON", `JSON 解析失败：${norm}`);
      }
      if (raw?.schema === SESSION_FORMAT) {
        sessions.push({ name: norm, raw, archived, archivedSegment });
      } else if (raw?.schema === "yangxia.course/1") {
        courses.push({ name: norm, raw, archived, archivedSegment });
      } else if (raw?.schema === ASSESS_FORMAT) {
        assessments.push({ name: norm, raw, archived, archivedSegment });
      } else if (raw?.schema === REVIEW_FORMAT) {
        const key = rv ? rv[1] : norm;
        const pairKey = `${archivedSegment ?? 0}:${key.replace(/\.json$/i, "")}`;
        reviewData[key] = raw;
        reviewJsons.set(pairKey, { path: norm, raw, archivedSegment, key });
      } else {
        skipped.push({ path: norm, reason: "未识别的 JSON 文件，已跳过" });
      }
    } else if (lower.endsWith(".md") || lower.endsWith(".txt")) {
      const text = entry.data.toString("utf8");
      const isMenu = norm.startsWith("菜单/") || /^历史\/第\d+段\/菜单\//.test(norm);
      const isPlan = norm.startsWith("计划/") || /^历史\/第\d+段\/计划\//.test(norm);
      const isMonthly = !!rv && rv[1] === "月度总结.md";
      if (isMenu) {
        docs.push({ name: norm, text, kind: "menu", archived, archivedSegment });
      } else if (isPlan) {
        // A4 ②：旧版迁入的历史计划单标 readonly_legacy=1，免于按新模板重跑 checkSheet 报错
        docs.push({ name: norm, text, kind: "plan", archived, archivedSegment, legacyReadonly: true });
      } else if (isMonthly) {
        docs.push({ name: norm, text, kind: "monthly_summary", archived, archivedSegment });
      } else if (rv) {
        const pairKey = `${archivedSegment ?? 0}:${rv[1].replace(/\.md$/i, "")}`;
        reviewMds.set(pairKey, { path: norm, text, archivedSegment, key: rv[1] });
        docs.push({ name: norm, text, kind: "review", archived, archivedSegment });
      } else {
        skipped.push({ path: norm, reason: "非标准目录下的文本文件，已跳过" });
      }
    } else {
      skipped.push({ path: norm, reason: "非养夏数据文件，已跳过" });
    }
  }

  const bundle: ProfileBundle = {
    profile,
    timeZone: tz,
    sessions,
    reviewData,
    courses,
    assessments,
    docs,
  };

  // 单事务前先跑完整 auditProfileBundle 门禁（0 错误才允许落库）
  const auditIssues = auditProfileBundle(bundle, templates, { now });
  const errs = auditIssues.filter((i) => i.level === "error");
  if (errs.length) {
    throw new AppError(422, "MIGRATE_AUDIT_FAILED", "迁移档案未通过规则核对，已取消导入", { issues: auditIssues });
  }

  return withTransaction(db, () => {
    if (opts.memberUserId) {
      const m = db.prepare("SELECT id, disabled_at FROM users WHERE id = ?").get(opts.memberUserId) as
        | { id: string; disabled_at: string | null }
        | undefined;
      if (!m || m.disabled_at) throw new AppError(404, "MEMBER_NOT_FOUND", "关联的成员账号不存在或已停用");
    }

    const dup = db.prepare("SELECT 1 FROM profiles WHERE code = ?").get(profile.code);
    if (dup) {
      throw new AppError(409, "PROFILE_CODE_CONFLICT", "该档案代号不可用，请更换其他代号");
    }

    const profileId = newId();
    const nowIso = now.toISOString();
    db.prepare(
      `INSERT INTO profiles
        (id, code, owner_user_id, is_managed, member_user_id, timezone, profile_json, version, has_conflict, updated_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?)`,
    ).run(
      profileId,
      String(profile.code),
      actor.userId,
      isManaged ? 1 : 0,
      isManaged ? (opts.memberUserId ?? null) : null,
      tz,
      JSON.stringify(profile),
      nowIso,
      nowIso,
    );

    // 写入课程（旧版 v1 课程 JSON 不含交付信封 follow/notes/motionHashes，归档课保留 archived，其余置 superseded 并提醒重新发布）
    for (const c of courses) {
      const src = (c.raw.source ?? {}) as Obj;
      const cSeg = typeof src.segment === "number" ? src.segment : (c.archivedSegment ?? segN);
      const cWeek = typeof src.week === "number" ? src.week : 1;
      const cDay = String(src.day ?? "");
      const half = src.half === true ? 1 : 0;
      const status: "superseded" | "archived" = c.archived ? "archived" : "superseded";
      const courseJson = JSON.stringify(c.raw);
      db.prepare(
        `INSERT INTO courses
          (id, profile_id, course_id, segment, week, day, half, status, archived_segment, legacy_path,
           course_json, follow_json, notes_json, template_version, template_hash, motion_hashes_json, snapshot_hash, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', '[]', ?, '', '{}', ?, ?, ?)`,
      ).run(
        newId(),
        profileId,
        String(c.raw.id ?? ""),
        cSeg,
        cWeek,
        cDay,
        half,
        status,
        c.archivedSegment ?? null,
        c.name,
        courseJson,
        String(src.templates ?? templates.version),
        sha256Hex(courseJson),
        nowIso,
        nowIso,
      );
    }

    // 写入练习记录（入库前校验同 (course_id, started_at) 重复，返回 422 而非未捕获 UNIQUE 500）
    const seenSessionKeys = new Set<string>();
    for (const s of sessions) {
      const raw = s.raw;
      const cid = String(raw.course?.id ?? "");
      const st = String(raw.startedAt ?? nowIso);
      const sk = `${cid}\0${st}`;
      if (seenSessionKeys.has(sk)) {
        throw new AppError(422, "MIGRATE_DUPLICATE_SESSION", `迁移目录包含重复的练习记录（${s.name}），请清理后再导入`);
      }
      seenSessionKeys.add(sk);
      const sym = (raw.symptoms ?? {}) as Obj;
      const hasSymptoms = sym.pain === true || sym.dizzy === true || sym.chest === true ? 1 : 0;
      db.prepare(
        `INSERT INTO workout_sessions
          (id, profile_id, course_id, started_at, ended_at, has_symptoms, edited, stale_course,
           archived_segment, legacy_path, session_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`,
      ).run(
        newId(),
        profileId,
        cid,
        st,
        typeof raw.endedAt === "string" ? raw.endedAt : null,
        hasSymptoms,
        raw.edited === true ? 1 : 0,
        s.archivedSegment ?? null,
        s.name,
        JSON.stringify(raw),
        nowIso,
        nowIso,
      );
    }

    // 写入复盘（配对 json + md，入库前防同 (segment, week, start_date) 重复）
    const segs = Array.isArray(profile.segments) ? (profile.segments as Obj[]) : [];
    const allPairKeys = new Set([...reviewJsons.keys(), ...reviewMds.keys()]);
    const seenReviewKeys = new Set<string>();
    let reviewCount = 0;
    for (const pk of allPairKeys) {
      const j = reviewJsons.get(pk);
      const m = reviewMds.get(pk);
      if (!j) continue;
      const startDate = String(j.raw.start ?? "");
      const week = Number(j.raw.week ?? 1);
      const matchedSeg = segs.find((sg) => sg.start === startDate && sg.week === week);
      const segment = j.archivedSegment ?? matchedSeg?.n ?? segN;
      const rk = `${segment}:${week}:${startDate}`;
      if (seenReviewKeys.has(rk)) {
        throw new AppError(422, "MIGRATE_DUPLICATE_REVIEW", `迁移目录包含重复的周复盘数据（${j.path}）`);
      }
      seenReviewKeys.add(rk);
      db.prepare(
        `INSERT INTO reviews
          (id, profile_id, segment, week, start_date, archived_segment, legacy_json_path, legacy_md_path,
           review_json, review_md, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        newId(),
        profileId,
        segment,
        week,
        startDate,
        j.archivedSegment ?? null,
        j.path,
        m?.path ?? null,
        JSON.stringify(j.raw),
        m?.text ?? "",
        nowIso,
        nowIso,
      );
      reviewCount += 1;
    }

    // 写入评估记录
    for (const a of assessments) {
      db.prepare(
        `INSERT INTO assessments
          (id, profile_id, kind, assess_date, logical_path, archived_segment, assessment_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        newId(),
        profileId,
        String(a.raw.kind ?? "触发"),
        String(a.raw.date ?? ""),
        a.name,
        a.archivedSegment ?? null,
        JSON.stringify(a.raw),
        nowIso,
      );
    }

    // 写入计划单/菜单/月度总结文档
    let docCount = 0;
    for (const d of docs) {
      if (d.kind === "review" || d.kind === "other") continue;
      const title = d.name.split("/").pop()?.replace(/\.md$/i, "") ?? d.name;
      const mPlan = /第(\d+)段-第(\d+)周/.exec(d.name);
      db.prepare(
        `INSERT INTO documents
          (id, profile_id, doc_type, title, segment, week, archived_segment, legacy_path, readonly_legacy, content_md, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        newId(),
        profileId,
        d.kind,
        title,
        d.archivedSegment ?? (mPlan ? Number(mPlan[1]) : null),
        mPlan ? Number(mPlan[2]) : null,
        d.archivedSegment ?? null,
        d.name,
        d.legacyReadonly ? 1 : 0,
        d.text,
        nowIso,
        nowIso,
      );
      docCount += 1;
    }

    writeAuditLog(db, {
      actorUserId: actor.userId,
      actorSessionId: actor.sessionId,
      profileId,
      action: "profile.import_v1",
      fields: ["profiles", "courses", "workout_sessions", "reviews", "assessments", "documents"],
      ruleOrReason: isManaged ? "v1_migrate_managed" : "v1_migrate_self",
      now,
    });

    return {
      profileId,
      code: String(profile.code),
      counts: {
        courses: courses.length,
        sessions: sessions.length,
        reviews: reviewCount,
        assessments: assessments.length,
        documents: docCount,
      },
      skipped,
      warnings: auditIssues.filter((i) => i.level === "warning"),
      notes: [
        "浏览器本地保存的编排器偏好和自定义方案库不在 v1.0.0 档案目录内，无法自动迁移，请在网页端或手机端按需重新设置。",
        "迁入的旧版计划单（计划/*.md）已按历史只读方式保存，后续请通过「生成计划单」按当前模板生成最新一周。",
      ],
    };
  });
}

export function importV1Zip(
  db: DatabaseSync,
  templates: TemplatesSnapshot,
  actor: AuthActor,
  zipBuffer: Buffer,
  opts: ImportV1Options = {},
): ImportV1Report {
  const entries = extractZipStrict(zipBuffer);
  return importV1Entries(db, templates, actor, entries, opts);
}

export function importV1Directory(
  db: DatabaseSync,
  templates: TemplatesSnapshot,
  actor: AuthActor,
  dirPath: string,
  migrateRoot: string | undefined,
  opts: ImportV1Options = {},
): ImportV1Report {
  if (actor.role !== "admin") {
    throw new AppError(403, "FORBIDDEN", "只有管理员可从服务器本地目录导入迁移档案");
  }
  if (!migrateRoot) {
    throw new AppError(400, "MIGRATE_DIR_UNCONFIGURED", "服务端未配置 YANGXIA_MIGRATE_DIR，请改用 ZIP 上传导入");
  }
  const entries = collectDirectoryEntries(dirPath, migrateRoot);
  return importV1Entries(db, templates, actor, entries, opts);
}
