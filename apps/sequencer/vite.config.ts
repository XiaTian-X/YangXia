// 打包成单个离线 HTML：dist/养夏跟练编排器.html（双击打开即可用，不需要服务器、不联网）。
import preact from "@preact/preset-vite";
import { existsSync, readFileSync, renameSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import { defineConfig, type Plugin } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

const root = dirname(fileURLToPath(import.meta.url));
const repo = join(root, "..", "..");
const OUTPUT = "养夏跟练编排器.html";
const MOTIONS_FORMAT = "yangxia.motions/1";
const VIRTUAL = "virtual:yangxia-figures";
// 只放行页面自带的东西：不能连外部地址。wasm 和 blob 是动画引擎、音视频导出要用的。
const CSP = "default-src 'none'; script-src 'unsafe-inline' 'wasm-unsafe-eval'; style-src 'unsafe-inline'; img-src data: blob:; media-src blob: data:; connect-src blob: data:; worker-src blob:; font-src data:; base-uri 'none'; form-action 'none'";
const require = createRequire(import.meta.url);

/** 找这个包的目录（包的 exports 不一定放行 package.json，所以从入口文件往上找）。 */
function packageDir(name: string): string {
  let dir = dirname(require.resolve(name));
  while (dir !== dirname(dir)) {
    const f = join(dir, "package.json");
    if (existsSync(f) && (JSON.parse(readFileSync(f, "utf8")) as { name?: string }).name === name) return dir;
    dir = dirname(dir);
  }
  throw new Error(`找不到依赖 ${name} 的目录`);
}

const gz = (data: Buffer | string) => gzipSync(data, { level: 9 }).toString("base64");

async function motionsFile(mode: string): Promise<string | null> {
  if (mode === "e2e") return join(repo, "contracts", "fixtures", "data", "motions.json");
  const { templatesDir } = (await import(pathToFileURL(join(repo, "scripts", "templates-path.mjs")).href)) as { templatesDir: () => string | null };
  const dir = templatesDir();
  const f = dir ? join(dir, "dist", "data", "motions.json") : "";
  return f && existsSync(f) ? f : null;
}

function figureAssets(mode: string): Plugin {
  const id = `\0${VIRTUAL}`;
  return {
    name: "yangxia-figures",
    resolveId: (s) => (s === VIRTUAL ? id : null),
    async load(s) {
      if (s !== id) return null;
      const file = await motionsFile(mode);
      let motions = "";
      if (file) {
        // 格式不认识或文件坏了，和课程核心库一样当作没有动图：照常打包，只是不带
        const text = readFileSync(file, "utf8");
        let format: unknown;
        try {
          format = (JSON.parse(text) as { format?: unknown }).format;
        } catch {
          format = "（解析不了）";
        }
        if (format === MOTIONS_FORMAT) motions = gz(text);
        else this.warn(`${file} 的格式是「${String(format)}」，这个编排器只认 ${MOTIONS_FORMAT}：这次打包不带动作示意动图`);
      } else {
        this.warn("没有找到模板的 dist/data/motions.json：这次打包不带动作示意动图");
      }
      const lottie = packageDir("@lottiefiles/dotlottie-web");
      const notices = [readFileSync(join(root, "third-party", "NOTICES.txt"), "utf8"),
        `dotLottie Web 许可全文\n\n${readFileSync(join(lottie, "LICENSE"), "utf8")}`,
        `Mediabunny 许可全文（Mozilla Public License 2.0）\n\n${readFileSync(join(packageDir("mediabunny"), "LICENSE"), "utf8")}`,
        `Space Grotesk 字体许可全文（SIL Open Font License 1.1）\n\n${readFileSync(join(packageDir("@fontsource/space-grotesk"), "LICENSE"), "utf8")}`].join("\n\n");
      return `export const motionsGz=${JSON.stringify(motions)};export const wasmGz=${JSON.stringify(gz(readFileSync(join(lottie, "dist", "dotlottie-player.wasm"))))};export const notices=${JSON.stringify(notices)};`;
    },
  };
}

/**
 * 课程包（v4 阶段 8c）：单文件内联之后，往页面里写打包标记和空的嵌入块，各恰好一个。
 * course export 读标记核对"动图、源码是不是现在的"，再把课程写进嵌入块（packages/course-core/src/package.ts）。
 * 标记的算法只用 scripts/sequencer-stamp.mjs，和 course export 同一个。
 */
function packageMarker(mode: string): Plugin {
  return {
    name: "yangxia-package",
    apply: "build",
    enforce: "post",
    async generateBundle(_, bundle) {
      const stamp = (await import(pathToFileURL(join(repo, "scripts", "sequencer-stamp.mjs")).href)) as {
        sourceHash: () => string | null; motionsHash: (text: string) => string;
      };
      const file = await motionsFile(mode);
      let motions = "none";
      let motionsHash = "none";
      if (file) {
        const text = readFileSync(file, "utf8");
        try {
          const m = JSON.parse(text) as { format?: unknown; version?: unknown };
          if (m.format === MOTIONS_FORMAT && typeof m.version === "string") {
            motions = m.version;
            motionsHash = stamp.motionsHash(text);
          }
        } catch {
          // 解析不了：当作没带动图（figureAssets 里已经提醒过）
        }
      }
      const source = stamp.sourceHash() ?? "none";
      const meta = `<meta name="yangxia-package" content="format=yangxia.package/1;motions=${motions};motionsHash=${motionsHash};source=${source}">`;
      const block = '<script type="application/json" id="yangxia-course"></script>';
      for (const out of Object.values(bundle)) {
        if (out.type !== "asset" || !out.fileName.endsWith(".html")) continue;
        let html = String(out.source);
        const charset = /<meta charset="[^"]*"\s*\/?>/i.exec(html);
        if (!charset || !html.includes("</body>")) throw new Error("页面里找不到 <meta charset> 或 </body>，写不了课程包标记");
        const at = charset.index + charset[0].length;
        html = `${html.slice(0, at)}\n    ${meta}${html.slice(at)}`;
        const end = html.lastIndexOf("</body>");
        html = `${html.slice(0, end)}${block}\n  ${html.slice(end)}`;
        out.source = html;
      }
    },
  };
}

export default defineConfig(({ mode }) => {
  const outDir = mode === "e2e" ? "dist-e2e" : "dist";   // e2e 用离线样例的动图，单独放，不覆盖正式打包
  return {
    root,
    base: "./",
    plugins: [
      preact(),
      figureAssets(mode),
      viteSingleFile(),
      packageMarker(mode),
      {
        name: "yangxia-csp",
        apply: "build",
        transformIndexHtml: { order: "pre", handler: (html) => html.replace("<head>", `<head>\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`) },
      } satisfies Plugin,
      {
        name: "yangxia-output-name",
        closeBundle() {
          const from = join(root, outDir, "index.html");
          if (existsSync(from)) renameSync(from, join(root, outDir, OUTPUT));
        },
      } satisfies Plugin,
    ],
    build: { outDir, emptyOutDir: true, target: "es2022", chunkSizeWarningLimit: 4000 },
  };
});
