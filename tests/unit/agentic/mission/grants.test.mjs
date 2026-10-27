import test from 'node:test';
import assert from 'node:assert/strict';
import {
  proposeGrant,
  activateGrant,
  checkGrant,
  consumeGrant,
  revokeGrant,
  expireGrant,
  invalidateGrant,
} from '../../../../scripts/agentic/mission/grants.mjs';

const hash = 'a'.repeat(64);
const grant = (overrides = {}) => ({
  id: 'g1', ownerId: 'o1', contractHash: hash, actor: 'writer',
  capabilities: ['files.read'], dataDisclosure: ['notes'],
  expiresAt: '2026-10-27T18:00:00Z', status: 'proposed', revision: 1,
  ...overrides,
});
const context = (overrides = {}) => ({
  ownerId: 'o1', actor: 'writer', contractHash: hash, capability: 'files.read',
  resource: '/docs/course/a.md', allowedResources: ['/docs/course'],
  dataClass: 'notes', allowedDataClasses: ['notes'],
  now: '2026-10-27T15:00:00Z', windowStart: '2026-10-27T14:00:00Z', windowEnd: '2026-10-27T17:00:00Z',
  spent: 1, estimate: 1, budget: 5, resolvedModel: 'gpt-6.1-sol',
  ...overrides,
});

function successful(result) {
  assert.equal(result.ok, true, result.error?.message);
  return result.grant ?? result;
}
function denied(result, code) {
  assert.equal(result.ok, false);
  assert.equal(result.error.code, code);
}

test('runs a proposed grant through active and consumed exactly once', () => {
  let current = successful(proposeGrant(grant()));
  current = successful(activateGrant(current, context()));
  const checked = checkGrant(current, context());
  assert.equal(checked.ok, true);
  current = successful(consumeGrant(current, context()));
  assert.equal(current.status, 'consumed');
  denied(checkGrant(current, context()), 'GRANT_NOT_ACTIVE');
  denied(consumeGrant(current, context()), 'GRANT_NOT_ACTIVE');
});

test('rejects proposed grants and unknown actors or unresolved models', () => {
  denied(checkGrant(grant(), context()), 'GRANT_NOT_ACTIVE');
  denied(activateGrant(grant(), context({ actor: '' })), 'ACTOR_REQUIRED');
  denied(activateGrant(grant(), context({ resolvedModel: null })), 'MODEL_UNKNOWN');
});

test('rejects owner, actor, contract, capability, resource and disclosure mismatches', () => {
  const active = successful(activateGrant(grant(), context()));
  for (const [overrides, code] of [
    [{ ownerId: 'o2' }, 'FORBIDDEN'],
    [{ actor: 'other' }, 'FORBIDDEN'],
    [{ contractHash: 'b'.repeat(64) }, 'CONTRACT_MISMATCH'],
    [{ capability: 'files.write' }, 'CAPABILITY_DENIED'],
    [{ resource: '/private/secret' }, 'SCOPE_DENIED'],
    [{ dataClass: 'email' }, 'DISCLOSURE_DENIED'],
  ]) denied(checkGrant(active, context(overrides)), code);
});

test('rejects outside-window, expired and over-budget calls', () => {
  const active = successful(activateGrant(grant(), context()));
  denied(checkGrant(active, context({ now: '2026-10-27T13:59:59Z' })), 'WINDOW_CLOSED');
  denied(checkGrant(active, context({ now: '2026-10-27T18:00:00Z' })), 'GRANT_EXPIRED');
  denied(checkGrant(active, context({ spent: 5, estimate: 1 })), 'BUDGET_EXCEEDED');
});

test('supports revoke, expiry and contract-change invalidation but not recovery', () => {
  const active = successful(activateGrant(grant(), context()));
  let current = successful(revokeGrant(active, context()));
  denied(checkGrant(current, context()), 'GRANT_REVOKED');
  current = successful(activateGrant(grant({ id: 'g2' }), context()));
  current = successful(expireGrant(current, { ...context(), now: '2026-10-27T18:01:00Z' }));
  denied(checkGrant(current, context()), 'GRANT_EXPIRED');
  current = successful(activateGrant(grant({ id: 'g3' }), context()));
  current = successful(invalidateGrant(current, context({ newContractHash: 'b'.repeat(64) })));
  assert.equal(current.status, 'invalidated');
  denied(activateGrant(current, context()), 'GRANT_NOT_PROPOSED');
});

test('does not authorize A4 or A5 through a reusable grant', () => {
  const proposed = grant({ capabilities: ['external.send'] });
  denied(activateGrant(proposed, context({ actionAutonomy: 'A4' })), 'CONFIRMATION_REQUIRED');
  denied(activateGrant(proposed, context({ actionAutonomy: 'A5' })), 'AUTONOMY_FORBIDDEN');
});
