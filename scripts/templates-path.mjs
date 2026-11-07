// 找模板仓库（YangXia-templates）的唯一规则：环境变量 YANGXIA_TEMPLATES，没设就用 ./templates。
// 核心库、hook、setup 都用这里，不要在别处写死路径。
// 命令行用法：node scripts/templates-path.mjs   → 打印路径；找不到时退出码 1 并说明怎么放进去。
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** 返回模板仓库的绝对路径；找不到（目录不存在或不像模板仓库）时返回 null。 */
export function templatesDir() {
  const dir = process.env.YANGXIA_TEMPLATES
    ? resolve(process.env.YANGXIA_TEMPLATES)
    : join(REPO_ROOT, "templates");
  return existsSync(join(dir, "tpl.py")) ? dir : null;
}

export const MISSING_HINT =
  "没找到模板仓库 YangXia-templates：把它放在主仓库的 templates/ 目录下（它是独立的 git 仓库，主仓库已忽略这个目录），" +
  "或者设置环境变量 YANGXIA_TEMPLATES 指向它。";

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dir = templatesDir();
  if (dir) {
    console.log(dir);
  } else {
    console.error(MISSING_HINT);
    process.exit(1);
  }
}
