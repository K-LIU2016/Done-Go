// S2D-W6 module 8: confirm-entry — the 确认入口 on a preview version.
// Records confirm / request_change / decline bound to (previewVersion, actor);
// only confirm emits a contract-draft-request EVENT (interface for W3 — this
// stream never creates contracts or touches missions). P0→contracted produces
// no external side effects: writes land in preview_confirmations only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openMigratedDb, makeClock, makePreview } from './_helpers.mjs';

async function loadConfirm() {
  return import('../../../../scripts/agentic/discussion/confirm.mjs');
}

async function loadPreviewStore() {
  return import('../../../../scripts/agentic/preview/store.mjs');
}

async function freshWorld() {
  const [{ createConfirmEntry }, { createPreviewStore }] = await Promise.all([loadConfirm(), loadPreviewStore()]);
  const db = openMigratedDb();
  const now = makeClock();
  const previewStore = createPreviewStore(db, { now });
  const confirmEntry = createConfirmEntry(db, { now });
  await previewStore.put({ ownerId: 'owner-a', missionId: 'm1', preview: makePreview({ missionId: 'm1' }) });
  return { db, previewStore, confirmEntry, now };
}

const W6_TABLES = ['previews', 'discussion_threads', 'discussion_messages', 'preview_confirmations', 'contract_change_records'];

async function tableCounts(db, owner = 'owner-a') {
  return Object.fromEntries(
    W6_TABLES.map(table => [table, db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE owner_id = ?`).get(owner).n]),
  );
}

test('confirm records the decision and emits a contract-draft-request event for W3', async () => {
  const world = await freshWorld();
  try {
    const record = await world.confirmEntry.record({
      ownerId: 'owner-a', missionId: 'm1', previewVersion: 1, actor: 'user', decision: 'confirm',
    });
    assert.ok(record.id);
    assert.equal(record.decision, 'confirm');
    assert.equal(record.replayed, false);
    assert.ok(record.event, 'confirm must carry the event');
    assert.equal(record.event.type, 'contract-draft-request');
    assert.equal(record.event.missionId, 'm1');
    assert.equal(record.event.previewVersion, 1);
    assert.equal(record.event.actor, 'user');
    assert.ok(record.event.emittedAt);
  } finally {
    world.db.close();
  }
});

test('request_change and decline record without an event', async () => {
  const world = await freshWorld();
  try {
    for (const decision of ['request_change', 'decline']) {
      const record = await world.confirmEntry.record({
        ownerId: 'owner-a', missionId: 'm1', previewVersion: 1, actor: 'user', decision, note: '再改改',
      });
      assert.equal(record.decision, decision);
      assert.equal(record.event, null);
      assert.equal(record.note, '再改改');
    }
  } finally {
    world.db.close();
  }
});

test('invalid decision or empty actor is CONTRACT_INVALID; unknown version is NOT_FOUND', async () => {
  const world = await freshWorld();
  try {
    await assert.rejects(
      () => world.confirmEntry.record({ ownerId: 'owner-a', missionId: 'm1', previewVersion: 1, actor: 'user', decision: 'maybe' }),
      error => error.code === 'CONTRACT_INVALID',
    );
    await assert.rejects(
      () => world.confirmEntry.record({ ownerId: 'owner-a', missionId: 'm1', previewVersion: 1, actor: '  ', decision: 'confirm' }),
      error => error.code === 'CONTRACT_INVALID',
    );
    await assert.rejects(
      () => world.confirmEntry.record({ ownerId: 'owner-a', missionId: 'm1', previewVersion: 4, actor: 'user', decision: 'confirm' }),
      error => error.code === 'NOT_FOUND',
    );
  } finally {
    world.db.close();
  }
});

test('replaying the same (version, actor, decision) returns the same record id', async () => {
  const world = await freshWorld();
  try {
    const first = await world.confirmEntry.record({
      ownerId: 'owner-a', missionId: 'm1', previewVersion: 1, actor: 'user', decision: 'confirm',
    });
    const replay = await world.confirmEntry.record({
      ownerId: 'owner-a', missionId: 'm1', previewVersion: 1, actor: 'user', decision: 'confirm',
    });
    assert.equal(replay.id, first.id);
    assert.equal(replay.replayed, true);
    assert.equal(await world.confirmEntry.list({ ownerId: 'owner-a', missionId: 'm1' }).then(rows => rows.length), 1);
    // A different actor or decision is a new record on the same version.
    await world.confirmEntry.record({ ownerId: 'owner-a', missionId: 'm1', previewVersion: 1, actor: 'admin', decision: 'confirm' });
    const rows = await world.confirmEntry.list({ ownerId: 'owner-a', missionId: 'm1' });
    assert.equal(rows.length, 2);
  } finally {
    world.db.close();
  }
});

test('soft-deleted preview versions can no longer be confirmed', async () => {
  const world = await freshWorld();
  try {
    await world.previewStore.put({ ownerId: 'owner-a', missionId: 'm1', preview: makePreview({ missionId: 'm1' }) });
    await world.previewStore.softDelete({ ownerId: 'owner-a', missionId: 'm1', version: 2 });
    await assert.rejects(
      () => world.confirmEntry.record({ ownerId: 'owner-a', missionId: 'm1', previewVersion: 2, actor: 'user', decision: 'confirm' }),
      error => error.code === 'NOT_FOUND',
    );
  } finally {
    world.db.close();
  }
});

test('owner isolation: another owner confirming the same mission/version is NOT_FOUND', async () => {
  const world = await freshWorld();
  try {
    await assert.rejects(
      () => world.confirmEntry.record({ ownerId: 'owner-b', missionId: 'm1', previewVersion: 1, actor: 'user', decision: 'confirm' }),
      error => error.code === 'NOT_FOUND',
    );
    assert.deepEqual(await world.confirmEntry.list({ ownerId: 'owner-b', missionId: 'm1' }), []);
  } finally {
    world.db.close();
  }
});

test('side-effect boundary: confirm writes ONLY into preview_confirmations', async () => {
  const world = await freshWorld();
  try {
    const before = await tableCounts(world.db);
    await world.confirmEntry.record({
      ownerId: 'owner-a', missionId: 'm1', previewVersion: 1, actor: 'user', decision: 'confirm',
    });
    const after = await tableCounts(world.db);
    for (const table of W6_TABLES) {
      const expected = table === 'preview_confirmations' ? before[table] + 1 : before[table];
      assert.equal(after[table], expected, `${table} must not change`);
    }
    // And the mission domain is not ours to touch: no missions table may exist from W6.
    const missionsTable = world.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'missions'")
      .get();
    assert.equal(missionsTable, undefined, 'W6 must not create a missions table (owned by W3)');
  } finally {
    world.db.close();
  }
});
