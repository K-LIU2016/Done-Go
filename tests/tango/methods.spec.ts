import { test, expect, type Page } from '@playwright/test';

// Explicit engineering fixtures. Ordinary user UI is covered by completion-user.spec.ts.
test.beforeEach(async ({ page }) => { await page.addInitScript(() => { Object.defineProperty(window, '__TANGO_DEVELOPER_UI__', { value: true }); }); });

const day = '2026-10-14';
const screen1 = { id: 't1', date: day, title: '筛选5篇论文', kind: 'necessary', start: '14:00', end: '15:00', prio: 3 };
const screen2 = { id: 't2', date: day, title: '筛选3篇文献', kind: 'necessary', start: '16:00', end: '17:00', prio: 3 };
const savedMethod = {
  id: 'mfix', version: 1, createdAt: '2026-10-13T08:00:00.000Z', updatedAt: '2026-10-13T08:00:00.000Z',
  name: '资料初筛与原文核对', purpose: '按研究问题初筛并核对出处', category: 'screen', fit: '', unfit: '',
  inputs: '[公开资料]、[研究问题]、[输出结构]', steps: '先定问题，再逐篇筛选', verify: '抽查关键结论与出处', stop: '材料不可分享即停',
  modelId: 'unknown', modelReason: '未验证 · 尚无个人实测依据', status: 'active',
  origin: { taskId: 't0', date: '2026-10-13', quality: 'accepted' }
};
const base = { v: 1, pv: 5, mode: 'real', name: 'KKK', wake: 960, entries: [screen1, screen2], trials: [], methods: [], methodUses: [], drafts: [], fw: {}, pal: 0, sound: false };
async function open(page: Page, patch: Record<string, unknown> = {}) {
  await page.clock.install({ time: new Date(day + 'T09:30:00+08:00') });
  await page.route('https://**', route => route.abort());
  await page.addInitScript(({ state }) => {
    if (!localStorage.getItem('tango.test.initialized')) {
      localStorage.setItem('tango-donego.web.v1', JSON.stringify(state));
      localStorage.setItem('tango-donego.llm.v1', JSON.stringify({ mode: 'off' }));
      localStorage.setItem('tango-donego.lang', 'zh');
      localStorage.setItem('tango.test.initialized', 'true');
    }
  }, { state: { ...base, ...patch } });
  await page.goto('/');
}
async function state(page: Page) { return page.evaluate(() => JSON.parse(localStorage.getItem('tango-donego.web.v1')!)); }
async function finishTask(page: Page, id: string, minutes: string, quality = 'accepted', keepMethod = false) {
  await page.locator('[data-act="task-finish"][data-id="' + id + '"]').first().click();
  await page.locator('#finish-min').fill(minutes);
  if (keepMethod) {
    await page.locator('.sheet details', { hasText: '保留这次方法' }).locator('summary').click();
    await page.locator('#finish-method-keep').check();
    await expect(page.locator('#finish-method-inputs')).toContainText('[');
  }
  await page.locator('#finish-quality').selectOption(quality);
  await page.locator('[data-act="finish-save"]').click();
  const overlay = page.locator('#layer .overlay');
  if (await overlay.count()) await overlay.locator('[data-act="close"]').first().click();
}

test('a finished task can keep its method and a similar task finds, applies and completes it', async ({ page }) => {
  await open(page);
  await expect(page.locator('[data-act="method-view"]')).toHaveCount(0);
  await finishTask(page, 't1', '25', 'accepted', true);
  const kept = await state(page);
  expect(kept.methods.length).toBe(1);
  expect(kept.methods[0].name).toContain('筛选');
  expect(kept.methods[0].inputs).toContain('[');
  expect(kept.methods[0].inputs).not.toContain('筛选5篇论文');
  expect(kept.methods[0].origin).toEqual({ taskId: 't1', date: day, quality: 'accepted' });
  await page.goto('#review');
  await page.locator('[data-act="method-library"]').click();
  await expect(page.getByRole('heading', { name: '我的 AI 工作手册' })).toBeVisible();
  await expect(page.locator('.sheet .block', { hasText: '我的 AI 工作手册' })).toContainText('资料');
  await expect(page.locator('.sheet .block', { hasText: '我的 AI 工作手册' })).toContainText('尚无完成验收的使用');
  await page.keyboard.press('Escape');
  await page.goto('#today');

  const hint = page.locator('[data-act="method-view"][data-id="t2"]');
  await expect(hint).toBeVisible();
  await hint.click();
  await expect(page.locator('.sheet')).toContainText('推荐原因');
  await expect(page.locator('.sheet')).toContainText('资料筛选');
  await page.locator('[data-act="method-apply"]').click();
  await expect(page.locator('.paper-stop', { has: page.locator('[data-act="task-finish"][data-id="t2"]') })).toContainText('使用方法');
  const applied = await state(page);
  expect(applied.entries.find((e: { id: string }) => e.id === 't2').methodRef.name).toContain('筛选');
  expect(applied.methodUses[0].status).toBe('applied');
  expect(applied.methodUses[0].taskId).toBe('t2');
  await finishTask(page, 't2', '20', 'accepted');
  const reused = await state(page);
  expect(reused.methodUses[0].status).toBe('completed');
  await page.goto('#review');
  await expect(page.locator('.review-method-results')).toContainText('1 次完成并验收');
});

test('dismissing a suggestion is recorded and stops suggesting for that task only', async ({ page }) => {
  await open(page, { methods: [savedMethod] });

  await expect(page.locator('[data-act="method-view"][data-id="t1"]')).toBeVisible();
  await page.locator('[data-act="method-dismiss"][data-id="t1"]').click();
  await expect(page.locator('[data-act="method-view"][data-id="t1"]')).toHaveCount(0);
  const after = await state(page);
  expect(after.methodUses.length).toBe(1);
  expect(after.methodUses[0].status).toBe('dismissed');
  expect(after.methodUses[0].taskId).toBe('t1');
  await expect(page.locator('[data-act="method-view"][data-id="t2"]')).toBeVisible();
});

test('aborting an applied method stays visible as an honest non-reuse record', async ({ page }) => {
  await open(page, { methods: [savedMethod] });

  await page.locator('[data-act="method-view"][data-id="t1"]').click();
  await page.locator('[data-act="method-apply"]').click();
  await expect(page.locator('.paper-stop', { has: page.locator('[data-act="task-finish"][data-id="t1"]') })).toContainText('使用方法');
  await page.locator('[data-act="method-view"][data-id="t1"]').click();
  await page.locator('[data-act="method-abort"]').click();
  const after = await state(page);
  expect(after.methodUses[0].status).toBe('aborted');
  await page.goto('#review');
  await expect(page.locator('.review-method-results')).toContainText('1 次应用后中止');
});
