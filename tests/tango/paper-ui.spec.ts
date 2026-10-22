import { test, expect, type Page } from '@playwright/test';

// Every browser context is disposable and contains synthetic records only.
const state = { v: 1, pv: 5, mode: 'real', name: '', wake: 960, entries: [
  { id: 'read', date: '2026-10-19', title: '阅读论文，核对关键结论与出处', start: '09:00', end: '10:00', kind: 'explore', prio: 1 },
  { id: 'write', date: '2026-10-19', title: '整理研究提纲', start: '10:30', end: '11:30', kind: 'create', prio: 2 },
  { id: 'walk', date: '2026-10-19', title: '去公园走走', start: '17:00', end: '17:30', kind: 'restore', prio: 4 }
], trials: [], methods: [], methodUses: [], drafts: [], fw: {}, pal: 0, sound: false };

async function open(page: Page) {
  await page.clock.install({ time: new Date('2026-10-19T10:45:00+08:00') });
  await page.route('https://**', route => route.abort());
  await page.route('**/api/llm/config', route => route.fulfill({ json: { endpoints: [] } }));
  await page.route('**/api/assistant/config', route => route.fulfill({ json: { available: true, provider: 'openai', model: 'fixture-default', destination: 'https://example.test/v1/chat/completions', models: { heavy: 'fixture-chat', standard: 'fixture-advice', light: 'fixture-light' }, reasoningEffort: 'xhigh' } }));
  await page.addInitScript(state => {
    if (!localStorage.getItem('paper-fixture')) {
      localStorage.setItem('tango-donego.web.v1', JSON.stringify(state));
      localStorage.setItem('tango-donego.lang', 'zh');
      localStorage.setItem('tango-donego.llm.v1', JSON.stringify({ mode: 'off' }));
      localStorage.setItem('paper-fixture', '1');
    }
  }, state);
  await page.goto('/#today');
}

test('paper pages render real structures at desktop, tablet and mobile sizes', async ({ page }, info) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await open(page);
  const original = await page.evaluate(() => localStorage.getItem('tango-donego.web.v1'));
  await expect(page.locator('.paper-route')).toContainText('此刻计划：整理研究提纲');
  await expect(page.locator('.paper-route .paper-stop')).toHaveCount(3);
  await expect(page.locator('.paper-route')).toContainText('非时长比例');
  await expect(page.locator('.paper-route')).toContainText('尚无实际用时');
  for (const route of ['today', 'assistant', 'review', 'line']) {
    await page.goto('/#' + route);
    await expect(page.locator('#view')).not.toBeEmpty();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.screenshot({ path: info.outputPath('paper-' + route + '.png'), fullPage: true });
  }
  await expect(page.locator('.tree .leaf')).toHaveCount(3);
  await expect(page.locator('.paper-tree-list,.paper-methods,.tree-hint')).toHaveCount(0);
  await page.locator('.tree .leaf').first().click();
  await expect(page.locator('.sheet')).toContainText('阅读论文');
  await page.keyboard.press('Escape');
  expect(await page.evaluate(() => localStorage.getItem('tango-donego.web.v1'))).toBe(original);
  if (info.project.name === 'desktop') {
    await page.setViewportSize({ width: 768, height: 1024 });
    for (const route of ['today', 'assistant', 'review', 'line']) {
      await page.goto('/#' + route);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      await page.screenshot({ path: info.outputPath('tablet-' + route + '.png'), fullPage: true });
    }
  }
  expect(errors).toEqual([]);
});

test('model labels follow purpose, failure keeps the draft, and retry sends once with safe formatting', async ({ page }, info) => {
  await open(page);
  await page.goto('/#assistant');
  await expect(page.locator('#assistant-connection')).toBeHidden();
  await expect(page.locator('#assistant-root')).not.toContainText('fixture-chat');
  await page.locator('#assistant-mode').selectOption('priorities');
  await expect(page.locator('#assistant-connection')).toBeHidden();
  await expect(page.locator('#assistant-root')).not.toContainText('fixture-advice');
  await expect(page.locator('#assistant-root')).not.toContainText('xhigh');
  await page.locator('#assistant-mode').selectOption('chat');
  await expect(page.locator('#assistant-privacy')).not.toHaveAttribute('open');
  await expect(page.locator('#assistant-records')).not.toHaveAttribute('open');
  await expect(page.locator('#assistant-privacy summary')).toContainText('仅当前对话');
  let sent = 0;
  await page.route('**/api/assistant/chat', route => {
    sent++;
    if (sent === 1) return route.fulfill({ status: 503, json: { error: 'ai-upstream-failed' } });
    return route.fulfill({ contentType: 'text/event-stream', body: 'data: ' + JSON.stringify({ text: '可以先从**核对关键结论**开始。\n- 写出研究问题\n- 对照原文检查\n[来源](https://example.test/paper)\n[危险](javascript:alert)\n```js\nconsole.log("检查来源");\n```' }) + '\n\ndata: [DONE]\n\n' });
  });
  const draft = '  我的论文阅读任务应该怎样使用 AI？  ';
  await page.locator('#assistant-message').fill(draft);
  await page.locator('#assistant-send').click();
  await expect(page.locator('#assistant-message')).toHaveValue(draft);
  await expect(page.locator('#assistant-notice')).toContainText('歇一会儿');
  await expect(page.locator('#assistant-send')).toHaveText('重试');
  await page.locator('#assistant-send').click();
  await expect(page.locator('.companion-message:not(.is-user) strong')).toContainText('核对关键结论');
  await expect(page.locator('.companion-message.is-user')).toHaveCount(1);
  await expect(page.locator('.companion-message ul li')).toHaveCount(2);
  await expect(page.locator('.companion-message pre')).toContainText('console.log');
  await expect(page.locator('.companion-message a')).toHaveCount(1);
  await expect(page.locator('.companion-message a')).toHaveAttribute('rel', 'noopener noreferrer');
  await expect(page.locator('#send-preview')).toHaveCount(0);
  expect(sent).toBe(2);
  await page.screenshot({ path: info.outputPath('paper-assistant-conversation.png'), fullPage: true });
  await page.locator('[data-companion-support]').click();
  await expect(page.locator('.sheet')).toContainText('通过小组邀请暗号加入');
});
