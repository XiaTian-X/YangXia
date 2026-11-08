// Claude Code PreToolUse hook（Bash）：拦下跳过提交前检查的 git 命令。只用 Node 自带功能。
// 主仓库和模板仓库用同一份脚本（.claude/hooks/guard-git.mjs），改了要两边同步。
//
// 拦：git commit --no-verify / -n（包括 -anm 这类合写、git -C 目录 commit -n）、git merge --no-verify、
//     任何带 core.hooksPath 的 git 命令或环境变量（-c、config、GIT_CONFIG_*）、git -c alias.*、
//     定义含 --no-verify 的别名、git commit-tree（不经提交前检查直接造提交）。
// 不拦：提交说明里出现的 "-n"（git commit -m "fix -n"）、git commit -uno。
// 写成 sh -c "…"、脚本文件里再调 git 的绕法，这里拦不住——规矩写在 AGENTS.md，提交前检查本身也会报。
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const SEP = Symbol("sep");

/** 按 shell 规则粗切：认单双引号、反斜杠，; & | 和换行是命令分隔。 */
export function tokenize(cmd) {
  const out = [];
  let cur = "";
  let has = false;
  let q = null;
  const push = () => {
    if (has) out.push(cur);
    cur = "";
    has = false;
  };
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (q) {
      if (c === q) q = null;
      else if (c === "\\" && q === '"' && i + 1 < cmd.length) cur += cmd[++i];
      else cur += c;
      continue;
    }
    if (c === "'" || c === '"') {
      q = c;
      has = true;
    } else if (c === "\\" && i + 1 < cmd.length) {
      cur += cmd[++i];
      has = true;
    } else if (/\s/.test(c) && c !== "\n") {
      push();
    } else if (c === ";" || c === "&" || c === "|" || c === "\n" || c === "(" || c === ")" || c === "`") {
      push();
      if (out[out.length - 1] !== SEP) out.push(SEP);
    } else {
      cur += c;
      has = true;
    }
  }
  push();
  return out;
}

const GLOBAL_WITH_VALUE = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--super-prefix", "--config-env"]);
const COMMIT_SHORT_WITH_VALUE = new Set(["m", "F", "C", "c", "t"]);
const COMMIT_SHORT_OPTIONAL = new Set(["u", "S"]);   // 值只能紧跟在后面（-uno、-Skey），不吃下一个词
const COMMIT_LONG_WITH_VALUE = new Set(["--message", "--file", "--author", "--date", "--template", "--reuse-message", "--reedit-message",
  "--fixup", "--squash", "--cleanup", "--trailer", "--pathspec-from-file"]);
const HOOKS_PATH = /^core\.hookspath(=|$)/i;

/** 返回拦下的原因；不用拦返回 null。 */
export function check(cmd) {
  const t = tokenize(cmd);
  const hasGit = t.some((w) => typeof w === "string" && (w === "git" || w.endsWith("/git")));
  if (hasGit && t.some((w) => typeof w === "string" && /core\.hookspath/i.test(w))) return "不能碰 core.hooksPath（提交前检查靠它启用；重新启用用 npm run setup）";
  if (hasGit && t.some((w) => typeof w === "string" && /^GIT_CONFIG_(PARAMETERS|COUNT|KEY_\d+|VALUE_\d+)=/.test(w))) return "不能用 GIT_CONFIG_* 环境变量临时改 git 设置";
  for (let i = 0; i < t.length; i++) {
    const w = t[i];
    if (w === SEP || !(w === "git" || w.endsWith("/git"))) continue;
    let j = i + 1;
    while (j < t.length && t[j] !== SEP && typeof t[j] === "string" && t[j].startsWith("-")) {
      const opt = t[j];
      const [name, inline] = opt.includes("=") ? [opt.slice(0, opt.indexOf("=")), opt.slice(opt.indexOf("=") + 1)] : [opt, null];
      if (opt === "-c" || name === "--config-env") {
        const v = inline ?? t[j + 1];
        if (typeof v === "string" && HOOKS_PATH.test(v)) return "不能用 -c core.hooksPath 改掉提交前检查";
        if (typeof v === "string" && /^alias\./i.test(v)) return "不能用 -c alias.* 临时定义别名";
      } else if (opt.startsWith("-c") && HOOKS_PATH.test(opt.slice(2))) {
        return "不能用 -c core.hooksPath 改掉提交前检查";
      }
      j += GLOBAL_WITH_VALUE.has(name) && inline === null ? 2 : 1;
    }
    const sub = t[j];
    if (typeof sub !== "string") continue;
    const args = [];
    for (let k = j + 1; k < t.length && t[k] !== SEP; k++) args.push(t[k]);
    if (sub === "config" && args.some((a) => HOOKS_PATH.test(a))) return "不能改 core.hooksPath（提交前检查靠它启用；重新启用用 npm run setup）";
    if (sub === "config" && args.some((a) => /^alias\./i.test(a)) && args.some((a) => /no-veri|(^|\s)-[a-zA-Z]*n/.test(a))) return "不能定义跳过提交前检查的别名";
    if (sub === "commit-tree") return "不能用 git commit-tree 绕过提交前检查";
    if (sub === "merge" || sub === "commit") {
      for (let k = 0; k < args.length; k++) {
        const a = args[k];
        if (a === "--") break;
        if (/^--no-veri/.test(a)) return `git ${sub} 不能加 --no-verify`;
        if (a.startsWith("--")) {
          if (COMMIT_LONG_WITH_VALUE.has(a)) k++;
          continue;
        }
        if (sub !== "commit" || !a.startsWith("-") || a.length < 2) continue;
        for (let c = 1; c < a.length; c++) {
          const ch = a[c];
          if (ch === "n") return "git commit 不能加 -n（就是 --no-verify）";
          if (COMMIT_SHORT_OPTIONAL.has(ch)) break;
          if (COMMIT_SHORT_WITH_VALUE.has(ch)) {
            if (c === a.length - 1) k++;
            break;
          }
        }
      }
    }
  }
  return null;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let input = {};
  try {
    input = JSON.parse(readFileSync(0, "utf8") || "{}");
  } catch {
    process.exit(0);
  }
  const reason = typeof input?.tool_input?.command === "string" ? check(input.tool_input.command) : null;
  if (reason) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: `${reason}。提交前检查不能跳过（AGENTS.md 提交规则）：检查没过就改，不绕。`,
      },
    }));
  }
  process.exit(0);
}
