// W1 blocks-e2e 配置（模式对齐根 playwright.account.config.ts）：tests/agentic/blocks/ 内自包含，
// 只收集本模块的 sync-two-devices.spec.ts（index-hook.spec.ts 归同目录 playwright.config.ts——两个
// harness 端口不同、互不抢占；不碰根 playwright.*.config.ts，文件归属 BUILD-PLAN §2.1 L39）。
// 端口用本流段 17601–17609 的 17602（17601 是 index-hook harness-server.mjs 的默认值），
// S2D_W1_E2E_PORT 可覆盖；webServer 命令以本配置文件所在目录为 cwd（playwright 行为，实测）。
import { defineConfig } from '@playwright/test';

const port = Number(process.env.S2D_W1_E2E_PORT) || 17602;

export default defineConfig({
  testDir: '.',
  testMatch: 'sync-two-devices.spec.ts',
  outputDir: './.blocks-e2e-results',
  timeout: 60000,
  workers: 1,
  use: { baseURL: 'http://127.0.0.1:' + port, timezoneId: 'Asia/Shanghai' },
  webServer: { command: 'node server.mjs', url: 'http://127.0.0.1:' + port, reuseExistingServer: false, timeout: 20000 },
});
