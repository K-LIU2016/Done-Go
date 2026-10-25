// tests/story/playwright.story.config.ts — 时光故事书验收 E2E 专用配置。
//
// 与仓库其它 playwright 配置互不影响：testDir 只含 tests/story/；webServer 起
// 的是故事 lab（scripts/story-lab.mjs，临时实例端口段 17570–17579，默认
// 17570），不是 app 的 serve-tango，也不是根配置的 vite dev (5199)。
//
// 跑法（重活纪律：heavy.lock + nice + 单 worker；见 argus 收敛令）：
//   flock -w 1800 /home/jc/.local/share/argus/heavy.lock nice -n 19 \
//     npx playwright test -c tests/story/playwright.story.config.ts --workers=1
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';

const here = fileURLToPath(new URL('.', import.meta.url)); // …/tests/story/
const repoRoot = resolve(here, '../..');
const port = Number(process.env.STORY_LAB_PORT) > 0 ? Number(process.env.STORY_LAB_PORT) : 17570;

export default defineConfig({
  // rootDir 默认 = config 目录（tests/story）；testDir 即本目录。
  // outputDir 相对 rootDir 落回仓库级 test-results/story（.gitignore 已覆盖）。
  testDir: './',
  outputDir: '../../test-results/story',
  timeout: 120_000,
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    timezoneId: 'Asia/Shanghai',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  projects: [
    // SPEC §8：390 宽与 1280 宽两档都要好看 —— 桌面 + 手机（触控）双 project。
    { name: 'desktop', use: { viewport: { width: 1280, height: 800 } } },
    { name: 'mobile', use: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
  ],
  webServer: {
    // 绝对路径起 lab：cwd 无论在哪都成立（story-lab 内部按自身位置解析 web/）
    command: `node ${repoRoot}/scripts/story-lab.mjs --port ${port}`,
    url: `http://127.0.0.1:${port}/story/lab.html`,
    reuseExistingServer: false,
    timeout: 30_000,
    stdout: 'ignore',
  },
});
