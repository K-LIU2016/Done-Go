import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/tango',
  outputDir: './test-results/tango',
  timeout: 20000,
  workers: 2,
  use: { baseURL: 'http://127.0.0.1:5207', timezoneId: 'Asia/Shanghai', reducedMotion: 'reduce', screenshot: 'only-on-failure', channel: process.env.TANGO_BROWSER || (process.platform === 'win32' ? 'msedge' : undefined) },
  projects: [
    { name: 'desktop', use: { viewport: { width: 1440, height: 1000 } } },
    { name: 'mobile', use: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
  ],
  webServer: { command: 'node scripts/serve-tango.mjs', url: 'http://127.0.0.1:5207', reuseExistingServer: process.env.TANGO_REUSE_SERVER === '1', timeout: 20000 },
});
