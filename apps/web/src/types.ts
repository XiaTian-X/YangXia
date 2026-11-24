// 养夏网页端共享前端类型定义。

export type TabId = "schedule" | "assess" | "profiles" | "docs" | "agent" | "admin";

export interface AuthMe {
  user: {
    id: string;
    username: string;
    role: "admin" | "member";
  };
  session: {
    id: string;
    kind: string;
    boundProfileId: string | null;
  };
  isTeen: boolean;
}

export interface ProfileSummary {
  id: string;
  code: string;
  ownerUserId: string;
  isManaged: boolean;
  memberUserId: string | null;
  timezone: string;
  age: string;
  stage: string;
  product: string;
  version: number;
  hasConflict: boolean;
  conflict: Record<string, any> | null;
  canManage: boolean;
  currentSegment: {
    n: number;
    week: number;
    start: string;
    product: string;
    phase?: string;
    type?: string;
    goal?: string;
  } | null;
  updatedAt: string;
  createdAt: string;
}

export const DECLARATION_TEXT = "未经专业审核，不是医学建议，不能替代医生的判断";
