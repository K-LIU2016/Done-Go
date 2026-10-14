import { test, expect, type Page } from '@playwright/test';

const paper = { id: 'paper', date: '2026-10-14', title: '读论文', kind: 'explore', start: '09:00', end: '10:00', prio: 1 };
const base = { v: 1, pv: 5, mode: 'real', name: 'KKK', wake: 960, entries: [paper], trials: [], drafts: [], fw: {}, pal: 0, sound: false };
async function open(page: Page, patch: Record<string, unknown> = {}) {
  await page.clock.install({ time: new Date('2026-10-14T09:30:00+08:00') });
  await page.route('https://**', route => route.abort());
  await page.addInitScript(state => {
    if (!localStorage.getItem('tango.test.initialized')) {
      localStorage.setItem('leubai.web.v1', JSON.stringify(state));
      localStorage.setItem('leubai.llm.v1', JSON.stringify({ mode: 'off' }));
      localStorage.setItem('leubai.lang', 'zh');
      localStorage.setItem('tango.test.initialized', 'true');
    }
  }, { ...base, ...patch });
  await page.goto('/');
}
async function state(page: Page) { return page.evaluate(() => JSON.parse(localStorage.getItem('leubai.web.v1')!)); }
async function finish(page: Page, minutes: string) {
  await page.locator('[data-act="task-finish"][data-id="paper"]').first().click();
  await page.locator('#finish-min').fill(minutes);
  await page.locator('#finish-ai').check();
  await page.locator('[data-act="finish-save"]').click();
}

test('the daily budget counts overlapping reservations once', async ({ page }) => {
  await open(page, { entries: [paper, { ...paper, id: 'second', start: '09:30', end: '10:30', kind: 'necessary' }] });
  await expect(page.locator('[data-metric="unplanned"]')).toContainText('14');
  await expect(page.locator('[data-metric="unplanned"]')).toContainText('30');
  await expect(page.getByText('全天未排', { exact: true })).toBeVisible();
});
test('model guidance has named companies and models without changing the plan', async ({ page }) => {
  await open(page);
  const before = await state(page);
  await page.locator('[data-act="ai-tools"][data-id="paper"]').first().click();
  await expect(page.locator('.sheet')).toContainText('Anthropic');
  await expect(page.locator('.sheet')).toContainText('Claude Sonnet 4.6');
  await expect(page.locator('.sheet')).toContainText('待估算');
  await expect(page.locator('.sheet a[href^="https://"]')).not.toHaveCount(0);
  expect(await state(page)).toEqual(before);
});
test('generic work and meals do not acquire invented AI savings', async ({ page }) => {
  await open(page, { entries: [{ ...paper, id: 'work', title: '工作', kind: 'necessary' }, { ...paper, id: 'food', title: '吃饭', kind: 'connect', start: '12:00', end: '13:00' }] });
  await expect(page.locator('[data-act="ai-tools"]')).toHaveCount(0);
  await page.goto('/#review');
  await expect(page.locator('.ai-row')).toHaveCount(0);
  await expect(page.locator('#view')).not.toContainText('每天约省');
});
test('confirmed completion creates a choice, not an automatic reservation, and survives reload', async ({ page }) => {
  await open(page);
  await finish(page, '40');
  await expect(page.locator('.sheet')).toContainText('腾出 20 min');
  await expect(page.locator('.sheet')).toContainText('09:40–10:00');
  await page.screenshot({ path: test.info().outputPath('completion-choice.png') });
  const saved = await state(page);
  expect(saved.trials).toHaveLength(1);
  expect(saved.trials[0]).toMatchObject({ before: 60, after: 40, confirmed: true, taskId: 'paper', usedAI: true });
  expect(saved.entries.filter((item: { kind: string }) => item.kind === 'blank')).toHaveLength(0);
  await page.reload();
  await expect(page.locator('[data-metric="saved"]')).toContainText('20');
  await expect(page.locator('[data-act="task-finish"][data-id="paper"]')).toHaveCount(0);
  await expect(page.locator('[data-act="time-use"]')).toHaveCount(3);
});
test('a walk is reserved only after the user chooses it', async ({ page }) => {
  await open(page);
  await finish(page, '40');
  await page.locator('.sheet [data-act="time-use"][data-v="walk"]').click();
  const saved = await state(page);
  expect(saved.entries.find((item: { kind: string }) => item.kind === 'blank')).toMatchObject({ start: '09:40', end: '10:00', use: 'restore', title: '散步', state: 'reserved' });
  expect(saved.trials).toHaveLength(1);
});
test('completion rejects blank and negative actual durations', async ({ page }) => {
  await open(page);
  await page.locator('[data-act="task-finish"][data-id="paper"]').first().click();
  await page.locator('[data-act="finish-save"]').click();
  await expect(page.locator('#finish-error')).toBeVisible();
  await page.locator('#finish-min').fill('-1');
  await page.locator('[data-act="finish-save"]').click();
  expect((await state(page)).trials).toHaveLength(0);
});
test('an overrun produces no fabricated time or booking invitation', async ({ page }) => {
  await open(page);
  await finish(page, '80');
  await expect(page.locator('[data-act="time-use"]')).toHaveCount(0);
  await expect(page.locator('[data-metric="saved"]')).toContainText('0');
  expect((await state(page)).trials[0].after).toBe(80);
});
test('historical freed intervals do not get silently booked into the past', async ({ page }) => {
  await open(page, { entries: [{ ...paper, start: '07:00', end: '08:00' }] });
  await finish(page, '40');
  await expect(page.locator('.sheet [data-act="time-use"][data-v="walk"]')).toBeDisabled();
  await expect(page.locator('.sheet')).toContainText('另选时段');
});
test('review respects range selection and ignores legacy unconfirmed reductions', async ({ page }) => {
  await open(page, { entries: [{ ...paper, ai: { before: 60, after: 10 } }], trials: [{ date: '2026-10-01', before: 60, after: 20, confirmed: true }, { date: '2026-10-14', before: 60, after: 40 }] });
  await page.goto('/#review');
  await expect(page.locator('[data-metric="review-saved"]')).toContainText('0');
  await expect(page.locator('#view')).not.toContainText('自由指数');
  await page.locator('[data-act="range"][data-d="30"]').click();
  await expect(page.locator('[data-metric="review-saved"]')).toContainText('40');
});
test('time bands and list views both expose real task durations', async ({ page }) => {
  await open(page);
  await page.goto('/#line');
  await expect(page.locator('.duration-band')).toHaveCount(1);
  await page.locator('[data-act="line-view"][data-v="list"]').click();
  await expect(page.locator('.timeline-list')).toContainText('09:00–10:00');
  await expect(page.locator('.timeline-list')).toContainText('60 min');
  await page.screenshot({ path: test.info().outputPath('timeline-list.png'), fullPage: true });
});
test('typing a task still creates an editable draft and preserves priority', async ({ page }) => {
  await open(page, { entries: [] });
  await page.screenshot({ path: test.info().outputPath('empty-today.png'), fullPage: true });
  await page.locator('#cap-text').fill('下午两点到三点开会，最重要');
  await page.locator('#capGo').click();
  await expect(page.locator('.draft')).toHaveCount(1);
  await page.locator('[data-act="draft-commit"]').click();
  const saved = await state(page);
  expect(saved.entries[0]).toMatchObject({ start: '14:00', end: '15:00', prio: 1 });
});
test('personal estimates remain separate from confirmed gains', async ({ page }) => {
  await open(page, { trials: [
    { taskId: 'p1', date: '2026-10-12', before: 60, after: 40, usedAI: true, category: 'read', confirmed: true },
    { taskId: 'p2', date: '2026-10-13', before: 60, after: 30, usedAI: true, category: 'read', confirmed: true },
  ] });
  await page.locator('[data-act="ai-tools"][data-id="paper"]').first().click();
  await expect(page.locator('.sheet')).toContainText('20–30 min');
  await expect(page.locator('.sheet')).toContainText('2 次确认记录');
  await expect(page.locator('[data-metric="saved"]')).toContainText('0');
});

test('a canceled booking conflict preserves the task and pending choice', async ({ page }) => {
  const overlap = { ...paper, id: 'other', title: '工作', start: '09:40', end: '10:00', kind: 'necessary' };
  await open(page, { entries: [paper, overlap] });
  await finish(page, '40');
  await page.locator('.sheet [data-act="time-use"][data-v="walk"]').click();
  await expect(page.locator('.sheet')).toContainText('时间撞了');
  await page.locator('[data-act="clash"][data-v="cancel"]').click();
  const saved = await state(page);
  expect(saved.entries.find((item: { id: string }) => item.id === 'other')).toEqual(overlap);
  expect(saved.entries.find((item: { id: string }) => item.id === 'paper').freed.pending).toBe(true);
  expect(saved.entries.filter((item: { kind: string }) => item.kind === 'blank')).toHaveLength(0);
});

test('custom use rejects past times and lets the user choose a future interval', async ({ page }) => {
  await open(page);
  await finish(page, '40');
  await page.locator('.sheet [data-act="time-use"][data-v="custom"]').click();
  await page.locator('#use-title').fill('陪家人');
  await page.locator('#use-start').fill('08:00');
  await page.locator('[data-act="use-save"]').click();
  await expect(page.locator('#use-error')).toBeVisible();
  expect((await state(page)).entries).toHaveLength(1);
  await page.locator('#use-start').fill('18:00');
  await page.locator('[data-act="use-save"]').click();
  expect((await state(page)).entries.find((item: { kind: string }) => item.kind === 'blank')).toMatchObject({ title: '陪家人', use: 'connect', start: '18:00', end: '18:20' });
});

test('personal-time use is counted only after confirmation', async ({ page }) => {
  await open(page, { entries: [{ id: 'walk', title: '散步', kind: 'blank', use: 'restore', state: 'reserved', kept: 0, date: '2026-10-14', start: '08:00', end: '08:20' }] });
  await page.goto('/#review');
  await expect(page.locator('[data-metric="personal-used"]')).toContainText('0');
  await page.locator('[data-act="kept"][data-id="walk"]').click();
  await expect(page.locator('[data-metric="personal-used"]')).toContainText('20');
  await page.reload();
  await expect(page.locator('[data-metric="personal-used"]')).toContainText('20');
});

test('model dialog traps keyboard focus and restores the opener', async ({ page }) => {
  await open(page);
  const opener = page.locator('[data-act="ai-tools"][data-id="paper"]').first();
  await opener.click();
  const last = page.locator('.sheet a').last();
  await last.focus();
  await page.keyboard.press('Tab');
  await expect(page.locator('.sheet button').first()).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(opener).toBeFocused();
});

test('Arabic navigation remains readable without horizontal overflow', async ({ page }, info) => {
  await open(page);
  await page.locator('#lang').selectOption('ar');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  for (const route of ['today', 'line', 'review']) {
    await page.goto('/#' + route);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  }
  await page.screenshot({ path: info.outputPath('arabic-review.png'), fullPage: true });
});

test('screens and dialogs fit the viewport in both themes and English', async ({ page }, info) => {
  await open(page);
  for (const theme of ['light', 'dark']) {
    await page.evaluate(value => document.documentElement.dataset.theme = value, theme);
    for (const route of ['today', 'line', 'review']) {
      await page.goto('/#' + route);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      await page.screenshot({ path: info.outputPath(`${theme}-${route}.png`), fullPage: true });
    }
  }
  await page.goto('/#today');
  await page.locator('#lang').selectOption('en');
  await expect(page.getByText('Unscheduled today', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.locator('[data-act="ai-tools"][data-id="paper"]').first().click();
  const box = await page.locator('.sheet').boundingBox();
  expect(box!.width).toBeLessThanOrEqual(info.project.use.viewport!.width);
  await page.screenshot({ path: info.outputPath('model-sheet.png') });
});
