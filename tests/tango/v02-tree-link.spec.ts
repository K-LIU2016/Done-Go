import { test, expect, type Page } from '@playwright/test';

// Explicit engineering fixtures. Ordinary user UI is covered by completion-user.spec.ts.
test.beforeEach(async ({ page }) => { await page.addInitScript(() => { Object.defineProperty(window, '__TANGO_DEVELOPER_UI__', { value: true }); }); });

const day = '2026-10-14';
const screen1 = { id: 't1', date: day, title: '筛选5篇论文', kind: 'necessary', start: '14:00', end: '15:00', prio: 3 };
const park = { id: 't2', date: day, title: '陪女儿去公园', kind: 'connect', start: '17:00', end: '18:00', prio: 3 };
const base = { v: 1, pv: 5, mode: 'real', name: 'KKK', wake: 960, entries: [screen1, park], trials: [], methods: [], methodUses: [], drafts: [], fw: {}, pal: 0, sound: false };
const items = [
  { type: 'news', title: '新工具帮助论文筛选与综述核查', source: 'Example Weekly', excerpt: '多篇论文的筛选与综述流程正在变化，论文初筛仍需人工核对。', url: 'https://example.test/paper-tools', publishedAt: '2026-10-12T00:00:00.000Z' },
  { type: 'podcast', title: 'GPT-5 定价与配额讨论', source: 'Example Cast', excerpt: '发布会纪要与定价策略。', url: 'https://example.test/gpt-price', publishedAt: '2026-10-11T00:00:00.000Z' }
];
async function open(page: Page) {
  await page.clock.install({ time: new Date(day + 'T09:30:00+08:00') });
  await page.route('https://**', route => route.abort());
  await page.route('**/api/llm/config', route => route.fulfill({ json: { endpoints: [] } }));
  await page.route('**/api/assistant/config', route => route.fulfill({ json: { available: false, provider: null, model: null, destination: null } }));
  await page.route('**/api/discovery**', route => route.fulfill({ json: { items, retrievedAt: '2026-10-14T01:30:00.000Z', stale: false, failures: [] } }));
  await page.addInitScript(({ state }) => {
    localStorage.setItem('tango-donego.web.v1', JSON.stringify(state));
    localStorage.setItem('tango-donego.llm.v1', JSON.stringify({ mode: 'off' }));
    localStorage.setItem('tango-donego.lang', 'zh');
  }, { state: base });
  await page.goto('/#line');
}
async function state(page: Page) { return page.evaluate(() => JSON.parse(localStorage.getItem('tango-donego.web.v1')!)); }

test('the outside world sits beside the tree on desktop and below on mobile', async ({ page }, info) => {
  await open(page);
  await page.locator('[data-companion-discover]').click();
  await expect(page.locator('.discovery-card').first()).toBeVisible();
  const main = await page.locator('.paper-line-main').boundingBox();
  const side = await page.locator('.paper-line-side').boundingBox();
  if (info.project.name === 'mobile') {
    expect(side!.y).toBeGreaterThan(main!.y + main!.height - 1);
  } else {
    expect(side!.x).toBeGreaterThan(main!.x + main!.width - 1);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
});

test('a task links to matching outside content but saves the source only after an explicit try', async ({ page }) => {
  await open(page);
  await page.locator('[data-companion-discover]').click();
  await expect(page.locator('.discovery-card').first()).toBeVisible();
  await page.locator('.tree .leaf[data-id="t1"]').click();
  await expect(page.locator('.sheet .leaf-related')).toContainText('相关外部内容');
  await expect(page.locator('.sheet .leaf-related')).toContainText('论文');
  await page.locator('[data-act="content-try"][data-url="https://example.test/paper-tools"]').click();
  await expect(page.locator('.sheet')).toContainText('查看模型能力');
  expect((await state(page)).entries.find((item: { id: string }) => item.id === 't1').sourceRef).toBeUndefined();
  await page.locator('.sheet [data-act="close"]').last().click();
  expect((await state(page)).entries.find((item: { id: string }) => item.id === 't1').sourceRef).toBeUndefined();
  await page.locator('.tree .leaf[data-id="t1"]').click();
  await page.locator('.sheet [data-act="content-try"][data-url="https://example.test/paper-tools"]').click();
  await page.locator('.sheet [data-act="source-try-start"]').click();
  const saved = await state(page);
  expect(saved.entries.find((item: { id: string }) => item.id === 't1').sourceRef).toMatchObject({ kind: 'discovery', url: 'https://example.test/paper-tools' });
  expect(saved.trials).toHaveLength(0);
  await page.locator('.sheet [data-act="close"]').last().click();
  await page.goto('/#today');
  await page.locator('[data-act="task-finish"][data-id="t1"]').first().click();
  await page.locator('#finish-min').fill('25');
  await page.locator('#finish-quality').selectOption('accepted');
  await page.locator('[data-act="finish-save"]').click();
  const overlay = page.locator('#layer .overlay');
  if (await overlay.count()) await overlay.locator('[data-act="close"]').first().click();
  await page.goto('/#review');
  await expect(page.locator('.paper-review-entry')).toContainText('来自树外内容：');
});

test('outside content finds related tasks back and stays silent without a real match', async ({ page }) => {
  await open(page);
  await page.locator('[data-companion-discover]').click();
  await expect(page.locator('.discovery-card').first()).toBeVisible();
  const paperCard = page.locator('.discovery-card', { hasText: '论文筛选与综述核查' });
  await paperCard.locator('.discovery-related summary').click();
  await expect(paperCard.locator('.discovery-related')).toContainText('筛选5篇论文');
  await expect(paperCard.locator('.discovery-related')).toContainText('论文');
  const pricingCard = page.locator('.discovery-card', { hasText: 'GPT-5 定价与配额讨论' });
  await expect(pricingCard.locator('.discovery-related')).toHaveCount(0);
  await page.locator('.tree .leaf[data-id="t2"]').click();
  await expect(page.locator('.sheet .leaf-related')).toContainText('不做牵强关联');
});
