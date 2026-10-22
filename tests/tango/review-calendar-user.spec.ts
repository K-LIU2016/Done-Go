import { test, expect, type Page } from '@playwright/test';

const stateKey = 'tango-donego.web.v1';
async function openReview(page: Page) {
  await page.clock.install({ time: new Date('2026-10-21T18:00:00+08:00') });
  await page.route('https://**', route => route.abort());
  await page.route('**/api/assistant/config', route => route.fulfill({ json: { available: false } }));
  await page.route('**/api/llm/config', route => route.fulfill({ json: { endpoints: [] } }));
  await page.route('**/api/assistant/chat', () => { throw new Error('Review controls must not call a model'); });
  await page.addInitScript(key => {
    if (localStorage.getItem('review-calendar-seeded')) return;
    localStorage.setItem(key, JSON.stringify({ v: 1, pv: 5, mode: 'real', name: '', wake: 960, entries: [{ id: 'recorded', title: 'My original task', date: '2026-10-21', start: '09:00', end: '10:00', kind: 'explore', done: true, completion: { before: 60, actual: 25, timeRecorded: true, usedAI: false, quality: 'pending' } }], trials: [], methods: [], methodUses: [], drafts: [], fw: {}, sound: false, pal: 0 }));
    localStorage.setItem('tango-donego.lang', 'zh');
    localStorage.setItem('review-calendar-seeded', '1');
  }, stateKey);
  await page.goto('/#review');
}

for (const theme of ['standard', 'designer']) {
  test(theme + ' review keeps date cells and Monet colors for ordinary users in every language', async ({ page }, info) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await openReview(page);
    await page.locator('#appearance-select').selectOption(theme);
    const original = await page.evaluate(key => JSON.parse(localStorage.getItem(key)!).entries, stateKey);
    for (const language of ['zh', 'en', 'ru', 'th', 'ar', 'ko']) {
      await page.locator('#lang').selectOption(language);
      await page.locator('[data-act="range"][data-d="7"]').click();
      await expect(page.locator('.cal-d:not(.pad)')).toHaveCount(7);
      await expect(page.locator('.cal-d:not(.pad)').first()).toHaveAttribute('aria-label', /^2026-10-15/);
      await expect(page.locator('.cal-d.today .f')).toContainText('25');
      await expect(page.locator('.cal-pal button')).toHaveCount(7);
      await expect(page.locator('[data-act="cal-mon"][data-d="-1"]')).toBeDisabled();
      const initialColor = await page.locator('.cal-d.today').evaluate(el => getComputedStyle(el).backgroundColor);
      await page.locator('[data-act="cal-pal"][data-v="4"]').click();
      await expect(page.locator('[data-act="cal-pal"][data-v="4"]')).toHaveAttribute('aria-pressed', 'true');
      expect(await page.locator('.cal-d.today').evaluate(el => getComputedStyle(el).backgroundColor)).not.toBe(initialColor);
      if (language === 'zh') await page.screenshot({ path: info.outputPath(theme + '-7day-review.png'), fullPage: true });
      await page.locator('[data-act="range"][data-d="30"]').click();
      await expect(page.locator('.cal-d:not(.pad)')).toHaveCount(30);
      await expect(page.locator('.cal-d:not(.pad)').first()).toHaveAttribute('aria-label', /^2026-09-22/);
      await page.locator('[data-act="cal-mon"][data-d="1"]').click();
      await expect(page.locator('.cal-d.today')).toHaveCount(0);
      await expect(page.locator('.user-review-summary [data-metric="recorded-minutes"]')).toContainText('0');
      await expect(page.locator('.scope-note.full')).toContainText('2026-08-23');
      await expect(page.locator('.scope-note.full')).toContainText('2026-09-21');
      await page.locator('[data-act="cal-mon"][data-d="-1"]').click();
      await expect(page.locator('.cal-d.today .f')).toContainText('25');
      if (language !== 'zh') {
        expect(await page.locator('.cal').innerText()).not.toMatch(/[一-鿿]/);
        for (const label of await page.locator('.cal-pal button').evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-label')))) expect(label).not.toMatch(/[一-鿿]/);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      if (['zh', 'ar'].includes(language)) await page.screenshot({ path: info.outputPath(theme + '-' + language + '-review.png'), fullPage: true });
      await page.locator('[data-act="cal-pal"][data-v="0"]').click();
    }
    await page.locator('[data-act="cal-pal"][data-v="6"]').click();
    await page.reload();
    await expect(page.locator('[data-act="cal-pal"][data-v="6"]')).toHaveAttribute('aria-pressed', 'true');
    expect(await page.evaluate(key => JSON.parse(localStorage.getItem(key)!).entries, stateKey)).toEqual(original);
    await expect(page.locator('[data-act="cohort-export"],[data-metric="review-estimated"],#finish-quality')).toHaveCount(0);
    expect(errors).toEqual([]);
  });
}
