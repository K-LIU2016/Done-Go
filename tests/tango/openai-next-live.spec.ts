import { test, expect } from '@playwright/test';

test('the configured gateway returns a real AI reply after preview without changing the synthetic ledger', async ({ page }, info) => {
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
      expect(Object.keys(request.postDataJSON())).toEqual(['prompt']);
      expect(request.headers()).not.toHaveProperty('authorization');
    }
  });
  await page.goto('/#assistant');
  await expect(page.locator('#assistant-connection')).toContainText('gpt-6.1-sol');
  await expect(page.locator('#assistant-connection')).toContainText('xhigh');
  await page.locator('#assistant-message').fill('合成连通验收，不是真实生活记录。请用一句话提出一个帮助我思考时间安排的问题，不给任何事项改动建议。');
  await page.locator('#assistant-send').click();
  await expect(page.locator('#send-preview')).toBeVisible();
  await expect(page.locator('.sheet')).toContainText('https://api.openai-next.com/v1/chat/completions');
  expect(sent).toBe(0);
  await page.locator('[data-act="send-confirm"]').click();
  await expect(page.locator('.companion-message:not(.is-user)')).toHaveCount(1, { timeout: 130000 });
  await expect(page.locator('.companion-message:not(.is-user)')).toContainText('AI 辅助回答');
  const saved = await page.evaluate(() => ({ ledger: JSON.parse(localStorage.getItem('tango-donego.web.v1')!), conversation: JSON.parse(localStorage.getItem('tango-donego.assistant.v1')!) }));
  expect(saved.ledger).toEqual(state);
  expect(saved.conversation.messages.at(-1).source).toBe('model');
  expect(saved.conversation.messages.at(-1).text.trim().length).toBeGreaterThan(0);
  expect(JSON.stringify(saved)).not.toMatch(/sk-[A-Za-z0-9_-]{20,}/);
  expect(sent).toBe(1);
  await page.screenshot({ path: info.outputPath('donego-openai-next-live.png'), fullPage: true });
});
