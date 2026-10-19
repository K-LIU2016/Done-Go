import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { createAssistant } from '../../scripts/ai-assistant.mjs';

const config = { provider: 'openai', url: 'https://api.example.com/v1/chat/completions', model: 'test-model', key: 'private-key' };
test('provider configuration reveals only safe fixed destination metadata', () => {
  assert.deepEqual(createAssistant({ config }).configuration(), { available: true, provider: 'openai', model: 'test-model', destination: config.url });
  assert.equal(JSON.stringify(createAssistant({ config }).configuration()).includes('private-key'), false);
  for (const url of ['https://user:pass@example.com/token?key=secret', 'http://private.example/v1', 'https://example.com/v1?secret=key']) assert.equal(createAssistant({ config: { ...config, url } }).configuration().available, false);
  assert.equal(createAssistant({ config: { ...config, url: 'https://example.com/private-key/chat' } }).configuration().available, false);
  assert.equal(createAssistant({ config: {} }).configuration().available, false);
});
test('both provider protocols carry advisory system constraints and reject caller targets', async () => {
  for (const provider of ['openai', 'anthropic']) {
    let sent;
    const app = createAssistant({ config: { ...config, provider }, fetch: async (url, options) => {
      sent = { url, options };
      return new Response(JSON.stringify(provider === 'openai' ? { choices: [{ message: { content: '仅建议' } }] } : { content: [{ type: 'text', text: '仅建议' }] }));
    } });
    assert.deepEqual(await app.chat({ prompt: '帮我分类' }), { content: [{ type: 'text', text: '仅建议' }] });
    assert.equal(sent.url, config.url); assert.equal(sent.options.redirect, 'error');
    assert.equal(provider === 'openai' ? sent.options.headers.Authorization : sent.options.headers['x-api-key'], provider === 'openai' ? 'Bearer private-key' : 'private-key');
    const payload = JSON.parse(sent.options.body), system = provider === 'openai' ? payload.messages[0].content : payload.system;
    assert.match(system, /建议/); assert.match(system, /因果/); assert.equal(payload.messages.at(-1).content, '帮我分类');
    assert.equal(payload.max_tokens, 3000);
    for (const input of [{ prompt: 'test', url: 'https://evil.example' }, { prompt: 'test', key: 'other' }, { prompt: '' }, { prompt: 'x'.repeat(60001) }, { prompt: '中'.repeat(62000) }, []]) await assert.rejects(app.chat(input), e => e.code === 'TANGO_AI_INPUT_INVALID');
  }
});

test('a Chinese conversation at the new character boundary reaches the provider without truncation', async () => {
  const prompt = '中'.repeat(60000); let received;
  const app = createAssistant({ config, fetch: async (_url, options) => {
    received = JSON.parse(options.body).messages.at(-1).content;
    return new Response('{"choices":[{"message":{"content":"accepted"}}]}');
  } });
  assert.equal(Buffer.byteLength(prompt), 180000);
  assert.equal((await app.chat({ prompt })).content[0].text, 'accepted');
  assert.equal(received, prompt);
});
test('provider errors and oversized or empty responses are sanitized and exact key echoes are redacted', async () => {
  for (const response of [new Response('private-key', { status: 401 }), new Response('{}'), new Response('x'.repeat(200))]) {
    await assert.rejects(createAssistant({ config, responseBytes: 100, fetch: async () => response }).chat({ prompt: 'hello' }), e => e.code.startsWith('TANGO_AI_') && !e.message.includes('private-key'));
  }
  const result = await createAssistant({ config, fetch: async () => new Response(JSON.stringify({ choices: [{ message: { content: 'echo private-key' } }] })) }).chat({ prompt: 'hello' });
  assert.equal(JSON.stringify(result).includes('private-key'), false);
});
test('provider timeouts and caller cancellation stop pending upstream calls', async () => {
  let aborted = false;
  const app = createAssistant({ config, timeoutMs: 15, fetch: async (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => { aborted = true; reject(signal.reason); }, { once: true });
  }) });
  await assert.rejects(app.chat({ prompt: 'hello' }), e => e.code === 'TANGO_AI_TIMEOUT'); assert.equal(aborted, true);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(createAssistant({ config }).chat({ prompt: 'hello' }, controller.signal), e => e.code === 'TANGO_AI_ABORTED');
});

test('provider streamed bodies are bounded and the connection concurrency limit is enforced', async () => {
  const streamed = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(101)); } });
  await assert.rejects(createAssistant({ config, responseBytes: 100, fetch: async () => new Response(streamed) }).chat({ prompt: 'hello' }), error => error.code === 'TANGO_AI_RESPONSE_TOO_LARGE');
  let finish;
  const gate = new Promise(resolve => { finish = resolve; });
  const app = createAssistant({ config, fetch: async () => { await gate; return new Response('{"choices":[{"message":{"content":"done"}}]}'); } });
  const first = app.chat({ prompt: 'one' }), second = app.chat({ prompt: 'two' });
  await assert.rejects(app.chat({ prompt: 'three' }), error => error.code === 'TANGO_AI_BUSY');
  finish(); await Promise.all([first, second]);
});

test('provider timeout also cancels a stalled response body', async () => {
  let cancelled = false;
  const body = new ReadableStream({ pull() {}, cancel() { cancelled = true; } });
  await assert.rejects(createAssistant({ config, timeoutMs: 10, fetch: async () => new Response(body) }).chat({ prompt: 'hello' }), error => error.code === 'TANGO_AI_TIMEOUT');
  assert.equal(cancelled, true);
});

test('optional OpenAI reasoning effort is exact metadata and wire configuration without changing legacy payloads', async () => {
  for (const reasoningEffort of [undefined, 'low', 'medium', 'high', 'xhigh']) {
    let payload;
    const selected = { ...config, model: 'gpt-6.1-sol', ...(reasoningEffort === undefined ? {} : { reasoningEffort }) };
    const app = createAssistant({ config: selected, fetch: async (_url, options) => {
      payload = JSON.parse(options.body);
      return new Response('{"choices":[{"message":{"content":"advisory response"}}]}');
    } });
    const metadata = app.configuration();
    assert.deepEqual(metadata, { available: true, provider: 'openai', model: 'gpt-6.1-sol', destination: config.url, ...(reasoningEffort === undefined ? {} : { reasoningEffort }) });
    await app.chat({ prompt: 'hello' });
    assert.equal(payload.model, 'gpt-6.1-sol');
    if (reasoningEffort === undefined) assert.equal(Object.prototype.hasOwnProperty.call(payload, 'reasoning_effort'), false);
    else assert.equal(payload.reasoning_effort, reasoningEffort);
    assert.equal(JSON.stringify(metadata).includes(config.key), false);
  }
});

test('invalid effort or any Anthropic effort fails closed before an upstream request', async () => {
  let requests = 0;
  const invalid = ['', 'XHIGH', 'extra High', 'none', null, false, 1, {}, ['xhigh']].map(reasoningEffort => ({ ...config, reasoningEffort }));
  invalid.push(...['low', 'medium', 'high', 'xhigh'].map(reasoningEffort => ({ ...config, provider: 'anthropic', reasoningEffort })));
  for (const selected of invalid) {
    const app = createAssistant({ config: selected, fetch: async () => { requests++; throw new Error('must not send'); } });
    assert.deepEqual(app.configuration(), { available: false, provider: null, model: null, destination: null });
    await assert.rejects(app.chat({ prompt: 'hello' }), error => error.code === 'TANGO_AI_NOT_CONFIGURED');
  }
  assert.equal(requests, 0);
});

test('the environment maps xhigh to the selected model and omits credentials from public metadata', () => {
  const moduleUrl = new URL('../../scripts/ai-assistant.mjs', import.meta.url).href;
  const source = `import { createAssistant } from ${JSON.stringify(moduleUrl)};
    let payload;
    const app = createAssistant({ fetch: async (_url, options) => { payload = JSON.parse(options.body); return new Response('{"choices":[{"message":{"content":"ok"}}]}'); } });
    await app.chat({ prompt: 'synthetic input' });
    console.log(JSON.stringify({ metadata: app.configuration(), payload }));`;
  // Use a clean synthetic environment; do not read or inherit the user's configured credentials.
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], { encoding: 'utf8', env: { TANGO_AI_PROVIDER: 'openai', TANGO_AI_URL: config.url, TANGO_AI_MODEL: 'gpt-6.1-sol', TANGO_AI_KEY: 'synthetic-test-key', TANGO_AI_REASONING_EFFORT: 'xhigh' } });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.metadata.reasoningEffort, 'xhigh');
  assert.equal(output.metadata.model, 'gpt-6.1-sol');
  assert.equal(output.payload.reasoning_effort, 'xhigh');
  assert.equal(output.payload.model, 'gpt-6.1-sol');
  assert.equal(result.stdout.includes('synthetic-test-key'), false);
});

test('xhigh has a 120 second default budget, ordinary modes keep 25 seconds, and explicit short test timeouts win', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const aborted = [];
  const pendingFetch = label => async (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => { aborted.push(label); reject(signal.reason); }, { once: true });
  });
  const ordinary = createAssistant({ config, fetch: pendingFetch('ordinary') }).chat({ prompt: 'hello' }).catch(error => error.code);
  const high = createAssistant({ config: { ...config, reasoningEffort: 'high' }, fetch: pendingFetch('high') }).chat({ prompt: 'hello' }).catch(error => error.code);
  let extendedCode;
  const extended = createAssistant({ config: { ...config, reasoningEffort: 'xhigh' }, fetch: pendingFetch('xhigh') }).chat({ prompt: 'hello' }).catch(error => { extendedCode = error.code; return error.code; });
  t.mock.timers.tick(25000);
  assert.equal(await ordinary, 'TANGO_AI_TIMEOUT');
  assert.equal(await high, 'TANGO_AI_TIMEOUT');
  assert.equal(extendedCode, undefined);
  t.mock.timers.tick(94999);
  await Promise.resolve();
  assert.equal(extendedCode, undefined);
  t.mock.timers.tick(1);
  assert.equal(await extended, 'TANGO_AI_TIMEOUT');
  const short = createAssistant({ config: { ...config, reasoningEffort: 'xhigh' }, timeoutMs: 7, fetch: pendingFetch('short') }).chat({ prompt: 'hello' }).catch(error => error.code);
  t.mock.timers.tick(7);
  assert.equal(await short, 'TANGO_AI_TIMEOUT');
  assert.deepEqual(aborted, ['ordinary', 'high', 'xhigh', 'short']);
});

test('mode tiers route models per tier and reasoning effort applies only to heavy', async () => {
  const payloads = [];
  const app = createAssistant({ config: { ...config, reasoningEffort: 'xhigh' }, env: { TANGO_AI_MODEL_STANDARD: 'standard-fixture', TANGO_AI_MODEL_LIGHT: 'light-fixture' }, fetch: async (_url, options) => {
    payloads.push(JSON.parse(options.body));
    return new Response('{"choices":[{"message":{"content":"ok"}}]}');
  } });
  assert.deepEqual(app.configuration().models, { heavy: 'test-model', standard: 'standard-fixture', light: 'light-fixture' });
  await app.chat({ prompt: 'hello', mode: 'chat' });
  await app.chat({ prompt: 'hello', mode: 'priorities' });
  await app.chat({ prompt: 'hello', mode: 'test' });
  assert.deepEqual(payloads.map(payload => payload.model), ['test-model', 'standard-fixture', 'light-fixture']);
  assert.deepEqual(payloads.map(payload => payload.reasoning_effort), ['xhigh', undefined, undefined]);
});

test('configuration omits models until tier overrides exist', () => {
  assert.equal('models' in createAssistant({ config, env: {} }).configuration(), false);
  assert.deepEqual(createAssistant({ config: { ...config, models: { heavy: 'a-model', standard: 'b-model', light: 'c-model' } } }).configuration().models, { heavy: 'a-model', standard: 'b-model', light: 'c-model' });
});

test('streamChat emits redacted SSE deltas and validates streaming input', async () => {
  let payload;
  const stream = new ReadableStream({ start(controller) {
    for (const chunk of ['你', '好用 private-key', '吗']) controller.enqueue(new TextEncoder().encode('data: ' + JSON.stringify({ choices: [{ delta: { content: chunk } }] }) + '\n\n'));
    controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
    controller.close();
  } });
  const app = createAssistant({ config, fetch: async (_url, options) => { payload = JSON.parse(options.body); return new Response(stream); } });
  const out = [];
  for await (const chunk of app.streamChat({ prompt: 'hello', mode: 'chat', stream: true })) out.push(chunk);
  assert.deepEqual(out, ['你', '好用 [redacted]', '吗']);
  assert.equal(payload.stream, true);
  for (const input of [{ prompt: '' }, { prompt: 'x', mode: 'nope' }, { prompt: 'x', stream: 'yes' }, { prompt: 'x', extra: 1 }]) await assert.rejects(async () => { for await (const chunk of app.streamChat(input)) chunk; }, error => error.code === 'TANGO_AI_INPUT_INVALID');
});

test('streamChat rejects empty streams and falls back to one-shot Anthropic responses', async () => {
  const empty = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n')); controller.close(); } });
  await assert.rejects(async () => { for await (const chunk of createAssistant({ config, fetch: async () => new Response(empty) }).streamChat({ prompt: 'hello' })) chunk; }, error => error.code === 'TANGO_AI_RESPONSE_INVALID');
  const app = createAssistant({ config: { provider: 'anthropic', url: config.url, model: 'test-model', key: 'private-key' }, fetch: async () => new Response(JSON.stringify({ content: [{ type: 'text', text: '一条回答' }] })) });
  const out = [];
  for await (const chunk of app.streamChat({ prompt: 'hello' })) out.push(chunk);
  assert.deepEqual(out, ['一条回答']);
});
