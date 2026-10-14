import { test, expect, type Page } from '@playwright/test';
test.use({ permissions: ['microphone'], launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] } });

const paper = { id: 'paper', date: '2026-10-14', title: '读论文', kind: 'explore', start: '09:00', end: '10:00', prio: 1 };
async function open(page: Page, entries = [paper], time = '2026-10-14T07:00:00+08:00') {
  await page.clock.install({ time: new Date(time) });
  await page.route('https://**', route => route.abort());
  await page.addInitScript(state => {
    if (!localStorage.getItem('tango.test.initialized')) {
      localStorage.setItem('leubai.web.v1', JSON.stringify(state));
      localStorage.setItem('leubai.llm.v1', JSON.stringify({ mode: 'off' }));
      localStorage.setItem('leubai.lang', 'zh');
      localStorage.setItem('tango.test.initialized', '1');
    }
  }, { v: 1, pv: 5, mode: 'real', wake: 960, entries, trials: [], drafts: [], fw: {}, sound: false });
  await page.goto('/#today');
}

test('unfinished branches grow into flowers and stay visible after their time passes', async ({ page }, info) => {
  await open(page);
  await page.goto('/#line');
  const item = page.locator('.tree .leaf[data-id="paper"]');
  const hours = await page.locator('.tree .hr').allTextContents();
  await expect(item).toHaveAttribute('data-stage', 'bud');
  await page.clock.fastForward(90 * 60 * 1000);
  await expect(item).toHaveAttribute('data-stage', 'flower');
  await page.clock.fastForward(120 * 60 * 1000);
  await expect(item).toHaveAttribute('data-stage', 'flower');
  await expect(item).toContainText('09:00–10:00');
  await page.screenshot({ path: info.outputPath('past-unfinished-flower.png'), fullPage: true });
  await page.reload();
  await expect(item).toHaveAttribute('data-stage', 'flower');
  expect(await page.locator('.tree .hr').allTextContents()).toEqual(hours);
  await page.clock.fastForward(24 * 60 * 60 * 1000);
  await expect(item).toHaveAttribute('data-stage', 'flower');
  await expect(item).toContainText('09:00–10:00');
});

test('finishing on today turns the same tree event into fruit and preserves the plan', async ({ page }, info) => {
  await open(page, [paper], '2026-10-14T09:30:00+08:00');
  await page.locator('#task-advice > summary').click();
  await page.locator('[data-act="task-finish"][data-id="paper"]').click();
  await page.locator('#finish-min').fill('40');
  await page.locator('[data-act="finish-save"]').click();
  await page.locator('.sheet [data-act="close"]').click();
  await page.goto('/#line');
  const item = page.locator('.tree .leaf[data-id="paper"]');
  await expect(item).toHaveAttribute('data-stage', 'fruit');
  await expect(item).toContainText('09:00–10:00');
  await item.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('.sheet')).toContainText('已完成');
  await page.keyboard.press('Escape');
  await page.clock.fastForward(12 * 60 * 60 * 1000);
  await expect(item).toHaveAttribute('data-stage', 'fruit');
  await page.reload();
  await expect(item).toHaveAttribute('data-stage', 'fruit');
  await expect(item).toContainText('09:00–10:00');
  await page.screenshot({ path: info.outputPath('completed-fruit.png'), fullPage: true });
});

test.describe('local speech capture', () => {

  test('local audio becomes an editable task even when browser speech is unavailable', async ({ page }) => {
    await open(page, []);
    await page.route('**/api/speech', route => route.fulfill({ json: { available: true, languages: ['zh-CN'] } }));
    await page.route('**/api/speech/transcribe?lang=zh-CN', async route => {
      expect(route.request().headers()['content-type']).toBe('audio/wav');
      const bytes = route.request().postDataBuffer()!;
      expect(bytes.subarray(0, 4).toString()).toBe('RIFF');
      expect(bytes.length).toBeGreaterThan(44);
      await route.fulfill({ json: { text: '2:00PM到三点开会' } });
    });
    await page.locator('#mic').click();
    await expect(page.locator('#mic')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#capStatus')).toContainText('在听');
    await page.clock.runFor(600);
    await page.locator('#mic').click();
    await expect(page.locator('.draft')).toHaveCount(1);
    await expect(page.locator('.draft [data-f="title"]')).toHaveValue('开会');
    await expect(page.locator('.draft [data-f="start"]')).toHaveValue('14:00');
    await expect(page.locator('.draft [data-f="end"]')).toHaveValue('15:00');
    await expect(page.locator('#mic')).toHaveAttribute('aria-pressed', 'false');
  });

  test('microphone denial preserves typed input and leaves the button retryable', async ({ page, context }) => {
    await open(page, []);
    await page.route('**/api/speech', route => route.fulfill({ json: { available: true, languages: ['zh-CN'] } }));
    await context.clearPermissions();
    await page.addInitScript(() => {
      navigator.mediaDevices.getUserMedia = async () => { throw new DOMException('denied', 'NotAllowedError'); };
    });
    await page.reload();
    await page.locator('#cap-text').fill('原来的事项');
    await page.locator('#mic').click();
    await expect(page.locator('#capStatus')).toContainText('麦克风');
    await expect(page.locator('#mic')).toHaveAttribute('aria-pressed', 'false');
    await expect(page.locator('#cap-text')).toHaveValue('原来的事项');
    await expect(page.locator('.draft')).toHaveCount(0);
  });

  test('leaving the page stops microphone tracks without creating tasks', async ({ page }) => {
    await open(page, []);
    await page.route('**/api/speech', route => route.fulfill({ json: { available: true, languages: ['zh-CN'] } }));
    await page.evaluate(() => {
      const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getUserMedia = async constraints => {
        const stream = await original(constraints);
        (window as any).voiceTracks = stream.getTracks();
        return stream;
      };
    });
    await page.locator('#mic').click();
    await expect(page.locator('#capStatus')).toContainText('在听');
    await page.locator('#tabs a[href="#review"]').click();
    await expect.poll(() => page.evaluate(() => (window as any).voiceTracks.every((track: MediaStreamTrack) => track.readyState === 'ended'))).toBe(true);
    await page.locator('#tabs a[href="#today"]').click();
    await expect(page.locator('#mic')).toHaveAttribute('aria-pressed', 'false');
    await expect(page.locator('.draft')).toHaveCount(0);
  });
});

test('local speech rejects external origins and malformed audio before recognition', async ({ request }) => {
  const external = await request.post('/api/speech/transcribe?lang=zh-CN', { headers: { Origin: 'https://example.com', 'Content-Type': 'audio/wav' }, data: Buffer.alloc(44) });
  expect(external.status()).toBe(403);
  const invalid = await request.post('/api/speech/transcribe?lang=zh-CN', { headers: { Origin: 'http://127.0.0.1:5207', 'Content-Type': 'audio/wav' }, data: Buffer.alloc(44) });
  expect(invalid.status()).toBe(400);
  const tooLarge = await request.post('/api/speech/transcribe?lang=zh-CN', { headers: { Origin: 'http://127.0.0.1:5207', 'Content-Type': 'audio/wav' }, data: Buffer.alloc(1000000) });
  expect(tooLarge.status()).toBe(413);
});
