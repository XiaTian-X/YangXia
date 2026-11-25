// 把写给命令行的检查结果换成网页、手机上看的说法：不出现"档案.json""npm run …"、文件路径这类字样。
// 有 code 的按代号换成界面上的说法；没有的照原话去掉命令行字样。检查本身不变（规则只在核心库里写一份）。
import type { Issue } from "./types.ts";

/** 界面上的入口名（和网页导航一致）。 */
const PLACES = { assess: "「评估与复盘」", schedule: "「排课中心」", profile: "「家庭与档案」" } as const;

const BY_CODE: Record<string, (msg: string) => string> = {
  ENTRY_ASSESSMENT_MISSING: (m) => {
    const d = /第一段（(\d{4}-\d{2}-\d{2}) 起）/.exec(m)?.[1];
    return `第一段${d ? `（${d} 起）` : ""}开始之前要先做入门评估：到${PLACES.assess}填写`;
  },
  FALL_RISK_MISSING: (m) => `${cleanText(m).replace(/（照成品第〇章[^）]*）$/, "")}：在${PLACES.assess}的评估表里照原话逐项问`,
  CONCLUSION_MISMATCH: () => `这份评估的结论和按规则重算的不一致：在${PLACES.assess}重新提交，结论由系统重算`,
  COURSE_NOT_EXPORTED: () => `这份课程不是从训练单导出的：在${PLACES.schedule}重新发布，不要手写处方`,
  BEDTIME_MISMATCH: (m) => `${cleanText(m)}：在${PLACES.profile}按公式重新计算`,
  SHEET_REGENERATE: (m) => cleanText(m).replace(/重新生成(，不手改)?/, `在${PLACES.schedule}重新生成计划单$1`),
  REVIEW_MISSING: (m) => `${cleanText(m)}（到${PLACES.assess}填写）`,
};

/** 去掉命令行字样：命令、文件名、档案文件。 */
export function cleanText(s: string): string {
  return s
    // 带命令的括号说明整段去掉
    .replace(/（[^（）]*(npm run|course (assess|export|plan|bedtime))[^（）]*）/g, "")
    .replace(/[；，]\s*npm run [^；，。）]*/g, "")
    .replace(/用 npm run course -- export 重新导出/g, `在${PLACES.schedule}重新发布`)
    .replace(/npm run [a-z:]+( -- [a-z]+)?( [^；，。）\s]+)?/g, "")
    .replace(/course (export|assess|plan|check|bedtime)/g, "命令")
    // 文件名
    .replace(/评估\/<日期>-(\S+?)\.json/g, "$1评估")
    .replace(/评估\/(\d{4}-\d{2}-\d{2})-(\S+?)\.json/g, "$1 的$2评估")
    .replace(/复盘\/(\d{4}-\d{2}-\d{2})-第(\d+)周\.(json|md)/g, "$1 起第 $2 周的复盘")
    .replace(/计划\/第(\d+)段-第(\d+)周\.md/g, "第 $1 段第 $2 周的计划单")
    .replace(/打卡\/[^\s：，；）]+\.json/g, "练习记录")
    .replace(/课程\/[^\s：，；）]+\.(json|html)/g, "课程")
    .replace(/档案\.json\s*/g, "档案 ")
    .replace(/\s+([：，；。）])/g, "$1")
    .replace(/（\s*）/g, "")
    .trim();
}

/**
 * 评估结论（evaluateAssessment 重算的 conclusion）换成几句人话，界面不显示原始 JSON。
 * 只翻译结论里已有的项，不另下判断。
 */
export function conclusionLines(c: Record<string, any> | null | undefined): string[] {
  if (!c || typeof c !== "object") return [];
  const out: string[] = [];
  if (c.needDoctor === true) out.push("开工前提有\"否\"：先去体检、问医生，拿到结果再开始");
  else if (c.needDoctor === false) out.push("开工前提都满足");
  if (typeof c.bmi === "number") out.push(`BMI ${c.bmi}（${c.bmiClass ?? "未分档"}）`);
  const fr = c.fallRisk;
  if (fr && typeof fr === "object") {
    out.push(`跌倒风险自查：${fr.level === "未定" ? `还定不了（最高可能是${fr.worst ?? "高"}）` : fr.level}；处理按${fr.effective}`);
    if (fr.doctorFirst) out.push("先带着结果问医生，医生同意之前不出课程");
    if (fr.officialNeeded) out.push("要先去医院或社区卫生服务中心做一次正式的跌倒风险评估");
    if (fr.gaitIncomplete) out.push("步态没测完：结论按没测的那几项最坏的情况算");
    if (fr.reassessBy) out.push(`${fr.reassessBy} 之前再自查一次`);
  }
  if (typeof c.result === "string") out.push(`结论：${c.result}${c.downgraded ? "（这一段有过不适，往上的结论降为原样）" : ""}`);
  if (typeof c.next === "string") out.push(`下一段：${c.next}`);
  else if (c.next && typeof c.next === "object") {
    const n = c.next;
    out.push(n.phase === "稳定" ? `下一周期继续稳定期${n.hold ? "（第一轮不升级、不加量）" : ""}` : n.phase === "不开" ? "先不开下一段：看完医生、做\"看完医生回来\"的触发评估以后再定" : `回起始期${n.type ?? ""}段`);
  }
  if (Array.isArray(c.extras) && c.extras.length) out.push(`另外：${c.extras.join("、")}`);
  if (c.habitTargets && typeof c.habitTargets === "object" && Object.keys(c.habitTargets).length) {
    out.push(`习惯目标调整：${Object.entries(c.habitTargets as Record<string, Record<string, number>>)
      .map(([h, v]) => `${h} ${v.days !== undefined ? `每周 ${v.days} 天` : v.minutes !== undefined ? `${v.minutes} 分钟` : v.line !== undefined ? `达标线 ${v.line}` : ""}`).join("、")}`);
  }
  if (Array.isArray(c.goals) && c.goals.length) out.push(`下一周期能选的目标：${c.goals.join("、")}`);
  if (!out.length) out.push("已按规则记下，这一种评估没有要另外处理的结论");
  return out;
}

/** 一条检查结果换成界面说法（path 也去掉文件名）；不改 level。 */
export function presentIssue(issue: Issue): Issue {
  const f = issue.code ? BY_CODE[issue.code] : undefined;
  return { ...issue, path: cleanText(issue.path), message: f ? f(issue.message) : cleanText(issue.message) };
}
