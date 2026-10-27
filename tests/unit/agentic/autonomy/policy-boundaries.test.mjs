import test from 'node:test';
import assert from 'node:assert/strict';

import { evaluateAction } from '../../../../scripts/agentic/autonomy/policy.mjs';

const NOW = '2026-10-27T10:00:00.000Z';
const ACTOR = { actorId: 'worker-1', resolvedModel: 'gpt-6.1-sol', modelProvider: 'gateway' };
const BASE = {
  ownerId: 'owner-1',
  mission: { id: 'm-1', ownerId: 'owner-1', state: 'contracted', autonomy: 'A3' },
  contract: {
    id: 'c-1', ownerId: 'owner-1', missionId: 'm-1', hash: 'contract-hash', status: 'active',
    capabilities: [{ capability: 'files.write', scope: '/workspace/m-1' }],
    dataDisclosure: [{ dataClass: 'personal', to: 'local', fields: ['notes.title'] }],
    budget: { modelCalls: 4, tokens: 1000, costCap: 2, localSlots: 1 },
    window: { prepStart: '2026-10-27T09:00:00.000Z', start: '2026-10-27T10:00:00.000Z', end: '2026-10-27T11:00:00.000Z' },
    wont: ['do not send externally'],
  },
  grant: {
    id: 'g-1', ownerId: 'owner-1', actor: 'worker-1', contractHash: 'contract-hash', status: 'active',
    capabilities: [{ capability: 'files.write', scope: '/workspace/m-1' }],
    expiresAt: '2026-10-27T11:00:00.000Z',
  },
  action: {
    id: 'a-1', ownerId: 'owner-1', capability: 'files.write', scope: '/workspace/m-1/new.md',
    risk: 'reversible', requestedAutonomy: 'A3', actor: ACTOR,
    estimate: { modelCalls: 1, tokens: 100, cost: 0, localSlots: 1 },
  },
};

const input = (overrides = {}) => ({
  ...BASE, ...overrides,
  mission: { ...BASE.mission, ...(overrides.mission ?? {}) },
  contract: { ...BASE.contract, ...(overrides.contract ?? {}) },
  grant: overrides.grant === null ? null : { ...BASE.grant, ...(overrides.grant ?? {}) },
  action: { ...BASE.action, ...(overrides.action ?? {}) },
});

function result(overrides, options = { now: NOW, phase: 'P1' }) {
  return evaluateAction(input(overrides), options);
}

test('requires contract capability and exact contract hash for the action', () => {
  assert.equal(result({ action: { contractHash: 'other' } }).code, 'CONTRACT_HASH_MISMATCH');
  assert.equal(result({ contract: { capabilities: [{ capability: 'files.read', scope: '/workspace/m-1' }] } }).code, 'SCOPE_DENIED');
});

test('binds a grant to the actor and explicit model provenance', () => {
  assert.equal(result({ grant: { actor: 'other' } }).code, 'GRANT_ACTOR_MISMATCH');
  assert.equal(result({ grant: { resolvedModel: 'gpt-6.1-sol' }, action: { actor: { actorId: 'worker-1', resolvedModel: 'other', modelProvider: 'gateway' } } }).code, 'GRANT_ACTOR_MODEL_MISMATCH');
});

test('fails closed when data disclosure does not cover destination or fields', () => {
  assert.equal(result({ action: { dataClass: 'sensitive', dataDestination: 'local', dataFields: ['notes.title'] } }).code, 'DATA_DISCLOSURE_DENIED');
  assert.equal(result({ action: { dataClass: 'personal', dataDestination: 'cloud-model', dataFields: ['notes.title'] } }).code, 'DATA_DISCLOSURE_DENIED');
  assert.equal(result({ action: { dataClass: 'personal', dataDestination: 'local', dataFields: ['notes.body'] } }).code, 'DATA_DISCLOSURE_DENIED');
});

test('enforces the contract window including the preparation window', () => {
  const validGrant = { expiresAt: '2026-10-27T12:00:00.000Z' };
  assert.equal(result({ grant: validGrant }, { now: '2026-10-27T08:59:59.000Z', phase: 'P1' }).code, 'WINDOW_OUTSIDE');
  assert.equal(result({ grant: validGrant }, { now: '2026-10-27T10:30:00.000Z', phase: 'P1' }).code, 'ALLOWED');
  assert.equal(result({ grant: validGrant }, { now: '2026-10-27T11:00:00.000Z', phase: 'P1' }).code, 'WINDOW_OUTSIDE');
});

test('treats the grant expiry instant as expired with an injected fixed clock', () => {
  const expiresAt = '2026-10-27T11:00:00.000Z';
  const validGrant = { expiresAt };
  assert.equal(result({ grant: validGrant }, { now: '2026-10-27T10:59:59.999Z', phase: 'P1' }).code, 'ALLOWED');
  assert.equal(result({ grant: validGrant }, { now: expiresAt, phase: 'P1' }).code, 'GRANT_EXPIRED');
});

test('enforces budget against cumulative spend and rejects malformed estimates', () => {
  assert.equal(result({ spent: { modelCalls: 3, tokens: 950, cost: 1.5, localSlots: 0 } }).code, 'BUDGET_EXCEEDED');
  assert.equal(result({ action: { estimate: { modelCalls: -1, tokens: 1, cost: 0, localSlots: 0 } } }).code, 'BUDGET_INVALID');
});

test('defaults to deny for malformed or missing action context', () => {
  assert.equal(evaluateAction({}).status, 'blocked');
  assert.equal(result({ contract: { hash: 'other' } }).code, 'GRANT_CONTRACT_MISMATCH');
});
