import test from 'node:test';
import assert from 'node:assert/strict';

import { AuditLog } from '../../../../scripts/agentic/autonomy/audit.mjs';

const NOW = '2026-10-27T10:00:00.000Z';
const CLOCK = () => new Date(NOW);
import {
  SideEffectFence,
  evaluateSideEffect,
} from '../../../../scripts/agentic/autonomy/side-effect-fence.mjs';

const ACTOR = { actorId: 'worker-1', resolvedModel: 'gpt-6.1-sol', modelProvider: 'gateway' };
const ACTION = {
  id: 'action-1',
  ownerId: 'owner-1',
  risk: 'reversible',
  requestedAutonomy: 'A3',
  actor: ACTOR,
};

function request(overrides = {}) {
  return {
    ...overrides,
    action: { ...ACTION, ...(overrides.action ?? {}) },
  };
}

test('classifies read-only, suggestion, preparation, and reversible actions as non-external', () => {
  for (const [risk, requestedAutonomy] of [
    ['observe', 'A1'],
    ['suggest', 'A1'],
    ['prepare', 'A2'],
    ['reversible', 'A3'],
  ]) {
    assert.deepEqual(evaluateSideEffect({ risk, requestedAutonomy }, { phase: 'P0' }), {
      status: 'allowed',
      code: 'ALLOWED',
      requiresHuman: false,
    });
  }
});

test('blocks external consequences in P0 and records an auditable decision', async () => {
  const audit = new AuditLog({ clock: CLOCK });
  const fence = new SideEffectFence({ audit, phase: 'P0', clock: CLOCK });
  const result = await fence.check(request({ action: { risk: 'external', requestedAutonomy: 'A3' } }));

  assert.deepEqual(result, {
    status: 'blocked',
    code: 'P0_EXTERNAL_EFFECT_BLOCKED',
    requiresHuman: false,
  });
  assert.equal(audit.events.length, 1);
  assert.deepEqual({
    type: audit.events[0].type,
    actionId: audit.events[0].actionId,
    decision: audit.events[0].decision,
    code: audit.events[0].code,
    actorId: audit.events[0].actorId,
    resolvedModel: audit.events[0].resolvedModel,
  }, {
    type: 'autonomy.side_effect_fence',
    actionId: 'action-1',
    decision: 'blocked',
    code: 'P0_EXTERNAL_EFFECT_BLOCKED',
    actorId: 'worker-1',
    resolvedModel: 'gpt-6.1-sol',
  });
  assert.equal(typeof audit.events[0].at, 'string');
});

test('returns needs-human for A4 external consequences outside P0 without executing', async () => {
  const audit = new AuditLog({ clock: CLOCK });
  const fence = new SideEffectFence({ audit, phase: 'P1', clock: CLOCK });
  let calls = 0;
  const result = await fence.execute(
    request({ action: { risk: 'external', requestedAutonomy: 'A4' } }),
    async () => { calls += 1; },
  );

  assert.deepEqual(result, {
    status: 'needs_human',
    code: 'NEED_HUMAN',
    requiresHuman: true,
  });
  assert.equal(calls, 0);
  assert.equal(audit.events[0].decision, 'needs_human');
});

test('hard-stops A5 regardless of phase, risk, or an otherwise usable action', async () => {
  const fence = new SideEffectFence({ audit: new AuditLog({ clock: CLOCK }), phase: 'P1', clock: CLOCK });
  let calls = 0;
  const result = await fence.execute(
    request({ action: { risk: 'financial', requestedAutonomy: 'A5' } }),
    async () => { calls += 1; },
  );

  assert.deepEqual(result, {
    status: 'blocked',
    code: 'A5_NEVER_AUTOMATIC',
    requiresHuman: false,
  });
  assert.equal(calls, 0);
});

test('keeps unresolved actor models UNKNOWN and never treats them as allowed', async () => {
  const fence = new SideEffectFence({ audit: new AuditLog({ clock: CLOCK }), phase: 'P1', clock: CLOCK });
  const result = await fence.check(request({ action: { actor: { actorId: 'worker-1', resolvedModel: null } } }));

  assert.deepEqual(result, {
    status: 'UNKNOWN',
    code: 'ACTOR_MODEL_UNKNOWN',
    requiresHuman: false,
  });
});

test('fails closed when the audit sink cannot persist the fence decision', async () => {
  const audit = new AuditLog({ writer: async () => { throw new Error('disk unavailable'); }, clock: CLOCK });
  const fence = new SideEffectFence({ audit, phase: 'P0', clock: CLOCK });
  const result = await fence.check(request());

  assert.deepEqual(result, {
    status: 'blocked',
    code: 'AUDIT_WRITE_FAILED',
    requiresHuman: false,
  });
});

test('does not allow an invalid action risk to pass the fence', async () => {
  const fence = new SideEffectFence({ audit: new AuditLog({ clock: CLOCK }), phase: 'P0', clock: CLOCK });
  const result = await fence.check(request({ action: { risk: 'delete-production' } }));

  assert.deepEqual(result, {
    status: 'blocked',
    code: 'AUTONOMY_ACTION_INVALID',
    requiresHuman: false,
  });
});

test('requires explicit actor provenance before allowing execution', async () => {
  const fence = new SideEffectFence({ audit: new AuditLog({ clock: CLOCK }), phase: 'P0', clock: CLOCK });
  const result = await fence.check(request({ action: { actor: undefined } }));

  assert.deepEqual(result, {
    status: 'blocked',
    code: 'ACTOR_INVALID',
    requiresHuman: false,
  });
});

test('does not report success when the result audit cannot be persisted', async () => {
  let writes = 0;
  const audit = new AuditLog({ writer: async () => {
    writes += 1;
    if (writes === 2) throw new Error('disk unavailable');
  }, clock: CLOCK });
  const fence = new SideEffectFence({ audit, phase: 'P0', clock: CLOCK });
  const result = await fence.execute(request(), async () => ({ written: true }));

  assert.deepEqual(result, {
    status: 'blocked',
    code: 'AUDIT_WRITE_FAILED',
    requiresHuman: false,
  });
});
