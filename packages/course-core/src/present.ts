// 把写给命令行的检查结果换成网页、手机上看的说法：不出现"档案.json""npm run …"、文件路径这类字样。
// 有 code 的按代号换成界面上的说法；没有的照原话去掉命令行字样。检查本身不变（规则只在核心库里写一份）。
import type { AssessmentForm } from "./assess-form.ts";
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

/** 档案、评估、复盘里常见字段名的说法（报错里夹着英文字段名时换成中文）。 */
const FIELD_NAMES: Record<string, string> = {
  "screening.doctorDate": "医生同意的日期",
  "screening.doctorCleared": "医生同意",
  "screening.date": "安全筛查的日期",
  doctorDate: "医生同意的日期",
  doctorCleared: "医生同意",
  screening: "安全筛查",
  household: "家里一起吃饭的人",
  bodyStopDate: "停记的日期",
  habitBase: "散步分钟",
  habitTargets: "习惯目标",
  conditions: "训练条件",
  choices: "器材",
  focus: "方向",
  birth: "出生年月",
  school: "学段",
  bedtime: "上床时间",
  wake: "起床时间",
  segments: "段",
  progressLog: "个人进度记录",
  progress: "个人进度",
  trainings: "训练次数",
  symptoms: "不适",
  habits: "习惯",
  companion: "家人在旁边",
  eventDate: "事情发生的日期",
  eventDates: "摔倒的日期",
  reasons: "原因",
  prereqs: "开工前提",
  dietByPro: "医生、营养师给的减重方案",
  weightClear: "减重的医生同意",
  cardioClear: "有氧加量的医生同意",
  addClear: "加项的医生同意",
};
const FIELD_RE = new RegExp(`(?<![A-Za-z.])(${Object.keys(FIELD_NAMES).map((k) => k.replace(/\./g, "\\.")).join("|")})(?![A-Za-z])`, "g");

/** 去掉命令行字样：命令、文件名、档案文件；常见英文字段名换成中文。 */
export function cleanText(s: string): string {
  return cleanCli(s)
    .replace(/habits\.([^\s：，；。）"]+)/g, "习惯「$1」")
    .replace(FIELD_RE, (m) => FIELD_NAMES[m] ?? m);
}

/** 评估里测试项的叫法（规则层的测试编号换成中文）。 */
const TEST_NAMES: Record<string, string> = {
  "pushup-test": "俯卧撑测试",
  "wallsit-test": "靠墙静蹲测试",
  "bike-test": "单车",
  "gym-weights": "主要动作的重量",
  "chair-stand-30s": "30 秒坐站测试",
  body: "身高、体重、腰围",
};
const AGE_NAMES: Record<string, string> = { a06: "6–12 岁", a13: "13–17 岁", a18: "18–39 岁", a40: "40–64 岁", a65: "65 岁以上" };
const JUDGES: Record<string, string> = {
  "前后比·同一级": "和上次比，要用同一级",
  "前后比·同一种用手的方式": "和上次比，要用同一种用手的方式",
  "前后比·同一深度": "和上次比，要蹲同样的深度",
  "只记录": "只记下来，不比",
  "BMI 分档": "按 BMI 分档",
};

/** 习惯目标 {"散步":{"minutes":15}} 这样的写法换成"散步 15 分钟"。 */
export function habitTargetsText(t: Record<string, Record<string, number>>): string {
  return Object.entries(t)
    .map(([h, v]) => `${h} ${v.days !== undefined ? `每周 ${v.days} 天` : v.minutes !== undefined ? `${v.minutes} 分钟` : v.line !== undefined ? `达标线 ${v.line}` : ""}`.trim())
    .join("、");
}

/**
 * 评估表单的汇总、各节说明换成网页上看的说法（命令行列项照原样）：
 * 测试编号、年龄段代号、英文字段名、原始 JSON 都换成人话。
 */
export function presentFormText(s: string): string {
  let out = s
    .replace(/习惯目标 (\{.*\})/, (m, j: string) => {
      try {
        return `习惯目标 ${habitTargetsText(JSON.parse(j))}`;
      } catch {
        return "习惯目标有调整";
      }
    })
    .replace(/写明 doctorRestart（true 回起始期第 1 周；false 照后面几条再算一次）/g, "选上\"医生建议从头来吗\"（从头来就回起始期第 1 周；不从头照后面几条再算一次）")
    .replace(/（还没算周期末量的体重腰围；写好记录再跑一次，结论的 goals 照重算的写）/g, "（还没算这次量的体重腰围，提交以后照重算的为准）")
    .replace(/照第八章开头原话问一次进食困扰（eatingCheck），记 goal/g, "照第八章开头原话问一次进食困扰，再选目标")
    .replace(/分档用 [A-Z_]+(、[A-Z_]+)*/g, "分档照国家标准")
    .replace(/没做完时 value 是/g, "没做完时填")
    .replace(/封顶见下面"评估参数"/g, "有封顶")
    .replace(/^([a-z0-9-]+)：/, (m, id: string) => (TEST_NAMES[id] ? `${TEST_NAMES[id]}：` : m));
  for (const [k, v] of Object.entries(JUDGES)) out = out.split(`：${k}（`).join(`：${v}（`);
  out = out.replace(/(?<![A-Za-z0-9-])a(06|13|18|40|65)(?![A-Za-z0-9-])/g, (m) => AGE_NAMES[m] ?? m);
  return cleanText(out);
}

function cleanCli(s: string): string {
  return s
    // 带命令的括号说明整段去掉
    .replace(/（[^（）]*(npm run|course (assess|export|plan|bedtime))[^（）]*）/g, "")
    .replace(/[；，]\s*npm run [^；，。）]*/g, "")
    .replace(/用 npm run course -- export 重新导出/g, `在${PLACES.schedule}重新发布`)
    .replace(/加 --half (重新)?导出半量课/g, `在${PLACES.schedule}发布时勾上"半量课"`)
    .replace(/npm run [a-z:]+( -- [a-z]+)?( [^；，。）\s]+)?/g, "")
    .replace(/course (export|assess|plan|check|bedtime)/g, "命令")
    // 文件名
    .replace(/评估\/<日期>-(\S+?)\.json/g, "$1评估")
    .replace(/评估\/(\d{4}-\d{2}-\d{2})-(\S+?)\.json/g, "$1 的$2评估")
    .replace(/复盘\/(\d{4}-\d{2}-\d{2})-第(\d+)周\.(json|md)/g, "$1 起第 $2 周的复盘")
    .replace(/计划\/第(\d+)段-第(\d+)周\.md/g, "第 $1 段第 $2 周的计划单")
    .replace(/打卡\/[^\s：，；）]+\.json/g, "练习记录")
    .replace(/课程\/[^\s：，；）]+\.(json|html)/g, "课程")
    .replace(/菜单\/([^\s：，；）]+)\.md/g, "菜单「$1」")
    .replace(/评估\/(?=\s|$|：)/g, "评估")
    // 括号里只有英文字段名的（如"（household）"）去掉
    .replace(/（[A-Za-z_.[\]0-9]+）/g, "")
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
    out.push(`习惯目标调整：${habitTargetsText(c.habitTargets as Record<string, Record<string, number>>)}`);
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

/** 交给网页的评估表单：汇总、各节说明、字段说明换成界面说法；命令行打印的 lines 不给网页（照原样留在命令行）。 */
export function presentAssessmentForm(form: AssessmentForm): AssessmentForm {
  return {
    ...form,
    summary: form.summary.map(presentFormText),
    sections: form.sections.map((sec) => ({
      ...sec,
      notes: sec.notes.map(presentFormText),
      fields: sec.fields.map((f) => (f.note ? { ...f, note: presentFormText(f.note) } : f)),
    })),
    lines: [],
  };
}
