// W5 Playwright 配置（补齐 plan.md M02 缺口；端口段 17621–17629，全局锁见 BUILD-PLAN §2.3）
// desktop 1280×900 + mobile 390×844（isMobile/hasTouch）双 project（plan.md M02 / BUILD-PLAN §2.4.5）；
// 时区 Asia/Shanghai（黄金场景时刻表）；reducedMotion 由 spec 内 page.emulateMedia 切换（M19 a11y）。
// 运行：flock -w 900 /tmp/donego-s2d-pw.lock npx playwright test -c tests/agentic/ui/playwright.config.ts <spec...>
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: '**/*.spec.ts',
  fullyParallel: false,
  workers: 1,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:17621',
    timezoneId: 'Asia/Shanghai',
    locale: 'zh-CN',
  },
  projects: [
    { name: 'desktop', use: { viewport: { width: 1280, height: 900 } } },
    // 390×844 · isMobile · hasTouch（plan.md M02 移动端口径）。不用 devices['iPhone *'] 预设——
    // 那会绑定 WebKit，本机 ms-playwright 只装了 Chromium（无需下载浏览器）。
    {
      name: 'mobile',
      use: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
    },
  ],
  webServer: {
    command: 'node helpers/serve.mjs --port 17621',
    url: 'http://127.0.0.1:17621/',
    reuseExistingServer: true,
    timeout: 20_000,
  },
});
