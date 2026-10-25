// tests/voice/playwright.voice.config.ts — VI·验收专用 Playwright config。
// 为什么不用根 playwright.config.ts：其 webServer 等待 5199，而 `npm run dev` 实际
// 由 TANGO_PORT 决定端口（默认 5207，不认 --port），webServer 必然 60s 超时——
// 既有仓库状况，不属本线修改范围（红线：只改 tests/voice/ 名下文件）。
// 本 config 不设 webServer：lab 实例（17552 主 / 17553 降级）与 stub LLM（17554）
// 由 voice-lab.spec.ts 在 worker 内自起自清（--workers=1 必需，端口固定）。
// projects 沿用根 config 的 Desktop Chrome / Pixel 5（桌面+手机双 project）。
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: /voice-lab\.spec\.ts/,
  outputDir: "../../test-results/voice-accept",
  timeout: 90_000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: "http://127.0.0.1:17552", // 兜底；spec 内一律绝对 URL
  },
  projects: [
    {
      name: "desktop",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1920, height: 1200 } },
    },
    {
      name: "mobile",
      use: { ...devices["Pixel 5"] },
    },
  ],
});
