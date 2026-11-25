// 养夏网页端共享前端类型定义。

export type TabId = "schedule" | "assess" | "profiles" | "docs" | "agent" | "admin";

// 接口返回值的类型从服务端引（只引类型）：服务端改了字段，网页类型检查就报错（v2 第一轮审查 P1-9）
export type {
  AssessmentFormResponse,
  AssessmentListItem,
  AuthMeResponse as AuthMe,
  IntakeFormResponse,
  ProfileSummary,
  ProfilesResponse,
  ProgressFormResponse,
  ProgressLogResponse,
  ReviewFormResponse,
  SetupStatusResponse,
} from "../../server/src/api/contracts.ts";

export const DECLARATION_TEXT = "未经专业审核，不是医学建议，不能替代医生的判断";
