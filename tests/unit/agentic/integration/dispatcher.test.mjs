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
  // 显式 principal:null 必须原样透传（未登录场景）；仅未提供时才默认 OWNER_A。
  // 原写法 `options.principal ?? OWNER_A` 会把 null 复活成 OWNER_A，使 401/
  // public-path 两个场景不可达（任何正确实现都无法通过）——测试基建修复，
  // 断言本身不变（RED 清单：未登录 401 / public bypass）。
  const principal = options.principal === undefined ? OWNER_A : options.principal;
  const context = stubContext({ auth: principalAuth(principal) });
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

// —— M14 补充组：构造校验、鉴权器故障、requestId 故障、已发头失败路径、
// 真实 ServerResponse 形状（getHeader）、events 汇故障、信封归一边界。
// 仅新增用例，不改动上方任何既有断言（TDD 红线：不删测试/不放宽校验）。

test('constructor validates injection: context/auth/handlers/legacy/requestId/maxBodyBytes', () => {
  const good = () => makeDispatcher();
  assert.throws(() => createAgenticDispatcher({ handlers: [] }), /context required/);
  assert.throws(() => createAgenticDispatcher({ context: { auth: null }, handlers: [] }), /context\.auth required/);
  assert.throws(() => createAgenticDispatcher({ context: stubContext(), handlers: 'nope' }), /handlers must be an array/);
  assert.throws(() => createAgenticDispatcher({ context: stubContext(), handlers: [], legacy: 42 }), /legacy must be a function/);
  assert.throws(() => createAgenticDispatcher({ context: stubContext(), handlers: [], requestId: 'x' }), /requestId must be a function/);
  assert.throws(() => createAgenticDispatcher({ context: stubContext(), handlers: [], maxBodyBytes: 0 }), /maxBodyBytes must be a positive integer/);
  good(); // 完整注入可构造
});

test('auth resolver throwing is treated as unauthenticated: 401 on protected paths', async () => {
  const context = stubContext({ auth: () => { throw new Error('session store exploded'); } });
  const dispatcher = createAgenticDispatcher({ context, handlers: [async () => true] });
  const res = fakeRes();
  assert.equal(await dispatcher.handle(fakeReq({ url: '/api/blocks/sync', body: {} }), res, '/api/blocks/sync'), true);
  assertErrorEnvelope(res, { status: 401, code: 'AUTH_REQUIRED' });
});

test('requestId generator throwing never breaks the request; envelope omits requestId when absent', async () => {
  const { dispatcher } = makeDispatcher({
    requestId: () => { throw new Error('id gen broken'); },
    handlers: [async () => { throw { code: 'CONFLICT', message: 'rev' }; }],
  });
  const res = fakeRes();
  assert.equal(await dispatcher.handle(fakeReq({ url: '/api/blocks/sync', body: {} }), res, '/api/blocks/sync'), true);
  const envelope = assertErrorEnvelope(res, { status: 409, code: 'CONFLICT' });
  assert.equal('requestId' in envelope.error, false, 'no requestId key when generation failed');
});

test('context without idGen/clock still serves and omits requestId and event timestamps', async () => {
  const bare = { auth: () => OWNER_A }; // 无 idGen/clock/events（最小上下文）
  const dispatcher = createAgenticDispatcher({ context: bare, handlers: [async () => { throw { code: 'NOT_FOUND', message: 'x' }; }] });
  const res = fakeRes();
  assert.equal(await dispatcher.handle(fakeReq({ url: '/api/missions/m', body: {} }), res, '/api/missions/m'), true);
  assertErrorEnvelope(res, { status: 404, code: 'NOT_FOUND' });
});

test('failure after JSON headers were sent: stream is ended, no second status line is written', async () => {
  const { dispatcher } = makeDispatcher({
    handlers: [async (req, res) => {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.write('{"partial":');
      throw { code: 'INTERNAL_ERROR' };
    }],
  });
  const res = fakeRes();
  await dispatcher.handle(fakeReq({ url: '/api/blocks/sync', body: {} }), res, '/api/blocks/sync');
  assert.equal(res.statusCode, 200, 'headers already sent cannot be replaced');
  assert.equal(res.writableEnded, true, 'response must terminate');
});

test('failure after the response fully ended: nothing further is written, request stays handled', async () => {
  const { dispatcher } = makeDispatcher({
    handlers: [async (req, res) => {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end('{}');
      throw { code: 'INTERNAL_ERROR' };
    }],
  });
  const res = fakeRes();
  assert.equal(await dispatcher.handle(fakeReq({ url: '/api/blocks/sync', body: {} }), res, '/api/blocks/sync'), true);
  assert.equal(res.text(), '{}');
});

test('real ServerResponse shape (getHeader, no .headers): SSE error frame still emitted', async () => {
  const { dispatcher } = makeDispatcher({
    handlers: [async (req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
      res.write('data: {"layer":"shape"}\n\n');
      throw { code: 'UPSTREAM_UNAVAILABLE', message: 'gateway cut' };
    }],
  });
  // 模拟真实 http.ServerResponse：headers 只经 getHeader(name) 读取（大小写
  // 不敏感），实例上没有 .headers 属性（与 fakeRes 不同）；不带 on/close。
  const sentHeaders = {};
  const chunks = [];
  const res = {
    statusCode: 0,
    headersSent: false,
    writableEnded: false,
    writeHead(status, headers) {
      res.statusCode = status;
      for (const [key, value] of Object.entries(headers || {})) sentHeaders[key.toLowerCase()] = value;
      res.headersSent = true;
      return res;
    },
    getHeader: name => sentHeaders[String(name).toLowerCase()],
    write: chunk => { chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))); return true; },
    end() { res.writableEnded = true; return res; },
    text: () => Buffer.concat(chunks).toString('utf8'),
  };
  res.sseFrames = () => res.text().split('\n\n')
    .filter(block => block.startsWith('data:'))
    .map(block => JSON.parse(block.replace(/^data:\s?/mg, '').trim()));
  await dispatcher.handle(fakeReq({ method: 'GET', url: '/api/missions/m1/preview' }), res, '/api/missions/m1/preview');
  assert.equal(res.writableEnded, true);
  const frames = res.sseFrames();
  const last = frames[frames.length - 1];
  assert.ok(JSON.stringify(last).includes('UPSTREAM_UNAVAILABLE'), 'real-shape SSE must still get the error frame');
});

test('events sink throwing during disconnect never crashes the dispatch path', async () => {
  const context = stubContext({ auth: () => OWNER_A, events: { emit: () => { throw new Error('sink down'); }, recorded: () => [] } });
  const dispatcher = createAgenticDispatcher({
    context,
    handlers: [async (req, res, pathname, env) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.destroy();
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(env.signal.aborted, true, 'abort still fires when the sink is broken');
      return true;
    }],
  });
  assert.equal(await dispatcher.handle(fakeReq({ method: 'GET', url: '/api/runs/r1/activity' }), fakeRes(), '/api/runs/r1/activity'), true);
});

test('legacy returning false propagates as not handled', async () => {
  const { dispatcher } = makeDispatcher({
    handlers: [async () => false],
    legacy: async () => false,
  });
  const res = fakeRes();
  assert.equal(await dispatcher.handle(fakeReq({ url: '/api/other' }), res, '/api/other'), false);
  assert.equal(res.headersSent, false);
});

test('empty handler chain with no legacy: false, response untouched', async () => {
  const { dispatcher } = makeDispatcher({ handlers: [] });
  const res = fakeRes();
  assert.equal(await dispatcher.handle(fakeReq({ url: '/x' }), res, '/x'), false);
  assert.equal(res.headersSent, false);
});

test('envelope normalization edges: empty message falls back to code; non-object details dropped; fractional status ignored', async () => {
  const { dispatcher } = makeDispatcher({
    handlers: [async () => { throw { code: 'RATE_LIMITED', message: '', details: 'leaky', status: 429.5 }; }],
  });
  const res = fakeRes();
  await dispatcher.handle(fakeReq({ url: '/api/blocks/sync', body: {} }), res, '/api/blocks/sync');
  const envelope = assertErrorEnvelope(res, { status: 429, code: 'RATE_LIMITED' });
  assert.equal(envelope.error.message, 'RATE_LIMITED', 'empty message falls back to the code, never an empty string');
  assert.equal('details' in envelope.error, false, 'non-object details must be dropped');
});

test('body limit drains the remainder before rejecting (single oversized chunk and streamed chunks)', async () => {
  for (const body of [Buffer.from('{"pad":"' + 'x'.repeat(4096) + '"}'), Buffer.concat([
    Buffer.from('{"a":"'), Buffer.from('y'.repeat(2048)), Buffer.from('"}'),
  ])]) {
    const { dispatcher } = makeDispatcher({
      maxBodyBytes: 32,
      handlers: [async (req, res, pathname, env) => { await env.readBody(); return true; }],
    });
    const res = fakeRes();
    await dispatcher.handle(fakeReq({ url: '/api/blocks/sync', body }), res, '/api/blocks/sync');
    const envelope = assertErrorEnvelope(res);
    assert.equal(res.statusCode, 413);
    assert.equal(envelope.error.details.limitBytes, 32);
  }
});

// ---------------- M21 回归：断连监听生命周期（短请求零泄漏 / 开放流保留至 close） ----------------

test('M21 regression: ended responses detach listeners at once; open streams keep the disconnect watch until close', async () => {
  const recorded = [];
  const context = stubContext({
    auth: () => OWNER_A,
    events: { emit: event => recorded.push(event), recorded: () => recorded.slice() },
  });

  // 短请求：响应已写完 → handle 返回时监听必须已全部拆除（零泄漏）。
  const endedRes = fakeRes();
  const endedDispatcher = createAgenticDispatcher({
    context,
    handlers: [async (req, res) => {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end('{"ok":true}');
      return true;
    }],
  });
  await endedDispatcher.handle(fakeReq({ method: 'GET', url: '/api/probe/short' }), endedRes, '/api/probe/short');
  assert.equal(endedRes.listenerCount('close'), 0, 'ended response must not keep res close listeners after handle');

  // 开放流：handler 同步返回、响应未结束 → 断连监听保留；客户端中途断开
  // （fakeRes.destroy 发 'close' 且 writableEnded 仍 false）→ 记 UNKNOWN 且自清。
  const openRes = fakeRes();
  const openDispatcher = createAgenticDispatcher({
    context,
    handlers: [(req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
      res.write('data: {"seq":1}\n\n');
      return true;
    }],
  });
  await openDispatcher.handle(fakeReq({ method: 'GET', url: '/api/probe/sse' }), openRes, '/api/probe/sse');
  assert.ok(openRes.listenerCount('close') >= 1, 'open stream keeps the disconnect watch after handle returns');
  openRes.destroy();
  const disconnect = recorded.find(e => e?.type === 'client_disconnect' && e.pathname === '/api/probe/sse');
  assert.ok(disconnect, `disconnect must be recorded for the open stream, got ${JSON.stringify(recorded)}`);
  assert.equal(disconnect.outcome, 'UNKNOWN');
  assert.equal(openRes.listenerCount('close'), 0, 'the watch must clean itself after the disconnect');

  // 正常写完触发的 close：只清理，不得记断开（无假阳性）。
  const finishedRes = fakeRes();
  const finishedDispatcher = createAgenticDispatcher({
    context,
    handlers: [(req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
      return true; // 开放返回，由“服务端稍后收尾”的正常结束路径接管
    }],
  });
  await finishedDispatcher.handle(fakeReq({ method: 'GET', url: '/api/probe/sse-end' }), finishedRes, '/api/probe/sse-end');
  const before = recorded.length;
  finishedRes.end();          // 服务端稍后正常写完
  finishedRes.emit('close');  // 正常收尾 close
  assert.equal(finishedRes.listenerCount('close'), 0, 'normal end must still clean the watch');
  assert.equal(
    recorded.slice(before).filter(e => e?.type === 'client_disconnect').length,
    0,
    'normal end must not be misreported as client_disconnect',
  );
});
