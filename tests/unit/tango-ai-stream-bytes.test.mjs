import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAssistant } from '../../scripts/ai-assistant.mjs';

const config = { provider: 'openai', url: 'https://api.example.com/v1/chat/completions', model: 'test-model', key: 'private-key' };
const encoder = new TextEncoder();
const frame = payload => encoder.encode('data: ' + JSON.stringify(payload) + '\n\n');
const reasoning = size => frame({ choices: [{ delta: { reasoning_content: 'r'.repeat(size) } }] });
const answer = () => frame({ choices: [{ delta: { content: '一二三四五六七八九十' } }] });
const done = () => encoder.encode('data: [DONE]\n\n');
const collect = app => (async () => { const out = []; for await (const chunk of app.streamChat({ prompt: 'hello', mode: 'chat', stream: true })) out.push(chunk); return out.join(''); })();
const sseResponse = frames => { let bytes = 0; const stream = new ReadableStream({ start(controller) { for (const chunk of frames) { bytes += chunk.byteLength; controller.enqueue(chunk); } controller.close(); } }); return { response: new Response(stream), bytes }; };

test('long reasoning deltas before a short answer stream through instead of tripping the size guard', async () => {
  const frames = [];
  for (let i = 0; i < 400; i += 1) frames.push(reasoning(1024));
  frames.push(answer(), done());
  const { response, bytes } = sseResponse(frames);
  assert.ok(bytes >= 300 * 1024, `expected >=300KB of raw SSE, got ${bytes}`);
  const app = createAssistant({ config, env: {}, fetch: async () => response });
  assert.equal(await collect(app), '一二三四五六七八九十');
});

test('stream parser accepts CR-only multi-line data events before a short answer', async () => {
  const payload = [
    'data: {"choices":[\r',
    'data: {"delta":{"content":"一"}}\r',
    'data: ]}\r',
    '\r',
    'data: [DONE]\r',
    '\r'
  ].join('');
  const stream = new ReadableStream({ start(controller) { controller.enqueue(encoder.encode(payload)); controller.close(); } });
  const app = createAssistant({ config, env: {}, fetch: async () => new Response(stream) });
  assert.equal(await collect(app), '一');
});

test('raw SSE bytes beyond the configured cap still fail with TANGO_AI_RESPONSE_TOO_LARGE', async () => {
  const frames = [];
  for (let i = 0; i < 16; i += 1) frames.push(reasoning(1024));
  frames.push(answer(), done());
  const { response, bytes } = sseResponse(frames);
  assert.ok(bytes > 8192 && bytes < 192 * 1024, `expected >8KB and <192KB, got ${bytes}`);
  const app = createAssistant({ config, env: { TANGO_AI_STREAM_MAX_BYTES: '8192' }, fetch: async () => response });
  await assert.rejects(collect(app), error => error.code === 'TANGO_AI_RESPONSE_TOO_LARGE');
});

test('the default raw-byte ceiling stays bounded at 4 MiB', async () => {
  const frames = [];
  for (let i = 0; i < 4200; i += 1) frames.push(reasoning(1024));
  frames.push(answer(), done());
  const { response, bytes } = sseResponse(frames);
  assert.ok(bytes > 4 * 1024 * 1024, `expected >4MiB of raw SSE, got ${bytes}`);
  const app = createAssistant({ config, env: {}, fetch: async () => response });
  await assert.rejects(collect(app), error => error.code === 'TANGO_AI_RESPONSE_TOO_LARGE');
});

test('invalid TANGO_AI_STREAM_MAX_BYTES values keep the lenient default', async () => {
  for (const value of ['not-a-number', '0', '-1048576', '4194304.5', '']) {
    const frames = [];
    for (let i = 0; i < 400; i += 1) frames.push(reasoning(1024));
    frames.push(answer(), done());
    const { response, bytes } = sseResponse(frames);
    assert.ok(bytes >= 300 * 1024 && bytes < 4 * 1024 * 1024);
    const app = createAssistant({ config, env: { TANGO_AI_STREAM_MAX_BYTES: value }, fetch: async () => response });
    assert.equal(await collect(app), '一二三四五六七八九十');
  }
});

test('the 24000-character visible-output cap is unchanged and rejects oversized content', async () => {
  const frames = [];
  for (let i = 0; i < 3; i += 1) frames.push(frame({ choices: [{ delta: { content: '字'.repeat(10000) } }] }));
  frames.push(done());
  const { response, bytes } = sseResponse(frames);
  assert.ok(bytes < 4 * 1024 * 1024);
  const app = createAssistant({ config, env: {}, fetch: async () => response });
  await assert.rejects(collect(app), error => error.code === 'TANGO_AI_RESPONSE_INVALID');
});
