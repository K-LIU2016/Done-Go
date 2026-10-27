// S2D-W13 · M13 组合根（scripts/agentic/integration/context.mjs）规格测试。
// 依据：brief §4.1「统一依赖容器」、plan.md M13、红线 4（集成路径禁隐藏 wall
// clock、第二 auth/db、读 key、外部调用）。
//
// TDD：本文件先行提交时 scripts/agentic/integration/ 尚不存在 → RED
// （ERR_MODULE_NOT_FOUND），M13 落地后转 GREEN；不删测试、不放宽校验。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createIntegrationContext } from '../../../../scripts/agentic/integration/context.mjs';
import { makeClock, fakeReq } from './_helpers.mjs';

const PRINCIPAL = { ownerId: 'owner-a', actor: 'user:owner-a' };

function baseOptions(overrides = {}) {
  const clock = makeClock();
  return {
    db: { prepare: () => ({ get: () => undefined, all: () => [], run: () => undefined }), exec: () => undefined },
    auth: () => PRINCIPAL,
    now: clock.now,
    ...overrides,
  };
}

test('M13 rejects construction without an injected clock (no hidden wall clock)', () => {
  assert.throws(() => createIntegrationContext(baseOptions({ now: undefined })), /clock|now/i);
});

test('M13 rejects construction without a principal resolver (no hidden second auth)', () => {
  assert.throws(() => createIntegrationContext(baseOptions({ auth: undefined })), /auth/i);
});

test('M13 rejects an async principal resolver: the W10 observability adapter must stay synchronous', () => {
  assert.throws(() => createIntegrationContext(baseOptions({ auth: async () => PRINCIPAL })), /sync|promise|auth/i);
});

test('M13 reuses the injected db instance verbatim (no second db)', () => {
  const db = baseOptions().db;
  const context = createIntegrationContext(baseOptions({ db }));
  assert.equal(context.db, db);
});

test('M13 clock.now() follows the injected deterministic time, never a wall clock', () => {
  const clock = makeClock('2026-10-28T08:00:00.000Z');
  const context = createIntegrationContext(baseOptions({ now: clock.now }));
  assert.equal(context.clock.now(), '2026-10-28T08:00:00.000Z');
  clock.tick(5);
  assert.equal(context.clock.now(), '2026-10-28T08:00:05.000Z');
});

test('M13 exposes the four frozen auth shapes from one principal resolver', () => {
  const context = createIntegrationContext(baseOptions());
  const req = fakeReq({ method: 'GET' });
  // W1 blocks / W12 perception: { authenticate(req) }
  assert.equal(context.auth.forBlocks(req), PRINCIPAL);
  assert.equal(context.auth.forPerception(req), PRINCIPAL);
  // W3 mission: { ownerId(req) }
  assert.equal(context.auth.forMission(req), 'owner-a');
  // W6 preview / W8 bridge / W9 delivery+inbox / W10 observability: auth(req) -> {ownerId}
  assert.equal(context.auth.forPreview(req), PRINCIPAL);
  assert.equal(context.auth.forBridge(req), PRINCIPAL);
  assert.equal(context.auth.forDelivery(req), PRINCIPAL);
  assert.equal(context.auth.forInbox(req), PRINCIPAL);
  assert.equal(context.auth.forObservability(req), PRINCIPAL);
});

test('M13 observability adapter returns a plain value, never a Promise', () => {
  const context = createIntegrationContext(baseOptions());
  const resolved = context.auth.forObservability(fakeReq({ method: 'GET' }));
  assert.notEqual(resolved, undefined);
  assert.equal(resolved instanceof Promise, false);
});

test('M13 unauthenticated requests resolve to null/undefined across all adapter shapes', () => {
  const context = createIntegrationContext(baseOptions({ auth: () => null }));
  const req = fakeReq({ method: 'GET' });
  assert.equal(context.auth.forBlocks(req), null);
  assert.equal(context.auth.forMission(req), undefined);
  assert.equal(context.auth.forPreview(req), null);
  assert.equal(context.auth.forObservability(req), null);
});

test('M13 default policy port is fail-closed: check() never allows', () => {
  const context = createIntegrationContext(baseOptions());
  let outcome;
  try {
    outcome = context.policyPort.check({ ownerId: 'owner-a', actor: 'user:owner-a' }, { kind: 'A3', action: 'side-effect' });
  } catch (error) {
    outcome = { allowed: false, error: error.message }; // throwing is an acceptable fail-closed form
  }
  assert.equal(outcome?.allowed === true, false, 'default policy port must not allow anything');
});

test('M13 uses an injected policy port verbatim', () => {
  const seen = [];
  const policyPort = { check: (ctxInfo, action) => { seen.push({ ctxInfo, action }); return { allowed: true }; } };
  const context = createIntegrationContext(baseOptions({ policyPort }));
  assert.deepEqual(context.policyPort.check({ ownerId: 'o' }, { kind: 'A1' }), { allowed: true });
  assert.equal(seen.length, 1);
});

test('M13 records emitted events in order through the shared sink', () => {
  const context = createIntegrationContext(baseOptions());
  context.events.emit({ type: 'run.started', runId: 'r1' });
  context.events.emit({ type: 'step.checkpointed', runId: 'r1', step: 2 });
  const recorded = typeof context.events.recorded === 'function' ? context.events.recorded() : context.events;
  assert.equal(recorded[0].type, 'run.started');
  assert.equal(recorded[1].type, 'step.checkpointed');
});

test('M13 idGen yields unique ids and honors an injected generator', () => {
  const generated = ['w13-a', 'w13-b'];
  let cursor = 0;
  const context = createIntegrationContext(baseOptions({ idGen: { next: () => generated[cursor++] } }));
  assert.equal(context.idGen.next(), 'w13-a');
  assert.equal(context.idGen.next(), 'w13-b');
  const fallback = createIntegrationContext(baseOptions());
  assert.notEqual(fallback.idGen.next(), fallback.idGen.next());
});
