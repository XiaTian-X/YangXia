// Claude Code 每轮结束时的检查（.claude/settings.json 的 Stop hook）。只用 Node 自带功能。
// - 模板仓库的 content/、figures/、tools/ 有未提交改动 → 跑 python3 tpl.py all
// - 主仓库的 packages/、apps/、contracts/、scripts/、.claude/hooks/、.githooks/ 有未提交改动 → 跑单元测试（不跑 Playwright）
// - profiles/ 下的档案目录有新改动（比上次检查通过的时间新）→ 跑 npm run profile -- check。
//   profiles/ 被 .gitignore 排除，git status 看不到，所以按文件修改时间判断；检查都通过才更新 profiles/.stop-check。
// 有错就把错误交回给 agent 先修；同一轮已经因为检查失败被拦过一次（stop_hook_active）就不再拦，避免死循环。
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT, templatesDir } from "./templates-path.mjs";

let input = {};
try {
  input = JSON.parse(readFileSync(0, "utf8") || "{}");
} catch {
  /* 没有输入也照常检查 */
}
if (input.stop_hook_active) process.exit(0);

const changed = (cwd, paths) => {
  const r = spawnSync("git", ["status", "--porcelain", "--", ...paths], { cwd, encoding: "utf8" });
  return r.status === 0 && r.stdout.trim().length > 0;
};
const tail = (s, n = 25) => s.trim().split("\n").slice(-n).join("\n");
const failures = [];

const tpl = templatesDir();
if (tpl && changed(tpl, ["content", "figures", "tools"])) {
  const r = spawnSync("python3", ["tpl.py", "all"], { cwd: tpl, encoding: "utf8" });
  if (r.status !== 0) failures.push(`模板构建 / 校验没通过（python3 tpl.py all）：\n${tail(r.stdout + r.stderr)}`);
}
if (changed(REPO_ROOT, ["packages", "apps", "contracts", "scripts", ".claude/hooks", ".githooks"])) {
  const r = spawnSync("npx", ["vitest", "run"], { cwd: REPO_ROOT, encoding: "utf8" });
  if (r.status !== 0) failures.push(`单元测试没通过（npm test）：\n${tail(r.stdout + r.stderr)}`);
}

const profiles = join(REPO_ROOT, "profiles");
const stamp = join(profiles, ".stop-check");
const newest = (dir) => readdirSync(dir).reduce((t, f) => {
  const p = join(dir, f);
  const s = statSync(p);
  return Math.max(t, s.isDirectory() ? newest(p) : s.mtimeMs);
}, 0);
if (tpl && existsSync(profiles)) {
  const since = existsSync(stamp) ? statSync(stamp).mtimeMs : 0;
  const dirs = readdirSync(profiles)
    .map((d) => join(profiles, d))
    .filter((d) => statSync(d).isDirectory() && existsSync(join(d, "档案.json")) && newest(d) > since);
  const before = failures.length;
  for (const d of dirs) {
    const r = spawnSync("node", ["packages/course-core/src/cli.ts", "profile", "check", d], { cwd: REPO_ROOT, encoding: "utf8" });
    if (r.status !== 0) failures.push(`档案检查没通过（npm run profile -- check profiles/${d.slice(profiles.length + 1)}）：\n${tail(r.stdout + r.stderr)}`);
  }
  if (failures.length === before) writeFileSync(stamp, `${new Date().toISOString()}\n`);
}

if (failures.length) {
  process.stdout.write(JSON.stringify({ decision: "block", reason: `${failures.join("\n\n")}\n\n先修好再结束这一轮。` }));
}
process.exit(0);
