// 文档里写的 npm run 命令都要在 package.json 里（根目录或某个工作区；写了 -w 的看那个工作区）。
// 修复方案 P1-13：AGENTS.md 曾写过不存在的 npm run dev:server。讲"这条命令不存在"的那一行不算。
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = new URL("../../", import.meta.url).pathname;
const pkg = (p: string) => JSON.parse(readFileSync(join(ROOT, p), "utf8")) as { name?: string; scripts?: Record<string, string>; workspaces?: string[] };

describe("文档里的 npm run 命令都存在", () => {
  it("README、AGENTS、docs/*.md、skills 里的每一条", () => {
    const root = pkg("package.json");
    const ws: Record<string, Record<string, string>> = {};
    for (const w of root.workspaces ?? []) {
      const j = pkg(`${w}/package.json`);
      if (j.name) ws[j.name] = j.scripts ?? {};
    }
    const all = new Set([...Object.keys(root.scripts ?? {}), ...Object.values(ws).flatMap((o) => Object.keys(o))]);
    const skills = join(ROOT, ".claude/skills");
    const files = [
      "README.md",
      "AGENTS.md",
      ...readdirSync(join(ROOT, "docs")).filter((f) => f.endsWith(".md")).map((f) => `docs/${f}`),
      ...(existsSync(skills) ? readdirSync(skills).map((d) => `.claude/skills/${d}/SKILL.md`).filter((f) => existsSync(join(ROOT, f))) : []),
    ];
    const bad: string[] = [];
    for (const f of files) {
      for (const line of readFileSync(join(ROOT, f), "utf8").split("\n")) {
        if (line.includes("不存在")) continue;
        for (const m of line.matchAll(/npm run ([a-z0-9:_-]+)(?: -w ([@a-z0-9/._-]+))?/g)) {
          const [, script, w] = m;
          const ok = w ? ws[w]?.[script] !== undefined : all.has(script);
          if (!ok) bad.push(`${f}：${m[0]}`);
        }
      }
    }
    expect(bad).toEqual([]);
  });
});
