import { test, expect, type Page } from '@playwright/test';

// Explicit engineering fixtures. Ordinary user UI is covered by completion-user.spec.ts.
test.beforeEach(async ({ page }) => { await page.addInitScript(() => { Object.defineProperty(window, '__TANGO_DEVELOPER_UI__', { value: true }); }); });

const day = '2026-10-14';
const screen1 = { id: 't1', date: day, title: '筛选5篇论文', kind: 'necessary', start: '14:00', end: '15:00', prio: 3 };
const cook = { id: 't2', date: day, title: '做饭', kind: 'connect', start: '18:00', end: '18:40', prio: 3 };
const base = { v: 1, pv: 5, mode: 'real', name: 'KKK', wake: 960, entries: [screen1, cook], trials: [], methods: [], methodUses: [], drafts: [], fw: {}, pal: 0, sound: false };
async function open(page: Page, patch: Record<string, unknown> = {}) {
  await page.clock.install({ time: new Date(day + 'T09:30:00+08:00') });
  await page.route('https://**', route => route.abort());
  await page.route('**/api/llm/config', route => route.fulfill({ json: { endpoints: [] } }));
  await page.route('**/api/assistant/config', route => route.fulfill({ json: { available: true, provider: 'openai', model: 'fixture-chat', destination: 'https://example.test/v1/chat/completions' } }));
  await page.addInitScript(({ state }) => {
    if (!localStorage.getItem('v02-entry-fixture')) {
      localStorage.setItem('tango-donego.web.v1', JSON.stringify(state));
      localStorage.setItem('tango-donego.llm.v1', JSON.stringify({ mode: 'off' }));
      localStorage.setItem('tango-donego.lang', 'zh');
      localStorage.setItem('v02-entry-fixture', '1');
    }
  }, { state: { ...base, ...patch } });
  await page.goto('/#today');
}
async function state(page: Page) { return page.evaluate(() => JSON.parse(localStorage.getItem('tango-donego.web.v1')!)); }
async function finish(page: Page, id: string, options: { ai?: boolean; helpful?: string; quality?: string } = {}) {
  await page.locator('[data-act="task-finish"][data-id="' + id + '"]').first().click();
  await page.locator('#finish-min').fill('25');
  if (options.ai !== false) {
    await page.locator('#finish-ai').check();
    if (options.helpful) {
      await expect(page.locator('#finish-helpful-wrap')).toBeVisible();
      await page.locator('#finish-helpful').selectOption(options.helpful);
    }
  } else {
    await page.locator('#finish-ai').uncheck();
    await expect(page.locator('#finish-helpful-wrap')).toBeHidden();
  }
  if (options.quality) await page.locator('#finish-quality').selectOption(options.quality);
  await page.locator('[data-act="finish-save"]').click();
  const overlay = page.locator('#layer .overlay');
  if (await overlay.count()) await overlay.locator('[data-act="close"]').first().click();
}

test('the today priorities entry keeps tasks private until explicit consent', async ({ page }) => {
  let calls = 0;
  await open(page);
  await page.route('**/api/assistant/chat', route => { calls++; return route.abort(); });
  await page.locator('[data-act="priorities-today"]').click();
  await expect(page.locator('#assistant-mode')).toHaveValue('priorities');
  await page.locator('#assistant-privacy summary').click();
  await expect(page.locator('#assistant-share-tasks')).not.toBeChecked();
  await expect(page.locator('[data-companion-task]')).toHaveCount(0);
  expect(calls).toBe(0);
  await page.locator('#assistant-share-tasks').check();
  await expect(page.locator('[data-companion-task="entry:t1"]')).toBeChecked();
  await expect(page.locator('[data-companion-task="entry:t2"]')).toBeChecked();
  expect(calls).toBe(0);
});

for (const entry of ['priorities', 'models'] as const) {
  test(entry + ' entry sends only explicitly shared context and respects revocation on re-entry', async ({ page }) => {
    await open(page);
    const contexts: any[] = [];
    await page.route('**/api/assistant/chat', async route => {
      contexts.push(JSON.parse(route.request().postDataJSON().prompt.split('\nCONTEXT_JSON\n')[1]));
      await route.fulfill({ json: { content: [{ type: 'text', text: JSON.stringify({ reply: '受控测试回答', suggestions: [] }) }] } });
    });
    async function enter() {
      await page.goto('/#today');
      if (entry === 'priorities') await page.locator('[data-act="priorities-today"]').click();
      else {
        await page.locator('.paper-route .paper-event', { hasText: '筛选5篇论文' }).click();
        await page.locator('.sheet [data-act="event-ai"]').click();
        await page.locator('.sheet [data-act="assistant-models"]').click();
      }
      await expect(page.locator('#assistant-mode')).toHaveValue(entry);
    }
    async function send(index: number) {
      await page.locator('#assistant-message').fill('测试问题 ' + index);
      await page.locator('#assistant-send').click();
      await expect(page.locator('.companion-message.is-user')).toHaveCount(index);
      await expect(page.locator('#assistant-send')).toBeEnabled();
      expect(contexts).toHaveLength(index);
    }
    function privateContext(context: any) {
      expect(context.tasks).toEqual([]);
      expect(context.metrics).toEqual({});
      expect(context.modelEvidence).toEqual([]);
    }
    await enter();
    expect(contexts).toHaveLength(0);
    await send(1);
    privateContext(contexts[0]);
    await page.locator('#assistant-privacy summary').click();
    await page.locator('#assistant-share-tasks').check();
    await send(2);
    expect(contexts[1].tasks.map((task: any) => task.targetId)).toEqual(entry === 'priorities' ? ['entry:t1', 'entry:t2'] : ['entry:t1']);
    expect(contexts[1].metrics).toEqual({});
    expect(contexts[1].modelEvidence).toEqual([]);
    await page.locator('#assistant-share-tasks').uncheck();
    await enter();
    await send(3);
    privateContext(contexts[2]);
    expect((await state(page)).entries).toEqual(base.entries);
  });
}

test('an empty day explains there is nothing to rank instead of opening chat', async ({ page }) => {
  await open(page, { entries: [] });
  await page.locator('[data-act="priorities-today"]').click();
  await expect(page.locator('.toast')).toContainText('今天还没有待办事项');
  await expect(page).toHaveURL(/#today/);
});

test('helpfulness is a separate self-report and never becomes acceptance or savings', async ({ page }) => {
  await open(page);
  await finish(page, 't1', { ai: true, helpful: 'not-helpful', quality: 'accepted' });
  const saved = await state(page);
  expect(saved.entries.find((item: { id: string }) => item.id === 't1').completion).toMatchObject({ helpful: 'not-helpful', quality: 'accepted', usedAI: true });
  expect(saved.trials[0].helpful).toBe('not-helpful');
  await page.goto('/#review');
  await expect(page.locator('.paper-review-entry')).toContainText('自述：没帮助');
  await expect(page.locator('[data-metric="review-actual"]')).toContainText('35');
  await expect(page.locator('[data-metric="review-actual"]')).not.toContainText('节省');
});

test('unchecking AI use hides the helpfulness question and stores no judgement', async ({ page }) => {
  await open(page);
  await finish(page, 't1', { ai: false, quality: 'accepted' });
  const saved = await state(page);
  expect(saved.entries.find((item: { id: string }) => item.id === 't1').completion.helpful).toBeNull();
  expect(saved.entries.find((item: { id: string }) => item.id === 't1').completion.usedAI).toBe(false);
});

test('muting one kind hides its proactive rows but keeps manual help and other kinds', async ({ page }) => {
  await open(page);
  await page.locator('.paper-route .paper-event', { hasText: '筛选5篇论文' }).click();
  await page.locator('.sheet [data-act="event-ai"]').click();
  await page.locator('[data-act="hints-mute"][data-cat="screen"]').click();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('tango-donego.hints.v1')!))).toEqual({ muted: { screen: true } });  await page.goto('/#review');
  await expect(page.locator('.ai-row', { hasText: '筛选5篇论文' })).toHaveCount(0);
  await expect(page.locator('.block', { hasText: 'AI 辅助机会' })).toContainText('1 条机会因你关闭该类推荐而隐藏');
  await page.goto('/#today');
  await page.locator('.paper-route .paper-event', { hasText: '做饭' }).click();
  await page.locator('.sheet [data-act="event-ai"]').click();
  await expect(page.locator('.sheet')).toContainText('准备菜单与采购清单');
  await page.locator('[data-act="close"]').first().click();
  await page.goto('/#settings');
  await expect(page.locator('.block', { hasText: 'AI 机会提示' })).toContainText('已关闭：资料筛选');
  await page.locator('[data-act="hints-restore"][data-cat="screen"]').click();
  await page.goto('/#review');
  await expect(page.locator('.ai-row', { hasText: '筛选5篇论文' })).toHaveCount(1);
});
