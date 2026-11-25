// 网页用到的接口返回值类型（v2 第一轮审查 P1-9）：服务端处理函数用 satisfies 对上，网页用 import type 引用，
// 服务端改了字段，网页类型检查就报错（以前网页自己另写一份，学段字段名不对就是这么漏的）。
// 这个文件只放类型，不 import 运行时代码（网页打包时只引类型）。
import type { AssessmentForm, IntakeForm, ProgressForm, ReviewForm } from "@yangxia/course-core";

export interface SetupStatusResponse {
  needsSetup: boolean;
}

export interface AuthMeResponse {
  user: { id: string; username: string; role: "admin" | "member" };
  session: { id: string; kind: string; boundProfileId: string | null };
  isTeen: boolean;
}

export interface ProfileSummary {
  id: string;
  code: string;
  ownerUserId: string;
  isManaged: boolean;
  memberUserId: string | null;
  timezone: string;
  age: string | null;
  stage: string | null;
  product: string | null;
  version: number;
  hasConflict: boolean;
  conflict: Record<string, any> | null;
  canManage: boolean;
  currentSegment: { n: number; week: number; product: string; phase: string; type: string } | null;
  updatedAt: string;
  createdAt: string;
}

export interface ProfilesResponse {
  declaration: string;
  profiles: ProfileSummary[];
}

export interface IntakeFormResponse {
  declaration: string;
  form: IntakeForm;
}

export interface AssessmentFormResponse {
  declaration: string;
  /** 不含命令行打印的 lines。 */
  form: Omit<AssessmentForm, "lines">;
}

export interface ReviewFormResponse {
  declaration: string;
  form: ReviewForm;
}

export interface ProgressFormResponse {
  declaration: string;
  form: ProgressForm;
  version: number | undefined;
}

export interface ProgressLogResponse {
  ok: true;
  version: number;
  progress: Record<string, unknown>;
  invalidatedCourses: unknown[];
  warnings: { level: string; path: string; message: string; code?: string }[];
}

export interface AssessmentListItem {
  id: unknown;
  kind: unknown;
  date: unknown;
  logicalPath: unknown;
  archivedSegment: unknown;
  record: Record<string, any>;
  /** 结论的人话（conclusionLines）。 */
  conclusionText: string[];
  createdAt: unknown;
}
