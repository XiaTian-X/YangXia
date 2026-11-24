// 移动端同步专用端点（同时支持账号登录态与扫码绑定 mobile_bound 严格白名单）。
import { Hono } from "hono";
import { z } from "zod";
import { DECLARATION } from "@yangxia/course-core";
import { buildPlayerPlan } from "@yangxia/course-core/player";
import { assertProfileAccess, listAccessibleProfiles, type AuthActor } from "../auth/permissions.ts";
import type { ServerContext } from "../context.ts";
import type { CourseDbRow } from "../db/bundle.ts";
import { AppError } from "../db/lock.ts";
import { courseRowToEnvelope, submitMobileSessionOp, updatePlaybackOp } from "../domain/profile-ops.ts";

const MotionsBatchSchema = z.object({
  ids: z.array(z.string().min(1).max(80)).max(60),
  knownHashes: z.record(z.string(), z.string()).optional(),
});

const SubmitSessionSchema = z.object({
  profileId: z.string().uuid().optional(),
  session: z.record(z.string(), z.unknown()),
  idempotencyKey: z.string().min(1).max(120).optional(),
  courseRecordId: z.string().uuid().optional(),
  courseSnapshotHash: z.string().min(1).max(128).optional(),
  replace: z.boolean().optional(),
});

const UpdatePlaybackSchema = z.object({
  profileId: z.string().uuid().optional(),
  expectedVersion: z.number().int().positive().optional(),
  playback: z.object({
    breathLead: z.union([z.number().int().min(0).max(10), z.literal("all")]).optional(),
    breathAfter: z.enum(["quiet", "pluck"]).optional(),
    countTiming: z.enum(["on-up", "on-rep"]).optional(),
  }),
});

function resolveTargetProfileId(actor: AuthActor, requested?: string | null): string {
  if (actor.sessionKind === "mobile_bound") {
    if (!actor.boundProfileId) throw new AppError(403, "BOUND_DEVICE_FORBIDDEN", "设备未绑定档案");
    if (requested && requested !== actor.boundProfileId) {
      throw new AppError(403, "BOUND_DEVICE_FORBIDDEN", "扫码绑定设备只能访问已绑定的单个档案");
    }
    return actor.boundProfileId;
  }
  if (!requested) throw new AppError(400, "PROFILE_ID_REQUIRED", "请提供 profileId");
  return requested;
}

export function registerMobileRoutes(
  app: Hono<{ Variables: { actor: AuthActor } }>,
  ctx: ServerContext,
): void {
  app.get("/api/mobile/profiles", (c) => {
    const actor = c.get("actor");
    const db = ctx.getDb();
    const rows = listAccessibleProfiles(db, actor);
    return c.json({
      profiles: rows.map((r) => {
        const parsed = JSON.parse(r.profile_json) as Record<string, unknown>;
        return {
          id: r.id,
          code: r.code,
          age: r.age,
          stage: r.stage,
          product: r.product,
          timezone: r.timezone,
          version: r.version,
          isManaged: r.is_managed === 1,
          hasWorkoutCourses: r.age !== "a06",
          hasConflict: r.has_conflict === 1,
          playback: parsed.playback ?? {},
        };
      }),
    });
  });

  app.get("/api/mobile/today", (c) => {
    const actor = c.get("actor");
    const db = ctx.getDb();
    const profileId = resolveTargetProfileId(actor, c.req.query("profileId"));
    const meta = assertProfileAccess(db, actor, profileId, "read_basic");
    const profile = JSON.parse(meta.profile_json) as Record<string, unknown>;
    const serverNow = ctx.now().toISOString();

    if (meta.age === "a06") {
      return c.json({
        profile: {
          id: meta.id,
          code: meta.code,
          age: meta.age,
          stage: meta.stage,
          product: meta.product,
          timezone: meta.timezone,
          version: meta.version,
          hasConflict: meta.has_conflict === 1,
        },
        supported: false,
        message: "6–12 岁家长版不导出跟练课程，请前往网页端查看计划正文。",
        declaration: DECLARATION,
        playback: {},
        activeCourses: [],
        invalidatedCourses: [],
        serverNow,
      });
    }

    const activeRows = db
      .prepare("SELECT * FROM courses WHERE profile_id = ? AND status = 'active' ORDER BY segment DESC, week DESC, day ASC, half ASC")
      .all(profileId) as unknown as CourseDbRow[];
    const invalidatedRows = db
      .prepare(
        "SELECT id, course_id, segment, week, day, half, invalidated_reason, snapshot_hash, updated_at FROM courses WHERE profile_id = ? AND status = 'invalidated' ORDER BY updated_at DESC LIMIT 30",
      )
      .all(profileId) as Record<string, unknown>[];

    return c.json({
      profile: {
        id: meta.id,
        code: meta.code,
        age: meta.age,
        stage: meta.stage,
        product: meta.product,
        timezone: meta.timezone,
        version: meta.version,
        hasConflict: meta.has_conflict === 1,
        conflict: meta.conflict_json ? JSON.parse(meta.conflict_json) : null,
      },
      supported: true,
      declaration: DECLARATION,
      playback: profile.playback ?? {},
      activeCourses: activeRows.map(courseRowToEnvelope),
      invalidatedCourses: invalidatedRows.map((r) => ({
        id: r.id,
        courseId: r.course_id,
        segment: r.segment,
        week: r.week,
        day: r.day,
        half: r.half === 1,
        invalidatedReason: r.invalidated_reason,
        snapshotHash: r.snapshot_hash,
        updatedAt: r.updated_at,
      })),
      serverNow,
    });
  });

  app.get("/api/mobile/courses/:id", (c) => {
    const actor = c.get("actor");
    const db = ctx.getDb();
    const id = c.req.param("id");
    const row = db.prepare("SELECT * FROM courses WHERE id = ?").get(id) as CourseDbRow | undefined;
    if (!row) throw new AppError(404, "COURSE_NOT_FOUND", "找不到对应课程");

    // 校验对该课程所属档案的访问权限（mobile_bound 必锁定 bound_profile_id）
    resolveTargetProfileId(actor, row.profile_id);
    const meta = assertProfileAccess(db, actor, row.profile_id, "read_basic");
    const payload = courseRowToEnvelope(row);

    const withTimeline = c.req.query("withTimeline") === "1";
    if (!withTimeline) {
      return c.json({ ...payload, profileCode: meta.code });
    }
    const profile = JSON.parse(meta.profile_json) as Record<string, any>;
    const precomputedPlan = buildPlayerPlan(payload.envelope.course, undefined, profile.playback);
    return c.json({
      ...payload,
      profileCode: meta.code,
      precomputedPlan,
    });
  });

  app.post("/api/mobile/motions/batch", async (c) => {
    const body = MotionsBatchSchema.parse(await c.req.json());
    const snap = ctx.templates.current();
    const known = body.knownHashes ?? {};
    const clips: Record<string, { hash: string; clip: unknown }> = {};
    const unchanged: string[] = [];
    const missing: string[] = [];

    for (const id of new Set(body.ids)) {
      const entry = Object.hasOwn(snap.motionIndex, id) ? snap.motionIndex[id] : undefined;
      const hash = entry?.hash ?? (Object.hasOwn(snap.motionHashes, id) ? snap.motionHashes[id] : undefined);
      if (!entry || !hash) {
        missing.push(id);
        continue;
      }
      if (known[id] === hash) {
        unchanged.push(id);
        continue;
      }
      clips[id] = { hash, clip: entry.clip };
    }

    return c.json({
      templateVersion: snap.version,
      clips,
      unchanged,
      missing,
    });
  });

  app.post("/api/mobile/sessions", async (c) => {
    const actor = c.get("actor");
    const body = SubmitSessionSchema.parse(await c.req.json());
    const profileId = resolveTargetProfileId(actor, body.profileId);
    const db = ctx.getDb();
    assertProfileAccess(db, actor, profileId, "submit_session");

    const res = submitMobileSessionOp(
      db,
      ctx.templates.current(),
      actor,
      profileId,
      {
        session: body.session,
        idempotencyKey: body.idempotencyKey,
        courseRecordId: body.courseRecordId,
        courseSnapshotHash: body.courseSnapshotHash,
        replace: body.replace,
      },
      ctx.now(),
    );

    if (res.status === "clock_skew_future") {
      return c.json(
        {
          ok: false,
          code: "CLOCK_SKEW_FUTURE",
          message: res.reason,
          serverNow: res.serverNow,
        },
        422,
      );
    }

    return c.json({ ok: true, ...res }, res.status === "accepted" ? 201 : 200);
  });

  app.patch("/api/mobile/playback", async (c) => {
    const actor = c.get("actor");
    const body = UpdatePlaybackSchema.parse(await c.req.json());
    const profileId = resolveTargetProfileId(actor, body.profileId);
    const db = ctx.getDb();
    assertProfileAccess(db, actor, profileId, "edit_playback");

    const res = updatePlaybackOp(
      db,
      actor,
      profileId,
      {
        expectedVersion: body.expectedVersion,
        playback: body.playback,
      },
      ctx.now(),
    );
    return c.json({ ok: true, ...res });
  });
}
