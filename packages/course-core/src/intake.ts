// 入口问卷的规则，全部取自模板 manifest 的 intake：阶段 → 年龄段、上床时间公式、各年龄段的筛查项。
// 建档时 agent 照这些规则问；档案写好后，这里逐项核对档案和模板对得上。
import type { Manifest } from "./manifest.ts";
import type { Issue } from "./types.ts";

type Obj = Record<string, any>;

/** 按公式算上床时间：起床时间 − 目标睡眠 − 入睡缓冲。阶段不覆盖或时间格式不对时返回 null。 */
export function bedtimeFor(m: Manifest, stage: string, wake: string): string | null {
  const st = m.intake.stages.find((x) => x.stage === stage);
  const t = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(wake ?? "");
  if (!st || !st.age || st.sleep_hours === undefined || !t) return null;
  let min = Number(t[1]) * 60 + Number(t[2]) - Math.round(st.sleep_hours * 60) - m.intake.bedtime.buffer_minutes;
  min = ((min % 1440) + 1440) % 1440;
  return `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
}

/** 这个年龄段的安全筛查项（逐字取自成品"先问医生"一节）。 */
export function screeningFor(m: Manifest, age: string) {
  return m.intake.screening.find((s) => s.age === age) ?? null;
}

/**
 * 筛查项里属于"不覆盖的人群"（问卷里建议写着"不覆盖"的那几类，如孕期、产后 6 个月内）的项：
 * 答"是"就不出计划，医生同意了也一样——那是另一套方案的事，不是这份模板。
 */
export function notCoveredItems(m: Manifest, age: string): { item: string; group: string; advice: string }[] {
  const groups = ((m.intake as { not_covered?: { group: string; advice: string }[] }).not_covered ?? [])
    .filter((g) => g.advice.includes("不覆盖"));
  const out: { item: string; group: string; advice: string }[] = [];
  for (const item of screeningFor(m, age)?.items ?? []) {
    const g = groups.find((g) => g.group.replace(/（[^）]*）/g, "").split("、").some((k) => k.trim().length >= 2 && item.includes(k.trim())));
    if (g) out.push({ item, group: g.group, advice: g.advice });
  }
  return out;
}

/**
 * 档案和模板对得上吗：
 * - 阶段属于模板覆盖的人群，年龄段和阶段一致；
 * - 成品存在，年龄段、场地和档案一致（全家餐饮模板不是个人计划）；
 * - 筛查逐项答了这个年龄段的每一条，原话一字不改，不多不少；属于"不覆盖的人群"的项答"是"就不出计划；
 * - 上床时间等于公式算出来的时间。
 */
export function checkProfileWithTemplates(raw: unknown, m: Manifest): Issue[] {
  const out: Issue[] = [];
  const err = (path: string, message: string) => out.push({ level: "error", path, message });
  if (typeof raw !== "object" || raw === null) return out;
  const p = raw as Obj;

  const st = m.intake.stages.find((x) => x.stage === p.stage);
  if (st && !st.age) err("stage", `模板不覆盖「${p.stage}」：不建档、不出计划，照问卷"不覆盖的人群"建议先问医生`);
  else if (st && st.age !== p.age) err("age", `阶段「${p.stage}」对应的年龄段是 ${st.age}，档案写的是 ${p.age}`);

  const product = m.products.find((x) => x.name === p.product);
  if (typeof p.product === "string" && p.product) {
    if (!product) err("product", `模板里没有成品「${p.product}」`);
    else if (product.age === "fam") err("product", "全家餐饮模板不是个人计划：档案选这个人自己的成品，菜单写在档案目录的 菜单/ 下");
    else if ((product as Obj).phase === "附册") err("product", `「${product.name}」是附册，不是计划：档案选这个人自己的纯徒手、居家或健身房版，附册配合着看`);
    else {
      if (product.age !== p.age) err("product", `成品「${product.name}」的年龄段是 ${product.age}，档案是 ${p.age}`);
      if (p.venue !== undefined && product.venue !== p.venue) err("venue", `成品「${product.name}」的场地是 ${product.venue}，档案写的是 ${p.venue}`);
    }
  }

  (Array.isArray(p.segments) ? p.segments : []).forEach((s: Obj, i: number) => {
    const sp = m.products.find((x) => x.name === s?.product);
    if (sp && (sp as Obj).phase === "附册") err(`segments[${i}].product`, `「${sp.name}」是附册，不能当成一段的成品`);
  });
  const sc = screeningFor(m, p.age);
  const answers: Obj[] = Array.isArray(p.screening?.answers) ? p.screening.answers : [];
  if (sc) {
    const given = answers.map((a) => (typeof a?.item === "string" ? a.item : ""));
    const missing = sc.items.filter((x) => !given.includes(x));
    const unknown = given.filter((x) => !sc.items.includes(x));
    const dup = given.filter((x, i) => given.indexOf(x) !== i);
    if (missing.length) err("screening.answers", `${p.age} 的筛查少答了 ${missing.length} 项（要照原话逐项问）：${missing.join("；")}`);
    if (unknown.length) err("screening.answers", `不是 ${p.age} 筛查项的原话：${unknown.join("；")}`);
    if (dup.length) err("screening.answers", `筛查项重复：${[...new Set(dup)].join("；")}`);
    for (const nc of notCoveredItems(m, p.age)) {
      if (answers.some((a) => a?.item === nc.item && a?.answer === "是")) {
        err("screening.answers", `「${nc.item}」答了"是"：${nc.group}——${nc.advice}，不出计划（医生同意也一样）`);
      }
    }
  }

  if (typeof p.wake === "string" && typeof p.bedtime === "string" && st?.age) {
    const want = bedtimeFor(m, p.stage, p.wake);
    if (want && want !== p.bedtime) err("bedtime", `${p.stage}、${p.wake} 起床，按公式上床时间是 ${want}，档案写的是 ${p.bedtime}（用 npm run course -- bedtime 算）`);
  }
  return out;
}
