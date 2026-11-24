// 编排器打包标记的源码哈希（scripts/sequencer-stamp.mjs）：打包时和 course export 时算的要一样，代码一改就要变。
// 在临时 git 仓库里试：改内容、新建没 add 的文件、删掉文件、被忽略的文件、范围外的文件、不是 git 仓库。
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const stamp = (await import(new URL("../../../scripts/sequencer-stamp.mjs", import.meta.url).href)) as {
  sourceHash: (root?: string) => string | null; motionsHash: (t: string) => string; STAMP_PATHS: string[];
};
const hasGit = (() => { try { execFileSync("git", ["--version"], { stdio: "ignore" }); return true; } catch { return false; } })();
const root = mkdtempSync(join(tmpdir(), "yangxia-stamp-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function repo(name: string): string {
  const d = join(root, name);
  mkdirSync(join(d, "apps", "sequencer", "src"), { recursive: true });
  mkdirSync(join(d, "packages", "course-core", "src"), { recursive: true });
  mkdirSync(join(d, "docs"), { recursive: true });
  writeFileSync(join(d, "apps", "sequencer", "src", "a.ts"), "export const a = 1;\n");
  writeFileSync(join(d, "packages", "course-core", "src", "b.ts"), "export const b = 2;\n");
  writeFileSync(join(d, "package-lock.json"), "{}\n");
  writeFileSync(join(d, "docs", "说明.md"), "文档\n");
  writeFileSync(join(d, ".gitignore"), "*.log\n");
  const git = (...a: string[]) => execFileSync("git", a, { cwd: d, stdio: "ignore" });
  git("init", "-q");
  git("add", "-A");   // 只暂存不提交（--cached 看得到暂存的文件），不受本机的提交签名、全局钩子影响
  return d;
}

describe.skipIf(!hasGit)("源码哈希", () => {
  it("同样的内容算出同样的哈希（和机器路径无关）", () => {
    const a = stamp.sourceHash(repo("same-a"));
    const b = stamp.sourceHash(repo("same-b"));
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).toBe(b);
  });

  it("改内容、新建没 add 的文件、删掉文件：变；被忽略的、范围外的文件：不变", () => {
    const d = repo("change");
    const base = stamp.sourceHash(d);
    writeFileSync(join(d, "apps", "sequencer", "src", "debug.log"), "x");
    writeFileSync(join(d, "docs", "说明.md"), "文档改了\n");
    expect(stamp.sourceHash(d), "忽略的、范围外的不算").toBe(base);
    writeFileSync(join(d, "apps", "sequencer", "src", "new.ts"), "export {};\n");
    const added = stamp.sourceHash(d);
    expect(added, "没 add 的新文件算进去").not.toBe(base);
    rmSync(join(d, "apps", "sequencer", "src", "new.ts"));
    expect(stamp.sourceHash(d)).toBe(base);
    writeFileSync(join(d, "packages", "course-core", "src", "b.ts"), "export const b = 3;\n");
    expect(stamp.sourceHash(d), "没提交的改动也算").not.toBe(base);
    rmSync(join(d, "packages", "course-core", "src", "b.ts"));
    expect(stamp.sourceHash(d), "删掉的文件").not.toBe(base);
  });

  it("不是 git 仓库：算不出来（当作过期）", () => {
    const d = join(root, "no-git");
    mkdirSync(join(d, "apps", "sequencer", "src"), { recursive: true });
    writeFileSync(join(d, "apps", "sequencer", "src", "a.ts"), "x");
    expect(stamp.sourceHash(d)).toBeNull();
  });

  it("动图哈希只看内容", () => {
    expect(stamp.motionsHash("abc")).toBe(stamp.motionsHash("abc"));
    expect(stamp.motionsHash("abc")).not.toBe(stamp.motionsHash("abd"));
  });
});
