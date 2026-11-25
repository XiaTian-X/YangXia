// 评估要问、要测什么（入门、段末、周期末、触发）：命令行 course assess 列项和网页评估表单用同一份。
// 每一项都从模板规则层（rules.assess、fallRisk、goals）推出来，不另写一套；结论照旧由 evaluateAssessment 重算。
// lines 是命令行逐行打印的文字（和下沉之前逐字一致），sections 是给网页渲染的结构化字段。
import { ageAt, ASSESS_FORMAT, assessRules, cycleEnd, param, productInfo, REASONS, segmentEnd } from "./assess.ts";
import { dateInZone } from "./date.ts";
import { buildAssessContext, type ProfileBundle, type TemplateBundle } from "./engine.ts";
import { fallRiskRules, FRAIL, SEVERITY, SKIPPED, UNTESTED } from "./fallrisk.ts";
import { cycleGoals } from "./goals.ts";
import { currentSegment } from "./plan.ts";

type Obj = Record<string, any>;

export type FieldInput =
  | { type: "yesno" }
  /** 是 / 否 / 说不清（说不清记 null）：跌倒风险自查只问老人本人的那几问。 */
  | { type: "yesnoUnsure" }
  | { type: "int"; min: number; max?: number }
  | { type: "decimal"; min: number; max: number; step: number }
  | { type: "enum"; options: { value: string | number; label: string }[] }
  | { type: "multi"; options: { value: string; label: string }[] }
  | { type: "date" }
  | { type: "dates" }
  | { type: "text"; maxLength: number }
  /** 一项步态测试：测了记 seconds、cane、siteOk、testedOn（tug 另有 chairOk）；或者没测成、按规则不测。 */
  | { type: "gait"; chair: boolean; untested: string[]; skipped: string[]; stops: string[] };

/** 只在别的项取某些值时才问。 */
export interface ShowIf {
  key: string;
  in: (string | number | boolean | null)[];
}

export interface FormField {
  /** 写进评估记录的位置（点分路径，如 prereqs.checkup、fallRisk.general.fell）；测试项写 tests.<id>.<字段>。 */
  key: string;
  label: string;
  input: FieldInput;
  required: boolean;
  note?: string;
  /** 只读、由服务端从档案带入（如健身房的重量取自个人进度）。 */
  readonly?: boolean;
  value?: unknown;
  /** 任一条成立才问。 */
  showIf?: ShowIf[];
}

export interface FormSection {
  id: string;
  title: string;
  notes: string[];
  fields: FormField[];
}

export interface AssessmentForm {
  kind: "入门" | "段末" | "周期末" | "触发";
  product: string;
  code: string;
  age: string;
  /** 段末、周期末：算的是第几段（记录的 segment）。 */
  segment: number | null;
  /** 触发评估跨段、换场地时可以换成的成品（换了以后再取一次表单，列新成品的入门项）。 */
  switchProducts: string[];
  sections: FormSection[];
  /** 段末、周期末的汇总和结论（人话）。 */
  summary: string[];
  /** 命令行打印的文字。 */
  lines: string[];
}

const KIND_LIST = ["入门", "段末", "周期末", "触发"] as const;
const HANDS = ["不用手", "扶椅子", "手撑"];
const STOPS = ["头晕", "腿软", "身体晃"];
const BIKE = ["稳态分钟", "间歇轮数"];

/** 测试项每个字段怎么填（字段名来自规则层 tests[].fields）。 */
function testField(test: string, f: string, ctx: { ladder?: { level: number; name: string }[]; cap?: number; progress?: Obj }): FormField {
  const key = `tests.${test}.${f}`;
  switch (f) {
    case "level":
      return { key, label: "做的是第几级", required: true, input: ctx.ladder?.length
        ? { type: "enum", options: ctx.ladder.map((l) => ({ value: l.level, label: `第 ${l.level} 级 · ${l.name}` })) }
        : { type: "int", min: 1 } };
    case "value":
      if (test === "wallsit-test") return { key, label: "坚持了几秒", required: true, input: { type: "int", min: 0, ...(ctx.cap !== undefined ? { max: ctx.cap } : { max: 600 }) },
        ...(ctx.cap !== undefined ? { note: `有高血压或没确认：最多 ${ctx.cap} 秒` } : {}) };
      if (test === "bike-test") return { key, label: "骑了多少（按方式填分钟或轮数）", required: true, input: { type: "int", min: 0, max: 300 } };
      if (test === "chair-stand-30s") return { key, label: "30 秒做了几次（没做完的写已经做了几次）", required: true, input: { type: "int", min: 0, max: 60 } };
      return { key, label: "做了几次", required: true, input: { type: "int", min: 0, max: 200 } };
    case "depth":
      return { key, label: "蹲的深度（照成品写法）", required: false, input: { type: "text", maxLength: 30 } };
    case "mode":
      return { key, label: "方式", required: true, input: { type: "enum", options: BIKE.map((x) => ({ value: x, label: x })) } };
    case "hands":
      return { key, label: "用手的方式", required: true, input: { type: "enum", options: HANDS.map((x) => ({ value: x, label: x })) } };
    case "done":
      return { key, label: "30 秒做完了吗", required: true, input: { type: "yesno" } };
    case "stopReason":
      return { key, label: "停下的原因", required: true, input: { type: "enum", options: STOPS.map((x) => ({ value: x, label: x })) }, showIf: [{ key: `tests.${test}.done`, in: [false] }] };
    case "move":
      return { key, label: "动作", required: true, input: { type: "text", maxLength: 40 }, readonly: true };
    default:
      return { key, label: f, required: true, input: { type: "text", maxLength: 60 } };
  }
}

/**
 * 某个档案、某种评估要问什么、测什么。product 不写时取现在这一段的成品（触发评估跨段、换场地写新成品）。
 * 出错（种类不对、周期末不在稳定期、模板没有评估规则、没有这份成品）时返回 { error }。
 */
export function assessmentForm(bundle: ProfileBundle, t: TemplateBundle, kind: string, opts: { product?: string; now?: Date } = {}): AssessmentForm | { error: string } {
  const profile = bundle.profile as Obj;
  const ar = assessRules(t.rules);
  if (!ar) return { error: "模板还没有评估规则（rules.json 的 assess）：先把模板仓库更新到 v4 阶段 2 之后" };
  if (!(KIND_LIST as readonly string[]).includes(kind)) return { error: "种类写 入门 / 段末 / 周期末 / 触发" };
  const seg = currentSegment(profile);
  if (seg && kind === "周期末" && seg.phase !== "稳定" && !(profile.segments as Obj[]).some((x) => x.phase === "稳定")) {
    return { error: "周期末评估只在稳定期第 12 周之后做；起始期每段第 4 周之后做的是段末评估" };
  }
  const product = opts.product ?? seg?.product ?? profile.product;
  const info = productInfo(t.manifest, product);
  if (!info) return { error: `模板里没有成品「${product}」` };

  const lines: string[] = [];
  const sections: FormSection[] = [];
  const summary: string[] = [];
  const ctx = buildAssessContext(bundle, t, { now: opts.now });
  const today = dateInZone(opts.now ?? new Date(), bundle.timeZone);
  const k = kind as AssessmentForm["kind"];
  const form: AssessmentForm = { kind: k, product, code: info.code, age: info.age, segment: null, switchProducts: [], sections, summary, lines };

  const head = `${kind}评估 · ${product}（未经专业审核，不是医学建议${info.age === "a65" ? "；65 岁以上的测试在医生同意以后、家人在场时做" : ""}）`;
  lines.push(head);
  const general: FormSection = { id: "general", title: "基本", notes: info.age === "a65" ? ["65 岁以上的测试在医生同意以后、家人在场时做"] : [], fields: [] };
  sections.push(general);

  if (kind === "触发") {
    lines.push(`原因（reasons）：跨段 / 满一年 / 身体变化 / 生病住院 / 生病 / 摔倒 / 换场地 / 中断 / 看完医生回来 / 回起始期（稳定期的人自己要求）；摔倒、生病住院写那天 eventDate；医生建议从头来的加 doctorRestart: true`);
    lines.push(`跨段、换场地：product 写新成品，带上新成品入门的项目（加 --product <新成品名> 列出来）${opts.product ? "" : `；下面列的是「${product}」的`}`);
    const at = ageAt(profile, today, ar.assess);
    if (at.age && at.age !== info.age) lines.push(`现在推算是${at.stage}（${at.age}），「${product}」是 ${info.age}：跨段要换到 ${at.age} 的成品，用 --product 列它的项目`);
    general.fields.push(
      { key: "reasons", label: "这次评估的原因（可以多选）", required: true, input: { type: "multi", options: REASONS.map((x) => ({ value: x, label: x })) } },
      { key: "eventDates", label: "摔倒的日期（一周里摔了几次的每次都写）", required: true, input: { type: "dates" }, showIf: [{ key: "reasons", in: ["摔倒"] }],
        note: "最近那次同时记为 eventDate" },
      { key: "eventDate", label: "生病住院那天", required: true, input: { type: "date" }, showIf: [{ key: "reasons", in: ["生病住院"] }] },
      { key: "doctorRestart", label: "医生建议从头来吗", required: false, input: { type: "yesno" }, showIf: [{ key: "reasons", in: ["看完医生回来"] }] },
    );
    // 跨段、换场地：可以换成的起始期成品（同年龄段换场地；跨段换到推算出的年龄段）
    const targetAge = at.age && at.age !== info.age ? at.age : info.age;
    form.switchProducts = (t.manifest.products as (typeof t.manifest.products[number] & { phase?: string })[])
      .filter((p) => p.age === targetAge && p.phase === "起始" && p.name !== product)
      .map((p) => p.name);
    if (at.age && at.age !== info.age) general.notes.push(`现在推算是${at.stage}：跨段要换到 ${at.age} 的成品`);
  }
  if (kind === "段末" || kind === "周期末") {
    const segs = (profile.segments ?? []) as Obj[];
    if (kind === "段末" && seg) form.segment = seg.week === 4 || seg.n === 1 ? seg.n : seg.n - 1;
    if (kind === "周期末") {
      const stableNs = [...new Set(segs.filter((x) => x.phase === "稳定").map((x) => x.n))] as number[];
      const done = stableNs.filter((n) => segs.some((x) => x.n === n && x.week === (t.rules?.stable?.cycleWeeks ?? 12)));
      form.segment = done.length ? done[done.length - 1] : stableNs[stableNs.length - 1] ?? null;
    }
  }

  const timing = kind === "段末" || kind === "周期末" ? "段末" : "入门";
  const pres = ar.assess.prereqs.filter((x) => x.products.includes(info.code));
  if (pres.length) {
    const sec: FormSection = { id: "prereqs", title: "开工前提", notes: [], fields: [] };
    for (const pr of pres) {
      lines.push(`开工前提 ${pr.id}：${pr.ask}（是 / 否；${pr.note}）`);
      sec.fields.push({ key: `prereqs.${pr.id}`, label: pr.ask, required: kind === "入门" || kind === "触发", input: { type: "yesno" }, note: pr.note });
    }
    // 开工前提只在入门（或换到 40–64 岁版的触发）评估里记
    if (kind === "入门" || kind === "触发") sections.push(sec);
  }
  if (kind === "入门" && ["a18", "a40", "a13"].includes(info.age)) {
    lines.push("训练基础 base：最近 3 个月平均每周几天力量练习（0、1、2 及以上；18–64 岁徒手、居家是直接进稳定期的门槛之一，其余只记录）");
    general.fields.push({ key: "base", label: "最近 3 个月平均每周几天力量练习", required: true,
      input: { type: "enum", options: [{ value: 0, label: "0 天" }, { value: 1, label: "1 天" }, { value: 2, label: "2 天及以上" }] },
      note: "18–64 岁徒手、居家是直接进稳定期的门槛之一，其余只记录" });
  }

  const tests: FormSection = { id: "tests", title: "测试", notes: [], fields: [] };
  const body: FormSection = { id: "body", title: "身高、体重、腰围", notes: [], fields: [] };
  const cap = param(ar.assess, "高血压静蹲上限", info.code)?.number;
  const hyper = profile.conditions?.["高血压"] !== false;
  for (const x of ar.assess.tests.filter((x) => x.products.includes(info.code) && x.timing.includes(timing))) {
    if (x.id === "body" && profile.body !== "记") continue;
    lines.push(`测试 ${x.id}：记 ${x.fields.join("、")}；${x.judge}（${x.note}）`);
    if (x.id === "wallsit-test" && cap !== undefined && hyper) lines.push(`  这个人有高血压或没确认：静蹲最多 ${cap} 秒`);
    if (x.id === "body") {
      const hadHeight = ctx.assessments.some((a) => typeof a.raw?.body?.height === "number");
      if (timing === "入门" || !hadHeight) body.fields.push({ key: "body.height", label: "身高（厘米）", required: true, input: { type: "decimal", min: 100, max: 230, step: 0.5 } });
      body.fields.push(
        { key: "body.weight", label: "体重（公斤）", required: true, input: { type: "decimal", min: 25, max: 300, step: 0.1 } },
        { key: "body.waist", label: "腰围（厘米）", required: true, input: { type: "decimal", min: 40, max: 200, step: 0.5 } },
      );
      body.notes.push(x.note);
      continue;
    }
    if (x.id === "gym-weights") {
      // 只记录：取自档案的个人进度，不手填
      const prog = (profile.progress ?? {}) as Obj;
      for (const [move, v] of Object.entries(prog)) {
        if (typeof (v as Obj)?.weight !== "number") continue;
        // 问法用动作的中文名（个人进度的键是动作编号）
        const ex = t.manifest.exercises.find((e) => e.id === move);
        tests.fields.push({ key: `tests.gym-weights.${move}`, label: `${ex?.short || ex?.name || move}：现在的重量（公斤，取自个人进度）`, required: false, readonly: true, value: (v as Obj).weight, input: { type: "decimal", min: 0, max: 500, step: 0.5 } });
      }
      tests.notes.push(`${x.id}：${x.note}`);
      continue;
    }
    const ladder = x.id === "pushup-test" ? t.plans?.products[product]?.ladders?.pushup : undefined;
    for (const f of x.fields) tests.fields.push(testField(x.id, f, { ladder, cap: x.id === "wallsit-test" && hyper ? cap : undefined }));
    tests.notes.push(`${x.id}：${x.judge}（${x.note}）`);
  }
  if (tests.fields.length || tests.notes.length) sections.push(tests);
  if (body.fields.length) sections.push(body);
  if (info.age === "a65" && tests.fields.length) {
    general.fields.push(
      { key: "companion", label: "测试时有家人在旁边", required: true, input: { type: "yesno" }, note: "65 岁以上的测试要家人在场时做" },
      { key: "doctorCleared", label: "医生同意做这些测试了吗", required: true, input: { type: "yesno" } },
      { key: "doctorDate", label: "医生同意的日期", required: true, input: { type: "date" }, showIf: [{ key: "doctorCleared", in: [true] }] },
    );
  }
  if (info.age === "a65" && kind === "段末") {
    lines.push("weightDrop：体重有没有明显下降（是 / 否，不记数字）");
    general.fields.push({ key: "weightDrop", label: "体重有没有明显下降（不记数字）", required: true, input: { type: "yesno" } });
  }
  if (info.age === "a65" && kind === "触发") {
    general.fields.push({ key: "fallAssessDone", label: "这一年做过跌倒风险评估没有（医院或社区卫生服务中心）", required: true, input: { type: "yesno" },
      showIf: [{ key: "reasons", in: ["满一年"] }] });
  }

  const fr = fallRiskRules(t.rules);
  if (fr && info.age === "a65" && kind !== "段末" && kind !== "周期末") {
    lines.push(`\n跌倒风险自查（fallRisk；照 WS/T 887—2026 第 5 章，不是正式评估；${kind === "触发" ? "跨段、满一年、摔倒、生病住院、身体变化、跌倒自查到期都要做" : "建档时要做"}）`);
    lines.push("第一部分 问卷（看医生之前可以做，原话照念）：");
    for (const q of fr.questions) lines.push(`  ${q.id}（${q.clause}，问${q.who}${q.part === "严重程度" ? "；一般性有\"是\"或说不清才问" : ""}）：${q.quotes.map((x) => x.text).join("")}`);
    lines.push(`  衰弱 5 条（${fr.frailMin} 条及以上算"是"）：${fr.frail.map((x) => `${x.id}「${x.quotes.map((q) => q.text).join("")}」`).join("；")}`);
    lines.push("  另问：needsSupport（在家走路也要扶墙或用助行器）、hardToStand（扶着椅子也很难自己站起来）、dizzy（经常头晕，或者站起来时眼前发黑）");
    const dz = (profile.screening?.answers ?? []).find((x: Obj) => /经常头晕/.test(x?.item ?? ""));
    if (dz) lines.push(`  （档案现在的安全筛查"经常头晕"是"${dz.answer}"，${profile.screening?.date ?? "没写日期"} 做的：问卷要和它对得上，不一样的先照实重做筛查；测步态那天有效的筛查是"是"的不在家测）`);
    lines.push("第二部分 步态（医生同意以后、家人在场时做；过去 12 个月跌倒过、高风险（含正式评估说高风险）、走路要扶、站起困难、经常头晕的不在家测）：");
    const before = "测之前照成品第〇章《跌倒风险自查》\"测之前\"那几条做：一人护在身边、一人计时，只有一个家人的先护后计时，护不过来就不测；地面防滑、清空、光线够，终点线外留减速的地方；穿包脚防滑的鞋，平时用手杖的照用；不把判定线念给老人听；头晕、腿软、身体晃立刻停下坐好";
    lines.push(`  ${before}`);
    const gaitText = (g: (typeof fr.gait)[number]) => g.id === "walk4m"
      ? `${g.distance} m，喊"开始"的同时按表、前脚脚跟超过终点线停表，用时超过 ${(g.distance ?? 4) / g.line} 秒阳性`
      : `背离开椅背时按表、背靠到椅背上时停表，超过 ${g.line} 秒阳性`;
    for (const g of fr.gait) lines.push(`  ${g.id}：${gaitText(g)}（按留余量的线 ${g.margin} 秒）；记 seconds（往大里取一位小数）、cane、siteOk${g.id === "tug" ? "、chairOk（有扶手和靠背、无轮子、约 46 cm）" : ""}、testedOn`);
    lines.push("  测不了写 { result: \"没测成\", reason }（中途停下的写 stopReason）；按规则不测写 { result: \"按规则不测\", reason }。");
    lines.push(`  看过结果的医生同意写 fallRiskSeen: true（同意的日期要在问卷之后 ${fr.askedValidDays} 天以内）；正式评估写 official { date, afterFall, level? }——自查前后 ${fr.officialRecentDays} 天以内的等级才并进结论`);

    // 结构化：问卷、衰弱、另问、步态、医生看过、正式评估
    const generalIds = new Set<string>(["fell", "unsteady", "fear"]);
    const unsure = new Set<string>(["unsteady", "fear"]);
    const anyGeneralYes: ShowIf[] = [...generalIds].map((id) => ({ key: `fallRisk.general.${id}`, in: [true, null] }));
    const ask: FormSection = { id: "fallRisk.ask", title: "跌倒风险自查 · 问卷（照 WS/T 887—2026，原话照念）", notes: [
      "这是在家做的自查，不是正式评估；结论只决定先不先问医生、要不要先做正式评估、多久再查",
      "只记每问的是 / 否，不记病名、用药、体重数字",
      ...(dz ? [`档案现在的安全筛查"经常头晕"是"${dz.answer}"：问卷要和它对得上，不一样的先照实重做筛查`] : []),
    ], fields: [{ key: "fallRisk.askedOn", label: "问卷做的日期", required: true, input: { type: "date" } }] };
    for (const q of fr.questions) {
      const text = q.quotes.map((x) => x.text).join("");
      if (generalIds.has(q.id)) {
        ask.fields.push({ key: `fallRisk.general.${q.id}`, label: `${text}（问${q.who}）`, required: true, input: unsure.has(q.id) ? { type: "yesnoUnsure" } : { type: "yesno" } });
      } else if ((SEVERITY as readonly string[]).includes(q.id)) {
        ask.fields.push({ key: `fallRisk.severity.${q.id}`, label: `${text}（问${q.who}）`, required: true, input: { type: "yesno" }, showIf: anyGeneralYes });
      }
    }
    for (const x of fr.frail) {
      if (!(FRAIL as readonly string[]).includes(x.id)) continue;
      ask.fields.push({ key: `fallRisk.frail.${x.id}`, label: x.quotes.map((q) => q.text).join(""), required: true, input: { type: "yesno" }, showIf: anyGeneralYes,
        note: `衰弱 5 条，${fr.frailMin} 条及以上算"是"` });
    }
    ask.fields.push(
      { key: "fallRisk.needsSupport", label: "在家走路也要扶墙或用助行器", required: true, input: { type: "yesno" } },
      { key: "fallRisk.hardToStand", label: "扶着椅子也很难自己站起来", required: true, input: { type: "yesno" } },
      { key: "fallRisk.dizzy", label: "经常头晕，或者站起来时眼前发黑", required: true, input: { type: "yesno" } },
    );
    sections.push(ask);
    const gait: FormSection = { id: "fallRisk.gait", title: "跌倒风险自查 · 步态（医生同意以后、家人在场时做）", notes: [
      "过去 12 个月跌倒过、高风险（含正式评估说高风险）、走路要扶、站起困难、经常头晕的不在家测",
      before,
      "不把判定线念给老人听",
    ], fields: [] };
    for (const g of fr.gait) {
      gait.fields.push({ key: `fallRisk.${g.id}`, label: g.id === "walk4m" ? `4 米走（${g.distance ?? 4} m）` : "起立行走（TUG）", required: true,
        input: { type: "gait", chair: g.id === "tug", untested: [...UNTESTED], skipped: [...SKIPPED], stops: [...STOPS] },
        note: g.id === "walk4m" ? "喊\"开始\"的同时按表、前脚脚跟超过终点线停表；秒数往大里取一位小数" : "背离开椅背时按表、背靠到椅背上时停表；椅子要有扶手和靠背、无轮子、约 46 cm；秒数往大里取一位小数" });
    }
    sections.push(gait);
    sections.push({ id: "fallRisk.doctor", title: "医生、正式评估", notes: [
      `看过结果的医生同意，日期要在问卷之后 ${fr.askedValidDays} 天以内`,
      `正式评估：自查前后 ${fr.officialRecentDays} 天以内的等级才并进结论`,
    ], fields: [
      { key: "fallRiskSeen", label: "医生看过这次自查的结果、同意了吗", required: false, input: { type: "yesno" } },
      { key: "official.date", label: "正式跌倒风险评估的日期（做过才填）", required: false, input: { type: "date" } },
      { key: "official.afterFall", label: "正式评估是在最近一次摔倒之后做的吗", required: false, input: { type: "yesno" }, showIf: [{ key: "official.date", in: ["*"] }] },
      { key: "official.level", label: "医生说的等级", required: false, input: { type: "enum", options: ["低", "中", "高"].map((x) => ({ value: x, label: x })) }, showIf: [{ key: "official.date", in: ["*"] }] },
    ] });
  }

  if (kind === "周期末") {
    const segs = profile.segments as Obj[];
    const stableNs = [...new Set(segs.filter((x) => x.phase === "稳定").map((x) => x.n))] as number[];
    const done = stableNs.filter((n) => segs.some((x) => x.n === n && x.week === (t.rules?.stable?.cycleWeeks ?? 12)));
    const n = done.length ? done[done.length - 1] : stableNs[stableNs.length - 1];
    const end = done.length ? cycleEnd(ctx, n) : null;
    if (!end) summary.push(`周期末结论：现在是稳定期第 ${seg?.week} 周，第 ${t.rules?.stable?.cycleWeeks ?? 12} 周的周复盘做完才算`);
    else if ("error" in end) summary.push(`周期末结论：${end.error}`);
    else {
      summary.push(`第 ${n} 段（稳定期）：12 周训练 ${end.trainings} 次；达标周数 ${Object.entries(end.habitWeeks).map(([h, w]) => `${h} ${w}`).join("、")}`);
      const a65 = productInfo(t.manifest, (segs.find((x: Obj) => x.n === n) ?? {}).product)?.age === "a65";
      summary.push(`结论：${end.result}；下一段：${end.next.phase === "不开" ? "先不开：周期末以后看医生，做触发评估\"看完医生回来\"写明 doctorRestart（true 回起始期第 1 周；false 照后面几条再算一次）"
        : end.next.phase === "稳定" ? `下一周期${end.next.hold ? (a65 ? "（第一轮不加项）" : "（第一轮不升级）") : ""}` : `回起始期${end.next.type}段`}`);
      for (const q of end.quotes) summary.push(`  原文：${q}`);
      if (end.next.phase === "稳定") {
        const cg = cycleGoals(ctx, n);
        if (cg) {
          summary.push(`下一周期能选的目标（还没算周期末量的体重腰围；写好记录再跑一次，结论的 goals 照重算的写）：${cg.goals.join("、")}——${cg.why}。选减脂、增肌的，照第八章开头原话问一次进食困扰（eatingCheck），记 goal`);
          if (["a18", "a40"].includes(info.age)) {
            sections.push({ id: "goal", title: "下一周期的目标", notes: [cg.why, "选减脂、增肌之前，照成品第八章开头的原话问一次进食困扰：只记\"问过\"或\"只能保持\"，不记答案"], fields: [
              { key: "goal", label: "下一周期选什么目标", required: true, input: { type: "enum", options: cg.goals.map((g) => ({ value: g, label: g })) } },
              { key: "eatingCheck", label: "进食困扰那一问", required: true, input: { type: "enum", options: [{ value: "问过", label: "问过（答了没有）" }, { value: "只能保持", label: "只能保持（答了有，不记答案）" }] },
                showIf: [{ key: "goal", in: ["减脂", "增肌"] }] },
            ] });
          }
        }
      }
    }
  }
  if (kind === "段末" && seg) {
    const n = seg.week === 4 || seg.n === 1 ? seg.n : seg.n - 1;
    if (n !== seg.n) summary.push(`（第 ${seg.n} 段已经开了，这里算的是第 ${n} 段的段末）`);
    const end = segmentEnd(profile, n, bundle.reviewData, ar, info.code);
    if ("error" in end) summary.push(`段末结论：${end.error}`);
    else {
      const capW = param(ar.assess, seg.type === "减量" ? "减量段每周排的训练" : "每周排的训练", info.code)?.value;
      const hab = Object.entries(end.numbers.habits).map(([h, xs]) => `${h} ${xs.map((x) => x.days).join("/")}`).join("；");
      summary.push([capW ? `四周训练 ${end.numbers.trainings}（每周最多算 ${capW} 次）` : "", hab ? `打卡：${hab}` : "",
        end.numbers.sick ? `生病 ${end.numbers.sick} 天` : "", end.numbers.falls ? `摔倒、差点摔倒、头晕 ${end.numbers.falls} 次` : "",
        end.numbers.symptoms ? "这一段有过不适" : ""].filter(Boolean).join("；"));
      summary.push(`结论：${end.result}${end.downgraded ? "（有不适，往上的结论降为原样）" : ""}；下一段：${end.next}${end.extras.length ? `；附加：${end.extras.join("、")}` : ""}${Object.keys(end.habitTargets).length ? `；习惯目标 ${JSON.stringify(end.habitTargets)}` : ""}`);
      for (const q of end.quotes) summary.push(`  原文：${q}`);
      if (end.next === "不开") {
        const after = segmentEnd(profile, n, bundle.reviewData, ar, info.code, { afterDoctor: true });
        if (!("error" in after)) summary.push(`医生同意、做了"看完医生回来"的触发评估以后：照后面几条走——${after.result}${after.downgraded ? "（往上的降级）" : ""}；下一段：${after.next}${Object.keys(after.habitTargets).length ? `；习惯目标 ${JSON.stringify(after.habitTargets)}` : ""}`);
      }
    }
  }
  lines.push(...summary);
  return form;
}

/** 这一项现在要不要问（showIf 任一条成立；"*" 表示那一项填了任何值）。 */
export function fieldVisible(field: FormField, values: Record<string, unknown>): boolean {
  if (!field.showIf?.length) return true;
  return field.showIf.some((c) => {
    const v = values[c.key];
    if (c.in.includes("*")) return v !== undefined && v !== "" && v !== null;
    return Array.isArray(v) ? v.some((x) => c.in.includes(x)) : c.in.includes(v as never);
  });
}

/** 表单里要填、现在却没填的项（只看现在要问的）。 */
export function missingFields(form: AssessmentForm, values: Record<string, unknown>): FormField[] {
  return form.sections.flatMap((s) => s.fields).filter((f) => f.required && !f.readonly && fieldVisible(f, values)
    && (values[f.key] === undefined || values[f.key] === "" || (Array.isArray(values[f.key]) && !(values[f.key] as unknown[]).length)
      || (f.input.type === "gait" && !gaitComplete(values[f.key], f.input.chair))));
}

/**
 * 步态一项填完了没有：测了的要有秒数、测的日期，用没用手杖、场地合不合格（起立行走另有椅子合不合格）都答了（不替人预答"否"）；
 * 没测成的要有原因（中途停下的还要停下的原因）；按规则不测的要有原因。
 */
export function gaitComplete(v: unknown, chair: boolean): boolean {
  if (typeof v !== "object" || v === null) return false;
  const g = v as Record<string, unknown>;
  if (g.result === "没测成") return typeof g.reason === "string" && (g.reason !== "中途停下" || typeof g.stopReason === "string");
  if (g.result === "按规则不测") return typeof g.reason === "string";
  return typeof g.seconds === "number" && g.seconds > 0 && typeof g.testedOn === "string" && g.testedOn !== ""
    && typeof g.cane === "boolean" && typeof g.siteOk === "boolean" && (!chair || typeof g.chairOk === "boolean");
}

/**
 * 把表单填的值（键是 FormField.key）组装成评估记录（yangxia.assessment/1，不含 conclusion：由服务端重算）。
 * 不问的项（showIf 不成立）不写；测试项 tests.<id>.<字段> 合成 tests 数组；健身房重量按个人进度一项一条；
 * 摔倒的多个日期写 eventDates，最近那次同时写 eventDate。
 */
export function buildAssessmentRecord(form: AssessmentForm, values: Record<string, unknown>, date: string, opts: { switched?: boolean } = {}): Record<string, unknown> {
  const rec: Record<string, any> = { schema: ASSESS_FORMAT, date, kind: form.kind };
  if (form.segment !== null && (form.kind === "段末" || form.kind === "周期末")) rec.segment = form.segment;
  const tests = new Map<string, Record<string, unknown>>();
  const gym: Record<string, unknown>[] = [];
  const set = (path: string, v: unknown) => {
    const parts = path.split(".");
    let o = rec;
    for (const p of parts.slice(0, -1)) o = o[p] ??= {};
    o[parts[parts.length - 1]] = v;
  };
  for (const f of form.sections.flatMap((s) => s.fields)) {
    if (!fieldVisible(f, values)) continue;
    const v = f.readonly ? f.value : values[f.key];
    if (v === undefined || v === "") continue;
    if (f.key.startsWith("tests.gym-weights.")) { gym.push({ id: "gym-weights", move: f.key.slice("tests.gym-weights.".length), value: v }); continue; }
    if (f.key.startsWith("tests.")) {
      const [, id, field] = f.key.split(".");
      const tt = tests.get(id) ?? { id };
      tt[field] = v;
      tests.set(id, tt);
      continue;
    }
    if (f.key === "eventDates" && Array.isArray(v)) {
      // 空行不算一个日期
      const ds = [...new Set((v as unknown[]).filter((d): d is string => typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d)))].sort();
      if (!ds.length) continue;
      if (ds.length > 1) rec.eventDates = ds;
      rec.eventDate = ds[ds.length - 1];
      continue;
    }
    set(f.key, v);
  }
  if (tests.size || gym.length) rec.tests = [...tests.values(), ...gym];
  // 跨段、换场地的触发评估：product 写新成品（表单是按新成品取的）
  if (opts.switched) rec.product = form.product;
  return rec;
}
