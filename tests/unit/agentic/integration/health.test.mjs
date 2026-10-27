// S2D-W13 · M17 集成健康检查（scripts/agentic/integration/health.mjs）规格测试。
// 依据：brief §3「集成健康检查」、§5.8/M26（发布候选启动后 /api/agentic/health
// 可读）；plan.md M17：db+_migrations 台账、路由注册表、上游配置在位性
// （不回显 secret）、容器自检。
//
// TDD：实现落地前 RED（ERR_MODULE_NOT_FOUND）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHealthHandler } from '../../../../scripts/agentic/integration/health.mjs';
import { fakeReq, fakeRes, makeClock, stubContext } from './_helpers.mjs';

const CANARY = 'canary-secret-w13-do-not-leak';

function contextWithDb(db, overrides = {}) {
  const clock = makeClock('2026-10-28T10:00:00.000Z');
  return stubContext({
    db,
    clock,
    auth: () => ({ ownerId: 'owner-a', actor: 'user:owner-a' }),
    ...overrides,
  });
}

function healthyDb() {
  const rows = { _migrations: [{ name: 'blocks-001-blocks.sql' }, { name: 'engine-001-runs.sql' }] };
  return {
    prepare: sql => ({
      all: () => (String(sql).includes('_migrations') ? rows._migrations : []),
      get: () => undefined,
      run: () => undefined,
    }),
    exec: () => undefined,
  };
}

async function getHealth(handler) {
  const res = fakeRes();
  const handled = await handler(fakeReq({ method: 'GET', url: '/api/agentic/health' }), res, '/api/agentic/health');
  return { res, handled };
}

test('GET /api/agentic/health answers ok with db, migration ledger and route registry', async () => {
  process.env.W13_HEALTH_CANARY = CANARY;
  try {
    const handler = createHealthHandler(contextWithDb(healthyDb(), {
      handlers: ['/api/blocks', '/api/missions', '/api/agentic/health'],
    }));
    const { res, handled } = await getHealth(handler);
    assert.equal(handled, true);
    assert.equal(res.statusCode, 200);
    assert.match(res.headers['content-type'] || '', /^application\/json/);
    const body = res.json();
    assert.equal(body.status, 'ok');
    assert.equal(body.db.ok, true);
    assert.ok(Array.isArray(body.db.migrations) && body.db.migrations.length >= 1, 'ledger must be visible');
    assert.ok(Array.isArray(body.routes) && body.routes.includes('/api/blocks'), 'route registry must be visible');
    const serialized = JSON.stringify(body);
    assert.ok(!serialized.includes(CANARY), 'health must not echo environment secrets');
    assert.ok(!/sk-[A-Za-z0-9]{8,}/.test(serialized), 'health must not echo key material');
  } finally {
    delete process.env.W13_HEALTH_CANARY;
  }
});

test('health reflects the deterministic container clock, not a wall clock', async () => {
  const clock = makeClock('2026-10-28T10:00:00.000Z');
  const handler = createHealthHandler(contextWithDb(healthyDb(), { clock }));
  const { res } = await getHealth(handler);
  const body = res.json();
  assert.ok(body.generatedAt !== undefined, 'health should timestamp itself for audit');
  assert.equal(body.generatedAt, '2026-10-28T10:00:00.000Z');
});

test('health is readable without authentication (release-check path)', async () => {
  const handler = createHealthHandler(contextWithDb(healthyDb(), { auth: () => null }));
  const { res } = await getHealth(handler);
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().status, 'ok');
});

test('broken db flips health to 503 with a frozen-envelope error', async () => {
  const brokenDb = { prepare: () => { throw new Error('sqlite disk image is malformed'); }, exec: () => undefined };
  const handler = createHealthHandler(contextWithDb(brokenDb));
  const res = fakeRes();
  const handled = await handler(fakeReq({ method: 'GET', url: '/api/agentic/health' }), res, '/api/agentic/health');
  assert.equal(handled, true);
  assert.equal(res.statusCode, 503);
  const body = res.json();
  assert.ok(body.error && typeof body.error.code === 'string' && body.error.code.length > 0);
  assert.ok(body.error.message.length > 0);
});

test('non-GET health is not handled by the health handler (falls through to legacy)', async () => {
  const handler = createHealthHandler(contextWithDb(healthyDb()));
  const res = fakeRes();
  const handled = await handler(fakeReq({ method: 'POST', url: '/api/agentic/health', body: {} }), res, '/api/agentic/health');
  assert.equal(handled, false);
  assert.equal(res.headersSent, false);
});

test('health lists upstream configuration presence without values', async () => {
  const handler = createHealthHandler(contextWithDb(healthyDb(), {
    upstreams: { gateway: { configured: true, endpoint: 'https://gw.example.invalid' }, bridge: { configured: false } },
  }));
  const { res } = await getHealth(handler);
  const serialized = res.text();
  assert.ok(serialized.includes('upstream') || serialized.includes('gateway'), 'upstream presence should be reported');
  assert.ok(!serialized.includes('keys'), 'must not report key names/values');
});

// ---------------- 补充组（实现节点新增；只增强，不放宽既有断言） ----------------
// 覆盖 plan.md M17 全分支：注册表投影、上游投影卫生学、容器 fail-closed、
// 构造期接线门、路径门。RED 组 6 用例保持逐字不动。

test('route registry projection keeps string prefixes and {prefix|name} labels, skips functions and blanks', async () => {
  const handler = createHealthHandler(contextWithDb(healthyDb(), {
    handlers: [
      '/api/blocks',
      '',
      { prefix: '/api/missions' },
      { name: '/api/preview' },
      { prefix: '', name: '' },
      () => true,
      null,
    ],
  }));
  const { res } = await getHealth(handler);
  assert.deepEqual(res.json().routes, ['/api/blocks', '/api/missions', '/api/preview']);
});

test('upstream projection sanitizes endpoints (query stripped, secret-shaped dropped) and whitelists fields', async () => {
  const handler = createHealthHandler(contextWithDb(healthyDb(), {
    upstreams: {
      gateway: { configured: true, endpoint: 'https://gw.example.invalid/v1?token=abc', apiKey: 'sk-shouldnotappear1' },
      codex: { configured: true, endpoint: 'https://x.invalid/ia/sk-shouldnotappear2/v1' },
      qclean: { configured: true, endpoint: 'https://q.invalid/v1?token=sk-strippedbyquery123' },
      bridge: { configured: false },
      malformed: 'not-an-object',
      empty: { configured: true, endpoint: '' },
    },
  }));
  const { res } = await getHealth(handler);
  const body = res.json();
  assert.deepEqual(body.upstreams.gateway, { configured: true, endpoint: 'https://gw.example.invalid/v1' });
  assert.deepEqual(body.upstreams.codex, { configured: true }, 'secret-shaped endpoint must be dropped entirely');
  assert.deepEqual(body.upstreams.qclean, { configured: true, endpoint: 'https://q.invalid/v1' }, 'query-embedded tokens are stripped, not dropped');
  assert.deepEqual(body.upstreams.bridge, { configured: false });
  assert.deepEqual(body.upstreams.malformed, { configured: false });
  assert.deepEqual(body.upstreams.empty, { configured: true });
  const serialized = res.text();
  assert.ok(!serialized.includes('shouldnotappear'), 'non-whitelisted upstream fields must never surface');
  assert.ok(!serialized.includes('apiKey'), 'field names of secret-bearing keys must not be echoed');
});

test('non-object upstreams input reports an empty presence map', async () => {
  for (const bad of [null, [], 'gateway', 42]) {
    const handler = createHealthHandler(contextWithDb(healthyDb(), { upstreams: bad }));
    const { res } = await getHealth(handler);
    assert.deepEqual(res.json().upstreams, {});
  }
});

test('missing optional container ports flip health to 503 with named subsystems (fail-closed)', async () => {
  const context = contextWithDb(healthyDb());
  delete context.traceSink;
  delete context.idGen;
  const handler = createHealthHandler(context);
  const { res, handled } = await getHealth(handler);
  assert.equal(handled, true);
  assert.equal(res.statusCode, 503);
  const body = res.json();
  assert.equal(body.error.code, 'UPSTREAM_UNAVAILABLE');
  assert.deepEqual(body.error.details.subsystems.sort(), ['idGen', 'traceSink']);
  assert.match(body.error.message, /traceSink/);
});

test('a throwing or non-string clock source fails the container check (no fake generatedAt)', async () => {
  for (const broken of [{ now: () => { throw new Error('clock exploded'); } }, { now: () => 42 }, { now: () => '' }]) {
    const handler = createHealthHandler(contextWithDb(healthyDb(), { clock: broken }));
    const { res } = await getHealth(handler);
    assert.equal(res.statusCode, 503, `clock ${JSON.stringify(String(broken.now))} must fail closed`);
    assert.ok(res.json().error.details.subsystems.includes('clock'));
    assert.ok(!res.text().includes('generatedAt'), 'an unhealthy report carries no timestamp it cannot trust');
  }
});

test('migration ledger probe filters non-string/empty names from raw rows', async () => {
  const db = {
    prepare: sql => ({
      all: () => (String(sql).includes('_migrations')
        ? [{ name: 'engine-001-runs.sql' }, { name: '' }, { other: 1 }, null]
        : []),
      get: () => undefined,
      run: () => undefined,
    }),
    exec: () => undefined,
  };
  const handler = createHealthHandler(contextWithDb(db));
  const { res } = await getHealth(handler);
  assert.deepEqual(res.json().db.migrations, ['engine-001-runs.sql']);
});

test('a GET on a different pathname is not handled (dispatcher ordering safe)', async () => {
  const handler = createHealthHandler(contextWithDb(healthyDb()));
  const res = fakeRes();
  const handled = await handler(fakeReq({ method: 'GET', url: '/api/blocks' }), res, '/api/blocks');
  assert.equal(handled, false);
  assert.equal(res.headersSent, false);
});

test('constructor rejects contexts missing the M13 wiring essentials', () => {
  assert.throws(() => createHealthHandler(null), /integration context/i);
  assert.throws(() => createHealthHandler(undefined), /integration context/i);
  const base = contextWithDb(healthyDb());
  assert.throws(() => createHealthHandler({ ...base, auth: 'nope' }), /context\.auth/i);
  assert.throws(() => createHealthHandler({ ...base, clock: null }), /context\.clock/i);
  assert.throws(() => createHealthHandler({ ...base, clock: {} }), /context\.clock/i);
  assert.throws(() => createHealthHandler({ ...base, db: { prepare: null } }), /context\.db/i);
});

// ---------------- 组合互操作（真实 M13 组合根 + M14 dispatcher 挂载） ----------------

test('health mounts through the real M13 context and M14 dispatcher public path, unauthenticated', async () => {
  const { createIntegrationContext } = await import('../../../../scripts/agentic/integration/context.mjs');
  const { createAgenticDispatcher } = await import('../../../../scripts/agentic/integration/dispatcher.mjs');
  const { openAgenticDb } = await import('../../../../scripts/agentic/db/index.mjs');

  const clock = makeClock('2026-10-28T10:00:00.000Z');
  const context = createIntegrationContext({
    db: openAgenticDb(':memory:'),
    auth: () => null, // release 探活：未登录
    now: clock.now,
  });
  // 挂载方约定：路由注册表标签挂在 context.handlers（health 读取的注册表来源），
  // dispatcher 的 handlers 只收 handler 函数（与 M14 签名一致）。
  context.handlers = ['/api/agentic/health', '/api/blocks'];
  const health = createHealthHandler(context);
  const dispatcher = createAgenticDispatcher({ context, handlers: [health] });

  const res = fakeRes();
  const handled = await dispatcher.handle(fakeReq({ method: 'GET', url: '/api/agentic/health' }), res, '/api/agentic/health');
  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.status, 'ok');
  assert.equal(body.generatedAt, '2026-10-28T10:00:00.000Z');
  assert.ok(body.db.migrations.length >= 1, 'real W0-migrated ledger must be visible');
  assert.ok(body.routes.includes('/api/agentic/health'), 'route registry from context.handlers');
  assert.deepEqual(body.upstreams, {});
  assert.equal(body.container.ok, true);
  assert.equal(res.headers['cache-control'], 'no-store');

  // 同一 dispatcher：受保护路径未登录仍 401（health 免鉴权不影响统一鉴权门）。
  const denied = fakeRes();
  await dispatcher.handle(fakeReq({ method: 'GET', url: '/api/blocks' }), denied, '/api/blocks');
  assert.equal(denied.statusCode, 401);
});
