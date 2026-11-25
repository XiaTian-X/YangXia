// 给网页、安卓渲染表单用的结构化数据：要问什么、能选什么都从训练单和规则层推出来，
// 前端只渲染，不自己挑选项（第一轮审查修复方案第二节）。
import { bedtimeFor, notCoveredItems, screeningFor } from "./intake.ts";
import { productCode, type Manifest, type ManifestProduct } from "./manifest.ts";
import { stableParam, type PlansData, type RulesData } from "./plan.ts";
import { PROFILE_FORMAT } from "./profile.ts";

/** "按器材选一个"里的一个选项。 */
export interface ChoiceOption {
  /** 写进档案 choices 的值：训练单原样（动作 ID，或者"（门框划船）"这种原文写法）。 */
  value: string;
  /** 给人看的名字：动作库的中文名；不是动作 ID 的照原文去掉括号。 */
  name: string;
  /** 能不能导出成跟练课程（不是动作 ID 的只能照成品原文做）。 */
  exportable: boolean;
}

/** 训练单里一组"按器材选一个"（trim.kind === "choose"），按 moves 和条件去重。 */
export interface ChoiceGroup {
  key: string;
  options: ChoiceOption[];
  /** 这组只在条件取这个值时用（如 13–17 岁"家长在旁边"）；null 表示一直用。 */
  condition: { name: string; value: boolean } | null;
  /** 用到这组的日子（去重，按出现先后）。 */
  days: string[];
}

/**
 * 这份成品要按器材选的组。档案的 choices 是一个按优先顺序排的列表：导出时每组取 choices 里第一个在这组里的；
 * 所以每一组（含各个条件取值的组）都要至少选中一个，不然导出到用得上它的那一天会报错。
 */
export function choiceGroups(plans: PlansData, manifest: Manifest, productName: string): ChoiceGroup[] {
  const product = plans.products[productName];
  if (!product) return [];
  const groups = new Map<string, ChoiceGroup>();
  for (const r of product.rows) {
    if (r.trim.kind !== "choose") continue;
    const key = `${r.moves.join("|")}#${r.condition ? `${r.condition.name}=${r.condition.value}` : ""}`;
    let g = groups.get(key);
    if (!g) {
      g = {
        key,
        options: r.moves.map((m) => {
          const ex = manifest.exercises.find((e) => e.id === m);
          return { value: m, name: ex ? ex.short || ex.name : m.replace(/^（(.*)）$/, "$1"), exportable: !!ex };
        }),
        condition: r.condition ? { name: r.condition.name, value: r.condition.value } : null,
        days: [],
      };
      groups.set(key, g);
    }
    if (!g.days.includes(r.day)) g.days.push(r.day);
  }
  return [...groups.values()];
}

/** choices 有没有覆盖每一组：返回没覆盖的组。 */
export function uncoveredChoiceGroups(groups: ChoiceGroup[], choices: readonly string[]): ChoiceGroup[] {
  return groups.filter((g) => !g.options.some((o) => choices.includes(o.value)));
}

// ---------- 建档向导 ----------

/** 建档向导到目前为止的回答（都可以没答；网页每走一步带上已答的，服务端照规则算下一步要问什么）。 */
export interface IntakeAnswers {
  /** 入口问卷 Q1：manifest intake.stages 的 stage 原话。 */
  stage?: string;
  /** 入口问卷 Q3（只问 18–64 岁）：gym / home / bw。 */
  venue?: string;
  /** 选的起始期成品；有基础、直接进稳定期的也写起始期那份，另写 direct: true。 */
  product?: string;
  /** 有基础、直接进稳定期（只限登记了门槛的成品）。 */
  direct?: boolean;
  /** 安全筛查：原话 → 是 / 否。 */
  screening?: Record<string, "是" | "否">;
  /** 训练条件：答了的写 true / false，没确认的不写。 */
  conditions?: Record<string, boolean>;
}

export interface IntakeCondition {
  name: string;
  /** 规则层问法原话。 */
  ask: string;
  note: string;
  /** 每次练之前都要再确认（如"家长在旁边"）。 */
  perSession: boolean;
  /** 没确认时按哪边导出（规则层"没确认时"）。 */
  unconfirmed: boolean;
}

export interface IntakeProduct {
  name: string;
  venue: string;
  /** 成品"谁用这一份"那一句。 */
  for: string;
  /** 按入口问卷推出来的那一份（只是标出来，不替使用者选）。 */
  recommended: boolean;
}

export interface DirectEntry {
  /** 能直接进的稳定期成品。 */
  product: string;
  /** 门槛：最近 3 个月每周力量练习天数、俯卧撑测试的级和次数（规则层 stable.params）。 */
  days: number;
  level: number;
  reps: number;
  quotes: string[];
}

export interface IntakeForm {
  /** Q1 的选项；age 为 null 的是不覆盖的阶段。 */
  stages: { stage: string; age: string | null }[];
  notCovered: { group: string; advice: string }[];
  /** 选了不覆盖的阶段、或者筛查里不覆盖的项答了"是"：不建档，照这句话转告。 */
  blocked: string | null;
  age: string | null;
  /** Q3（只问 18–64 岁）。 */
  venueAsk: { question: string; options: { value: string; label: string }[] } | null;
  /** 这个年龄段能选的起始期成品；附册、稳定期、全家餐饮模板不在里面。 */
  products: IntakeProduct[];
  /** 选的成品能不能"有基础、直接进稳定期"，门槛是多少；不能的为 null。 */
  direct: DirectEntry | null;
  screening: { heading: string; rule: string; kind: "any" | "all"; items: string[] } | null;
  /** 筛查结论：都答完才有；needDoctor 时医生同意（记日期）之前不出计划和课程。 */
  screeningOutcome: { needDoctor: boolean; message: string } | null;
  /** 这份成品现在要问的训练条件。 */
  conditions: IntakeCondition[];
  /** 这份成品（直接进稳定期的按稳定期那份）要按器材选的组。 */
  choiceGroups: ChoiceGroup[];
  /** 按年龄段要记的基本信息。 */
  basics: {
    birth: boolean;
    school: { stages: string[]; systems: { value: "63" | "54"; label: string }[] } | null;
    /** 18–64 岁：体重腰围记不记。 */
    body: boolean;
    /** 65 岁以上：建档时的散步分钟（"散步减 5 分钟"按它算）。 */
    walkBase: boolean;
    /** 直接进稳定期的人：方向（作息、饮食、训练，要含训练）。 */
    focus: boolean;
  };
}

/** 入口问卷 Q3 的三个选项依次对应的场地（问卷 purpose："选场地：gym、home、bw"）。 */
const VENUE_BY_OPTION = ["gym", "home", "bw"];

export interface IntakeTemplates {
  manifest: Manifest;
  plans: PlansData;
  rules: RulesData;
}

type IntakeManifest = Manifest & {
  intake: Manifest["intake"] & {
    questions?: { id: string; question: string; options: string[] }[];
    not_covered?: { group: string; advice: string }[];
  };
};

type FullProduct = ManifestProduct & { phase?: string; for?: string };

/**
 * 建档向导要问什么、能选什么：全部从入口问卷、规则层、训练单推出来（onboard skill 的网页版）。
 * 不预选：推荐的成品只标 recommended，选不选由使用者定。
 */
export function intakeForm(t: IntakeTemplates, answers: IntakeAnswers): IntakeForm {
  const m = t.manifest as IntakeManifest;
  const notCovered = (m.intake.not_covered ?? []).map((x) => ({ group: x.group, advice: x.advice }));
  const out: IntakeForm = {
    stages: m.intake.stages.map((s) => ({ stage: s.stage, age: s.age })),
    notCovered,
    blocked: null,
    age: null,
    venueAsk: null,
    products: [],
    direct: null,
    screening: null,
    screeningOutcome: null,
    conditions: [],
    choiceGroups: [],
    basics: { birth: false, school: null, body: false, walkBase: false, focus: false },
  };
  const st = m.intake.stages.find((s) => s.stage === answers.stage);
  if (!st) return out;
  if (!st.age) {
    const nc = notCovered.find((g) => g.group.startsWith(st.stage)) ?? notCovered[0];
    out.blocked = `模板不覆盖「${st.stage}」${nc ? `：${nc.advice}` : ""}`;
    return out;
  }
  const age = st.age;
  out.age = age;
  const adult = age === "a18" || age === "a40";

  // Q3 场地：只问 18–64 岁
  const q3 = m.intake.questions?.find((q) => q.id === "Q3");
  if (adult && q3) out.venueAsk = { question: q3.question, options: q3.options.map((label, i) => ({ value: VENUE_BY_OPTION[i], label })) };

  const all = m.products as FullProduct[];
  const starts = all.filter((p) => p.age === age && p.phase === "起始");
  out.products = starts.map((p) => ({
    name: p.name,
    venue: p.venue,
    for: p.for ?? "",
    recommended: adult ? p.venue === answers.venue : starts.length === 1,
  }));

  const picked = starts.find((p) => p.name === answers.product);
  if (picked) {
    const code = productCode(picked);
    const stable = all.find((p) => p.age === age && p.venue === picked.venue && p.phase === "稳定");
    const dp = stableParam(t.rules, code, "直接进入");
    const days = stableParam(t.rules, code, "有基础每周力量天数")?.number;
    const level = stableParam(t.rules, code, "有基础俯卧撑级")?.number;
    const reps = stableParam(t.rules, code, "有基础俯卧撑次数")?.number;
    if (stable && dp?.value === "是" && days !== undefined && level !== undefined && reps !== undefined) {
      const names = ["直接进入", "有基础每周力量天数", "有基础俯卧撑级", "有基础俯卧撑次数"];
      const quotes = ((t.rules.stable?.params ?? []) as { name: string; products: string[]; quotes?: { text: string }[] }[])
        .filter((x) => x.products.includes(code) && names.includes(x.name))
        .flatMap((x) => (x.quotes ?? []).map((q) => q.text));
      out.direct = { product: stable.name, days, level, reps, quotes };
    }
    const effective = answers.direct && out.direct ? out.direct.product : picked.name;
    out.conditions = intakeConditions(t.rules, code, answers);
    out.choiceGroups = choiceGroups(t.plans, t.manifest, effective);
    out.basics.focus = !!(answers.direct && out.direct);
  }

  // 安全筛查（逐字原话）；不覆盖的项答"是"就不建档
  const sc = screeningFor(m, age);
  if (sc) {
    out.screening = { heading: sc.heading, rule: sc.rule, kind: sc.kind, items: sc.items };
    const ans = answers.screening ?? {};
    const nc = notCoveredItems(m, age).find((x) => ans[x.item] === "是");
    if (nc) out.blocked = `${nc.group}：${nc.advice}`;
    else if (sc.items.every((x) => ans[x] === "是" || ans[x] === "否")) {
      const yes = sc.items.some((x) => ans[x] === "是");
      const needDoctor = age === "a65" || sc.kind === "all" || yes;
      out.screeningOutcome = {
        needDoctor,
        message: age === "a65" ? "65 岁以上开始前都要先问医生：医生同意之前不出计划和课程"
          : needDoctor ? "筛查有\"是\"：先问医生，医生同意之前不出计划和课程" : "筛查都是\"否\"：可以开始",
      };
    }
  }

  const minor = age === "a06" || age === "a13";
  out.basics.birth = !minor;
  if (minor) {
    out.basics.school = {
      stages: age === "a06" ? ["小学"] : ["初中", "高中"],
      systems: [{ value: "63", label: "六三制（小学 6 年、初中 3 年）" }, { value: "54", label: "五四制（小学 5 年、初中 4 年）" }],
    };
  }
  out.basics.body = adult;
  out.basics.walkBase = age === "a65";
  return out;
}

/** 建档向导收齐以后组装档案用的输入（筛查、条件、器材这些照 IntakeAnswers；其余是基本信息）。 */
export interface IntakeProfileInput {
  answers: IntakeAnswers;
  code: string;
  startDate: string;
  timezone: string;
  wake?: string;
  /** 18 岁以上：出生年月 YYYY-MM。 */
  birth?: string;
  /** 6–17 岁：学段、入学年份、学制。 */
  school?: { stage: string; entry: number; system?: "63" | "54" };
  /** 18–64 岁：体重腰围记不记。 */
  body?: "记" | "不记";
  /** 65 岁以上：建档时的散步分钟。 */
  walkBase?: number;
  /** 能用的器材，按优先顺序。 */
  choices?: string[];
  /** 直接进稳定期的人：方向。 */
  focus?: string[];
  doctorCleared?: boolean;
  doctorDate?: string;
  household?: string[];
}

/**
 * 照建档向导的回答组装档案（yangxia.profile/1）：只用这份成品要问的条件里答了的项（没确认的不写），
 * 上床时间按公式算；直接进稳定期的第一段写稳定期成品。组装好的档案照旧由服务端整档核对。
 */
export function profileFromIntake(t: IntakeTemplates, input: IntakeProfileInput): { profile: Record<string, unknown> } | { error: string } {
  const form = intakeForm(t, input.answers);
  if (form.blocked) return { error: form.blocked };
  if (!form.age) return { error: "还没选阶段" };
  const start = form.products.find((p) => p.name === input.answers.product);
  if (!start) return { error: "还没选起始期计划成品" };
  if (!form.screeningOutcome || !form.screening) return { error: "安全筛查还没逐项答完" };
  const direct = !!(input.answers.direct && form.direct);
  const product = direct ? form.direct!.product : start.name;
  const asked = new Set(form.conditions.map((c) => c.name));
  const conditions = Object.fromEntries(Object.entries(input.answers.conditions ?? {}).filter(([k, v]) => asked.has(k) && typeof v === "boolean"));
  const stage = input.answers.stage!;
  const bedtime = input.wake ? bedtimeFor(t.manifest, stage, input.wake) : null;
  const answers = form.screening.items.map((item) => ({ item, answer: input.answers.screening![item] }));
  const profile: Record<string, unknown> = {
    schema: PROFILE_FORMAT,
    code: input.code.trim(),
    stage,
    age: form.age,
    venue: start.venue,
    product,
    timezone: input.timezone,
    startDate: input.startDate,
    segments: [{ n: 1, type: "标准", ...(direct ? { phase: "稳定" } : {}), week: 1, start: input.startDate, product }],
    screening: {
      answers,
      doctorCleared: input.doctorCleared === true,
      date: input.startDate,
      ...(input.doctorCleared && input.doctorDate ? { doctorDate: input.doctorDate } : {}),
    },
    ...(Object.keys(conditions).length ? { conditions } : {}),
    ...(input.choices?.length ? { choices: input.choices } : {}),
    ...(input.wake ? { wake: input.wake } : {}),
    ...(bedtime ? { bedtime } : {}),
    ...(input.household?.length ? { household: input.household } : {}),
    progress: {},
    progressLog: [],
  };
  if (form.basics.birth && input.birth) profile.birth = input.birth;
  if (form.basics.school && input.school) profile.school = { stage: input.school.stage, entry: input.school.entry, ...(input.school.system ? { system: input.school.system } : {}) };
  if (form.basics.body && input.body) profile.body = input.body;
  if (form.basics.walkBase && input.walkBase) profile.habitBase = { 散步: input.walkBase };
  if (direct && input.focus?.length) profile.focus = { areas: input.focus };
  return { profile };
}

/**
 * 这份成品现在要问的训练条件：只列规则层 products 含这份成品的；有依赖的按已答的定。
 * - 重度肥胖：只在安全筛查"BMI ≥ 28"答"是"时问（答"否"按"否"推，不用问；身高体重当场算，只记是 / 否）；
 * - 有氧问过医生：只对有高血压（或没确认）、或者重度肥胖的人有用。
 */
export function intakeConditions(rules: RulesData, code: string, answers: IntakeAnswers): IntakeCondition[] {
  const cs = Object.entries(rules.conditions).filter(([, c]) => c.products.includes(code));
  const has = (n: string) => cs.some(([x]) => x === n);
  const conds = answers.conditions ?? {};
  const bmiYes = Object.entries(answers.screening ?? {}).some(([item, a]) => a === "是" && /BMI\s*≥\s*28/.test(item));
  const out: IntakeCondition[] = [];
  for (const [name, c] of cs) {
    if (name === "重度肥胖" && !bmiYes) continue;
    if (name === "有氧问过医生") {
      const htn = has("高血压") && conds["高血压"] !== false;
      const severe = has("重度肥胖") && bmiYes && conds["重度肥胖"] !== false;
      if (!htn && !severe) continue;
    }
    out.push({ name, ask: c.ask, note: c.note, perSession: !!c.per_session, unconfirmed: c.default });
  }
  return out;
}
