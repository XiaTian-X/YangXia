import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  testMatch: /.*\.spec\.ts/,
  timeout: 120_000,
  use: { browserName: "chromium", headless: true, acceptDownloads: true },
  reporter: [["list"]],
});
