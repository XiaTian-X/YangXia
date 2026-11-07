// 命令行（Node 24 直接运行 TypeScript）：
//   npm run course -- check <课程.json> [--profile <档案.json>]   检查课程，有错误时退出码 1
//   npm run course -- summary <课程.json>                         总时长、动作、组数
//   npm run course -- srt <课程.json>                             打印 SRT 字幕
//   npm run course -- cases                                       跑模板 manifest 里的红线校验样例
import { readFileSync } from "node:fs";
import { checkCourse } from "./check.ts";
import { failedRedlineCases } from "./redlines.ts";
import { buildSrt } from "./srt.ts";
import { buildTimeline, itemSpec } from "./timeline.ts";
import { validateCourse } from "./validate.ts";
import { loadTemplates } from "./node.ts";

const USAGE = `用法：
  npm run course -- check <课程.json> [--profile <档案.json>]
  npm run course -- summary <课程.json>
  npm run course -- srt <课程.json>
  npm run course -- cases`;

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new Error(`读不了 ${path}：${(e as Error).message}`);
  }
}

function mmss(sec: number): string {
  const s = Math.round(sec);
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

async function main(argv: string[]): Promise<number> {
  const [cmd, file, ...rest] = argv;
  if (cmd === "cases") {
    const t = await loadTemplates();
    const bad = failedRedlineCases(t.manifest.redlines);
    for (const c of bad) console.log(`不符：${c.age}·${c.scope}「${c.text}」应该${c.blocked ? "拦下" : "通过"}`);
    console.log(`红线校验样例 ${t.manifest.redlines.cases.length} 条，不符 ${bad.length} 条`);
    return bad.length ? 1 : 0;
  }
  if (!file || !["check", "summary", "srt"].includes(cmd ?? "")) {
    console.log(USAGE);
    return 2;
  }
  const raw = readJson(file);
  if (cmd === "check") {
    const t = await loadTemplates();
    const pi = rest.indexOf("--profile");
    const profile = pi >= 0 ? readJson(rest[pi + 1]) : undefined;
    const issues = checkCourse(raw, { manifest: t.manifest, readProduct: t.readProduct, profile });
    for (const i of issues) console.log(`[${i.level === "error" ? "错误" : "警告"}] ${i.path || "课程"}：${i.message}`);
    const errors = issues.filter((i) => i.level === "error").length;
    console.log(`\n检查完：${errors} 个错误，${issues.length - errors} 个警告`);
    return errors ? 1 : 0;
  }
  const { course, issues } = validateCourse(raw);
  if (!course) {
    for (const i of issues) console.log(`[错误] ${i.path}：${i.message}`);
    return 1;
  }
  const tl = buildTimeline(course);
  if (cmd === "srt") {
    process.stdout.write(buildSrt(tl.events, tl.totalDuration));
    return 0;
  }
  console.log(`${course.name}（${course.source.product} · 第 ${course.source.week} 周${course.source.day ? " · " + course.source.day + " 日" : ""}）`);
  console.log(`总时长约 ${mmss(tl.totalDuration)}`);
  for (const b of course.blocks) {
    const head = b.kind === "circuit" ? `循环 ${b.rounds} 轮` : "逐个动作";
    console.log(`- ${head}：${b.items.map((it) => `${it.name} ${itemSpec(it, b.kind === "circuit" ? b.rounds : it.sets ?? 1)}`).join("；")}`);
  }
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e) => {
    console.error((e as Error).message);
    process.exit(2);
  },
);
