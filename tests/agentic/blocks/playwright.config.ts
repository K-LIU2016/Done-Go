// W1 index-hook e2e 配置：tests/agentic/blocks/ 内自包含（不碰根 playwright.*.config.ts——文件归属）。
// 端口用本流段 17601–17609；与其它 Playwright 流共用全局锁 /tmp/donego-s2d-pw.lock 时由运行方 flock。
import { defineConfig } from '@playwright/test';

const port = Number(process.env.S2D_W1_PORT) || 17601;

export default defineConfig({
  testDir: '.',
  outputDir: './.results',
  timeout: 30000,
  workers: 1,
  use: { baseURL: 'http://127.0.0.1:' + port, timezoneId: 'Asia/Shanghai' },
  webServer: { command: 'node harness-server.mjs', url: 'http://127.0.0.1:' + port, reuseExistingServer: true, timeout: 15000 },
});
