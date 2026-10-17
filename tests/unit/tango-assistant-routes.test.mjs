import assert from 'node:assert/strict';
import { test } from 'node:test';
import { request } from 'node:http';
import { createTangoServer } from '../../scripts/serve-tango.mjs';
import { createAssistant } from '../../scripts/ai-assistant.mjs';

function call(port, path, { method = 'GET', body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method, headers }, res => {
      let text = ''; res.setEncoding('utf8'); res.on('data', part => { text += part; });
      res.on('end', () => resolve({ status: res.statusCode, text, data: text ? JSON.parse(text) : null }));
    }); req.on('error', reject); req.end(body);
  });
}

test('assistant routes guard fixed local origins, methods, JSON and byte limits before upstream calls', async t => {
  let calls = 0;
  const server = createTangoServer({ assistant: { configuration: () => ({ available: false, provider: null, model: null, destination: null }), chat: async () => { calls++; return { content: [{ type: 'text', text: '建议' }] }; } }, discovery: { get: async topic => ({ items: [], retrievedAt: '2026-10-17T00:00:00Z', stale: false, failures: [], topic }) } });
  t.after(() => new Promise(resolve => server.close(resolve)));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port, origin = 'http://127.0.0.1:' + port;
  assert.equal((await call(port, '/api/assistant/config')).data.available, false);
  assert.equal((await call(port, '/api/assistant/config', { headers: { Host: 'evil.example:' + port } })).status, 403);
  assert.equal((await call(port, '/api/assistant/chat', { method: 'POST' })).status, 403);
  assert.equal((await call(port, '/api/assistant/chat', { method: 'POST', headers: { Origin: 'https://evil.example' } })).status, 403);
  assert.equal((await call(port, '/api/assistant/chat', { method: 'GET' })).status, 405);
  assert.equal((await call(port, '/api/assistant/chat', { method: 'POST', headers: { Origin: origin }, body: '{}' })).status, 415);
  assert.equal((await call(port, '/api/assistant/chat', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: '{bad' })).status, 400);
  assert.equal((await call(port, '/api/assistant/chat', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: 'x'.repeat(257 * 1024) })).status, 413);
  assert.equal((await call(port, '/api/assistant/chat', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', 'Transfer-Encoding': 'chunked' }, body: 'x'.repeat(257 * 1024) })).status, 413);
  assert.equal(calls, 0);
  const success = await call(port, '/api/assistant/chat', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json; charset=utf-8' }, body: '{"prompt":"hello"}' });
  assert.equal(success.data.content[0].text, '建议'); assert.equal(calls, 1);
  assert.equal((await call(port, '/api/discovery?topic=research')).status, 200);
  assert.equal((await call(port, '/api/discovery?topic=all&url=https://evil.example')).status, 400);
  assert.equal((await call(port, '/api/discovery?topic=unknown')).status, 400);
});

test('the HTTP body budget admits long Chinese context while the provider still rejects oversized prompts', async t => {
  let sent = 0, received;
  const assistant = createAssistant({ config: { provider: 'openai', url: 'https://api.example.com/v1/chat/completions', model: 'test-model', key: 'private-key' }, fetch: async (_url, options) => {
    sent++; received = JSON.parse(options.body).messages.at(-1).content;
    return new Response('{"choices":[{"message":{"content":"accepted"}}]}');
  } });
  const server = createTangoServer({ assistant });
  t.after(() => new Promise(resolve => server.close(resolve)));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port, headers = { Origin: 'http://127.0.0.1:' + port, 'Content-Type': 'application/json' };
  const prompt = '中'.repeat(60000);
  const json = JSON.stringify({ prompt }), body = json + ' '.repeat(262144 - Buffer.byteLength(json));
  assert.equal(Buffer.byteLength(body), 262144);
  const success = await call(port, '/api/assistant/chat', { method: 'POST', headers, body });
  assert.equal(success.status, 200); assert.equal(received, prompt); assert.equal(sent, 1);
  const oversized = await call(port, '/api/assistant/chat', { method: 'POST', headers, body: JSON.stringify({ prompt: 'x'.repeat(60001) }) });
  assert.equal(oversized.status, 400); assert.equal(oversized.data.code, 'TANGO_AI_INPUT_INVALID'); assert.equal(sent, 1);
});

test('assistant client disconnect aborts the active provider operation', async t => {
  let started, stopped;
  const ready = new Promise(resolve => { started = resolve; }), aborted = new Promise(resolve => { stopped = resolve; });
  const server = createTangoServer({ assistant: { configuration: () => ({}), chat: async (_input, signal) => new Promise(resolve => { started(); signal.addEventListener('abort', () => { stopped(); resolve({ content: [] }); }, { once: true }); }) } });
  t.after(() => new Promise(resolve => server.close(resolve)));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const req = request({ host: '127.0.0.1', port, path: '/api/assistant/chat', method: 'POST', headers: { Origin: 'http://127.0.0.1:' + port, 'Content-Type': 'application/json' } });
  req.on('error', () => {}); req.end('{"prompt":"hello"}'); await ready; req.destroy();
  await Promise.race([aborted, new Promise((_resolve, reject) => { const timer = setTimeout(() => reject(new Error('provider was not aborted')), 500); timer.unref(); })]);
});
