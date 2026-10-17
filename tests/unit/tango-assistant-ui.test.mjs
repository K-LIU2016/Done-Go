import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../../web/assistant-ui.js', import.meta.url), 'utf8');

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
  assert.match(html, /select id="assistant-model"/);
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

test('assistant chat shows a waiting state and locks purpose and model while a request is in flight', async () => {
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
    modelChoices: () => [{ value: 'fixture', label: '测试模型', selected: true }],
    selectModel() {},
    request: () => new Promise(resolve => { resolveRequest = resolve; }),
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
  assert.match(pendingHtml, /id="assistant-model"[^>]*disabled/);
  assert.match(pendingHtml, /id="assistant-send"[^>]*disabled[^>]*>等待中/);

  resolveRequest({});
  await new Promise(resolve => setTimeout(resolve, 0));
  const completeHtml = ui.render();
  assert.doesNotMatch(completeHtml, /id="assistant-mode"[^>]*disabled/);
  assert.doesNotMatch(completeHtml, /id="assistant-model"[^>]*disabled/);
});
