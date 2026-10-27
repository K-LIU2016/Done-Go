// S2D-W13 · M13 组合根接缝补充测试（context.test.mjs 之外的新增规格，TDD 补充 RED：
// 覆盖 plan.md M13 明列但主规格文件未展开的接缝——单台账 db、nowMs/W7·W8 时钟适配、
// W4 policy 桥（fail-closed/UNKNOWN 不吞）、traceSink→W10 store 映射、红线 4 自审）。
//
// 红线锚点：brief §4.1/§4.6、plan.md R-8/R-9/R-10；不删测试、不放宽校验。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createIntegrationContext,
  adaptClockForRuntime,
  adaptPolicyPortForRuntime,
} from '../../../../scripts/agentic/integration/context.mjs';
import { openAgenticDb } from '../../../../scripts/agentic/db/index.mjs';
import { validateClock, validatePolicyPort, readPolicyDecision } from '../../../../scripts/agentic/runtime/ports.mjs';
import { makeClock, fakeReq, fakeRes, tempDir } from './_helpers.mjs';

const PRINCIPAL = { ownerId: 'owner-a', actor: 'user:owner-a' };

function contextWith(overrides = {}) {
  const clock = makeClock();
  return createIntegrationContext({
    db: openAgenticDb(':memory:'),
    auth: () => PRINCIPAL,
    now: clock.now,
    ...overrides,
  });
}

// ---------------- db：单一 W0 migrate 台账 ----------------

test('M13 auto-migrates the injected db through the single W0 ledger and reports nothing new on a pre-migrated db', () => {
  const db = openAgenticDb(':memory:');
  const context = createIntegrationContext({ db, auth: () => PRINCIPAL, now: makeClock().now });
  assert.ok(context.appliedMigrations.length >= 1, 'fresh db must have applied the merged migrations');
  const again = createIntegrationContext({ db, auth: () => PRINCIPAL, now: makeClock().now });
  assert.deepEqual(again.appliedMigrations, [], 'second composition on the same db must apply zero migrations');
  const ledgers = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table'")
    .all()
    .map((row) => row.name)
    .filter((name) => name.startsWith('_'));
  assert.deepEqual(ledgers, ['_migrations'], 'only the single W0 ledger may exist');
});

test('M13 opens and migrates a dbFile itself (openAgenticDb + single ledger), idempotently across contexts', async () => {
  const { path, cleanup } = await tempDir('w13-context-db-');
  try {
    const file = join(path, 'agentic.sqlite');
    const first = contextWith({ db: undefined, dbFile: file });
    assert.ok(first.appliedMigrations.length >= 1);
    const second = contextWith({ db: undefined, dbFile: file });
    assert.deepEqual(second.appliedMigrations, [], 'reopening the same file must apply nothing');
    const spans = second.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='obs_spans'").all();
    assert.equal(spans.length, 1, 'merged migrations must create the observability projection table');
  } finally {
    await cleanup();
  }
});

test('M13 rejects construction with neither db nor dbFile, and with both at once (no hidden db)', () => {
  assert.throws(() => contextWith({ db: undefined, dbFile: undefined }), /db/i);
  assert.throws(() => contextWith({ dbFile: '/tmp/w13-ignored.sqlite' }), /db/i);
});

// ---------------- clock：确定性 + W7/W8 适配 ----------------

test('M13 clock.nowMs() is Date.parse of the injected now(); adaptClockForRuntime satisfies W7 validateClock', () => {
  const clock = makeClock('2026-10-28T08:30:00.000Z');
  const context = contextWith({ now: clock.now });
  assert.equal(context.clock.nowMs(), Date.parse('2026-10-28T08:30:00.000Z'));
  clock.tick(3);
  assert.equal(context.clock.nowMs(), Date.parse('2026-10-28T08:30:03.000Z'));
  const runtimeClock = adaptClockForRuntime(context.clock);
  validateClock(runtimeClock); // W7 shape: now() -> epoch ms, must not throw
  assert.equal(runtimeClock.now(), Date.parse('2026-10-28T08:30:03.000Z'));
});

test('M13 rejects a now() that is not a deterministic ISO string source', () => {
  assert.throws(() => contextWith({ now: () => 1769539200000 }), /clock|now|iso/i);
  assert.throws(() => contextWith({ now: () => 'not-a-timestamp' }), /clock|now|iso/i);
});

// ---------------- auth：thenable 运行期守卫与非法 principal ----------------

test('M13 auth adapters throw loudly on a thenable principal instead of silently treating it as anonymous', () => {
  const context = contextWith({ auth: () => Promise.resolve(PRINCIPAL) });
  assert.throws(() => context.auth.forObservability(fakeReq()), /sync|promise|auth/i);
});

test('M13 auth adapters treat a principal without a usable ownerId as unauthenticated', () => {
  const context = contextWith({ auth: () => ({ actor: 'user:x' }) });
  assert.equal(context.auth.forPreview(fakeReq()), null);
  assert.equal(context.auth.forMission(fakeReq()), undefined);
  assert.equal(context.auth.forBlocks(fakeReq()), null);
});

test('M13 auth adapters turn a throwing resolver into anonymous, except forObservability never returns a Promise', () => {
  const context = contextWith({ auth: () => { throw new Error('session store down'); } });
  assert.equal(context.auth.forBridge(fakeReq()), null);
  const resolved = context.auth.forObservability(fakeReq());
  assert.equal(resolved, null);
  assert.equal(resolved instanceof Promise, false);
});

// ---------------- events：注入 verbatim / 缺省台账 ----------------

test('M13 reuses an injected events sink verbatim', () => {
  const seen = [];
  const sink = { emit: (event) => seen.push(event) };
  const context = contextWith({ events: sink });
  assert.equal(context.events, sink);
  context.events.emit({ type: 'x' });
  assert.deepEqual(seen, [{ type: 'x' }]);
});

test('M13 default events sink rejects junk and recorded() returns an ordered copy', () => {
  const context = contextWith();
  assert.throws(() => context.events.emit(null), /event/i);
  assert.throws(() => context.events.emit({ type: '' }), /event/i);
  context.events.emit({ type: 'a', ownerId: 'o' });
  context.events.emit({ type: 'b' });
  const snapshot = context.events.recorded();
  assert.deepEqual(snapshot.map((event) => event.type), ['a', 'b']);
  snapshot.pop();
  assert.equal(context.events.recorded().length, 2, 'recorded() must hand out copies');
});

// ---------------- idGen：函数注入归一 + 缺省唯一 ----------------

test('M13 normalizes a callable idGen injection to {next()} and keeps ids unique by default', () => {
  let n = 0;
  const context = contextWith({ idGen: () => `injected-${n++}` });
  assert.equal(context.idGen.next(), 'injected-0');
  assert.equal(context.idGen.next(), 'injected-1');
  const fallback = contextWith();
  const a = fallback.idGen.next('step');
  const b = fallback.idGen.next('step');
  assert.notEqual(a, b);
  assert.match(a, /^step-/);
});

// ---------------- policy：W4 桥（fail-closed，UNKNOWN 不吞） ----------------

const POLICY_BASE = {
  ownerId: 'owner-1',
  mission: { id: 'm-1', ownerId: 'owner-1', state: 'contracted', autonomy: 'A3' },
  contract: {
    id: 'c-1', ownerId: 'owner-1', missionId: 'm-1', hash: 'contract-hash', status: 'active',
    capabilities: [{ capability: 'files.write', scope: '/workspace/m-1' }],
    window: { prepStart: '2026-10-28T09:00:00.000Z', start: '2026-10-28T10:00:00.000Z', end: '2026-10-28T11:00:00.000Z' },
  },
  grant: {
    id: 'g-1', ownerId: 'owner-1', actor: 'worker-1', contractHash: 'contract-hash', status: 'active',
    capabilities: [{ capability: 'files.write', scope: '/workspace/m-1' }],
    expiresAt: '2026-10-28T12:00:00.000Z',
  },
  action: {
    id: 'a-1', ownerId: 'owner-1', capability: 'files.write', scope: '/workspace/m-1/new.md',
    risk: 'reversible', requestedAutonomy: 'A3',
    actor: { actorId: 'worker-1', resolvedModel: 'glm-5.3', modelProvider: 'gateway' },
    estimate: { modelCalls: 1, tokens: 100, cost: 0, localSlots: 1 },
  },
};

/** W4 桥上下文：base/phase 可覆盖（A4/A5 用例需 mission autonomy 抬到对应档）。 */
function w4Context({ base = POLICY_BASE, phase = 'P1' } = {}) {
  return contextWith({
    policy: { resolvePolicyInput: () => base, phase },
    now: makeClock('2026-10-28T10:30:00.000Z').now,
  });
}

test('M13 W4 policy bridge maps an allowed decision to allowed:true', () => {
  const context = w4Context();
  const decision = context.policyPort.check({ ownerId: 'owner-1' }, POLICY_BASE.action);
  assert.deepEqual(decision, { allowed: true });
});

test('M13 W4 policy bridge keeps A4 as an explicit confirmation gate (never auto-allow)', () => {
  const base = {
    ...POLICY_BASE,
    mission: { ...POLICY_BASE.mission, autonomy: 'A4' },
    action: { ...POLICY_BASE.action, requestedAutonomy: 'A4' },
  };
  const context = w4Context({ base });
  const decision = context.policyPort.check({ ownerId: 'owner-1' }, base.action);
  assert.equal(decision.allowed, false);
  assert.equal(decision.need, 'A4_CONFIRMATION_REQUIRED');
  assert.equal(decision.reason, 'A4_CONFIRMATION_REQUIRED');
});

test('M13 W4 policy bridge maps A5 and P0-external to hard denials', () => {
  const a5Base = {
    ...POLICY_BASE,
    mission: { ...POLICY_BASE.mission, autonomy: 'A5' },
    action: { ...POLICY_BASE.action, requestedAutonomy: 'A5' },
  };
  const a5 = w4Context({ base: a5Base }).policyPort.check({ ownerId: 'owner-1' }, a5Base.action);
  assert.equal(a5.allowed, false);
  assert.equal(a5.reason, 'A5_NEVER_AUTOMATIC');
  assert.equal(a5.unknown, undefined);

  const p0Context = contextWith({
    policy: { resolvePolicyInput: () => POLICY_BASE, phase: 'P0' },
    now: makeClock('2026-10-28T10:30:00.000Z').now,
  });
  const external = p0Context.policyPort.check(
    { ownerId: 'owner-1' },
    { ...POLICY_BASE.action, risk: 'external' },
  );
  assert.equal(external.allowed, false);
  assert.equal(external.reason, 'P0_EXTERNAL_EFFECT_BLOCKED');
});

test('M13 W4 policy bridge surfaces UNKNOWN actor provenance instead of swallowing it', () => {
  const context = w4Context();
  const action = { ...POLICY_BASE.action, actor: { actorId: 'worker-1' } }; // resolvedModel 缺失 → W4 UNKNOWN
  const decision = context.policyPort.check({ ownerId: 'owner-1' }, action);
  assert.equal(decision.allowed, false, 'UNKNOWN must never become an allow');
  assert.equal(decision.reason, 'ACTOR_MODEL_UNKNOWN');
  assert.equal(decision.unknown, true, 'UNKNOWN outcomes must stay visible for the reconciliation queue');
});

test('M13 W4 policy bridge fails closed on owner mismatch, missing context and a throwing resolver', () => {
  const context = w4Context();
  assert.equal(context.policyPort.check({ ownerId: 'owner-2' }, POLICY_BASE.action).reason, 'OWNER_MISMATCH');

  const unresolved = contextWith({ policy: { resolvePolicyInput: () => null, phase: 'P1' } });
  assert.equal(unresolved.policyPort.check({}, {}).reason, 'CONTEXT_INVALID');

  const throwing = contextWith({
    policy: { resolvePolicyInput: () => { throw new Error('store unavailable'); }, phase: 'P1' },
  });
  const decision = throwing.policyPort.check({}, {});
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, 'POLICY_INPUT_RESOLVER_FAILED');
});

test('M13 W4 policy bridge uses the context clock, so decisions move with the deterministic time', () => {
  const clock = makeClock('2026-10-28T10:30:00.000Z');
  const context = contextWith({
    policy: { resolvePolicyInput: () => POLICY_BASE, phase: 'P1' },
    now: clock.now,
  });
  assert.equal(context.policyPort.check({ ownerId: 'owner-1' }, POLICY_BASE.action).allowed, true);
  clock.tick(3600); // 11:30 — past the contract window end
  const after = context.policyPort.check({ ownerId: 'owner-1' }, POLICY_BASE.action);
  assert.equal(after.allowed, false);
  assert.equal(after.reason, 'WINDOW_OUTSIDE');
});

test('M13 rejects a policy block without a resolver function', () => {
  assert.throws(() => contextWith({ policy: { phase: 'P1' } }), /resolvePolicyInput|policy/i);
});

test('M13 default policy port denial carries an explicit reason', () => {
  const decision = contextWith().policyPort.check({}, {});
  assert.equal(decision.allowed, false);
  assert.match(decision.reason, /POLICY_PORT_UNBOUND/);
});

// ---------------- runtime 适配（W7 policyCheck 形状） ----------------

test('M13 adaptPolicyPortForRuntime satisfies W7 validatePolicyPort and maps allowed/need faithfully', async () => {
  const port = adaptPolicyPortForRuntime(w4Context().policyPort);
  validatePolicyPort(port);
  const allowed = await port.check({ ownerId: 'owner-1' }, POLICY_BASE.action);
  assert.deepEqual(allowed, { allow: true });

  const denyPort = adaptPolicyPortForRuntime(
    contextWith().policyPort, // default deny-all
  );
  const denial = readPolicyDecision(await denyPort.check({}, {}));
  assert.equal(denial.allow, false);
  assert.equal(typeof denial.reason, 'string');
});

test('M13 runtime adapters reject malformed inputs loudly', () => {
  assert.throws(() => adaptClockForRuntime(null), /clock/i);
  assert.throws(() => adaptPolicyPortForRuntime({}), /policy/i);
});

// ---------------- traceSink → W10 store ----------------

test('M13 traceSink records a contract-shaped span into the W10 store and stays idempotent per id', () => {
  const context = contextWith();
  const span = {
    id: 'span-1', name: 'agent.step', kind: 'chat',
    startedAt: '2026-10-28T10:00:00.000Z', endedAt: '2026-10-28T10:00:01.000Z', status: 'ok',
    attributes: { 'donego.actor.model': 'glm-5.3' },
  };
  const first = context.traceSink.record(span, { ownerId: 'owner-a', runId: 'run-1' });
  assert.equal(first.inserted, true);
  const row = context.db.prepare('SELECT * FROM obs_spans WHERE owner_id = ? AND id = ?').get('owner-a', 'span-1');
  assert.equal(row.name, 'agent.step');
  assert.equal(row.run_id, 'run-1');
  assert.equal(row.provenance, 'RESOLVED', 'declared actor model must project as resolved provenance');

  const second = context.traceSink.record(span, { ownerId: 'owner-a' });
  assert.equal(second.duplicate, true);
  assert.throws(
    () => context.traceSink.record(span, { ownerId: 'owner-b' }),
    (error) => error.code === 'SPAN_OWNER_MISMATCH' || /another owner/.test(error.message),
    'a foreign owner must never overwrite or shadow an existing span id',
  );
});

test('M13 traceSink refuses to record without an owner binding', () => {
  const context = contextWith();
  assert.throws(() => context.traceSink.record({ id: 's', name: 'x', kind: 'chat', startedAt: '2026-10-28T10:00:00.000Z', status: 'ok' }), /owner/i);
});

test('M13 traceSink maps W7 engine event spans onto the frozen span contract deterministically', () => {
  const clock = makeClock('2026-10-28T10:00:00.000Z');
  const context = contextWith({ now: clock.now });

  context.traceSink.record(
    { type: 'run.started', runId: 'run-9', actor: 'user:owner-a', recordedAt: '2026-10-28T10:00:02.000Z' },
    { ownerId: 'owner-a' },
  );
  const started = context.db
    .prepare("SELECT * FROM obs_spans WHERE owner_id = 'owner-a' AND name = 'run.started'")
    .get();
  assert.equal(started.kind, 'invoke_agent');
  assert.equal(started.status, 'running');
  assert.equal(started.started_at, '2026-10-28T10:00:02.000Z');
  assert.equal(started.run_id, 'run-9');
  assert.ok(JSON.parse(started.attributes_json).actor === 'user:owner-a');

  context.traceSink.record(
    { type: 'run.finished', runId: 'run-9', status: 'succeeded', recordedAt: '2026-10-28T10:00:05.000Z' },
    { ownerId: 'owner-a', runId: 'run-9' },
  );
  const done = context.db
    .prepare("SELECT * FROM obs_spans WHERE owner_id = 'owner-a' AND name = 'run.finished'")
    .get();
  assert.equal(done.status, 'ok', 'a succeeded finish may close its span');
  assert.equal(done.ended_at, '2026-10-28T10:00:05.000Z');
});

test('M13 traceSink never promotes an UNKNOWN or paused run finish into a success span', () => {
  const clock = makeClock('2026-10-28T10:00:00.000Z');
  const context = contextWith({ now: clock.now });
  for (const outcome of ['unknown', 'paused']) {
    context.traceSink.record(
      { type: 'run.finished', runId: `run-${outcome}`, status: outcome, recordedAt: '2026-10-28T10:00:09.000Z' },
      { ownerId: 'owner-a', runId: `run-${outcome}` },
    );
  }
  const rows = context.db
    .prepare("SELECT * FROM obs_spans WHERE name = 'run.finished'")
    .all();
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.notEqual(row.status, 'ok', 'UNKNOWN/paused must not be recorded as success');
    assert.equal(row.status, 'running', 'non-terminal recording keeps the span incomplete for W10 classification');
    const attributes = JSON.parse(row.attributes_json);
    assert.ok(['unknown', 'paused'].includes(attributes.runOutcome), 'raw outcome stays visible in attributes');
  }
});

test('M13 traceSink.forOwner binds a W7-shaped {record(span)} sink to one owner', () => {
  const context = contextWith();
  const bound = context.traceSink.forOwner('owner-b', 'run-b');
  bound.record({ type: 'run.started', runId: 'run-b', recordedAt: '2026-10-28T10:00:00.000Z' });
  const row = context.db
    .prepare("SELECT * FROM obs_spans WHERE owner_id = 'owner-b'")
    .get();
  assert.equal(row.run_id, 'run-b');
});

test('M13 traceSink keeps a failed finish as error, not success', () => {
  const context = contextWith();
  context.traceSink.record(
    { type: 'run.finished', runId: 'run-f', status: 'failed', recordedAt: '2026-10-28T10:00:00.000Z' },
    { ownerId: 'owner-a' },
  );
  const row = context.db.prepare("SELECT status FROM obs_spans WHERE name = 'run.finished'").get();
  assert.equal(row.status, 'error');
});

test('M13 auth adapter is itself callable — the M14 dispatcher seam (typeof context.auth === function)', async () => {
  const context = contextWith();
  assert.equal(typeof context.auth, 'function');
  const req = fakeReq({ method: 'GET' });
  assert.equal(context.auth(req), PRINCIPAL, 'direct call resolves the principal once');
  const awaited = await context.auth(req); // dispatcher awaits; sync value passes through
  assert.equal(awaited, PRINCIPAL);
});

test('M13 real context plugs into the M14 dispatcher end-to-end (auth gate)', async () => {
  const { createAgenticDispatcher } = await import('../../../../scripts/agentic/integration/dispatcher.mjs');
  const context = contextWith({ auth: () => null });
  const dispatch = createAgenticDispatcher({ context, handlers: [], legacy: null, maxBodyBytes: 1024 }).handle;
  const res = fakeRes();
  const handled = await dispatch(fakeReq({ method: 'GET', url: '/api/agentic/anything' }), res, '/api/agentic/anything');
  assert.equal(handled, true);
  assert.equal(res.statusCode, 401, 'unauthenticated protected path must be gated before any handler');
  const envelope = res.json();
  assert.equal(envelope.error.code, 'AUTH_REQUIRED');
});

// ---------------- 红线 4 自审：组合根源码无隐藏墙钟/环境读取/外呼 ----------------

test('M13 context source carries no hidden wall clock, env read or external call (red line 4 self-audit)', () => {
  const source = readFileSync(
    fileURLToPath(new URL('../../../../scripts/agentic/integration/context.mjs', import.meta.url)),
    'utf8',
  );
  assert.ok(!source.includes('Date.now('), 'no wall clock reads');
  assert.ok(!source.includes('new Date('), 'no wall clock construction');
  assert.ok(!source.includes('process.env'), 'no environment/key reads');
  assert.ok(!/\bfetch\s*\(/.test(source), 'no external calls');
  assert.ok(!/node:(http|https|net|dns|child_process)/.test(source), 'no network/process imports');
});
