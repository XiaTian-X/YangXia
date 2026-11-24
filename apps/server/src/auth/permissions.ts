// 四类角色严格白名单权限矩阵（对应需求 A3 与架构 3.3）：
// 1. 独立成年人（is_managed=0）：仅 owner_user_id 本人可读写（管理员在 Web/API 层同样禁止查看）
// 2. 管理员代管子档案（is_managed=1）：管理员/owner 完整管理；
// 3. 13-17 岁可登录账号（member 绑定到 is_managed=1 & age='a13'）：严格白名单（只读本人课程/计划单/模板、交练习记录、改允许范围的 playback）
// 4. 扫码绑定设备（kind='mobile_bound'）：严格路由白名单 + 锁定 bound_profile_id
import type { DatabaseSync } from "node:sqlite";
import { AppError, type ProfileRowMeta } from "../db/lock.ts";

export type SessionKind = "web" | "mobile_account" | "mobile_bound";

export interface AuthActor {
  userId: string;
  username: string;
  role: "admin" | "member";
  sessionId: string;
  sessionKind: SessionKind;
  boundProfileId: string | null;
  viaCookie: boolean;
}

export type ProfileAction =
  | "read_basic"       // 查看档案摘要、课程、计划单
  | "read_detail"      // 查看复盘、评估、审计、完整档案（代管未成年人仅限基本视图与课程/计划单）
  | "manage"           // 建/改档案主体、排课、发布、复盘、评估、菜单、归档、发扫码码
  | "submit_session"   // 提交练习记录
  | "edit_playback";   // 改档案级播放偏好（受安全下限约束）

/** 扫码绑定设备（mobile_bound）严格放行的 (HTTP Method, Path) 白名单。 */
const MOBILE_BOUND_WHITELIST: { method: string; pattern: RegExp }[] = [
  { method: "GET", pattern: /^\/api\/auth\/me$/ },
  { method: "POST", pattern: /^\/api\/auth\/refresh$/ },
  { method: "POST", pattern: /^\/api\/auth\/logout$/ },
  { method: "GET", pattern: /^\/api\/mobile\/profiles$/ },
  { method: "GET", pattern: /^\/api\/mobile\/today$/ },
  { method: "GET", pattern: /^\/api\/mobile\/courses\/[^/]+$/ },
  { method: "POST", pattern: /^\/api\/mobile\/motions\/batch$/ },
  { method: "POST", pattern: /^\/api\/mobile\/sessions$/ },
  { method: "PATCH", pattern: /^\/api\/mobile\/playback$/ },
];

export function isAllowedForMobileBound(method: string, path: string): boolean {
  const m = method.toUpperCase();
  return MOBILE_BOUND_WHITELIST.some((r) => r.method === m && r.pattern.test(path));
}

/** 判断该账号是否为绑定了 13–17 岁代管档案的青少年账号（需受严格白名单约束）。 */
export function isTeenMemberAccount(db: DatabaseSync, actor: AuthActor): boolean {
  if (actor.role === "admin") return false;
  const row = db
    .prepare("SELECT 1 AS ok FROM profiles WHERE is_managed = 1 AND member_user_id = ? AND age = 'a13' LIMIT 1")
    .get(actor.userId) as { ok: number } | undefined;
  return !!row;
}

export function canPerformOnProfile(actor: AuthActor, profile: ProfileRowMeta, action: ProfileAction): boolean {
  // 扫码绑定设备：仅限绑定档案 + 仅限基础读/提交记录/改播放偏好
  if (actor.sessionKind === "mobile_bound") {
    if (actor.boundProfileId !== profile.id) return false;
    return action === "read_basic" || action === "submit_session" || action === "edit_playback";
  }

  // 独立成年人档案（is_managed = 0）：严格隔离，仅 owner 本人可访问（管理员亦不可越权查看）
  if (profile.is_managed === 0) {
    return profile.owner_user_id === actor.userId;
  }

  // 代管子档案（is_managed = 1）：
  // 管理者（档案 owner 或管理员）具备全部管理与读取权限
  if (profile.owner_user_id === actor.userId || actor.role === "admin") {
    return true;
  }

  // 关联到该代管档案的成员账号（13–17 岁严格白名单 / 65+ 或其他代管成员）
  if (profile.member_user_id === actor.userId) {
    if (profile.age === "a13") {
      // 13–17 岁严格白名单：仅允许只读本人课程/计划单/模板、交练习记录、调允许范围 playback
      return action === "read_basic" || action === "submit_session" || action === "edit_playback";
    }
    return action === "read_basic" || action === "submit_session" || action === "edit_playback";
  }

  return false;
}

export function assertProfileAccess(
  db: DatabaseSync,
  actor: AuthActor,
  profileId: string,
  action: ProfileAction,
): ProfileRowMeta {
  const row = db.prepare("SELECT * FROM profiles WHERE id = ?").get(profileId) as ProfileRowMeta | undefined;
  if (!row || !canPerformOnProfile(actor, row, action)) {
    // 对无权访问的独立档案不泄露存在性（统一 403/404，这里对越权返回 403 便于明确区分权限）
    if (!row) throw new AppError(404, "PROFILE_NOT_FOUND", "找不到对应档案");
    throw new AppError(403, "FORBIDDEN", "没有权限对该档案执行此操作");
  }
  return row;
}

/** 列出当前登录者有权看到的档案列表（严格遵循四类角色边界）。 */
export function listAccessibleProfiles(db: DatabaseSync, actor: AuthActor): ProfileRowMeta[] {
  if (actor.sessionKind === "mobile_bound") {
    if (!actor.boundProfileId) return [];
    const row = db.prepare("SELECT * FROM profiles WHERE id = ?").get(actor.boundProfileId) as ProfileRowMeta | undefined;
    return row ? [row] : [];
  }
  if (actor.role === "admin") {
    // 管理员可见：自己拥有的档案 + 所有代管档案；严禁列出其他独立成年人档案
    return db
      .prepare("SELECT * FROM profiles WHERE owner_user_id = ? OR is_managed = 1 ORDER BY created_at ASC")
      .all(actor.userId) as unknown as ProfileRowMeta[];
  }
  return db
    .prepare("SELECT * FROM profiles WHERE owner_user_id = ? OR member_user_id = ? ORDER BY created_at ASC")
    .all(actor.userId, actor.userId) as unknown as ProfileRowMeta[];
}
