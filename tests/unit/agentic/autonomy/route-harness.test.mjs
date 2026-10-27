import test from 'node:test';
import assert from 'node:assert/strict';

import { AuditLog } from '../../../../scripts/agentic/autonomy/audit.mjs';
import { ConfirmationStore } from '../../../../scripts/agentic/autonomy/confirmation.mjs';
import { AutonomyRuntime, createAutonomyRoutes } from '../../../../scripts/agentic/autonomy/runtime.mjs';

const ACTOR = { actorId: 'route-actor', modelProvider: 'gateway', resolvedModel: 'gpt-6.1-sol' };
const CLOCK = () => new Date('2026-10-27T10:00:00.000Z');
const BASE = {
  ownerId: 'owner-1',
  mission: { id: 'mission-1', ownerId: 'owner-1', state: 'contracted', autonomy: 'A3' },
  contract: {
    id: 'contract-1', ownerId: 'owner-1', missionId: 'mission-1', hash: 'contract-hash', status: 'active',
    capabilities: [{ capability: 'files.write', scope: '/workspace/mission-1' }],
  },
  grant: {
    id: 'grant-1', ownerId: 'owner-1', contractHash: 'contract-hash', status: 'active',
    capabilities: [{ capability: 'files.write', scope: '/workspace/mission-1' }],
    expiresAt: '2099-01-01T00:00:00.000Z',
  },
  action: {
    id: 'action-1', ownerId: 'owner-1', capability: 'files.write',
    scope: '/workspace/mission-1/output.md', risk: 'reversible',
    requestedAutonomy: 'A3', actor: ACTOR,
  },
  idempotencyKey: 'route-idem-1',
};

function request(overrides = {}) {
  return {
    ...BASE, ...overrides,
    mission: { ...BASE.mission, ...(overrides.mission ?? {}) },
    contract: { ...BASE.contract, ...(overrides.contract ?? {}) },
    grant: { ...BASE.grant, ...(overrides.grant ?? {}) },
    action: { ...BASE.action, ...(overrides.action ?? {}) },
  };
}

function makeRoute(options = {}) {
  return createAutonomyRoutes({ runtime: new AutonomyRuntime({ audit: new AuditLog({ clock: CLOCK }), clock: CLOCK, ...options }) });
}

test('route harness exposes a pure decision endpoint without invoking an executor', async () => {
  let calls = 0;
  const route = createAutonomyRoutes({
    runtime: new AutonomyRuntime({ audit: new AuditLog({ clock: CLOCK }), clock: CLOCK, execute: async () => { calls += 1; } }),
  });
  const response = await route({ method: 'POST', pathname: '/api/autonomy/decide', body: request() });
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { status: 'allowed', code: 'ALLOWED', requiresConfirmation: false });
  assert.equal(calls, 0);
});

test('route harness issues a one-time confirmation and audits the issuance', async () => {
  const audit = new AuditLog({ clock: CLOCK });
  const route = createAutonomyRoutes({ runtime: new AutonomyRuntime({ audit, phase: 'P1', clock: CLOCK }) });
  const body = request({
    mission: { autonomy: 'A4' },
    action: { capability: 'files.write', scope: '/workspace/mission-1/output.md', risk: 'external', requestedAutonomy: 'A4' },
  });
  const response = await route({ method: 'POST', pathname: '/api/autonomy/confirm', body });
  assert.equal(response.status, 200);
  assert.equal(typeof response.body.token, 'string');
  assert.equal(audit.events.at(-1).type, 'autonomy.confirmation.issued');
});

test('route harness executes only the dry-run adapter and returns idempotent results', async () => {
  const route = makeRoute({ phase: 'P1' });
  const body = request();
  const first = await route({ method: 'POST', pathname: '/api/autonomy/execute', body });
  const second = await route({ method: 'POST', pathname: '/api/autonomy/execute', body });
  assert.equal(first.status, 200);
  assert.equal(first.body.status, 'succeeded');
  assert.deepEqual(first.body.output, { dryRun: true });
  assert.deepEqual(second.body, first.body);
});

test('route harness recovers an unknown result without repeating the executor', async () => {
  const route = createAutonomyRoutes({
    runtime: new AutonomyRuntime({ audit: new AuditLog({ clock: CLOCK }), phase: 'P1', clock: CLOCK }),
    executor: async () => { throw Object.assign(new Error('disconnect'), { unknown: true }); },
  });
  const body = request({ idempotencyKey: 'unknown-route' });
  const first = await route({ method: 'POST', pathname: '/api/autonomy/execute', body });
  const recovered = await route({ method: 'POST', pathname: '/api/autonomy/recover', body });
  assert.equal(first.body.status, 'UNKNOWN');
  assert.equal(recovered.status, 200);
  assert.equal(recovered.body.status, 'UNKNOWN');
});

test('route harness rejects unsupported routes and malformed input without throwing', async () => {
  const route = makeRoute();
  assert.deepEqual(await route({ method: 'GET', pathname: '/api/autonomy/decide', body: {} }), {
    status: 404, body: { code: 'NOT_FOUND' },
  });
  const response = await route({ method: 'POST', pathname: '/api/autonomy/decide', body: {} });
  assert.equal(response.status, 400);
  assert.equal(response.body.code, 'CONTEXT_INVALID');
});

test('route harness fails closed when confirmation audit persistence fails', async () => {
  const confirmations = new ConfirmationStore({ clock: CLOCK });
  const audit = new AuditLog({ writer: async () => { throw new Error('audit unavailable'); }, clock: CLOCK });
  const runtime = new AutonomyRuntime({ audit, confirmations, phase: 'P1', clock: CLOCK });
  const route = createAutonomyRoutes({ runtime });
  const body = request({
    mission: { autonomy: 'A4' },
    action: { risk: 'external', requestedAutonomy: 'A4' },
  });
  const response = await route({ method: 'POST', pathname: '/api/autonomy/confirm', body });
  assert.equal(response.status, 400);
  assert.equal(response.body.code, 'AUDIT_WRITE_FAILED');
});
