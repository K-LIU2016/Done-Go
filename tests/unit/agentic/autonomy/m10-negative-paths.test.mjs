import test from 'node:test';
import assert from 'node:assert/strict';

import { AuditLog } from '../../../../scripts/agentic/autonomy/audit.mjs';
import { ConfirmationStore } from '../../../../scripts/agentic/autonomy/confirmation.mjs';
import { AutonomyRuntime } from '../../../../scripts/agentic/autonomy/runtime.mjs';
import { evaluateAction } from '../../../../scripts/agentic/autonomy/policy.mjs';
import { IdempotencyRecovery } from '../../../../scripts/agentic/autonomy/idempotency-recovery.mjs';
import { SideEffectFence } from '../../../../scripts/agentic/autonomy/side-effect-fence.mjs';

const NOW = '2026-10-27T10:00:00.000Z';
const CLOCK = () => new Date(NOW);
const ACTOR = { actorId: 'worker-1', modelProvider: 'gateway', resolvedModel: 'gpt-6.1-sol' };
const BASE = {
  ownerId: 'owner-1',
  mission: { id: 'mission-1', ownerId: 'owner-1', state: 'contracted', autonomy: 'A3' },
  contract: {
    id: 'contract-1', ownerId: 'owner-1', missionId: 'mission-1', hash: 'contract-hash', status: 'active',
    capabilities: [{ capability: 'files.write', scope: '/workspace/mission-1' }],
  },
  grant: {
    id: 'grant-1', ownerId: 'owner-1', actor: 'worker-1', contractHash: 'contract-hash',
    status: 'active', capabilities: [{ capability: 'files.write', scope: '/workspace/mission-1' }],
    expiresAt: '2026-10-27T11:00:00.000Z',
  },
  action: {
    id: 'action-1', ownerId: 'owner-1', capability: 'files.write',
    scope: '/workspace/mission-1/output.md', risk: 'reversible', requestedAutonomy: 'A3', actor: ACTOR,
  },
};

const request = (overrides = {}) => ({
  ...BASE,
  ...overrides,
  mission: { ...BASE.mission, ...(overrides.mission ?? {}) },
  contract: { ...BASE.contract, ...(overrides.contract ?? {}) },
  grant: overrides.grant === null ? null : { ...BASE.grant, ...(overrides.grant ?? {}) },
  action: { ...BASE.action, ...(overrides.action ?? {}) },
});

test('A0 and A1 never turn a write request into an allowed action', () => {
  for (const autonomy of ['A0', 'A1']) {
    const result = evaluateAction(request({
      mission: { autonomy },
      action: { requestedAutonomy: autonomy },
    }), { now: NOW, phase: 'P1' });
    assert.deepEqual(result, { status: 'blocked', code: 'AUTONOMY_TOO_LOW', requiresConfirmation: false });
  }
});

test('A2 and A3 remain bounded by their matching capabilities and grants', () => {
  assert.equal(evaluateAction(request({
    mission: { autonomy: 'A2' }, action: { risk: 'prepare', requestedAutonomy: 'A2' },
  }), { now: NOW, phase: 'P1' }).code, 'ALLOWED');
  assert.equal(evaluateAction(request({
    action: { scope: '/workspace/other/output.md' },
  }), { now: NOW, phase: 'P1' }).code, 'SCOPE_DENIED');
});

test('A4 requires a fresh confirmation and a replay cannot execute', async () => {
  const runtime = new AutonomyRuntime({ audit: new AuditLog({ clock: CLOCK }), phase: 'P1', clock: CLOCK });
  const input = request({
    mission: { autonomy: 'A4' },
    action: { risk: 'external', requestedAutonomy: 'A4', capability: 'files.write' },
  });
  const pending = await runtime.perform(input, async () => ({ shouldNotRun: true }));
  assert.equal(pending.code, 'A4_CONFIRMATION_REQUIRED');
  const confirmation = runtime.confirm(input);
  const completed = await runtime.perform({ ...input, confirmationToken: confirmation.token }, async () => ({ ok: true }));
  assert.equal(completed.status, 'succeeded');
  const replay = await runtime.perform({ ...input, confirmationToken: confirmation.token }, async () => ({ shouldNotRun: true }));
  assert.equal(replay.status, 'succeeded');
  assert.deepEqual(replay.output, completed.output);
});

test('A5 financial actions are hard-stopped even with an active grant', async () => {
  let calls = 0;
  const runtime = new AutonomyRuntime({ audit: new AuditLog({ clock: CLOCK }), phase: 'P1', clock: CLOCK });
  const result = await runtime.perform(request({
    mission: { autonomy: 'A5' },
    contract: { capabilities: [{ capability: 'purchase', scope: 'cart:1' }] },
    grant: { capabilities: [{ capability: 'purchase', scope: 'cart:1' }] },
    action: { capability: 'purchase', scope: 'cart:1', risk: 'financial', requestedAutonomy: 'A5' },
  }), async () => { calls += 1; });
  assert.equal(result.code, 'A5_NEVER_AUTOMATIC');
  assert.equal(calls, 0);
});

test('owner changes fail closed and cannot reuse another owner\'s grant', () => {
  const result = evaluateAction(request({ action: { ownerId: 'owner-2' } }), { now: NOW, phase: 'P1' });
  assert.deepEqual(result, { status: 'blocked', code: 'OWNER_MISMATCH', requiresConfirmation: false });
});

test('unresolved actor models remain UNKNOWN and never produce completion', async () => {
  let calls = 0;
  const runtime = new AutonomyRuntime({ audit: new AuditLog({ clock: CLOCK }), phase: 'P1', clock: CLOCK });
  const result = await runtime.perform(request({ action: { actor: { actorId: 'worker-1', resolvedModel: null } } }), async () => {
    calls += 1;
    return { completed: true };
  });
  assert.equal(result.status, 'UNKNOWN');
  assert.equal(result.code, 'ACTOR_MODEL_UNKNOWN');
  assert.equal(calls, 0);
});

test('audit failure blocks an action before the executor and latches the sink', async () => {
  let calls = 0;
  const audit = new AuditLog({ writer: async () => { throw new Error('disk unavailable'); }, clock: CLOCK });
  const runtime = new AutonomyRuntime({ audit, phase: 'P1', clock: CLOCK });
  const result = await runtime.perform(request(), async () => {
    calls += 1;
    return { completed: true };
  });
  assert.equal(result.status, 'blocked');
  assert.equal(result.code, 'AUDIT_WRITE_FAILED');
  assert.equal(calls, 0);
  assert.equal(audit.available, false);
});

test('timeout and disconnect become UNKNOWN and recovery never retries the executor', async () => {
  for (const [suffix, code] of [['disconnect', 'CLIENT_DISCONNECTED'], ['timeout', 'TIMEOUT']]) {
    const recovery = new IdempotencyRecovery({ clock: CLOCK });
    const input = {
      idempotencyKey: `idem-negative-${suffix}`, actionId: `action-negative-${suffix}`, ownerId: 'owner-1',
      contractHash: 'contract-hash', grantId: 'grant-1', actor: ACTOR, actionHash: `hash-${suffix}`,
    };
    let calls = 0;
    const result = await recovery.execute(input, async () => {
      calls += 1;
      const error = new Error(`${suffix} observed`);
      error.code = code;
      throw error;
    });
    assert.deepEqual({ status: result.status, code: result.code }, { status: 'UNKNOWN', code: 'EXTERNAL_RESULT_UNKNOWN' });
    const recovered = await recovery.recover(input, async () => { calls += 1; });
    assert.equal(recovered.status, 'UNKNOWN');
    assert.equal(recovered.code, 'EXTERNAL_RESULT_UNKNOWN');
    assert.equal(calls, 1);
  }
});

test('duplicate idempotency requests return the first result without rerunning work', async () => {
  const recovery = new IdempotencyRecovery({ now: () => NOW });
  const input = {
    idempotencyKey: 'idem-negative-2', actionId: 'action-negative-2', ownerId: 'owner-1',
    contractHash: 'contract-hash', grantId: 'grant-1', actor: ACTOR, actionHash: 'hash-2',
  };
  let calls = 0;
  const first = await recovery.execute(input, async () => { calls += 1; return { artifact: 'one' }; });
  const duplicate = await recovery.execute(input, async () => { calls += 1; return { artifact: 'two' }; });
  assert.equal(first.status, 'succeeded');
  assert.equal(duplicate.duplicate, true);
  assert.deepEqual(duplicate.output, first.output);
  assert.equal(calls, 1);
});

test('side-effect fence rejects P0 external effects and audit persistence failures', async () => {
  const p0 = new SideEffectFence({ audit: new AuditLog({ clock: CLOCK }), phase: 'P0', clock: CLOCK });
  const blocked = await p0.check({ action: { ...BASE.action, risk: 'external', requestedAutonomy: 'A3' } });
  assert.equal(blocked.code, 'P0_EXTERNAL_EFFECT_BLOCKED');
  const failing = new SideEffectFence({
    audit: new AuditLog({ writer: async () => { throw new Error('read only'); }, clock: CLOCK }), phase: 'P0', clock: CLOCK,
  });
  const persisted = await failing.check({ action: BASE.action });
  assert.equal(persisted.code, 'AUDIT_WRITE_FAILED');
});

test('confirmation store rejects expired and binding-mismatched tokens once', () => {
  const store = new ConfirmationStore({ clock: CLOCK });
  const issued = store.issue({ actionId: 'action-1', actor: ACTOR, contractHash: 'contract-hash', now: NOW, ttlMs: 1 });
  assert.equal(store.consume(issued.token, {
    actionId: 'action-2', actor: ACTOR, contractHash: 'contract-hash', now: NOW,
  }).code, 'CONFIRMATION_BINDING_MISMATCH');
  assert.equal(store.consume(issued.token, {
    actionId: 'action-1', actor: ACTOR, contractHash: 'contract-hash', now: '2026-10-27T10:00:00.001Z',
  }).code, 'CONFIRMATION_EXPIRED');
  assert.equal(store.consume(issued.token, {
    actionId: 'action-1', actor: ACTOR, contractHash: 'contract-hash', now: NOW,
  }).code, 'CONFIRMATION_REPLAY');
});
