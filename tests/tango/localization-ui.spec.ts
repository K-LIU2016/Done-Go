import { test, expect } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Explicit engineering fixtures. Ordinary user UI is covered by completion-user.spec.ts.
test.beforeEach(async ({ page }) => { await page.addInitScript(() => { Object.defineProperty(window, '__TANGO_DEVELOPER_UI__', { value: true }); }); });

const state = { v: 1, pv: 5, mode: 'real', name: '', wake: 960, entries: [], trials: [], methods: [], methodUses: [], drafts: [], fw: {}, pal: 0, sound: false };
const languages = ['en', 'ru', 'th', 'ar', 'ko'];

async function untranslatedCopy(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const result: string[] = [];
    const protectedSelector = 'script,style,#lang option,[translate="no"],[data-user-content]';
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode, el = node.parentElement;
      if (!el || el.closest(protectedSelector + ',textarea') || !(el.tagName === 'OPTION' ? el.parentElement : el)?.getClientRects().length) continue;
      let text = node.textContent || '';
      const template = el.closest('[data-local-text]');
      if (template) {
        for (const part of JSON.parse(template.getAttribute('data-local-text')!)) {
          if (Array.isArray(part)) text = text.replace(String(part[0]), '');
        }
      }
      const message = el.closest('[data-local-message]');
      if (message) {
        for (const value of Object.values(JSON.parse(message.getAttribute('data-local-values')!))) {
          if (Array.isArray(value)) text = text.replace(String(value[0]), '');
        }
      }
      if (/[\u4e00-\u9fff]/.test(text)) result.push(text.trim());
    }
    for (const el of document.querySelectorAll('[placeholder],[aria-label],[title]')) {
      if (el.closest(protectedSelector) || !el.getClientRects().length) continue;
      for (const name of ['placeholder', 'aria-label', 'title']) {
        let value = el.getAttribute(name) || '';
        if (name === 'aria-label' && el.hasAttribute('data-local-label')) {
          for (const part of JSON.parse(el.getAttribute('data-local-label')!)) {
            if (Array.isArray(part)) value = value.replace(String(part[0]), '');
          }
        }
        if (/[\u4e00-\u9fff]/.test(value)) result.push(name + ': ' + value);
      }
    }
    return [...new Set(result)];
  });
}

// Give each locale the normal 20s budget and an isolated page instead of sharing
// one timeout across five complete review / catalog / method workflows.
for (const language of languages) {
  test(`nonempty review translates system statistics and preserves event actions (${language})`, async ({ page }, info) => {
    await page.clock.install({ time: new Date('2026-10-20T12:00:00+08:00') });
    await page.addInitScript(() => {
      const data = JSON.parse(localStorage.getItem('tango-donego.web.v1')!);
      data.entries = [{ id: 'localized-paper', date: '2026-10-20', title: '读论文「自己的原文」', kind: 'explore', start: '09:00', end: '10:00', prio: 1, completion: { before: 60, actual: 80, usedAI: true, quality: 'accepted', learning: { ownAttempt: 'yes', hintLevel: 'outline', independentRetest: 'needs-practice', skills: ['verification', 'privacy'] } } }];
      data.entries.push({ id: 'pending-paper', date: '2026-10-20', title: '待验收的用户原文', kind: 'explore', start: '11:00', end: '11:30', prio: 1, completion: { before: 30, actual: 35, usedAI: true, quality: 'rework' } });
      data.methods = [{ id: 'local-method', version: 1, createdAt: '2026-10-20T01:00:00.000Z', updatedAt: '2026-10-20T01:00:00.000Z', name: '我的方法原文', purpose: '自己的用途', category: 'read', fit: '自己写的适用条件', unfit: '自己写的不适用条件', inputs: '[原始模板]', steps: '第一步原文\n第二步原文', verify: '我的核验原文', stop: '我的停止条件', modelId: 'unknown', modelReason: '我的模型理由', status: 'active', origin: { taskId: 'localized-paper', date: '2026-10-20', quality: 'accepted' } }];
      data.methodUses = [{ id: 'local-use', methodId: 'local-method', methodVersion: 1, methodName: '我的方法原文', taskId: 'localized-paper', date: '2026-10-20', status: 'completed', at: '2026-10-20T02:00:00.000Z' }];
      data.trials = [{ taskId: 'localized-paper', date: '2026-10-20', category: 'read', before: 60, after: 80, usedAI: true, quality: 'accepted', confirmed: true, recording: 3, costs: { preparation: 10, execution: 50, checking: 15, rework: 5 } }];
      localStorage.setItem('tango-donego.web.v1', JSON.stringify(data));
    });
    await page.goto('/#review');
    const before = await page.evaluate(() => localStorage.getItem('tango-donego.web.v1'));
    await page.locator('#lang').selectOption(language);
    await page.locator('#view details').evaluateAll(nodes => nodes.forEach(node => node.setAttribute('open', '')));
    const untranslated = await untranslatedCopy(page);
    expect.soft(untranslated, language).toEqual([]);
    if (language === 'ar') await page.screenshot({ path: info.outputPath('arabic-review.png'), fullPage: true });
    const opportunity = page.locator('[data-act="ai-tools"]').first();
    await expect(opportunity).toHaveAttribute('data-t', '读论文「自己的原文」');
    await opportunity.click();
    await expect(page.locator('.sheet')).toBeVisible();
    await page.locator('.sheet details').evaluateAll(nodes => nodes.forEach(node => node.setAttribute('open', '')));
    expect.soft(await untranslatedCopy(page), language + ' AI tools').toEqual([]);
    const catalog = await page.evaluate(() => {
      const app = window as any;
      return app.TangoModelCatalogCN.CN_MODELS.map((entry: any) => ({
        ...entry, fit: app.TangoI18n.text(entry.taskFit), desc: app.TangoI18n.text(entry.descZh),
        date: app.TangoI18n.text('资料核验日期：{date}').replace('{date}', entry.accessDate),
      }));
    });
    expect(catalog).toHaveLength(5);
    for (const entry of catalog) {
      expect(entry.fit).not.toBe(entry.taskFit);
      expect(entry.desc).not.toBe(entry.descZh);
    }
    // Only proper names are exempt; descriptions, task guidance and dates must
    // remain visible, translated system copy on all five catalog cards.
    const catalogCards = page.locator('.sheet .tool').filter({ has: page.locator('[data-local-message="资料核验日期：{date}"]') });
    await expect(catalogCards).toHaveCount(5);
    await expect(catalogCards.locator('.tool-h b > [translate="no"]')).toHaveText(catalog.map((entry: any) => entry.displayName));
    await expect(catalogCards.locator('.tool-h > span > [translate="no"]')).toHaveText(catalog.map((entry: any) => entry.vendor));
    await expect(catalogCards.locator('.model-reason')).toHaveText(catalog.map((entry: any) => entry.fit));
    await expect(catalogCards.locator('.model-reason + p')).toHaveText(catalog.map((entry: any) => entry.desc));
    await expect(catalogCards.locator('[data-local-message]')).toHaveText(catalog.map((entry: any) => entry.date));
    await page.locator('.sheet [data-act="close"]').first().click();
    // Keep stale source dates in a synthetic, unverified catalog to ensure the
    // product localizes the status and never borrows the old verification date.
    const unverifiedDate = await page.evaluate(() => {
      const app = window as any, source = app.TangoModelCatalogCN;
      app.TangoModelCatalogCN = { ...source, CN_MODELS: source.CN_MODELS.map((entry: any) => ({ ...entry, verified: false })) };
      return app.TangoI18n.text('资料核验日期：{date}').replace('{date}', app.TangoI18n.text('未核验'));
    });
    await opportunity.click();
    await page.locator('.sheet details').evaluateAll(nodes => nodes.forEach(node => node.setAttribute('open', '')));
    await expect(catalogCards.locator('[data-local-message]')).toHaveText(Array(5).fill(unverifiedDate));
    expect.soft(await untranslatedCopy(page), language + ' unverified AI tools').toEqual([]);
    await page.locator('.sheet [data-act="close"]').first().click();
    await page.goto('/#review');
    await page.locator('[data-act="method-library"]').click();
    await page.locator('[data-act="method-reuse"]').click();
    expect.soft(await untranslatedCopy(page), language + ' method task selection').toEqual([]);
    await page.locator('.reuse-task').first().click();
    await page.locator('.sheet details').evaluateAll(nodes => nodes.forEach(node => node.setAttribute('open', '')));
    expect.soft(await untranslatedCopy(page), language + ' method details').toEqual([]);
    await expect(page.locator('#method-template')).toHaveValue('[原始模板]');
    await expect(page.locator('.sheet')).toContainText('我的核验原文');
    await page.locator('.sheet [data-act="close"]').first().click();
    await page.locator('[data-act="method-library"]').click();
    await page.locator('[data-act="method-edit"]').click();
    expect.soft(await untranslatedCopy(page), language + ' method editor').toEqual([]);
    await page.locator('.sheet [data-act="close"]').first().click();
    expect(await page.evaluate(() => localStorage.getItem('tango-donego.web.v1'))).toBe(before);
  });
}

test('all built-in task workflows translate reasons, steps and generated prompts', async ({ page }) => {
  const html = readFileSync(new URL('../../web/index.html', import.meta.url), 'utf8');
  const start = html.indexOf('var GUIDANCE = {');
  const guidance = vm.runInNewContext(html.slice(start, html.indexOf('function guidanceText', start)) + '; GUIDANCE');
  const strings = Object.values(guidance).flatMap((value: any) => [value.reason, ...value.steps, value.prompt, value.device].map(pair => pair[0]));
  await page.goto('/#today');
  for (const language of languages) {
    await page.locator('#lang').selectOption(language);
    const copy = await page.evaluate(source => source.map(text => ({ source: text, translated: (window as any).TangoI18n.text(text) })), strings);
    expect(copy.filter(item => /[\u4e00-\u9fff]/.test(item.translated)), language).toEqual([]);
    expect(copy.every(item => typeof item.translated === 'string' && item.translated.length > 0)).toBe(true);
  }
});
test.beforeEach(async ({ page }) => {
  await page.route('https://**', route => route.abort());
  await page.route('**/api/assistant/config', route => route.fulfill({ json: { available: true, provider: 'openai', model: 'fixture-chat', destination: 'https://example.test/v1/chat/completions', models: { heavy: 'fixture-chat', standard: 'fixture-advice', light: 'fixture-light' }, reasoningEffort: 'xhigh' } }));
  await page.addInitScript(data => {
    if (!localStorage.getItem('tango-donego.web.v1')) localStorage.setItem('tango-donego.web.v1', JSON.stringify(data));
    localStorage.setItem('tango-donego.llm.v1', JSON.stringify({ mode: 'off' }));
  }, state);
});

test('system copy is localized across every core page', async ({ page }, info) => {
  test.setTimeout(90000);
  const findings: Record<string, string[]> = {};
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/#today');
  for (const language of languages) {
    await page.locator('#lang').selectOption(language);
    for (const route of ['today', 'line', 'review', 'agreements', 'assistant', 'settings']) {
      await page.goto('/#' + route);
      await expect(page.locator('html')).toHaveAttribute('lang', language);
      await expect(page.locator('#view')).not.toBeEmpty();
      await page.locator('#view details').evaluateAll(nodes => nodes.forEach(node => node.setAttribute('open', '')));
      const untranslated = await untranslatedCopy(page);
      if (untranslated.length) findings[language + '/' + route] = untranslated;
    }
  }
  await writeFile(info.outputPath('untranslated.json'), JSON.stringify(findings, null, 2));
  expect(errors).toEqual([]);
  expect(findings).toEqual({});
});

test('language changes preserve drafts, original records and model replies', async ({ page }, info) => {
  await page.goto('/#today');
  const draft = '今天开会，明天完成论文 — original draft';
  await page.locator('#cap-text').fill(draft);
  for (const language of [...languages, 'zh']) {
    await page.locator('#lang').selectOption(language);
    await expect(page.locator('#cap-text')).toHaveValue(draft);
  }
  await page.goto('/#assistant');
  await page.route('**/api/assistant/chat', route => route.fulfill({ contentType: 'text/event-stream', body: 'data: ' + JSON.stringify({ text: '今天的时间属于你。Original AI answer.' }) + '\n\ndata: [DONE]\n\n' }));
  await page.locator('#assistant-message').fill('今天');
  await page.locator('#assistant-send').click();
  await expect(page.locator('.companion-message:not(.is-user)')).toContainText('Original AI answer.');
  await page.locator('#assistant-message').fill(draft);
  const before = await page.evaluate(() => localStorage.getItem('tango-donego.web.v1'));
  for (const language of [...languages, 'zh']) {
    await page.locator('#lang').selectOption(language);
    await expect(page.locator('#assistant-message')).toHaveValue(draft);
    await expect(page.locator('.companion-message.is-user p')).toHaveText('今天');
    await expect(page.locator('.companion-message:not(.is-user)')).toContainText('今天的时间属于你。Original AI answer.');
    expect(await page.evaluate(() => localStorage.getItem('tango-donego.web.v1'))).toBe(before);
    await expect(page.locator('html')).toHaveAttribute('dir', language === 'ar' ? 'rtl' : 'ltr');
  }
  await page.locator('#lang').selectOption('th');
  await page.screenshot({ path: info.outputPath('thai-assistant.png'), fullPage: true });
  await page.reload();
  await expect(page.locator('#lang')).toHaveValue('th');
});
