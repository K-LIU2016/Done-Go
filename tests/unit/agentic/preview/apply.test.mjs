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

test('length patch keeps the unit: 课时 stays 课时 in a readable 预计篇幅 fact', async () => {
  const world = await freshWorld();
  try {
    const hours = await world.applyPatch({
      ...baseParams({ utterance: '改成 4 课时' }),
      previewStore: world.previewStore,
      discussionStore: world.discussionStore,
      parsePatch: parserReturning({ length: { unit: '课时', value: 4 } }),
    });
    const facts = hours.preview.preview.shape.blocks.find(block => block.type === 'facts');
    assert.equal(facts.items.find(item => item.k === '预计篇幅').v, '4 课时');
    assert.equal(facts.items.some(item => item.k === '课时'), false, 'no bare 课时 fact');
    assert.deepEqual(hours.preview.preview.diff.changed, ['shape.facts[预计篇幅]']);

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

// Remediation blocker C: patch.length.unit must survive into the facts the
// owner reads —「3000 字」renders as「预计篇幅：约 3000 字」,「4 课时」keeps
// 课时 — for EVERY unit the parser can produce (课时/小时/分钟/字/页).
test('every supported length unit renders a readable, unit-keeping 预计篇幅 fact', async () => {
  const cases = [
    { unit: '课时', value: 4, expected: '4 课时' },
    { unit: '小时', value: 1.5, expected: '1.5 小时' },
    { unit: '分钟', value: 90, expected: '90 分钟' },
    { unit: '字', value: 3000, expected: '约 3000 字' },
    { unit: '页', value: 12, expected: '约 12 页' },
  ];
  for (const { unit, value, expected } of cases) {
    const world = await freshWorld();
    try {
      const result = await world.applyPatch({
        ...baseParams({ utterance: `篇幅改成 ${value} ${unit}` }),
        previewStore: world.previewStore,
        discussionStore: world.discussionStore,
        parsePatch: parserReturning({ length: { unit, value } }),
      });
      assert.equal(result.preview.version, 2, `${unit}: one new version`);
      const facts = result.preview.preview.shape.blocks.find(block => block.type === 'facts');
      const fact = facts.items.find(item => item.k === '预计篇幅');
      assert.equal(fact.v, expected, `${unit} must render as「${expected}」`);
      assert.equal(facts.items.some(item => item.k === '课时'), false, `${unit}: no bare 课时 fact`);
      assert.deepEqual(result.preview.preview.diff.changed, ['shape.facts[预计篇幅]'], `${unit}: diff path names 预计篇幅`);
    } finally {
      world.db.close();
    }
  }
});

test('unsupported length units fail closed CONTRACT_INVALID with zero writes', async () => {
  const world = await freshWorld();
  try {
    for (const unit of ['光年', 'miles', '字数']) {
      await assert.rejects(
        () => world.applyPatch({
          ...baseParams({ utterance: `篇幅改成 3 ${unit}` }),
          previewStore: world.previewStore,
          discussionStore: world.discussionStore,
          parsePatch: parserReturning({ length: { unit, value: 3 } }),
        }),
        error => error.code === 'CONTRACT_INVALID' && /unit/.test(error.message),
      );
    }
    assert.equal(await countRows(world.db, 'previews'), 1);
    assert.equal(await countRows(world.db, 'discussion_messages'), 0);
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
    // A different utterance chains as a new turn onto the fresh base (v2).
    // (Spec repair: the original baseVersion: 1 was state-isomorphic to the
    // stale-base CONFLICT case in the "stale baseVersion" test above and to
    // routes.test.mjs's stale-base 409 — no deterministic apply could satisfy
    // both; the fresh base preserves this test's chaining intent.)
    const next = await world.applyPatch({
      ...baseParams({ utterance: '范围再收紧到政策文件', baseVersion: 2 }),
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

test('combined sources+length+boundary patch lands ONE version with a multi-path diff and both contract fields', async () => {
  const world = await freshWorld();
  try {
    const result = await world.applyPatch({
      ...baseParams({ utterance: '只看国内 K12，4 课时，另外别读邮箱' }),
      previewStore: world.previewStore,
      discussionStore: world.discussionStore,
      parsePatch: parserReturning({
        sources: { include: ['国内 K12'] },
        length: { unit: '课时', value: 4 },
        boundary: { will: { add: ['检索论文'] }, wont: { add: ['读取邮箱'] } },
      }),
    });
    assert.equal(result.preview.version, 2);
    assert.equal(await countRows(world.db, 'previews'), 2, 'one new version, not one per field');
    assert.deepEqual(result.preview.preview.diff.changed, [
      'shape.facts[来源范围]', 'shape.facts[预计篇幅]', 'boundary.will', 'boundary.wont',
    ]);
    assert.ok(result.preview.preview.boundary.will.includes('检索论文'));
    assert.deepEqual(result.changeRecord.changedFields, ['boundary.will', 'boundary.wont']);
    assert.equal(await countRows(world.db, 'contract_change_records'), 1);
  } finally {
    world.db.close();
  }
});

test('FORBIDDEN: willing an item the owner explicitly forbade is rejected with zero writes', async () => {
  const world = await freshWorld();
  try {
    await assert.rejects(
      () => world.applyPatch({
        ...baseParams({ utterance: '允许你读邮箱' }),
        previewStore: world.previewStore,
        discussionStore: world.discussionStore,
        parsePatch: parserReturning({ boundary: { will: { add: ['读邮箱'] } } }), // present in base wont
      }),
      error => error.code === 'FORBIDDEN',
    );
    assert.equal(await countRows(world.db, 'previews'), 1);
    assert.equal(await countRows(world.db, 'discussion_messages'), 0);
  } finally {
    world.db.close();
  }
});

test('malformed patch shapes fail closed CONTRACT_INVALID with zero writes', async () => {
  const world = await freshWorld();
  try {
    const malformed = [
      'not-an-object',
      { sources: { include: [] } },
      { sources: { exclude: ['x'] } },
      { length: { unit: '课时' } },
      { length: { unit: '课时', value: 0 } },
      { boundary: { needs: [] } },
      { boundary: { wont: { toggle: ['x'] } } },
    ];
    for (const patch of malformed) {
      await assert.rejects(
        () => world.applyPatch({
          ...baseParams({ utterance: `补丁 ${JSON.stringify(patch)}` }),
          previewStore: world.previewStore,
          discussionStore: world.discussionStore,
          parsePatch: parserReturning(patch),
        }),
        error => error.code === 'CONTRACT_INVALID',
      );
    }
    assert.equal(await countRows(world.db, 'previews'), 1);
    assert.equal(await countRows(world.db, 'discussion_messages'), 0);
  } finally {
    world.db.close();
  }
});

test('sources patch against a preview without a facts block fails closed, zero writes', async () => {
  const world = await freshWorld();
  try {
    await world.previewStore.put({
      ownerId: 'owner-a',
      missionId: 'm_nofacts',
      preview: makePreview({
        missionId: 'm_nofacts',
        shape: { kind: 'report', title: '无事实块', blocks: [{ type: 'caveat', text: '只有注意事项' }] },
      }),
    });
    await assert.rejects(
      () => world.applyPatch({
        ...baseParams({ missionId: 'm_nofacts' }),
        previewStore: world.previewStore,
        discussionStore: world.discussionStore,
        parsePatch: parserReturning({ sources: { include: ['国内 K12'] } }),
      }),
      error => error.code === 'CONTRACT_INVALID' && /facts/.test(error.message),
    );
    assert.equal(await countRows(world.db, 'previews', 'owner-a'), 2, 'v1 of m1 + v1 of m_nofacts only');
    assert.equal(await countRows(world.db, 'discussion_messages'), 0);
  } finally {
    world.db.close();
  }
});
