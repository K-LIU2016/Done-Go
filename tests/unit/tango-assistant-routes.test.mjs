import assert from 'node:assert/strict';
import { test } from 'node:test';
import { request } from 'node:http';
import { networkInterfaces } from 'node:os';
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

function rawCall(port, path, { method = 'GET', body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method, headers }, res => {
      let text = ''; res.setEncoding('utf8'); res.on('data', part => { text += part; });
      res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], text }));
    }); req.on('error', reject); req.end(body);
  });
}

function openRawStream(port, path, { method = 'GET', body, headers = {} } = {}) {
  let resolveFirst, rejectFirst, resolveDone, rejectDone, responseStatus, responseType, text = '', sawFirst = false;
  const firstChunk = new Promise((resolve, reject) => { resolveFirst = resolve; rejectFirst = reject; });
  const finished = new Promise((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });
  const req = request({ host: '127.0.0.1', port, path, method, headers }, res => {
    responseStatus = res.statusCode; responseType = res.headers['content-type']; res.setEncoding('utf8');
    res.on('data', part => { text += part; if (!sawFirst) { sawFirst = true; resolveFirst({ status: responseStatus, type: responseType, text: part }); } });
    res.on('end', () => resolveDone({ status: responseStatus, type: responseType, text }));
  });
  req.on('error', error => { if (!sawFirst) rejectFirst(error); rejectDone(error); });
  req.end(body);
  return { firstChunk, finished };
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

test('assistant config accepts validated PUT patches and guards origin, store, and body shape', async t => {
  const saved = [];
  const server = createTangoServer({ assistant: { configuration: () => ({ available: true, provider: 'openai', model: 'saved-model', destination: 'https://api.example.com/v1/chat/completions' }), chat: async () => ({}) }, assistantConfigStore: { save: async patch => { if (!patch || typeof patch !== 'object' || Array.isArray(patch) || Object.keys(patch).length === 0) throw new Error('invalid'); saved.push(patch); } } });
  t.after(() => new Promise(resolve => server.close(resolve)));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port, headers = { Origin: 'http://127.0.0.1:' + port, 'Content-Type': 'application/json' };
  const patch = { provider: 'openai', url: 'https://api.example.com/v1/chat/completions', model: 'saved-model' };
  const put = await rawCall(port, '/api/assistant/config', { method: 'PUT', headers, body: JSON.stringify(patch) });
  assert.equal(put.status, 200); assert.equal(JSON.parse(put.text).model, 'saved-model'); assert.deepEqual(saved, [patch]);
  assert.equal((await rawCall(port, '/api/assistant/config', { method: 'PUT', headers, body: '{bad' })).status, 400);
  assert.equal((await rawCall(port, '/api/assistant/config', { method: 'PUT', headers, body: '{}' })).status, 400);
  assert.equal((await rawCall(port, '/api/assistant/config', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) })).status, 403);
});

test('assistant config PUT returns 405 when no config store is wired', async t => {
  const server = createTangoServer({ assistant: { configuration: () => ({}), chat: async () => ({}) } });
  t.after(() => new Promise(resolve => server.close(resolve)));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  assert.equal((await rawCall(port, '/api/assistant/config', { method: 'PUT', headers: { Origin: 'http://127.0.0.1:' + port, 'Content-Type': 'application/json' }, body: '{"model":"x"}' })).status, 405);
});

test('assistant chat streams SSE frames and surfaces mid-stream failures as error frames', async t => {
  const okServer = createTangoServer({ assistant: { configuration: () => ({}), chat: async () => { throw new Error('unused'); }, streamChat: async function* () { yield '你'; yield '好'; } } });
  t.after(() => new Promise(resolve => okServer.close(resolve)));
  await new Promise(resolve => okServer.listen(0, '127.0.0.1', resolve));
  const port = okServer.address().port, headers = { Origin: 'http://127.0.0.1:' + port, 'Content-Type': 'application/json' };
  const ok = await rawCall(port, '/api/assistant/chat', { method: 'POST', headers, body: '{"prompt":"hello","mode":"chat","stream":true}' });
  assert.equal(ok.status, 200); assert.match(ok.type, /text\/event-stream/);
  assert.equal(ok.text, 'data: {"status":"waiting"}\n\ndata: {"text":"你"}\n\ndata: {"text":"好"}\n\ndata: [DONE]\n\n');
  const failServer = createTangoServer({ assistant: { configuration: () => ({}), chat: async () => { throw new Error('unused'); }, streamChat: async function* () { yield '一'; throw Object.assign(new Error('upstream'), { code: 'TANGO_AI_UPSTREAM_FAILED' }); } } });
  t.after(() => new Promise(resolve => failServer.close(resolve)));
  await new Promise(resolve => failServer.listen(0, '127.0.0.1', resolve));
  const failPort = failServer.address().port, failHeaders = { Origin: 'http://127.0.0.1:' + failPort, 'Content-Type': 'application/json' };
  const failed = await rawCall(failPort, '/api/assistant/chat', { method: 'POST', headers: failHeaders, body: '{"prompt":"hello","mode":"chat","stream":true}' });
  assert.equal(failed.status, 200);
  assert.equal(failed.text, 'data: {"status":"waiting"}\n\ndata: {"text":"一"}\n\ndata: {"error":"ai-upstream-failed"}\n\n');
});

test('assistant chat flushes an SSE status frame before the first model token', async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const server = createTangoServer({ assistant: { configuration: () => ({}), chat: async () => ({}), streamChat: async function* () { await gate; yield '回答'; } } });
  t.after(() => new Promise(resolve => server.close(resolve)));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const stream = openRawStream(port, '/api/assistant/chat', { method: 'POST', headers: { Origin: 'http://127.0.0.1:' + port, 'Content-Type': 'application/json' }, body: '{"prompt":"hello","mode":"chat","stream":true}' });
  let timeout;
  try {
    const first = await Promise.race([stream.firstChunk, new Promise((_resolve, reject) => { timeout = setTimeout(() => reject(new Error('SSE status did not arrive before the model token')), 1000); })]);
    clearTimeout(timeout);
    assert.equal(first.status, 200);
    assert.match(first.type, /text\/event-stream/);
    assert.equal(first.text, 'data: {"status":"waiting"}\n\n');
    release();
    const complete = await stream.finished;
    assert.equal(complete.text, 'data: {"status":"waiting"}\n\ndata: {"text":"回答"}\n\ndata: [DONE]\n\n');
  } finally {
    clearTimeout(timeout);
    release();
  }
});

test('assistant routes admit the explicitly bound IPv4 host and still reject unbound hosts', async t => {
  const address = Object.values(networkInterfaces()).flat().find(i => i && i.family === 'IPv4' && !i.internal)?.address;
  if (!address) { t.skip('no external IPv4 interface to bind'); return; }
  const server = createTangoServer({ assistant: { configuration: () => ({ available: false, provider: null, model: null, destination: null }), chat: async () => ({ content: [{ type: 'text', text: 'unused' }] }) }, discovery: { get: async topic => ({ items: [], retrievedAt: '2026-10-18T00:00:00Z', stale: false, failures: [], topic }) } });
  t.after(() => new Promise(resolve => server.close(resolve)));
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, address, resolve); });
  const port = server.address().port;
  const ask = hostHeader => new Promise((resolve, reject) => {
    const req = request({ host: address, port, path: '/api/assistant/config', headers: { Host: hostHeader } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject); req.end();
  });
  assert.equal(await ask(address + ':' + port), 200);
  assert.equal(await ask('192.0.2.1:' + port), 403);
  assert.equal(await ask('evil.example:' + port), 403);
});
