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

/** 一条检查结果换成界面说法（path 也去掉文件名）；不改 level。 */
export function presentIssue(issue: Issue): Issue {
  const f = issue.code ? BY_CODE[issue.code] : undefined;
  return { ...issue, path: cleanText(issue.path), message: f ? f(issue.message) : cleanText(issue.message) };
}
