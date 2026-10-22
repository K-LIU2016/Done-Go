import { test, expect, type Page } from '@playwright/test';

const task = { id: 'simple', date: '2026-10-21', title: '论文阅读原文', start: '09:00', end: '10:00', kind: 'explore', prio: 2 };
async function open(page: Page) {
  await page.clock.install({ time: new Date('2026-10-21T09:30:00+08:00') });
  await page.route('https://**', route => route.abort());
  await page.route('**/api/assistant/config', route => route.fulfill({ json: { available: true, provider: 'openai', model: 'gpt-6.1-sol', destination: 'https://example.test/v1/chat/completions' } }));
  await page.route('**/api/llm/config', route => route.fulfill({ json: { endpoints: [] } }));
  await page.route('**/api/assistant/chat', () => { throw new Error('completion must never call a model'); });
  await page.addInitScript(task => {
    if (localStorage.getItem('simple-completion-seeded')) return;
    localStorage.setItem('tango-donego.web.v1', JSON.stringify({ v: 1, pv: 5, mode: 'real', name: '', wake: 960, entries: [task], trials: [], drafts: [], methods: [], methodUses: [], fw: {}, sound: false, pal: 0 }));
    localStorage.setItem('tango-donego.lang', 'zh');
    localStorage.setItem('tango-donego.llm.v1', JSON.stringify({ consent: false }));
    localStorage.setItem('simple-completion-seeded', '1');
  }, task);
  await page.goto('/#today');
}
const saved = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem('tango-donego.web.v1')!));
const developerControls = '#finish-quality,#finish-recording,#finish-preparation,#finish-checking,#finish-rework,#finish-helpful,#finish-model-version,#finish-own-attempt,#finish-method-keep,[data-act="cohort-export"],[data-act="model-evaluation-export"],[data-act="diagnostic-export"]';

test('bubble completion is simple in both themes and every language', async ({ page }, info) => {
  await open(page);
  const before = await saved(page);
  for (const theme of ['standard', 'designer']) {
    await page.locator('#appearance-select').selectOption(theme);
    for (const language of ['zh', 'en', 'ru', 'th', 'ar', 'ko']) {
      await page.locator('#lang').selectOption(language);
      await page.locator('.bubble[data-id="simple"]').dblclick();
      await expect(page.locator('#finish-min')).toBeVisible();
      await expect(page.locator('#finish-ai')).toBeVisible();
      await expect(page.locator(developerControls)).toHaveCount(0);
      await expect(page.locator('.sheet details')).toHaveCount(0);
      await expect(page.locator('#finish-model-wrap')).toBeHidden();
      await page.locator('#finish-ai').check();
      await expect(page.locator('#finish-model-name')).toBeVisible();
      await page.locator('#finish-model-name').fill('gpt-6.1-sol');
      const copy = await page.locator('.sheet').evaluate(element => {
        const clone = element.cloneNode(true) as HTMLElement;
        clone.querySelectorAll('[data-user-content],option').forEach(node => node.remove());
        return clone.textContent;
      });
      if (language !== 'zh') {
        expect(copy).not.toMatch(/[\u4e00-\u9fff]/);
        expect(await page.locator('#finish-min').getAttribute('placeholder')).not.toMatch(/[\u4e00-\u9fff]/);
        expect(await page.locator('#finish-model-name').getAttribute('placeholder')).not.toMatch(/[\u4e00-\u9fff]/);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      if (['zh', 'ar'].includes(language)) await page.screenshot({ path: info.outputPath(theme + '-' + language + '-completion.png'), fullPage: true });
      await page.keyboard.press('Escape');
    }
  }
  expect(await saved(page)).toEqual(before);
});

test('time may be omitted, then added with a model, without fabricated savings', async ({ page }) => {
  await open(page);
  await page.locator('.bubble[data-id="simple"]').dblclick();
  await page.locator('[data-act="finish-save"]').click();
  await expect(page.locator('.sheet')).toHaveCount(0);
  let state = await saved(page);
  expect(state.entries[0]).toMatchObject({ done: true, end: '10:00', completion: { actual: null, timeRecorded: false, usedAI: false, quality: 'pending' } });
  expect(state.trials).toEqual([]);
  await page.reload();
  await page.locator('.paper-event[data-id="simple"]').click();
  await page.locator('.sheet [data-act="task-finish"][data-id="simple"]').click();
  await page.locator('#finish-min').fill('25');
  await page.locator('#finish-ai').check();
  await page.locator('#finish-model-name').fill('gpt-6.1-sol');
  await page.locator('[data-act="finish-save"]').click();
  await expect(page.locator('.sheet')).toHaveCount(0);
  state = await saved(page);
  expect(state.entries[0].completion).toMatchObject({ actual: 25, modelName: 'gpt-6.1-sol', timeRecorded: true });
  expect(state.trials).toHaveLength(1);
  expect(state.trials[0].quality).toBe('pending');
  await page.goto('/#review');
  await expect(page.locator('.user-review-records')).toContainText('gpt-6.1-sol');
  await expect(page.locator('[data-metric="recorded-minutes"]')).toContainText('25');
  await expect(page.locator(developerControls)).toHaveCount(0);
  await expect(page.locator('[data-metric="review-net"],[data-metric="review-estimated"]')).toHaveCount(0);
});

test('linked pages expose no evaluation controls or debug details to users', async ({ page }) => {
  await open(page);
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  for (const language of ['zh', 'en', 'ru', 'th', 'ar', 'ko']) {
    await page.locator('#lang').selectOption(language);
    for (const route of ['today', 'review', 'settings', 'line']) {
      await page.goto('/#' + route);
      await expect(page.locator(developerControls)).toHaveCount(0);
      await expect(page.locator('#view')).not.toContainText('cohort');
      await expect(page.locator('#view')).not.toContainText('AI 技能练习');
      await expect(page.locator('#view')).not.toContainText('最近错误编号');
      if (language !== 'zh') {
        const copy = await page.locator('#view').evaluate(element => { const clone = element.cloneNode(true) as HTMLElement; clone.querySelectorAll('[data-user-content],input,option,svg').forEach(node => node.remove()); return clone.textContent; });
        expect(copy, language + '/' + route).not.toMatch(/[\u4e00-\u9fff]/);
      }
    }
  }
  await page.locator('.tree .leaf[data-id="simple"]').click();
  await page.locator('[data-act="event-ai"]').click();
  await expect(page.locator(developerControls)).toHaveCount(0);
  await expect(page.locator('.sheet')).not.toContainText('任务级效果未实测');
  expect(errors).toEqual([]);
});

test('saving unchanged legacy details preserves the original measurement and history', async ({ page }) => {
  await open(page);
  await page.evaluate(() => {
    const state = JSON.parse(localStorage.getItem('tango-donego.web.v1')!);
    state.entries[0].done = true;
    state.entries[0].completion = { actual: 40, before: 60, plannedEnd: '10:00', usedAI: true, modelName: 'gpt-6.1-sol', modelId: 'unknown', quality: 'accepted', recording: 3, costs: { execution: 30, preparation: 5, checking: 5, rework: 0 } };
    state.trials = [{ taskId: 'simple', date: '2026-10-21', title: '论文阅读原文', before: 60, after: 40, quality: 'accepted', confirmed: true, usedAI: true, recording: 3 }];
    localStorage.setItem('tango-donego.web.v1', JSON.stringify(state));
  });
  await page.reload();
  const before = await saved(page);
  await page.locator('.paper-event[data-id="simple"]').click();
  await page.locator('.sheet [data-act="task-finish"][data-id="simple"]').click();
  await page.locator('[data-act="finish-save"]').click();
  await expect(page.locator('.sheet')).toHaveCount(0);
  expect(await saved(page)).toEqual(before);
});
