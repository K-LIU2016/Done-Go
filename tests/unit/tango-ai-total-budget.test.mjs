import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAssistant } from '../../scripts/ai-assistant.mjs';

// D21: parse and prompt budgets are TOTAL-duration caps counted from the start
// of the request, not idle budgets that reasoning deltas keep rearming. parse
// = 8000ms (the tidy diff flow with its rule-result fallback), prompt =
// 20000ms. Explicit timeoutMs / TANGO_AI_TIMEOUT_MS keep overriding both,
// legacy modes keep the 25s/120s totals plus the 300s stream floor, and the
// timeout error semantics stay TANGO_AI_TIMEOUT / 504 with the same fallback
// behaviour on the client.

const config = { provider: 'openai', url: 'https://api.example.com/v1/chat/completions', model: 'auto', key: 'synthetic-test-key' };
const openaiReply = text => new Response(JSON.stringify({ choices: [{ message: { content: text } }] }));
const encoder = new TextEncoder();
const frame = payload => encoder.encode('data: ' + JSON.stringify(payload) + '\n\n');
const reasoning = size => frame({ choices: [{ delta: { reasoning_content: 'r'.repeat(size) } }] });
const answer = () => frame({ choices: [{ delta: { content: '好' } }] });
const done = () => encoder.encode('data: [DONE]\n\n');
const settle = promise => promise.then(value => ({ ok: true, value }), error => ({ ok: false, code: error.code, status: error.status }));
const drain = () => new Promise(resolve => setImmediate(resolve));

test('non-streaming parse keeps flying past 6.5s and times out at the 8s total cap', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const app = createAssistant({ config, env: {}, fetch: () => new Promise(() => {}) });
  const call = settle(app.chat({ prompt: '晚上10点整理实验数据', mode: 'parse' }));
  await t.mock.timers.tick(6500);
  let early; call.then(outcome => { early = outcome; });
  await drain();
  assert.equal(early, undefined, 'the old 6s budget must be gone: parse is still in flight at 6.5s');
  await t.mock.timers.tick(1500);
  const outcome = await call;
  assert.equal(outcome.ok, false);
  assert.equal(outcome.code, 'TANGO_AI_TIMEOUT');
  assert.equal(outcome.status, 504);
});

test('non-streaming prompt times out at the 20s total cap even when the upstream finally answers', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let release; const gate = new Promise(resolve => { release = resolve; });
  const app = createAssistant({ config, env: {}, fetch: () => gate.then(() => openaiReply('迟到的回复')) });
  const call = settle(app.chat({ prompt: 'USER_REQUEST_JSON\n{"userRequest":{"title":"写周报"}}', mode: 'prompt' }));
  await t.mock.timers.tick(20000);
  release();
  const outcome = await call;
  assert.equal(outcome.ok, false);
  assert.equal(outcome.code, 'TANGO_AI_TIMEOUT');
  assert.equal(outcome.status, 504);
});

test('parse streaming hits the 8s total wall even while reasoning bytes keep flowing', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  let controller;
  const stream = new ReadableStream({ start(c) { controller = c; c.enqueue(reasoning(1024)); } });
  const app = createAssistant({ config, env: {}, fetch: async () => new Response(stream) });
  const call = settle((async () => { const out = []; for await (const chunk of app.streamChat({ prompt: '晚上10点整理实验数据', mode: 'parse', stream: true })) out.push(chunk); return out.join(''); })());
  await drain();
  for (let i = 0; i < 8; i += 1) {
    t.mock.timers.tick(1000);
    controller.enqueue(reasoning(1024));
    await drain();
  }
  // The 8s wall usually trips on the last loop read and cancels the reader, so
  // the farewell frames may land in an already-closed stream.
  try { controller.enqueue(answer()); controller.enqueue(done()); controller.close(); } catch {}
  const outcome = await call;
  assert.equal(outcome.ok, false);
  assert.equal(outcome.code, 'TANGO_AI_TIMEOUT');
  assert.equal(outcome.status, 504);
});

test('prompt streaming hits the 20s total wall even while reasoning bytes keep flowing', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  let controller;
  const stream = new ReadableStream({ start(c) { controller = c; c.enqueue(reasoning(1024)); } });
  const app = createAssistant({ config, env: {}, fetch: async () => new Response(stream) });
  const call = settle((async () => { const out = []; for await (const chunk of app.streamChat({ prompt: 'USER_REQUEST_JSON\n{"userRequest":{"title":"写周报"}}', mode: 'prompt', stream: true })) out.push(chunk); return out.join(''); })());
  await drain();
  for (let i = 0; i < 10; i += 1) {
    t.mock.timers.tick(2000);
    controller.enqueue(reasoning(1024));
    await drain();
  }
  try { controller.enqueue(answer()); controller.enqueue(done()); controller.close(); } catch {}
  const outcome = await call;
  assert.equal(outcome.ok, false);
  assert.equal(outcome.code, 'TANGO_AI_TIMEOUT');
  assert.equal(outcome.status, 504);
});

test('legacy chat streaming keeps running past 25s while bytes flow (300s floor unchanged)', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  let controller;
  const stream = new ReadableStream({ start(c) { controller = c; c.enqueue(answer()); } });
  const app = createAssistant({ config, env: {}, fetch: async () => new Response(stream) });
  const call = settle((async () => { const out = []; for await (const chunk of app.streamChat({ prompt: 'hello', mode: 'chat', stream: true })) out.push(chunk); return out.join(''); })());
  await drain();
  for (let i = 0; i < 13; i += 1) {
    t.mock.timers.tick(20000);
    controller.enqueue(reasoning(1024));
    await drain();
  }
  controller.enqueue(done());
  controller.close();
  const outcome = await call;
  assert.equal(outcome.ok, true);
  assert.equal(outcome.value, '好');
});

test('TANGO_AI_TIMEOUT_MS and explicit timeoutMs still override the capped totals', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = () => new Promise(() => {});
  const fromEnv = createAssistant({ config, env: { TANGO_AI_TIMEOUT_MS: '15000' }, fetch: pending });
  const parse = settle(fromEnv.chat({ prompt: '晚上10点整理实验数据', mode: 'parse' }));
  await t.mock.timers.tick(8000);
  let early; parse.then(outcome => { early = outcome; });
  await drain();
  assert.equal(early, undefined, 'the env override must beat the 8s parse default');
  await t.mock.timers.tick(7000);
  assert.equal((await parse).code, 'TANGO_AI_TIMEOUT');
  const explicit = createAssistant({ config, timeoutMs: 12000, env: {}, fetch: pending });
  const prompt = settle(explicit.chat({ prompt: 'USER_REQUEST_JSON\n{"userRequest":{"title":"写周报"}}', mode: 'prompt' }));
  await t.mock.timers.tick(8000);
  let earlyPrompt; prompt.then(outcome => { earlyPrompt = outcome; });
  await drain();
  assert.equal(earlyPrompt, undefined, 'the explicit timeoutMs must beat the 20s prompt default');
  await t.mock.timers.tick(4000);
  assert.equal((await prompt).code, 'TANGO_AI_TIMEOUT');
});
