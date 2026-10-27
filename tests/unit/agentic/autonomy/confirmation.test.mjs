import test from 'node:test';
import assert from 'node:assert/strict';

import { ConfirmationStore } from '../../../../scripts/agentic/autonomy/confirmation.mjs';
import { AuditLog } from '../../../../scripts/agentic/autonomy/audit.mjs';
import { AutonomyRuntime } from '../../../../scripts/agentic/autonomy/runtime.mjs';

const NOW = '2026-10-27T10:00:00.000Z';
const CLOCK = () => new Date(NOW);
const ACTOR = { actorId: 'sender-1', resolvedModel: 'gpt-6.1-sol', modelProvider: 'gateway' };
const REQUEST = {
  ownerId: 'owner-1',
  mission: { id: 'm-1', ownerId: 'owner-1', state: 'contracted', autonomy: 'A4' },
  contract: {
    id: 'c-1', ownerId: 'owner-1', missionId: 'm-1', hash: 'hash-1', status: 'active',
    capabilities: [{ capability: 'message.send', scope: 'draft:1' }],
  },
  grant: {
    id: 'g-1', ownerId: 'owner-1', contractHash: 'hash-1', status: 'active',
    capabilities: [{ capability: 'message.send', scope: 'draft:1' }],
    expiresAt: '2026-10-27T11:00:00.000Z',
  },
  action: {
    id: 'action-1', ownerId: 'owner-1', capability: 'message.send', scope: 'draft:1',
    risk: 'external', requestedAutonomy: 'A4', actor: ACTOR,
  },
};

function freshStore() { return new ConfirmationStore({ clock: CLOCK }); }

test('does not issue a confirmation for an unresolved actor model', () => {
  assert.throws(() => freshStore().issue({
    actionId: 'action-1',
    actor: { ...ACTOR, resolvedModel: null },
    contractHash: 'hash-1',
  }), /ACTOR_MODEL_UNKNOWN/);
});

test('rejects invalid confirmation inputs instead of creating a usable token', () => {
  const store = freshStore();
  assert.throws(() => store.issue({ actionId: '', actor: ACTOR, contractHash: 'hash-1' }), /CONFIRMATION_INPUT_INVALID/);
  assert.throws(() => store.issue({ actionId: 'action-1', actor: ACTOR, contractHash: '' }), /CONFIRMATION_INPUT_INVALID/);
  assert.throws(() => store.issue({ actionId: 'action-1', actor: ACTOR, contractHash: 'hash-1', ttlMs: 0 }), /CONFIRMATION_TTL_INVALID/);
});

test('runtime only issues A4 confirmations for a policy decision that needs confirmation', async () => {
  const runtime = new AutonomyRuntime({ audit: new AuditLog({ clock: CLOCK }), phase: 'P1', clock: CLOCK });
  assert.throws(() => runtime.confirm({ ...REQUEST, action: { ...REQUEST.action, requestedAutonomy: 'A3', risk: 'reversible' } }), /CONFIRMATION_NOT_REQUIRED/);
  const issued = runtime.confirm(REQUEST);
  assert.equal(typeof issued.token, 'string');
  assert.equal(issued.actionId, 'action-1');
});

test('confirmation is bound to the complete action identity, not only its token', () => {
  const store = freshStore();
  const action = { id: 'action-1', ownerId: 'owner-1', capability: 'message.send', scope: 'draft:1', risk: 'external', requestedAutonomy: 'A4', actor: ACTOR };
  const issued = store.issue({ actionId: 'action-1', actionHash: 'action-hash-1', action, actor: ACTOR, contractHash: 'hash-1' });
  assert.equal(store.consume(issued.token, {
    actionId: 'action-2', action, actionHash: 'action-hash-1', actor: ACTOR, contractHash: 'hash-1',
  }).code, 'CONFIRMATION_BINDING_MISMATCH');
  assert.equal(store.consume(issued.token, {
    actionId: 'action-1', action: { ...action, scope: 'draft:2' }, actionHash: 'action-hash-2', actor: ACTOR, contractHash: 'hash-1',
  }).code, 'CONFIRMATION_BINDING_MISMATCH');
  assert.equal(store.consume(issued.token, {
    actionId: 'action-1', action, actionHash: 'action-hash-1', actor: ACTOR, contractHash: 'hash-2',
  }).code, 'CONFIRMATION_BINDING_MISMATCH');
  assert.equal(store.consume(issued.token, {
    actionId: 'action-1', action, actionHash: 'action-hash-1', actor: ACTOR, contractHash: 'hash-1',
  }).status, 'confirmed');
});

test('expired confirmation is removed and cannot be consumed later', () => {
  const store = freshStore();
  const action = { id: 'action-1', ownerId: 'owner-1', capability: 'message.send', scope: 'draft:1', risk: 'external', requestedAutonomy: 'A4', actor: ACTOR };
  const issued = store.issue({ actionId: 'action-1', action, actor: ACTOR, contractHash: 'hash-1', ttlMs: 1 });
  assert.equal(store.consume(issued.token, {
    actionId: 'action-1', action, actor: ACTOR, contractHash: 'hash-1', now: '2026-10-27T10:00:00.001Z',
  }).code, 'CONFIRMATION_EXPIRED');
  assert.equal(store.consume(issued.token, {
    actionId: 'action-1', action, actor: ACTOR, contractHash: 'hash-1',
  }).code, 'CONFIRMATION_REPLAY');
});
