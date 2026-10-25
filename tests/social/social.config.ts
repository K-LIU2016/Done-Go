// tests/social/social.config.ts — 同频（社交游戏化）验收 E2E 配置（SO验收工）。
//
// 每个 project 独立 lab 实例（任务书端口段 17560–17569；:memory: 库 +
// --seed-demo），保证 desktop/mobile 两轮互不污染（删除我的数据等步骤会
// 破坏库内状态）。命令用绝对路径，规避 webServer cwd 歧义。
//
// 运行（重活纪律：heavy.lock + nice + --workers=1）：
//   flock -w 1800 /home/jc/.local/share/argus/heavy.lock nice -n 19 \
//     npx playwright test --config tests/social/social.config.ts --workers=1
import { defineConfig } from '@playwright/test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const port = Number(process.env.SOCIAL_LAB_PORT) || 17560;
const origin = (value: number) => 'http://127.0.0.1:' + value;

export default defineConfig({
  testDir: './',
  testMatch: 'social-lab.spec.ts',
  outputDir: '../../test-results/social',
  timeout: 60000,
  workers: 1,
  fullyParallel: false,
  expect: { timeout: 10000 },
  use: {
    timezoneId: 'Asia/Shanghai',
    reducedMotion: 'reduce',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'desktop', use: { baseURL: origin(port), viewport: { width: 1920, height: 1200 } } },
    { name: 'mobile', use: { baseURL: origin(port + 1), viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
  ],
  webServer: [port, port + 1].map((value) => ({
    command: 'node ' + ROOT + '/scripts/social-lab.mjs --seed-demo --port=' + value,
    url: origin(value) + '/social/lab.html',
    reuseExistingServer: false,
    timeout: 20000,
  })),
});
