import { test, expect } from '@playwright/test';

// Explicit engineering fixtures. Ordinary user UI is covered by completion-user.spec.ts.
test.beforeEach(async ({ page }) => { await page.addInitScript(() => { Object.defineProperty(window, '__TANGO_DEVELOPER_UI__', { value: true }); }); });

const day = '2026-10-14';
const method = { id: 'm1', version: 1, createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', name: '论文核验方法', category: 'read', status: 'active', inputs: '[资料]', steps: '核对原文', verify: '核对出处', stop: '无法核实时停止', modelId: 'unknown' };
const entry = { id: 'read', date: day, title: '读论文', start: '14:00', end: '15:00', kind: 'explore', prio: 2 };
const uses = [
  { id: 'recent', methodId: 'm1', methodVersion: 1, methodName: method.name, taskId: 'previous', date: '2026-10-12', status: 'completed', at: '2026-10-12T00:00:00.000Z' },
  { id: 'older', methodId: 'm1', methodVersion: 1, methodName: method.name, taskId: 'older-task', date: '2026-09-20', status: 'completed', at: '2026-09-20T00:00:00.000Z' }
];

test.beforeEach(async ({ page }) => {
  await page.clock.install({ time: new Date(day + 'T09:30:00+08:00') });
  await page.route('https://**', route => route.abort());
  await page.route('**/api/assistant/config', route => route.fulfill({ json: { available: false } }));
  await page.route('**/api/llm/config', route => route.fulfill({ json: { endpoints: [] } }));
  await page.addInitScript(({ entry, method, uses }) => {
    if (localStorage.getItem('v02-contract-seeded')) return;
    localStorage.setItem('tango-donego.web.v1', JSON.stringify({ v: 1, pv: 5, mode: 'real', name: '', wake: 960, entries: [entry], trials: [], drafts: [], methods: [method], methodUses: uses, fw: {}, pal: 0, sound: false }));
    localStorage.setItem('tango-donego.lang', 'zh');
    localStorage.setItem('tango-donego.llm.v1', JSON.stringify({ mode: 'off' }));
    localStorage.setItem('v02-contract-seeded', '1');
  }, { entry, method, uses });
});

test('today bubbles precede the shared event list in both appearances', async ({ page }) => {
  await page.goto('/#today');
  for (const theme of ['standard', 'designer']) {
    await page.locator('#appearance-select').selectOption(theme);
    const bubbles = await page.locator('.bubbles').boundingBox();
    const route = await page.locator('.paper-route').boundingBox();
    expect(bubbles!.y + bubbles!.height).toBeLessThanOrEqual(route!.y);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.locator('.paper-route .paper-event').click();
    await expect(page.locator('.sheet')).toContainText(entry.title);
    await page.keyboard.press('Escape');
  }
});

test('review shows reuse results for its window and opens saved methods without a dead tree link', async ({ page }) => {
  await page.goto('/#review');
  await expect(page.locator('[data-act="method-reuse"]')).toHaveCount(0);
  const results = page.locator('.review-method-results');
  await expect(results).toContainText('1 次完成并验收');
  await expect(results).toContainText('论文核验方法');
  await expect(results).not.toContainText('2 次完成并验收');
  await page.locator('[data-act="range"][data-d="30"]').click();
  await expect(results).toContainText('2 次完成并验收');
  await expect(results.locator('a[href="#line"]')).toHaveCount(0);
  await results.locator('[data-act="method-library"]').click();
  await expect(page).toHaveURL(/#review$/);
  await expect(page.getByRole('heading', { name: '我的 AI 工作手册' })).toBeVisible();
  await expect(page.locator('[data-act="method-reuse"]')).toBeVisible();
});

test('deleting an event preserves past method uses and their version identity', async ({ page }) => {
  await page.goto('/#today');
  await page.locator('[data-act="method-view"][data-id="read"]').click();
  await page.locator('[data-act="method-apply"]').click();
  await page.locator('.paper-route .paper-event').click();
  await page.locator('.sheet [data-act="del"]').click();
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('tango-donego.web.v1')!));
  expect(saved.entries).toEqual([]);
  expect(saved.methodUses).toHaveLength(3);
  expect(saved.methodUses[2]).toMatchObject({ taskId: 'read', methodId: 'm1', methodVersion: 1 });
  await page.reload();
  await page.goto('/#review');
  await page.locator('[data-act="method-library"]').click();
  await page.locator('[data-act="method-edit"]').click();
  await expect(page.locator('.sheet')).toBeVisible();
});
