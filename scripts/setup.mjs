// npm run setup：新克隆后运行一次。
// 1. 主仓库启用提交前检查（core.hooksPath = .githooks）
// 2. 找到模板仓库就也替它启用（python3 tpl.py setup）；找不到就说明怎么放进去
import { chmodSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { MISSING_HINT, REPO_ROOT, templatesDir } from "./templates-path.mjs";

chmodSync(join(REPO_ROOT, ".githooks", "pre-commit"), 0o755);
execFileSync("git", ["config", "core.hooksPath", ".githooks"], { cwd: REPO_ROOT, stdio: "inherit" });
console.log("主仓库：已启用提交前检查（core.hooksPath = .githooks）。");

const tpl = templatesDir();
if (tpl) {
  execFileSync("python3", ["tpl.py", "setup"], { cwd: tpl, stdio: "inherit" });
  console.log(`模板仓库：${tpl}`);
} else {
  console.warn(`模板仓库：${MISSING_HINT}`);
}
