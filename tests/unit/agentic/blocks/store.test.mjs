// W1 blocks-db 单测（TDD 先行：本文件即 scripts/agentic/block-store/store.mjs 与
// scripts/agentic/db/migrations/blocks-001-blocks.sql 的行为契约，实现须让本文件全绿）。
// 依据：PRD §11.1（blocks 表字段）、BUILD-PLAN §2.1 L48（W0 迁移器未交付前，测试内直接
// 执行本流迁移 SQL）、§3 W1-1、规划 DAG blocks-db 节（幂等重放 / 软删除 / 跨 owner 隔离 / seq 单调）。
//
// 契约：createBlocksStore({ db, now }) →
//   upsert(owner, { id, baseRevision, block })
//     新建要求 baseRevision 0；更新要求 baseRevision = 服务端当前 revision；
//     revision 由服务端递增（客户端自带 revision 不生效），updated_at 取 now()；
//     与已应用的同一 change 完全相同（baseRevision = revision-1 且规范内容一致）→ 重放：
//       applied true、revision 与游标 seq 不再前进；
//     baseRevision 不匹配且非重放 → { applied: false, block: <服务端当前块> }，不抛错
//       （逐条冲突判定放调用方，模式同 scripts/collaboration-store.mjs:69 但不整体 409）。
//   softDelete(owner, { id, baseRevision })
//     deleted_at 置位不物理删；重放/冲突语义同 upsert。
//   list(owner, from, to)
//     未删除块，date 区间 [from, to] 含两端；from/to 可省略（缺省不过滤该侧）。
//   changesSince(owner, cursor)
//     → { changes: [{ seq, at, block }], cursor }：每个块只出最新状态、按 seq 升序，
//     只含该 owner 的变更；cursor 为该 owner 可见的最大全局 seq（避免 updated_at 撞秒），
//     无新变更时原样返回传入 cursor（别 owner 的 seq 不推进本 owner 游标）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { createBlocksStore } from '../../../../scripts/agentic/block-store/store.mjs';

const MIGRATION_PATH = fileURLToPath(new URL('../../../../scripts/agentic/db/migrations/blocks-001-blocks.sql', import.meta.url));

function migrationSql() { return readFileSync(MIGRATION_PATH, 'utf8'); }

function makeStore() {
  const db = new DatabaseSync(':memory:');
  db.exec(migrationSql());
  let tick = 0;
  const now = () => { tick += 1; return '2026-10-26T0' + tick + ':00:00.000Z'; };
  return { store: createBlocksStore({ db, now }), now };
}

const blockOf = (over = {}) => ({ date: '2026-10-26', start: '09:00', end: '10:00', title: '写作', kind: 'create', prio: 3, note: '', done: false, source: 'web', ...over });

test('迁移建表：blocks 含 PRD §11.1 全部字段，block_changes 为游标日志表', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(migrationSql());
  const columns = db.prepare('PRAGMA table_info(blocks)').all().map(column => column.name);
  for (const name of ['id', 'owner_id', 'revision', 'date', 'start', 'end', 'title', 'kind', 'prio', 'note', 'done', 'source', 'deleted_at', 'updated_at'])
    assert.ok(columns.includes(name), 'blocks 缺少字段 ' + name);
  const logColumns = db.prepare('PRAGMA table_info(block_changes)').all().map(column => column.name);
  for (const name of ['seq', 'owner_id', 'block_id', 'at']) assert.ok(logColumns.includes(name), 'block_changes 缺少字段 ' + name);
});

test('upsert 新建：revision=1 由服务端分配（客户端自带 revision 不生效），updated_at 来自注入时钟', () => {
  const { store } = makeStore();
  const first = store.upsert('alice', { id: 'b1', baseRevision: 0, block: blockOf({ revision: 999 }) });
  assert.equal(first.applied, true);
  assert.equal(first.block.revision, 1);
  assert.ok(first.block.deleted_at == null);
  assert.ok(first.block.updated_at);
  const second = store.upsert('alice', { id: 'b2', baseRevision: 0, block: blockOf({ title: '第二块' }) });
  assert.notEqual(first.block.updated_at, second.block.updated_at); // 每次写入各取一次 now()
});

test('幂等重放：同一 change 重发 revision 与游标不前进，同块多次变更只出一条最新状态', () => {
  const { store } = makeStore();
  const created = store.upsert('alice', { id: 'b1', baseRevision: 0, block: blockOf() });
  const createReplay = store.upsert('alice', { id: 'b1', baseRevision: 0, block: blockOf() });
  assert.equal(created.applied, true);
  assert.equal(createReplay.applied, true);
  assert.equal(createReplay.block.revision, 1);
  const update = store.upsert('alice', { id: 'b1', baseRevision: 1, block: blockOf({ title: 'v2' }) });
  assert.equal(update.applied, true);
  assert.equal(update.block.revision, 2);
  const updateReplay = store.upsert('alice', { id: 'b1', baseRevision: 1, block: blockOf({ title: 'v2' }) });
  assert.equal(updateReplay.applied, true);
  assert.equal(updateReplay.block.revision, 2);
  assert.equal(updateReplay.block.title, 'v2');
  const since = store.changesSince('alice', 0);
  assert.equal(since.changes.length, 1);                    // b1 只出最新状态一条
  assert.equal(since.changes[0].block.revision, 2);
  assert.equal(since.cursor, since.changes[0].seq);
});

test('冲突：baseRevision 不匹配且内容不同 → 不应用，带回服务端当前块', () => {
  const { store } = makeStore();
  store.upsert('alice', { id: 'b1', baseRevision: 0, block: blockOf() });
  store.upsert('alice', { id: 'b1', baseRevision: 1, block: blockOf({ title: 'v2' }) }); // revision 2
  const stale = store.upsert('alice', { id: 'b1', baseRevision: 1, block: blockOf({ title: '别的改动' }) });
  assert.equal(stale.applied, false);
  assert.equal(stale.block.revision, 2);
  assert.equal(stale.block.title, 'v2');
  const wrongBase = store.upsert('alice', { id: 'b1', baseRevision: 7, block: blockOf({ title: '乱写的基准' }) });
  assert.equal(wrongBase.applied, false);
  assert.equal(wrongBase.block.revision, 2);
});

test('软删除：deleted_at 置位不物理删；list 不出、changes 可见；重放与冲突语义同 upsert', () => {
  const { store } = makeStore();
  store.upsert('alice', { id: 'b1', baseRevision: 0, block: blockOf() });
  store.upsert('alice', { id: 'b2', baseRevision: 0, block: blockOf({ title: '保留块' }) });
  const removed = store.softDelete('alice', { id: 'b1', baseRevision: 1 });
  assert.equal(removed.applied, true);
  assert.equal(removed.block.revision, 2);
  assert.ok(removed.block.deleted_at);
  const replay = store.softDelete('alice', { id: 'b1', baseRevision: 1 });
  assert.equal(replay.applied, true);
  assert.equal(replay.block.revision, 2);
  assert.deepEqual(store.list('alice', '2026-10-01', '2026-10-31').map(block => block.id), ['b2']); // list 不出
  const deletedEntry = store.changesSince('alice', 0).changes.find(change => change.block.id === 'b1');
  assert.ok(deletedEntry, '软删除应出现在 changes 里');
  assert.ok(deletedEntry.block.deleted_at);                                                          // 带 deleted_at 可见
  assert.equal(store.softDelete('alice', { id: 'b2', baseRevision: 9 }).applied, false);             // 基准不符
});

test('跨 owner 隔离与 owner 可见全局 seq：别 owner 的变更不可见、不推进本 owner 游标', () => {
  const { store } = makeStore();
  store.upsert('alice', { id: 'a1', baseRevision: 0, block: blockOf() });   // seq 1
  store.upsert('alice', { id: 'a2', baseRevision: 0, block: blockOf() });   // seq 2
  store.upsert('bob', { id: 'b1', baseRevision: 0, block: blockOf() });     // seq 3（bob）
  const aliceFirst = store.changesSince('alice', 0);
  assert.deepEqual(aliceFirst.changes.map(change => change.block.id), ['a1', 'a2']);
  assert.equal(aliceFirst.cursor, 2);
  const aliceSecond = store.changesSince('alice', aliceFirst.cursor);
  assert.equal(aliceSecond.changes.length, 0);      // bob 的 seq 3 对 alice 不可见
  assert.equal(aliceSecond.cursor, 2);              // 游标不因别人的 seq 跳跃
  store.upsert('alice', { id: 'a1', baseRevision: 1, block: blockOf({ title: 'v2' }) }); // seq 4
  const aliceThird = store.changesSince('alice', 2);
  assert.deepEqual(aliceThird.changes.map(change => change.block.id), ['a1']);
  assert.equal(aliceThird.cursor, 4);
  // 同一 block id 在不同 owner 下互不干扰（owner+id 才是键）
  store.upsert('bob', { id: 'a1', baseRevision: 0, block: blockOf({ title: 'bob 的同名块' }) });
  const aliceBlocks = store.list('alice');
  assert.deepEqual(aliceBlocks.map(block => block.id).sort(), ['a1', 'a2']);
  assert.equal(aliceBlocks.find(block => block.id === 'a1').title, 'v2');
  const bobBlocks = store.list('bob');
  assert.deepEqual(bobBlocks.map(block => block.id).sort(), ['a1', 'b1']);
  assert.equal(bobBlocks.find(block => block.id === 'a1').title, 'bob 的同名块');
});

test('seq 单调：changesSince 按 seq 升序且严格递增', () => {
  const { store } = makeStore();
  for (let i = 0; i < 3; i++) store.upsert('alice', { id: 'm' + i, baseRevision: 0, block: blockOf() });
  store.softDelete('alice', { id: 'm0', baseRevision: 1 });
  const { changes } = store.changesSince('alice', 0);
  assert.equal(changes.length, 3);                  // m1、m2、m0(已删) 各一条最新状态
  for (let i = 1; i < changes.length; i++) assert.ok(changes[i].seq > changes[i - 1].seq, 'seq 必须严格递增');
});
