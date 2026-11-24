// 编排器打包标记：课程包（v4 阶段 8c）要知道"这个打包好的编排器是不是用现在的源码、现在的动图打的"。
// 打包时（apps/sequencer/vite.config.ts）把这里算出的哈希写进页面的 <meta name="yangxia-package">；
// course export 出课程包之前用同一个算法重算，对不上就不出课程包、提示先 npm run build。两边只能用这里的函数，不要各写一套。
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "./templates-path.mjs";

/**
 * 会进编排器的源码（偏保守：课程核心库的命令行代码不进编排器，改了也算过期）。
 * 编排器的界面、打包配置（内容安全策略、动图内嵌）、依赖版本、授权文本、编排器里的样例课。
 */
export const STAMP_PATHS = [
  "apps/sequencer/src",
  "apps/sequencer/index.html",
  "apps/sequencer/vite.config.ts",
  "apps/sequencer/package.json",
  "apps/sequencer/third-party",
  "packages/course-core/src",
  "package-lock.json",
  "contracts/fixtures/courses/ok-a18-home-w1-a.json",
];

/**
 * 源码哈希：git 管着的文件加上还没 git add 的新文件（不含被忽略的），跳过已经删掉的，按路径排序；
 * 读工作区里的内容（有没提交的改动也算），每个文件拼成 路径\0长度\0内容，整体算 SHA-256。
 * 算不出来（不是 git 检出、没装 git）返回 null：当作过期，不出课程包。
 */
export function sourceHash(root = REPO_ROOT) {
  let out;
  try {
    out = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", ...STAMP_PATHS], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return null;
  }
  const files = [...new Set(out.split("\0").filter(Boolean))]
    .filter((f) => existsSync(join(root, f)) && statSync(join(root, f)).isFile())
    .sort();
  if (!files.length) return null;
  const h = createHash("sha256");
  for (const f of files) {
    const buf = readFileSync(join(root, f));
    h.update(f);
    h.update("\0");
    h.update(String(buf.length));
    h.update("\0");
    h.update(buf);
  }
  return h.digest("hex");
}

/** 动图内容的哈希（模板的版本号只在发版时变，没发版的动图更新要靠内容判断）。 */
export function motionsHash(text) {
  return createHash("sha256").update(text).digest("hex");
}
