// S2D-W6 module 3: preview-store — immutable per-mission version chain.
// put assigns versions, get/latest/list are owner-scoped, soft delete hides,
// baseVersion gives optimistic concurrency (CONFLICT), reads validate the
// stored payload (fail closed on corruption).
import test from 'node:test';
import assert from 'node:assert/strict';
import { openMigratedDb, makeClock, makePreview, makeMinimalPreview } from './_helpers.mjs';

async function loadStore() {
  return import('../../../../scripts/agentic/preview/store.mjs');
}

async function freshStore() {
  const { createPreviewStore } = await loadStore();
  const db = openMigratedDb();
  const store = createPreviewStore(db, { now: makeClock() });
  return { db, store };
}

test('put assigns version 1 then 2 regardless of the incoming preview.version', async () => {
  const { db, store } = await freshStore();
  try {
    const first = await store.put({ ownerId: 'owner-a', missionId: 'm1', preview: makePreview({ missionId: 'm1', version: 99 }) });
    assert.equal(first.version, 1);
    assert.equal(first.revision, 1);
    assert.ok(first.id);
    assert.equal(first.preview.version, 1);
    assert.equal(first.preview.missionId, 'm1');

    const second = await store.put({ ownerId: 'owner-a', missionId: 'm1', preview: makeMinimalPreview('m1', 7) });
    assert.equal(second.version, 2);
  } finally {
    db.close();
  }
});

test('versions are immutable: get(version 1) returns the original payload after later puts', async () => {
  const { db, store } = await freshStore();
  try {
    const original = makePreview({ missionId: 'm1' });
    await store.put({ ownerId: 'owner-a', missionId: 'm1', preview: original });
    await store.put({ ownerId: 'owner-a', missionId: 'm1', preview: makeMinimalPreview('m1') });
    const row = await store.get({ ownerId: 'owner-a', missionId: 'm1', version: 1 });
    assert.deepEqual(row.preview, original);
    const rows = await store.list({ ownerId: 'owner-a', missionId: 'm1' });
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map(row => row.version), [1, 2]);
  } finally {
    db.close();
  }
});

test('put validates against the frozen schema and stores nothing on failure', async () => {
  const { db, store } = await freshStore();
  try {
    await assert.rejects(
      () => store.put({ ownerId: 'owner-a', missionId: 'm1', preview: makePreview({ confidence: 9 }) }),
      error => error.code === 'CONTRACT_INVALID',
    );
    assert.equal(await store.latest({ ownerId: 'owner-a', missionId: 'm1' }), null);
    assert.deepEqual(await store.list({ ownerId: 'owner-a', missionId: 'm1' }), []);
  } finally {
    db.close();
  }
});

test('latest/get/list are owner-scoped; a foreign owner sees nothing', async () => {
  const { db, store } = await freshStore();
  try {
    await store.put({ ownerId: 'owner-a', missionId: 'm1', preview: makeMinimalPreview('m1') });
    assert.equal(await store.latest({ ownerId: 'owner-b', missionId: 'm1' }), null);
    assert.equal(await store.get({ ownerId: 'owner-b', missionId: 'm1', version: 1 }), null);
    assert.deepEqual(await store.list({ ownerId: 'owner-b', missionId: 'm1' }), []);
    // Same owner, other mission: also empty (mission-scoped).
    assert.equal(await store.latest({ ownerId: 'owner-a', missionId: 'm_other' }), null);
  } finally {
    db.close();
  }
});

test('baseVersion gives optimistic concurrency: stale base CONFLICTs and writes nothing', async () => {
  const { db, store } = await freshStore();
  try {
    await store.put({ ownerId: 'owner-a', missionId: 'm1', preview: makeMinimalPreview('m1') });
    const second = await store.put({
      ownerId: 'owner-a', missionId: 'm1', baseVersion: 1,
      preview: makeMinimalPreview('m1'),
    });
    assert.equal(second.version, 2);
    await assert.rejects(
      () => store.put({
        ownerId: 'owner-a', missionId: 'm1', baseVersion: 1,
        preview: makeMinimalPreview('m1'),
      }),
      error => error.code === 'CONFLICT',
    );
    assert.equal((await store.latest({ ownerId: 'owner-a', missionId: 'm1' })).version, 2);
  } finally {
    db.close();
  }
});

test('softDelete hides a version from get/latest/list; deleting again is NOT_FOUND', async () => {
  const { db, store } = await freshStore();
  try {
    await store.put({ ownerId: 'owner-a', missionId: 'm1', preview: makeMinimalPreview('m1') });
    await store.put({ ownerId: 'owner-a', missionId: 'm1', preview: makeMinimalPreview('m1') });
    await store.softDelete({ ownerId: 'owner-a', missionId: 'm1', version: 2 });
    assert.equal(await store.get({ ownerId: 'owner-a', missionId: 'm1', version: 2 }), null);
    assert.equal((await store.latest({ ownerId: 'owner-a', missionId: 'm1' })).version, 1);
    assert.deepEqual((await store.list({ ownerId: 'owner-a', missionId: 'm1' })).map(row => row.version), [1]);
    await assert.rejects(
      () => store.softDelete({ ownerId: 'owner-a', missionId: 'm1', version: 2 }),
      error => error.code === 'NOT_FOUND',
    );
    // Foreign owner cannot delete owner-a's version.
    await assert.rejects(
      () => store.softDelete({ ownerId: 'owner-b', missionId: 'm1', version: 1 }),
      error => error.code === 'NOT_FOUND',
    );
  } finally {
    db.close();
  }
});

test('a corrupted stored payload fails closed on read with CONTRACT_INVALID', async () => {
  const { db, store } = await freshStore();
  try {
    const row = await store.put({ ownerId: 'owner-a', missionId: 'm1', preview: makeMinimalPreview('m1') });
    db.prepare('UPDATE previews SET payload = ? WHERE id = ?').run('{"missionId": "m1", "version": 1}', row.id);
    await assert.rejects(
      () => store.get({ ownerId: 'owner-a', missionId: 'm1', version: 1 }),
      error => error.code === 'CONTRACT_INVALID',
    );
  } finally {
    db.close();
  }
});

// Negative paths from plan §2 (missionId empty → CONTRACT_INVALID, malformed
// inputs fail closed before any write, baseVersion against an empty chain).
test('malformed put inputs fail closed with CONTRACT_INVALID and write nothing', async () => {
  const { db, store } = await freshStore();
  try {
    await assert.rejects(
      () => store.put({ ownerId: '', missionId: 'm1', preview: makeMinimalPreview('m1') }),
      error => error.code === 'CONTRACT_INVALID',
    );
    await assert.rejects(
      () => store.put({ ownerId: 'owner-a', missionId: '', preview: makeMinimalPreview('m1') }),
      error => error.code === 'CONTRACT_INVALID',
    );
    await assert.rejects(
      () => store.put({ ownerId: 'owner-a', missionId: 'm1', preview: 'not-an-object' }),
      error => error.code === 'CONTRACT_INVALID',
    );
    await assert.rejects(
      () => store.put({ ownerId: 'owner-a', missionId: 'm1', preview: makeMinimalPreview('other') }),
      error => error.code === 'CONTRACT_INVALID',
    );
    await assert.rejects(
      () => store.put({ ownerId: 'owner-a', missionId: 'm1', baseVersion: 'one', preview: makeMinimalPreview('m1') }),
      error => error.code === 'CONTRACT_INVALID',
    );
    assert.deepEqual(await store.list({ ownerId: 'owner-a', missionId: 'm1' }), []);
  } finally {
    db.close();
  }
});

test('baseVersion against an empty chain CONFLICTs (the base never existed)', async () => {
  const { db, store } = await freshStore();
  try {
    await assert.rejects(
      () => store.put({ ownerId: 'owner-a', missionId: 'm1', baseVersion: 1, preview: makeMinimalPreview('m1') }),
      error => error.code === 'CONFLICT',
    );
    assert.equal(await store.latest({ ownerId: 'owner-a', missionId: 'm1' }), null);
  } finally {
    db.close();
  }
});

test('malformed version lookups fail closed with CONTRACT_INVALID', async () => {
  const { db, store } = await freshStore();
  try {
    await assert.rejects(
      () => store.get({ ownerId: 'owner-a', missionId: 'm1', version: 0 }),
      error => error.code === 'CONTRACT_INVALID',
    );
    await assert.rejects(
      () => store.softDelete({ ownerId: 'owner-a', missionId: 'm1', version: 'two' }),
      error => error.code === 'CONTRACT_INVALID',
    );
    await assert.rejects(
      () => store.latest({ ownerId: 'owner-b', missionId: '' }),
      error => error.code === 'CONTRACT_INVALID',
    );
  } finally {
    db.close();
  }
});
