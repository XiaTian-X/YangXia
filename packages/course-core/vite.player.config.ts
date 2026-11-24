// 将 @yangxia/course-core/player 打包为单文件无依赖 es2020 IIFE（dist/player-runtime.js，挂载全局 YangXiaPlayer）
// 供 Android QuickJS 加载；严禁降级 ES5（保护 Unicode 码点展开 [...note.trim()]）。
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const root = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root,
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2020",
    sourcemap: false,
    lib: {
      entry: resolve(root, "src/player.ts"),
      name: "YangXiaPlayer",
      formats: ["iife"],
      fileName: () => "player-runtime.js",
    },
  },
});
