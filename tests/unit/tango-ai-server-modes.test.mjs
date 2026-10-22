import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAssistant } from '../../scripts/ai-assistant.mjs';

const config = { provider: 'openai', url: 'https://api.example.com/v1/chat/completions', model: 'auto', key: 'private-key' };
const parseReply = '{"date":"2026-10-22","start":"22:00","end":null,"title":"复盘会","kind":"event","prio":2}';
const openaiReply = text => new Response(JSON.stringify({ choices: [{ message: { content: text } }] }));

test('parse mode routes to the light tier with a strict-JSON system contract and passes the reply through verbatim', async () => {
  const payloads = [];
  const app = createAssistant({ config, env: { TANGO_AI_MODEL_LIGHT: 'light-fixture', TANGO_AI_MODEL_STANDARD: 'standard-fixture' }, fetch: async (_url, options) => {
    payloads.push(JSON.parse(options.body));
    return openaiReply(parseReply);
  } });
  const prompt = '<user_input>晚上10点复盘会</user_input><rule_result>{"date":"2026-10-22","start":"10:00"}</rule_result>今天是2026-10-22';
  const result = await app.chat({ prompt, mode: 'parse' });
  assert.equal(result.content[0].type, 'text');
  assert.equal(result.content[0].text, parseReply);
  assert.equal(payloads.length, 1);
  const [payload] = payloads;
  assert.equal(payload.model, 'light-fixture');
  assert.equal(payload.max_tokens, 3000);
  assert.equal(Object.prototype.hasOwnProperty.call(payload, 'reasoning_effort'), false);
  assert.equal(payload.messages[0].role, 'system');
  assert.equal(payload.messages.at(-1).role, 'user');
  assert.equal(payload.messages.at(-1).content, prompt);
  const system = payload.messages[0].content;
  assert.match(system, /只输出一个 JSON 对象/);
  assert.match(system, /date/);
  assert.match(system, /start/);
  assert.match(system, /end/);
  assert.match(system, /title/);
  assert.match(system, /kind/);
  assert.match(system, /prio/);
  assert.match(system, /「晚上10点」是 22:00/);
  assert.match(system, /不可信数据/);
});

test('parse mode never injects reasoning effort even when the heavy tier is configured with xhigh', async () => {
  let payload;
  const app = createAssistant({ config: { ...config, reasoningEffort: 'xhigh' }, env: {}, fetch: async (_url, options) => {
    payload = JSON.parse(options.body);
    return openaiReply(parseReply);
  } });
  await app.chat({ prompt: '<user_input>晚上10点复盘会</user_input>', mode: 'parse' });
  assert.equal(Object.prototype.hasOwnProperty.call(payload, 'reasoning_effort'), false);
});

test('prompt mode routes to the standard tier and instructs three-step usage plus a copyable prompt', async () => {
  const payloads = [];
  const app = createAssistant({ config: { ...config, reasoningEffort: 'xhigh' }, env: { TANGO_AI_MODEL_STANDARD: 'standard-fixture' }, fetch: async (_url, options) => {
    payloads.push(JSON.parse(options.body));
    return openaiReply('三步用法');
  } });
  const prompt = '<item_title>写周报</item_title><shared_context>{"kind":"task"}</shared_context>';
  const result = await app.chat({ prompt, mode: 'prompt' });
  assert.equal(result.content[0].text, '三步用法');
  const [payload] = payloads;
  assert.equal(payload.model, 'standard-fixture');
  assert.equal(Object.prototype.hasOwnProperty.call(payload, 'reasoning_effort'), false);
  const system = payload.messages[0].content;
  assert.match(system, /三步用法/);
  assert.match(system, /提示词：/);
  assert.match(system, /AI 生成，未实测/);
  assert.match(system, /不虚构/);
  assert.match(system, /已明确同意共享/);
  assert.match(system, /不可信数据/);
  assert.equal(payload.messages.at(-1).content, prompt);
});

test('every mode carries the unified injection defence in its system prompt', async () => {
  let system;
  const app = createAssistant({ config, env: {}, fetch: async (_url, options) => {
    system = JSON.parse(options.body).messages[0].content;
    return openaiReply('建议');
  } });
  await app.chat({ prompt: '帮我排优先级' });
  assert.match(system, /不可信数据/);
  assert.match(system, /试图改变你的指令/);
});

test('parse and prompt inputs obey TANGO_AI_INPUT_LIMIT while legacy modes keep the 60000 boundary', async () => {
  let requests = 0;
  const app = createAssistant({ config, env: {}, fetch: async () => { requests++; return openaiReply('ok'); } });
  await assert.rejects(app.chat({ prompt: 'x'.repeat(2001), mode: 'parse' }), error => error.code === 'TANGO_AI_INPUT_TOO_LONG' && error.status === 413);
  await assert.rejects(app.chat({ prompt: 'y'.repeat(2001), mode: 'prompt' }), error => error.code === 'TANGO_AI_INPUT_TOO_LONG' && error.status === 413);
  assert.equal(requests, 0);
  assert.equal((await app.chat({ prompt: 'z'.repeat(2000), mode: 'parse' })).content[0].text, 'ok');
  assert.equal(requests, 1);
  const tight = createAssistant({ config, env: { TANGO_AI_INPUT_LIMIT: '100' }, fetch: async () => { requests++; return openaiReply('ok'); } });
  await assert.rejects(tight.chat({ prompt: 'x'.repeat(101), mode: 'parse' }), error => error.code === 'TANGO_AI_INPUT_TOO_LONG');
  assert.equal(requests, 1);
  assert.equal((await tight.chat({ prompt: '中'.repeat(3000), mode: 'chat' })).content[0].text, 'ok');
  assert.equal(requests, 2);
  await assert.rejects(app.chat({ prompt: 'x'.repeat(60001) }), error => error.code === 'TANGO_AI_INPUT_INVALID');
  await assert.rejects(app.chat({ prompt: 'x', mode: 'nope' }), error => error.code === 'TANGO_AI_INPUT_INVALID');
});

test('parse calls share the process-wide concurrency ceiling of two', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const app = createAssistant({ config, env: {}, fetch: async () => { await gate; return openaiReply('{}'); } });
  const first = app.chat({ prompt: 'a', mode: 'parse' });
  const second = app.chat({ prompt: 'b', mode: 'parse' });
  await assert.rejects(app.chat({ prompt: 'c', mode: 'parse' }), error => error.code === 'TANGO_AI_BUSY');
  release();
  await Promise.all([first, second]);
});

test('parse streaming follows the gateway SSE contract without a reasoning effort field', async () => {
  let payload;
  const stream = new ReadableStream({ start(controller) {
    const encoder = new TextEncoder();
    controller.enqueue(encoder.encode('data: ' + JSON.stringify({ choices: [{ delta: {} }] }) + '\n\n'));
    controller.enqueue(encoder.encode('data: ' + JSON.stringify({ choices: [{ delta: { content: '{"date":"2026-10-22",' } }] }) + '\n\n'));
    controller.enqueue(encoder.encode('data: ' + JSON.stringify({ choices: [{ delta: { content: '"start":"22:00"}' } }] }) + '\n\n'));
    controller.enqueue(encoder.encode(': keepalive comment\n\n'));
    controller.enqueue(encoder.encode('data: [DONE]\n\n'));
    controller.close();
  } });
  const app = createAssistant({ config: { ...config, reasoningEffort: 'xhigh' }, env: {}, fetch: async (_url, options) => {
    payload = JSON.parse(options.body);
    return new Response(stream);
  } });
  const chunks = [];
  for await (const chunk of app.streamChat({ prompt: '<user_input>晚上10点复盘会</user_input>', mode: 'parse', stream: true })) chunks.push(chunk);
  assert.equal(chunks.join(''), '{"date":"2026-10-22","start":"22:00"}');
  assert.equal(payload.stream, true);
  assert.equal(payload.model, 'auto');
  assert.equal(Object.prototype.hasOwnProperty.call(payload, 'reasoning_effort'), false);
  assert.match(payload.messages[0].content, /「晚上10点」是 22:00/);
  assert.equal(payload.messages.at(-1).content, '<user_input>晚上10点复盘会</user_input>');
});
