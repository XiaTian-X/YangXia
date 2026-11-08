// 仓库级的守门：Claude Code 的 git 命令拦截（.claude/hooks/guard-git.mjs）、提交前检查（.githooks/pre-commit）。
// 两个仓库各有一份同样的脚本，这里也核对两份一致（模板仓库不在时跳过）。
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = new URL("../../", import.meta.url).pathname;
const { check } = (await import(join(ROOT, ".claude/hooks/guard-git.mjs"))) as { check: (cmd: string) => string | null };

describe("git 命令拦截", () => {
  const blocked = [
    "git commit -n -m x", "git commit -anm \"msg\"", "git commit --no-verify -m x", "git commit --no-veri -m x",
    "git -C templates commit -n -m x", "cd templates && git commit -qn -F msg.txt", "git -c core.hooksPath=/dev/null commit -m x",
    "git config core.hooksPath x", "git config --unset core.hooksPath", "git merge --no-verify main",
    "GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=/dev/null git commit -m x",
    "GIT_CONFIG_PARAMETERS=\"'core.hooksPath'='/x'\" git commit -m x", "git -c alias.ci='commit --no-verify' ci -m x",
    "git config alias.ci 'commit -n'", "git commit-tree HEAD^{tree} -m x",
  ];
  const allowed = [
    "git commit -m \"fix -n bug\"", "git commit -mn", "git log -n 5", "git merge -n main", "git status && git commit -am \"x\"",
    "git -C templates log --oneline -n 3", "npm run setup", "git commit -q -F - <<'EOF'\nx -n\nEOF", "git commit -uno -m x", "git config alias.st status",
  ];
  for (const c of blocked) it(`拦下：${c}`, () => expect(check(c)).not.toBeNull());
  for (const c of allowed) it(`放行：${JSON.stringify(c)}`, () => expect(check(c)).toBeNull());
});

const tpl = join(ROOT, "templates");
describe.skipIf(!existsSync(join(tpl, ".git")))("两个仓库的守门脚本一致", () => {
  for (const f of [".githooks/pre-commit", ".claude/hooks/guard-git.mjs"]) {
    it(f, () => expect(readFileSync(join(tpl, f), "utf8")).toBe(readFileSync(join(ROOT, f), "utf8")));
  }
});

describe("提交前检查", () => {
  // 样例内容运行时拼出来：源码里直接写档案格式，提交前检查会拦下这个测试文件本身
  const PROFILE = ["yangxia", "profile/1"].join(".");
  const SESSION = ["yangxia", "session/1"].join(".");
  const REVIEW = ["yangxia", "review/1"].join(".");
  const ASSESS = ["yangxia", "assessment/1"].join(".");
  const run = (files: Record<string, string>) => {
    const dir = mkdtempSync(join(tmpdir(), "yangxia-hook-"));
    try {
      const git = (...a: string[]) => spawnSync("git", a, { cwd: dir, encoding: "utf8" });
      git("init", "-q");
      for (const [f, body] of Object.entries(files)) {
        mkdirSync(dirname(join(dir, f)), { recursive: true });
        writeFileSync(join(dir, f), body);
        git("add", "-f", f);
      }
      const r = spawnSync("python3", [join(ROOT, ".githooks/pre-commit")], { cwd: dir, encoding: "utf8" });
      return { code: r.status, out: r.stdout + r.stderr };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  it("拦下多行和压成一行的个人档案", () => {
    expect(run({ "a.json": JSON.stringify({ schema: PROFILE }, null, 2) }).code).toBe(1);
    expect(run({ "b.json": JSON.stringify({ schema: SESSION, items: [] }) }).code).toBe(1);
  });
  it("拦下复盘数据、评估记录（多行、压成一行、放在数组里）", () => {
    expect(run({ "r.json": JSON.stringify({ schema: REVIEW, moves: [] }, null, 2) }).code).toBe(1);
    expect(run({ "r2.json": JSON.stringify({ schema: REVIEW }) }).code).toBe(1);
    expect(run({ "a.json": JSON.stringify([{ schema: ASSESS }]) }).code).toBe(1);
  });
  it("拦下 profiles/、.env、私钥、日历", () => {
    for (const f of ["profiles/甲/档案.json", ".env", "id_ed25519", "训练.ics"]) expect(run({ [f]: "x\n" }).code, f).toBe(1);
  });
  it("放行样例目录里的档案样例和普通文件", () => {
    expect(run({ "contracts/fixtures/profiles/ok.json": JSON.stringify({ schema: PROFILE }), "README.md": "# x\n" }).code).toBe(0);
  });
});
