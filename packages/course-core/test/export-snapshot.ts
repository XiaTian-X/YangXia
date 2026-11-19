// 导出快照：把"所有情形"的导出结果存下来，改代码或模板之后逐项比，证明没选新动作的人不受影响。
//   npm run snapshot -- write <快照.json.gz>     生成基线（要在改动之前、用上一发布版模板生成）
//   npm run snapshot -- compare <快照.json.gz> [--ignore 字段,字段] [--allow-figure]   和基线逐项比，已有情形变了或消失了退出码 1；
//     只差动作示意（figure）的变化单独汇总，按成品、动作、名称列出；--allow-figure 时这类变化不算失败（补图批次用）
//   npm run snapshot -- check                    全量导出，每个情形都过课程检查（发版前跑，约 8 分钟）
// 比的是课程内容、follow、notes、issues；模板版本号不比。基线不提交。
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { gunzipSync, gzipSync } from "node:zlib";
import { checkCourse } from "../src/check.ts";
import { loadTemplates, requirePlans } from "../src/node.ts";
import { exportCourse } from "../src/plan.ts";
import { sweepCases, type SweepCase, type SweepSource } from "./sweep.ts";

const FORMAT = "yangxia.export-snapshot/1";
type Obj = Record<string, unknown>;

function strip(v: unknown, drop: Set<string>): unknown {
  if (Array.isArray(v)) return v.map((x) => strip(x, drop));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v as Obj).filter(([k]) => !drop.has(k)).map(([k, x]) => [k, strip(x, drop)]));
  return v;
}

function result(c: SweepCase, drop: Set<string>): string {
  const r = exportCourse(c.input);
  const course = r.course ? { ...r.course, source: { ...r.course.source, templates: undefined } } : null;
  return JSON.stringify(strip({ course, follow: r.follow, notes: r.notes, issues: r.issues }, drop));
}

const sha = (s: string) => createHash("sha1").update(s).digest("hex").slice(0, 16);

/** 第一处不同：返回路径和两边的值，方便定位。 */
function firstDiff(a: unknown, b: unknown, path = ""): string {
  if (JSON.stringify(a) === JSON.stringify(b)) return "";
  if (a && b && typeof a === "object" && typeof b === "object") {
    for (const k of new Set([...Object.keys(a as Obj), ...Object.keys(b as Obj)])) {
      const d = firstDiff((a as Obj)[k], (b as Obj)[k], path ? `${path}.${k}` : k);
      if (d) return d;
    }
  }
  return `${path}：基线 ${JSON.stringify(a)?.slice(0, 120)}，现在 ${JSON.stringify(b)?.slice(0, 120)}`;
}

async function source(): Promise<SweepSource & { readProduct: (name: string) => string | null }> {
  const t = await loadTemplates();
  const { plans, rules } = requirePlans(t);
  return { plans, rules, manifest: t.manifest, readProduct: t.readProduct };
}

function write(file: string, src: SweepSource) {
  const bodies: Record<string, string> = {};
  const cases: [string, string][] = [];
  const none = new Set<string>();
  for (const c of sweepCases(src)) {
    const body = result(c, none);
    const h = sha(body);
    bodies[h] = body;
    cases.push([c.key, h]);
  }
  writeFileSync(file, gzipSync(JSON.stringify({ format: FORMAT, templates: src.plans.version, cases, bodies })));
  console.log(`已写入 ${file}：模板 ${src.plans.version}，${cases.length} 种情形，${Object.keys(bodies).length} 种不同结果`);
  return 0;
}

const FIG = new Set(["figure"]);

/** 只差 figure 时，列出每一项：动作 名称 旧图号 → 新图号。 */
function figureDiffs(a: any, b: any): string[] {
  const items = (r: any) => (r.course?.blocks ?? []).flatMap((x: any) => x.items);
  const ia = items(a), ib = items(b);
  return ib.flatMap((it: any, k: number) => (it.figure !== ia[k]?.figure ? [`${it.exercise}「${it.name}」${ia[k]?.figure ?? "（无）"} → ${it.figure ?? "（无）"}`] : []));
}

function compare(file: string, src: SweepSource, ignore: string[], allowFigure = false) {
  const base = JSON.parse(gunzipSync(readFileSync(file)).toString("utf8")) as { format: string; templates: string; cases: [string, string][]; bodies: Record<string, string> };
  if (base.format !== FORMAT) throw new Error(`快照格式不对：${base.format}`);
  const drop = new Set(ignore);
  const want = new Map(base.cases);
  const seen = new Set<string>();
  const changed: string[] = [];
  const figureOnly = new Map<string, number>();
  const added: string[] = [];
  let same = 0;
  for (const c of sweepCases(src)) {
    seen.add(c.key);
    const old = want.get(c.key);
    if (old === undefined) {
      added.push(c.key);
      continue;
    }
    const now = result(c, drop);
    const was = drop.size ? JSON.stringify(strip(JSON.parse(base.bodies[old]), drop)) : base.bodies[old];
    if (now === was) same++;
    else if (!drop.has("figure") && JSON.stringify(strip(JSON.parse(was), FIG)) === JSON.stringify(strip(JSON.parse(now), FIG))) {
      for (const d of figureDiffs(JSON.parse(was), JSON.parse(now))) figureOnly.set(`${c.product} ${d}`, (figureOnly.get(`${c.product} ${d}`) ?? 0) + 1);
    } else changed.push(`${c.key}\n    ${firstDiff(JSON.parse(was), JSON.parse(now))}`);
  }
  const removed = base.cases.map(([k]) => k).filter((k) => !seen.has(k));
  const figureCases = [...figureOnly.values()].reduce((a, b) => a + b, 0);
  console.log(`基线模板 ${base.templates}，现在 ${src.plans.version}：相同 ${same}，变化 ${changed.length}，只差动作示意 ${figureCases} 处，新增情形 ${added.length}，消失情形 ${removed.length}`);
  for (const [k, n] of [...figureOnly].sort()) console.log(`只差动作示意：${k}（${n} 处）`);
  for (const s of changed.slice(0, 20)) console.log(`变化：${s}`);
  for (const s of removed.slice(0, 20)) console.log(`消失：${s}`);
  for (const s of added.slice(0, 20)) console.log(`新增：${s}`);
  // 新增情形（新动作、新选项带来的）不算失败；已有情形变了、消失了才算
  return changed.length || removed.length || (figureCases && !allowFigure) ? 1 : 0;
}

function check(src: SweepSource & { readProduct: (name: string) => string | null }) {
  let n = 0;
  const bad: string[] = [];
  for (const c of sweepCases(src)) {
    n++;
    const r = exportCourse(c.input);
    const errs = r.issues.filter((i) => i.level === "error");
    const chk = r.course
      ? checkCourse(r.course, { manifest: src.manifest, readProduct: src.readProduct, profile: c.input.profile, plans: src.plans, rules: src.rules, addOns: c.input.addOns }).filter((i) => i.level === "error")
      : [];
    if (errs.length || chk.length) bad.push(`${c.key}：${[...errs, ...chk].map((i) => i.message).join(" | ").slice(0, 200)}`);
  }
  console.log(`全量导出 ${n} 种情形，${bad.length} 种有错误`);
  for (const s of bad.slice(0, 20)) console.log(s);
  return bad.length ? 1 : 0;
}

const [cmd, file, ...rest] = process.argv.slice(2);
const src = await source();
const at = rest.indexOf("--ignore");
const ignore = at >= 0 ? (rest[at + 1] ?? "").split(",").filter(Boolean) : [];
if (cmd === "write" && file) process.exit(write(file, src));
if (cmd === "compare" && file) process.exit(compare(file, src, ignore, rest.includes("--allow-figure")));
if (cmd === "check") process.exit(check(src));
console.error("用法：export-snapshot.ts write <文件> | compare <文件> [--ignore 字段,字段] | check");
process.exit(2);
