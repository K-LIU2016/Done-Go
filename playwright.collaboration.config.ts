import { defineConfig } from '@playwright/test';
const port = Number(process.env.TANGO_PORT) || 5276;
const origin = (value: number) => 'http://127.0.0.1:' + value;
export default defineConfig({
 testDir: './tests/tango', testMatch: 'collaboration.spec.ts',
 outputDir: './test-results/collaboration', timeout: 60000, workers: 2,
 use: { channel: process.platform === 'win32' ? 'msedge' : undefined, timezoneId: 'Asia/Shanghai', reducedMotion: 'reduce', screenshot: 'only-on-failure' },
 projects: [
  { name: 'desktop', use: { baseURL: origin(port), viewport: { width: 1440, height: 1000 } } },
  { name: 'mobile', use: { baseURL: origin(port + 1), viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
 ],
 // Independent services preserve production registration limits and isolate project records.
 webServer: [port, port + 1].map(value => ({ command: 'node tests/helpers/email-server.mjs', env: { TANGO_PORT: String(value), TANGO_FIXTURE_AI: '1' }, url: origin(value), reuseExistingServer: false, timeout: 20000 })),
});
