import { test, expect, type Page, type Route } from '@playwright/test';

const STATE_KEY = 'tango-donego.web.v1';
const SESSION_KEY = 'tango-donego.assistant.v1';
const task = { id: 'paper', date: '2026-10-17', title: '论文修改', start: '09:00', end: '10:00', kind: 'create', prio: 3 };
const initialState = { v: 1, pv: 5, mode: 'real', name: 'private-owner', wake: 960, entries: [task], trials: [], drafts: [], fw: {}, pal: 0, sound: false };
type SharedContext = {
  mode: string;
  tasks: Array<{ targetId: string; fingerprint: string }>;
  messages: Array<{ role: string; text: string; source?: string }>;
  modelEvidence: Array<{ modelId: string; availability: string }>;
};
function requestContext(route: Route): SharedContext {
  const prompt = route.request().postDataJSON().prompt as string;
  const separator = '\nCONTEXT_JSON\n';
  expect(prompt).toContain(separator);
  return JSON.parse(prompt.slice(prompt.lastIndexOf(separator) + separator.length));
}
async function respond(route: Route, reply: string, suggestions: Record<string, unknown>[] = []) {
  const body = route.request().postDataJSON() as { stream?: boolean };
  if (body && body.stream === true) {
    await route.fulfill({ headers: { 'Content-Type': 'text/event-stream; charset=utf-8' }, body: 'data: ' + JSON.stringify({ text: reply }) + '\n\ndata: [DONE]\n\n' });
    return;
  }
  await route.fulfill({ json: { content: [{ type: 'text', text: JSON.stringify({ reply, suggestions }) }] } });
}
async function open(page: Page, options: { configured?: boolean; sessionRaw?: string } = {}) {
  const configured = options.configured !== false;
  await page.clock.install({ time: new Date('2026-10-17T08:00:00+08:00') });
  await page.addInitScript(({ initialState, configured, sessionRaw, stateKey, sessionKey }) => {
    if (!localStorage.getItem('assistant-boundaries-seeded')) {
      localStorage.setItem(stateKey, JSON.stringify(initialState));
      localStorage.setItem('tango-donego.lang', 'zh');
      localStorage.setItem('tango-donego.llm.v1', JSON.stringify({ mode: configured ? 'auto' : 'off', consent: configured }));
      if (sessionRaw !== undefined) localStorage.setItem(sessionKey, sessionRaw);
      localStorage.setItem('assistant-boundaries-seeded', '1');
    }
  }, { initialState, configured, sessionRaw: options.sessionRaw, stateKey: STATE_KEY, sessionKey: SESSION_KEY });
  await page.route('https://**', route => route.abort());
  await page.route('**/api/status', route => route.fulfill({ json: { status: 'ok', version: '0.1.0-local', runtime: 'web-local' } }));
  await page.route('**/api/llm/config', route => route.fulfill({ json: { endpoints: [] } }));
  await page.route('**/api/assistant/config', route => route.fulfill({ json: { available: configured, provider: configured ? 'openai' : null, model: configured ? 'fixture-model' : null, destination: configured ? 'https://example.test/v1/chat/completions' : null } }));
  await page.goto('/#today');
  await page.locator('[data-act="assistant-open"]').first().click();
  if (configured) {
    await expect(page.locator('#assistant-connection')).toBeHidden();
    await expect(page.locator('#assistant-root')).not.toContainText('fixture-model');
  } else {
    await expect(page.locator('#assistant-connection')).not.toContainText('本地引导');
  }
}
async function shareTask(page: Page, mode: 'priorities' | 'models') {
  await page.locator('#assistant-mode').selectOption(mode);
  await page.locator('#assistant-privacy summary').click();
  if (mode === 'models') await page.locator('#assistant-share-models').check();
  await page.locator('#assistant-share-tasks').check();
  await page.locator('[data-companion-task="entry:paper"]').check();
}
async function send(page: Page, message: string) {
  await page.locator('#assistant-message').fill(message);
  await page.locator('#assistant-send').click();
  await expect(page.locator('#send-preview')).toHaveCount(0);
}
async function savedState(page: Page) { return page.evaluate(key => JSON.parse(localStorage.getItem(key)!), STATE_KEY); }
async function savedSession(page: Page) { return page.evaluate(key => JSON.parse(localStorage.getItem(key)!), SESSION_KEY); }

test('a model-only proposal requires manual adoption and persists its preference without changing the time ledger', async ({ page }) => {
  await open(page);
  let shared: SharedContext | undefined;
  await page.route('**/api/assistant/chat', async route => {
    shared = requestContext(route);
    const chosen = shared.tasks[0];
    expect(shared.modelEvidence.some(model => model.modelId === 'gpt-5.4')).toBe(true);
    await respond(route, '可以把这个候选交给你核验后再决定。', [{ targetId: chosen.targetId, fingerprint: chosen.fingerprint, modelId: 'gpt-5.4', reason: '先检查账户额度，再核对输出与原文。' }]);
  });
  const before = await savedState(page);
  await shareTask(page, 'models');
  await expect(page.locator('#assistant-share-models')).toBeChecked();
  await send(page, '为这个任务选一个模型候选');
  await expect(page.locator('[data-companion-apply]')).toHaveCount(1);
  expect((await savedState(page)).entries).toEqual(before.entries);
  expect(shared!.tasks[0].targetId).toBe('entry:paper');
  await page.locator('[data-companion-apply]').click();
  await expect(page.locator('#assistant-notice')).toContainText('已采纳');
  const adopted = await savedState(page);
  expect(adopted.entries[0]).toEqual({ ...before.entries[0], modelPreference: 'gpt-5.4' });
  expect(adopted.trials).toEqual(before.trials);
  await page.reload();
  const restored = await savedState(page);
  expect(restored.entries[0]).toEqual(adopted.entries[0]);
  expect(restored.trials).toEqual(before.trials);
});

test('a single send requests the model directly and blocks duplicate submissions while waiting', async ({ page }) => {
  await open(page);
  let requests = 0;
  let notifyStarted!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { notifyStarted = resolve; });
  const released = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/assistant/chat', async route => {
    requests++; notifyStarted(); await released;
    await respond(route, '直接发送后的模型回应');
  });
  const before = await savedState(page);
  await send(page, '点击一次就发送这条消息');
  await started;
  await expect(page.locator('#assistant-send')).toBeDisabled();
  await expect(page.locator('#assistant-mode')).toBeDisabled();
  await page.locator('#assistant-message').press('Enter');
  expect(requests).toBe(1);
  await expect(page.locator('.companion-message.is-user')).toHaveCount(1);
  release();
  await expect(page.locator('.companion-message:not(.is-user)')).toContainText('直接发送后的模型回应');
  await expect(page.locator('#assistant-send')).toBeEnabled();
  expect(requests).toBe(1);
  expect((await savedSession(page)).messages.at(-1).source).toBe('model');
  expect(await savedState(page)).toEqual(before);
});

test('task suggestion requests omit saved conversation until explicit sharing and then include the actual earlier dialogue', async ({ page }) => {
  await open(page);
  const contexts: SharedContext[] = [];
  await page.route('**/api/assistant/chat', async route => { contexts.push(requestContext(route)); await respond(route, '受控模型回应 ' + contexts.length); });
  await send(page, 'private-chat-context：周末想陪家人');
  await expect(page.locator('.companion-message').last()).toContainText('受控模型回应 1');
  await shareTask(page, 'priorities');
  await expect(page.locator('#assistant-use-chat')).not.toBeChecked();
  await send(page, '先只讨论这个任务');
  await expect(page.locator('.companion-message').last()).toContainText('受控模型回应 2');
  expect(contexts[1].mode).toBe('priorities');
  expect(contexts[1].messages).toEqual([]);
  await page.locator('#assistant-use-chat').check();
  await send(page, '现在结合之前聊到的边界');
  await expect(page.locator('.companion-message').last()).toContainText('受控模型回应 3');
  expect(contexts[2].messages.some(message => message.role === 'user' && message.text.includes('private-chat-context'))).toBe(true);
  expect(contexts[2].messages.some(message => message.role === 'assistant' && message.text === '受控模型回应 1' && message.source === 'model')).toBe(true);
  expect(JSON.stringify(contexts)).not.toContain('private-owner');
  expect((await savedSession(page)).useChatForSuggestions).toBe(true);
});

test('a target changed in persistent storage during the request cannot be overwritten by adopting an older proposal', async ({ page }) => {
  await open(page);
  let notifyStarted!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { notifyStarted = resolve; });
  const released = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/assistant/chat', async route => {
    const chosen = requestContext(route).tasks[0];
    notifyStarted(); await released;
    await respond(route, '这是请求发起时的旧快照建议。', [{ targetId: chosen.targetId, fingerprint: chosen.fingerprint, priority: 1, kind: 'create', reason: '仍需根据最新事项确认。' }]);
  });
  await shareTask(page, 'priorities');
  await send(page, '请给出可核验的建议');
  await started;
  const changedRaw = await page.evaluate(key => {
    const changed = JSON.parse(localStorage.getItem(key)!);
    changed.entries[0].title = '其他标签更新后的论文任务'; changed.entries[0].prio = 4;
    changed.entries.push({ id: 'other', date: '2026-10-17', title: '其他标签新增事项', start: '11:00', end: '12:00', kind: 'necessary', prio: 2 });
    const raw = JSON.stringify(changed); localStorage.setItem(key, raw); return raw;
  }, STATE_KEY);
  release();
  await expect(page.locator('[data-companion-apply]')).toHaveCount(1);
  await page.locator('[data-companion-apply]').click();
  await expect(page.locator('#assistant-notice')).toContainText('未应用');
  expect(await page.evaluate(key => localStorage.getItem(key), STATE_KEY)).toBe(changedRaw);
  await page.reload();
  const restored = await savedState(page);
  expect(restored.entries[0]).toMatchObject({ title: '其他标签更新后的论文任务', prio: 4 });
  expect(restored.entries).toHaveLength(2);
  expect(restored.trials).toEqual([]);
});

test('damaged conversation storage stays intact and offers an actionable export of the protected original', async ({ page }) => {
  const damaged = '{"v":1,"messages":[broken-original';
  await open(page, { configured: false, sessionRaw: damaged });
  await expect(page.locator('#assistant-notice')).toContainText('无法读取');
  await expect(page.locator('#assistant-notice')).toContainText('导出');
  await page.locator('#assistant-records summary').click();
  await expect(page.locator('[data-companion-export]')).toBeVisible();
  expect(await page.evaluate(key => localStorage.getItem(key), SESSION_KEY)).toBe(damaged);
  await page.locator('#assistant-message').fill('原存储损坏时，先在内存中继续');
  await page.locator('#assistant-send').click();
  await expect(page.locator('.companion-message')).toHaveCount(1);
  expect(await page.evaluate(key => localStorage.getItem(key), SESSION_KEY)).toBe(damaged);
  await page.locator('[data-companion-export]').click();
  await expect(page.locator('#exp')).toBeVisible();
  const exported = JSON.parse(await page.locator('#exp').inputValue());
  expect(exported.protectedOriginal).toBe(damaged);
  expect(exported.currentSession.messages).toHaveLength(1);
  expect(exported.currentSession.messages[0].role).toBe('user');
  expect(await page.evaluate(key => localStorage.getItem(key), SESSION_KEY)).toBe(damaged);
});

test('a provider error produces no fake answer and no local guidance action', async ({ page }) => {
  await open(page);
  let requests = 0;
  await page.route('**/api/assistant/chat', async route => { requests++; await route.fulfill({ status: 502, json: { error: 'ai-upstream-failed', code: 'TANGO_AI_UPSTREAM_FAILED' } }); });
  const before = await savedState(page);
  await send(page, '服务失败时我也想继续理清安排');
  await expect(page.locator('#assistant-notice')).toContainText('歇一会儿我们再继续吧');
  await expect(page.locator('#assistant-root')).not.toContainText('本地引导');
  await expect(page.locator('[data-companion-local]')).toHaveCount(0);
  await expect(page.locator('.companion-message:not(.is-user)')).toHaveCount(0);
  const session = await savedSession(page);
  expect(session.messages[session.messages.length - 1].role).toBe('user');
  expect(session.messages.some((message: { source?: string }) => message.source === 'model')).toBe(false);
  expect(requests).toBe(1);
  expect(await savedState(page)).toEqual(before);
});

test('revoking conversation sharing immediately shows a persistence failure instead of silently restoring old consent on reload', async ({ page }) => {
  const original = JSON.stringify({ v: 1, messages: [], notes: '', useChatForSuggestions: true });
  await open(page, { sessionRaw: original });
  await expect(page.locator('#assistant-use-chat')).toBeChecked();
  await page.evaluate(key => {
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (name: string, value: string) {
      if (name === key) throw new DOMException('Controlled quota failure for conversation only', 'QuotaExceededError');
      return setItem.call(this, name, value);
    };
  }, SESSION_KEY);
  await page.locator('#assistant-privacy summary').click();
  await page.locator('#assistant-use-chat').uncheck();
  await expect(page.locator('#assistant-use-chat')).not.toBeChecked();
  expect(await page.evaluate(key => localStorage.getItem(key), SESSION_KEY)).toBe(original);
  expect((await savedSession(page)).useChatForSuggestions).toBe(true);
  await expect(page.locator('#assistant-notice')).toContainText(/保存|内存|存储受保护/);
  await expect(page.locator('#assistant-notice')).toContainText('导出');
});
