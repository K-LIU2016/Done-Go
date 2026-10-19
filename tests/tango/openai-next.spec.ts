import { test, expect } from '@playwright/test';

test('server-configured extra-high reasoning is visible and outlasts the ordinary client timeout', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-10-17T10:00:00+08:00') });
  await page.addInitScript(() => {
    localStorage.setItem('tango-donego.web.v1', JSON.stringify({ v: 1, pv: 5, mode: 'real', name: '', wake: 960, entries: [], drafts: [], trials: [], fw: {}, pal: 0 }));
    localStorage.setItem('tango-donego.llm.v1', JSON.stringify({ mode: 'auto', consent: true }));
    localStorage.setItem('tango-donego.lang', 'zh');
  });
  await page.route('https://**', route => route.abort());
  await page.route('**/api/assistant/config', route => route.fulfill({ json: { available: true, provider: 'openai', model: 'gpt-6.1-sol', destination: 'https://api.openai-next.com/v1/chat/completions', reasoningEffort: 'xhigh' } }));
  let release!: () => void, started!: () => void, requests = 0;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const ready = new Promise<void>(resolve => { started = resolve; });
  await page.route('**/api/assistant/chat', async route => {
    requests++;
    expect(Object.keys(route.request().postDataJSON())).toEqual(['prompt']);
    started(); await waiting;
    await route.fulfill({ json: { content: [{ type: 'text', text: JSON.stringify({ reply: '可以先说说今天最想保留的一段时间。', suggestions: [] }) }] } });
  });
  await page.goto('/#assistant');
  await expect(page.locator('#assistant-connection')).toContainText('gpt-6.1-sol');
  await expect(page.locator('#assistant-connection')).toContainText('xhigh');
  await page.locator('#assistant-message').fill('帮我理清今天的安排');
  await page.locator('#assistant-send').click();
  await expect(page.locator('#send-preview')).toHaveCount(0);
  await ready;
  await page.clock.runFor(46000);
  await expect(page.locator('#assistant-send')).toBeDisabled();
  await expect(page.locator('#assistant-notice')).not.toContainText('没有取得');
  release();
  await expect(page.locator('.companion-message').last()).toContainText('可以先说说');
  expect(requests).toBe(1);
});
