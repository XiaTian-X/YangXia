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

export default defineConfig(({ mode }) => {
  const outDir = mode === "e2e" ? "dist-e2e" : "dist";   // e2e 用离线样例的动图，单独放，不覆盖正式打包
  return {
    root,
    base: "./",
    plugins: [
      preact(),
      figureAssets(mode),
      viteSingleFile(),
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
