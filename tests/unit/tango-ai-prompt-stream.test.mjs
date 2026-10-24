import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAssistant } from '../../scripts/ai-assistant.mjs';

// D22: the R1.1 streaming size fix must cover prompt mode too. The raw SSE
// byte guard (default 4 MiB, TANGO_AI_STREAM_MAX_BYTES override) and the
// 24000-character visible cap apply to every streaming mode, so hundreds of
// KB of reasoning_content deltas before a short prompt body plus [DONE] must
// stream through instead of failing with ai-response-too-large.

const config = { provider: 'openai', url: 'https://api.example.com/v1/chat/completions', model: 'auto', key: 'synthetic-test-key' };
const encoder = new TextEncoder();
const frame = payload => encoder.encode('data: ' + JSON.stringify(payload) + '\n\n');
const reasoning = size => frame({ choices: [{ delta: { reasoning_content: 'r'.repeat(size) } }] });
const answer = text => frame({ choices: [{ delta: { content: text } }] });
const done = () => encoder.encode('data: [DONE]\n\n');
const inputs = { prompt: 'USER_REQUEST_JSON\n{"userRequest":{"title":"写周报"}}', parse: '<user_input>晚上10点整理实验数据</user_input>' };
const collect = (app, mode) => (async () => { const out = []; for await (const chunk of app.streamChat({ prompt: inputs[mode], mode, stream: true })) out.push(chunk); return out.join(''); })();
const sseResponse = frames => { let bytes = 0; const stream = new ReadableStream({ start(controller) { for (const chunk of frames) { bytes += chunk.byteLength; controller.enqueue(chunk); } controller.close(); } }); return { response: new Response(stream), bytes }; };

test('prompt mode: ≥300KB of reasoning deltas before a short body plus [DONE] must succeed', async () => {
  const frames = [];
  for (let i = 0; i < 400; i += 1) frames.push(reasoning(1024));
  frames.push(answer('三步提示词正文'), done());
  const { response, bytes } = sseResponse(frames);
  assert.ok(bytes >= 300 * 1024, 'expected >=300KB of raw SSE, got ' + bytes);
  const app = createAssistant({ config, env: {}, fetch: async () => response });
  assert.equal(await collect(app, 'prompt'), '三步提示词正文');
});

test('prompt mode: raw SSE bytes beyond TANGO_AI_STREAM_MAX_BYTES still fail TOO_LARGE', async () => {
  const frames = [];
  for (let i = 0; i < 16; i += 1) frames.push(reasoning(1024));
  frames.push(answer('正文'), done());
  const { response, bytes } = sseResponse(frames);
  assert.ok(bytes > 8192 && bytes < 192 * 1024, 'expected >8KB and <192KB, got ' + bytes);
  const app = createAssistant({ config, env: { TANGO_AI_STREAM_MAX_BYTES: '8192' }, fetch: async () => response });
  await assert.rejects(collect(app, 'prompt'), error => error.code === 'TANGO_AI_RESPONSE_TOO_LARGE');
});

test('prompt mode: the 24000-character visible cap still rejects oversized bodies', async () => {
  const frames = [];
  for (let i = 0; i < 3; i += 1) frames.push(answer('字'.repeat(10000)));
  frames.push(done());
  const { response, bytes } = sseResponse(frames);
  assert.ok(bytes < 4 * 1024 * 1024);
  const app = createAssistant({ config, env: {}, fetch: async () => response });
  await assert.rejects(collect(app, 'prompt'), error => error.code === 'TANGO_AI_RESPONSE_INVALID');
});

test('parse mode: the 24000-character visible cap applies as well', async () => {
  const frames = [];
  for (let i = 0; i < 3; i += 1) frames.push(answer('字'.repeat(10000)));
  frames.push(done());
  const { response, bytes } = sseResponse(frames);
  assert.ok(bytes < 4 * 1024 * 1024);
  const app = createAssistant({ config, env: {}, fetch: async () => response });
  await assert.rejects(collect(app, 'parse'), error => error.code === 'TANGO_AI_RESPONSE_INVALID');
});
