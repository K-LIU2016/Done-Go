import assert from 'node:assert/strict';
import { test } from 'node:test';
import { request } from 'node:http';
import { createTangoServer, createAIGuard } from '../../scripts/serve-tango.mjs';
import { createAssistant } from '../../scripts/ai-assistant.mjs';

function call(port, path, { method = 'GET', body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method, headers }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', part => { text += part; });
      res.on('end', () => resolve({ status: res.statusCode, data: text ? JSON.parse(text) : null }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

async function start(t, options) {
  const server = createTangoServer(options);
  t.after(() => new Promise(resolve => server.close(resolve)));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return server;
}

function countingAssistant() {
  const state = { calls: 0 };
  state.assistant = {
    configuration: () => ({}),
    chat: async () => { state.calls++; return { content: [{ type: 'text', text: 'ok' }] }; },
    streamChat: async function* () { state.calls++; yield 'ok'; },
  };
  return state;
}

test('AI feature flags default to off and surface read-only through /api/assistant/features', async t => {
  assert.deepEqual(createAIGuard({ env: {} }).features(), { parse: false, prompts: false });
  assert.deepEqual(createAIGuard({ env: { TANGO_AI_PARSE: '0', TANGO_AI_PROMPTS: 'no' } }).features(), { parse: false, prompts: false });
  assert.deepEqual(createAIGuard({ env: { TANGO_AI_PARSE: '1', TANGO_AI_PROMPTS: 'TRUE' } }).features(), { parse: true, prompts: true });
  const serverOff = await start(t, { assistant: countingAssistant().assistant, aiGuard: createAIGuard({ env: {} }) });
  const offPort = serverOff.address().port;
  const off = await call(offPort, '/api/assistant/features');
  assert.equal(off.status, 200);
  assert.deepEqual(off.data, { parse: false, prompts: false });
  assert.equal((await call(offPort, '/api/assistant/features?x=1')).status, 400);
  assert.equal((await call(offPort, '/api/assistant/features', { method: 'PUT' })).status, 405);
  const serverOn = await start(t, { assistant: countingAssistant().assistant, aiGuard: createAIGuard({ env: { TANGO_AI_PARSE: '1', TANGO_AI_PROMPTS: 'true' } }) });
  const on = await call(serverOn.address().port, '/api/assistant/features');
  assert.deepEqual(on.data, { parse: true, prompts: true });
});

test('parse and prompt modes stay closed until their flag is enabled; legacy modes never gate', async t => {
  const state = countingAssistant();
  const server = await start(t, { assistant: state.assistant, aiGuard: createAIGuard({ env: {} }) });
  const port = server.address().port;
  const headers = { Origin: 'http://127.0.0.1:' + port, 'Content-Type': 'application/json' };
  const parse = await call(port, '/api/assistant/chat', { method: 'POST', headers, body: JSON.stringify({ prompt: '晚上10点复盘会', mode: 'parse' }) });
  assert.equal(parse.status, 400);
  assert.equal(parse.data.code, 'TANGO_AI_MODE_DISABLED');
  assert.equal(parse.data.message, '该 AI 功能未开放');
  const prompt = await call(port, '/api/assistant/chat', { method: 'POST', headers, body: JSON.stringify({ prompt: '写周报', mode: 'prompt' }) });
  assert.equal(prompt.status, 400);
  assert.equal(prompt.data.code, 'TANGO_AI_MODE_DISABLED');
  assert.equal(state.calls, 0);
  const chat = await call(port, '/api/assistant/chat', { method: 'POST', headers, body: JSON.stringify({ prompt: 'hello', mode: 'chat' }) });
  assert.equal(chat.status, 200);
  assert.equal(state.calls, 1);
  const open = await start(t, { assistant: countingAssistant().assistant, aiGuard: createAIGuard({ env: { TANGO_AI_PARSE: '1', TANGO_AI_PROMPTS: '1' } }) });
  const openPort = open.address().port;
  const openHeaders = { Origin: 'http://127.0.0.1:' + openPort, 'Content-Type': 'application/json' };
  const parseOpen = await call(openPort, '/api/assistant/chat', { method: 'POST', headers: openHeaders, body: JSON.stringify({ prompt: '晚上10点复盘会', mode: 'parse' }) });
  assert.equal(parseOpen.status, 200);
  const promptOpen = await call(openPort, '/api/assistant/chat', { method: 'POST', headers: openHeaders, body: JSON.stringify({ prompt: '写周报', mode: 'prompt' }) });
  assert.equal(promptOpen.status, 200);
});

test('the global daily AI budget returns 429 with a visitor-facing message and resets the next day', async t => {
  let clock = new Date(2026, 9, 22, 10, 0, 0).getTime();
  const state = countingAssistant();
  const server = await start(t, { assistant: state.assistant, aiGuard: createAIGuard({ env: { TANGO_AI_DAILY_LIMIT: '2' }, now: () => clock }) });
  const port = server.address().port;
  const headers = { Origin: 'http://127.0.0.1:' + port, 'Content-Type': 'application/json' };
  assert.equal((await call(port, '/api/assistant/chat', { method: 'POST', headers, body: '{"prompt":"一"}' })).status, 200);
  assert.equal((await call(port, '/api/assistant/chat', { method: 'POST', headers, body: '{"prompt":"二"}' })).status, 200);
  assert.equal(state.calls, 2);
  const third = await call(port, '/api/assistant/chat', { method: 'POST', headers, body: '{"prompt":"三"}' });
  assert.equal(third.status, 429);
  assert.equal(third.data.code, 'TANGO_AI_DAILY_LIMIT');
  assert.equal(third.data.message, '今日体验额度已用完');
  const streamed = await call(port, '/api/assistant/chat', { method: 'POST', headers, body: '{"prompt":"四","stream":true}' });
  assert.equal(streamed.status, 429);
  assert.equal(streamed.data.code, 'TANGO_AI_DAILY_LIMIT');
  assert.equal(state.calls, 2);
  clock = new Date(2026, 9, 23, 8, 0, 0).getTime();
  const nextDay = await call(port, '/api/assistant/chat', { method: 'POST', headers, body: '{"prompt":"新的一天"}' });
  assert.equal(nextDay.status, 200);
  assert.equal(state.calls, 3);
});

test('per-visitor minute quotas apply per forwarded visitor identity', async t => {
  let clock = new Date(2026, 9, 22, 10, 0, 0).getTime();
  const state = countingAssistant();
  const server = await start(t, { assistant: state.assistant, aiGuard: createAIGuard({ env: { TANGO_AI_RATE_LIMIT: '2' }, now: () => clock }) });
  const port = server.address().port;
  const headers = { Origin: 'http://127.0.0.1:' + port, 'Content-Type': 'application/json' };
  assert.equal((await call(port, '/api/assistant/chat', { method: 'POST', headers, body: '{"prompt":"一"}' })).status, 200);
  assert.equal((await call(port, '/api/assistant/chat', { method: 'POST', headers, body: '{"prompt":"二"}' })).status, 200);
  const third = await call(port, '/api/assistant/chat', { method: 'POST', headers, body: '{"prompt":"三"}' });
  assert.equal(third.status, 429);
  assert.equal(third.data.code, 'TANGO_AI_RATE_LIMITED');
  assert.equal(third.data.message, '访问过于频繁，请稍后再试');
  const forwarded = await call(port, '/api/assistant/chat', { method: 'POST', headers: { ...headers, 'X-Forwarded-For': '198.51.100.7' }, body: '{"prompt":"另一位访客"}' });
  assert.equal(forwarded.status, 200);
  clock += 61000;
  const nextWindow = await call(port, '/api/assistant/chat', { method: 'POST', headers, body: '{"prompt":"新窗口"}' });
  assert.equal(nextWindow.status, 200);
  assert.equal(state.calls, 4);
});

test('oversized parse input is rejected with a clear code before any upstream call', async t => {
  let upstream = 0;
  const assistant = createAssistant({ config: { provider: 'openai', url: 'https://api.example.com/v1/chat/completions', model: 'auto', key: 'synthetic-test-key' }, env: {}, fetch: async () => { upstream++; return new Response('{"choices":[{"message":{"content":"{}"}}]}'); } });
  const server = await start(t, { assistant, aiGuard: createAIGuard({ env: { TANGO_AI_PARSE: '1' } }) });
  const port = server.address().port;
  const headers = { Origin: 'http://127.0.0.1:' + port, 'Content-Type': 'application/json' };
  const oversized = await call(port, '/api/assistant/chat', { method: 'POST', headers, body: JSON.stringify({ prompt: 'x'.repeat(2001), mode: 'parse' }) });
  assert.equal(oversized.status, 413);
  assert.equal(oversized.data.code, 'TANGO_AI_INPUT_TOO_LONG');
  assert.equal(oversized.data.message, '输入内容过长，请精简后重试');
  assert.equal(upstream, 0);
  const fine = await call(port, '/api/assistant/chat', { method: 'POST', headers, body: JSON.stringify({ prompt: 'x'.repeat(2000), mode: 'parse' }) });
  assert.equal(fine.status, 200);
  assert.equal(upstream, 1);
});
