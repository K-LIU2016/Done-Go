// S2D-W6 module 4: discussion-store — append-only discussion thread per
// (owner, mission): utterance + patch + before/after versions, idempotency-key
// dedup, and contract_change_records written in the SAME transaction as the
// message ("讨论不改变合同而无记录" — CTO-DECISIONS 2026-10-27 §4 W6 row).
import test from 'node:test';
import assert from 'node:assert/strict';
import { openMigratedDb, makeClock } from './_helpers.mjs';

async function loadDiscussionStore() {
  return import('../../../../scripts/agentic/discussion/store.mjs');
}

async function freshStore() {
  const { createDiscussionStore } = await loadDiscussionStore();
  const db = openMigratedDb();
  const store = createDiscussionStore(db, { now: makeClock() });
  return { db, store };
}

function messageParams(overrides = {}) {
  return {
    ownerId: 'owner-a',
    missionId: 'm1',
    actor: 'user',
    utterance: '研究只看国内 K12',
    baseVersion: 1,
    beforeVersion: 1,
    afterVersion: 2,
    idempotencyKey: 'key-1',
    patch: { sources: { include: ['国内 K12'] } },
    ...overrides,
  };
}

test('appendMessage creates the thread implicitly and returns the stored message', async () => {
  const { db, store } = await freshStore();
  try {
    const message = await store.appendMessage(messageParams());
    assert.ok(message.id);
    assert.equal(message.missionId, 'm1');
    assert.equal(message.beforeVersion, 1);
    assert.equal(message.afterVersion, 2);
    assert.deepEqual(message.patch, { sources: { include: ['国内 K12'] } });

    const thread = await store.getThread({ ownerId: 'owner-a', missionId: 'm1' });
    assert.ok(thread);
    assert.equal(thread.messages.length, 1);
    assert.equal(thread.messages[0].id, message.id);
    assert.deepEqual(thread.messages[0].patch, { sources: { include: ['国内 K12'] } });
  } finally {
    db.close();
  }
});

test('replaying the same idempotency key returns the existing message without appending', async () => {
  const { db, store } = await freshStore();
  try {
    const first = await store.appendMessage(messageParams());
    const replay = await store.appendMessage(messageParams({ idempotencyKey: 'key-1', afterVersion: 999 }));
    assert.equal(replay.id, first.id);
    assert.equal(replay.replayed, true);
    const thread = await store.getThread({ ownerId: 'owner-a', missionId: 'm1' });
    assert.equal(thread.messages.length, 1);
    // The replay did not overwrite the original afterVersion.
    assert.equal(thread.messages[0].afterVersion, 2);
  } finally {
    db.close();
  }
});

test('messages list in append order across multiple turns; patch may be null', async () => {
  const { db, store } = await freshStore();
  try {
    await store.appendMessage(messageParams({ idempotencyKey: 'k1' }));
    await store.appendMessage(messageParams({ idempotencyKey: 'k2', utterance: '随便聊聊', patch: null, afterVersion: null }));
    const thread = await store.getThread({ ownerId: 'owner-a', missionId: 'm1' });
    assert.equal(thread.messages.length, 2);
    assert.deepEqual(thread.messages.map(message => message.idempotencyKey), ['k1', 'k2']);
    assert.equal(thread.messages[1].patch, null);
    assert.equal(thread.messages[1].afterVersion, null);
  } finally {
    db.close();
  }
});

test('threads are owner-scoped: another owner sees no thread for the same mission', async () => {
  const { db, store } = await freshStore();
  try {
    await store.appendMessage(messageParams());
    assert.equal(await store.getThread({ ownerId: 'owner-b', missionId: 'm1' }), null);
    // owner-b appending for the same mission creates its own thread, not shared.
    await store.appendMessage(messageParams({ ownerId: 'owner-b', idempotencyKey: 'k-b' }));
    const threadA = await store.getThread({ ownerId: 'owner-a', missionId: 'm1' });
    const threadB = await store.getThread({ ownerId: 'owner-b', missionId: 'm1' });
    assert.equal(threadA.messages.length, 1);
    assert.equal(threadB.messages.length, 1);
    assert.notEqual(threadA.id ?? threadA.thread?.id, threadB.id ?? threadB.thread?.id);
  } finally {
    db.close();
  }
});

test('contractChange writes message + change record in one transaction and links them', async () => {
  const { db, store } = await freshStore();
  try {
    const message = await store.appendMessage(messageParams({
      idempotencyKey: 'k-wont',
      patch: { boundary: { wont: { add: ['读取邮箱'] } } },
      contractChange: {
        patch: { boundary: { wont: { add: ['读取邮箱'] } } },
        changedFields: ['boundary.wont'],
      },
    }));
    const records = await store.listChangeRecords({ ownerId: 'owner-a', missionId: 'm1' });
    assert.equal(records.length, 1);
    assert.equal(records[0].messageId, message.id);
    assert.equal(records[0].beforeVersion, 1);
    assert.equal(records[0].afterVersion, 2);
    assert.deepEqual(records[0].changedFields, ['boundary.wont']);
    assert.deepEqual(records[0].patch, { boundary: { wont: { add: ['读取邮箱'] } } });
  } finally {
    db.close();
  }
});

test('atomicity: if the change-record insert fails the whole message rolls back', async () => {
  const { db, store } = await freshStore();
  try {
    await assert.rejects(
      // patch column on contract_change_records is NOT NULL: null contract patch
      // must abort the transaction, leaving NO message and NO thread behind.
      () => store.appendMessage(messageParams({
        idempotencyKey: 'k-atomic',
        contractChange: { patch: null, changedFields: ['boundary.wont'] },
      })),
      () => true,
    );
    assert.equal(await store.getThread({ ownerId: 'owner-a', missionId: 'm1' }), null);
    assert.deepEqual(await store.listChangeRecords({ ownerId: 'owner-a', missionId: 'm1' }), []);
  } finally {
    db.close();
  }
});

test('listChangeRecords returns [] when nothing was recorded and is owner-scoped', async () => {
  const { db, store } = await freshStore();
  try {
    await store.appendMessage(messageParams({ idempotencyKey: 'k-plain' }));
    assert.deepEqual(await store.listChangeRecords({ ownerId: 'owner-a', missionId: 'm1' }), []);
    assert.deepEqual(await store.listChangeRecords({ ownerId: 'owner-b', missionId: 'm1' }), []);
  } finally {
    db.close();
  }
});
