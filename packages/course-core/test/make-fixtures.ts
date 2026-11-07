// 从真实模板生成测试样例（模板更新后重新运行）：
//   node packages/course-core/test/make-fixtures.ts
// 输出 contracts/fixtures/manifest.json（只留样例课程用到的成品和动作，红线规则全留）
// 和 contracts/fixtures/products/<成品名>.md（只留样例课程原文所在的行）。
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadTemplates } from "../src/node.ts";
import type { Course } from "../src/types.ts";

const FIX = new URL("../../../contracts/fixtures/", import.meta.url).pathname;
const plain = (s: string) => s.replace(/\*\*/g, "").replace(/\s+/g, " ").trim();

const t = await loadTemplates();
const courses = readdirSync(join(FIX, "courses"))
  .filter((f) => f.startsWith("ok-"))
  .map((f) => JSON.parse(readFileSync(join(FIX, "courses", f), "utf8")) as Course);

const products = new Set(courses.map((c) => c.source.product));
const exerciseIds = new Set(courses.flatMap((c) => c.blocks.flatMap((b) => b.items.map((i) => i.exercise))));
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
delete (manifest as Record<string, unknown>).params;
writeFileSync(join(FIX, "manifest.json"), JSON.stringify(manifest, null, 1) + "\n");

mkdirSync(join(FIX, "products"), { recursive: true });
for (const name of products) {
  const lines = (t.readProduct(name) ?? "").split("\n");
  // 原文所在的行；表格行再带上它的表头和分隔行（课程检查要靠表头判断那一格是第几周）
  const idx = new Set<number>();
  lines.forEach((line, i) => {
    if (!quotes.some((q) => plain(line).includes(q))) return;
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
console.log(`manifest：${manifest.products.length} 份成品、${manifest.exercises.length} 个动作，模板版本 ${m.version}`);
