import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { request } from 'node:http';
import vm from 'node:vm';
import { test } from 'node:test';

import { createAssistant } from '../../scripts/ai-assistant.mjs';
import { createAIGuard, createTangoServer } from '../../scripts/serve-tango.mjs';
import { resolveParse } from '../../web/ai-parse.js';

const CONFIG = {
  provider: 'openai',
  url: 'https://api.example.com/v1/chat/completions',
  model: 'local-fixture-model',
  key: 'synthetic-test-key'
};
const PRODUCT_MODES = ['chat', 'parse', 'prompt', 'priorities', 'models', 'reflection'];
const FIXTURES = {
  chat: '请给出一条建议',
  parse: '<user_input>晚上10点整理实验数据</user_input>',
  prompt: 'USER_REQUEST_JSON\\n{"userRequest":{"title":"写周报"}}\\nCONTEXT_JSON\\n{}',
  priorities: '请按目标和约束整理优先级',
  models: '请比较可用模型',
  reflection: '请回顾这周的时间使用'
};

const openaiReply = (text = 'local fixture response') => new Response(JSON.stringify({ choices: [{ message: { content: text } }] }));
const encoder = new TextEncoder();
const sse = (frames) => {
  const body = new ReadableStream({
    start(controller) {
      for (const frame of frames) controller.enqueue(frame);
      controller.close();
    }
  });
  return new Response(body);
};
const deltaFrame = (value) => encoder.encode('data: ' + JSON.stringify({ choices: [{ delta: value }] }) + '\\n\\n');
const doneFrame = () => encoder.encode('data: [DONE]\\n\\n');
const collect = async (app, input) => {
  const chunks = [];
  for await (const chunk of app.streamChat(input)) chunks.push(chunk);
  return chunks.join('');
};

function httpCall(port, path, { method = 'GET', body, headers = {} } = {}) {
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

async function startServer(t, options) {
  const server = createTangoServer(options);
  t.after(() => new Promise(resolve => server.close(resolve)));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return server;
}

test('MODES includes the six product modes, internal test mode, and integrated relay/story modes', () => {
  const source = readFileSync(new URL('../../scripts/ai-assistant.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('const MODES = [');
  const end = source.indexOf('];', start);
  assert.ok(start >= 0 && end > start, 'ai-assistant.mjs must declare MODES');
  const modesText = source.slice(start + 'const MODES = ['.length, end);
  const modes = [...modesText.matchAll(/["']([^"']+)["']/g)].map(item => item[1]);
  assert.deepEqual(modes, ['chat', 'priorities', 'models', 'reflection', 'test', 'parse', 'prompt', 'relay', 'route', 'story']);
  assert.deepEqual([...new Set(modes)], modes, 'MODES values must be unique');
});
test('each product mode runs three times through a deterministic local fixture', async () => {
  const calls = [];
  const app = createAssistant({
    config: CONFIG,
    env: { TANGO_AI_MODEL_LIGHT: 'local-light', TANGO_AI_MODEL_STANDARD: 'local-standard' },
    fetch: async (url, options) => {
      calls.push({ url, payload: JSON.parse(options.body) });
      return openaiReply('local fixture response');
    }
  });

  for (const mode of PRODUCT_MODES) {
    for (let run = 0; run < 3; run += 1) {
      const result = await app.chat({ prompt: FIXTURES[mode], mode });
      assert.equal(result.content[0].text, 'local fixture response');
    }
  }

  assert.equal(calls.length, PRODUCT_MODES.length * 3);
  for (const mode of PRODUCT_MODES) {
    const modeCalls = calls.filter(({ payload }) => payload.messages.at(-1).content === FIXTURES[mode]);
    assert.equal(modeCalls.length, 3, mode + ' must run exactly three local fixture calls');
    assert.ok(modeCalls.every(({ url }) => url === CONFIG.url));
  }
  assert.ok(calls.every(({ payload }) => payload.max_tokens === 3000));
});

test('upstream failure is sanitized and parse fallback preserves the untouched rule item', async () => {
  const app = createAssistant({ config: CONFIG, env: {}, fetch: async () => new Response('upstream fixture failure', { status: 503 }) });
  await assert.rejects(app.chat({ prompt: 'hello', mode: 'chat' }), error => error.code === 'TANGO_AI_UPSTREAM_FAILED' && error.status === 502);

  const rule = { id: 'rule-1', title: '复盘会', kind: 'connect', prio: 3, date: '2026-10-22', start: '10:00', end: '11:00', at: true };
  const fallback = resolveParse('', '晚上10点复盘会', [rule], new Date(2026, 9, 22, 14, 5));
  assert.equal(fallback.source, 'rule');
  assert.equal(fallback.aiParsed, null);
  assert.deepEqual(fallback.item, rule);
  assert.equal(fallback.diff.fallback, true);
});

test('parse and prompt total budgets remain 8 seconds and 20 seconds', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = () => new Promise(() => {});
  const app = createAssistant({ config: CONFIG, env: {}, fetch: pending });
  const settle = promise => promise.then(() => 'ok', error => error.code);

  const parse = settle(app.chat({ prompt: FIXTURES.parse, mode: 'parse' }));
  t.mock.timers.tick(7999);
  await Promise.resolve();
  let parseCode;
  parse.then(value => { parseCode = value; });
  await Promise.resolve();
  assert.equal(parseCode, undefined);
  t.mock.timers.tick(1);
  assert.equal(await parse, 'TANGO_AI_TIMEOUT');

  const prompt = settle(app.chat({ prompt: FIXTURES.prompt, mode: 'prompt' }));
  t.mock.timers.tick(19999);
  await Promise.resolve();
  let promptCode;
  prompt.then(value => { promptCode = value; });
  await Promise.resolve();
  assert.equal(promptCode, undefined);
  t.mock.timers.tick(1);
  assert.equal(await prompt, 'TANGO_AI_TIMEOUT');
});

test('stream raw bytes and visible content caps reject oversized local fixtures', async () => {
  const rawFrames = [deltaFrame({ reasoning_content: 'r'.repeat(700) }), deltaFrame({ reasoning_content: 'r'.repeat(700) }), deltaFrame({ content: 'ok' }), doneFrame()];
  const byteApp = createAssistant({ config: CONFIG, env: {}, streamBytes: 1024, fetch: async () => sse(rawFrames) });
  await assert.rejects(collect(byteApp, { prompt: 'hello', mode: 'chat', stream: true }), error => error.code === 'TANGO_AI_RESPONSE_TOO_LARGE');

  const contentFrames = [deltaFrame({ content: '字'.repeat(10000) }), deltaFrame({ content: '字'.repeat(10000) }), deltaFrame({ content: '字'.repeat(5000) }), doneFrame()];
  const contentApp = createAssistant({ config: CONFIG, env: {}, fetch: async () => sse(contentFrames) });
  await assert.rejects(collect(contentApp, { prompt: 'hello', mode: 'chat', stream: true }), error => error.code === 'TANGO_AI_RESPONSE_INVALID');
});

test('visitor daily limit is enforced per demo visitor and resets by day', () => {
  let clock = new Date(2026, 9, 23, 9, 0).getTime();
  const guard = createAIGuard({ env: { TANGO_AI_VISITOR_DAILY_LIMIT: '2' }, now: () => clock });
  const req = ip => ({ socket: { remoteAddress: '127.0.0.1' }, headers: { 'x-forwarded-for': ip } });
  const demo = { id: 'demo-session', demo: true, role: 'user' };
  guard.check(req('203.0.113.20'), demo, 'chat');
  guard.check(req('203.0.113.20'), demo, 'chat');
  assert.throws(() => guard.check(req('203.0.113.20'), demo, 'chat'), error => error.code === 'TANGO_AI_VISITOR_DAILY_LIMIT' && error.status === 429);
  clock += 24 * 60 * 60 * 1000;
  guard.check(req('203.0.113.20'), demo, 'chat');
});

test('CN catalog exposes the five expected entries and complete verification metadata', () => {
  const source = readFileSync(new URL('../../web/model-catalog-cn.js', import.meta.url), 'utf8');
  const context = vm.createContext({ window: {} });
  vm.runInContext(source, context);
  const catalog = context.window.TangoModelCatalogCN;
  assert.ok(catalog);
  assert.deepEqual(Array.from(catalog.CN_MODEL_IDS), ['doubao-seed-2.1', 'deepseek-v4.1-flash', 'qwen3.8-max', 'kimi-k3', 'tencent-yuanbao']);
  assert.equal(catalog.CN_MODELS.length, 5);
  for (const entry of catalog.CN_MODELS) {
    assert.equal(entry.accessDate.length, 10);
    assert.ok(Number.isFinite(Date.parse(entry.accessDate)));
    assert.equal(typeof entry.verified, 'boolean');
    for (const key of ['vendor', 'displayName', 'descZh', 'appUrl', 'capabilityUrl', 'taskFit']) assert.ok(typeof entry[key] === 'string' && entry[key].trim());
  }
});

test('disabled parse and prompt modes reject before the local assistant is called', async t => {
  let calls = 0;
  const assistant = {
    configuration: () => ({}),
    chat: async () => { calls += 1; return { content: [{ type: 'text', text: 'local' }] }; },
    streamChat: async function* () { calls += 1; yield 'local'; }
  };
  const server = await startServer(t, { assistant, aiGuard: createAIGuard({ env: {} }) });
  const port = server.address().port;
  const headers = { Origin: 'http://127.0.0.1:' + port, 'Content-Type': 'application/json' };
  const parse = await httpCall(port, '/api/assistant/chat', { method: 'POST', headers, body: JSON.stringify({ prompt: FIXTURES.parse, mode: 'parse' }) });
  const prompt = await httpCall(port, '/api/assistant/chat', { method: 'POST', headers, body: JSON.stringify({ prompt: FIXTURES.prompt, mode: 'prompt' }) });
  assert.equal(parse.status, 400);
  assert.equal(parse.data.code, 'TANGO_AI_MODE_DISABLED');
  assert.equal(prompt.status, 400);
  assert.equal(prompt.data.code, 'TANGO_AI_MODE_DISABLED');
  assert.equal(calls, 0);
});
