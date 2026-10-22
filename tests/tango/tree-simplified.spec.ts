import { test, expect, type Page } from '@playwright/test';

// Disposable browser contexts and synthetic records only. No real model calls.
const day = '2026-10-21';
const entry = { id: 'tree-task', date: day, title: '核对论文原文与出处', start: '09:00', end: '10:00', kind: 'explore', prio: 2 };
const method = { id: 'tree-method', version: 1, createdAt: '2026-10-20T00:00:00.000Z', updatedAt: '2026-10-20T00:00:00.000Z', name: '自己的核对方法', purpose: '保留的方法原文', category: 'read', inputs: '[资料]', steps: '核对原文', verify: '逐项核对出处', stop: '无出处则停止', modelId: 'unknown', status: 'active' };
async function open(page: Page) {
  await page.clock.install({ time: new Date(day + 'T09:30:00+08:00') });
  await page.route('https://**', route => route.abort());
  await page.route('**/api/assistant/config', route => route.fulfill({ json: { available: false } }));
  await page.route('**/api/llm/config', route => route.fulfill({ json: { endpoints: [] } }));
  await page.route('**/api/discovery**', route => route.fulfill({ json: { items: [], failures: [], stale: false } }));
  await page.route('**/api/assistant/chat', () => { throw new Error('tree navigation must not invoke a model'); });
  await page.addInitScript(({ entry, method }) => {
    if (localStorage.getItem('tree-simple-seeded')) return;
    localStorage.setItem('tango-donego.web.v1', JSON.stringify({ v: 1, pv: 5, mode: 'real', name: '', wake: 960, entries: [entry], methods: [method], methodUses: [], trials: [], drafts: [], fw: {}, sound: false, pal: 0 }));
    localStorage.setItem('tango-donego.lang', 'zh');
    localStorage.setItem('tango-donego.llm.v1', JSON.stringify({ consent: false }));
    localStorage.setItem('tree-simple-seeded', '1');
  }, { entry, method });
  await page.goto('/#line');
}
const saved = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem('tango-donego.web.v1')!));

for (const theme of ['standard', 'designer']) {
  test(theme + ' removes duplicate tree sections in all languages while keeping keyboard access and dates', async ({ page }, info) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await open(page);
    await page.locator('#appearance-select').selectOption(theme);
    const before = await saved(page);
    for (const language of ['zh', 'en', 'ru', 'th', 'ar', 'ko']) {
      await page.locator('#lang').selectOption(language);
      await expect(page.locator('.paper-tree-list,.paper-methods,.tree-hint')).toHaveCount(0);
      await expect(page.locator('#view [data-act="method-library"]')).toHaveCount(0);
      await expect(page.locator('.tree .leaf')).toHaveCount(1);
      await expect(page.locator('.tree-now')).toBeVisible();
      const leaf = page.locator('.tree .leaf[data-id="tree-task"]');
      await leaf.focus();
      await page.keyboard.press('Enter');
      await expect(page.locator('.sheet')).toContainText(entry.title);
      await expect(page.locator('.sheet [data-act="edit"]')).toBeVisible();
      await expect(page.locator('.sheet [data-act="task-finish"]')).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(leaf).toBeFocused();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      if (language !== 'zh') {
        const systemCopy = await page.locator('#view').evaluate(element => {
          const clone = element.cloneNode(true) as HTMLElement;
          clone.querySelectorAll('svg,[data-user-content],[translate="no"]').forEach(node => node.remove());
          return clone.textContent;
        });
        expect(systemCopy, language).not.toMatch(/[一-鿿]/);
        expect(await leaf.getAttribute('aria-label')).toContain(entry.title);
      }
      if (['zh', 'ar'].includes(language)) await page.screenshot({ path: info.outputPath(theme + '-' + language + '-tree.png'), fullPage: true });
      await page.locator('[data-act="day"][data-d="-1"]').click();
      await expect(page.locator('.tree .leaf,.tree-now')).toHaveCount(0);
      await page.locator('[data-act="day"][data-d="1"]').click();
      await expect(leaf).toBeVisible();
    }
    expect(await saved(page)).toEqual(before);
    expect(errors).toEqual([]);
  });

  test(theme + ' tree still edits, completes and deletes the same event and review can open saved methods', async ({ page }) => {
    await open(page);
    await page.locator('#appearance-select').selectOption(theme);
    await page.locator('.tree .leaf').click();
    await page.locator('.sheet [data-act="edit"]').click();
    await page.locator('#ed-title').fill('核对修改后的论文');
    await page.locator('[data-act="ed-save"]').click();
    await expect(page.locator('.tree .leaf')).toHaveAccessibleName(/核对修改后的论文/);
    await page.locator('.tree .leaf').click();
    await page.locator('.sheet [data-act="task-finish"]').click();
    await page.locator('#finish-min').fill('25');
    await page.locator('#finish-ai').check();
    await page.locator('#finish-model-name').fill('user-selected-model');
    await page.locator('[data-act="finish-save"]').click();
    expect((await saved(page)).entries).toHaveLength(1);
    expect((await saved(page)).entries[0]).toMatchObject({ id: entry.id, done: true, completion: { actual: 25, modelName: 'user-selected-model' } });
    await page.goto('/#review');
    await expect(page.locator('.user-review-records')).toContainText('核对修改后的论文');
    await expect(page.locator('.companion-invite a[href="#line"]')).toHaveCount(0);
    await page.locator('[data-act="method-library"]').click();
    await expect(page).toHaveURL(/#review$/);
    await expect(page.locator('.sheet')).toContainText(method.name);
    await page.locator('.sheet [data-act="method-edit"]').click();
    await expect(page.locator('#me-verify')).toHaveValue(method.verify);
    await page.keyboard.press('Escape');
    await page.goto('/#line');
    await page.locator('.tree .leaf').click();
    await page.locator('.sheet [data-act="del"]').click();
    await expect(page.locator('.tree .leaf')).toHaveCount(0);
    expect((await saved(page)).entries).toEqual([]);
    expect((await saved(page)).methods).toHaveLength(1);
    await page.goto('/#review');
    await page.locator('[data-act="method-library"]').click();
    await expect(page.locator('.sheet')).toContainText(method.name);
  });
}
