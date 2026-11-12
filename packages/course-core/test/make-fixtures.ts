// 从真实模板生成测试样例（模板更新后重新运行）：
//   node packages/course-core/test/make-fixtures.ts
// 输出 contracts/fixtures/manifest.json（只留样例课程用到的成品和动作，红线规则全留）
// 和 contracts/fixtures/products/<成品名>.md（只留样例课程原文、训练单出处原文所在的行），
// 以及 contracts/fixtures/data/plans.json、rules.json（训练单只留 PLAN_PRODUCTS 这几份成品）。
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadTemplates, requirePlans } from "../src/node.ts";
import type { Course } from "../src/types.ts";

const FIX = new URL("../../../contracts/fixtures/", import.meta.url).pathname;
const plain = (s: string) => s.replace(/\*\*/g, "").replace(/\s+/g, " ").trim();

const t = await loadTemplates();
const courses = readdirSync(join(FIX, "courses"))
  .filter((f) => f.startsWith("ok-"))
  .map((f) => JSON.parse(readFileSync(join(FIX, "courses", f), "utf8")) as Course);

// 训练单的离线样例只留这几份（导出、进度规则的测试用）；成品正文同时摘出训练单的出处原文
const PLAN_PRODUCTS = ["18-39岁-居家版", "18-39岁-纯徒手版", "18-39岁-纯徒手版（稳定期）", "40-64岁-纯徒手版", "40-64岁-纯徒手版（稳定期）", "18-39岁-健身房版", "18-39岁-健身房版（稳定期）", "13-17岁-纯徒手版", "65岁以上-椅子辅助版"];
const { plans, rules } = requirePlans(t);
// 评估的测试还要 6–12 岁版（没有训练单，只用 manifest 里的成品信息）
const EXTRA_PRODUCTS = ["6-12岁-户外与游戏版（家长版）"];
const products = new Set([...courses.map((c) => c.source.product), ...PLAN_PRODUCTS, ...EXTRA_PRODUCTS]);
const exerciseIds = new Set(courses.flatMap((c) => c.blocks.flatMap((b) => b.items.map((i) => i.exercise))));
for (const name of PLAN_PRODUCTS) {
  const p = plans.products[name];
  for (const r of p.rows) r.moves.forEach((mv) => exerciseIds.add(mv));
  for (const l of Object.values(p.ladders).flat()) exerciseIds.add(l.exercise);
}
const planQuotes = (name: string) => (PLAN_PRODUCTS.includes(name) ? plans.products[name].rows.flatMap((r) =>
  [...Object.values(r.evidence ?? {}).flat(), ...r.quotes.map((q) => q.text)]).map(plain) : []);
const quotes = courses.flatMap((c) => c.blocks.flatMap((b) => b.items.flatMap((i) => i.quote.map(plain))));

const m = t.manifest;
const manifest = {
  ...m,
  products: m.products.filter((p) => products.has(p.name)),
  exercises: m.exercises
    .filter((e) => exerciseIds.has(e.id))
    .map((e) => ({ ...e, used_in: e.used_in.filter((u) => products.has(u.product)) })),
};
delete (manifest as Record<string, unknown>).figures;
// 官方参数只留评估要用的 BMI 切点（低体重、超重、肥胖）
(manifest as Record<string, unknown>).params = ((m as unknown as { params: { id: string }[] }).params ?? []).filter((x) => ["BMI_CN", "WEIGHT_LOW_CN"].includes(x.id));
writeFileSync(join(FIX, "manifest.json"), JSON.stringify(manifest, null, 1) + "\n");

mkdirSync(join(FIX, "products"), { recursive: true });
for (const name of products) {
  if (EXTRA_PRODUCTS.includes(name)) continue;
  const lines = (t.readProduct(name) ?? "").split("\n");
  // 原文所在的行；表格行再带上它的表头和分隔行（课程检查要靠表头判断那一格是第几周）
  const idx = new Set<number>();
  const qs = [...quotes, ...planQuotes(name)];
  lines.forEach((line, i) => {
    if (!qs.some((q) => plain(line).includes(q))) return;
    idx.add(i);
    if (!line.trim().startsWith("|")) return;
    let j = i - 1;
    while (j >= 0 && lines[j].trim().startsWith("|") && !/^\s*\|[\s|:-]+\|\s*$/.test(lines[j])) j--;
    if (j >= 1 && /^\s*\|[\s|:-]+\|\s*$/.test(lines[j])) {
      idx.add(j);
      idx.add(j - 1);
    }
  });
  const keep = [...idx].sort((a, b) => a - b).map((i) => lines[i]);
  writeFileSync(join(FIX, "products", `${name}.md`),
    `<!-- 测试样例：从模板成品「${name}」摘出的原文行，由 packages/course-core/test/make-fixtures.ts 生成，不要手改 -->\n${keep.join("\n")}\n`);
  console.log(`${name}：摘了 ${keep.length} 行`);
}
mkdirSync(join(FIX, "data"), { recursive: true });
const planFix = { ...plans, products: Object.fromEntries(PLAN_PRODUCTS.map((n) => [n, plans.products[n]])) };
writeFileSync(join(FIX, "data", "plans.json"), JSON.stringify(planFix) + "\n");
writeFileSync(join(FIX, "data", "rules.json"), JSON.stringify(rules, null, 1) + "\n");
console.log(`manifest：${manifest.products.length} 份成品、${manifest.exercises.length} 个动作，模板版本 ${m.version}`);
console.log(`训练单：${PLAN_PRODUCTS.length} 份成品`);
