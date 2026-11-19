// 只在 Node 里用：按 scripts/templates-path.mjs 的规则找模板仓库，读 manifest 和成品正文。
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { MOTIONS_FORMAT, type MotionsData } from "./figure-motion.ts";
import { type Manifest, MANIFEST_FORMAT } from "./manifest.ts";
import { PLANS_FORMAT, type PlansData, RULES_FORMAT, type RulesData } from "./plan.ts";

const REPO_ROOT = new URL("../../../", import.meta.url);

export async function templatesDir(): Promise<string | null> {
  const mod = (await import(new URL("scripts/templates-path.mjs", REPO_ROOT).href)) as { templatesDir: () => string | null };
  return mod.templatesDir();
}

export interface Templates {
  dir: string;
  manifest: Manifest;
  readProduct: (name: string) => string | null;
  /** 训练单、规则参数（模板 dist/data/）。模板还没有这两个文件时是 null（v4 之前的模板）。 */
  plans: PlansData | null;
  rules: RulesData | null;
  /** 动作示意动图（dist/data/motions.json）。可选：v3.4 及以前的模板没有。 */
  motions: MotionsData | null;
}

/** 读模板发布物。找不到模板、或 manifest 格式不对时抛出说明。 */
export async function loadTemplates(): Promise<Templates> {
  const dir = await templatesDir();
  if (!dir) {
    throw new Error("没找到模板仓库：把 YangXia-templates 放在 templates/，或设置环境变量 YANGXIA_TEMPLATES");
  }
  const path = join(dir, "dist", "manifest.json");
  if (!existsSync(path)) throw new Error(`模板还没构建：${path} 不存在，先在模板仓库运行 python3 tpl.py all`);
  const manifest = JSON.parse(readFileSync(path, "utf8")) as Manifest;
  if (manifest.format !== MANIFEST_FORMAT) {
    throw new Error(`模板 manifest 的格式是「${manifest.format ?? "（没有）"}」，需要 ${MANIFEST_FORMAT}：请先更新模板仓库`);
  }
  const readProduct = (name: string) => {
    const f = join(dir, "dist", `${name}.md`);
    return existsSync(f) ? readFileSync(f, "utf8") : null;
  };
  const data = <T extends { format: string }>(file: string, format: string): T | null => {
    const f = join(dir, "dist", "data", file);
    if (!existsSync(f)) return null;
    const d = JSON.parse(readFileSync(f, "utf8")) as T;
    if (d.format !== format) throw new Error(`模板 ${file} 的格式是「${d.format}」，需要 ${format}：请先更新模板仓库`);
    return d;
  };
  // 动图是可选的：格式不认识时只是没有动图，不影响导出和检查
  let motions: MotionsData | null = null;
  try {
    motions = data<MotionsData>("motions.json", MOTIONS_FORMAT);
  } catch {
    motions = null;
  }
  return { dir, manifest, readProduct, plans: data<PlansData>("plans.json", PLANS_FORMAT), rules: data<RulesData>("rules.json", RULES_FORMAT), motions };
}

/** 训练单和规则参数：导出课程、核对进度要用，没有就提示先更新模板。 */
export function requirePlans(t: Templates): { plans: PlansData; rules: RulesData } {
  if (!t.plans || !t.rules) throw new Error("模板还没有训练单（dist/data/plans.json、rules.json）：先把模板仓库更新到 v4 阶段 1 之后，再运行 python3 tpl.py all");
  return { plans: t.plans, rules: t.rules };
}
