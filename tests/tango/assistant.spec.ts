import { test, expect, type Page } from '@playwright/test';

const task = { id: 'paper', date: '2026-10-17', title: '论文修改', start: '09:00', end: '10:00', kind: 'create', prio: 3 };
const state = { v: 1, pv: 5, mode: 'real', name: 'private-owner', wake: 960, entries: [task], trials: [], drafts: [], fw: {}, pal: 0, sound: false };
async function open(page: Page, configured = false, consent = configured, configGate?: Promise<void>) {
  await page.clock.install({ time: new Date('2026-10-17T08:00:00+08:00') });
  await page.addInitScript(({ state, configured, consent }) => {
    if (!localStorage.getItem('assistant-seeded')) {
      localStorage.setItem('tango-donego.web.v1', JSON.stringify(state));
      localStorage.setItem('tango-donego.lang', 'zh');
      localStorage.setItem('tango-donego.llm.v1', JSON.stringify({ mode: configured ? 'auto' : 'off', consent }));
      localStorage.setItem('assistant-seeded', '1');
    }
  }, { state, configured, consent });
  await page.route('https://**', route => route.abort());
  await page.route('**/api/llm/config', route => route.fulfill({ json: { endpoints: [] } }));
  await page.route('**/api/assistant/config', async route => {
    if (configGate) await configGate;
    return route.fulfill({ json: { available: configured, provider: configured ? 'openai' : null, model: configured ? 'fixture-model' : null, destination: configured ? 'https://example.test/v1/chat/completions' : null } });
  });
  await page.goto('/#today');
}

test('an unavailable companion never fabricates a local answer', async ({ page }, info) => {
  await open(page);
  await page.locator('[data-act="assistant-open"]').first().click();
  await expect(page.locator('#assistant-root')).not.toContainText('本地引导');
  await expect(page.locator('[data-companion-local]')).toHaveCount(0);
  await page.locator('#assistant-message').fill('我想把晚上的时间留给家人');
  await page.locator('#assistant-send').click();
  await expect(page.locator('.companion-message')).toHaveCount(1);
  await expect(page.locator('#assistant-notice')).toContainText('歇一会儿我们再继续吧，或者联系技术支持人员来为你开通新的探戈通道吧。');
  const session = JSON.parse(await page.evaluate(() => localStorage.getItem('tango-donego.assistant.v1')!));
  expect(session.useChatForSuggestions).toBe(false);
  expect(session.messages).toHaveLength(1);
  expect(session.messages[0].role).toBe('user');
  expect((await page.evaluate(() => JSON.parse(localStorage.getItem('tango-donego.web.v1')!))).entries[0]).toEqual(task);
  await page.reload();
  await expect(page.locator('.companion-message')).toHaveCount(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.screenshot({ path: info.outputPath('donego-companion.png'), fullPage: true });
});

test('the configured gateway answers with the selected model even when legacy consent is false', async ({ page }) => {
  await open(page, true, false);
  let requests = 0;
  await page.route('**/api/assistant/chat', async route => {
    requests++;
    await route.fulfill({ json: { content: [{ type: 'text', text: JSON.stringify({ reply: '这是受控模型的真实回答。', suggestions: [] }) }] } });
  });
  await page.locator('[data-act="assistant-open"]').first().click();
  await expect(page.locator('#assistant-model')).toContainText('fixture-model');
  await expect(page.locator('#assistant-root')).not.toContainText('本地引导');
  await expect(page.locator('[data-companion-local]')).toHaveCount(0);
  await page.locator('#assistant-message').fill('请根据我的问题直接回答');
  await page.locator('#assistant-send').click();
  await expect(page.locator('#send-preview')).toBeVisible();
  await page.locator('[data-act="send-confirm"]').click();
  await expect(page.locator('.companion-message').last()).toContainText('这是受控模型的真实回答。');
  const session = JSON.parse(await page.evaluate(() => localStorage.getItem('tango-donego.assistant.v1')!));
  expect(session.messages[session.messages.length - 1].source).toBe('model');
  expect(requests).toBe(1);
});

test('chat waits for an in-flight assistant configuration before checking availability', async ({ page }) => {
  let releaseConfig!: () => void;
  const configGate = new Promise<void>(resolve => { releaseConfig = resolve; });
  await open(page, true, false, configGate);
  await page.route('**/api/assistant/chat', async route => {
    await route.fulfill({ json: { content: [{ type: 'text', text: JSON.stringify({ reply: '配置加载完成后的模型回答。', suggestions: [] }) }] } });
  });
  await page.locator('[data-act="assistant-open"]').first().click();
  await expect(page.locator('#assistant-connection')).toContainText('正在连接所选模型');
  await page.locator('#assistant-message').fill('配置尚未返回时也要等待真实模型');
  await page.locator('#assistant-send').click();
  await expect(page.locator('#assistant-send')).toHaveText('等待中…');
  await expect(page.locator('#assistant-mode')).toBeDisabled();
  await page.waitForTimeout(150);
  releaseConfig();
  await expect(page.locator('#send-preview')).toBeVisible({ timeout: 5000 });
  await page.locator('[data-act="send-confirm"]').click();
  await expect(page.locator('.companion-message').last()).toContainText('配置加载完成后的模型回答。');
});

test('configured AI waits for context preview and a suggestion changes a task only after confirmation', async ({ page }) => {
  await open(page, true);
  let requests = 0, shared = '';
  await page.route('**/api/assistant/chat', async route => {
    requests++; shared = route.request().postDataJSON().prompt;
    const body = JSON.parse(shared.slice(shared.indexOf('\nCONTEXT_JSON\n') + '\nCONTEXT_JSON\n'.length));
    const chosen = body.tasks[0];
    await route.fulfill({ json: { content: [{ type: 'text', text: JSON.stringify({ reply: '根据你共享的目标，可以先处理论文修改。', suggestions: [{ targetId: chosen.targetId, fingerprint: chosen.fingerprint, priority: 1, kind: 'create', reason: '请核对截止日期是否确实临近。' }] }) }] } });
  });
  await page.locator('[data-act="assistant-open"]').first().click();
  await expect(page.locator('#assistant-model')).toContainText('fixture-model');
  await page.locator('#assistant-mode').selectOption('priorities');
  await page.locator('#assistant-privacy summary').click();
  await page.locator('#assistant-share-tasks').check();
  await page.locator('[data-companion-task="entry:paper"]').check();
  await page.locator('#assistant-message').fill('帮我考虑这件事的优先级');
  await page.locator('#assistant-send').click();
  await expect(page.locator('#send-preview')).toBeVisible();
  expect(requests).toBe(0);
  expect(await page.locator('#send-preview').inputValue()).not.toContain('private-owner');
  await page.locator('[data-act="send-confirm"]').click();
  await expect(page.locator('[data-companion-apply]')).toHaveCount(1);
  expect((await page.evaluate(() => JSON.parse(localStorage.getItem('tango-donego.web.v1')!))).entries[0].prio).toBe(3);
  await page.locator('[data-companion-apply]').click();
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('tango-donego.web.v1')!));
  expect(saved.entries[0]).toMatchObject({ prio: 1, start: '09:00', end: '10:00', kind: 'create' });
  expect(saved.trials).toEqual([]);
  expect(requests).toBe(1);
  expect(shared).not.toContain('private-owner');
});

test('chat is excluded from task suggestions until the user enables shared conversational context', async ({ page }) => {
  await open(page);
  await page.locator('[data-act="assistant-open"]').first().click();
  await page.locator('#assistant-message').fill('private-chat-context');
  await page.locator('#assistant-send').click();
  await page.locator('#assistant-mode').selectOption('priorities');
  await page.locator('#assistant-privacy summary').click();
  await expect(page.locator('#assistant-use-chat')).not.toBeChecked();
  await page.locator('#assistant-use-chat').check();
  await page.reload();
  await expect(page.locator('#assistant-use-chat')).toBeChecked();
});

test('review opens a reflective conversation while time facts retain their source and causal limits', async ({ page }) => {
  await open(page);
  await page.goto('/#review');
  await page.locator('[data-act="assistant-reflect"]').click();
  await expect(page.locator('#assistant-mode')).toHaveValue('reflection');
  await expect(page.locator('#assistant-root')).toContainText('差值不等于 AI 的贡献');
  await page.locator('#assistant-message').fill('帮我回顾今天对时间的安排');
  await page.locator('#assistant-send').click();
  await expect(page.locator('.companion-message').last()).not.toBeEmpty();
  expect((await page.evaluate(() => JSON.parse(localStorage.getItem('tango-donego.web.v1')!))).trials).toEqual([]);
});

test('time-tree news and podcasts load only on request with real dates and no transcript transmission', async ({ page }, info) => {
  await open(page);
  let requested = 0;
  await page.route('**/api/discovery?**', route => {
    requested++;
    expect(route.request().url()).not.toContain('private-owner');
    return route.fulfill({ json: { items: [{ id: 'source-1', type: 'news', title: 'AI 研究来源示例', url: 'https://example.test/ai', source: '测试新闻源', publishedAt: '2026-10-16T03:00:00.000Z', excerpt: '这是用于验证来源展示的受控测试数据。' }, { id: 'source-2', type: 'podcast', title: 'AI 播客来源示例', url: 'https://example.test/podcast', source: '测试播客源', publishedAt: '2026-10-15T03:00:00.000Z', excerpt: '讨论如何核对 AI 输出。' }], retrievedAt: '2026-10-17T00:00:00.000Z', stale: false, failures: 0 } });
  });
  await page.goto('/#line');
  expect(requested).toBe(0);
  await page.locator('[data-companion-discover]').click();
  await expect(page.locator('#ai-discovery')).toContainText('AI 播客来源示例');
  await expect(page.locator('#ai-discovery')).toContainText('2026-10-16');
  await expect(page.locator('#ai-discovery a[href="https://example.test/ai"]')).toHaveAttribute('rel', /noopener/);
  expect(requested).toBe(1);
  await page.screenshot({ path: info.outputPath('donego-tree-discovery.png'), fullPage: true });
});
