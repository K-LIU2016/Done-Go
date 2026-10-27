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
