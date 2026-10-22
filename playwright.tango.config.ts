import { defineConfig } from '@playwright/test';

const tangoPort = Number(process.env.TANGO_PORT) > 0 ? Number(process.env.TANGO_PORT) : 5207;

export default defineConfig({
  testDir: './tests/tango',
  testIgnore: ['collaboration.spec.ts','account-entry.spec.ts','demo-entry.spec.ts'],
  globalSetup: './tests/helpers/email-setup.mjs',
  outputDir: './test-results/tango',
  timeout: 20000,
  workers: 2,
  use: { storageState: './artifacts/tango-ui-auth.json', baseURL: 'http://127.0.0.1:' + tangoPort, timezoneId: 'Asia/Shanghai', reducedMotion: 'reduce', screenshot: 'only-on-failure', channel: process.env.TANGO_BROWSER || (process.platform === 'win32' ? 'msedge' : undefined) },
  projects: [
    { name: 'desktop', use: { viewport: { width: 1440, height: 1000 } } },
    { name: 'mobile', use: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
  ],
  webServer: { command: 'node tests/helpers/email-server.mjs', url: 'http://127.0.0.1:' + tangoPort, env: { TANGO_PORT: String(tangoPort), TANGO_LEGACY_UI_FIXTURES: '1' }, reuseExistingServer: process.env.TANGO_REUSE_SERVER === '1', timeout: 20000 },
});
