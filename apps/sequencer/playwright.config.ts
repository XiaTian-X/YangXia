import { defineConfig } from "@playwright/test";

// 冒烟测试打开打包好的单文件 HTML（根目录 npm run e2e 会先用离线样例打包到 dist-e2e）。无头浏览器里没有系统语音，测试一律用内置语音。
export default defineConfig({
  testDir: "./e2e",
  testMatch: /.*\.spec\.ts/,
  timeout: 180_000,
  use: { browserName: "chromium", headless: true, acceptDownloads: true },
  reporter: [["list"]],
});
