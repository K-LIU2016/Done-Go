import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ACTOR_MODEL_STATES,
  COMPLETION_EVENT_TYPES,
  normalizeActorProvenance,
  validateActorModel,
  completionVerdict,
  normalizeAutonomyEvent,
  isCompletionEvent,
} from '../../../../scripts/agentic/autonomy/actor-model-boundary.mjs';

const ACTOR = {
  actorId: 'worker-1',
  modelProvider: 'gateway',
  requestedModel: 'gpt-6.1-sol',
  resolvedModel: 'gpt-6.1-sol',
};

const EVENT = {
  eventId: 'evt-1',
  eventType: 'autonomy.action.result',
  ownerId: 'owner-1',
  actor: ACTOR,
  occurredAt: '2026-10-27T10:00:00.000Z',
  payload: { actionId: 'a-1' },
};

test('normalizes resolved actor provenance and retains requested-to-resolved binding', () => {
  assert.deepEqual(normalizeActorProvenance(ACTOR), {
    actorId: 'worker-1',
    modelProvider: 'gateway',
    requestedModel: 'gpt-6.1-sol',
    resolvedModel: 'gpt-6.1-sol',
    status: 'RESOLVED',
    code: 'ACTOR_MODEL_RESOLVED',
  });
  assert.deepEqual(ACTOR_MODEL_STATES, ['RESOLVED', 'UNKNOWN']);
});

test('missing or null resolved model is UNKNOWN and cannot yield completion', () => {
  const actor = validateActorModel({ actorId: 'worker-1', modelProvider: 'gateway', resolvedModel: null });
  assert.equal(actor.status, 'UNKNOWN');
  assert.equal(actor.resolvedModel, null);
  assert.equal(completionVerdict(actor).status, 'UNKNOWN');
  assert.equal(completionVerdict(actor).canComplete, false);
});

test('malformed actor identity or model provenance is rejected', () => {
  assert.throws(() => normalizeActorProvenance({}), /ACTOR_INVALID/);
  assert.throws(() => normalizeActorProvenance({ actorId: 'worker-1', resolvedModel: 7 }), /ACTOR_MODEL_INVALID/);
  assert.throws(() => normalizeActorProvenance({ actorId: 'worker-1', modelProvider: 7 }), /ACTOR_PROVIDER_INVALID/);
});

test('completion verdict only succeeds for an explicitly resolved model', () => {
  assert.deepEqual(completionVerdict(ACTOR, { output: { ok: true } }), {
    status: 'succeeded', code: 'SUCCEEDED', canComplete: true, output: { ok: true },
  });
  assert.deepEqual(completionVerdict({ ...ACTOR, resolvedModel: '' }, { output: { ok: true } }), {
    status: 'UNKNOWN', code: 'ACTOR_MODEL_UNKNOWN', canComplete: false,
  });
});

test('normalizes cross-flow events through an explicit actor/model event boundary', () => {
  const normalized = normalizeAutonomyEvent(EVENT);
  assert.equal(normalized.eventId, 'evt-1');
  assert.equal(normalized.type, 'autonomy.action.result');
  assert.equal(normalized.actorId, 'worker-1');
  assert.equal(normalized.resolvedModel, 'gpt-6.1-sol');
  assert.equal(normalized.actorStatus, 'RESOLVED');
  assert.equal(normalized.payload.actionId, 'a-1');
  assert.equal(normalized.occurredAt, EVENT.occurredAt);
});

test('event boundary accepts unknown provenance but marks completion event UNKNOWN', () => {
  const normalized = normalizeAutonomyEvent({
    ...EVENT,
    eventType: COMPLETION_EVENT_TYPES[0],
    actor: { actorId: 'worker-1', resolvedModel: null },
    status: 'succeeded',
  });
  assert.equal(normalized.actorStatus, 'UNKNOWN');
  assert.equal(normalized.status, 'UNKNOWN');
  assert.equal(normalized.code, 'ACTOR_MODEL_UNKNOWN');
});

test('event boundary rejects missing required cross-flow identity and invalid timestamps', () => {
  assert.throws(() => normalizeAutonomyEvent({ ...EVENT, eventId: '' }), /AUTONOMY_EVENT_INVALID/);
  assert.throws(() => normalizeAutonomyEvent({ ...EVENT, ownerId: '' }), /AUTONOMY_EVENT_INVALID/);
  assert.throws(() => normalizeAutonomyEvent({ ...EVENT, occurredAt: 'not-a-date' }), /AUTONOMY_EVENT_INVALID/);
});

test('completion event classifier is explicit and conservative', () => {
  assert.equal(isCompletionEvent('autonomy.action.result'), true);
  assert.equal(isCompletionEvent('autonomy.action.unknown'), false);
  assert.equal(isCompletionEvent('random.event'), false);
});
