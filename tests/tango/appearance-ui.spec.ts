import { test, expect, type Page } from '@playwright/test';

const state = { v: 1, pv: 5, mode: 'real', name: '', wake: 960, entries: [
  { id: 'read', date: '2026-10-19', title: '阅读论文，核对关键结论与出处', start: '09:00', end: '10:00', kind: 'explore', prio: 1 },
  { id: 'write', date: '2026-10-19', title: '整理研究提纲', start: '10:30', end: '11:30', kind: 'create', prio: 2 },
  { id: 'walk', date: '2026-10-19', title: '去公园走走', start: '17:00', end: '17:30', kind: 'restore', prio: 4 }
], trials: [], methods: [], methodUses: [], drafts: [], fw: {}, pal: 0, sound: false };

async function open(page: Page) {
  await page.clock.install({ time: new Date('2026-10-19T10:45:00+08:00') });
  await page.route('https://**', route => route.abort());
  await page.route('**/api/llm/config', route => route.fulfill({ json: { endpoints: [] } }));
  await page.route('**/api/assistant/config', route => route.fulfill({ json: { available: true, provider: 'openai', model: 'fixture-default', destination: 'https://example.test/v1/chat/completions', models: { heavy: 'fixture-chat', standard: 'fixture-advice', light: 'fixture-light' }, reasoningEffort: 'xhigh' } }));
  await page.addInitScript(data => {
    localStorage.setItem('tango-donego.web.v1', JSON.stringify(data));
    localStorage.setItem('tango-donego.lang', 'zh');
    localStorage.setItem('tango-donego.llm.v1', JSON.stringify({ mode: 'off' }));
  }, state);
  await page.goto('/#today');
}

test('appearance switches instantly, persists, and preserves route, records and chat draft', async ({ page }, info) => {
  await open(page);
  const choices = page.locator('#appearance-select option');
  await expect(choices).toHaveCount(5);
  await expect(page.locator('#appearance-select')).toHaveValue('standard');
  await expect(page.locator('html')).toHaveAttribute('data-appearance', 'standard');
  await page.goto('/#assistant');
  const draft = '帮我整理这件事的下一步';
  await page.locator('#assistant-message').fill(draft);
  const before = await page.evaluate(() => localStorage.getItem('tango-donego.web.v1'));
  await page.locator('#appearance-select').selectOption('designer');
  await expect(page.locator('html')).toHaveAttribute('data-appearance', 'designer');
  await expect(page.locator('#appearance-select')).toHaveValue('designer');
  await expect(page.locator('#assistant-message')).toHaveValue(draft);
  await expect(page).toHaveURL(/#assistant$/);
  expect(await page.evaluate(() => localStorage.getItem('tango-donego.web.v1'))).toBe(before);
  expect(await page.evaluate(() => localStorage.getItem('tango-donego.appearance.v1'))).toBe('designer');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-appearance', 'designer');

  for (const choice of ['standard', 'swiss', 'archive', 'designer', 'workbench']) {
    await page.locator('#assistant-message').fill(draft);
    const view = await page.locator('#view').elementHandle();
    await page.locator('#appearance-select').selectOption(choice);
    await expect(page.locator('#assistant-message')).toHaveValue(draft);
    expect(await view!.evaluate(element => element === document.getElementById('view'))).toBe(true);
    expect(await page.evaluate(() => localStorage.getItem('tango-donego.web.v1'))).toBe(before);
    await page.goto('/#line');
    await expect(page.locator('.tree-now')).toContainText('10:45');
    await expect(page.locator('.leaf').first()).toHaveAttribute('aria-label', /探索/);
    await expect(page.locator('.paper-tree-list,.paper-methods,.tree-hint')).toHaveCount(0);
    if (info.project.name === 'desktop') await page.screenshot({ path: info.outputPath('appearance-' + choice + '-tree.png'), fullPage: true });
    await page.goto('/#assistant');
    if (info.project.name === 'desktop') {
      await page.locator('#assistant-message').fill(draft);
      await page.screenshot({ path: info.outputPath('appearance-' + choice + '-assistant.png'), fullPage: true });
    }
  }

  await page.goto('/#line');
  await page.locator('[data-act="day"][data-d="-1"]').click();
  await expect(page.locator('.tree-now')).toHaveCount(0);
});

test('appearance can change when local storage writes fail and controls remain usable on mobile', async ({ page }, info) => {
  test.skip(info.project.name !== 'mobile', 'mobile header and fixed navigation are checked at phone width');
  await page.addInitScript(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key: string, value: string) {
      if (key === 'tango-donego.appearance.v1') throw new DOMException('blocked', 'QuotaExceededError');
      return original.call(this, key, value);
    };
  });
  await open(page);
  await page.locator('#appearance-select').focus();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Tab');
  await expect(page.locator('html')).toHaveAttribute('data-appearance', 'swiss');
  await page.locator('#appearance-select').selectOption('designer');
  await expect(page.locator('html')).toHaveAttribute('data-appearance', 'designer');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  const control = await page.locator('#appearance-control').boundingBox();
  const nav = await page.locator('.tabs').boundingBox();
  expect(control).not.toBeNull();
  expect(nav).not.toBeNull();
  expect(control!.y + control!.height).toBeLessThan(page.viewportSize()!.height);
});

test('all appearances adapt core pages, header order, languages and zoom widths without losing controls', async ({ page }, info) => {
  await open(page);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  for (const theme of ['standard', 'swiss', 'archive', 'designer', 'workbench']) {
    await page.locator('#appearance-select').selectOption(theme);
    for (const route of ['today', 'line', 'review', 'agreements', 'assistant', 'settings']) {
      await page.goto('/#' + route);
      await expect(page.locator('#view')).not.toBeEmpty();
      await expect(page.locator('#appearance-select')).toHaveValue(theme);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), theme + '/' + route).toBe(true);
    }
  }
  const language = await page.locator('#lang').boundingBox();
  const appearance = await page.locator('#appearance-control').boundingBox();
  expect(appearance!.x).toBeGreaterThanOrEqual(language!.x + language!.width);
  for (const locale of ['en', 'ru', 'th', 'ar', 'ko', 'zh']) {
    await page.locator('#lang').selectOption(locale);
    const labels = { en: 'Appearance', ru: 'Оформление', th: 'รูปลักษณ์', ar: 'المظهر', ko: '외관', zh: '外观' };
    await expect(page.locator('#appearance-select')).toHaveAccessibleName(labels[locale as keyof typeof labels]);
    expect(await page.locator('#appearance-label').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  }
  if (info.project.name === 'desktop') {
    for (const width of [768, 720, 360]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto('/#assistant');
      await expect(page.locator('#assistant-message')).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    }
  }
  expect(errors).toEqual([]);
});

test('explicit appearance stays stable regardless of system dark mode', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await open(page);
  expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe('rgb(250, 248, 243)');
  await page.locator('#appearance-select').selectOption('designer');
  await page.emulateMedia({ colorScheme: 'light' });
  expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe('rgb(37, 61, 51)');
});

for (const theme of ['standard', 'swiss', 'archive', 'designer', 'workbench']) {
  test(theme + ' keeps capture, event editing, chat, privacy and support controls usable', async ({ page }, info) => {
    await open(page);
    await page.locator('#appearance-select').selectOption(theme);
    await page.locator('#cap-text').fill('下午两点到三点开会');
    await page.locator('#appearance-select').selectOption(theme === 'standard' ? 'designer' : 'standard');
    await expect(page.locator('#cap-text')).toHaveValue('下午两点到三点开会');
    await page.locator('#appearance-select').selectOption(theme);
    await page.locator('#capGo').click();
    await page.locator('[data-act="draft-commit"]').click();
    await page.locator('.paper-route .paper-event', { hasText: '开会' }).click();
    await page.locator('.sheet [data-act="edit"]').click();
    await page.locator('#ed-title').fill('准备组会议程');
    await page.locator('[data-act="ed-save"]').click();
    await expect(page.locator('.paper-stop', { hasText: '准备组会议程' })).toContainText('14:00');
    await page.goto('/#assistant');
    await page.locator('#assistant-mode').selectOption('priorities');
    await expect(page.locator('#assistant-connection')).toBeHidden();
    await expect(page.locator('#assistant-root')).not.toContainText('fixture-advice');
    await page.locator('#assistant-mode').selectOption('chat');
    await expect(page.locator('#assistant-connection')).toBeHidden();
    await expect(page.locator('#assistant-root')).not.toContainText('fixture-chat');
    const placeholder = await page.locator('#assistant-message').evaluate(element => ({
      color: getComputedStyle(element, '::placeholder').color,
      opacity: getComputedStyle(element, '::placeholder').opacity
    }));
    const muted = { standard: 'rgb(100, 102, 93)', swiss: 'rgb(95, 114, 128)', archive: 'rgb(107, 96, 78)', designer: 'rgb(208, 220, 205)', workbench: 'rgb(90, 98, 95)' };
    expect(placeholder.color).toBe(muted[theme as keyof typeof muted]);
    expect(placeholder.opacity).toBe('1');
    expect(await page.locator('.skip-link').evaluate(element => element.getBoundingClientRect().bottom)).toBeLessThanOrEqual(0);
    await page.locator('#assistant-privacy summary').click();
    await page.locator('#assistant-share-metrics').check();
    await page.locator('#appearance-select').selectOption(theme === 'standard' ? 'designer' : 'standard');
    await expect(page.locator('#assistant-share-metrics')).toBeChecked();
    await expect(page.locator('#assistant-privacy')).toHaveAttribute('open', '');
    await page.locator('#appearance-select').selectOption(theme);
    await page.locator('#assistant-privacy summary').click();
    await page.locator('#assistant-records summary').click();
    await expect(page.locator('#assistant-records')).toHaveAttribute('open', '');
    await page.locator('#assistant-records summary').click();
    let calls = 0;
    await page.route('**/api/assistant/chat', route => {
      calls++;
      if (calls === 2) return route.fulfill({ status: 503, json: { error: 'ai-upstream-failed' } });
      return route.fulfill({ contentType: 'text/event-stream', body: 'data: ' + JSON.stringify({ text: '这是主题验收的受控测试回答。\n\n先从**核对关键结论**开始。\n- 写下研究问题\n- 回到原文检查出处\n\n[查看来源](https://example.test/paper)\n\n```js\nconsole.log("逐项核验");\n```' }) + '\n\ndata: [DONE]\n\n' });
    });
    await page.locator('#assistant-message').fill('阅读论文时，怎么判断 AI 总结是否可靠？');
    await page.locator('#assistant-send').click();
    await expect(page.locator('.companion-message:not(.is-user) strong')).toContainText('核对关键结论');
    await expect(page.locator('.companion-message ul li')).toHaveCount(2);
    await expect(page.locator('.companion-message pre')).toContainText('逐项核验');
    await expect(page.locator('#send-preview')).toHaveCount(0);
    await page.screenshot({ path: info.outputPath('appearance-' + theme + '-conversation.png'), fullPage: true });
    for (const selector of ['.appearance-caption', '.companion-message.is-user', '.companion-message:not(.is-user)', '.companion-message a', '#assistant-send']) {
      const ratio = await page.locator(selector).first().evaluate(element => {
        const rgb = (value: string) => (value.match(/[\d.]+/g) || []).map(Number);
        const luminance = (values: number[]) => values.slice(0, 3).map(value => { const s = value / 255; return s <= .04045 ? s / 12.92 : ((s + .055) / 1.055) ** 2.4; }).reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0);
        let background = [255, 255, 255];
        const layers: number[][] = [];
        for (let node: Element | null = element; node; node = node.parentElement) layers.unshift(rgb(getComputedStyle(node).backgroundColor));
        for (const layer of layers) { const alpha = layer.length > 3 ? layer[3] : 1; background = background.map((value, i) => layer[i] * alpha + value * (1 - alpha)); }
        const fg = luminance(rgb(getComputedStyle(element).color)), bg = luminance(background);
        return (Math.max(fg, bg) + .05) / (Math.min(fg, bg) + .05);
      });
      expect(ratio, theme + ' contrast: ' + selector).toBeGreaterThanOrEqual(4.5);
    }
    await page.locator('#assistant-message').fill('继续核验这一条结论');
    await page.locator('#assistant-send').click();
    await expect(page.locator('#assistant-notice')).toContainText('歇一会儿');
    await expect(page.locator('#assistant-message')).toHaveValue('继续核验这一条结论');
    await page.locator('#assistant-send').click();
    await expect(page.locator('.companion-message.is-user')).toHaveCount(2);
    expect(calls).toBe(3);
    await page.locator('[data-companion-support]').click();
    await expect(page.locator('.sheet')).toContainText('yajing1906232977@163.com');
    await page.keyboard.press('Escape');
    await expect(page.locator('.sheet')).toHaveCount(0);
  });
}
