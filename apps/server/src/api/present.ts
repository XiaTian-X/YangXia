// 返回给网页、手机的检查结果统一换成界面说法（核心库 presentIssue）：不出现"档案.json""npm run …"、文件路径。
// Agent 工具交给模型的结果不走这里（照原话，规则信息完整）。
import { presentIssue, type Issue } from "@yangxia/course-core";

const ISSUE_KEYS = new Set(["issues", "warnings", "conflictIssues"]);

const looksLikeIssue = (x: unknown): x is Issue =>
  typeof x === "object" && x !== null && typeof (x as Issue).message === "string" && typeof (x as Issue).path === "string";

/** 把 JSON 里 issues / warnings 这类数组的每一项换成界面说法（最多往下找 4 层）。 */
export function presentPayload<T>(body: T, depth = 0): T {
  if (depth > 4 || body === null || typeof body !== "object") return body;
  if (Array.isArray(body)) return body.map((x) => presentPayload(x, depth + 1)) as T;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
    if (ISSUE_KEYS.has(k) && Array.isArray(v)) out[k] = v.map((x) => (looksLikeIssue(x) ? presentIssue({ ...x, level: x.level ?? "error" }) : x));
    else out[k] = presentPayload(v, depth + 1);
  }
  return out as T;
}
