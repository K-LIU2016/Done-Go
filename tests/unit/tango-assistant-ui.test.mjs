import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../../web/assistant-ui.js', import.meta.url), 'utf8');

test('explicit sharing refusal survives every contextual entry and reload, while allowing opt-in again', () => {
  const storage = new Map();
  function create(blockStorage = false) {
    const listeners = {};
    const context = vm.createContext({
      window: { TangoAssistant: { sanitizeSession: value => value } }, URL,
      document: { addEventListener(type, handler) { listeners[type] = handler; }, getElementById: () => null, querySelector: () => null },
      localStorage: {
        getItem(key) { if (blockStorage) throw new Error('blocked'); return storage.get(key) || null; },
        setItem(key, value) { if (blockStorage) throw new Error('blocked'); storage.set(key, value); }
      }
    });
    vm.runInContext(source, context);
    const ui = context.window.TangoAssistantUI.create({ active: () => false, navigate() {}, connection: () => ({ label: 'fixture' }), tasks: () => [], metrics: () => ({ period: {} }) });
    return { ui, change(field, checked) { listeners.change({ target: { id: 'assistant-share-' + field, checked } }); } };
  }
  function enterAll(ui) {
    ui.open('models', 'entry:fixture');
    ui.open('priorities', null, { taskIds: ['entry:fixture'] });
    ui.open('reflection', null, { range: { from: '2026-10-01', to: '2026-10-21' } });
    for (const field of ['tasks', 'metrics', 'models']) assert.doesNotMatch(ui.render(), new RegExp('id="assistant-share-' + field + '" checked'), field + ' must remain private');
  }
  const first = create();
  for (const field of ['tasks', 'metrics', 'models']) first.change(field, false);
  enterAll(first.ui);
  enterAll(create().ui);
  const memoryOnly = create(true);
  for (const field of ['tasks', 'metrics', 'models']) memoryOnly.change(field, false);
  enterAll(memoryOnly.ui);
  first.change('tasks', true);
  first.ui.open('models', 'entry:fixture');
  assert.match(first.ui.render(), /id="assistant-share-tasks" checked/);
});

test('assistant UI script parses and renders without a duplicate return failure', () => {
  const listeners = {};
  const task = { id: 'entry:privacy-fixture', date: '2026-10-17', title: '测试事项', start: '09:00', end: '10:00', prio: 3, kind: 'necessary', done: false };
  const document = {
    addEventListener(type, handler) { listeners[type] = handler; },
    querySelector() { return null; },
    getElementById() { return null; }
  };
  const localStorage = {
    getItem() { return null; },
    setItem() {}
  };
  const context = vm.createContext({
    window: {
      TangoAssistant: {
        sanitizeSession(value) { return value; }
      }
    },
    document,
    localStorage,
    URL,
    AbortController,
    setTimeout,
    clearTimeout
  });

  assert.doesNotThrow(() => vm.runInContext(source, context));
  const ui = context.window.TangoAssistantUI.create({
    active: () => true,
    refresh() {},
    connection: () => ({ label: '未配置', available: false, loading: false }),
    tasks: () => [task],
    metrics: () => ({ period: { from: '2026-10-17', to: '2026-10-17' } }),
    modelEvidence: () => [],
    navigate() {},
    route: () => 'assistant'
  });

  const html = ui.render();
  assert.match(html, /id="assistant-root"/);
  assert.match(html, /<details id="assistant-privacy"[^>]*>/);
  assert.match(html, /<details id="assistant-records"[^>]*>/);
  assert.doesNotMatch(html, /<details[^>]*\bopen[ >]/);
  assert.doesNotMatch(html, /我的目标与边界|assistant-notes/);
  assert.match(html, /select id="assistant-mode"/);
  assert.doesNotMatch(html, /assistant-model/);
  assert.doesNotMatch(html, /data-companion-task=/, 'task choices stay out of view until sharing is enabled');
  assert.doesNotMatch(html, /id="assistant-share-tasks" checked/);
  assert.doesNotMatch(html, /测试事项/);
  assert.match(html, /由你决定，分享多少/);
  assert.match(html, /链接与记录/);

  listeners.change({ target: { id: 'assistant-share-tasks', checked: true } });
  const sharingHtml = ui.render();
  assert.match(sharingHtml, /data-companion-task="entry:privacy-fixture"/);
  assert.match(sharingHtml, /测试事项/);
});

test('assistant UI exposes a small technical support action and opens the bridge callback', () => {
  const listeners = {};
  const document = {
    addEventListener(type, handler) { listeners[type] = handler; },
    querySelector() { return null; },
  };
  const localStorage = {
    getItem() { return null; },
    setItem() {}
  };
  const context = vm.createContext({
    window: {
      TangoAssistant: {
        sanitizeSession(value) { return value; }
      }
    },
    document,
    localStorage,
    URL,
    AbortController,
    setTimeout,
    clearTimeout
  });

  vm.runInContext(source, context);
  let supportCalls = 0;
  const ui = context.window.TangoAssistantUI.create({
    active: () => true,
    refresh() {},
    connection: () => ({ label: '未配置', available: false, loading: false }),
    tasks: () => [],
    metrics: () => ({ period: { from: '2026-10-17', to: '2026-10-17' } }),
    modelEvidence: () => [],
    navigate() {},
    route: () => 'assistant',
    support() { supportCalls += 1; }
  });

  const html = ui.render();
  assert.match(html, /data-companion-support/);
  assert.match(html, />技术支持</);

  const target = {
    hasAttribute(name) { return name === 'data-companion-support'; },
    closest() { return this; }
  };
  listeners.click({ target });
  assert.equal(supportCalls, 1);
});

test('assistant UI uses the Done&Go support message for model connection failures', async () => {
  const listeners = {};
  const messageInput = { value: '请回答这个问题', trim() { return this.value.trim(); } };
  const document = {
    addEventListener(type, handler) { listeners[type] = handler; },
    querySelector() { return null; },
    getElementById(selector) { return selector === 'assistant-message' ? messageInput : null; }
  };
  const localStorage = {
    getItem() { return null; },
    setItem() {}
  };
  const context = vm.createContext({
    window: {
      TangoAssistant: {
        sanitizeSession(value) { return value; },
        buildContext() { return {}; },
        buildPrompt() { return 'prompt'; },
        validateReply() { return { reply: 'ok', suggestions: [] }; }
      }
    },
    document,
    localStorage,
    URL,
    AbortController,
    setTimeout,
    clearTimeout
  });

  vm.runInContext(source, context);
  let refreshCalls = 0;
  const ui = context.window.TangoAssistantUI.create({
    active: () => true,
    refresh() { refreshCalls += 1; },
    connection: () => ({ label: '未配置', available: false, loading: false }),
    request: async () => { throw new Error('not configured'); },
    requestText: async () => { throw new Error('not configured'); },
    tasks: () => [],
    metrics: () => ({ period: { from: '2026-10-17', to: '2026-10-17' } }),
    modelEvidence: () => [],
    navigate() {},
    route: () => 'assistant',
    support() {}
  });

  await listeners.submit({ target: { id: 'assistant-form' }, preventDefault() {} });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.match(ui.render(), /歇一会儿我们再继续吧，或者联系技术支持人员来为你开通新的探戈通道吧。/);
  assert.ok(refreshCalls > 0);
});

test('assistant chat shows a waiting state with a streaming bubble and locks purpose while a request is in flight', async () => {
  const listeners = {};
  const messageInput = { value: '请回答', trim() { return this.value.trim(); } };
  const document = {
    addEventListener(type, handler) { listeners[type] = handler; },
    querySelector() { return null; },
    getElementById(selector) { return selector === 'assistant-message' ? messageInput : null; }
  };
  const localStorage = { getItem() { return null; }, setItem() {} };
  const context = vm.createContext({
    window: {
      TangoAssistant: {
        sanitizeSession(value) { return value; },
        buildContext() { return {}; },
        buildPrompt() { return 'prompt'; },
        validateReply() { return { reply: '模型回答', suggestions: [] }; }
      }
    },
    document,
    localStorage,
    URL,
    AbortController,
    setTimeout,
    clearTimeout
  });
  vm.runInContext(source, context);
  let resolveRequest;
  const ui = context.window.TangoAssistantUI.create({
    active: () => true,
    refresh() {},
    connection: () => ({ label: '已连接', available: true, loading: false }),
    requestText: () => new Promise(resolve => { resolveRequest = resolve; }),
    tasks: () => [],
    metrics: () => ({ period: { from: '2026-10-17', to: '2026-10-17' } }),
    modelEvidence: () => [],
    navigate() {},
    route: () => 'assistant',
    support() {}
  });

  listeners.submit({ target: { id: 'assistant-form' }, preventDefault() {} });
  const pendingHtml = ui.render();
  assert.match(pendingHtml, /正在等待回应/);
  assert.match(pendingHtml, /id="assistant-mode"[^>]*disabled/);
  assert.match(pendingHtml, /id="assistant-stream"/);
  assert.match(pendingHtml, /id="assistant-send"[^>]*disabled[^>]*>等待中/);

  resolveRequest('流式回答完成');
  await new Promise(resolve => setTimeout(resolve, 0));
  const completeHtml = ui.render();
  assert.match(completeHtml, /流式回答完成/);
  assert.doesNotMatch(completeHtml, /id="assistant-mode"[^>]*disabled/);
  assert.doesNotMatch(completeHtml, /id="assistant-stream"/);
});

test('a failed turn restores the exact draft, and retry does not duplicate the user turn or share it twice', async () => {
  const listeners = {}, input = { value: '  帮我拆解任务\n先看材料  ' };
  let stored = null, fail = true, builtContext;
  const context = vm.createContext({ window: { TangoAssistant: {
    sanitizeSession: value => value,
    buildContext(value) { builtContext = value; return {}; },
    buildPrompt: () => 'prompt'
  } }, document: { addEventListener(type, handler) { listeners[type] = handler; }, querySelector: () => null, getElementById: key => key === 'assistant-message' ? input : null }, localStorage: { getItem: () => stored, setItem(key, value) { stored = value; } }, URL });
  vm.runInContext(source, context);
  const ui = context.window.TangoAssistantUI.create({ active: () => true, refresh() {}, tasks: () => [], metrics: () => ({}), connection: () => ({ available: true, label: 'fixture' }), requestText: async () => { if (fail) throw new Error('provider unavailable'); return '回答'; } });
  listeners.submit({ target: { id: 'assistant-form' }, preventDefault() {} });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.match(ui.render(), />  帮我拆解任务\n先看材料  <\/textarea>/);
  assert.match(ui.render(), />重试<\/button>/);
  assert.equal(JSON.parse(stored).messages.length, 1);
  fail = false;
  listeners.submit({ target: { id: 'assistant-form' }, preventDefault() {} });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(JSON.parse(stored).messages.length, 2);
  assert.equal(builtContext.session.messages.length, 0);
  assert.match(ui.render(), /回答/);
});

test('model formatting escapes HTML and permits only safe HTTPS links outside code', () => {
  const reply = '<img src=x onerror=alert(1)>\n**核对**\n- 第一项\n- 第二项\n[来源](https://example.test/paper?q=1&v=2)\n[危险](javascript:alert)\n[文件](data:text/html,evil)\n```html\n<script>alert(1)</script>\n```';
  const context = vm.createContext({ window: { TangoAssistant: { sanitizeSession: value => value } }, URL, document: { addEventListener() {}, getElementById: () => null, querySelector: () => null }, localStorage: { getItem: () => JSON.stringify({ v: 1, messages: [{ id: 'fixture', role: 'assistant', source: 'model', text: reply }], notes: '' }) } });
  vm.runInContext(source, context);
  const ui = context.window.TangoAssistantUI.create({ connection: () => ({ label: 'fixture' }), tasks: () => [] });
  const html = ui.render();
  assert.match(html, /<strong>核对<\/strong>/);
  assert.match(html, /<ul><li>第一项<\/li><li>第二项<\/li><\/ul>/);
  assert.match(html, /href="https:\/\/example.test\/paper\?q=1&amp;v=2" target="_blank" rel="noopener noreferrer"/);
  assert.match(html, /<pre><code>&lt;script&gt;/);
  assert.doesNotMatch(html, /<img src=x|<script>|href="(?:javascript:|data:)/);
});
