import { test, expect } from '@playwright/test';

test('the configured gateway returns a real AI reply on send without changing the synthetic ledger', async ({ page }, info) => {
  test.skip(process.env.TANGO_LIVE_AI !== '1', 'Opt-in billable integration; uses only synthetic browser data.');
  test.setTimeout(150000);
  const state = { v: 1, pv: 5, mode: 'real', name: '', wake: 960, entries: [], drafts: [], trials: [], fw: {}, pal: 0 };
  await page.addInitScript(state => {
    localStorage.setItem('tango-donego.web.v1', JSON.stringify(state));
    localStorage.setItem('tango-donego.llm.v1', JSON.stringify({ mode: 'auto', consent: true }));
    localStorage.setItem('tango-donego.lang', 'zh');
  }, state);
  let sent = 0;
  page.on('request', request => {
    if (new URL(request.url()).pathname === '/api/assistant/chat') {
      sent++;
      expect(request.postDataJSON()).toEqual({ prompt: expect.any(String), mode: 'chat', stream: true });
      expect(request.headers()).not.toHaveProperty('authorization');
    }
  });
  await page.goto('/#assistant');
  await expect(page.locator('#assistant-connection')).toBeHidden();
  await expect(page.locator('#assistant-root')).not.toContainText('gpt-6.1-sol');
  await expect(page.locator('#assistant-root')).not.toContainText('xhigh');
  await page.locator('#assistant-message').fill('合成连通验收，不是真实生活记录。请用一句话提出一个帮助我思考时间安排的问题，不给任何事项改动建议。');
  await page.locator('#assistant-send').click();
  await expect(page.locator('#send-preview')).toHaveCount(0);
  await expect(page.locator('.companion-message:not(.is-user)')).toHaveCount(1, { timeout: 130000 });
  await expect(page.locator('.companion-message:not(.is-user) .message-author')).toHaveText('探戈 · AI');
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('tango-donego.assistant.v1')!).messages.at(-1)?.source), { timeout: 130000 }).toBe('model');
  const saved = await page.evaluate(() => ({ ledger: JSON.parse(localStorage.getItem('tango-donego.web.v1')!), conversation: JSON.parse(localStorage.getItem('tango-donego.assistant.v1')!) }));
  expect(saved.ledger).toEqual(state);
  expect(saved.conversation.messages.at(-1).source).toBe('model');
  expect(saved.conversation.messages.at(-1).text.trim().length).toBeGreaterThan(0);
  expect(JSON.stringify(saved)).not.toMatch(/sk-[A-Za-z0-9_-]{20,}/);
  expect(sent).toBe(1);
  await page.screenshot({ path: info.outputPath('donego-openai-next-live.png'), fullPage: true });
});
