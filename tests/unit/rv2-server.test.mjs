import assert from 'node:assert/strict';
import { test } from 'node:test';
import { request } from 'node:http';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAssistant } from '../../scripts/ai-assistant.mjs';
import { createTangoServer } from '../../scripts/serve-tango.mjs';
import { createMetrics, metricsDay, validMetricsDay, METRICS_BODY_MAX_BYTES } from '../../scripts/metrics.mjs';
import { PROMPT_MAX, EVENT_MAX } from '../../web/relay/contracts.js';

const config = { provider: 'openai', url: 'https://api.example.com/v1/chat/completions', model: 'auto', key: 'private-key' };
const openaiReply = text => new Response(JSON.stringify({ choices: [{ message: { content: text } }] }));
const scenes = {
  version: 1,
  usages: [
    {
      id: 'meeting-notes', title: '整理会议纪要', category: '整理',
      does: ['列出重点', '拆出待办'], materialLabel: '把会议内容给我', materialHint: '粘贴聊天记录或转写文字',
      learned: '先要重点、待办和没说清的地方。', externalPrompt: '请整理：1.重点 2.待办 {{material}}',
      keywords: ['会议', '开会', '纪要', '组会'], personas: { student: { featured: true }, worker: { featured: true } },
    },
    {
      id: 'email-reply', title: '写一封回复', category: '写',
      does: ['先起草一版'], materialLabel: '把来往消息给我', materialHint: '粘贴对方的话和你的意图',
      learned: '把对方问题和你的意图一起交给 AI。', externalPrompt: '请起草回复 {{material}}',
      keywords: ['邮件', '回复', '客户'], personas: { worker: { featured: true } },
    },
    {
      id: 'trip-plan', title: '做旅行计划', category: '计划',
      does: ['拆成清单'], materialLabel: '把想法给我', materialHint: '目的地、天数、预算',
      learned: '目标、限制、截止时间一起说。', externalPrompt: '请做计划 {{material}}',
      keywords: ['旅行', '行程'], personas: { student: { featured: true } },
    },
  ],
};

// ---------------------------------------------------------------------------
// SPEC §5.3 relay v2 contract: {mode:'relay', stream:true, prompt} switches the
// upstream system contract to sections/learned/followups and D3 drops
// estimatedSavedMinutes entirely. The v1 request shape (no stream flag) must
// keep the v1 contract so web/ai-relay.js and its old tests stay green.
// ---------------------------------------------------------------------------

test('relay v2 (stream:true) teaches the sections contract without estimatedSavedMinutes (D3) on the standard tier', async () => {
  let payload;
  const app = createAssistant({ config, env: { TANGO_AI_MODEL_STANDARD: 'fast-standard', TANGO_AI_MODEL_LIGHT: 'fast-light' }, fetch: async (_url, options) => {
    payload = JSON.parse(options.body);
    return openaiReply('{"sections":[{"title":"会议重点","items":["本周上线"]}],"learned":"先要重点和待办。","followups":["更短一点"]}');
  } });
  const prompt = '【AI 接力】用法：整理会议纪要\n用户事件：<event>整理组会记录</event>\n用户材料：<material>张三负责测试</material>';
  const result = await app.chat({ mode: 'relay', stream: true, prompt });
  assert.equal(result.content[0].text, '{"sections":[{"title":"会议重点","items":["本周上线"]}],"learned":"先要重点和待办。","followups":["更短一点"]}');
  assert.equal(payload.model, 'fast-standard');
  assert.equal(payload.messages.at(-1).content, prompt);
  const system = payload.messages[0].content;
  assert.match(system, /当前任务：完成一次 AI 接力/);
  assert.match(system, /sections/);
  assert.match(system, /learned/);
  assert.match(system, /followups/);
  assert.match(system, /不可信/);
  assert.doesNotMatch(system, /estimatedSavedMinutes/);
});

test('relay v1 request (no stream flag) keeps the legacy contract mentioning estimatedSavedMinutes', async () => {
  let payload;
  const app = createAssistant({ config, env: {}, fetch: async (_url, options) => {
    payload = JSON.parse(options.body);
    return openaiReply('{"result":"r","learned":"l","estimatedSavedMinutes":5}');
  } });
  await app.chat({ mode: 'relay', prompt: '【AI 接力】事件类型：会议整理' });
  const system = payload.messages[0].content;
  assert.match(system, /当前任务：完成一次 AI 接力/);
  assert.match(system, /estimatedSavedMinutes/);
  assert.match(system, /不可信标签/);
});

test('relay v2 prompts obey the contract cap PROMPT_MAX (413) while v1 keeps the legacy boundary', async () => {
  let calls = 0;
  const app = createAssistant({ config, env: {}, fetch: async () => { calls++; return openaiReply('{"sections":[{"title":"a","items":["b"]}],"learned":"c","followups":[]}'); } });
  await assert.rejects(app.chat({ mode: 'relay', stream: true, prompt: 'x'.repeat(PROMPT_MAX + 1) }), error => error.code === 'TANGO_AI_INPUT_TOO_LONG' && error.status === 413);
  assert.equal(calls, 0);
  assert.equal((await app.chat({ mode: 'relay', stream: true, prompt: 'x'.repeat(PROMPT_MAX) })).content[0].type, 'text');
  assert.equal(calls, 1);
  // v1 keeps the 60000-char legacy boundary — old flow, old cap.
  await assert.rejects(app.chat({ mode: 'relay', prompt: 'x'.repeat(60001) }), error => error.code === 'TANGO_AI_INPUT_INVALID');
});

test('relay v2 streams with the v2 system contract and hits the 60s total wall while reasoning bytes keep flowing (§4⑧)', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const encoder = new TextEncoder();
  let sawPayload;
  let controller;
  const frame = payload => encoder.encode('data: ' + JSON.stringify(payload) + '\n\n');
  const stream = new ReadableStream({ start(c) { controller = c; c.enqueue(frame({ choices: [{ delta: { reasoning_content: 'r'.repeat(512) } }] })); } });
  const app = createAssistant({ config, env: {}, fetch: async (_url, options) => {
    sawPayload = JSON.parse(options.body);
    return new Response(stream);
  } });
  const drain = () => new Promise(resolve => setImmediate(resolve));
  const call = (async () => { const out = []; for await (const chunk of app.streamChat({ mode: 'relay', stream: true, prompt: '【AI 接力】<event>e</event><material>m</material>' })) out.push(chunk); return out.join(''); })().then(value => ({ ok: true, value }), error => ({ ok: false, code: error.code, status: error.status }));
  await drain();
  assert.equal(sawPayload.stream, true);
  assert.match(sawPayload.messages[0].content, /sections/);
  assert.doesNotMatch(sawPayload.messages[0].content, /estimatedSavedMinutes/);
  for (let i = 0; i < 7; i += 1) {
    t.mock.timers.tick(10000);
    // After the 60s wall cancels the reader the controller may already be
    // closed — farewell frames land in a closed stream (same as the parse
    // total-budget test).
    try { controller.enqueue(frame({ choices: [{ delta: { reasoning_content: 'r'.repeat(512) } }] })); } catch {}
    await drain();
  }
  const outcome = await call;
  assert.equal(outcome.ok, false);
  assert.equal(outcome.code, 'TANGO_AI_TIMEOUT');
  assert.equal(outcome.status, 504);
});

test('relay v1 streaming keeps the 300s total floor — the 60s wall applies only to stream:true', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const encoder = new TextEncoder();
  let controller;
  const frame = payload => encoder.encode('data: ' + JSON.stringify(payload) + '\n\n');
  const stream = new ReadableStream({ start(c) { controller = c; c.enqueue(frame({ choices: [{ delta: { content: '好' } }] })); } });
  const app = createAssistant({ config, env: {}, fetch: async () => new Response(stream) });
  const drain = () => new Promise(resolve => setImmediate(resolve));
  const call = (async () => { const out = []; for await (const chunk of app.streamChat({ mode: 'relay', prompt: '【AI 接力】事件类型：会议整理' })) out.push(chunk); return out.join(''); })().then(value => ({ ok: true, value }), error => ({ ok: false, code: error.code }));
  await drain();
  for (let i = 0; i < 4; i += 1) {
    t.mock.timers.tick(20000);
    controller.enqueue(frame({ choices: [{ delta: { reasoning_content: 'r'.repeat(512) } }] }));
    await drain();
  }
  let early; call.then(outcome => { early = outcome; });
  await drain();
  assert.equal(early, undefined, 'v1 relay must still be streaming at 80s: the 60s cap is v2-only');
  controller.enqueue(encoder.encode('data: [DONE]\n\n'));
  controller.close();
  assert.equal((await call).value, '好');
});

// ---------------------------------------------------------------------------
// SPEC §5.3 mode:'route' — light tier, event in, scene-library ids only out.
// ---------------------------------------------------------------------------

test('route mode runs the light tier with the scene catalog in the system prompt and the event in an untrusted tag', async () => {
  let payload;
  const app = createAssistant({ config, scenes, env: { TANGO_AI_MODEL_LIGHT: 'fast-light', TANGO_AI_MODEL_STANDARD: 'fast-standard' }, fetch: async (_url, options) => {
    payload = JSON.parse(options.body);
    return openaiReply('{"usageId":"meeting-notes","confidence":0.82,"alternatives":["email-reply"]}');
  } });
  const result = await app.chat({ mode: 'route', event: '整理组会纪要' });
  assert.equal(result.content[0].text, '{"usageId":"meeting-notes","confidence":0.82,"alternatives":["email-reply"]}');
  assert.equal(payload.model, 'fast-light');
  assert.equal(payload.messages.at(-1).content, '<event>整理组会纪要</event>');
  const system = payload.messages[0].content;
  assert.match(system, /当前任务：为一件事匹配/);
  assert.match(system, /usageId/);
  assert.match(system, /confidence/);
  assert.match(system, /alternatives/);
  assert.match(system, /meeting-notes｜整理会议纪要｜会议,开会,纪要,组会/);
  assert.match(system, /email-reply｜写一封回复｜邮件,回复,客户/);
  assert.match(system, /不可信数据/);
  assert.match(system, /只能使用候选清单中出现过的 id|只能从候选清单/);
});

test('route mode validates the request strictly and rejects non-string events and extra keys', async () => {
  let calls = 0;
  const app = createAssistant({ config, scenes, env: {}, fetch: async () => { calls++; return openaiReply('{}'); } });
  await assert.rejects(app.chat({ mode: 'route' }), error => error.code === 'TANGO_AI_INPUT_INVALID');
  await assert.rejects(app.chat({ mode: 'route', event: '   ' }), error => error.code === 'TANGO_AI_INPUT_INVALID');
  await assert.rejects(app.chat({ mode: 'route', event: 42 }), error => error.code === 'TANGO_AI_INPUT_INVALID');
  await assert.rejects(app.chat({ mode: 'route', event: 'x'.repeat(EVENT_MAX + 1) }), error => error.code === 'TANGO_AI_INPUT_INVALID');
  await assert.rejects(app.chat({ mode: 'route', event: '开会', prompt: 'legacy field' }), error => error.code === 'TANGO_AI_INPUT_INVALID');
  await assert.rejects(app.chat({ mode: 'route', event: '开会', stream: true }), error => error.code === 'TANGO_AI_INPUT_INVALID');
  assert.equal(calls, 0);
  assert.equal((await app.chat({ mode: 'route', event: 'x'.repeat(EVENT_MAX) })).content[0].type, 'text');
  assert.equal(calls, 1);
});

test('route mode without a usable scene library reports TANGO_AI_NOT_CONFIGURED and never calls upstream', async () => {
  let calls = 0;
  const broken = createAssistant({ config, scenes: { version: 9, usages: [] }, env: {}, fetch: async () => { calls++; return openaiReply('{}'); } });
  await assert.rejects(broken.chat({ mode: 'route', event: '开会' }), error => error.code === 'TANGO_AI_NOT_CONFIGURED' && error.status === 503);
  const throwing = createAssistant({ config, scenes: async () => { throw new Error('disk gone'); }, env: {}, fetch: async () => { calls++; return openaiReply('{}'); } });
  await assert.rejects(throwing.chat({ mode: 'route', event: '开会' }), error => error.code === 'TANGO_AI_NOT_CONFIGURED');
  const invalid = createAssistant({ config, scenes: { version: 1, usages: [{ id: 'x', title: '' }] }, env: {}, fetch: async () => { calls++; return openaiReply('{}'); } });
  await assert.rejects(invalid.chat({ mode: 'route', event: '开会' }), error => error.code === 'TANGO_AI_NOT_CONFIGURED');
  assert.equal(calls, 0);
});

// ---------------------------------------------------------------------------
// SPEC §5.5 / D10 — scripts/metrics.mjs: count-only funnel counters.
// ---------------------------------------------------------------------------

test('metrics counters accept only count-only bodies and accumulate per day', async () => {
  let clock = Date.parse('2026-10-24T10:00:00+08:00');
  const metrics = createMetrics({ now: () => clock });
  const day = metricsDay(clock);
  assert.equal(await metrics.record({ event: 'start_submit' }), 'start_submit');
  assert.equal(await metrics.record({ event: 'relay_send' }), 'relay_send');
  assert.equal(await metrics.record({ event: 'relay_send' }), 'relay_send');
  assert.equal(await metrics.record({ event: 'rate:much' }), 'rate:much');
  assert.equal(await metrics.record({ event: 'relay_fail:timeout' }), 'relay_fail:timeout');
  assert.equal(await metrics.record({ event: 'baton_copy:doubao' }), 'baton_copy:doubao');
  assert.equal(await metrics.record({ event: 'relay_send' }), 'relay_send');
  // D10: junk never counts — wrong names, bad param slots, extra keys, arrays.
  assert.equal(await metrics.record({ event: 'nonsense' }), null);
  assert.equal(await metrics.record({ event: 'relay_fail:segfault' }), null);
  assert.equal(await metrics.record({ event: 'rate:maybe' }), null);
  assert.equal(await metrics.record({ event: 'relay_send', userId: 1 }), null);
  assert.equal(await metrics.record({ event: 'relay_send', ip: '10.0.0.1' }), null);
  assert.equal(await metrics.record({ event: { nested: true } }), null);
  assert.equal(await metrics.record(['relay_send']), null);
  assert.equal(await metrics.record(null), null);
  assert.deepEqual(await metrics.snapshot(day), { day, events: { 'baton_copy:doubao': 1, 'rate:much': 1, 'relay_fail:timeout': 1, relay_send: 3, start_submit: 1 } });
  // A new day starts from zero counters of its own (+25h crosses any local midnight).
  clock += 25 * 3600 * 1000;
  assert.equal(await metrics.record({ event: 'relay_send' }), 'relay_send');
  assert.deepEqual(await metrics.snapshot(metricsDay(clock)), { day: metricsDay(clock), events: { relay_send: 1 } });
  assert.deepEqual((await metrics.snapshot(day)).events.relay_send, 3);
});

test('metrics persist per-day JSON atomically and resume across restarts', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rv2-metrics-'));
  let clock = Date.parse('2026-10-24T23:00:00+08:00');
  const day = metricsDay(clock);
  const first = createMetrics({ dir, now: () => clock });
  assert.equal(await first.record({ event: 'scene_click' }), 'scene_click');
  assert.equal(await first.record({ event: 'relay_ok' }), 'relay_ok');
  assert.equal(await first.record({ event: 'scene_click' }), 'scene_click');
  const onDisk = JSON.parse(await readFile(join(dir, day + '.json'), 'utf8'));
  assert.deepEqual(onDisk, { day, events: { relay_ok: 1, scene_click: 2 } });
  // Restart: a fresh instance resumes today's counts from the daily file.
  const second = createMetrics({ dir, now: () => clock });
  assert.equal(await second.record({ event: 'scene_click' }), 'scene_click');
  assert.deepEqual(await second.snapshot(day), { day, events: { relay_ok: 1, scene_click: 3 } });
  // Rollover keeps the finished day frozen in its own file (+25h crosses any local midnight).
  clock += 25 * 3600 * 1000;
  const next = metricsDay(clock);
  assert.equal(await second.record({ event: 'relay_ok' }), 'relay_ok');
  assert.deepEqual((await second.snapshot(day)).events, { relay_ok: 1, scene_click: 3 });
  assert.deepEqual((await second.snapshot(next)).events, { relay_ok: 1 });
});

test('metrics tighten baton_copy/graduated to the known external app ids when supplied', async () => {
  const metrics = createMetrics({ apps: ['doubao', 'deepseek', 'chatgpt'] });
  assert.equal(await metrics.record({ event: 'baton_copy:doubao' }), 'baton_copy:doubao');
  assert.equal(await metrics.record({ event: 'graduated:chatgpt' }), 'graduated:chatgpt');
  // id-shaped but unknown: rejected once the real app list is supplied …
  assert.equal(await metrics.record({ event: 'baton_copy:not-an-app' }), null);
  // … while the apps-less fallback keeps the contracts APP_ID_RE gate.
  const fallback = createMetrics();
  assert.equal(await metrics.record({ event: 'baton_copy:not-an-app' }), null);
  assert.equal(await fallback.record({ event: 'baton_copy:not-an-app' }), 'baton_copy:not-an-app');
});

test('the default server metrics tighten app events to web/relay/external-apps.js ids', async t => {
  const server = createTangoServer({ assistant: noAssistant, discovery: noDiscovery });
  t.after(() => new Promise(resolve => server.close(resolve)));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port, origin = 'http://127.0.0.1:' + port;
  const headers = { Origin: origin, 'Content-Type': 'application/json' };
  assert.equal((await call(port, '/api/metrics', { method: 'POST', headers, body: '{"event":"baton_copy:doubao"}' })).status, 204);
  assert.equal((await call(port, '/api/metrics', { method: 'POST', headers, body: '{"event":"baton_copy:definitely-not-a-listed-app"}' })).status, 400);
});

test('metrics day helpers validate calendar days and bound the POST body', () => {
  assert.equal(validMetricsDay('2026-10-24'), true);
  assert.equal(validMetricsDay('2026-02-29'), false); // 2026 is not a leap year
  assert.equal(validMetricsDay('2026-13-01'), false);
  assert.equal(validMetricsDay('2026-10-24x'), false);
  assert.equal(validMetricsDay('today'), false);
  assert.equal(validMetricsDay(''), false);
  assert.equal(validMetricsDay(null), false);
  assert.ok(Number.isInteger(METRICS_BODY_MAX_BYTES) && METRICS_BODY_MAX_BYTES >= 256 && METRICS_BODY_MAX_BYTES <= 4096);
});

// ---------------------------------------------------------------------------
// serve-tango wiring: /api/metrics endpoints + relay/route through the real
// HTTP server with the real createAssistant (fake upstream fetch).
// ---------------------------------------------------------------------------

function call(port, path, { method = 'GET', body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method, headers }, res => {
      let text = ''; res.setEncoding('utf8'); res.on('data', part => { text += part; });
      res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], text, data: text ? (() => { try { return JSON.parse(text); } catch { return null; } })() : null }));
    }); req.on('error', reject); req.end(body);
  });
}

const noAssistant = { configuration: () => ({}), chat: async () => ({ content: [{ type: 'text', text: 'unused' }] }) };
const noDiscovery = { get: async topic => ({ items: [], topic }) };

test('/api/metrics counts guest funnel events without auth (D5) and guards origin, query, JSON and size', async t => {
  const counted = [];
  const metrics = { record: async body => { const event = body && typeof body === 'object' ? body.event : null; counted.push(event); return event === 'relay_send' ? event : null; }, snapshot: async day => ({ day, events: {} }) };
  const guestAuthThrows = { requestAllowed: () => true, authenticate() { throw new Error('AUTH_REQUIRED'); } };
  const server = createTangoServer({ collaboration: guestAuthThrows, metrics, assistant: noAssistant, discovery: noDiscovery });
  t.after(() => new Promise(resolve => server.close(resolve)));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port, origin = 'http://127.0.0.1:' + port;
  // D5: guests (authenticate would throw) can still post funnel events.
  const post = await call(port, '/api/metrics', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: '{"event":"relay_send"}' });
  assert.equal(post.status, 204);
  assert.equal(post.text, '');
  assert.deepEqual(counted, ['relay_send']);
  assert.equal((await call(port, '/api/metrics', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"event":"relay_send"}' })).status, 403);
  assert.equal((await call(port, '/api/metrics?x=1', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: '{"event":"relay_send"}' })).status, 400);
  assert.equal((await call(port, '/api/metrics', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: 'not json' })).status, 400);
  assert.equal((await call(port, '/api/metrics', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: '{"event":"nonsense"}' })).status, 400);
  assert.equal((await call(port, '/api/metrics', { method: 'POST', headers: { Origin: origin }, body: '{}' })).status, 415);
  assert.equal((await call(port, '/api/metrics', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', 'Content-Length': String(METRICS_BODY_MAX_BYTES + 1) }, body: 'x'.repeat(METRICS_BODY_MAX_BYTES + 1) })).status, 413);
  assert.equal((await call(port, '/api/metrics', { method: 'GET', headers: { Origin: origin } })).status, 401); // authenticate() throws for guests
});

test('/api/metrics GET serves an admin the day snapshot and validates ?day=', async t => {
  const metrics = { record: async () => null, snapshot: async day => ({ day, events: { relay_send: 7, start_submit: 7 } }) };
  const admin = { requestAllowed: () => true, authenticate: () => ({ id: 'u1', role: 'admin' }) };
  const member = { requestAllowed: () => true, authenticate: () => ({ id: 'u2', role: 'member' }) };
  const build = collaboration => {
    const server = createTangoServer({ collaboration, metrics, assistant: noAssistant, discovery: noDiscovery });
    return { server, start: new Promise(resolve => server.listen(0, '127.0.0.1', resolve)) };
  };
  const adminServer = build(admin);
  t.after(() => new Promise(resolve => adminServer.server.close(resolve)));
  await adminServer.start;
  let port = adminServer.server.address().port;
  let origin = 'http://127.0.0.1:' + port;
  const today = await call(port, '/api/metrics', { headers: { Origin: origin } });
  assert.equal(today.status, 200);
  assert.equal(today.data.events.relay_send, 7);
  const other = await call(port, '/api/metrics?day=2026-10-25', { headers: { Origin: origin } });
  assert.equal(other.status, 200);
  assert.equal(other.data.day, '2026-10-25');
  assert.equal(other.data.events.start_submit, 7);
  assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(today.data.day), 'the default day is today');
  assert.equal((await call(port, '/api/metrics?day=2026-2-31', { headers: { Origin: origin } })).status, 400);
  assert.equal((await call(port, '/api/metrics?day=abc', { headers: { Origin: origin } })).status, 400);
  assert.equal((await call(port, '/api/metrics?day=2026-10-24&day=2026-10-25', { headers: { Origin: origin } })).status, 400);
  assert.equal((await call(port, '/api/metrics?topic=x', { headers: { Origin: origin } })).status, 400);
  assert.equal((await call(port, '/api/metrics', { method: 'PUT', headers: { Origin: origin } })).status, 405);
  const memberServer = build(member);
  t.after(() => new Promise(resolve => memberServer.server.close(resolve)));
  await memberServer.start;
  port = memberServer.server.address().port;
  origin = 'http://127.0.0.1:' + port;
  assert.equal((await call(port, '/api/metrics', { headers: { Origin: origin } })).status, 403);
});

test('the HTTP server relays a v2 relay request as SSE and a route request through the guard', async t => {
  const encoder = new TextEncoder();
  let upstream;
  const sse = payload => encoder.encode('data: ' + JSON.stringify(payload) + '\n\n');
  const delta = text => ({ choices: [{ delta: { content: text } }] });
  const assistant = createAssistant({ config, scenes, env: { TANGO_AI_MODEL_LIGHT: 'fast-light', TANGO_AI_MODEL_STANDARD: 'fast-standard' }, fetch: async (_url, options) => {
    upstream = JSON.parse(options.body);
    if (upstream.stream === true) {
      const stream = new ReadableStream({ start(c) {
        c.enqueue(sse(delta('{"sections":[{"title":"会议重点","items":["本周上')));
        c.enqueue(sse(delta('线"]}],"learned":"先要重点。","followups":[]}')));
        c.enqueue(encoder.encode('data: [DONE]\n\n'));
        c.close();
      } });
      return new Response(stream);
    }
    return openaiReply('{"usageId":"meeting-notes","confidence":0.9,"alternatives":[]}');
  } });
  const server = createTangoServer({ assistant, metrics: createMetrics() });
  t.after(() => new Promise(resolve => server.close(resolve)));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port, origin = 'http://127.0.0.1:' + port;
  const relay = await call(port, '/api/assistant/chat', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'relay', stream: true, prompt: '【AI 接力】<event>整理组会</event><material>张三负责测试</material>' }) });
  assert.equal(relay.status, 200);
  assert.match(relay.type, /text\/event-stream/);
  assert.match(relay.text, /data: \{"status":"waiting"\}/);
  assert.match(relay.text, /会议重点/);
  assert.match(relay.text, /data: \[DONE\]/);
  assert.equal(upstream.model, 'fast-standard');
  assert.doesNotMatch(upstream.messages[0].content, /estimatedSavedMinutes/);
  const route = await call(port, '/api/assistant/chat', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'route', event: '帮我整理组会纪要' }) });
  assert.equal(route.status, 200);
  assert.equal(route.data.content[0].text, '{"usageId":"meeting-notes","confidence":0.9,"alternatives":[]}');
  assert.equal(upstream.model, 'fast-light');
  assert.equal(upstream.messages.at(-1).content, '<event>帮我整理组会纪要</event>');
});
