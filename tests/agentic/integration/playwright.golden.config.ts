// S2D-W13 · M23 PW golden 配置（plan.md §G5 M23）。
// 模式对齐 tests/agentic/blocks/playwright.blocks.config.ts（自包含目录、webServer
// 以本配置所在目录为 cwd）。端口：W13 harness 段 17701–17709 的 17704
//（经 S2D_W13_PW_PORT 对流到 pw-server.mjs；被占即失败不漂移——探活 url 与
// 监听口必须同值）。M21 node 侧 golden 用 pickHarnessPort 从 17701 顺扫避让。
// 只收本目录 pw-golden.spec.ts（node 侧 *.test.mjs 归 node --test，互不相扰）。
// desktop 单 project（「最小 golden」；移动端/a11y 归 W5 自有套件）。
// 运行（全局锁 ≤2 PW 进程）：
//   flock -w 900 /tmp/donego-s2d-pw.lock npx playwright test -c tests/agentic/integration/playwright.golden.config.ts
import { defineConfig } from '@playwright/test';

const port = Number(process.env.S2D_W13_PW_PORT) || 17704;

export default defineConfig({
  testDir: '.',
  testMatch: 'pw-golden.spec.ts',
  outputDir: './.pw-golden-results',
  timeout: 180_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:' + port,
    timezoneId: 'Asia/Shanghai',
    locale: 'zh-CN',
  },
  projects: [
    { name: 'desktop', use: { viewport: { width: 1280, height: 900 } } },
  ],
  webServer: {
    command: 'node pw-server.mjs',
    url: 'http://127.0.0.1:' + port + '/',
    reuseExistingServer: false,
    timeout: 20_000,
  },
});
