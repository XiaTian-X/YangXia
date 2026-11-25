// 从 SQLite 组装 @yangxia/course-core 的存储无关 ProfileBundle，确保服务端与 CLI 规则 100% 同源。
import type { DatabaseSync } from "node:sqlite";
import {
  dateInZone,
  resolveTimeZone,
  reviewDataName,
  reviewName,
  type AssessFile,
  type ProfileBundle,
  type ProfileCourseItem,
  type ProfileDocItem,
  type SessionFile,
} from "@yangxia/course-core";
import type { ProfileRowMeta } from "./lock.ts";

export interface CourseDbRow {
  id: string;
  profile_id: string;
  course_id: string;
  segment: number;
  week: number;
  day: string;
  half: number;
  status: "active" | "superseded" | "invalidated" | "archived";
  invalidated_reason: string | null;
  archived_segment: number | null;
  legacy_path: string | null;
  course_json: string;
  follow_json: string;
  notes_json: string;
  checks_json: string;
  template_version: string;
  template_hash: string;
  motion_hashes_json: string;
  snapshot_hash: string;
  created_at: string;
  updated_at: string;
}

export interface SessionDbRow {
  id: string;
  profile_id: string;
  course_record_id: string | null;
  course_id: string;
  course_snapshot_hash: string | null;
  idempotency_key: string | null;
  started_at: string;
  ended_at: string | null;
  has_symptoms: number;
  edited: number;
  stale_course: number;
  archived_segment: number | null;
  legacy_path: string | null;
  session_json: string;
  created_at: string;
  updated_at: string;
}

export interface ReviewDbRow {
  id: string;
  profile_id: string;
  segment: number;
  week: number;
  start_date: string;
  archived_segment: number | null;
  legacy_json_path: string | null;
  legacy_md_path: string | null;
  review_json: string;
  review_md: string;
  created_at: string;
  updated_at: string;
}

export interface AssessmentDbRow {
  id: string;
  profile_id: string;
  kind: string;
  assess_date: string;
  logical_path: string;
  archived_segment: number | null;
  assessment_json: string;
  created_at: string;
}

export interface DocumentDbRow {
  id: string;
  profile_id: string;
  doc_type: "plan" | "menu" | "monthly_summary";
  title: string;
  segment: number | null;
  week: number | null;
  week_start: string | null;
  archived_segment: number | null;
  legacy_path: string;
  readonly_legacy: number;
  content_md: string;
  template_version: string | null;
  created_at: string;
  updated_at: string;
}

export interface LoadedProfileState {
  meta: ProfileRowMeta;
  bundle: ProfileBundle;
  activeCourseRows: CourseDbRow[];
  activeCourseItems: (ProfileCourseItem & { rowId: string })[];
}

function basenameOf(p: string): string {
  const norm = p.replace(/\\/g, "/");
  const idx = norm.lastIndexOf("/");
  return idx >= 0 ? norm.slice(idx + 1) : norm;
}

/** 构造可供 engine.ts 全部函数直接消费的 ProfileBundle；支持覆盖内存态草稿以做事务内落库前门禁。 */
export function loadProfileState(
  db: DatabaseSync,
  profileId: string,
  overrides?: {
    profile?: Record<string, any>;
    extraSessions?: SessionFile[];
    extraAssessments?: AssessFile[];
    extraReviews?: { startDate: string; week: number; json: Record<string, any>; md: string; legacyJsonPath?: string; legacyMdPath?: string }[];
    extraDocs?: ProfileDocItem[];
  },
): LoadedProfileState {
  const meta = db.prepare("SELECT * FROM profiles WHERE id = ?").get(profileId) as ProfileRowMeta | undefined;
  if (!meta) throw new Error(`找不到档案：${profileId}`);

  const profile = overrides?.profile ?? (JSON.parse(meta.profile_json) as Record<string, any>);
  const timeZone = resolveTimeZone(meta.timezone, profile);

  const sessionRows = db
    .prepare("SELECT * FROM workout_sessions WHERE profile_id = ? ORDER BY started_at ASC, created_at ASC")
    .all(profileId) as unknown as SessionDbRow[];
  const sessions: SessionFile[] = sessionRows.map((r) => {
    const archived = r.archived_segment != null;
    const name = r.legacy_path ?? (archived ? `历史/第${r.archived_segment}段/打卡/${r.id}.json` : `打卡/${r.id}.json`);
    return {
      name,
      raw: JSON.parse(r.session_json) as Record<string, any>,
      archived,
      archivedSegment: r.archived_segment ?? undefined,
    };
  });
  if (overrides?.extraSessions) sessions.push(...overrides.extraSessions);

  const reviewRows = db
    .prepare("SELECT * FROM reviews WHERE profile_id = ? ORDER BY start_date ASC, week ASC")
    .all(profileId) as unknown as ReviewDbRow[];
  const reviewData: Record<string, Record<string, any>> = {};
  const docs: ProfileDocItem[] = [];
  for (const r of reviewRows) {
    const archived = r.archived_segment != null;
    const segRef = { start: r.start_date, week: r.week };
    const jsonKey = r.legacy_json_path ? basenameOf(r.legacy_json_path) : reviewDataName(segRef);
    const mdName =
      r.legacy_md_path ??
      (archived
        ? `历史/第${r.archived_segment}段/复盘/${reviewName(segRef)}`
        : `复盘/${reviewName(segRef)}`);
    reviewData[jsonKey] = JSON.parse(r.review_json) as Record<string, any>;
    docs.push({
      name: mdName,
      text: r.review_md,
      kind: "review",
      archived,
      archivedSegment: r.archived_segment ?? undefined,
    });
  }
  if (overrides?.extraReviews) {
    for (const r of overrides.extraReviews) {
      const segRef = { start: r.startDate, week: r.week };
      const jsonKey = r.legacyJsonPath ? basenameOf(r.legacyJsonPath) : reviewDataName(segRef);
      const mdName = r.legacyMdPath ?? `复盘/${reviewName(segRef)}`;
      reviewData[jsonKey] = r.json;
      const idx = docs.findIndex((d) => d.kind === "review" && d.name === mdName);
      const item: ProfileDocItem = { name: mdName, text: r.md, kind: "review" };
      if (idx >= 0) docs[idx] = item;
      else docs.push(item);
    }
  }

  const docRows = db
    .prepare("SELECT * FROM documents WHERE profile_id = ? ORDER BY created_at ASC")
    .all(profileId) as unknown as DocumentDbRow[];
  for (const r of docRows) {
    const archived = r.archived_segment != null;
    docs.push({
      name: r.legacy_path,
      text: r.content_md,
      kind: r.doc_type,
      archived,
      archivedSegment: r.archived_segment ?? undefined,
      legacyReadonly: r.readonly_legacy === 1,
    });
  }
  if (overrides?.extraDocs) {
    for (const d of overrides.extraDocs) {
      const idx = docs.findIndex((x) => x.name === d.name);
      if (idx >= 0) docs[idx] = d;
      else docs.push(d);
    }
  }

  const assessRows = db
    .prepare("SELECT * FROM assessments WHERE profile_id = ? ORDER BY assess_date ASC, created_at ASC")
    .all(profileId) as unknown as AssessmentDbRow[];
  const assessments: AssessFile[] = assessRows.map((r) => ({
    name: r.logical_path,
    raw: JSON.parse(r.assessment_json) as Record<string, any>,
    archived: r.archived_segment != null,
    archivedSegment: r.archived_segment ?? undefined,
  }));
  if (overrides?.extraAssessments) assessments.push(...overrides.extraAssessments);

  const courseRows = db
    .prepare("SELECT * FROM courses WHERE profile_id = ? AND status IN ('active', 'archived') ORDER BY created_at ASC")
    .all(profileId) as unknown as CourseDbRow[];
  const courses: ProfileCourseItem[] = [];
  const activeCourseRows: CourseDbRow[] = [];
  const activeCourseItems: (ProfileCourseItem & { rowId: string })[] = [];
  for (const r of courseRows) {
    const archived = r.status === "archived" || r.archived_segment != null;
    const halfTag = r.half === 1 ? "-半量" : "";
    const defaultName = archived
      ? `历史/第${r.archived_segment ?? r.segment}段/课程/第${r.segment}段-第${r.week}周-${r.day}日${halfTag}.json`
      : `课程/第${r.segment}段-第${r.week}周-${r.day}日${halfTag}.json`;
    const createdDate = dateInZone(new Date(r.created_at), timeZone);
    const item: ProfileCourseItem = {
      name: r.legacy_path ?? defaultName,
      raw: JSON.parse(r.course_json) as Record<string, any>,
      archived,
      archivedSegment: r.archived_segment ?? undefined,
      createdDate,
      createdAt: r.created_at,
    };
    courses.push(item);
    if (r.status === "active") {
      activeCourseRows.push(r);
      activeCourseItems.push({ ...item, rowId: r.id });
    }
  }

  return {
    meta,
    bundle: {
      profile,
      timeZone,
      sessions,
      reviewData,
      courses,
      assessments,
      docs,
    },
    activeCourseRows,
    activeCourseItems,
  };
}
