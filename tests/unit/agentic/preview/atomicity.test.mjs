// S2D-W6 remediation gate, blocker A (applyPatch atomicity): the discussion
// turn write path must land preview version + discussion message +
// contract_change_records in ONE BEGIN IMMEDIATE/COMMIT. The historical
// two-commit shape (previewStore.put, then discussionStore.appendMessage) had
// a crash window: when the second commit failed, the live preview boundary had
// already moved while discussion_messages / contract_change_records stayed
// empty — "讨论不改变合同而无记录" (CTO-DECISIONS-2026-10-27 §4 W6 row).
//
// Invariants under test (CTO gate DONEGO-S2D-W6-REMEDIATION-GATE):
//  - FAILURE INJECTION: when any write AFTER the first fails — a thrown error
//    between the two store calls, or a REAL SQLite constraint abort on the
//    contract_change_records insert — all THREE row kinds stay at zero for the
//    turn (previews / discussion_messages / contract_change_records; the
//    implicitly created thread rolls back with them).
//  - SUCCESS: one turn = exactly ONE new preview version + ONE message + ONE
//    change record.
//  - RECOVERY: after a failed turn, retrying the SAME turn on clean stores
//    succeeds and replays idempotently afterwards.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openMigratedDb, makeClock, makePreview } from './_helpers.mjs';

async function loadStores() {
  const [apply, previewStoreMod, discussionStoreMod] = await Promise.all([
    import('../../../../scripts/agentic/discussion/apply.mjs'),
    import('../../../../scripts/agentic/preview/store.mjs'),
    import('../../../../scripts/agentic/discussion/store.mjs'),
  ]);
  return { apply, previewStoreMod, discussionStoreMod };
}

async function freshWorld() {
  const { apply, previewStoreMod, discussionStoreMod } = await loadStores();
  const db = openMigratedDb();
  const now = makeClock();
  const previewStore = previewStoreMod.createPreviewStore(db, { now });
  const discussionStore = discussionStoreMod.createDiscussionStore(db, { now });
  await previewStore.put({ ownerId: 'owner-a', missionId: 'm1', preview: makePreview({ missionId: 'm1' }) });
  return { db, applyPatch: apply.applyPatch, previewStore, discussionStore };
}

const BOUNDARY_PATCH = { boundary: { wont: { add: ['夜间勿扰'] } } };

function turnParams(world, discussionStore, parsePatch) {
  return {
    ownerId: 'owner-a',
    missionId: 'm1',
    actor: 'user',
    utterance: '夜里别打扰我',
    baseVersion: 1,
    previewStore: world.previewStore,
    discussionStore,
    parsePatch: async () => ({ patch: parsePatch, origin: 'rules' }),
  };
}

/**
 * Wrap a real discussion store so the message write (the SECOND write of the
 * turn) is sabotaged: `transform` either throws (simulated crash between the
 * version commit and the message commit) or mutates params before delegating
 * to the REAL store (real SQL, real constraint failures). Both call surfaces
 * are intercepted — the public appendMessage and, when present, the
 * transactional txn.appendMessage seam — so the test exercises whichever path
 * applyPatch currently uses.
 */
function sabotagingMessageWrite(store, transform) {
  const intercept = params => {
    const mutated = transform(params);
    if (store.txn && typeof store.txn.appendMessage === 'function') {
      return store.txn.appendMessage(mutated);
    }
    return store.appendMessage(mutated);
  };
  const wrapped = { ...store, appendMessage: intercept };
  if (store.txn) wrapped.txn = { ...store.txn, appendMessage: intercept };
  return wrapped;
}

async function countRows(db, table, owner = 'owner-a') {
  return db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE owner_id = ?`).get(owner).n;
}

/** All three turn row kinds (plus the implicit thread) must be untouched. */
async function assertZeroTurnWrites(db, world) {
  assert.equal(await countRows(db, 'previews'), 1, 'preview version must roll back (seed v1 only)');
  assert.equal(await countRows(db, 'discussion_messages'), 0, 'no message may survive');
  assert.equal(await countRows(db, 'contract_change_records'), 0, 'no change record may survive');
  assert.equal(await countRows(db, 'discussion_threads'), 0, 'implicit thread must roll back too');
  const latest = await world.previewStore.latest({ ownerId: 'owner-a', missionId: 'm1' });
  assert.equal(latest.version, 1);
  assert.equal(latest.preview.diff, undefined, 'the live preview boundary must NOT have moved');
  assert.equal(latest.preview.boundary.wont.includes('夜间勿扰'), false);
}

test('turn is atomic: a failure BETWEEN the version write and the message write leaves all three row kinds at zero', async () => {
  const world = await freshWorld();
  try {
    const crashBetweenWrites = sabotagingMessageWrite(world.discussionStore, () => {
      throw new Error('simulated crash between the version write and the message write');
    });
    await assert.rejects(
      () => world.applyPatch(turnParams(world, crashBetweenWrites, BOUNDARY_PATCH)),
      error => /simulated crash/.test(error.message),
    );
    await assertZeroTurnWrites(world.db, world);
  } finally {
    world.db.close();
  }
});

test('turn is atomic: a REAL SQLite NOT NULL abort on the contract_change_records insert rolls the version back too', async () => {
  const world = await freshWorld();
  try {
    // Real failure injection at the third write of the turn: the change-record
    // insert runs against the real database and really violates its NOT NULL
    // patch column (contractChange.patch = null). Whatever commit semantics
    // surround it, nothing of the turn may survive.
    const nullPatchRecord = sabotagingMessageWrite(world.discussionStore, params => ({
      ...params,
      contractChange: { patch: null, changedFields: ['boundary.wont'] },
    }));
    await assert.rejects(
      () => world.applyPatch(turnParams(world, nullPatchRecord, BOUNDARY_PATCH)),
      error => /NOT NULL/i.test(error.message),
    );
    await assertZeroTurnWrites(world.db, world);
  } finally {
    world.db.close();
  }
});

test('successful contract turn commits exactly ONE version + ONE message + ONE change record; retry after failure recovers and replays', async () => {
  const world = await freshWorld();
  try {
    // A failed turn first (crash between writes), then the SAME turn retried
    // on the clean stores: recovery must produce the single-version outcome.
    const crashBetweenWrites = sabotagingMessageWrite(world.discussionStore, () => {
      throw new Error('simulated crash between the version write and the message write');
    });
    await assert.rejects(() => world.applyPatch(turnParams(world, crashBetweenWrites, BOUNDARY_PATCH)));

    const result = await world.applyPatch(turnParams(world, world.discussionStore, BOUNDARY_PATCH));
    assert.equal(result.replayed, false);
    assert.equal(result.preview.version, 2);
    assert.equal(await countRows(world.db, 'previews'), 2, 'exactly one new version (seed + v2)');
    assert.equal(await countRows(world.db, 'discussion_messages'), 1, 'exactly one message');
    assert.equal(await countRows(world.db, 'contract_change_records'), 1, 'exactly one change record');
    assert.equal(await countRows(world.db, 'discussion_threads'), 1, 'exactly one thread');
    assert.equal(result.changeRecord.messageId, result.message.id);
    assert.equal(result.changeRecord.beforeVersion, 1);
    assert.equal(result.changeRecord.afterVersion, 2);

    // Replay of the same turn stays idempotent after recovery.
    const replay = await world.applyPatch(turnParams(world, world.discussionStore, BOUNDARY_PATCH));
    assert.equal(replay.replayed, true);
    assert.equal(replay.message.id, result.message.id);
    assert.equal(await countRows(world.db, 'previews'), 2);
    assert.equal(await countRows(world.db, 'discussion_messages'), 1);
    assert.equal(await countRows(world.db, 'contract_change_records'), 1);
  } finally {
    world.db.close();
  }
});
