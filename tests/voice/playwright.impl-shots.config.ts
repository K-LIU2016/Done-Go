// tests/voice/playwright.impl-shots.config.ts — VI·收官「4 屏实现截图」专用 Playwright config。
// 为什么不用根 playwright.config.ts：其 webServer 等待 5199，而 serve-tango 只认 TANGO_PORT
// （默认 5207），webServer 必 60s 超时——既有仓库状况，不属本线修改范围（同
// playwright.voice.config.ts 头注）。本 config 不设 webServer：lab 实例（17553）与
// stub LLM（17555）由 impl-shots.spec.ts 在 worker 内自起自清（--workers=1 必需，端口固定）。
// 视口按收官任务指定：390×844（手机）与 1280×860（桌面）；deviceScaleFactor 2 出图清晰。
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: /impl-shots\.spec\.ts/,
  outputDir: "../../test-results/voice-shots",
  timeout: 120_000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: "http://127.0.0.1:17553", // 兜底；spec 内一律绝对 URL
  },
  projects: [
    {
      name: "mobile-390",
      use: { ...devices["Desktop Chrome"], viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 },
    },
    {
      name: "desktop-1280",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 860 }, deviceScaleFactor: 2 },
    },
  ],
});
