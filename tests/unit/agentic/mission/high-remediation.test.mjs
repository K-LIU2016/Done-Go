import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { validate } from '../../../../scripts/agentic/contracts.mjs';
import { transitionMission, replayMission } from '../../../../scripts/agentic/mission/state-machine.mjs';
import { proposeGrant, activateGrant, checkGrant } from '../../../../scripts/agentic/mission/grants.mjs';
import { openAgenticDb, migrate } from '../../../../scripts/agentic/db/index.mjs';
import { createMissionStore } from '../../../../scripts/agentic/mission/store.mjs';
import { createMissionRoutes } from '../../../../scripts/agentic/mission/routes.mjs';

const dir = fileURLToPath(new URL('../../../../scripts/agentic/db/migrations/', import.meta.url));
const hash = 'a'.repeat(64);
const mission = (overrides = {}) => ({
  id: 'm1', revision: 1, schemaVersion: 1, blockId: 'b1', goal: 'research', state: 'draft', autonomy: 'A2',
  scanId: null, previewId: null, contractId: null, createdAt: '2026-10-27T12:00:00Z', updatedAt: '2026-10-27T12:00:00Z', deletedAt: null,
  ...overrides,
});
const grant = (overrides = {}) => ({
  id: 'g1', revision: 1, schemaVersion: 1, createdAt: '2026-10-27T12:00:00Z', updatedAt: '2026-10-27T12:00:00Z', deletedAt: null,
  source: 'real', ownerId: 'o1', contractHash: hash, actor: 'writer', capabilities: ['files.read'], dataDisclosure: ['notes'],
  expiresAt: '2026-10-27T18:00:00Z', status: 'proposed', ...overrides,
});
const response = () => ({ statusCode: 200, body: null, writeHead(code) { this.statusCode = code; }, end(value) { this.body = value ? JSON.parse(value) : null; } });
const request = (method, url, ownerId, value) => ({ method, url, ownerId, headers: {}, async json() { return value; } });
async function call(routes, method, url, ownerId, value) {
  const res = response();
  await routes(request(method, url, ownerId, value), res, url);
  return res;
}
function harness() {
  const db = openAgenticDb(':memory:'); migrate(db, dir);
  const store = createMissionStore(db);
  const routes = createMissionRoutes({ db, store, auth: { ownerId(req) { return req.ownerId; } } });
  return { db, store, routes };
}

test('RED A/G: mission creation is draft-only, safe autonomy, and strips lifecycle fields', async () => {
  const { db, routes } = harness();
  try {
    const bad = await call(routes, 'POST', '/api/missions', 'o1', mission({ state: 'live', autonomy: 'A5' }));
    assert.equal(bad.statusCode, 400);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM missions').get().count, 0);
    const good = await call(routes, 'POST', '/api/missions', 'o1', mission({ autonomy: 'A1', contractId: 'forged', contractHash: hash, resumeState: 'delivered', blockedReason: 'forged' }));
    assert.equal(good.statusCode, 201);
    assert.equal(good.body.state, 'draft');
    assert.equal(good.body.ownerId, 'o1');
    assert.equal(good.body.revision, 1);
    assert.equal(good.body.contractId, null);
    assert.equal(good.body.contractHash, undefined);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM missions').get().count, 1);
  } finally { db.close(); }
});

test('RED B: resume only uses persisted resumeState and rejects tampered values', () => {
  const paused = mission({ state: 'paused', resumeState: 'prepping', contractId: 'c1', contractHash: hash });
  const resumed = transitionMission(paused, 'resume', { contractHash: hash, resumeState: 'delivered' });
  assert.equal(resumed.ok, true);
  assert.equal(resumed.mission.state, 'prepping');
  assert.equal(transitionMission({ ...paused, resumeState: 'delivered' }, 'resume', { contractHash: hash }).ok, false);
});

test('RED C/E/F: conflict is replayable, expiry is replayable, and event ids are mission-scoped', () => {
  const initial = mission({ ownerId: 'o1', state: 'previewed', previewId: 'p1' });
  const expired = transitionMission(initial, 'expire', { now: '2026-10-27T14:00:00Z', windowStart: '2026-10-27T14:00:00Z', eventId: 'same' });
  assert.equal(expired.ok, true);
  assert.equal(replayMission(initial, [expired.event]).ok, true);
  const db = openAgenticDb(':memory:'); migrate(db, dir); const store = createMissionStore(db);
  try {
    store.saveMission(mission({ id: 'm1', ownerId: 'o1' }));
    store.saveMission(mission({ id: 'm2', ownerId: 'o1' }));
    assert.equal(store.appendEvent({ ownerId: 'o1', missionId: 'm1', eventId: 'same', revision: 2, from: 'draft', to: 'scanned', payload: '{}' }).duplicate, false);
    assert.equal(store.appendEvent({ ownerId: 'o1', missionId: 'm2', eventId: 'same', revision: 2, from: 'draft', to: 'scanned', payload: '{}' }).duplicate, false);
  } finally { db.close(); }
});

test('RED D/H: frozen grants persist complete shape and are mission/model/scope bound by sidecar', async () => {
  const schema = JSON.parse(await (await import('node:fs/promises')).readFile(new URL('../../../../contracts/agentic/grant.schema.json', import.meta.url), 'utf8'));
  assert.equal(validate(grant(), schema).valid, true);
  const proposed = proposeGrant(grant());
  assert.equal(proposed.ok, true);
  const active = activateGrant(proposed.grant, { ownerId: 'o1', actor: 'writer', contractHash: hash, resolvedModel: 'model-1', now: '2026-10-27T15:00:00Z' });
  assert.equal(active.ok, true);
  assert.equal(checkGrant(active.grant, { ownerId: 'o1', actor: 'writer', contractHash: hash, resolvedModel: 'model-1', now: '2026-10-27T15:00:00Z', capability: 'files.read', resource: '/private/secret' }).ok, false);
});
