// 打包成单个离线 HTML：dist/养夏跟练编排器.html（双击打开即可用，不需要服务器、不联网）。
import preact from "@preact/preset-vite";
import { existsSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

const root = dirname(fileURLToPath(import.meta.url));
const OUTPUT = "养夏跟练编排器.html";

export default defineConfig({
  root,
  base: "./",
  plugins: [
    preact(),
    viteSingleFile(),
    {
      name: "yangxia-output-name",
      closeBundle() {
        const from = join(root, "dist", "index.html");
        if (existsSync(from)) renameSync(from, join(root, "dist", OUTPUT));
      },
    },
  ],
  build: { outDir: "dist", emptyOutDir: true, target: "es2022" },
});
