// S2D-W13 · M18 serve-mount 规格测试（scripts/serve-tango.mjs options.agentic 注入）。
//
// 依据：brief §3「scripts/serve-tango.mjs：把集成 route dispatcher 作为可注入
// 选项挂载，保持既有 legacy route、origin/auth 和错误语义；无配置时既有服务
// 行为不变」、§4.2「handler 返回 handled:boolean，未处理请求落回 legacy
// server」、plan.md §G3 M18（同 options.collaboration 先例 :106-112）。
//
// 挂载契约：
//   createTangoServer({ agentic: { handle(req,res,pathname) } }) —— handle 即
//   M14 createAgenticDispatcher() 返回形状；真值=已处理（响应已写完，直接返回），
//   falsy=未处理（body 未读、响应未触碰）→ 原样落回 legacy 流程（collaboration
//   鉴权/origin 与静态语义逐字节不变，apiRequest 状态如同本分支未运行）。
//   分支只吃 /api/agentic/ 前缀，且置于 collaboration /api/ 鉴权块之前
//   （dispatcher 的冻结信封与 M17 免鉴权健康路径不得被 tango 401 抢答）；
//   origin 语义与既有 API 分支一致（collaboration.requestAllowed /
//   allowedHosts + origin 匹配）。options.agentic 缺省时分支完全不参与。
//
// 全部走真实 http.Server + fetch（M14 的 fake req/res 已被其自身 38 用例锁定；
// 本文件钉的是挂载层：真 socket、真 header、真静态回退）。端口一律 listen(0)
// 临时分配，不占 17701-17719 预算。
//
// TDD：serve-tango 未实现 options.agentic → 挂载组 RED；无配置组同时锁定基线。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { createTangoServer } from '../../../../scripts/serve-tango.mjs';
import { createIntegrationContext } from '../../../../scripts/agentic/integration/context.mjs';
import { createAgenticDispatcher } from '../../../../scripts/agentic/integration/dispatcher.mjs';
import { createHealthHandler } from '../../../../scripts/agentic/integration/health.mjs';
import { openAgenticDb } from '../../../../scripts/agentic/db/index.mjs';
import { createCollaborationService } from '../../../../scripts/collaboration-service.mjs';
import { makeClock } from './_helpers.mjs';

const SPEECH = { available: false, languages: [] };
const ASSISTANT = {
  configuration: () => ({ available: true, model: 'fixture-standard', models: { standard: 'fixture-standard' } }),
  chat: async () => ({ content: [{ type: 'text', text: '{"reply":"ok","actions":[]}' }] }),
};
const OWNER = { ownerId: 'w13-mount-owner', id: 'w13-mount-owner' };
const FIXTURE_HEADER = { 'x-w13-fixture': '1' };
const fixtureAuth = req => (req.headers['x-w13-fixture'] === '1' ? OWNER : null);

function echoHandler() {
  return async (req, res, pathname, env) => {
    if (pathname !== '/api/agentic/echo-test' || req.method !== 'POST') return false;
    const body = await env.readBody();
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ echo: body, owner: env.principal === null ? null : env.principal.ownerId }));
    return true;
  };
}

function streamHandler() {
  return (req, res, pathname) => {
    if (pathname !== '/api/agentic/stream-test' || req.method !== 'GET') return false;
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store' });
    res.write('data: {"n":1}\n\n');
    res.write('data: {"n":2}\n\n');
    res.end();
    return true;
  };
}

/** 真实 M13 组合根 + M14 dispatcher + M17 health 的挂载件（无外部调用）。 */
function makeAgentic({ auth = () => null, handlers = [] } = {}) {
  const clock = makeClock('2026-10-28T12:00:00.000Z');
  const context = createIntegrationContext({ db: openAgenticDb(':memory:'), now: clock.now, auth });
  context.handlers = ['/api/agentic/health', ...handlers.map(() => '/api/agentic/*')];
  return createAgenticDispatcher({
    context,
    handlers: [createHealthHandler(context), ...handlers],
  });
}

async function startServer(t, options) {
  const server = createTangoServer({ speechCapabilities: async () => SPEECH, ...options });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  t.after(() => new Promise(resolve => server.close(resolve)));
  return { server, port, origin: 'http://127.0.0.1:' + port };
}

async function startCollab(t, extra) {
  const collaboration = await createCollaborationService({ databaseFile: ':memory:', assistant: ASSISTANT, allowLocalAccounts: true });
  t.after(() => collaboration.close());
  return startServer(t, { collaboration, ...extra });
}

async function call(origin, path, { method = 'GET', headers = {}, body } = {}) {
  const response = await fetch(origin + path, { method, headers, body });
  const text = await response.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* 非 JSON（静态 404/HTML）保持 null */ }
  return { status: response.status, headers: response.headers, text, body: parsed };
}

async function register(origin, username) {
  const response = await fetch(origin + '/api/auth/local-register', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin, 'x-tango-client': 'tango-settings/1' },
    body: JSON.stringify({ username, password: 'MountPass123', displayName: username }),
  });
  assert.equal(response.status, 200, await response.text());
  return response.headers.get('set-cookie')?.split(';')[0];
}

function rawRequest(port, { path, host, origin, method = 'GET' }) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: '127.0.0.1', port, method, path, setHost: false, headers: { ...(host ? { host } : {}), ...(origin ? { origin } : {}) } },
      res => { let text = ''; res.on('data', chunk => { text += chunk; }); res.on('end', () => resolve({ status: res.statusCode, text })); },
    );
    req.on('error', reject);
    req.end();
  });
}

// ---------------- A. 无配置：legacy 行为逐字节不变（基线锁定，改造前后都必须绿） ----------------

test('no options.agentic: agentic paths stay legacy static misses (404, no collaboration)', async t => {
  const { origin } = await startServer(t);
  const health = await call(origin, '/api/agentic/health');
  assert.equal(health.status, 404);
  assert.equal(health.body, null);
  assert.equal((await call(origin, '/api/agentic/blocks')).status, 404);
});

test('no options.agentic: collaboration still owns /api/ auth for agentic paths (401 tango envelope)', async t => {
  const { origin } = await startCollab(t);
  const denied = await call(origin, '/api/agentic/health');
  assert.equal(denied.status, 401);
  assert.equal(denied.body.error, 'AUTH_REQUIRED'); // 扁平 tango 信封，不是冻结信封
  assert.equal(denied.body.error.code, undefined);
});

// ---------------- B. 挂载：dispatcher 全权接管 /api/agentic/ 前缀 ----------------

test('mounted dispatcher answers /api/agentic/health unauthenticated with the frozen 200', async t => {
  const { origin } = await startServer(t, { agentic: makeAgentic() });
  const health = await call(origin, '/api/agentic/health');
  assert.equal(health.status, 200);
  assert.equal(health.body.status, 'ok');
  assert.equal(health.body.generatedAt, '2026-10-28T12:00:00.000Z');
  assert.match(health.headers.get('content-type') || '', /application\/json/);
  assert.equal(health.headers.get('cache-control'), 'no-store');
  // 外层安全头不被 dispatcher 覆盖（setHeader 先于挂载分支，writeHead 合并保留）
  assert.equal(health.headers.get('x-content-type-options'), 'nosniff');
});

test('mounted: health stays public even with collaboration mounted (agentic branch precedes the /api/ auth block)', async t => {
  const { origin } = await startCollab(t, { agentic: makeAgentic() });
  const health = await call(origin, '/api/agentic/health');
  assert.equal(health.status, 200);
  assert.equal(health.body.status, 'ok');
});

test('mounted: protected agentic paths get the frozen 401 envelope, not the tango one', async t => {
  const { origin } = await startCollab(t, { agentic: makeAgentic() });
  const denied = await call(origin, '/api/agentic/blocks');
  assert.equal(denied.status, 401);
  assert.equal(denied.body.error.code, 'AUTH_REQUIRED'); // 冻结信封：error 为对象
  assert.equal(typeof denied.body.error.message, 'string');
});

// ---------------- C. 未处理落回 legacy（handled=false → 如同分支未运行） ----------------

test('mounted, unhandled path falls back to the exact no-collaboration legacy result (bare 404)', async t => {
  const { origin } = await startServer(t, { agentic: makeAgentic({ auth: fixtureAuth }) });
  const miss = await call(origin, '/api/agentic/nope', { headers: FIXTURE_HEADER }); // 已过 dispatcher 鉴权、无 handler 命中
  assert.equal(miss.status, 404);
  assert.equal(miss.body, null); // 不是 503 JSON：apiRequest 未被挂载分支置位
});

test('mounted + collaboration, unhandled path reproduces the unmounted legacy answer (503 static-miss semantics)', async t => {
  const mounted = await startCollab(t, { agentic: makeAgentic({ auth: fixtureAuth }) });
  const plain = await startCollab(t);
  const cookie = await register(mounted.origin, 'fallthrough-mount');
  const plainCookie = await register(plain.origin, 'fallthrough-plain');
  const headers = { cookie, ...FIXTURE_HEADER };
  const a = await call(mounted.origin, '/api/agentic/nope', { headers });
  const b = await call(plain.origin, '/api/agentic/nope', { headers: { cookie: plainCookie } });
  assert.equal(a.status, 503);
  assert.equal(a.body.error, 'service-unavailable');
  assert.equal(b.status, 503); // 挂载与否，落回结果一致
  assert.equal(a.body.error, b.body.error);
});

// ---------------- D. origin 语义保持（挂载分支与既有 API 分支同门） ----------------

test('mounted: foreign Host header is rejected before dispatch (403 origin-rejected)', async t => {
  const { port } = await startServer(t, { agentic: makeAgentic() });
  const evil = await rawRequest(port, { path: '/api/agentic/health', host: 'evil.example:9999' });
  assert.equal(evil.status, 403);
  assert.equal(JSON.parse(evil.text).error, 'origin-rejected');
});

test('mounted: mismatched Origin header is rejected even with a valid Host', async t => {
  const { port } = await startServer(t, { agentic: makeAgentic() });
  const cross = await rawRequest(port, { path: '/api/agentic/health', host: '127.0.0.1:' + port, origin: 'http://evil.example' });
  assert.equal(cross.status, 403);
  assert.equal(JSON.parse(cross.text).error, 'origin-rejected');
});

// ---------------- E. 挂载不扰动 legacy 路由 ----------------

test('mounted: legacy /api/status, static root and collaboration auth keep working', async t => {
  const { origin } = await startCollab(t, { agentic: makeAgentic() });
  const status = await call(origin, '/api/status');
  assert.equal(status.status, 200);
  assert.equal(status.body.app, 'Tango');
  const page = await call(origin, '/');
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type') || '', /text\/html/);
  assert.equal((await register(origin, 'legacy-alive')).length > 0, true);
});

// ---------------- F. 真实 socket 上的 body/SSE 走 dispatcher ----------------

test('mounted: POST body flows through env.readBody with principal; unauthenticated stays 401', async t => {
  const { origin } = await startServer(t, { agentic: makeAgentic({ auth: fixtureAuth, handlers: [echoHandler()] }) });
  const denied = await call(origin, '/api/agentic/echo-test', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hello: 'world' }) });
  assert.equal(denied.status, 401);
  assert.equal(denied.body.error.code, 'AUTH_REQUIRED');
  const ok = await call(origin, '/api/agentic/echo-test', { method: 'POST', headers: { 'content-type': 'application/json', ...FIXTURE_HEADER }, body: JSON.stringify({ hello: 'world' }) });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.echo.hello, 'world');
  assert.equal(ok.body.owner, 'w13-mount-owner');
});

test('mounted: oversized body hits the unified 413 envelope through the real socket', async t => {
  const clock = makeClock('2026-10-28T12:00:00.000Z');
  const context = createIntegrationContext({ db: openAgenticDb(':memory:'), now: clock.now, auth: fixtureAuth });
  context.handlers = [];
  const dispatcher = createAgenticDispatcher({ context, handlers: [echoHandler()], maxBodyBytes: 256 });
  const { origin } = await startServer(t, { agentic: dispatcher });
  const big = await call(origin, '/api/agentic/echo-test', { method: 'POST', headers: { 'content-type': 'application/json', ...FIXTURE_HEADER }, body: 'x'.repeat(300) });
  assert.equal(big.status, 413);
  assert.equal(big.body.error.code, 'CONTRACT_INVALID');
  assert.equal(big.body.error.details.limitBytes, 256);
});

test('mounted: SSE frames and headers pass through the real server untouched', async t => {
  const { origin } = await startServer(t, { agentic: makeAgentic({ auth: fixtureAuth, handlers: [streamHandler()] }) });
  const response = await fetch(origin + '/api/agentic/stream-test', { headers: FIXTURE_HEADER });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') || '', /text\/event-stream/);
  const text = await response.text();
  assert.equal(text, 'data: {"n":1}\n\ndata: {"n":2}\n\n'); // 不注入 [DONE]、不改帧
});

// ---------------- G. 注入形状构造门（接线错误在 createTangoServer 就炸） ----------------

test('malformed options.agentic fails fast at server construction', () => {
  assert.throws(() => createTangoServer({ agentic: {} }), /agentic/i);
  assert.throws(() => createTangoServer({ agentic: { handle: 'not-a-function' } }), /agentic/i);
});
