// 档案管理、评估、复盘、计划单、饮食文档、段归档、扫码绑定码生成与排课发布端点。
import { Hono } from "hono";
import { z } from "zod";
import {
  assessRules,
  auditProfileBundle,
  bedtimeFor,
  choiceGroups,
  currentSegment,
  dayRows,
  DECLARATION,
  inspectEndSummary,
  screeningFor,
} from "@yangxia/course-core";
import {
  assertProfileAccess,
  canPerformOnProfile,
  listAccessibleProfiles,
  type AuthActor,
} from "../auth/permissions.ts";
import type { ServerContext } from "../context.ts";
import { generatePairingCode, newId, sha256Hex } from "../crypto/tokens.ts";
import { writeAuditLog } from "../db/audit.ts";
import { loadProfileState, type CourseDbRow, type DocumentDbRow } from "../db/bundle.ts";
import { AppError } from "../db/lock.ts";
import {
  archiveSegmentOp,
  courseRowToEnvelope,
  createProfileOp,
  generatePlanSheetOp,
  invalidateCourseOp,
  publishCourseOp,
  saveDocumentOp,
  submitAssessmentOp,
  submitReviewOp,
  updateProfileOp,
} from "../domain/profile-ops.ts";

const CreateProfileSchema = z.object({
  profile: z.record(z.string(), z.unknown()),
  timezone: z.string().min(1).max(64).optional(),
  isManaged: z.boolean().optional(),
  memberUserId: z.string().uuid().nullable().optional(),
  initialAssessment: z.record(z.string(), z.unknown()).optional(),
});

const UpdateProfileSchema = z.object({
  expectedVersion: z.number().int().positive().optional(),
  patch: z.record(z.string(), z.unknown()).optional(),
  replaceProfile: z.record(z.string(), z.unknown()).optional(),
  timezone: z.string().min(1).max(64).optional(),
  memberUserId: z.string().uuid().nullable().optional(),
});

const SubmitAssessmentSchema = z.object({
  expectedVersion: z.number().int().positive().optional(),
  record: z.record(z.string(), z.unknown()),
  logicalPath: z.string().max(120).optional(),
});

const SubmitReviewSchema = z.object({
  expectedVersion: z.number().int().positive().optional(),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  week: z.number().int().min(1).max(12),
  reviewJson: z.record(z.string(), z.unknown()),
  reviewMd: z.string().min(1).max(200_000),
  nextSegmentEntry: z.record(z.string(), z.unknown()).optional(),
  profilePatch: z.record(z.string(), z.unknown()).optional(),
});

const SaveDocSchema = z.object({
  expectedVersion: z.number().int().positive().optional(),
  docType: z.enum(["menu", "monthly_summary"]),
  title: z.string().min(1).max(80),
  contentMd: z.string().min(1).max(300_000),
});

const PublishCourseSchema = z.object({
  expectedVersion: z.number().int().positive().optional(),
  week: z.number().int().min(1).max(12),
  day: z.string().min(1).max(20),
  picks: z.record(z.string(), z.string()).optional(),
  half: z.boolean().optional(),
  confirmedNoFall: z.boolean().optional(),
});

const InvalidateCourseSchema = z.object({
  expectedVersion: z.number().int().positive().optional(),
  reason: z.string().min(1).max(200),
});

const ArchiveSegmentSchema = z.object({
  expectedVersion: z.number().int().positive().optional(),
  segment: z.number().int().min(1),
});

export function registerProfileRoutes(
  app: Hono<{ Variables: { actor: AuthActor } }>,
  ctx: ServerContext,
): void {
  // 入口问卷与上床时间只读查询（供网页端建档向导使用，无需大模型）
  app.get("/api/intake", (c) => {
    const snap = ctx.templates.current();
    const age = c.req.query("age");
    return c.json({
      declaration: DECLARATION,
      templateVersion: snap.version,
      intake: snap.manifest.intake,
      products: snap.manifest.products,
      screening: age ? screeningFor(snap.manifest, age) : snap.manifest.intake.screening,
    });
  });

  // 这份成品要"按器材选一个"的组（训练单 trim.kind = choose），建档向导照它问，不替使用者选
  app.get("/api/choices", (c) => {
    const snap = ctx.templates.current();
    const product = c.req.query("product") || "";
    if (!snap.manifest.products.some((p) => p.name === product)) {
      throw new AppError(400, "UNKNOWN_PRODUCT", "没有这份成品");
    }
    return c.json({ product, groups: snap.plans ? choiceGroups(snap.plans, snap.manifest, product) : [] });
  });

  app.get("/api/bedtime", (c) => {
    const stage = c.req.query("stage") || "";
    const wake = c.req.query("wake") || "";
    const bedtime = bedtimeFor(ctx.templates.current().manifest, stage, wake);
    if (!bedtime) throw new AppError(400, "INVALID_BEDTIME_INPUT", "无法计算上床时间，请检查阶段名称和起床时间（HH:MM）");
    return c.json({ ok: true, stage, wake, bedtime });
  });

  app.get("/api/profiles", (c) => {
    const actor = c.get("actor");
    const db = ctx.getDb();
    const rows = listAccessibleProfiles(db, actor);
    return c.json({
      declaration: DECLARATION,
      profiles: rows.map((r) => {
        const parsed = JSON.parse(r.profile_json) as Record<string, any>;
        return {
          id: r.id,
          code: r.code,
          ownerUserId: r.owner_user_id,
          isManaged: r.is_managed === 1,
          memberUserId: r.member_user_id,
          timezone: r.timezone,
          age: r.age,
          stage: r.stage,
          product: r.product,
          version: r.version,
          hasConflict: r.has_conflict === 1,
          conflict: r.conflict_json ? JSON.parse(r.conflict_json) : null,
          canManage: canPerformOnProfile(actor, r, "manage"),
          currentSegment: currentSegment(parsed),
          updatedAt: r.updated_at,
          createdAt: r.created_at,
        };
      }),
    });
  });

  app.post("/api/profiles", async (c) => {
    const actor = c.get("actor");
    const body = CreateProfileSchema.parse(await c.req.json());
    const res = createProfileOp(ctx.getDb(), ctx.templates.current(), actor, body, ctx.now());
    return c.json({ ok: true, declaration: DECLARATION, ...res }, 201);
  });

  app.get("/api/profiles/:id", (c) => {
    const actor = c.get("actor");
    const db = ctx.getDb();
    const id = c.req.param("id");
    const meta = assertProfileAccess(db, actor, id, "read_basic");
    const profile = JSON.parse(meta.profile_json) as Record<string, any>;
    const canManage = canPerformOnProfile(actor, meta, "manage");

    if (!canManage) {
      // 13–17 岁与普通代管成员只读安全基础视图
      return c.json({
        declaration: DECLARATION,
        id: meta.id,
        code: meta.code,
        isManaged: meta.is_managed === 1,
        timezone: meta.timezone,
        version: meta.version,
        canManage: false,
        profile: {
          code: profile.code,
          stage: profile.stage,
          age: profile.age,
          product: profile.product,
          wake: profile.wake,
          bedtime: profile.bedtime,
          playback: profile.playback ?? {},
          currentSegment: currentSegment(profile),
        },
      });
    }

    return c.json({
      declaration: DECLARATION,
      id: meta.id,
      code: meta.code,
      ownerUserId: meta.owner_user_id,
      isManaged: meta.is_managed === 1,
      memberUserId: meta.member_user_id,
      timezone: meta.timezone,
      version: meta.version,
      hasConflict: meta.has_conflict === 1,
      conflict: meta.conflict_json ? JSON.parse(meta.conflict_json) : null,
      canManage: true,
      profile,
      updatedAt: meta.updated_at,
      createdAt: meta.created_at,
    });
  });

  app.patch("/api/profiles/:id", async (c) => {
    const actor = c.get("actor");
    const id = c.req.param("id");
    const body = UpdateProfileSchema.parse(await c.req.json());
    const db = ctx.getDb();
    assertProfileAccess(db, actor, id, "manage");
    const res = updateProfileOp(db, ctx.templates.current(), actor, id, body, ctx.now());
    return c.json({ ok: true, ...res });
  });

  app.get("/api/profiles/:id/audit", (c) => {
    const actor = c.get("actor");
    const db = ctx.getDb();
    const id = c.req.param("id");
    assertProfileAccess(db, actor, id, "manage");
    const state = loadProfileState(db, id);
    const issues = auditProfileBundle(state.bundle, ctx.templates.current(), { now: ctx.now() });
    const logs = db
      .prepare(
        `SELECT id, actor_user_id, actor_session_id, action, fields_json, rule_or_reason, created_at
         FROM audit_logs WHERE profile_id = ? ORDER BY created_at DESC LIMIT 100`,
      )
      .all(id) as Record<string, unknown>[];
    return c.json({
      issues,
      auditLogs: logs.map((l) => ({
        id: l.id,
        actorUserId: l.actor_user_id,
        actorSessionId: l.actor_session_id,
        action: l.action,
        fields: JSON.parse(String(l.fields_json || "[]")),
        ruleOrReason: l.rule_or_reason,
        createdAt: l.created_at,
      })),
    });
  });

  app.post("/api/profiles/:id/pairing-code", (c) => {
    const actor = c.get("actor");
    const db = ctx.getDb();
    const id = c.req.param("id");
    const meta = assertProfileAccess(db, actor, id, "manage");
    if (meta.age === "a06") {
      throw new AppError(400, "UNSUPPORTED_FOR_MOBILE", "6–12 岁家长版无手机跟练课程，无需生成手机绑定码");
    }
    const now = ctx.now();
    const code = generatePairingCode();
    const codeHash = sha256Hex(code);
    const expiresAt = new Date(now.getTime() + 5 * 60_000).toISOString();

    db.prepare(
      `INSERT INTO pairing_codes (id, code_hash, profile_id, created_by, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(newId(), codeHash, id, actor.userId, expiresAt, now.toISOString());

    writeAuditLog(db, {
      actorUserId: actor.userId,
      actorSessionId: actor.sessionId,
      profileId: id,
      action: "pairing_code.create",
      fields: ["pairing_codes"],
      ruleOrReason: "ttl_5m_128bit",
      now,
    });

    return c.json(
      {
        ok: true,
        code,
        profileId: id,
        profileCode: meta.code,
        expiresAt,
        qrPayload: JSON.stringify({ type: "yangxia_pair", code, profileCode: meta.code }),
      },
      201,
    );
  });

  app.get("/api/profiles/:id/assessments", (c) => {
    const actor = c.get("actor");
    const db = ctx.getDb();
    const id = c.req.param("id");
    assertProfileAccess(db, actor, id, "manage");
    const state = loadProfileState(db, id);
    const snap = ctx.templates.current();
    const rows = db
      .prepare("SELECT id, kind, assess_date, logical_path, archived_segment, assessment_json, created_at FROM assessments WHERE profile_id = ? ORDER BY assess_date DESC, created_at DESC")
      .all(id) as Record<string, unknown>[];

    const kind = c.req.query("kind");
    const endSummary =
      kind === "段末" || kind === "周期末"
        ? inspectEndSummary(state.bundle, snap, kind, { now: ctx.now() })
        : null;

    return c.json({
      assessments: rows.map((r) => ({
        id: r.id,
        kind: r.kind,
        date: r.assess_date,
        logicalPath: r.logical_path,
        archivedSegment: r.archived_segment,
        record: JSON.parse(String(r.assessment_json)),
        createdAt: r.created_at,
      })),
      assessRules: snap.rules ? assessRules(snap.rules) : null,
      endSummary,
    });
  });

  app.post("/api/profiles/:id/assessments", async (c) => {
    const actor = c.get("actor");
    const id = c.req.param("id");
    const body = SubmitAssessmentSchema.parse(await c.req.json());
    const db = ctx.getDb();
    assertProfileAccess(db, actor, id, "manage");
    const res = submitAssessmentOp(db, ctx.templates.current(), actor, id, body, ctx.now());
    return c.json({ ok: true, ...res }, 201);
  });

  app.get("/api/profiles/:id/reviews", (c) => {
    const actor = c.get("actor");
    const db = ctx.getDb();
    const id = c.req.param("id");
    assertProfileAccess(db, actor, id, "manage");
    const rows = db
      .prepare("SELECT * FROM reviews WHERE profile_id = ? ORDER BY start_date DESC, week DESC")
      .all(id) as Record<string, unknown>[];
    const sessions = db
      .prepare(
        "SELECT id, course_id, started_at, ended_at, has_symptoms, edited, stale_course, legacy_path, session_json FROM workout_sessions WHERE profile_id = ? ORDER BY started_at DESC LIMIT 60",
      )
      .all(id) as Record<string, unknown>[];
    return c.json({
      reviews: rows.map((r) => ({
        id: r.id,
        segment: r.segment,
        week: r.week,
        startDate: r.start_date,
        archivedSegment: r.archived_segment,
        reviewJson: JSON.parse(String(r.review_json)),
        reviewMd: r.review_md,
        updatedAt: r.updated_at,
      })),
      sessions: sessions.map((s) => ({
        id: s.id,
        courseId: s.course_id,
        startedAt: s.started_at,
        endedAt: s.ended_at,
        hasSymptoms: s.has_symptoms === 1,
        edited: s.edited === 1,
        staleCourse: s.stale_course === 1,
        legacyPath: s.legacy_path,
        record: JSON.parse(String(s.session_json)),
      })),
    });
  });

  app.post("/api/profiles/:id/reviews", async (c) => {
    const actor = c.get("actor");
    const id = c.req.param("id");
    const body = SubmitReviewSchema.parse(await c.req.json());
    const db = ctx.getDb();
    assertProfileAccess(db, actor, id, "manage");
    const res = submitReviewOp(db, ctx.templates.current(), actor, id, body, ctx.now());
    return c.json({ ok: true, ...res }, 201);
  });

  app.post("/api/profiles/:id/plan-sheet", async (c) => {
    const actor = c.get("actor");
    const id = c.req.param("id");
    let expectedVersion: number | undefined;
    try {
      const raw = await c.req.json();
      if (typeof raw?.expectedVersion === "number") expectedVersion = raw.expectedVersion;
    } catch {
      /* 允许空 body */
    }
    const db = ctx.getDb();
    assertProfileAccess(db, actor, id, "manage");
    const res = generatePlanSheetOp(db, ctx.templates.current(), actor, id, expectedVersion, ctx.now());
    return c.json({ ok: true, ...res }, 201);
  });

  app.get("/api/profiles/:id/documents", (c) => {
    const actor = c.get("actor");
    const db = ctx.getDb();
    const id = c.req.param("id");
    const meta = assertProfileAccess(db, actor, id, "read_basic");
    const canManage = canPerformOnProfile(actor, meta, "manage");
    const rows = canManage
      ? (db.prepare("SELECT * FROM documents WHERE profile_id = ? ORDER BY updated_at DESC").all(id) as unknown as DocumentDbRow[])
      : (db
          .prepare("SELECT * FROM documents WHERE profile_id = ? AND doc_type = 'plan' ORDER BY updated_at DESC")
          .all(id) as unknown as DocumentDbRow[]);
    return c.json({
      declaration: DECLARATION,
      documents: rows.map((d) => ({
        id: d.id,
        docType: d.doc_type,
        title: d.title,
        segment: d.segment,
        week: d.week,
        weekStart: d.week_start,
        archivedSegment: d.archived_segment,
        legacyPath: d.legacy_path,
        readonlyLegacy: d.readonly_legacy === 1,
        contentMd: d.content_md,
        templateVersion: d.template_version,
        updatedAt: d.updated_at,
      })),
    });
  });

  app.post("/api/profiles/:id/documents", async (c) => {
    const actor = c.get("actor");
    const id = c.req.param("id");
    const body = SaveDocSchema.parse(await c.req.json());
    const db = ctx.getDb();
    assertProfileAccess(db, actor, id, "manage");
    const res = saveDocumentOp(db, ctx.templates.current(), actor, id, body, ctx.now());
    return c.json({ ok: true, ...res }, 201);
  });

  app.post("/api/profiles/:id/archive-segment", async (c) => {
    const actor = c.get("actor");
    const id = c.req.param("id");
    const body = ArchiveSegmentSchema.parse(await c.req.json());
    const db = ctx.getDb();
    assertProfileAccess(db, actor, id, "manage");
    const res = archiveSegmentOp(db, ctx.templates.current(), actor, id, body.segment, body.expectedVersion, ctx.now());
    return c.json({ ok: true, ...res });
  });

  app.get("/api/profiles/:id/schedule", (c) => {
    const actor = c.get("actor");
    const db = ctx.getDb();
    const id = c.req.param("id");
    const meta = assertProfileAccess(db, actor, id, "read_basic");
    const profile = JSON.parse(meta.profile_json) as Record<string, any>;
    const seg = currentSegment(profile);
    const snap = ctx.templates.current();
    const productPlan = snap.plans?.products?.[String(seg?.product ?? profile.product ?? "")];
    const days = productPlan ? [...new Set(productPlan.rows.map((r) => r.day))] : [];
    const segType = seg?.phase === "稳定" ? "稳定" : (seg?.type ?? "标准");
    const segWeek = seg?.week ?? 1;
    const pickGroupsByDay = Object.fromEntries(
      days.map((d) => {
        const rows = productPlan && snap.rules ? dayRows(productPlan, snap.rules, profile, segType, segWeek, d) : [];
        const groups = new Map<string, string[]>();
        for (const r of rows) {
          if (r.trim.kind === "rotate") {
            const list = groups.get(r.trim.group) ?? [];
            for (const mv of r.moves) if (!list.includes(mv)) list.push(mv);
            groups.set(r.trim.group, list);
          }
        }
        return [d, Object.fromEntries(groups)];
      }),
    );

    const courseRows = db
      .prepare("SELECT * FROM courses WHERE profile_id = ? AND status IN ('active', 'invalidated') ORDER BY updated_at DESC LIMIT 40")
      .all(id) as unknown as CourseDbRow[];
    const recentSessions = db
      .prepare(
        "SELECT id, course_id, started_at, ended_at, has_symptoms, edited, stale_course, legacy_path FROM workout_sessions WHERE profile_id = ? ORDER BY started_at DESC LIMIT 30",
      )
      .all(id) as Record<string, unknown>[];

    return c.json({
      declaration: DECLARATION,
      profileId: id,
      code: meta.code,
      age: meta.age,
      version: meta.version,
      hasConflict: meta.has_conflict === 1,
      conflict: meta.conflict_json ? JSON.parse(meta.conflict_json) : null,
      currentSegment: seg,
      supportedForWorkout: meta.age !== "a06",
      days,
      pickGroupsByDay,
      activeCourses: courseRows.filter((r) => r.status === "active").map(courseRowToEnvelope),
      invalidatedCourses: courseRows
        .filter((r) => r.status === "invalidated")
        .map((r) => ({
          id: r.id,
          courseId: r.course_id,
          segment: r.segment,
          week: r.week,
          day: r.day,
          half: r.half === 1,
          invalidatedReason: r.invalidated_reason,
          updatedAt: r.updated_at,
        })),
      recentSessions,
    });
  });

  app.post("/api/profiles/:id/courses/publish", async (c) => {
    const actor = c.get("actor");
    const id = c.req.param("id");
    const body = PublishCourseSchema.parse(await c.req.json());
    const db = ctx.getDb();
    assertProfileAccess(db, actor, id, "manage");
    const res = publishCourseOp(db, ctx.templates.current(), actor, id, body, ctx.now());
    return c.json({ ok: true, ...res }, 201);
  });

  app.post("/api/profiles/:id/courses/:courseRecordId/invalidate", async (c) => {
    const actor = c.get("actor");
    const id = c.req.param("id");
    const courseRecordId = c.req.param("courseRecordId");
    const body = InvalidateCourseSchema.parse(await c.req.json());
    const db = ctx.getDb();
    assertProfileAccess(db, actor, id, "manage");
    const res = invalidateCourseOp(db, actor, id, courseRecordId, body.reason, body.expectedVersion, ctx.now());
    return c.json({ ok: true, ...res });
  });
}
