// S2D-W13 · M14 路由复用器（scripts/agentic/integration/dispatcher.mjs）规格测试。
// 依据：brief §4.2「路由复用器」、plan.md M14 RED 清单：未登录 401 / 跨 owner
// 403 / body>限 413 / 坏 JSON 400 / SSE disconnect / legacy fallback；
// 错误码→HTTP 映射以冻结 README「错误码与 HTTP 建议」表为唯一来源。
//
// TDD：实现落地前本文件 RED（ERR_MODULE_NOT_FOUND）；GREEN 后不得删测试/放宽校验。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAgenticDispatcher, ERROR_STATUS } from '../../../../scripts/agentic/integration/dispatcher.mjs';
import { assertErrorEnvelope, fakeReq, fakeRes, stubContext } from './_helpers.mjs';

const FROZEN_STATUS_TABLE = {
  AUTH_REQUIRED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONTRACT_INVALID: 400,
  CONFLICT: 409,
  RATE_LIMITED: 429,
  BUDGET_EXCEEDED: 409,
  NEED_HUMAN: 409,
  UPSTREAM_UNAVAILABLE: 503,
  INTERNAL_ERROR: 500,
};

function principalAuth(principal) {
  return () => principal;
}

const OWNER_A = { ownerId: 'owner-a', actor: 'user:owner-a' };
const OWNER_B = { ownerId: 'owner-b', actor: 'user:owner-b' };

function makeDispatcher(options = {}) {
  const context = stubContext({ auth: principalAuth(options.principal ?? OWNER_A) });
  const dispatcher = createAgenticDispatcher({ context, ...options });
  return { dispatcher, context };
}

test('ERROR_STATUS matches the frozen README http table exactly', () => {
  assert.deepEqual(ERROR_STATUS, FROZEN_STATUS_TABLE);
});

test('dispatches to the first handler that returns true and reports handled', async () => {
  const calls = [];
  const { dispatcher } = makeDispatcher({
    handlers: [
      async (req, res, pathname, env) => { calls.push(['first', pathname, env.principal]); return false; },
      async (req, res, pathname, env) => { calls.push(['second', pathname, env.principal]); res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }); res.end('{"ok":true}'); return true; },
    ],
  });
  const res = fakeRes();
  const handled = await dispatcher.handle(fakeReq({ url: '/api/blocks/sync', body: { baseRevision: 0, changes: [] } }), res, '/api/blocks/sync');
  assert.equal(handled, true);
  assert.deepEqual(calls.map(entry => entry[0]), ['first', 'second']);
  assert.deepEqual(calls[1][2], OWNER_A);
  assert.equal(res.json().ok, true);
});

test('unmatched requests fall back to legacy with the body still unread', async () => {
  let legacyBody = null;
  const legacy = async (req, res, pathname) => {
    assert.equal(pathname, '/api/legacy/thing');
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    legacyBody = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end('{"legacy":true}');
    return true;
  };
  const { dispatcher } = makeDispatcher({
    handlers: [async () => false],
    legacy,
  });
  const res = fakeRes();
  const handled = await dispatcher.handle(fakeReq({ url: '/api/legacy/thing', body: { hello: 'world' } }), res, '/api/legacy/thing');
  assert.equal(handled, true);
  assert.deepEqual(legacyBody, { hello: 'world' });
  assert.equal(res.json().legacy, true);
});

test('unmatched with no legacy returns false so the caller can keep serving', async () => {
  const { dispatcher } = makeDispatcher({ handlers: [async () => false] });
  const res = fakeRes();
  assert.equal(await dispatcher.handle(fakeReq({ url: '/static/app.js' }), res, '/static/app.js'), false);
  assert.equal(res.headersSent, false, 'dispatcher must not touch the response when nothing handled it');
});

test('unauthenticated request to a protected path: 401 AUTH_REQUIRED envelope, no handler invoked', async () => {
  let handlerCalled = false;
  const { dispatcher } = makeDispatcher({
    principal: null,
    handlers: [async () => { handlerCalled = true; return true; }],
  });
  const res = fakeRes();
  const handled = await dispatcher.handle(fakeReq({ url: '/api/blocks/sync', body: {} }), res, '/api/blocks/sync');
  assert.equal(handled, true, 'an error response is still a handled request');
  assert.equal(handlerCalled, false);
  assertErrorEnvelope(res, { status: 401, code: 'AUTH_REQUIRED' });
});

test('public paths (agentic health) bypass the auth gate and still dispatch', async () => {
  let seenPrincipal = 'unset';
  const { dispatcher } = makeDispatcher({
    principal: null,
    handlers: [async (req, res, pathname, env) => { seenPrincipal = env.principal; res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }); res.end('{}'); return true; }],
  });
  const res = fakeRes();
  assert.equal(await dispatcher.handle(fakeReq({ method: 'GET', url: '/api/agentic/health' }), res, '/api/agentic/health'), true);
  assert.equal(seenPrincipal, null);
  assert.equal(res.statusCode, 200);
});

test('cross-owner access hides existence: NOT_FOUND, no owner leakage in the envelope', async () => {
  const { dispatcher } = makeDispatcher({
    handlers: [async (req, res, pathname, env) => {
      throw { code: 'NOT_FOUND', message: 'resource not available', details: {} };
    }],
  });
  const res = fakeRes();
  await dispatcher.handle(fakeReq({ method: 'GET', url: '/api/artifacts/artifact-of-owner-b' }), res, '/api/artifacts/artifact-of-owner-b');
  const envelope = assertErrorEnvelope(res, { status: 404, code: 'NOT_FOUND' });
  assert.ok(!JSON.stringify(envelope).includes('owner-b'), 'cross-owner envelope must not leak the other owner id');
});

test('body above maxBodyBytes: 413 with a valid envelope and details.limitBytes', async () => {
  let handlerCalled = false;
  const { dispatcher } = makeDispatcher({
    maxBodyBytes: 64,
    handlers: [async (req, res, pathname, env) => { await env.readBody(); handlerCalled = true; return true; }],
  });
  const res = fakeRes();
  await dispatcher.handle(fakeReq({ url: '/api/blocks/sync', body: { pad: 'x'.repeat(512) } }), res, '/api/blocks/sync');
  assert.equal(handlerCalled, false);
  assert.equal(res.statusCode, 413);
  const envelope = assertErrorEnvelope(res);
  assert.ok(envelope.error.details && typeof envelope.error.details.limitBytes === 'number');
});

test('malformed JSON body: 400 CONTRACT_INVALID envelope', async () => {
  const { dispatcher } = makeDispatcher({
    handlers: [async (req, res, pathname, env) => { await env.readBody(); return true; }],
  });
  const res = fakeRes();
  await dispatcher.handle(fakeReq({ url: '/api/blocks/sync', body: '{"broken":' }), res, '/api/blocks/sync');
  assertErrorEnvelope(res, { status: 400, code: 'CONTRACT_INVALID' });
});

test('readBody is cached: multiple handler reads parse the body once', async () => {
  let reads = 0;
  const { dispatcher } = makeDispatcher({
    handlers: [async (req, res, pathname, env) => {
      const first = await env.readBody();
      const second = await env.readBody();
      reads += 1;
      assert.deepEqual(first, second);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end('{}');
      return true;
    }],
  });
  const res = fakeRes();
  await dispatcher.handle(fakeReq({ url: '/api/blocks/sync', body: { a: 1 } }), res, '/api/blocks/sync');
  assert.equal(reads, 1);
  assert.equal(res.statusCode, 200);
});

for (const [code, status] of Object.entries(FROZEN_STATUS_TABLE)) {
  test(`handler api error ${code} surfaces as ${status} with the frozen envelope`, async () => {
    const { dispatcher } = makeDispatcher({
      handlers: [async () => { throw { code, message: `${code} raised by flow handler` }; }],
    });
    const res = fakeRes();
    await dispatcher.handle(fakeReq({ url: '/api/missions/m1/scan', body: {} }), res, '/api/missions/m1/scan');
    assertErrorEnvelope(res, { status, code });
  });
}

test('non-enumerated handler crashes become 500 INTERNAL_ERROR without internals leaking', async () => {
  const { dispatcher } = makeDispatcher({
    handlers: [async () => { const boom = new Error('secret internals sk-LEAK at inner/module.mjs:10'); throw boom; }],
  });
  const res = fakeRes();
  await dispatcher.handle(fakeReq({ url: '/api/blocks/sync', body: {} }), res, '/api/blocks/sync');
  const envelope = assertErrorEnvelope(res, { status: 500, code: 'INTERNAL_ERROR' });
  const serialized = JSON.stringify(envelope);
  assert.ok(!serialized.includes('sk-LEAK'), 'internal error must not leak key-like material');
  assert.ok(!serialized.includes('inner/module.mjs'), 'internal error must not leak module paths');
});

test('requestId generator stamps every error envelope with a stable id', async () => {
  const { dispatcher } = makeDispatcher({
    requestId: () => 'req_w13_1',
    handlers: [async () => { throw { code: 'CONFLICT', message: 'revision conflict' }; }],
  });
  const res = fakeRes();
  await dispatcher.handle(fakeReq({ url: '/api/blocks/sync', body: {} }), res, '/api/blocks/sync');
  const envelope = assertErrorEnvelope(res, { status: 409, code: 'CONFLICT' });
  assert.equal(envelope.error.requestId, 'req_w13_1');
});

test('SSE: headers are event-stream, frames stream incrementally', async () => {
  const { dispatcher } = makeDispatcher({
    handlers: [async (req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store' });
      res.write('data: {"layer":"shape"}\n\n');
      res.write('data: {"layer":"samples"}\n\n');
      res.write('data: [DONE]\n\n');
      res.end();
      return true;
    }],
  });
  const res = fakeRes();
  await dispatcher.handle(fakeReq({ method: 'GET', url: '/api/missions/m1/preview' }), res, '/api/missions/m1/preview');
  assert.equal(res.statusCode, 200);
  assert.match(res.headers['content-type'], /^text\/event-stream/);
  assert.deepEqual(res.sseFrames().slice(0, 2), [{ layer: 'shape' }, { layer: 'samples' }]);
});

test('SSE client disconnect: env.signal aborts and the disconnect is recorded with UNKNOWN outcome (never swallowed)', async () => {
  const { dispatcher, context } = makeDispatcher({
    handlers: [async (req, res, pathname, env) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store' });
      res.write('data: {"layer":"shape"}\n\n');
      await new Promise(resolve => setImmediate(resolve));
      res.destroy(); // client cuts the connection mid-stream
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(env.signal.aborted, true, 'abort signal must fire on client disconnect');
      return true;
    }],
  });
  await dispatcher.handle(fakeReq({ method: 'GET', url: '/api/runs/r1/activity' }), fakeRes(), '/api/runs/r1/activity');
  const recorded = context.events.recorded();
  const disconnect = recorded.find(event => /disconnect/i.test(String(event?.type)));
  assert.ok(disconnect, `a disconnect event must be recorded, got: ${JSON.stringify(recorded)}`);
  assert.equal(disconnect.outcome, 'UNKNOWN', 'disconnect outcome must stay UNKNOWN, not silently succeed');
});

test('SSE mid-stream upstream failure: final frame carries the frozen error, never a success marker', async () => {
  const { dispatcher } = makeDispatcher({
    handlers: [async (req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store' });
      res.write('data: {"layer":"shape"}\n\n');
      throw { code: 'UPSTREAM_UNAVAILABLE', message: 'model gateway unreachable' };
    }],
  });
  const res = fakeRes();
  await dispatcher.handle(fakeReq({ method: 'GET', url: '/api/missions/m1/preview' }), res, '/api/missions/m1/preview');
  assert.equal(res.writableEnded, true, 'stream must terminate');
  const frames = res.sseFrames();
  const last = frames[frames.length - 1];
  const serialized = JSON.stringify(last);
  assert.ok(serialized.includes('UPSTREAM_UNAVAILABLE'), `final SSE frame must carry the failure, got: ${serialized}`);
  assert.ok(!serialized.includes('[DONE]'), 'a failed stream must not end with a success marker');
});

test('dispatcher authenticates exactly once per request, not once per handler', async () => {
  let authCalls = 0;
  const context = stubContext({ auth: () => { authCalls += 1; return OWNER_B; } });
  const dispatcher = createAgenticDispatcher({
    context,
    handlers: [async () => false, async () => false],
  });
  await dispatcher.handle(fakeReq({ url: '/api/blocks/sync', body: {} }), fakeRes(), '/api/blocks/sync');
  assert.equal(authCalls, 1);
});
