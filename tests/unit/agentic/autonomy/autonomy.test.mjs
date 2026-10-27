import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AUTONOMY_LEVELS,
  ACTION_RISKS,
  normalizeActor,
  normalizeAction,
} from '../../../../scripts/agentic/autonomy/types.mjs';
import { evaluateAction } from '../../../../scripts/agentic/autonomy/policy.mjs';
import { ConfirmationStore } from '../../../../scripts/agentic/autonomy/confirmation.mjs';
import { AuditLog } from '../../../../scripts/agentic/autonomy/audit.mjs';
import { AutonomyRuntime, createAutonomyRoutes } from '../../../../scripts/agentic/autonomy/runtime.mjs';

const NOW = '2026-10-27T10:00:00.000Z';
const CLOCK = () => new Date(NOW);
const ACTOR = { actorId: 'planner-1', resolvedModel: 'gpt-6.1-sol', modelProvider: 'gateway' };
const BASE = {
  ownerId: 'owner-1',
  mission: { id: 'm-1', ownerId: 'owner-1', state: 'contracted', autonomy: 'A3' },
  contract: {
    id: 'c-1', ownerId: 'owner-1', missionId: 'm-1', hash: 'contract-hash', status: 'active',
    capabilities: [
      { capability: 'files.write', scope: '/workspace/m-1' },
      { capability: 'message.send', scope: 'draft:message-1' },
      { capability: 'purchase', scope: 'cart:1' },
    ],
    wont: ['send external messages'],
  },
  grant: {
    id: 'g-1', ownerId: 'owner-1', contractHash: 'contract-hash', status: 'active',
    capabilities: [{ capability: 'files.write', scope: '/workspace/m-1' }],
    expiresAt: '2026-10-27T11:00:00.000Z',
  },
  action: {
    id: 'a-1', ownerId: 'owner-1', capability: 'files.write', scope: '/workspace/m-1/new.md',
    risk: 'reversible', requestedAutonomy: 'A3', actor: ACTOR,
  },
};

function input(overrides = {}) {
  return {
    ...BASE,
    ...overrides,
    mission: { ...BASE.mission, ...(overrides.mission ?? {}) },
    contract: { ...BASE.contract, ...(overrides.contract ?? {}) },
    grant: overrides.grant === null ? null : { ...BASE.grant, ...(overrides.grant ?? {}) },
    action: { ...BASE.action, ...(overrides.action ?? {}) },
  };
}

test('normalizes autonomy levels and action risk without accepting unknown values', () => {
  assert.deepEqual(AUTONOMY_LEVELS, ['A0', 'A1', 'A2', 'A3', 'A4', 'A5']);
  assert.deepEqual(ACTION_RISKS, ['observe', 'suggest', 'prepare', 'reversible', 'external', 'financial']);
  assert.deepEqual(normalizeAction({ risk: 'external', requestedAutonomy: 'A4' }), {
    risk: 'external', requestedAutonomy: 'A4',
  });
  assert.throws(() => normalizeAction({ risk: 'unknown' }), /AUTONOMY_ACTION_INVALID/);
});

test('missing resolved model is UNKNOWN and cannot be treated as complete', () => {
  const actor = normalizeActor({ actorId: 'planner-1', resolvedModel: null });
  assert.equal(actor.status, 'UNKNOWN');
  assert.equal(actor.code, 'ACTOR_MODEL_UNKNOWN');
  assert.equal(actor.resolvedModel, null);
});

test('allows an A3 reversible action only inside active contract and grant scope', () => {
  const result = evaluateAction(input(), { now: NOW });
  assert.deepEqual(result, { status: 'allowed', code: 'ALLOWED', requiresConfirmation: false });
});

test('rejects pre-contract actions and never calls an external executor', () => {
  const result = evaluateAction(input({ mission: { state: 'previewed' } }), { now: NOW });
  assert.equal(result.status, 'blocked');
  assert.equal(result.code, 'CONTRACT_REQUIRED');
});

test('rejects A0 and A1 write or execution attempts', () => {
  for (const autonomy of ['A0', 'A1']) {
    const result = evaluateAction(input({ mission: { autonomy }, action: { requestedAutonomy: autonomy } }), { now: NOW });
    assert.equal(result.status, 'blocked');
    assert.equal(result.code, 'AUTONOMY_TOO_LOW');
  }
});

test('allows an A2 preparation action with the required preparation grant', () => {
  const result = evaluateAction(input({
    mission: { autonomy: 'A2' },
    action: { risk: 'prepare', requestedAutonomy: 'A2' },
  }), { now: NOW });
  assert.deepEqual(result, { status: 'allowed', code: 'ALLOWED', requiresConfirmation: false });
});

test('rejects missing, expired, revoked, or mismatched grants fail-closed', () => {
  for (const grant of [null, { ...BASE.grant, status: 'revoked' }, { ...BASE.grant, expiresAt: '2026-10-27T09:59:59.000Z' }, { ...BASE.grant, contractHash: 'old' }]) {
    const result = evaluateAction(input({ grant }), { now: NOW });
    assert.equal(result.status, 'blocked');
    assert.match(result.code, /GRANT/);
  }
});

test('rejects cross-owner and out-of-scope actions', () => {
  assert.equal(evaluateAction(input({ action: { ownerId: 'owner-2' } }), { now: NOW }).code, 'OWNER_MISMATCH');
  assert.equal(evaluateAction(input({ action: { scope: '/other/place/file' } }), { now: NOW }).code, 'SCOPE_DENIED');
});

test('requires a fresh one-time confirmation for A4 external effects', () => {
  const result = evaluateAction(input({
    mission: { autonomy: 'A4' },
    action: { risk: 'external', requestedAutonomy: 'A4', capability: 'message.send', scope: 'draft:message-1' },
    grant: { capabilities: [{ capability: 'message.send', scope: 'draft:message-1' }] },
  }), { now: NOW, phase: 'P1' });
  assert.deepEqual(result, { status: 'needs_confirmation', code: 'A4_CONFIRMATION_REQUIRED', requiresConfirmation: true });
});

test('hard-stops A5 financial or legal actions even when a grant exists', () => {
  const result = evaluateAction(input({
    mission: { autonomy: 'A5' },
    action: { risk: 'financial', requestedAutonomy: 'A5', capability: 'purchase', scope: 'cart:1' },
    grant: { capabilities: [{ capability: 'purchase', scope: 'cart:1' }] },
  }), { now: NOW });
  assert.deepEqual(result, { status: 'blocked', code: 'A5_NEVER_AUTOMATIC', requiresConfirmation: false });
});

test('does not allow deleting the default wont boundary', () => {
  const result = evaluateAction(input({ action: { capability: 'contract.wont.delete', risk: 'reversible' } }));
  assert.equal(result.code, 'WONT_IMMUTABLE');
});

test('issues and atomically consumes an A4 confirmation bound to actor model and contract hash', () => {
  const store = new ConfirmationStore({ clock: CLOCK });
  const issued = store.issue({ actionId: 'a-4', actor: ACTOR, contractHash: 'contract-hash', ttlMs: 1000 });
  assert.ok(issued.token);
  assert.equal(store.consume(issued.token, { actionId: 'a-4', actor: ACTOR, contractHash: 'contract-hash' }).status, 'confirmed');
  assert.equal(store.consume(issued.token, { actionId: 'a-4', actor: ACTOR, contractHash: 'contract-hash' }).code, 'CONFIRMATION_REPLAY');
});

test('rejects expired or mismatched confirmations without creating a grant', () => {
  const store = new ConfirmationStore({ clock: CLOCK });
  const issued = store.issue({ actionId: 'a-4', actor: ACTOR, contractHash: 'contract-hash', ttlMs: 10 });
  assert.equal(store.consume(issued.token, { actionId: 'a-4', actor: { ...ACTOR, resolvedModel: 'other' }, contractHash: 'contract-hash' }).code, 'CONFIRMATION_BINDING_MISMATCH');
  assert.equal(store.consume(issued.token, { actionId: 'a-4', actor: ACTOR, contractHash: 'contract-hash', now: '2026-10-27T10:00:00.020Z' }).code, 'CONFIRMATION_EXPIRED');
});

test('audit log fails closed when its writer fails', async () => {
  const audit = new AuditLog({ writer: async () => { throw new Error('disk unavailable'); } });
  await assert.rejects(() => audit.append({ type: 'policy.denied', actor: ACTOR }), /AUDIT_WRITE_FAILED/);
  assert.equal(audit.failed, true);
});

test('runtime blocks P0 external effects and A5 without invoking executor', async () => {
  let calls = 0;
  const runtime = new AutonomyRuntime({ audit: new AuditLog({ clock: CLOCK }), clock: CLOCK });
  const result = await runtime.perform(input({
    action: { risk: 'external', requestedAutonomy: 'A4' },
    mission: { autonomy: 'A4' },
    grant: { capabilities: [{ capability: 'files.write', scope: '/workspace/m-1' }] },
  }), async () => { calls += 1; });
  assert.equal(result.status, 'blocked');
  assert.equal(result.code, 'P0_EXTERNAL_EFFECT_BLOCKED');
  assert.equal(calls, 0);
});

test('runtime consumes A4 confirmation once and executes only after explicit confirmation', async () => {
  let calls = 0;
  const runtime = new AutonomyRuntime({ audit: new AuditLog({ clock: CLOCK }), phase: 'P1', clock: CLOCK });
  const request = input({
    action: { id: 'a-4', ownerId: 'owner-1', risk: 'external', requestedAutonomy: 'A4', capability: 'message.send', scope: 'draft:message-1' },
    mission: { autonomy: 'A4' },
    grant: { capabilities: [{ capability: 'message.send', scope: 'draft:message-1' }] },
  });
  const pending = await runtime.perform(request, async () => { calls += 1; return { sent: true }; });
  assert.equal(pending.code, 'A4_CONFIRMATION_REQUIRED');
  const confirmation = runtime.confirm(request);
  const done = await runtime.perform({ ...request, confirmationToken: confirmation.token }, async () => { calls += 1; return { sent: true }; });
  assert.equal(done.status, 'succeeded');
  assert.equal(calls, 1);
});

test('runtime returns the same result for duplicate idempotency keys', async () => {
  let calls = 0;
  const runtime = new AutonomyRuntime({ audit: new AuditLog({ clock: CLOCK }), phase: 'P1', clock: CLOCK });
  const request = input({ action: { id: 'a-idem' }, idempotencyKey: 'idem-1' });
  const first = await runtime.perform(request, async () => { calls += 1; return { ok: true }; });
  const second = await runtime.perform(request, async () => { calls += 1; return { ok: true }; });
  assert.deepEqual(second, first);
  assert.equal(calls, 1);
});

test('runtime marks unknown external outcomes and recovery never retries them', async () => {
  let calls = 0;
  const runtime = new AutonomyRuntime({ audit: new AuditLog({ clock: CLOCK }), phase: 'P1', clock: CLOCK });
  const request = input({ action: { id: 'a-unknown' }, idempotencyKey: 'idem-unknown' });
  const result = await runtime.perform(request, async () => { calls += 1; const error = new Error('connection lost'); error.unknown = true; throw error; });
  assert.equal(result.status, 'UNKNOWN');
  const recovered = await runtime.recover('idem-unknown', async () => { calls += 1; });
  assert.deepEqual(recovered, result);
  assert.equal(calls, 1);
});

test('runtime refuses completion when actor model is missing and records UNKNOWN', async () => {
  let calls = 0;
  const runtime = new AutonomyRuntime({ audit: new AuditLog({ clock: CLOCK }), phase: 'P1', clock: CLOCK });
  const result = await runtime.perform(input({ action: { actor: { actorId: 'planner-1', resolvedModel: null } } }), async () => { calls += 1; });
  assert.equal(result.status, 'UNKNOWN');
  assert.equal(result.code, 'ACTOR_MODEL_UNKNOWN');
  assert.equal(calls, 0);
});

test('runtime fails closed if audit persistence fails', async () => {
  let calls = 0;
  const audit = new AuditLog({ writer: async () => { throw new Error('read only'); } });
  const runtime = new AutonomyRuntime({ audit, phase: 'P1', clock: CLOCK });
  const result = await runtime.perform(input(), async () => { calls += 1; });
  assert.equal(result.status, 'blocked');
  assert.equal(result.code, 'AUDIT_WRITE_FAILED');
  assert.equal(calls, 0);
});

test('route harness returns JSON decisions and does not execute real external actions', async () => {
  const runtime = new AutonomyRuntime({ audit: new AuditLog({ clock: CLOCK }), clock: CLOCK });
  const route = createAutonomyRoutes({ runtime });
  const body = input({ action: { risk: 'external', requestedAutonomy: 'A4' }, mission: { autonomy: 'A4' } });
  const response = await route({ method: 'POST', pathname: '/api/autonomy/decide', body });
  assert.equal(response.status, 200);
  assert.equal(response.body.code, 'P0_EXTERNAL_EFFECT_BLOCKED');
});
