import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ACTION_RISKS,
  AUTONOMY_LEVELS,
  P0_BLOCKED_AUTONOMY,
  P0_BLOCKED_RISKS,
  DECISION_CODES,
  RESULT_CODES,
  isP0Forbidden,
  normalizeActionRisk,
  normalizeAutonomyLevel,
  normalizeActor,
} from '../../../../scripts/agentic/autonomy/types.mjs';

test('normalizes each autonomy level and rejects unknown levels', () => {
  for (const level of AUTONOMY_LEVELS) assert.equal(normalizeAutonomyLevel(level), level);
  assert.throws(() => normalizeAutonomyLevel('A6'), /AUTONOMY_LEVEL_INVALID/);
  assert.throws(() => normalizeAutonomyLevel(null), /AUTONOMY_LEVEL_INVALID/);
});

test('normalizes each action risk and rejects unknown risks', () => {
  for (const risk of ACTION_RISKS) assert.equal(normalizeActionRisk(risk), risk);
  assert.throws(() => normalizeActionRisk('delete-production'), /AUTONOMY_ACTION_INVALID/);
});

test('exposes immutable P0 boundaries for external and financial effects', () => {
  assert.deepEqual(P0_BLOCKED_RISKS, ['external', 'financial']);
  assert.deepEqual(P0_BLOCKED_AUTONOMY, ['A4', 'A5']);
  assert.equal(isP0Forbidden({ risk: 'external', requestedAutonomy: 'A3' }), true);
  assert.equal(isP0Forbidden({ risk: 'reversible', requestedAutonomy: 'A3' }), false);
  assert.equal(isP0Forbidden({ risk: 'observe', requestedAutonomy: 'A4' }), true);
  assert.throws(() => P0_BLOCKED_RISKS.push('new-risk'), TypeError);
});

test('normalizes explicit actor model provenance without treating null as complete', () => {
  const resolved = normalizeActor({ actorId: 'worker-1', resolvedModel: 'gpt-6.1-sol', modelProvider: 'gateway' });
  assert.deepEqual(resolved, {
    actorId: 'worker-1',
    resolvedModel: 'gpt-6.1-sol',
    modelProvider: 'gateway',
    status: 'RESOLVED',
    code: 'ACTOR_MODEL_RESOLVED',
  });
  const unknown = normalizeActor({ actorId: 'worker-1', resolvedModel: null, modelProvider: 'gateway' });
  assert.equal(unknown.status, 'UNKNOWN');
  assert.equal(unknown.resolvedModel, null);
  assert.equal(unknown.code, 'ACTOR_MODEL_UNKNOWN');
});

test('rejects malformed actor provenance', () => {
  assert.throws(() => normalizeActor({}), /ACTOR_INVALID/);
  assert.throws(() => normalizeActor({ actorId: 'worker-1', resolvedModel: 42 }), /ACTOR_MODEL_INVALID/);
  assert.throws(() => normalizeActor({ actorId: 'worker-1', resolvedModel: 'model', modelProvider: 42 }), /ACTOR_PROVIDER_INVALID/);
});

test('publishes stable decision and result error-code vocabularies', () => {
  assert.equal(DECISION_CODES.P0_EXTERNAL_EFFECT_BLOCKED, 'P0_EXTERNAL_EFFECT_BLOCKED');
  assert.equal(DECISION_CODES.A4_CONFIRMATION_REQUIRED, 'A4_CONFIRMATION_REQUIRED');
  assert.equal(RESULT_CODES.SUCCEEDED, 'SUCCEEDED');
  assert.equal(RESULT_CODES.EXTERNAL_RESULT_UNKNOWN, 'EXTERNAL_RESULT_UNKNOWN');
});
