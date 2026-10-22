import { test, expect, type Page } from '@playwright/test';

// Explicit engineering fixtures. Ordinary user UI is covered by completion-user.spec.ts.
test.beforeEach(async ({ page }) => { await page.addInitScript(() => { Object.defineProperty(window, '__TANGO_DEVELOPER_UI__', { value: true }); }); });

const day = '2026-10-14';
const paper = (date: string) => ({ id: 'p-' + date, date, title: '读论文 ' + date, kind: 'explore', start: '09:00', end: '10:00', prio: 3 });
const base = { v: 1, pv: 5, mode: 'real', name: 'KKK', wake: 960, entries: [paper('2026-10-14'), paper('2026-10-02'), paper('2026-09-20')], trials: [
  { taskId: 'p-2026-10-14', date: '2026-10-14', title: '读论文 2026-10-14', before: 60, after: 40, usedAI: true, quality: 'accepted', confirmed: true, category: 'read' },
  { taskId: 'p-2026-10-02', date: '2026-10-02', title: '读论文 2026-10-02', before: 60, after: 30, usedAI: true, quality: 'accepted', confirmed: true, category: 'read' }
], methods: [], methodUses: [], drafts: [], fw: {}, pal: 0, sound: false };
async function open(page: Page, patch: Record<string, unknown> = {}) {
  await page.clock.install({ time: new Date(day + 'T20:30:00+08:00') });
  await page.route('https://**', route => route.abort());
  await page.route('**/api/llm/config', route => route.fulfill({ json: { endpoints: [] } }));
  await page.route('**/api/assistant/config', route => route.fulfill({ json: { available: true, provider: 'openai', model: 'fixture-chat', destination: 'https://example.test/v1/chat/completions' } }));
  await page.addInitScript(({ state }) => {
    localStorage.setItem('tango-donego.web.v1', JSON.stringify(state));
    localStorage.setItem('tango-donego.llm.v1', JSON.stringify({ mode: 'off' }));
    localStorage.setItem('tango-donego.lang', 'zh');
  }, { state: { ...base, ...patch } });
  await page.goto('/#review');
}

test('a 30-day review carries its exact window into the chat and states it visibly', async ({ page }) => {
  await open(page);
  const contexts: any[] = [];
  await page.route('**/api/assistant/chat', async route => {
    contexts.push(JSON.parse(route.request().postDataJSON().prompt.split('\nCONTEXT_JSON\n')[1]));
    await route.fulfill({ json: { content: [{ type: 'text', text: JSON.stringify({ reply: '受控回顾测试回答', suggestions: [] }) }] } });
  });
  await page.locator('[data-act="range"][data-d="30"]').click();
  await page.locator('[data-act="assistant-reflect"]').click();
  await expect(page.locator('#assistant-mode')).toHaveValue('reflection');
  await expect(page.locator('.companion-range')).toContainText('正在回顾：2026-09-15 → 2026-10-14');
  await page.locator('#assistant-privacy summary').click();
  await expect(page.locator('#assistant-share-metrics')).not.toBeChecked();
  await expect(page.locator('.companion-facts')).toHaveCount(0);
  expect(contexts).toHaveLength(0);
  await page.locator('#assistant-message').fill('请回顾这段时间');
  await page.locator('#assistant-send').click();
  await expect(page.locator('#assistant-send')).toBeEnabled();
  expect(contexts).toHaveLength(1);
  expect(contexts[0]).toMatchObject({ tasks: [], metrics: {}, modelEvidence: [] });
  await page.locator('#assistant-share-metrics').check();
  await expect(page.locator('.companion-facts')).toContainText('共享时段 2026-09-15 → 2026-10-14');
  await expect(page.locator('.companion-facts')).toContainText('2 项');
  await page.locator('#assistant-message').fill('根据我分享的汇总回顾');
  await page.locator('#assistant-send').click();
  await expect(page.locator('#assistant-send')).toBeEnabled();
  expect(contexts).toHaveLength(2);
  expect(contexts[1].metrics.period).toEqual({ from: '2026-09-15', to: '2026-10-14' });
  expect(contexts[1].tasks).toEqual([]);
  expect(contexts[1].modelEvidence).toEqual([]);
});

test('switching the time range yourself drops the carried window without pretending', async ({ page }) => {
  await open(page);
  await page.locator('[data-act="range"][data-d="30"]').click();
  await page.locator('[data-act="assistant-reflect"]').click();
  await expect(page.locator('.companion-range')).toBeVisible();
  await page.locator('#assistant-privacy summary').click();
  await expect(page.locator('#assistant-share-metrics')).not.toBeChecked();
  await page.locator('#assistant-share-metrics').check();
  await page.locator('#assistant-period').selectOption('week');
  await expect(page.locator('.companion-range')).toHaveCount(0);
  await expect(page.locator('.companion-facts')).toContainText('共享时段 2026-10-08 → 2026-10-14');
});

test('the default 7-day review still passes its own window', async ({ page }) => {
  await open(page);
  await page.locator('[data-act="assistant-reflect"]').click();
  await expect(page.locator('.companion-range')).toContainText('正在回顾：2026-10-08 → 2026-10-14');
});
