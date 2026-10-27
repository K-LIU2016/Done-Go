// S2D-W6 module 8: confirm-entry — the 确认入口 on a preview version.
// Records confirm / request_change / decline bound to (previewVersion, actor);
// only confirm emits a contract-draft-request EVENT (interface for W3 — this
// stream never creates contracts or touches missions). P0→contracted produces
// no external side effects: writes land in preview_confirmations only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { openMigratedDb, makeClock, makePreview, MIGRATIONS_DIR } from './_helpers.mjs';

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
    // W13 integrate (M09): the shared W0 ledger also applies W3's
    // mission-001-core.sql, so the missions table legitimately EXISTS here and
    // "it must not exist" no longer holds. Same-strength boundary, proven two
    // ways in the integrated tree: (1) no W6 migration file ever declares a
    // W3-owned table, and (2) the confirm action writes no rows into missions.
    const missionsBefore = world.db.prepare('SELECT COUNT(*) AS n FROM missions').get().n;
    await world.confirmEntry.record({
      ownerId: 'owner-a', missionId: 'm1', previewVersion: 1, actor: 'user', decision: 'confirm',
    });
    const after = await tableCounts(world.db);
    for (const table of W6_TABLES) {
      const expected = table === 'preview_confirmations' ? before[table] + 1 : before[table];
      assert.equal(after[table], expected, `${table} must not change`);
    }
    for (const sqlFile of ['preview-001-store.sql', 'preview-002-discussion.sql']) {
      const sql = readFileSync(join(MIGRATIONS_DIR, sqlFile), 'utf8');
      assert.doesNotMatch(
        sql,
        /CREATE\s+(?:UNIQUE\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["'`]?missions\b/i,
        `${sqlFile} must not declare W3's missions table (soft refs are fine)`,
      );
    }
    const missionsAfter = world.db.prepare('SELECT COUNT(*) AS n FROM missions').get().n;
    assert.equal(missionsAfter, missionsBefore, 'W6 confirm must not write into missions (owned by W3)');
  } finally {
    world.db.close();
  }
});

test('key-shape and note validation are CONTRACT_INVALID and write nothing', async () => {
  const world = await freshWorld();
  try {
    const badInputs = [
      { ownerId: '', missionId: 'm1', previewVersion: 1, actor: 'user', decision: 'confirm' },
      { ownerId: 'owner-a', missionId: '   ', previewVersion: 1, actor: 'user', decision: 'confirm' },
      { ownerId: 'owner-a', missionId: 'm1', previewVersion: 0, actor: 'user', decision: 'confirm' },
      { ownerId: 'owner-a', missionId: 'm1', previewVersion: '1', actor: 'user', decision: 'confirm' },
      { ownerId: 'owner-a', missionId: 'm1', previewVersion: 1, actor: 'user', decision: 'confirm', note: 42 },
      { ownerId: 'owner-a', missionId: 'm1', previewVersion: 1, actor: 'user', decision: 'confirm', note: 'n'.repeat(2001) },
    ];
    for (const params of badInputs) {
      await assert.rejects(
        () => world.confirmEntry.record(params),
        error => error.code === 'CONTRACT_INVALID',
        `expected CONTRACT_INVALID for ${JSON.stringify(params)}`,
      );
    }
    assert.equal((await world.confirmEntry.list({ ownerId: 'owner-a', missionId: 'm1' })).length, 0);
  } finally {
    world.db.close();
  }
});

test('replay collapses onto the original record even with a drifted note', async () => {
  const world = await freshWorld();
  try {
    const first = await world.confirmEntry.record({
      ownerId: 'owner-a', missionId: 'm1', previewVersion: 1, actor: 'user', decision: 'confirm',
    });
    assert.equal(first.note, null);
    const replay = await world.confirmEntry.record({
      ownerId: 'owner-a', missionId: 'm1', previewVersion: 1, actor: 'user', decision: 'confirm', note: '再想想',
    });
    assert.equal(replay.id, first.id);
    assert.equal(replay.replayed, true);
    assert.equal(replay.note, null, 'the stored note wins: a drifted retry never rewrites a recorded decision');
  } finally {
    world.db.close();
  }
});

test('idempotent replay survives a later soft delete of the confirmed version', async () => {
  const world = await freshWorld();
  try {
    const first = await world.confirmEntry.record({
      ownerId: 'owner-a', missionId: 'm1', previewVersion: 1, actor: 'user', decision: 'confirm',
    });
    await world.previewStore.softDelete({ ownerId: 'owner-a', missionId: 'm1', version: 1 });
    const replay = await world.confirmEntry.record({
      ownerId: 'owner-a', missionId: 'm1', previewVersion: 1, actor: 'user', decision: 'confirm',
    });
    assert.equal(replay.id, first.id, 'a retry of an already-recorded decision replays it');
    assert.equal(replay.replayed, true);
  } finally {
    world.db.close();
  }
});

test('list returns decisions in append order; corrupted stored event JSON fails closed', async () => {
  const world = await freshWorld();
  try {
    await world.confirmEntry.record({
      ownerId: 'owner-a', missionId: 'm1', previewVersion: 1, actor: 'user', decision: 'confirm', note: '就绪',
    });
    await world.confirmEntry.record({
      ownerId: 'owner-a', missionId: 'm1', previewVersion: 1, actor: 'user', decision: 'decline',
    });
    const rows = await world.confirmEntry.list({ ownerId: 'owner-a', missionId: 'm1' });
    assert.deepEqual(rows.map(row => row.decision), ['confirm', 'decline']);
    assert.equal(rows[0].note, '就绪');
    assert.equal(rows[0].event.type, 'contract-draft-request');
    assert.equal(rows[0].event.previewVersion, 1);
    assert.equal(rows[1].event, null);

    world.db
      .prepare("UPDATE preview_confirmations SET event = '{not-json' WHERE decision = 'confirm'")
      .run();
    await assert.rejects(
      () => world.confirmEntry.list({ ownerId: 'owner-a', missionId: 'm1' }),
      error => error.code === 'CONTRACT_INVALID',
      'a corrupted stored event must surface as CONTRACT_INVALID, never as a plausible event',
    );
  } finally {
    world.db.close();
  }
});
