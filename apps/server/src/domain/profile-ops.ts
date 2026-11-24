// 事务级核心业务操作（供 REST API 与阶段 3 Agent 工具共同调用，保证规则 100% 同源）：
// 全部写入走单档案 BEGIN IMMEDIATE 锁 + 乐观锁 + engine.ts 门禁 + 脱敏审计 + 过重旧课自动作废。
import type { DatabaseSync } from "node:sqlite";
import {
  ASSESS_FORMAT,
  auditProfileBundle,
  collectProgressIssues,
  currentSegment,
  DECLARATION,
  detectInvalidatedCourses,
  evaluateAssessment,
  exportProfileCourse,
  generateProfileSheet,
  isValidTimeZone,
  prepareSessionImport,
  PROFILE_FORMAT,
  REVIEW_FORMAT,
  reviewDataName,
  reviewName,
  validateProfile,
  type CourseDeliveryEnvelope,
  type InvalidatedCourse,
  type Issue,
} from "@yangxia/course-core";
import type { AuthActor } from "../auth/permissions.ts";
import { isTeenMemberAccount } from "../auth/permissions.ts";
import { newId, sha256Hex } from "../crypto/tokens.ts";
import { writeAuditLog } from "../db/audit.ts";
import { loadProfileState, type CourseDbRow } from "../db/bundle.ts";
import { AppError, withProfileLock, withTransaction } from "../db/lock.ts";
import type { TemplatesSnapshot } from "../templates/manager.ts";

type Obj = Record<string, any>;

function onlyErrors(issues: Issue[]): Issue[] {
  return issues.filter((i) => i.level === "error");
}

function onlyWarnings(issues: Issue[]): Issue[] {
  return issues.filter((i) => i.level === "warning");
}

function currentWeekStart(profile: Obj): string | null {
  const segs = Array.isArray(profile.segments) ? (profile.segments as Obj[]) : [];
  const last = segs[segs.length - 1];
  return typeof last?.start === "string" ? last.start : null;
}

function diffTopKeys(before: Obj, after: Obj): string[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const changed: string[] = [];
  for (const k of keys) {
    if (JSON.stringify(before[k]) !== JSON.stringify(after[k])) changed.push(k);
  }
  return changed;
}

/** 在已有事务内检测当前档案的全部活跃课程，将命中作废条件的置 invalidated 并返回清单。 */
export function invalidateAffectedCoursesInTx(
  db: DatabaseSync,
  profileId: string,
  templates: TemplatesSnapshot,
  now: Date,
): InvalidatedCourse[] {
  const state = loadProfileState(db, profileId);
  if (!state.activeCourseItems.length) return [];
  const invalid = detectInvalidatedCourses(state.bundle, templates, state.activeCourseItems, { now });
  if (!invalid.length) return [];

  const byName = new Map(state.activeCourseItems.map((c) => [c.name, c.rowId]));
  const nowIso = now.toISOString();
  for (const inv of invalid) {
    const rowId = byName.get(inv.name);
    if (!rowId) continue;
    db.prepare(
      "UPDATE courses SET status = 'invalidated', invalidated_reason = ?, updated_at = ? WHERE id = ? AND status = 'active'",
    ).run(inv.reason, nowIso, rowId);
  }
  return invalid;
}

function uniqueSessionPath(db: DatabaseSync, profileId: string, suggested: string): string {
  const exists = (p: string) =>
    !!db.prepare("SELECT 1 FROM workout_sessions WHERE profile_id = ? AND legacy_path = ?").get(profileId, p);
  if (!exists(suggested)) return suggested;
  const stem = suggested.replace(/\.json$/i, "");
  for (let i = 2; i < 1000; i++) {
    const cand = `${stem}_${i}.json`;
    if (!exists(cand)) return cand;
  }
  return `${stem}_${newId().slice(0, 8)}.json`;
}

function uniqueAssessmentPath(db: DatabaseSync, profileId: string, date: string, kind: string, preferred?: string): string {
  const base = preferred && /^评估\/[0-9]{4}-[0-9]{2}-[0-9]{2}-[\u4e00-\u9fa5a-zA-Z0-9_-]+\.json$/.test(preferred)
    ? preferred
    : `评估/${date}-${kind}.json`;
  const exists = (p: string) =>
    !!db.prepare("SELECT 1 FROM assessments WHERE profile_id = ? AND logical_path = ?").get(profileId, p);
  if (!exists(base)) return base;
  const stem = base.replace(/\.json$/i, "");
  for (let i = 2; i < 100; i++) {
    const cand = `${stem}-${i}.json`;
    if (!exists(cand)) return cand;
  }
  return `${stem}-${newId().slice(0, 6)}.json`;
}

export interface CreateProfileInput {
  profile: Obj;
  timezone?: string;
  isManaged?: boolean;
  memberUserId?: string | null;
  initialAssessment?: Obj;
}

export function createProfileOp(
  db: DatabaseSync,
  templates: TemplatesSnapshot,
  actor: AuthActor,
  input: CreateProfileInput,
  now = new Date(),
) {
  if (actor.sessionKind === "mobile_bound") {
    throw new AppError(403, "FORBIDDEN", "扫码绑定设备不能新建档案");
  }
  if (isTeenMemberAccount(db, actor)) {
    throw new AppError(403, "FORBIDDEN", "青少年账号无权新建档案");
  }
  const isManaged = input.isManaged === true;
  if (isManaged && actor.role !== "admin") {
    throw new AppError(403, "FORBIDDEN", "只有管理员可以创建家庭代管档案");
  }
  if (!isManaged && input.memberUserId) {
    throw new AppError(400, "INVALID_INPUT", "独立档案不能关联代管成员账号");
  }

  const profile: Obj = { ...input.profile, schema: PROFILE_FORMAT };
  const tz = input.timezone ?? profile.timezone ?? "Asia/Shanghai";
  if (!isValidTimeZone(tz)) {
    throw new AppError(422, "INVALID_TIMEZONE", `非法 IANA 时区：${tz}`);
  }
  profile.timezone = tz;

  const extraAssessments: { name: string; raw: Obj }[] = [];
  let initialAssessRecord: Obj | null = null;
  let initialAssessPath: string | null = null;

  if (input.initialAssessment) {
    const rawA: Obj = { ...input.initialAssessment, schema: ASSESS_FORMAT };
    delete rawA.conclusion;
    const draftBundle = {
      profile,
      timeZone: tz,
      sessions: [],
      reviewData: {},
      courses: [],
      assessments: [],
      docs: [],
    };
    const kind = String(rawA.kind ?? "入门");
    initialAssessPath = `评估/${rawA.date}-${kind}.json`;
    const ev = evaluateAssessment(draftBundle, templates, kind, { name: initialAssessPath, raw: rawA }, { now });
    if (ev.error) {
      throw new AppError(422, "ASSESSMENT_INVALID", ev.error);
    }
    const evErrs = onlyErrors(ev.issues);
    if (evErrs.length) {
      throw new AppError(422, "ASSESSMENT_INVALID", "入门评估未通过校验", { issues: ev.issues });
    }
    initialAssessRecord = { ...rawA, conclusion: ev.conclusion ?? {} };
    extraAssessments.push({ name: initialAssessPath, raw: initialAssessRecord });
  }

  const auditIssues = auditProfileForMutation(
    {
      profile,
      timeZone: tz,
      sessions: [],
      reviewData: {},
      courses: [],
      assessments: extraAssessments,
      docs: [],
    },
    templates,
    now,
  );
  const errs = onlyErrors(auditIssues);
  if (errs.length) {
    throw new AppError(422, "PROFILE_VALIDATION_FAILED", "档案未通过规则校验", { issues: auditIssues });
  }

  return withTransaction(db, () => {
    if (input.memberUserId) {
      const m = db.prepare("SELECT id, disabled_at FROM users WHERE id = ?").get(input.memberUserId) as
        | { id: string; disabled_at: string | null }
        | undefined;
      if (!m || m.disabled_at) {
        throw new AppError(404, "MEMBER_NOT_FOUND", "关联的成员账号不存在或已停用");
      }
    }

    const dup = db.prepare("SELECT 1 FROM profiles WHERE code = ?").get(profile.code);
    if (dup) {
      // 通用错误提示，避免探测该代号是否属于其他家庭成员
      throw new AppError(409, "PROFILE_CODE_CONFLICT", "该档案代号不可用，请更换其他代号");
    }

    const id = newId();
    const nowIso = now.toISOString();
    db.prepare(
      `INSERT INTO profiles
        (id, code, owner_user_id, is_managed, member_user_id, timezone, profile_json, version, has_conflict, updated_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?)`,
    ).run(
      id,
      String(profile.code),
      actor.userId,
      isManaged ? 1 : 0,
      isManaged ? (input.memberUserId ?? null) : null,
      tz,
      JSON.stringify(profile),
      nowIso,
      nowIso,
    );

    if (initialAssessRecord && initialAssessPath) {
      db.prepare(
        `INSERT INTO assessments (id, profile_id, kind, assess_date, logical_path, assessment_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        newId(),
        id,
        String(initialAssessRecord.kind),
        String(initialAssessRecord.date),
        initialAssessPath,
        JSON.stringify(initialAssessRecord),
        nowIso,
      );
    }

    writeAuditLog(db, {
      actorUserId: actor.userId,
      actorSessionId: actor.sessionId,
      profileId: id,
      action: "profile.create",
      fields: Object.keys(profile),
      ruleOrReason: isManaged ? "managed_create" : "self_create",
      now,
    });

    return {
      id,
      version: 1,
      profile,
      warnings: onlyWarnings(auditIssues),
    };
  });
}

function isPreEntryOnboarding(bundle: {
  profile: Obj;
  assessments: unknown[];
  sessions: unknown[];
  courses: unknown[];
  reviewData: Record<string, unknown>;
}): boolean {
  const segs = bundle.profile.segments;
  return (
    bundle.assessments.length === 0 &&
    bundle.sessions.length === 0 &&
    bundle.courses.length === 0 &&
    Object.keys(bundle.reviewData).length === 0 &&
    Array.isArray(segs) &&
    segs.length === 1 &&
    segs[0]?.n === 1 &&
    segs[0]?.week === 1 &&
    segs[0]?.phase !== "稳定"
  );
}

export function auditProfileForMutation(
  bundle: Parameters<typeof auditProfileBundle>[0],
  templates: TemplatesSnapshot,
  now: Date,
): Issue[] {
  const issues = auditProfileBundle(
    { ...bundle, courses: bundle.courses.filter((c) => c.archived) },
    templates,
    { now },
  );
  if (!isPreEntryOnboarding(bundle)) return issues;
  return issues.filter((i) => !(i.level === "error" && i.path === "评估/" && i.message.includes("之前要有入门评估")));
}

export interface UpdateProfileInput {
  expectedVersion?: number;
  patch?: Obj;
  replaceProfile?: Obj;
  timezone?: string;
  memberUserId?: string | null;
  ruleOrReason?: string;
}

export function updateProfileOp(
  db: DatabaseSync,
  templates: TemplatesSnapshot,
  actor: AuthActor,
  profileId: string,
  input: UpdateProfileInput,
  now = new Date(),
) {
  return withProfileLock(db, profileId, input.expectedVersion, (meta) => {
    const before = JSON.parse(meta.profile_json) as Obj;
    const candidate: Obj = input.replaceProfile
      ? { ...input.replaceProfile, schema: PROFILE_FORMAT }
      : { ...before, ...(input.patch ?? {}), schema: PROFILE_FORMAT };

    const nextTz = input.timezone ?? candidate.timezone ?? meta.timezone;
    if (!isValidTimeZone(nextTz)) {
      throw new AppError(422, "INVALID_TIMEZONE", `非法 IANA 时区：${nextTz}`);
    }
    candidate.timezone = nextTz;

    if (candidate.code !== meta.code) {
      const dup = db.prepare("SELECT 1 FROM profiles WHERE code = ? AND id != ?").get(candidate.code, profileId);
      if (dup) {
        throw new AppError(409, "PROFILE_CODE_CONFLICT", "该档案代号不可用，请更换其他代号");
      }
    }

    let nextMemberUserId = meta.member_user_id;
    if (input.memberUserId !== undefined) {
      if (meta.is_managed !== 1 || actor.role !== "admin") {
        throw new AppError(403, "FORBIDDEN", "只有管理员可修改代管档案关联成员");
      }
      if (input.memberUserId !== null) {
        const m = db.prepare("SELECT id, disabled_at FROM users WHERE id = ?").get(input.memberUserId) as
          | { id: string; disabled_at: string | null }
          | undefined;
        if (!m || m.disabled_at) {
          throw new AppError(404, "MEMBER_NOT_FOUND", "关联的成员账号不存在或已停用");
        }
      }
      nextMemberUserId = input.memberUserId;
    }

    const state = loadProfileState(db, profileId, { profile: candidate });
    state.bundle.timeZone = nextTz;
    // 在改档案本身的门禁中，旧活跃课程（如刚刚降级或改筛查导致的过重旧课）将由下方 detectInvalidatedCourses 自动作废，
    // 建档后、做入门评估前的初始周允许更新筛查/医生同意/条件，避免 65+ 等需先获医生同意再测入门的死锁；
    // 其余全部规则（格式、条件、医生同意日期结构、进度、文档红线等）仍 100% 强制执行。
    const auditIssues = auditProfileForMutation(state.bundle, templates, now);
    const errs = onlyErrors(auditIssues);
    if (errs.length) {
      throw new AppError(422, "PROFILE_VALIDATION_FAILED", "档案更新未通过规则校验", { issues: auditIssues });
    }

    const nowIso = now.toISOString();
    const nextVersion = meta.version + 1;
    db.prepare(
      `UPDATE profiles
       SET code = ?, member_user_id = ?, timezone = ?, profile_json = ?, version = ?, has_conflict = 0, conflict_json = NULL, updated_at = ?
       WHERE id = ?`,
    ).run(String(candidate.code), nextMemberUserId, nextTz, JSON.stringify(candidate), nextVersion, nowIso, profileId);

    const invalidatedCourses = invalidateAffectedCoursesInTx(db, profileId, templates, now);
    const changedFields = diffTopKeys(before, candidate);

    writeAuditLog(db, {
      actorUserId: actor.userId,
      actorSessionId: actor.sessionId,
      profileId,
      action: "profile.update",
      fields: changedFields,
      ruleOrReason: "profile_update",
      now,
    });

    return {
      id: profileId,
      version: nextVersion,
      profile: candidate,
      invalidatedCourses,
      warnings: onlyWarnings(auditIssues),
    };
  });
}

/** 专供移动端与青少年/代管成员修改档案级播放偏好（只允许改 playback 三字段，受安全下限约束）。 */
export function updatePlaybackOp(
  db: DatabaseSync,
  actor: AuthActor,
  profileId: string,
  input: {
    expectedVersion?: number;
    playback: { breathLead?: number | "all"; breathAfter?: "quiet" | "pluck"; countTiming?: "on-up" | "on-rep" };
  },
  now = new Date(),
) {
  return withProfileLock(db, profileId, input.expectedVersion, (meta) => {
    const profile = JSON.parse(meta.profile_json) as Obj;
    const prev = (profile.playback && typeof profile.playback === "object" ? profile.playback : {}) as Obj;
    const nextPlayback: Obj = { ...prev };
    if (input.playback.breathLead !== undefined) nextPlayback.breathLead = input.playback.breathLead;
    if (input.playback.breathAfter !== undefined) nextPlayback.breathAfter = input.playback.breathAfter;
    if (input.playback.countTiming !== undefined) nextPlayback.countTiming = input.playback.countTiming;

    const candidate = { ...profile, playback: nextPlayback };
    const allPbIssues = validateProfile(candidate, { now, timeZone: meta.timezone }).filter((i) =>
      i.path.startsWith("playback"),
    );
    const pbErrors = onlyErrors(allPbIssues);
    if (pbErrors.length) {
      throw new AppError(422, "PLAYBACK_INVALID", "播放偏好不合规", { issues: pbErrors });
    }

    const nowIso = now.toISOString();
    const nextVersion = meta.version + 1;
    db.prepare("UPDATE profiles SET profile_json = ?, version = ?, updated_at = ? WHERE id = ?").run(
      JSON.stringify(candidate),
      nextVersion,
      nowIso,
      profileId,
    );

    writeAuditLog(db, {
      actorUserId: actor.userId,
      actorSessionId: actor.sessionId,
      profileId,
      action: "profile.playback_update",
      fields: Object.keys(input.playback).map((k) => `playback.${k}`),
      ruleOrReason: "playback_prefs",
      now,
    });

    return {
      version: nextVersion,
      playback: nextPlayback,
      warnings: onlyWarnings(allPbIssues),
    };
  });
}

export interface SubmitAssessmentInput {
  expectedVersion?: number;
  record: Obj;
  logicalPath?: string;
}

export function submitAssessmentOp(
  db: DatabaseSync,
  templates: TemplatesSnapshot,
  actor: AuthActor,
  profileId: string,
  input: SubmitAssessmentInput,
  now = new Date(),
) {
  return withProfileLock(db, profileId, input.expectedVersion, (meta) => {
    const state = loadProfileState(db, profileId);
    const rawRecord: Obj = { ...input.record, schema: ASSESS_FORMAT };
    delete rawRecord.conclusion;
    const kind = String(rawRecord.kind ?? "");
    const logicalPath = uniqueAssessmentPath(db, profileId, String(rawRecord.date ?? ""), kind, input.logicalPath);
    const ev = evaluateAssessment(state.bundle, templates, kind, { name: logicalPath, raw: rawRecord }, { now });
    if (ev.error) {
      throw new AppError(422, "ASSESSMENT_VALIDATION_FAILED", ev.error);
    }
    const errs = onlyErrors(ev.issues);
    if (errs.length) {
      throw new AppError(422, "ASSESSMENT_VALIDATION_FAILED", "评估记录未通过校验", { issues: ev.issues });
    }

    const finalRecord: Obj = { ...rawRecord, conclusion: ev.conclusion ?? {} };
    const nextState = loadProfileState(db, profileId, {
      extraAssessments: [{ name: logicalPath, raw: finalRecord }],
    });
    const fullAudit = auditProfileBundle(
      { ...nextState.bundle, courses: nextState.bundle.courses.filter((c) => c.archived) },
      templates,
      { now },
    );
    const fullErrs = onlyErrors(fullAudit);
    if (fullErrs.length) {
      throw new AppError(422, "ASSESSMENT_VALIDATION_FAILED", "评估记录与档案整体规则冲突", { issues: fullAudit });
    }

    const id = newId();
    const nowIso = now.toISOString();
    const nextVersion = meta.version + 1;
    db.prepare(
      `INSERT INTO assessments (id, profile_id, kind, assess_date, logical_path, assessment_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      profileId,
      String(finalRecord.kind),
      String(finalRecord.date),
      logicalPath,
      JSON.stringify(finalRecord),
      nowIso,
    );
    db.prepare(
      "UPDATE profiles SET version = ?, has_conflict = 0, conflict_json = NULL, updated_at = ? WHERE id = ?",
    ).run(nextVersion, nowIso, profileId);

    const invalidatedCourses = invalidateAffectedCoursesInTx(db, profileId, templates, now);
    writeAuditLog(db, {
      actorUserId: actor.userId,
      actorSessionId: actor.sessionId,
      profileId,
      action: "assessment.submit",
      fields: ["assessments", String(finalRecord.kind)],
      ruleOrReason: `assess:${String(finalRecord.kind)}`,
      now,
    });

    return {
      id,
      logicalPath,
      assessment: finalRecord,
      version: nextVersion,
      invalidatedCourses,
      warnings: onlyWarnings([...ev.issues, ...fullAudit]),
    };
  });
}

export interface SubmitReviewInput {
  expectedVersion?: number;
  startDate: string;
  week: number;
  reviewJson: Obj;
  reviewMd: string;
  nextSegmentEntry?: Obj;
  profilePatch?: Obj;
}

export function submitReviewOp(
  db: DatabaseSync,
  templates: TemplatesSnapshot,
  actor: AuthActor,
  profileId: string,
  input: SubmitReviewInput,
  now = new Date(),
) {
  return withProfileLock(db, profileId, input.expectedVersion, (meta) => {
    const beforeProfile = JSON.parse(meta.profile_json) as Obj;
    const safePatch: Obj = input.profilePatch ? { ...input.profilePatch } : {};
    // 禁止通过复盘附带 patch 修改档案元标识字段，避免与 profiles 表列漂移
    delete safePatch.schema;
    delete safePatch.code;
    delete safePatch.timezone;
    const candidateProfile: Obj = { ...beforeProfile, ...safePatch, schema: PROFILE_FORMAT };
    if (input.nextSegmentEntry) {
      const baseSegs = Array.isArray(candidateProfile.segments) ? candidateProfile.segments : [];
      candidateProfile.segments = [...baseSegs, input.nextSegmentEntry];
    }

    const segMatch = (Array.isArray(beforeProfile.segments) ? beforeProfile.segments : []).find(
      (s: Obj) => s.start === input.startDate && s.week === input.week,
    );
    const segmentNum = segMatch?.n ?? currentSegment(beforeProfile)?.n ?? 1;

    const reviewJson: Obj = {
      ...input.reviewJson,
      schema: REVIEW_FORMAT,
      start: input.startDate,
      week: input.week,
    };
    const segRef = { start: input.startDate, week: input.week };
    const legacyJsonPath = `复盘/${reviewDataName(segRef)}`;
    const legacyMdPath = `复盘/${reviewName(segRef)}`;

    const state = loadProfileState(db, profileId, {
      profile: candidateProfile,
      extraReviews: [
        {
          startDate: input.startDate,
          week: input.week,
          json: reviewJson,
          md: input.reviewMd,
          legacyJsonPath,
          legacyMdPath,
        },
      ],
    });
    const auditIssues = auditProfileBundle(
      { ...state.bundle, courses: state.bundle.courses.filter((c) => c.archived) },
      templates,
      { now },
    );
    const errs = onlyErrors(auditIssues);
    if (errs.length) {
      throw new AppError(422, "REVIEW_VALIDATION_FAILED", "周复盘或推进下一周未通过校验", { issues: auditIssues });
    }

    const nowIso = now.toISOString();
    const existing = db
      .prepare("SELECT id FROM reviews WHERE profile_id = ? AND segment = ? AND week = ? AND start_date = ?")
      .get(profileId, segmentNum, input.week, input.startDate) as { id: string } | undefined;
    const reviewId = existing?.id ?? newId();

    if (existing) {
      db.prepare(
        `UPDATE reviews SET review_json = ?, review_md = ?, legacy_json_path = ?, legacy_md_path = ?, updated_at = ?
         WHERE id = ?`,
      ).run(JSON.stringify(reviewJson), input.reviewMd, legacyJsonPath, legacyMdPath, nowIso, reviewId);
    } else {
      db.prepare(
        `INSERT INTO reviews
          (id, profile_id, segment, week, start_date, legacy_json_path, legacy_md_path, review_json, review_md, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        reviewId,
        profileId,
        segmentNum,
        input.week,
        input.startDate,
        legacyJsonPath,
        legacyMdPath,
        JSON.stringify(reviewJson),
        input.reviewMd,
        nowIso,
        nowIso,
      );
    }

    const nextVersion = meta.version + 1;
    db.prepare(
      "UPDATE profiles SET profile_json = ?, version = ?, has_conflict = 0, conflict_json = NULL, updated_at = ? WHERE id = ?",
    ).run(JSON.stringify(candidateProfile), nextVersion, nowIso, profileId);

    const invalidatedCourses = invalidateAffectedCoursesInTx(db, profileId, templates, now);
    writeAuditLog(db, {
      actorUserId: actor.userId,
      actorSessionId: actor.sessionId,
      profileId,
      action: input.nextSegmentEntry ? "review.submit_and_advance" : "review.submit",
      fields: input.nextSegmentEntry ? ["reviews", "segments"] : ["reviews"],
      ruleOrReason: `seg${segmentNum}-w${input.week}`,
      now,
    });

    return {
      id: reviewId,
      version: nextVersion,
      reviewJson,
      profile: candidateProfile,
      invalidatedCourses,
      warnings: onlyWarnings(auditIssues),
    };
  });
}

export function generatePlanSheetOp(
  db: DatabaseSync,
  templates: TemplatesSnapshot,
  actor: AuthActor,
  profileId: string,
  expectedVersion?: number,
  now = new Date(),
) {
  return withProfileLock(db, profileId, expectedVersion, (meta) => {
    const state = loadProfileState(db, profileId);
    const res = generateProfileSheet(state.bundle, templates, { now });
    const errs = onlyErrors(res.issues);
    if (errs.length || !res.text || !res.file) {
      throw new AppError(422, "SHEET_GENERATION_FAILED", "无法生成个人计划单", { issues: res.issues });
    }

    const seg = currentSegment(state.bundle.profile);
    const weekStart = currentWeekStart(state.bundle.profile);
    const nowIso = now.toISOString();
    const existing = db
      .prepare("SELECT id, week_start FROM documents WHERE profile_id = ? AND legacy_path = ?")
      .get(profileId, res.file) as { id: string; week_start: string | null } | undefined;

    // 若同段同周次为重复周（week_start 改变），先把旧周的计划单重命名标只读归档保留，再写入最新一周
    if (existing && existing.week_start && weekStart && existing.week_start !== weekStart) {
      const oldStem = res.file.replace(/\.md$/i, "");
      const oldPath = `${oldStem}-${existing.week_start}.md`;
      db.prepare("UPDATE documents SET legacy_path = ?, readonly_legacy = 1, updated_at = ? WHERE id = ?").run(
        oldPath,
        nowIso,
        existing.id,
      );
    }

    const existingSame = db
      .prepare("SELECT id FROM documents WHERE profile_id = ? AND legacy_path = ?")
      .get(profileId, res.file) as { id: string } | undefined;
    const docId = existingSame?.id ?? newId();
    const title = res.file.replace(/^计划\//, "").replace(/\.md$/i, "");

    if (existingSame) {
      db.prepare(
        `UPDATE documents
         SET title = ?, segment = ?, week = ?, week_start = ?, readonly_legacy = 0, content_md = ?, template_version = ?, updated_at = ?
         WHERE id = ?`,
      ).run(title, seg?.n ?? null, seg?.week ?? null, weekStart, res.text, templates.version, nowIso, docId);
    } else {
      db.prepare(
        `INSERT INTO documents
          (id, profile_id, doc_type, title, segment, week, week_start, legacy_path, readonly_legacy, content_md, template_version, created_at, updated_at)
         VALUES (?, ?, 'plan', ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
      ).run(
        docId,
        profileId,
        title,
        seg?.n ?? null,
        seg?.week ?? null,
        weekStart,
        res.file,
        res.text,
        templates.version,
        nowIso,
        nowIso,
      );
    }

    const nextVersion = meta.version + 1;
    db.prepare("UPDATE profiles SET version = ?, updated_at = ? WHERE id = ?").run(nextVersion, nowIso, profileId);

    writeAuditLog(db, {
      actorUserId: actor.userId,
      actorSessionId: actor.sessionId,
      profileId,
      action: "plan_sheet.generate",
      fields: ["documents.plan"],
      ruleOrReason: res.file,
      now,
    });

    return {
      id: docId,
      file: res.file,
      contentMd: res.text,
      version: nextVersion,
      warnings: onlyWarnings(res.issues),
    };
  });
}

export function saveDocumentOp(
  db: DatabaseSync,
  templates: TemplatesSnapshot,
  actor: AuthActor,
  profileId: string,
  input: {
    expectedVersion?: number;
    docType: "menu" | "monthly_summary";
    title: string;
    contentMd: string;
  },
  now = new Date(),
) {
  return withProfileLock(db, profileId, input.expectedVersion, (meta) => {
    const cleanTitle = input.title.trim().replace(/[/\\]+/g, "-").slice(0, 80);
    if (!cleanTitle) throw new AppError(400, "INVALID_TITLE", "文档标题不能为空");
    const legacyPath = input.docType === "monthly_summary" ? "复盘/月度总结.md" : `菜单/${cleanTitle}.md`;

    const state = loadProfileState(db, profileId, {
      extraDocs: [{ name: legacyPath, text: input.contentMd, kind: input.docType }],
    });
    const auditIssues = auditProfileBundle(
      { ...state.bundle, courses: state.bundle.courses.filter((c) => c.archived) },
      templates,
      { now },
    );
    const errs = onlyErrors(auditIssues);
    if (errs.length) {
      throw new AppError(422, "DOCUMENT_VALIDATION_FAILED", "文档未通过免责声明或安全红线校验", { issues: auditIssues });
    }

    const seg = currentSegment(state.bundle.profile);
    const weekStart = currentWeekStart(state.bundle.profile);
    const nowIso = now.toISOString();
    const existing = db
      .prepare("SELECT id FROM documents WHERE profile_id = ? AND legacy_path = ?")
      .get(profileId, legacyPath) as { id: string } | undefined;
    const docId = existing?.id ?? newId();

    if (existing) {
      db.prepare(
        "UPDATE documents SET title = ?, segment = ?, week = ?, content_md = ?, template_version = ?, updated_at = ? WHERE id = ?",
      ).run(cleanTitle, seg?.n ?? null, seg?.week ?? null, input.contentMd, templates.version, nowIso, docId);
    } else {
      db.prepare(
        `INSERT INTO documents
          (id, profile_id, doc_type, title, segment, week, week_start, legacy_path, readonly_legacy, content_md, template_version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
      ).run(
        docId,
        profileId,
        input.docType,
        cleanTitle,
        seg?.n ?? null,
        seg?.week ?? null,
        weekStart,
        legacyPath,
        input.contentMd,
        templates.version,
        nowIso,
        nowIso,
      );
    }

    const nextVersion = meta.version + 1;
    db.prepare("UPDATE profiles SET version = ?, updated_at = ? WHERE id = ?").run(nextVersion, nowIso, profileId);
    writeAuditLog(db, {
      actorUserId: actor.userId,
      actorSessionId: actor.sessionId,
      profileId,
      action: `document.save_${input.docType}`,
      fields: [`documents.${input.docType}`],
      ruleOrReason: input.docType === "menu" ? "doc_menu" : "doc_monthly_summary",
      now,
    });

    return {
      id: docId,
      legacyPath,
      version: nextVersion,
      warnings: onlyWarnings(auditIssues),
    };
  });
}

export interface PublishCourseInput {
  expectedVersion?: number;
  week: number;
  day: string;
  picks?: Record<string, string>;
  half?: boolean;
  confirmedNoFall?: boolean;
}

export function publishCourseOp(
  db: DatabaseSync,
  templates: TemplatesSnapshot,
  actor: AuthActor,
  profileId: string,
  input: PublishCourseInput,
  now = new Date(),
) {
  return withProfileLock(db, profileId, input.expectedVersion, (meta) => {
    if (meta.has_conflict === 1) {
      const conflict = meta.conflict_json ? JSON.parse(meta.conflict_json) : null;
      throw new AppError(
        409,
        "PROFILE_CONFLICT_UNRESOLVED",
        "存在未处理的迟到练习记录冲突（可能影响复盘或安全判断），请先核对并修正周复盘后再排课",
        { conflict },
      );
    }

    const state = loadProfileState(db, profileId);
    if (state.bundle.profile.age === "a65" && input.confirmedNoFall !== true) {
      throw new AppError(
        400,
        "CONFIRM_NO_FALL_REQUIRED",
        "65 岁以上发布课程前请先确认：上次练完后没有摔倒、差点摔倒或头晕（confirmedNoFall: true）",
      );
    }

    const exp = exportProfileCourse(state.bundle, templates, {
      week: input.week,
      day: input.day,
      picks: input.picks,
      half: input.half,
      now,
    });
    const errs = onlyErrors(exp.issues);
    if (errs.length || !exp.course || !exp.envelope) {
      throw new AppError(422, "COURSE_EXPORT_BLOCKED", "课程未通过安全或规则门禁，无法发布", {
        issues: exp.issues,
      });
    }

    const seg = currentSegment(state.bundle.profile);
    const segN = seg?.n ?? 1;
    const halfInt = input.half ? 1 : 0;
    const halfTag = input.half ? "-半量" : "";
    const legacyPath = `课程/第${segN}段-第${input.week}周-${input.day}日${halfTag}.json`;
    const snapshotHash = sha256Hex(JSON.stringify(exp.envelope));
    const nowIso = now.toISOString();
    const recordId = newId();

    // 同一 (profile_id, segment, week, day, half) 的旧活跃课先标 superseded，满足部分唯一索引
    db.prepare(
      `UPDATE courses
       SET status = 'superseded', updated_at = ?
       WHERE profile_id = ? AND segment = ? AND week = ? AND day = ? AND half = ? AND status = 'active'`,
    ).run(nowIso, profileId, segN, input.week, input.day, halfInt);

    db.prepare(
      `INSERT INTO courses
        (id, profile_id, course_id, segment, week, day, half, status, legacy_path, course_json, follow_json, notes_json,
         template_version, template_hash, motion_hashes_json, snapshot_hash, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      recordId,
      profileId,
      exp.course.id,
      segN,
      input.week,
      input.day,
      halfInt,
      legacyPath,
      JSON.stringify(exp.course),
      JSON.stringify(exp.follow),
      JSON.stringify(exp.notes),
      exp.envelope.templateVersion,
      exp.envelope.templateHash,
      JSON.stringify(exp.envelope.motionHashes),
      snapshotHash,
      nowIso,
      nowIso,
    );

    const nextVersion = meta.version + 1;
    db.prepare("UPDATE profiles SET version = ?, updated_at = ? WHERE id = ?").run(nextVersion, nowIso, profileId);

    writeAuditLog(db, {
      actorUserId: actor.userId,
      actorSessionId: actor.sessionId,
      profileId,
      action: "course.publish",
      fields: ["courses", `seg${segN}`, `w${input.week}`, input.day, ...(input.half ? ["half"] : [])],
      ruleOrReason: `templates:${exp.envelope.templateVersion}`,
      now,
    });

    return {
      id: recordId,
      snapshotHash,
      version: nextVersion,
      envelope: exp.envelope,
      warnings: onlyWarnings(exp.issues),
    };
  });
}

export function invalidateCourseOp(
  db: DatabaseSync,
  actor: AuthActor,
  profileId: string,
  courseRecordId: string,
  reason: string,
  expectedVersion?: number,
  now = new Date(),
) {
  return withProfileLock(db, profileId, expectedVersion, (meta) => {
    const row = db
      .prepare("SELECT id, status FROM courses WHERE id = ? AND profile_id = ?")
      .get(courseRecordId, profileId) as { id: string; status: string } | undefined;
    if (!row) throw new AppError(404, "COURSE_NOT_FOUND", "找不到对应课程");

    const nowIso = now.toISOString();
    const cleanReason = reason.trim().slice(0, 200) || "管理员手动撤回";
    db.prepare(
      "UPDATE courses SET status = 'invalidated', invalidated_reason = ?, updated_at = ? WHERE id = ?",
    ).run(cleanReason, nowIso, courseRecordId);

    const nextVersion = meta.version + 1;
    db.prepare("UPDATE profiles SET version = ?, updated_at = ? WHERE id = ?").run(nextVersion, nowIso, profileId);
    writeAuditLog(db, {
      actorUserId: actor.userId,
      actorSessionId: actor.sessionId,
      profileId,
      action: "course.invalidate",
      fields: ["courses.status"],
      ruleOrReason: "manual_invalidate",
      now,
    });
    return { id: courseRecordId, version: nextVersion, status: "invalidated" as const, reason: cleanReason };
  });
}

export function archiveSegmentOp(
  db: DatabaseSync,
  templates: TemplatesSnapshot,
  actor: AuthActor,
  profileId: string,
  segmentNumber: number,
  expectedVersion?: number,
  now = new Date(),
) {
  return withProfileLock(db, profileId, expectedVersion, (meta) => {
    const profile = JSON.parse(meta.profile_json) as Obj;
    const curSeg = currentSegment(profile)?.n ?? 1;
    if (!Number.isInteger(segmentNumber) || segmentNumber < 1 || segmentNumber >= curSeg) {
      throw new AppError(
        422,
        "INVALID_ARCHIVE_SEGMENT",
        `只能归档小于当前第 ${curSeg} 段的已完成历史段（1–${Math.max(1, curSeg - 1)}）`,
      );
    }

    const prefix = `历史/第${segmentNumber}段/`;
    const addPrefix = (p: string | null, fallback: string) => {
      const base = p || fallback;
      return base.startsWith("历史/") ? base : `${prefix}${base}`;
    };
    const nowIso = now.toISOString();

    // 1. 归档课程
    const courses = db
      .prepare("SELECT id, legacy_path, week, day, half FROM courses WHERE profile_id = ? AND segment = ? AND archived_segment IS NULL")
      .all(profileId, segmentNumber) as { id: string; legacy_path: string | null; week: number; day: string; half: number }[];
    for (const c of courses) {
      const fallback = `课程/第${segmentNumber}段-第${c.week}周-${c.day}日${c.half ? "-半量" : ""}.json`;
      db.prepare(
        "UPDATE courses SET status = 'archived', archived_segment = ?, legacy_path = ?, updated_at = ? WHERE id = ?",
      ).run(segmentNumber, addPrefix(c.legacy_path, fallback), nowIso, c.id);
    }

    // 2. 归档该段练习记录（按 session.course.source.segment === segmentNumber）
    const sessRows = db
      .prepare("SELECT id, legacy_path, session_json FROM workout_sessions WHERE profile_id = ? AND archived_segment IS NULL")
      .all(profileId) as { id: string; legacy_path: string | null; session_json: string }[];
    for (const s of sessRows) {
      const raw = JSON.parse(s.session_json) as Obj;
      if (raw?.course?.source?.segment === segmentNumber) {
        db.prepare(
          "UPDATE workout_sessions SET archived_segment = ?, legacy_path = ?, updated_at = ? WHERE id = ?",
        ).run(segmentNumber, addPrefix(s.legacy_path, `打卡/${s.id}.json`), nowIso, s.id);
      }
    }

    // 3. 归档复盘
    const revRows = db
      .prepare("SELECT id, week, start_date, legacy_json_path, legacy_md_path FROM reviews WHERE profile_id = ? AND segment = ? AND archived_segment IS NULL")
      .all(profileId, segmentNumber) as { id: string; week: number; start_date: string; legacy_json_path: string | null; legacy_md_path: string | null }[];
    for (const r of revRows) {
      const segRef = { start: r.start_date, week: r.week };
      db.prepare(
        "UPDATE reviews SET archived_segment = ?, legacy_json_path = ?, legacy_md_path = ?, updated_at = ? WHERE id = ?",
      ).run(
        segmentNumber,
        addPrefix(r.legacy_json_path, `复盘/${reviewDataName(segRef)}`),
        addPrefix(r.legacy_md_path, `复盘/${reviewName(segRef)}`),
        nowIso,
        r.id,
      );
    }

    // 4. 归档文档
    const docRows = db
      .prepare("SELECT id, legacy_path FROM documents WHERE profile_id = ? AND segment = ? AND archived_segment IS NULL")
      .all(profileId, segmentNumber) as { id: string; legacy_path: string }[];
    for (const d of docRows) {
      db.prepare(
        "UPDATE documents SET archived_segment = ?, legacy_path = ?, updated_at = ? WHERE id = ?",
      ).run(segmentNumber, addPrefix(d.legacy_path, d.legacy_path), nowIso, d.id);
    }

    // 5. 归档属于该段的段末/周期末评估
    const assessRows = db
      .prepare("SELECT id, logical_path, assessment_json FROM assessments WHERE profile_id = ? AND archived_segment IS NULL")
      .all(profileId) as { id: string; logical_path: string; assessment_json: string }[];
    for (const a of assessRows) {
      const raw = JSON.parse(a.assessment_json) as Obj;
      if (raw?.segment === segmentNumber) {
        db.prepare("UPDATE assessments SET archived_segment = ?, logical_path = ? WHERE id = ?").run(
          segmentNumber,
          addPrefix(a.logical_path, a.logical_path),
          a.id,
        );
      }
    }

    const afterState = loadProfileState(db, profileId);
    const auditIssues = auditProfileBundle(afterState.bundle, templates, { now });
    const errs = onlyErrors(auditIssues);
    if (errs.length) {
      throw new AppError(422, "ARCHIVE_VALIDATION_FAILED", "段归档后档案校验未通过，已回滚", { issues: auditIssues });
    }

    const nextVersion = meta.version + 1;
    db.prepare("UPDATE profiles SET version = ?, updated_at = ? WHERE id = ?").run(nextVersion, nowIso, profileId);
    writeAuditLog(db, {
      actorUserId: actor.userId,
      actorSessionId: actor.sessionId,
      profileId,
      action: "segment.archive",
      fields: ["courses", "workout_sessions", "reviews", "documents", "assessments"],
      ruleOrReason: `archive_seg_${segmentNumber}`,
      now,
    });

    return { archivedSegment: segmentNumber, version: nextVersion };
  });
}

export interface SubmitMobileSessionInput {
  session: Obj;
  idempotencyKey?: string;
  courseRecordId?: string;
  courseSnapshotHash?: string;
  replace?: boolean;
}

export interface SubmitMobileSessionResult {
  status: "accepted" | "duplicate" | "replaced" | "clock_skew_future";
  id?: string;
  legacyPath?: string;
  staleCourse?: boolean;
  hasConflict?: boolean;
  invalidatedCourses?: InvalidatedCourse[];
  serverNow?: string;
  reason?: string;
}

export function submitMobileSessionOp(
  db: DatabaseSync,
  templates: TemplatesSnapshot,
  actor: AuthActor,
  profileId: string,
  input: SubmitMobileSessionInput,
  now = new Date(),
): SubmitMobileSessionResult {
  return withProfileLock(db, profileId, undefined, (meta) => {
    // 1. 幂等键命中检查
    if (input.idempotencyKey) {
      const byKey = db
        .prepare("SELECT id, legacy_path, stale_course FROM workout_sessions WHERE profile_id = ? AND idempotency_key = ?")
        .get(profileId, input.idempotencyKey) as { id: string; legacy_path: string | null; stale_course: number } | undefined;
      if (byKey && !input.replace) {
        return {
          status: "duplicate",
          id: byKey.id,
          legacyPath: byKey.legacy_path ?? undefined,
          staleCourse: byKey.stale_course === 1,
          hasConflict: meta.has_conflict === 1,
          invalidatedCourses: [],
        };
      }
    }

    const state = loadProfileState(db, profileId);
    const prep = prepareSessionImport(state.bundle, input.session, {
      replace: input.replace === true,
      now,
    });

    if (prep.status === "clock_skew_future") {
      return {
        status: "clock_skew_future",
        serverNow: prep.serverNow ?? now.toISOString(),
        reason: prep.reason ?? "练习时间晚于服务器当前时间超过 5 分钟，请检查手机时间",
      };
    }

    if (prep.status === "rejected") {
      throw new AppError(422, "SESSION_REJECTED", prep.reason ?? "练习记录校验未通过", {
        issues: prep.validationIssues,
        diffFields: prep.diff,
      });
    }

    if (prep.status === "duplicate") {
      const existing = (prep.replaceTarget
        ? db
            .prepare("SELECT id, legacy_path, stale_course FROM workout_sessions WHERE profile_id = ? AND legacy_path = ?")
            .get(profileId, prep.replaceTarget)
        : db
            .prepare("SELECT id, legacy_path, stale_course FROM workout_sessions WHERE profile_id = ? AND course_id = ? AND started_at = ?")
            .get(profileId, String(input.session?.course?.id ?? ""), String(input.session?.startedAt ?? ""))) as
        | { id: string; legacy_path: string | null; stale_course: number }
        | undefined;
      return {
        status: "duplicate",
        id: existing?.id,
        legacyPath: existing?.legacy_path ?? prep.replaceTarget,
        staleCourse: existing?.stale_course === 1,
        hasConflict: meta.has_conflict === 1,
        invalidatedCourses: [],
      };
    }

    const isReplace = !!prep.replaceTarget;
    const normalized = prep.record!;
    const courseObj = normalized.course as Obj;
    const src = (courseObj?.source ?? {}) as Obj;
    const courseId = String(courseObj.id);
    const startedAt = String(normalized.startedAt);
    const endedAt = typeof normalized.endedAt === "string" ? normalized.endedAt : null;
    const sym = (normalized.symptoms ?? {}) as Obj;
    const hasSymptoms = sym.pain === true || sym.dizzy === true || sym.chest === true ? 1 : 0;
    const edited = normalized.edited === true ? 1 : 0;

    // 2. 服务端权威比对 course_snapshot_hash 与课程状态（含 invalidated 与 superseded）判定 stale_course
    let courseRecord: CourseDbRow | undefined;
    if (input.courseRecordId) {
      courseRecord = db
        .prepare("SELECT * FROM courses WHERE id = ? AND profile_id = ?")
        .get(input.courseRecordId, profileId) as CourseDbRow | undefined;
    }
    if (!courseRecord) {
      courseRecord = db
        .prepare(
          "SELECT * FROM courses WHERE profile_id = ? AND course_id = ? ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END, updated_at DESC LIMIT 1",
        )
        .get(profileId, courseId) as CourseDbRow | undefined;
    }

    let staleCourse = 0;
    if (courseRecord) {
      if (courseRecord.status !== "active") staleCourse = 1;
      const activeSame = db
        .prepare(
          "SELECT snapshot_hash FROM courses WHERE profile_id = ? AND segment = ? AND week = ? AND day = ? AND half = ? AND status = 'active'",
        )
        .get(profileId, src.segment ?? courseRecord.segment, src.week ?? courseRecord.week, src.day ?? courseRecord.day, src.half ? 1 : 0) as
        | { snapshot_hash: string }
        | undefined;
      if (input.courseSnapshotHash) {
        if (!activeSame || activeSame.snapshot_hash !== input.courseSnapshotHash) staleCourse = 1;
      }
    } else if (input.courseSnapshotHash) {
      const matched = db
        .prepare("SELECT status FROM courses WHERE profile_id = ? AND snapshot_hash = ? LIMIT 1")
        .get(profileId, input.courseSnapshotHash) as { status: string } | undefined;
      if (matched && matched.status !== "active") staleCourse = 1;
    }

    const nowIso = now.toISOString();
    let sessionId: string;
    let legacyPath: string;

    if (isReplace) {
      // 按 prepareSessionImport 匹配到的逻辑路径定位原记录（兼容 Z / .000Z / +08:00 等价时间戳）
      const existing = db
        .prepare("SELECT id, legacy_path FROM workout_sessions WHERE profile_id = ? AND legacy_path = ?")
        .get(profileId, prep.replaceTarget!) as { id: string; legacy_path: string | null } | undefined;
      if (!existing) throw new AppError(404, "SESSION_NOT_FOUND", "要替换的原练习记录不存在");
      sessionId = existing.id;
      legacyPath = existing.legacy_path ?? uniqueSessionPath(db, profileId, prep.suggestedName ?? `打卡/${sessionId}.json`);
      // 防 replace 时 idempotencyKey 与另一条记录碰撞触发 UNIQUE 500
      if (input.idempotencyKey) {
        const keyOwner = db
          .prepare("SELECT id FROM workout_sessions WHERE profile_id = ? AND idempotency_key = ?")
          .get(profileId, input.idempotencyKey) as { id: string } | undefined;
        if (keyOwner && keyOwner.id !== sessionId) {
          throw new AppError(409, "IDEMPOTENCY_KEY_CONFLICT", "幂等键已被其他练习记录占用");
        }
      }
      db.prepare(
        `UPDATE workout_sessions
         SET course_record_id = ?, course_snapshot_hash = ?, idempotency_key = COALESCE(?, idempotency_key),
             ended_at = ?, has_symptoms = ?, edited = ?, stale_course = ?, session_json = ?, updated_at = ?
         WHERE id = ?`,
      ).run(
        courseRecord?.id ?? null,
        input.courseSnapshotHash ?? courseRecord?.snapshot_hash ?? null,
        input.idempotencyKey ?? null,
        endedAt,
        hasSymptoms,
        edited,
        staleCourse,
        JSON.stringify(normalized),
        nowIso,
        sessionId,
      );
    } else {
      sessionId = newId();
      legacyPath = uniqueSessionPath(db, profileId, prep.suggestedName!);
      db.prepare(
        `INSERT INTO workout_sessions
          (id, profile_id, course_record_id, course_id, course_snapshot_hash, idempotency_key,
           started_at, ended_at, has_symptoms, edited, stale_course, legacy_path, session_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        sessionId,
        profileId,
        courseRecord?.id ?? null,
        courseId,
        input.courseSnapshotHash ?? courseRecord?.snapshot_hash ?? null,
        input.idempotencyKey ?? null,
        startedAt,
        endedAt,
        hasSymptoms,
        edited,
        staleCourse,
        legacyPath,
        JSON.stringify(normalized),
        nowIso,
        nowIso,
      );
    }

    // 3. 落库后安全联动：
    //    (a) 完整复用 collectProgressIssues（覆盖周复盘、进度日志、评估、目标、65+ 加项）检测所有冲突；
    //    (b) 若本次记录含不适（含迟到不适！）或触发任意规则冲突，立即强制作废所有在本次入库前已发布的活跃课！
    const postState = loadProfileState(db, profileId);
    const conflictIssues = onlyErrors(collectProgressIssues(postState.bundle, templates, { now }));

    const invalidatedMap = new Map<string, InvalidatedCourse>();
    if (hasSymptoms === 1 || conflictIssues.length > 0) {
      const reason =
        hasSymptoms === 1
          ? "新同步的练习记录出现疼痛、头晕或胸闷，此前发布的活跃课程已作废，请核对复盘后再重新发布"
          : "迟到练习记录触发规则或复盘冲突，此前发布的活跃课程已作废，请核对复盘后再重新发布";
      for (const ac of postState.activeCourseRows) {
        if (ac.created_at <= nowIso) {
          db.prepare(
            "UPDATE courses SET status = 'invalidated', invalidated_reason = ?, updated_at = ? WHERE id = ? AND status = 'active'",
          ).run(reason, nowIso, ac.id);
          invalidatedMap.set(ac.id, { name: ac.legacy_path ?? ac.id, courseId: ac.course_id, reason });
        }
      }
    }
    for (const inv of invalidateAffectedCoursesInTx(db, profileId, templates, now)) {
      if (![...invalidatedMap.values()].some((x) => x.name === inv.name)) {
        invalidatedMap.set(inv.name, inv);
      }
    }
    const invalidatedCourses = [...invalidatedMap.values()];

    const hasConflict = conflictIssues.length > 0 ? 1 : meta.has_conflict;
    const conflictJson =
      conflictIssues.length > 0
        ? JSON.stringify({
            kind: "late_session_conflict",
            sessionId,
            staleCourse: staleCourse === 1,
            detectedAt: nowIso,
            issues: conflictIssues.map((i) => ({ path: i.path, message: i.message })),
          })
        : meta.conflict_json;

    db.prepare("UPDATE profiles SET version = version + 1, has_conflict = ?, conflict_json = ?, updated_at = ? WHERE id = ?").run(
      hasConflict,
      conflictJson,
      nowIso,
      profileId,
    );

    writeAuditLog(db, {
      actorUserId: actor.userId,
      actorSessionId: actor.sessionId,
      profileId,
      action: isReplace ? "session.replace" : "session.submit",
      fields: ["workout_sessions", ...(hasSymptoms ? ["symptoms"] : []), ...(staleCourse ? ["stale_course"] : [])],
      ruleOrReason: hasConflict ? "conflict_flagged" : "session_saved",
      now,
    });

    return {
      status: isReplace ? "replaced" : "accepted",
      id: sessionId,
      legacyPath,
      staleCourse: staleCourse === 1,
      hasConflict: hasConflict === 1,
      invalidatedCourses,
    };
  });
}

/** 构造交付信封对象（从 courses 表读出还原）。 */
export function courseRowToEnvelope(row: CourseDbRow): {
  id: string;
  courseId: string;
  segment: number;
  week: number;
  day: string;
  half: boolean;
  status: CourseDbRow["status"];
  invalidatedReason: string | null;
  snapshotHash: string;
  createdAt: string;
  updatedAt: string;
  envelope: CourseDeliveryEnvelope;
} {
  return {
    id: row.id,
    courseId: row.course_id,
    segment: row.segment,
    week: row.week,
    day: row.day,
    half: row.half === 1,
    status: row.status,
    invalidatedReason: row.invalidated_reason,
    snapshotHash: row.snapshot_hash,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    envelope: {
      schema: "yangxia.delivery/1",
      course: JSON.parse(row.course_json),
      follow: JSON.parse(row.follow_json),
      notes: JSON.parse(row.notes_json),
      declaration: DECLARATION,
      templateVersion: row.template_version,
      templateHash: row.template_hash,
      motionHashes: JSON.parse(row.motion_hashes_json),
    },
  };
}
