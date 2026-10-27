import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { openAgenticDb, migrate } from '../../../../scripts/agentic/db/index.mjs';
import { createMissionStore } from '../../../../scripts/agentic/mission/store.mjs';

const migrationDir = fileURLToPath(new URL('../../../../scripts/agentic/db/migrations/', import.meta.url));
const mission = (overrides = {}) => ({
  id: 'm1', ownerId: 'o1', revision: 1, schemaVersion: 1, blockId: 'b1', goal: 'research',
  state: 'draft', autonomy: 'A2', scanId: null, previewId: null, contractId: null,
  createdAt: '2026-10-27T12:00:00Z', updatedAt: '2026-10-27T12:00:00Z', deletedAt: null,
  ...overrides,
});

test('migration creates mission, grant, event and idempotency tables with owner boundaries', () => {
  const db = openAgenticDb(':memory:');
  try {
    const applied = migrate(db, migrationDir);
    assert.deepEqual(applied, ['mission-001-core.sql']);
    for (const table of ['missions', 'mission_events', 'mission_grants', 'mission_idempotency']) {
      assert.doesNotThrow(() => db.prepare(`SELECT * FROM ${table}`).all());
    }
    assert.deepEqual(migrate(db, migrationDir), []);
  } finally { db.close(); }
});

test('store persists owner-scoped revisions and idempotent command results', () => {
  const db = openAgenticDb(':memory:');
  migrate(db, migrationDir);
  const store = createMissionStore(db);
  try {
    assert.equal(store.saveMission(mission()).ok, true);
    assert.equal(store.getMission('o1', 'm1').goal, 'research');
    assert.equal(store.getMission('o2', 'm1'), null);
    assert.equal(store.appendEvent({ ownerId: 'o1', missionId: 'm1', eventId: 'e1', from: 'draft', to: 'scanned', payload: '{}' }).ok, true);
    assert.equal(store.appendEvent({ ownerId: 'o1', missionId: 'm1', eventId: 'e1', from: 'draft', to: 'scanned', payload: '{}' }).duplicate, true);
    assert.equal(store.updateMission(mission({ state: 'scanned', revision: 2 }), { ownerId: 'o1', expectedRevision: 1 }).ok, true);
    assert.equal(store.updateMission(mission({ state: 'previewed', revision: 2 }), { ownerId: 'o1', expectedRevision: 1 }).error.code, 'CONFLICT');
    assert.equal(store.rememberCommand('o1', 'cmd-1', { pending: true }).duplicate, false);
    assert.deepEqual(store.rememberCommand('o1', 'cmd-1', { ok: true }), { duplicate: false });
    assert.deepEqual(store.rememberCommand('o1', 'cmd-1', { ok: true }), { duplicate: true, result: { ok: true } });
  } finally { db.close(); }
});

test('store rejects stale grant writes and preserves owner isolation', () => {
  const db = openAgenticDb(':memory:');
  migrate(db, migrationDir);
  const store = createMissionStore(db);
  try {
    const grant = { ownerId: 'o1', id: 'g1', revision: 1, contractHash: 'a'.repeat(64), actor: 'writer', capabilities: ['files.read'], dataDisclosure: ['notes'], expiresAt: '2026-10-27T18:00:00Z', status: 'active' };
    store.saveGrant(grant);
    assert.equal(store.getGrant('o2', 'g1'), undefined);
    assert.equal(store.updateGrant({ ...grant, revision: 2, status: 'revoked' }, { ownerId: 'o1', expectedRevision: 99 }).error.code, 'CONFLICT');
    assert.equal(store.updateGrant({ ...grant, revision: 2, status: 'revoked' }, { ownerId: 'o1', expectedRevision: 1 }).ok, true);
  } finally { db.close(); }
});

test('store recovers persisted events after reopening a file database', () => {
  const dir = mkdtempSync(join(tmpdir(), 'donego-w3-'));
  const file = join(dir, 'agentic.sqlite');
  let db = openAgenticDb(file); migrate(db, migrationDir);
  let store = createMissionStore(db);
  store.saveMission(mission());
  store.appendEvent({ ownerId: 'o1', missionId: 'm1', eventId: 'e1', from: 'draft', to: 'scanned', payload: '{}' });
  store.saveGrant({ ownerId: 'o1', id: 'g1', revision: 1, contractHash: 'a'.repeat(64), actor: 'writer', capabilities: ['files.read'], dataDisclosure: ['notes'], expiresAt: '2026-10-27T18:00:00Z', status: 'active' });
  assert.equal(store.invalidateGrants('o1', 'a'.repeat(64)).count, 1);
  db.close();
  db = openAgenticDb(file); migrate(db, migrationDir); store = createMissionStore(db);
  try {
    assert.deepEqual(store.listEvents('o1', 'm1').map(event => event.eventId), ['e1']);
  } finally { db.close(); }
});
