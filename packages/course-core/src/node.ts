// 只在 Node 里用：按 scripts/templates-path.mjs 的规则找模板仓库，读 manifest 和成品正文。
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type Manifest, MANIFEST_FORMAT } from "./manifest.ts";

const REPO_ROOT = new URL("../../../", import.meta.url);

export async function templatesDir(): Promise<string | null> {
  const mod = (await import(new URL("scripts/templates-path.mjs", REPO_ROOT).href)) as { templatesDir: () => string | null };
  return mod.templatesDir();
}

export interface Templates {
  dir: string;
  manifest: Manifest;
  readProduct: (name: string) => string | null;
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
  return { dir, manifest, readProduct };
}
