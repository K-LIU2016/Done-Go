import { test, expect, type Page } from '@playwright/test';

// Explicit engineering fixtures. Ordinary user UI is covered by completion-user.spec.ts.
test.beforeEach(async ({ page }) => { await page.addInitScript(() => { Object.defineProperty(window, '__TANGO_DEVELOPER_UI__', { value: true }); }); });

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
async function openModelSheet(page: Page, title: string) {
  await page.locator('.paper-route .paper-event', { hasText: title }).click();
  await page.locator('.sheet [data-act="event-ai"]').click();
}
async function finish(page: Page, minutes: string, quality = 'accepted') {
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
  const route = await page.locator('.paper-route').boundingBox();
  expect(hello).not.toBeNull();
  expect(route).not.toBeNull();
  expect(route!.y).toBeGreaterThanOrEqual(input!.y + input!.height);
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
  const before = await state(page);
  await openModelSheet(page, '读论文');
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
  for (const title of ['工作', '吃饭']) {
    await page.locator('.paper-route .paper-event', { hasText: title }).click();
    await expect(page.locator('.sheet [data-act="event-ai"]')).toBeVisible();
    await page.locator('[data-act="close"]').first().click();
  }
  await openModelSheet(page, '吃饭');
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
  const before = await state(page);
  const cases = [
    { title: '读论文', model: 'Claude', prompt: /页码/ },
    { title: '修复登录代码', model: 'GPT', prompt: /复现|测试/ },
    { title: '世界旅游大会', model: 'Gemini', prompt: /纪要|待办/ },
  ];
  for (const item of cases) {
    await openModelSheet(page, item.title);
    await expect(page.locator('.tool').first()).toContainText(item.model);
    await expect(page.locator('.tool').first().locator('.model-reason')).not.toBeEmpty();
    await expect(page.locator('.guidance-steps li')).toHaveCount(3);
    await expect(page.locator('#model-prompt')).toHaveValue(item.prompt);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    if (item.title === '读论文') await page.screenshot({ path: info.outputPath('task-guidance.png') });
    await page.locator('[data-act="close"]').first().click();
  }
  expect(await state(page)).toEqual(before);
});

test('short tasks cannot claim more saved minutes than their duration', async ({ page }) => {
  await open(page, { entries: [{ ...paper, end: '09:01' }] });
  await openModelSheet(page, '读论文');
  await expect(page.locator('.sheet .ai-tip')).toContainText('待实测');
  await page.locator('[data-act="close"]').first().click();
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
test('typing a task keeps a brand-colored save button beside its draft in both themes', async ({ page }, info) => {
  await open(page, { entries: [] });
  await page.screenshot({ path: test.info().outputPath('empty-today.png'), fullPage: true });
  await page.locator('#cap-text').fill('下午两点到三点在市中心开一个关于脑机接口的会，最重要');
  await page.locator('#capGo').click();
  await expect(page.locator('.draft')).toHaveCount(1);
  for (const theme of ['standard', 'designer']) {
    await page.locator('#appearance-select').selectOption(theme);
    for (const width of info.project.name === 'mobile' ? [390, 360] : [1440, 768]) {
      await page.setViewportSize({ width, height: 1000 });
      const draft = await page.locator('.draft').boundingBox();
      const save = page.locator('[data-act="draft-commit"]');
      const button = await save.boundingBox();
      expect(button!.x).toBeGreaterThanOrEqual(draft!.x + draft!.width);
      expect(button!.y).toBeGreaterThanOrEqual(draft!.y);
      expect(button!.y + button!.height).toBeLessThanOrEqual(draft!.y + draft!.height);
      await expect(save).toHaveCSS('background-color', 'rgb(233, 84, 50)');
      expect(await save.evaluate(element => { const range = document.createRange(); range.selectNodeContents(element); return range.getClientRects().length; })).toBe(1);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      await page.screenshot({ path: info.outputPath('draft-save-' + theme + '-' + width + '.png'), fullPage: true });
    }
  }
  await page.locator('[data-act="draft-commit"]').click();
  const saved = await state(page);
  expect(saved.entries[0]).toMatchObject({ start: '14:00', end: '15:00', prio: 1 });
});
test('personal estimates remain separate from confirmed gains', async ({ page }) => {
  await open(page, { trials: [
    { taskId: 'p1', date: '2026-10-12', before: 60, after: 40, usedAI: true, category: 'read', confirmed: true, quality: 'accepted', dataMode: 'real' },
    { taskId: 'p2', date: '2026-10-13', before: 60, after: 30, usedAI: true, category: 'read', confirmed: true, quality: 'accepted', dataMode: 'real' },
  ] });
  await openModelSheet(page, '读论文');
  await expect(page.locator('.sheet')).toContainText('20–30 min');
  await expect(page.locator('.estimate-help summary')).toContainText('个人历史差值参考 · 2');
  await expect(page.locator('[data-metric="saved"]')).toHaveCount(0);
});

test('review forecast keeps completion-time snapshots and never rewrites them from later history', async ({ page }) => {
  const completed = (id: string, date: string, title: string, forecast?: Record<string, unknown>) => ({
    id, date, title, kind: 'explore', start: '09:00', end: '10:00', prio: 2, done: true,
    completion: { before: 60, actual: 40, usedAI: true, quality: 'accepted' },
    ...(forecast ? { forecast } : {}),
  });
  const readTrial = (taskId: string, date: string, after: number) => ({ taskId, date, before: 60, after, usedAI: true, category: 'read', confirmed: true, quality: 'accepted', dataMode: 'real' });
  await open(page, {
    entries: [
      completed('snap-a', '2026-10-14', '读论文一', { before: 60, low: 10, high: 20, source: 'history' }),
      completed('snap-b', '2026-10-13', '读论文二', { before: 60, low: 10, high: 20, source: 'history' }),
      completed('missing', '2026-10-12', '读论文三'),
      completed('mismatch', '2026-10-11', '读论文四', { before: 90, low: 10, high: 20, source: 'history' }),
    ],
    trials: [readTrial('later-1', '2026-10-10', 5), readTrial('later-2', '2026-10-09', 10)],
  });
  await page.goto('/#review');
  const estimated = page.locator('[data-metric="review-estimated"]');
  await expect(estimated).toContainText('20–40 min');
  await expect(page.locator('.estimated-tile')).toContainText('2 项有参考');
  await expect(page.locator('.estimated-tile')).toContainText('2 项样本不足');
  await expect(estimated).not.toContainText('50–55 min');
  await expect(estimated).not.toContainText('70–95 min');
});

test('completion snapshots the current forecast and excludes the same task attempt', async ({ page }) => {
  await open(page, { trials: [
    { taskId: 'paper', date: '2026-10-14', before: 60, after: 5, usedAI: true, category: 'read', confirmed: true, quality: 'accepted', dataMode: 'real' },
    { taskId: 'other-1', date: '2026-10-13', before: 60, after: 40, usedAI: true, category: 'read', confirmed: true, quality: 'accepted', dataMode: 'real' },
    { taskId: 'other-2', date: '2026-10-12', before: 60, after: 30, usedAI: true, category: 'read', confirmed: true, quality: 'accepted', dataMode: 'real' },
  ] });
  await page.locator('[data-act="task-finish"][data-id="paper"]').first().click();
  await page.locator('#finish-min').fill('40');
  await page.locator('#finish-ai').check();
  await page.locator('#finish-quality').selectOption('accepted');
  await page.locator('[data-act="finish-save"]').click();
  await expect(page.locator('.sheet')).toContainText('已完成');
  const saved = await state(page);
  expect(saved.trials.filter((trial: { taskId: string }) => trial.taskId === 'paper')).toHaveLength(1);
  expect(saved.entries.find((entry: { id: string }) => entry.id === 'paper').forecast).toEqual({ before: 60, low: 20, high: 30, source: 'history', dataMode: 'real' });
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
  const opener = page.locator('.paper-route .paper-event').first();
  await opener.click();
  await page.locator('.sheet [data-act="event-ai"]').click();
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
  await openModelSheet(page, '读论文');
  const box = await page.locator('.sheet').boundingBox();
  expect(box!.width).toBeLessThanOrEqual(info.project.use.viewport!.width);
  await page.screenshot({ path: info.outputPath('model-sheet.png') });
  await page.locator('[data-act="close"]').first().click();
  await page.goto('/#review');
  await expect(page.locator('.estimated-tile')).toContainText('Your past records');
  await expect(page.locator('.estimated-tile')).toContainText('Not measured');
  await expect(page.locator('.actual-tile')).toContainText('Difference after review');
  await expect(page.locator('.estimated-tile')).not.toContainText('Without AI');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.screenshot({ path: info.outputPath('english-review.png'), fullPage: true });
});

test('today keeps one event list below bubbles and preserves it across language switches', async ({ page }, info) => {
  await open(page);
  const before = await state(page);
  await expect(page.locator('.paper-route .paper-stop')).toHaveCount(1);
  await expect(page.locator('.paper-stop', { hasText: '读论文' })).toContainText('09:00');
  await expect(page.locator('.paper-stop', { hasText: '读论文' }).locator('[data-act="task-finish"]')).toBeVisible();
  await expect(page.locator('.bubble').filter({ hasText: '读论文' })).toBeVisible();
  await expect(page.locator('#task-advice')).toHaveCount(0);
  await page.screenshot({ path: info.outputPath('today-single-list.png') });
  await page.locator('#lang').selectOption('en');
  await expect(page.locator('.paper-stop', { hasText: '读论文' })).toBeVisible();
  await page.locator('#lang').selectOption('zh');
  expect(await state(page)).toEqual(before);
  await page.reload();
  await expect(page.locator('.paper-route .paper-stop')).toHaveCount(1);
});

test('empty today omits the redundant panel in both themes and capture restores the event list', async ({ page }, info) => {
  await open(page, { entries: [] });
  for (const theme of ['standard', 'designer']) {
    await page.locator('#appearance-select').selectOption(theme);
    await expect(page.locator('.paper-route')).toHaveCount(0);
    await expect(page.locator('.paper-robot')).toHaveCount(0);
    await expect(page.locator('[data-act="paper-capture"]')).toHaveCount(0);
    await expect(page.locator('#cap-text')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.screenshot({ path: info.outputPath('empty-today-' + theme + '.png'), fullPage: true });
    await page.locator('#cap-text').fill('14:00–15:00 开会');
    await page.locator('#capGo').click();
    await page.locator('[data-act="draft-commit"]').click();
    await expect(page.locator('.paper-route .paper-stop')).toHaveCount(1);
    await page.locator('.paper-route .paper-event').click();
    await page.locator('.sheet [data-act="del"]').click();
    await expect(page.locator('.paper-route')).toHaveCount(0);
  }
});
