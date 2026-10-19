import { test, expect, type Page } from '@playwright/test';

const key = 'tango-donego.web.v1';
const paper = { id: 'paper', date: '2026-10-16', start: '09:00', end: '10:00', title: '读论文 private-task-title', kind: 'explore', prio: 1 };
const initial = { v: 1, pv: 5, mode: 'real', name: 'private-person-name', wake: 960, entries: [paper], trials: [], drafts: [], fw: {}, pal: 0, sound: false };
async function open(page: Page, options: { state?: Record<string, unknown>; llm?: Record<string, unknown>; blockedStorage?: boolean; corrupt?: boolean } = {}) {
  await page.clock.install({ time: new Date('2026-10-16T09:30:00+08:00') });
  await page.route('https://**', route => route.abort());
  await page.addInitScript(({ state, llm, blocked, corrupt }) => {
    if (!localStorage.getItem('donego-readiness-seeded')) {
      localStorage.setItem('tango-donego.web.v1', corrupt ? '{preserve-this-damaged-data' : JSON.stringify(state));
      localStorage.setItem('tango-donego.llm.v1', JSON.stringify(llm));
      localStorage.setItem('tango-donego.lang', 'zh');
      localStorage.setItem('donego-readiness-seeded', '1');
    }
    if (blocked) Object.defineProperty(window, 'localStorage', { get() { throw new DOMException('disabled', 'SecurityError'); } });
  }, { state: { ...initial, ...options.state }, llm: options.llm || { mode: 'off' }, blocked: options.blockedStorage || false, corrupt: options.corrupt || false });
  await page.goto('/#today');
}
async function finishForm(page: Page) {
  await page.locator('#task-advice > summary').click();
  await page.locator('[data-act="task-finish"][data-id="paper"]').click();
}
async function current(page: Page) { return page.evaluate(key => JSON.parse(localStorage.getItem(key)!), key); }

test('release status, all routes and privacy-safe diagnostics are visible', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await open(page);
  for (const hash of ['today', 'line', 'review', 'agreements', 'assistant', 'settings']) {
    await page.goto('/#' + hash);
    await expect(page.locator('#view')).not.toBeEmpty();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  }
  await expect(page.locator('#view')).toContainText('donego-web-2026.10.19');
  await expect(page.locator('#service-status')).toContainText('0.1.0-local');
  await page.locator('[data-act="diagnostic-export"]').click();
  const report = JSON.parse(await page.locator('#exp').inputValue());
  expect(report.counts.entries).toBe(1);
  expect(JSON.stringify(report)).not.toMatch(/private-/);
  expect(errors).toEqual([]);
});

test('exact AI send preview blocks transmission and cancellation returns to local capture', async ({ page }) => {
  let sent = 0;
  await page.route('**/api/llm/config', route => route.fulfill({ json: { endpoints: [] } }));
  await page.route('**/api/assistant/config', route => route.fulfill({ json: { available: true, provider: 'openai', model: 'fixture', destination: 'https://example.test/parse' } }));
  await page.route('**/api/assistant/chat', route => { sent++; return route.fulfill({ json: { content: [{ type: 'text', text: '{"items":[{"title":"开会","kind":"necessary","start":"14:00","end":"15:00"}]}' }] } }); });
  await open(page, { llm: { consent: true } });
  await page.locator('#cap-text').fill('下午两点到三点开会');
  await page.locator('#capGo').click();
  await expect(page.locator('.sheet')).toContainText('https://example.test/parse');
  await expect(page.locator('.sheet')).toContainText('下午两点到三点开会');
  expect(sent).toBe(0);
  await page.keyboard.press('Escape');
  await expect(page.locator('.draft')).toHaveCount(1);
  expect(sent).toBe(0);
  await page.locator('#cap-text').fill('下午四点到五点开会');
  await page.locator('#capGo').click();
  await page.locator('[data-act="send-confirm"]').click();
  await expect(page.locator('.draft')).toHaveCount(2);
  expect(sent).toBe(1);
  expect((await current(page)).trials).toEqual([]);
});

test('costs, consented task evidence and learning observations survive reload without raw text exports', async ({ page }, info) => {
  await open(page);
  await finishForm(page);
  await page.locator('#finish-min').fill('30');
  await page.getByText('准备、核对与返工成本', { exact: true }).click();
  await page.locator('#finish-preparation').fill('5');
  await page.locator('#finish-checking').fill('10');
  await page.locator('#finish-rework').fill('20');
  await page.locator('#finish-recording').fill('3');
  await page.locator('#finish-ai').check();
  await page.locator('#finish-quality').selectOption('accepted');
  await page.getByText('任务模型证据与匿名导出 · 可选', { exact: true }).click();
  await page.locator('#finish-model-id').selectOption('claude-sonnet-5.5');
  await page.locator('#finish-model-version').fill('v20261016');
  await page.locator('#finish-input-scale').selectOption('short');
  await page.locator('#finish-eval-consent').check();
  await page.getByText('学习护栏与技能练习 · 可选', { exact: true }).click();
  await page.locator('#finish-own-attempt').selectOption('yes');
  await page.locator('#finish-hint-level').selectOption('hints');
  await page.locator('#finish-retest').selectOption('needs-practice');
  await page.locator('#finish-skill-verification').check();
  await page.locator('[data-act="finish-save"]').click();
  await page.reload();
  expect((await current(page)).trials[0]).toMatchObject({ after: 65, recording: 3, modelVersion: 'v20261016', learning: { ownAttempt: 'yes', independentRetest: 'needs-practice' } });
  await page.goto('/#review');
  await expect(page.locator('[data-metric="review-actual"]')).toContainText('−5');
  await expect(page.locator('[data-metric="review-net"]')).toContainText('−8');
  await expect(page.locator('#view')).toContainText('1 项自述记录');
  await page.screenshot({ path: info.outputPath('donego-evidence-review.png'), fullPage: true });
  await page.locator('[data-act="model-evaluation-export"]').click();
  const report = JSON.parse(await page.locator('#exp').inputValue());
  expect(report.modelResults).toHaveLength(1);
  expect(report.modelResults[0]).toMatchObject({ after: 65, recording: 3, netDifference: -8, modelId: 'claude-sonnet-5.5' });
  expect(JSON.stringify(report)).not.toMatch(/private-|paper/);
});

test('missing recording costs remain unknown and unconsented task records never enter model exports', async ({ page }) => {
  await open(page);
  await finishForm(page);
  await page.locator('#finish-min').fill('40');
  await page.locator('#finish-quality').selectOption('accepted');
  await page.locator('[data-act="finish-save"]').click();
  await page.keyboard.press('Escape');
  await page.goto('/#review');
  await expect(page.locator('[data-metric="review-net"]')).toContainText('未知');
  await page.locator('[data-act="model-evaluation-export"]').click();
  expect(JSON.parse(await page.locator('#exp').inputValue()).modelResults).toEqual([]);
});

test('manual account checks persist and an unavailable candidate yields to alternatives', async ({ page }) => {
  await open(page);
  await page.locator('#task-advice > summary').click();
  await page.locator('[data-act="ai-tools"][data-id="paper"]').click();
  await page.locator('.tool').first().getByText('记录我的账户检查', { exact: true }).click();
  await page.locator('#account-state-0').selectOption('unavailable');
  await page.locator('#account-reason-0').selectOption('quota');
  await page.locator('[data-act="account-check-save"][data-model="0"]').click();
  await page.reload();
  expect((await current(page)).modelAvailability['claude-sonnet-5.5']).toMatchObject({ state: 'unavailable', reason: 'quota', checkedAt: expect.stringMatching(/^2026-10-16T01:30:/) });
  await page.locator('#task-advice > summary').click();
  await page.locator('[data-act="ai-tools"][data-id="paper"]').click();
  await expect(page.locator('.tool').first()).not.toContainText('Claude Sonnet');
  await expect(page.locator('.sheet')).toContainText('返回本地流程');
});

test('blocked browser storage keeps settings and local capture usable', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  await open(page, { blockedStorage: true });
  await page.keyboard.press('Escape');
  await page.goto('/#settings');
  await expect(page.locator('#view')).toContainText('仅内存');
  await page.locator('[data-act="diagnostic-export"]').click();
  await expect(page.locator('#exp')).toBeVisible();
  expect(errors).toEqual([]);
});

test('damaged saved data cannot be overwritten by starting or recording', async ({ page }) => {
  await open(page, { corrupt: true });
  await page.locator('[data-act="ob-real"]').click();
  await page.locator('#cap-text').fill('下午两点到三点开会');
  await page.locator('#capGo').click();
  await page.locator('[data-act="draft-commit"]').click();
  expect(await page.evaluate(key => localStorage.getItem(key), key)).toBe('{preserve-this-damaged-data');
  await page.goto('/#settings');
  await expect(page.locator('#view')).toContainText('原始内容未被覆盖');
});

test('malformed imports preserve current data and unrecognized secrets are removed from accepted imports', async ({ page }) => {
  await open(page);
  await page.goto('/#settings');
  const before = await current(page);
  for (const data of [{ ...before, pal: '__proto__' }, { ...before, drafts: {} }, { ...before, entries: [{ ...paper, kind: 'constructor' }] }]) {
    await page.locator('[data-act="import-open"]').click();
    await page.locator('#imp').fill(JSON.stringify(data));
    await page.locator('[data-act="import"]').click();
    await expect(page.locator('.toast')).toContainText('原数据未替换');
    expect(await current(page)).toEqual(before);
  }
  await page.locator('[data-act="import-open"]').click();
  await page.locator('#imp').fill(JSON.stringify({ ...before, config: { key: 'imported-secret' }, entries: [{ ...paper, secret: 'nested-secret' }] }));
  await page.locator('[data-act="import"]').click();
  expect(JSON.stringify(await current(page))).not.toMatch(/imported-secret|nested-secret/);
  await page.goto('/#review');
  await expect(page.locator('[data-metric="review-actual"]')).toHaveText('0 min');
});

test('another tab changing records cannot be silently overwritten by an old snapshot', async ({ page, context }) => {
  await open(page);
  const other = await context.newPage();
  await other.goto('/#today');
  await other.locator('#cap-text').fill('下午两点到三点开会');
  await other.locator('#capGo').click();
  await other.locator('[data-act="draft-commit"]').click();
  await expect(page.locator('body')).toContainText('另一个标签页已更改数据');
  await page.locator('#cap-text').fill('下午四点到五点开会');
  await page.locator('#capGo').click();
  await page.locator('[data-act="draft-commit"]').click();
  const saved = await current(page);
  expect(saved.entries.some((e: { start: string }) => e.start === '14:00')).toBe(true);
  expect(saved.entries.some((e: { start: string }) => e.start === '16:00')).toBe(false);
});

test('local agreement same-version decisions survive reload and malformed storage remains recoverable', async ({ page }) => {
  await open(page);
  await page.goto('/#agreements');
  await page.locator('[data-act="agreement-create"]').click();
  await page.locator('[data-act="agreement-accept"]').click();
  await expect(page.locator('#view [role="status"]')).toContainText('等待对方回应');
  await page.locator('[data-act="agreement-actor"][data-v="bob"]').click();
  await page.locator('[data-act="agreement-counter"]').click();
  await expect(page.locator('#view')).toContainText('v2');
  await page.locator('[data-act="agreement-accept"]').click();
  await page.locator('[data-act="agreement-actor"][data-v="alice"]').click();
  await page.locator('[data-act="agreement-accept"]').click();
  await page.reload();
  await expect(page.locator('#view')).toContainText('执行授权仍为空');
  await page.evaluate(() => localStorage.setItem('tango-donego.agreements.v1', '[{}]'));
  await page.reload();
  await expect(page.locator('#view')).toContainText('无法读取');
  expect(await page.evaluate(() => localStorage.getItem('tango-donego.agreements.v1'))).toBe('[{}]');
});
