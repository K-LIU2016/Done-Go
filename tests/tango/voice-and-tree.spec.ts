import { test, expect, type Page } from '@playwright/test';
test.use({ permissions: ['microphone'], launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] } });

const paper = { id: 'paper', date: '2026-10-14', title: '读论文', kind: 'explore', start: '09:00', end: '10:00', prio: 1 };
async function open(page: Page, entries: Record<string, unknown>[] = [paper], time = '2026-10-14T07:00:00+08:00', drafts: Record<string, unknown>[] = []) {
  await page.clock.install({ time: new Date(time) });
  await page.route('https://**', route => route.abort());
  await page.addInitScript(state => {
    if (!localStorage.getItem('tango.test.initialized')) {
      localStorage.setItem('tango-donego.web.v1', JSON.stringify(state));
      localStorage.setItem('tango-donego.llm.v1', JSON.stringify({ mode: 'off' }));
      localStorage.setItem('tango-donego.lang', 'zh');
      localStorage.setItem('tango.test.initialized', '1');
    }
  }, { v: 1, pv: 5, mode: 'real', wake: 960, entries, trials: [], drafts, fw: {}, sound: false });
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
  await page.locator('#finish-quality').selectOption('accepted');
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
  async function say(page: Page, text: string) {
    await page.route('**/api/speech', route => route.fulfill({ json: { available: true, languages: ['zh-CN'] } }));
    await page.route('**/api/speech/transcribe?lang=zh-CN', route => route.fulfill({ json: { text } }));
    await page.locator('#mic').click();
    await expect(page.locator('#capStatus')).toContainText('在听');
    await page.clock.runFor(600);
    await page.locator('#mic').click();
  }

  test('local audio directly creates a normal-priority bubble and retains its transcript', async ({ page }) => {
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
    await expect(page.locator('.bubble')).toHaveCount(1);
    await expect(page.locator('.bubble')).toContainText('开会');
    await expect(page.locator('.draft')).toHaveCount(0);
    await expect(page.locator('#cap-text')).toHaveValue('下午2:00到三点开会');
    const entries = () => page.evaluate(() => JSON.parse(localStorage.getItem('tango-donego.web.v1')!).entries);
    expect(await entries()).toEqual([expect.objectContaining({ title: '开会', start: '14:00', end: '15:00', prio: 3 })]);
    await page.locator('#capGo').click();
    await expect(page.locator('.draft')).toHaveCount(0);
    expect(await entries()).toHaveLength(1);
    await expect(page.locator('#mic')).toHaveAttribute('aria-pressed', 'false');
    await page.reload();
    await expect(page.locator('.bubble')).toHaveCount(1);
    expect(await entries()).toHaveLength(1);
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

  test('voice preserves unsent typing and existing drafts without submitting them', async ({ page }) => {
    await open(page, [], undefined, [{ ...paper, id: 'draft', title: '手动草稿' }]);
    await page.locator('#cap-text').fill('上午九点到十点写稿');
    await say(page, '下午两点到三点开会');
    await expect(page.locator('.bubble')).toHaveCount(1);
    await expect(page.locator('.draft [data-f="title"]')).toHaveValue('手动草稿');
    await expect(page.locator('#cap-text')).toHaveValue('上午九点到十点写稿；下午两点到三点开会');
    await page.locator('#capGo').click();
    await expect(page.locator('.draft')).toHaveCount(2);
    await expect(page.locator('.bubble')).toHaveCount(1);
    await expect(page.locator('.draft [data-f="title"]').nth(0)).toHaveValue('手动草稿');
    await expect(page.locator('.draft [data-f="title"]').nth(1)).toHaveValue('写稿');
  });

  test('successive recordings create only their new events with normal priority', async ({ page }) => {
    await open(page, []);
    await say(page, '下午两点到三点开会，然后四点到五点读书');
    await expect(page.locator('.bubble.p3')).toHaveCount(2);
    await say(page, '晚上七点到八点跑步');
    await expect(page.locator('.bubble.p3')).toHaveCount(3);
    await expect(page.locator('#cap-text')).toHaveValue('晚上七点到八点跑步');
    await page.locator('#capGo').click();
    await expect(page.locator('.draft')).toHaveCount(0);
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('tango-donego.web.v1')!).entries.map((e: any) => [e.title, e.start, e.end, e.prio]))).toEqual([
      ['开会', '14:00', '15:00', 3], ['读书', '16:00', '17:00', 3], ['跑步', '19:00', '20:00', 3],
    ]);
  });

  test('voice asks before replacing personal time and cancellation preserves it', async ({ page }) => {
    await open(page, [{ ...paper, id: 'stillness', kind: 'stillness', title: '自由安排', start: '14:00', end: '15:00', state: 'reserved' }]);
    await say(page, '下午两点到三点开会');
    await expect(page.locator('.sheet [data-act="clash"]')).toHaveCount(3);
    await page.locator('[data-act="clash"][data-v="cancel"]').click();
    await expect(page.locator('.bubble')).toHaveCount(1);
    await expect(page.locator('.bubble')).toHaveAttribute('data-id', 'stillness');
    await expect(page.locator('#cap-text')).toHaveValue('下午两点到三点开会');
    await expect(page.locator('#capGo')).toBeEnabled();
  });

  test('failed transcription keeps typing and a retry creates exactly one event', async ({ page }) => {
    await open(page, []);
    await page.locator('#cap-text').fill('保留文字');
    await page.route('**/api/speech', route => route.fulfill({ json: { available: true, languages: ['zh-CN'] } }));
    await page.route('**/api/speech/transcribe?lang=zh-CN', route => route.fulfill({ status: 503, json: { error: 'recognition-failed' } }));
    await page.locator('#mic').click();
    await expect(page.locator('#capStatus')).toContainText('在听');
    await page.clock.runFor(600);
    await page.locator('#mic').click();
    await expect(page.locator('#capStatus')).toContainText('转写未成功');
    await expect(page.locator('#cap-text')).toHaveValue('保留文字');
    await expect(page.locator('.bubble')).toHaveCount(0);
    await say(page, '下午两点到三点开会');
    await expect(page.locator('.bubble.p3')).toHaveCount(1);
    await expect(page.locator('.draft')).toHaveCount(0);
  });

  test('leaving during AI task parsing cancels automatic event creation', async ({ page }) => {
    await page.route('**/api/llm/config', route => route.fulfill({ json: { endpoints: [] } }));
    await page.route('**/api/assistant/config', route => route.fulfill({ json: { available: true, provider: 'openai', model: 'fixture', destination: 'https://example.test/voice-gateway' } }));
    await open(page, []);
    await page.evaluate(() => localStorage.setItem('tango-donego.llm.v1', JSON.stringify({ consent: true })));
    await page.reload();
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    await page.route('**/api/assistant/chat', async route => {
      await held;
      await route.fulfill({ json: { content: [{ type: 'text', text: JSON.stringify({ items: [{ title: '开会', kind: 'necessary', start: '14:00', end: '15:00', prio: 1 }] }) }] } });
    });
    const parsing = page.waitForRequest('**/api/assistant/chat');
    await say(page, '下午两点到三点开会');
    await page.locator('[data-act="send-confirm"]').click();
    await parsing;
    await page.locator('#tabs a[href="#review"]').click();
    const parsed = page.waitForResponse('**/api/assistant/chat');
    release();
    await parsed;
    await page.locator('#tabs a[href="#today"]').click();
    await expect(page.locator('.bubble')).toHaveCount(0);
    await expect(page.locator('.draft')).toHaveCount(0);
    await expect(page.locator('#capGo')).toBeEnabled();
  });

  test('browser speech fallback shares automatic creation and keeps typed text', async ({ page }) => {
    await open(page, []);
    await page.route('**/api/speech', route => route.fulfill({ json: { available: false, languages: [] } }));
    await page.evaluate(() => {
      (window as any).SpeechRecognition = class {
        onresult: any; onend: any;
        constructor() { (window as any).testRecognition = this; }
        start() {}
        stop() { this.onend(); }
        abort() {}
      };
    });
    await page.locator('#cap-text').fill('上午九点到十点写稿');
    await page.locator('#mic').click();
    await expect(page.locator('#mic')).toHaveAttribute('aria-pressed', 'true');
    await page.evaluate(() => {
      const results = [Object.assign([{ transcript: '下午两点到三点开会' }], { isFinal: true })];
      (window as any).testRecognition.onresult({ resultIndex: 0, results });
    });
    await page.locator('#mic').click();
    await expect(page.locator('.bubble.p3')).toHaveCount(1);
    await expect(page.locator('.draft')).toHaveCount(0);
    await expect(page.locator('#cap-text')).toHaveValue('上午九点到十点写稿；下午两点到三点开会');
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

test('local speech rejects external origins and malformed audio before recognition', async ({ request, baseURL }) => {
  const origin = new URL(baseURL!).origin;
  const external = await request.post('/api/speech/transcribe?lang=zh-CN', { headers: { Origin: 'https://example.com', 'Content-Type': 'audio/wav' }, data: Buffer.alloc(44) });
  expect(external.status()).toBe(403);
  const invalid = await request.post('/api/speech/transcribe?lang=zh-CN', { headers: { Origin: origin, 'Content-Type': 'audio/wav' }, data: Buffer.alloc(44) });
  expect(invalid.status()).toBe(400);
  const tooLarge = await request.post('/api/speech/transcribe?lang=zh-CN', { headers: { Origin: origin, 'Content-Type': 'audio/wav' }, data: Buffer.alloc(1000000) });
  expect(tooLarge.status()).toBe(413);
});
