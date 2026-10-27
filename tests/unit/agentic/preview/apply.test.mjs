// S2D-W6 module 7: patch-apply — the discussion→preview write path.
// Invariants under test (DAG §2 负面路径):
//  - every failure mode leaves ZERO writes (no half-applied patch);
//  - touching contract-relevant fields ALWAYS leaves a contract_change_records
//    row in the same transaction as the message;
//  - system wont items can never be relaxed (FORBIDDEN);
//  - replay of the same (mission, baseVersion, normalized utterance) is idempotent.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openMigratedDb, makeClock, makePreview } from './_helpers.mjs';

async function loadApply() {
  return import('../../../../scripts/agentic/discussion/apply.mjs');
}

async function loadStores() {
  const [apply, previewStoreMod, discussionStoreMod] = await Promise.all([
    loadApply(),
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

/** Stub parser: returns a fixed patch so apply tests stay decoupled from rule text. */
function parserReturning(patch) {
  return async utterance => ({ patch: typeof patch === 'function' ? patch(utterance) : patch, origin: 'rules' });
}

function baseParams(overrides = {}) {
  return {
    ownerId: 'owner-a',
    missionId: 'm1',
    actor: 'user',
    utterance: '研究只看国内 K12',
    baseVersion: 1,
    ...overrides,
  };
}

async function countRows(db, table, owner = 'owner-a') {
  return db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE owner_id = ?`).get(owner).n;
}

test('sources patch rewrites the 来源范围 fact, creates v2 with diff, and records the message', async () => {
  const world = await freshWorld();
  try {
    const result = await world.applyPatch({
      ...baseParams(),
      previewStore: world.previewStore,
      discussionStore: world.discussionStore,
      parsePatch: parserReturning({ sources: { include: ['国内 K12'] } }),
    });
    assert.equal(result.replayed, false);
    assert.equal(result.preview.version, 2);
    assert.equal(result.message.beforeVersion, 1);
    assert.equal(result.message.afterVersion, 2);
    const facts = result.preview.preview.shape.blocks.find(block => block.type === 'facts');
    const source = facts.items.find(item => item.k === '来源范围');
    assert.equal(source.v, '国内 K12');
    assert.deepEqual(result.preview.preview.diff.changed, ['shape.facts[来源范围]']);
    assert.equal(result.preview.preview.diff.reason, '研究只看国内 K12');
    // Untouched parts survive verbatim (增量更新, PRD §5.2 末).
    assert.deepEqual(result.preview.preview.storyboard, makePreview().storyboard);
    // Non-contract change → no change record.
    assert.equal(result.changeRecord, null);
    assert.equal(await countRows(world.db, 'contract_change_records'), 0);
  } finally {
    world.db.close();
  }
});

test('boundary wont.add produces a contract change record linked to the message', async () => {
  const world = await freshWorld();
  try {
    const result = await world.applyPatch({
      ...baseParams({ utterance: '别读我的邮箱' }),
      previewStore: world.previewStore,
      discussionStore: world.discussionStore,
      parsePatch: parserReturning({ boundary: { wont: { add: ['读取邮箱'] } } }),
    });
    assert.ok(result.preview.preview.boundary.wont.includes('读取邮箱'));
    assert.ok(result.changeRecord, 'contract-relevant patch must yield a change record');
    assert.deepEqual(result.changeRecord.changedFields, ['boundary.wont']);
    assert.equal(result.changeRecord.messageId, result.message.id);
    assert.equal(await countRows(world.db, 'contract_change_records'), 1);
  } finally {
    world.db.close();
  }
});

test('length patch writes the 课时 fact; wont.remove of a custom item is allowed but recorded', async () => {
  const world = await freshWorld();
  try {
    const hours = await world.applyPatch({
      ...baseParams({ utterance: '改成 4 课时' }),
      previewStore: world.previewStore,
      discussionStore: world.discussionStore,
      parsePatch: parserReturning({ length: { unit: '课时', value: 4 } }),
    });
    const facts = hours.preview.preview.shape.blocks.find(block => block.type === 'facts');
    assert.equal(facts.items.find(item => item.k === '课时').v, '4');

    const loosened = await world.applyPatch({
      ...baseParams({ utterance: '允许读邮箱', baseVersion: hours.preview.version }),
      previewStore: world.previewStore,
      discussionStore: world.discussionStore,
      parsePatch: parserReturning({ boundary: { wont: { remove: ['读邮箱'] } } }),
    });
    assert.equal(loosened.preview.preview.boundary.wont.includes('读邮箱'), false);
    assert.ok(loosened.changeRecord, 'boundary change must be recorded');
  } finally {
    world.db.close();
  }
});

test('FORBIDDEN: removing a system wont item or adding a paying/sending will is rejected with zero writes', async () => {
  const world = await freshWorld();
  try {
    const attempts = [
      { boundary: { wont: { remove: ['付款'] } } },
      { boundary: { will: { add: ['帮我付款下单'] } } },
      { boundary: { will: { add: ['替我发送邮件'] } } },
    ];
    for (const patch of attempts) {
      await assert.rejects(
        () => world.applyPatch({
          ...baseParams({ utterance: `尝试 ${JSON.stringify(patch)}` }),
          previewStore: world.previewStore,
          discussionStore: world.discussionStore,
          parsePatch: parserReturning(patch),
        }),
        error => error.code === 'FORBIDDEN',
      );
    }
    assert.equal(await countRows(world.db, 'previews'), 1, 'no new preview versions');
    assert.equal(await countRows(world.db, 'discussion_messages'), 0, 'no message rows');
    assert.equal(await countRows(world.db, 'contract_change_records'), 0, 'no change records');
  } finally {
    world.db.close();
  }
});

test('stale baseVersion is CONFLICT with zero writes; fresh baseVersion chains', async () => {
  const world = await freshWorld();
  try {
    const first = await world.applyPatch({
      ...baseParams(),
      previewStore: world.previewStore,
      discussionStore: world.discussionStore,
      parsePatch: parserReturning({ sources: { include: ['国内 K12'] } }),
    });
    assert.equal(first.preview.version, 2);
    await assert.rejects(
      () => world.applyPatch({
        ...baseParams({ utterance: '第二个补丁' }),
        previewStore: world.previewStore,
        discussionStore: world.discussionStore,
        parsePatch: parserReturning({ sources: { include: ['欧美'] } }),
      }),
      error => error.code === 'CONFLICT',
    );
    assert.equal(await countRows(world.db, 'previews'), 2);
    assert.equal(await countRows(world.db, 'discussion_messages'), 1);
  } finally {
    world.db.close();
  }
});

test('parser failure (UPSTREAM_UNAVAILABLE) leaves the preview at zero change', async () => {
  const world = await freshWorld();
  try {
    const failing = async () => { const error = new Error('upstream down'); error.code = 'UPSTREAM_UNAVAILABLE'; throw error; };
    await assert.rejects(
      () => world.applyPatch({
        ...baseParams(),
        previewStore: world.previewStore,
        discussionStore: world.discussionStore,
        parsePatch: failing,
      }),
      error => error.code === 'UPSTREAM_UNAVAILABLE',
    );
    const latest = await world.previewStore.latest({ ownerId: 'owner-a', missionId: 'm1' });
    assert.equal(latest.version, 1);
    assert.equal(latest.preview.diff, undefined, 'original v1 must be untouched');
    assert.equal(await countRows(world.db, 'discussion_messages'), 0);
  } finally {
    world.db.close();
  }
});

test('unrecognized patch fields fail closed CONTRACT_INVALID with zero writes', async () => {
  const world = await freshWorld();
  try {
    await assert.rejects(
      () => world.applyPatch({
        ...baseParams({ utterance: '加一条 DoD' }),
        previewStore: world.previewStore,
        discussionStore: world.discussionStore,
        parsePatch: parserReturning({ dod: { add: ['必须包含图表'] } }),
      }),
      error => error.code === 'CONTRACT_INVALID',
    );
    assert.equal(await countRows(world.db, 'previews'), 1);
    assert.equal(await countRows(world.db, 'discussion_messages'), 0);
  } finally {
    world.db.close();
  }
});

test('empty/oversized utterance and missing prior preview are rejected before any write', async () => {
  const world = await freshWorld();
  try {
    await assert.rejects(
      () => world.applyPatch({
        ...baseParams({ utterance: '   ' }),
        previewStore: world.previewStore, discussionStore: world.discussionStore,
        parsePatch: parserReturning(null),
      }),
      error => error.code === 'CONTRACT_INVALID',
    );
    await assert.rejects(
      () => world.applyPatch({
        ...baseParams({ utterance: '长'.repeat(2001) }),
        previewStore: world.previewStore, discussionStore: world.discussionStore,
        parsePatch: parserReturning(null),
      }),
      error => error.code === 'CONTRACT_INVALID',
    );
    await assert.rejects(
      () => world.applyPatch({
        ...baseParams({ missionId: 'm_missing' }),
        previewStore: world.previewStore, discussionStore: world.discussionStore,
        parsePatch: parserReturning(null),
      }),
      error => error.code === 'NOT_FOUND',
    );
    assert.equal(await countRows(world.db, 'previews'), 1);
    assert.equal(await countRows(world.db, 'discussion_messages'), 0);
  } finally {
    world.db.close();
  }
});

test('patch null (no rule matched): message recorded, preview unchanged', async () => {
  const world = await freshWorld();
  try {
    const result = await world.applyPatch({
      ...baseParams({ utterance: '就随便聊聊' }),
      previewStore: world.previewStore,
      discussionStore: world.discussionStore,
      parsePatch: parserReturning(null),
    });
    assert.equal(result.message.afterVersion, result.message.beforeVersion);
    assert.equal(result.preview.version, 1);
    assert.equal(result.changeRecord, null);
    assert.equal(await countRows(world.db, 'previews'), 1);
  } finally {
    world.db.close();
  }
});

test('no-op patch (adding an existing wont item) records the talk but no new version', async () => {
  const world = await freshWorld();
  try {
    const result = await world.applyPatch({
      ...baseParams({ utterance: '不要读邮箱' }),
      previewStore: world.previewStore,
      discussionStore: world.discussionStore,
      parsePatch: parserReturning({ boundary: { wont: { add: ['读邮箱'] } } }), // already present
    });
    assert.equal(result.preview.version, 1, 'nothing changed → no new version');
    assert.equal(result.changeRecord, null);
    assert.equal(await countRows(world.db, 'previews'), 1);
  } finally {
    world.db.close();
  }
});

test('idempotent replay: same (mission, baseVersion, utterance) returns the same message, no new version', async () => {
  const world = await freshWorld();
  try {
    const call = () => world.applyPatch({
      ...baseParams({ utterance: '研究只看国内 K12', baseVersion: 1 }),
      previewStore: world.previewStore,
      discussionStore: world.discussionStore,
      parsePatch: parserReturning({ sources: { include: ['国内 K12'] } }),
    });
    const first = await call();
    const replay = await call();
    assert.equal(replay.replayed, true);
    assert.equal(replay.message.id, first.message.id);
    assert.equal(replay.preview.version, first.preview.version);
    assert.equal(await countRows(world.db, 'previews'), 2, 'still v1+v2 only');
    assert.equal(await countRows(world.db, 'discussion_messages'), 1);
    // Whitespace-only differences normalize to the same key (trim + collapse runs).
    const spaced = await world.applyPatch({
      ...baseParams({ utterance: '   研究只看国内   K12  ', baseVersion: 1 }),
      previewStore: world.previewStore,
      discussionStore: world.discussionStore,
      parsePatch: parserReturning({ sources: { include: ['国内 K12'] } }),
    });
    assert.equal(spaced.replayed, true);
    // A different utterance on the same base is a new turn (chained onto latest).
    const next = await world.applyPatch({
      ...baseParams({ utterance: '范围再收紧到政策文件', baseVersion: 1 }),
      previewStore: world.previewStore,
      discussionStore: world.discussionStore,
      parsePatch: parserReturning({ sources: { include: ['政策文件'] } }),
    });
    assert.equal(next.replayed, false);
    assert.equal(next.preview.version, 3);
  } finally {
    world.db.close();
  }
});
