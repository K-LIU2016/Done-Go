import { test, expect, type Page } from '@playwright/test';

const paper = { id: 'paper', date: '2026-10-14', title: '读论文', kind: 'explore', start: '09:00', end: '10:00', prio: 1 };
const base = { v: 1, pv: 5, mode: 'real', name: 'KKK', wake: 960, entries: [paper], trials: [], drafts: [], fw: {}, pal: 0, sound: false };
async function open(page: Page, patch: Record<string, unknown> = {}, llm: Record<string, unknown> = { mode: 'off' }) {
  await page.clock.install({ time: new Date('2026-10-14T09:30:00+08:00') });
  await page.route('https://**', route => route.abort());
  await page.addInitScript(({ state, llm }) => {
    if (!localStorage.getItem('tango.test.initialized')) {
      localStorage.setItem('tango-donego.web.v1', JSON.stringify(state));
      localStorage.setItem('tango-donego.llm.v1', JSON.stringify(llm));
      localStorage.setItem('tango-donego.lang', 'zh');
      localStorage.setItem('tango.test.initialized', 'true');
    }
  }, { state: { ...base, ...patch }, llm });
  await page.goto('/');
}
async function state(page: Page) { return page.evaluate(() => JSON.parse(localStorage.getItem('tango-donego.web.v1')!)); }
async function expandTasks(page: Page) {
  const panel = page.locator('#task-advice');
  if (await panel.getAttribute('open') === null) await panel.locator('summary').click();
}
async function finish(page: Page, minutes: string, quality = 'accepted') {
  await expandTasks(page);
  await page.locator('[data-act="task-finish"][data-id="paper"]').first().click();
  await page.locator('#finish-min').fill(minutes);
  await page.locator('#finish-ai').check();
  await page.locator('#finish-quality').selectOption(quality);
  await page.locator('[data-act="finish-save"]').click();
}

test('the daily budget counts overlapping reservations once', async ({ page }) => {
  await open(page, { entries: [paper, { ...paper, id: 'second', start: '09:30', end: '10:30', kind: 'necessary' }] });
  await expect(page.locator('[data-metric="unplanned"]')).toContainText('14');
  await expect(page.locator('[data-metric="unplanned"]')).toContainText('30');
  await expect(page.getByText('全天未排', { exact: true })).toBeVisible();
  const input = await page.locator('#cap-text').boundingBox();
  expect(input!.y + input!.height).toBeLessThan(test.info().project.use.viewport!.height);
  const hello = await page.locator('.hello').boundingBox();
  const overview = await page.locator('.time-overview').boundingBox();
  expect(hello).not.toBeNull();
  expect(overview).not.toBeNull();
  expect(overview!.y).toBeGreaterThanOrEqual(hello!.y + hello!.height);
  await expect(page.locator('[data-act="budget-edit"]')).toContainText('今日预算');
  await expect(page.locator('[data-act="budget-edit"]')).toBeVisible();
  await expect(page.locator('.budget-row span.budget-chip').filter({ hasText: '今日已预留' })).toBeVisible();
});
test('today budget is editable and persists without clearing the capture input', async ({ page }) => {
  await open(page);
  await page.locator('#cap-text').fill('14:00–15:00 读论文');
  await page.locator('[data-act="budget-edit"]').click();
  await expect(page.locator('#today-budget')).toBeFocused();
  await page.locator('#today-budget').fill('10');
  await page.locator('#budgetForm button[type="submit"]').click();
  await expect(page.locator('[data-act="budget-edit"]')).toContainText('10');
  await expect(page.locator('#cap-text')).toHaveValue('14:00–15:00 读论文');
  expect((await state(page)).wake).toBe(600);
  await page.reload();
  await expect(page.locator('[data-act="budget-edit"]')).toContainText('10');
});
test('today budget edit can be canceled with Escape', async ({ page }) => {
  await open(page);
  await page.locator('[data-act="budget-edit"]').click();
  await page.locator('#today-budget').fill('12');
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-act="budget-edit"]')).toContainText('16');
  await expect(page.locator('#budgetForm')).toBeHidden();
});
test('model guidance has named companies and models without changing the plan', async ({ page }) => {
  await open(page);
  await expandTasks(page);
  const before = await state(page);
  await page.locator('[data-act="ai-tools"][data-id="paper"]').first().click();
  await expect(page.locator('.sheet')).toContainText('Anthropic');
  await expect(page.locator('.sheet')).toContainText('Claude Sonnet');
  await expect(page.locator('.sheet')).toContainText('时间收益待实测 · 样本不足');
  await expect(page.locator('.guidance-steps li')).toHaveCount(3);
  await expect(page.locator('#model-prompt')).toHaveValue(/页码/);
  await expect(page.locator('.sheet a[href^="https://"]')).not.toHaveCount(0);
  expect(await state(page)).toEqual(before);
});
test('generic work and meals receive scoped guidance without counting estimates as savings', async ({ page }) => {
  await open(page, { entries: [{ ...paper, id: 'work', title: '工作', kind: 'necessary' }, { ...paper, id: 'food', title: '吃饭', kind: 'connect', start: '12:00', end: '13:00' }] });
  await expandTasks(page);
  await expect(page.locator('.task-list [data-act="ai-tools"]')).toHaveCount(2);
  await page.locator('[data-act="ai-tools"][data-id="food"]').click();
  await expect(page.locator('.sheet')).toContainText('准备环节');
  await expect(page.locator('.sheet')).toContainText('吃饭时长不压缩');
  await page.locator('[data-act="close"]').first().click();
  await expect(page.locator('[data-metric="saved"]')).toHaveCount(0);
  expect((await state(page)).trials).toHaveLength(0);
  await page.goto('/#review');
  await expect(page.locator('.ai-row')).toHaveCount(2);
  await expect(page.locator('#view')).not.toContainText('每天约省');
});

test('task-specific guidance prioritizes different models and includes executable prompts', async ({ page }, info) => {
  await open(page, { entries: [paper, { ...paper, id: 'code', title: '修复登录代码', kind: 'create' }, { ...paper, id: 'meeting', title: '世界旅游大会', kind: 'necessary' }] });
  await expandTasks(page);
  const before = await state(page);
  const cases = [
    { id: 'paper', model: 'Claude', prompt: /页码/ },
    { id: 'code', model: 'GPT', prompt: /复现|测试/ },
    { id: 'meeting', model: 'Gemini', prompt: /纪要|待办/ },
  ];
  for (const item of cases) {
    await page.locator('.task-list [data-act="ai-tools"][data-id="' + item.id + '"]').click();
    await expect(page.locator('.tool').first()).toContainText(item.model);
    await expect(page.locator('.tool').first().locator('.model-reason')).not.toBeEmpty();
    await expect(page.locator('.guidance-steps li')).toHaveCount(3);
    await expect(page.locator('#model-prompt')).toHaveValue(item.prompt);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    if (item.id === 'paper') await page.screenshot({ path: info.outputPath('task-guidance.png') });
    await page.locator('[data-act="close"]').first().click();
  }
  expect(await state(page)).toEqual(before);
});

test('short tasks cannot claim more saved minutes than their duration', async ({ page }) => {
  await open(page, { entries: [{ ...paper, end: '09:01' }] });
  await expandTasks(page);
  const text = await page.locator('.task-list .ai-inline').innerText();
  expect(text).toContain('待实测');
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
  expect(saved.entries[0].forecast).toMatchObject({ before: 60, low: null, high: null, source: 'insufficient' });
  expect(saved.entries.filter((item: { kind: string }) => item.kind === 'stillness')).toHaveLength(0);
  // Later history must not rewrite this task's original completion-time forecast.
  saved.trials.push({ taskId: 'later', date: '2026-10-01', before: 60, after: 10, usedAI: true, category: 'read', confirmed: true });
  await page.evaluate(value => localStorage.setItem('tango-donego.web.v1', JSON.stringify(value)), saved);
  await page.reload();
  await expect(page.locator('[data-metric="saved"]')).toHaveCount(0);
  await expect(page.locator('[data-act="task-finish"][data-id="paper"]')).toHaveCount(0);
  await expect(page.locator('[data-act="time-use"]')).toHaveCount(3);
  await page.goto('/#review');
  await expect(page.locator('[data-metric="review-actual"]')).toContainText('20');
  await expect(page.locator('[data-metric="review-estimated"]')).toContainText('待实测');
});
test('pending completion survives reload and only accepted follow-up creates a gain', async ({ page }) => {
  await open(page);
  await finish(page, '40', 'pending');
  await expect(page.locator('.sheet')).toHaveCount(0);
  let saved = await state(page);
  expect(saved.trials[0]).toMatchObject({ after: 40, quality: 'pending' });
  expect(saved.entries[0].freed).toBeUndefined();
  await page.goto('/#review');
  await expect(page.locator('[data-metric="review-actual"]')).toHaveText('0 min');
  await expect(page.getByRole('heading', { name: '待验收事项', exact: true })).toBeVisible();
  await page.locator('[data-act="task-finish"][data-id="paper"]').click();
  await page.locator('#finish-quality').selectOption('accepted');
  await page.locator('[data-act="finish-save"]').click();
  await expect(page.locator('.sheet')).toContainText('腾出 20 min');
  saved = await state(page);
  expect(saved.trials[0]).toMatchObject({ after: 40, quality: 'accepted' });
  expect(saved.entries[0].freed).toMatchObject({ pending: true, minutes: 20 });
});
test('a walk is reserved only after the user chooses it', async ({ page }) => {
  await open(page);
  await finish(page, '40');
  await page.locator('.sheet [data-act="time-use"][data-v="walk"]').click();
  const saved = await state(page);
  expect(saved.entries.find((item: { kind: string }) => item.kind === 'stillness')).toMatchObject({ start: '09:40', end: '10:00', use: 'restore', title: '散步', state: 'reserved' });
  expect(saved.trials).toHaveLength(1);
});
test('completion rejects blank and negative actual durations', async ({ page }) => {
  await open(page);
  await expandTasks(page);
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
  expect((await state(page)).trials[0].after).toBe(80);
  await page.goto('/#review');
  await expect(page.locator('[data-metric="review-actual"]')).toContainText('−20');
});
test('historical freed intervals do not get silently booked into the past', async ({ page }) => {
  await open(page, { entries: [{ ...paper, start: '07:00', end: '08:00' }] });
  await finish(page, '40');
  await expect(page.locator('.sheet [data-act="time-use"][data-v="walk"]')).toBeDisabled();
  await expect(page.locator('.sheet')).toContainText('另选时段');
});
test('review respects range selection and ignores legacy unconfirmed reductions', async ({ page }) => {
  await open(page, { entries: [{ ...paper, ai: { before: 60, after: 10 } }], trials: [{ date: '2026-10-01', before: 60, after: 20, confirmed: true, quality: 'accepted' }, { date: '2026-10-14', before: 60, after: 40 }] });
  await page.goto('/#review');
  await expect(page.locator('[data-metric="review-actual"]')).toContainText('0');
  await expect(page.locator('#view')).not.toContainText('自由指数');
  await page.locator('[data-act="range"][data-d="30"]').click();
  await expect(page.locator('[data-metric="review-actual"]')).toContainText('40');
});
test('time tree alone preserves task times and opens task details from leaves', async ({ page }) => {
  await open(page);
  await page.goto('/#line');
  await expect(page.locator('#tabs a[href="#line"]')).toHaveText('时间之树');
  await expect(page.locator('[data-act="line-view"]')).toHaveCount(0);
  await expect(page.locator('.duration-band')).toHaveCount(0);
  await expect(page.locator('.timeline-list')).toHaveCount(0);
  await expect(page.locator('.tree .leaf')).toHaveCount(1);
  await expect(page.locator('.tree')).toContainText('09:00–10:00');
  await page.locator('.tree .leaf').click();
  await expect(page.locator('.sheet')).toContainText('09:00–10:00');
  await expect(page.locator('.sheet')).toContainText('60 min');
  await page.locator('[data-act="close"]').first().click();
  await page.locator('[data-act="day"][data-d="1"]').click();
  await expect(page.locator('.tree .leaf')).toHaveCount(0);
  await page.locator('[data-act="day"][data-d="-1"]').click();
  await expect(page.locator('.tree .leaf')).toHaveCount(1);
  await page.screenshot({ path: test.info().outputPath('time-tree.png'), fullPage: true });
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
    { taskId: 'p1', date: '2026-10-12', before: 60, after: 40, usedAI: true, category: 'read', confirmed: true, quality: 'accepted' },
    { taskId: 'p2', date: '2026-10-13', before: 60, after: 30, usedAI: true, category: 'read', confirmed: true, quality: 'accepted' },
  ] });
  await expandTasks(page);
  await page.locator('[data-act="ai-tools"][data-id="paper"]').first().click();
  await expect(page.locator('.sheet')).toContainText('20–30 min');
  await expect(page.locator('.estimate-help summary')).toContainText('个人历史 · 2 次');
  await expect(page.locator('[data-metric="saved"]')).toHaveCount(0);
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
  expect(saved.entries.filter((item: { kind: string }) => item.kind === 'stillness')).toHaveLength(0);
});

test('custom use rejects past times and lets the user choose a future interval', async ({ page }, info) => {
  await open(page);
  await finish(page, '40');
  await page.locator('.sheet [data-act="time-use"][data-v="custom"]').click();
  await page.locator('#use-title').fill('处理报销');
  await page.locator('#use-start').fill('08:00');
  await page.locator('[data-act="use-save"]').click();
  await expect(page.locator('#use-error')).toBeVisible();
  expect((await state(page)).entries).toHaveLength(1);
  await page.locator('#use-start').fill('18:00');
  await page.locator('[data-act="use-save"]').click();
  expect((await state(page)).entries.find((item: { kind: string }) => item.kind === 'stillness')).toMatchObject({ title: '处理报销', use: 'necessary', start: '18:00', end: '18:20' });
  await page.reload();
  expect((await state(page)).entries.find((item: { kind: string }) => item.kind === 'stillness')).toMatchObject({ title: '处理报销', use: 'necessary', start: '18:00', end: '18:20' });
  await page.goto('/#review');
  await page.screenshot({ path: info.outputPath('donego-release-review.png'), fullPage: true });
});

test('confirming personal-time use never inflates predicted or actual task savings', async ({ page }) => {
  await open(page, { entries: [{ id: 'walk', title: '散步', kind: 'stillness', use: 'restore', state: 'reserved', kept: 0, date: '2026-10-14', start: '08:00', end: '08:20' }] });
  await page.goto('/#review');
  await expect(page.locator('[data-metric="review-estimated"]')).toHaveText('待实测');
  await expect(page.locator('[data-metric="review-actual"]')).toContainText('0');
  await page.locator('[data-act="kept"][data-id="walk"]').click();
  expect((await state(page)).entries[0].kept).toBe(20);
  await page.reload();
  expect((await state(page)).entries[0].kept).toBe(20);
  await expect(page.locator('[data-metric="review-actual"]')).toContainText('0');
});

test('review stacks estimated and actual differences while today only shows the daily budget', async ({ page }, info) => {
  await open(page, { entries: [paper, { ...paper, id: 'old', date: '2026-10-01' }, { ...paper, id: 'free', kind: 'stillness' } ] });
  await expect(page.locator('[data-metric="saved"]')).toHaveCount(0);
  await page.goto('/#review');
  await expect(page.locator('[data-metric="review-estimated"]')).toHaveText('待实测');
  await expect(page.locator('[data-metric="review-estimated-before"]')).toHaveCount(0);
  await expect(page.locator('[data-metric="review-estimated-after"]')).toHaveCount(0);
  await expect(page.locator('[data-metric="review-actual"]')).toHaveText('0 min');
  await expect(page.locator('[data-metric="personal-used"]')).toHaveCount(0);
  const first = await page.locator('.estimated-tile').boundingBox();
  const second = await page.locator('.actual-tile').boundingBox();
  expect(second!.y).toBeGreaterThanOrEqual(first!.y + first!.height);
  await page.screenshot({ path: info.outputPath('review-differences.png') });
  await page.locator('[data-act="range"][data-d="30"]').click();
  await expect(page.locator('[data-metric="review-estimated"]')).toHaveText('待实测');
});

test('consent off keeps item text local even when a custom endpoint is configured', async ({ page }) => {
  let requests = 0;
  await open(page, {}, { mode: 'custom', url: 'https://example.com/v1/messages', model: 'test-model', consent: false });
  await page.unroute('https://**');
  await page.route('https://**', route => { requests += 1; return route.abort(); });
  await page.locator('#cap-text').fill('14:00–15:00 读论文');
  await page.locator('#capGo').click();
  await expect(page.locator('.draft')).toHaveCount(1);
  expect(requests).toBe(0);
});

test('legacy keys are cleared at startup and settings explain the migration', async ({ page }) => {
  await open(page, {}, { mode: 'custom', url: 'https://example.com/v1/messages', model: 'test-model', key: 'legacy-secret', consent: true });
  await page.goto('/#settings');
  await expect(page.locator('#view')).toContainText('已从本地配置清除');
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('tango-donego.llm.v1')!));
  expect(saved.key).toBeUndefined();
  expect(JSON.stringify(saved)).not.toContain('legacy-secret');
});

test('invalid import is rejected and valid import can be rolled back from backup', async ({ page }) => {
  await open(page);
  const before = await state(page);
  await page.goto('/#settings');
  await page.locator('[data-act="import-open"]').click();
  await page.locator('#imp').fill('{"v":1,"entries":"bad"}');
  await page.locator('[data-act="import"]').click();
  await expect(page.locator('.toast')).toContainText('原数据未替换');
  expect(await state(page)).toEqual(before);
  const imported = { ...before, entries: [{ ...paper, id: 'imported', title: '导入事项', start: '10:00', end: '11:00' }], trials: [] };
  await page.locator('[data-act="import-open"]').click();
  await page.locator('#imp').fill(JSON.stringify(imported));
  await page.locator('[data-act="import"]').click();
  expect((await state(page)).entries[0].id).toBe('imported');
  await page.goto('/#settings');
  await page.locator('[data-act="restore-backup"]').click();
  await page.locator('[data-act="restore-backup-yes"]').click();
  expect((await state(page)).entries[0].id).toBe('paper');
});

test('model dialog traps keyboard focus and restores the opener', async ({ page }) => {
  await open(page);
  await expandTasks(page);
  const opener = page.locator('[data-act="ai-tools"][data-id="paper"]').first();
  await opener.click();
  const last = page.locator('.sheet [data-act="close"]').last();
  await last.focus();
  await page.keyboard.press('Tab');
  await expect(page.locator('.sheet button').first()).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(last).toBeFocused();
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
  await expandTasks(page);
  await page.locator('[data-act="ai-tools"][data-id="paper"]').first().click();
  const box = await page.locator('.sheet').boundingBox();
  expect(box!.width).toBeLessThanOrEqual(info.project.use.viewport!.width);
  await page.screenshot({ path: info.outputPath('model-sheet.png') });
  await page.locator('[data-act="close"]').first().click();
  await page.goto('/#review');
  await expect(page.locator('.estimated-tile')).toContainText('Personal history reference');
  await expect(page.locator('.estimated-tile')).toContainText('Not measured');
  await expect(page.locator('.actual-tile')).toContainText('Accepted time difference');
  await expect(page.locator('.estimated-tile')).not.toContainText('Without AI');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.screenshot({ path: info.outputPath('english-review.png'), fullPage: true });
});

test('task advice starts collapsed and keyboard expansion preserves tasks and the open state', async ({ page }, info) => {
  await open(page);
  const before = await state(page);
  const panel = page.locator('#task-advice');
  const summary = panel.locator('summary');
  await expect(summary).toContainText('事项 · AI 建议');
  await expect(panel.locator('.task-count')).toHaveText('1');
  await expect(panel.locator('.task-card')).toBeHidden();
  await expect(page.locator('.bubble').filter({ hasText: '读论文' })).toBeVisible();
  await page.screenshot({ path: info.outputPath('task-advice-collapsed.png') });
  await summary.focus();
  await page.keyboard.press('Enter');
  await expect(panel.locator('.task-card')).toBeVisible();
  await expect(panel).toContainText('待实测');
  await page.locator('#lang').selectOption('en');
  await expect(panel.locator('summary')).toContainText('Tasks · AI tips');
  await expect(panel.locator('.task-card')).toBeVisible();
  await page.locator('#lang').selectOption('zh');
  await page.screenshot({ path: info.outputPath('task-advice-expanded.png') });
  await summary.click();
  await expect(panel.locator('.task-card')).toBeHidden();
  expect(await state(page)).toEqual(before);
  await page.reload();
  await expect(panel.locator('.task-card')).toBeHidden();
});

test('empty task advice shows zero and its example is reachable after expansion', async ({ page }) => {
  await open(page, { entries: [] });
  await expect(page.locator('#task-advice .task-count')).toHaveText('0');
  await expandTasks(page);
  await expect(page.locator('#task-advice')).toContainText('还没有事项');
  await page.locator('#task-advice [data-act="capture-example"]').click();
  await expect(page.locator('#cap-text')).toHaveValue('上午九点到十点读论文');
});
