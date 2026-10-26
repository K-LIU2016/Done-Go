// W1 block-routes 单测（TDD 先行）：createBlockRoutes 的 HTTP 契约（实现须让本文件全绿）。
// 依据：BUILD-PLAN §2.1 L46（createXxxRoutes 不挂 serve-tango，测试自建 harness）、
// §3 W1-1（GET /api/blocks?from&to、POST /api/blocks/sync 返回 {applied,conflicts,serverChanges,cursor}、
// 全部按 owner 过滤、未登录 401）、规划 DAG block-routes 节（护栏：JSON content-type、body≤128KB、
// 单次 changes≤500、x-tango-client/origin 校验，同 collaboration-service.mjs:13,68-69）。
//
// 契约：createBlockRoutes({ store, authenticate, requestAllowed, now }) →
//   async (req, res, pathname) => handled:boolean   pathname 含查询串；非 /api/blocks* 返回 false。
//   GET  /api/blocks[?from&to]   → 200 { blocks, cursor }（只含该 owner 未删除块；from/to 合法
//     YYYY-MM-DD、可单边；非法 → 400）
//   POST /api/blocks/sync        body { baseRevision:<游标>, changes:[{id, baseRevision, block|deleted}] }
//     → 200 { applied:<本次新应用条数>, conflicts:[{id, block:<服务端当前块>}],
//             serverChanges:[<块最新快照，不含本次冲突块>], cursor }
//     冲突逐条进 conflicts，不整体 409；幂等重放 applied 计 0、revision 不前进；
//     changes>500 → 400；body>128KB → 413；非 JSON content-type → 415；坏 JSON → 400。
//   未登录 → 401 {error:'AUTH_REQUIRED'}；x-tango-client/origin 不符 → 403 {error:'ORIGIN_REJECTED'}。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startBlockServer } from './harness.mjs';
import { createBlockRoutes, createBlocksStore } from '../../../../scripts/agentic/block-store/index.mjs';

const blockOf = (over = {}) => ({ date: '2026-10-26', start: '09:00', end: '10:00', title: '写作', kind: 'create', prio: 3, note: '', done: false, source: 'web', ...over });

test('统一导出：block-store/index.mjs 同时提供 store 与 routes 工厂', () => {
  assert.equal(typeof createBlocksStore, 'function');
  assert.equal(typeof createBlockRoutes, 'function');
});

test('未登录：GET/POST 均 401 AUTH_REQUIRED', async t => {
  const f = await startBlockServer(t);
  const got = await f.request('/api/blocks');
  assert.equal(got.status, 401);
  assert.equal(got.body.error, 'AUTH_REQUIRED');
  const posted = await f.request('/api/blocks/sync', { body: { baseRevision: 0, changes: [] } });
  assert.equal(posted.status, 401);
  assert.equal(posted.body.error, 'AUTH_REQUIRED');
});

test('护栏：缺 x-tango-client 或跨 origin → 403 ORIGIN_REJECTED；未知路径不接管（挂载方 404 兜底）', async t => {
  const f = await startBlockServer(t);
  const alice = f.login('alice');
  const noClient = await f.request('/api/blocks', { cookie: alice, headers: { 'x-tango-client': '' } });
  assert.equal(noClient.status, 403);
  assert.equal(noClient.body.error, 'ORIGIN_REJECTED');
  const evil = await f.request('/api/blocks/sync', { cookie: alice, headers: { origin: 'http://evil.example' }, body: { baseRevision: 0, changes: [] } });
  assert.equal(evil.status, 403);
  assert.equal(evil.body.error, 'ORIGIN_REJECTED');
  const outside = await f.request('/api/other', { cookie: alice });
  assert.equal(outside.status, 404); // routes 返回 false，由 harness 兜底
});

test('GET /api/blocks：按 owner 返回未删除块，from/to 过滤（含两端、可单边），非法日期 400', async t => {
  const f = await startBlockServer(t);
  const alice = f.login('alice');
  f.store.upsert('alice', { id: 'a1', baseRevision: 0, block: blockOf({ date: '2026-10-25' }) });
  f.store.upsert('alice', { id: 'a2', baseRevision: 0, block: blockOf({ date: '2026-10-26' }) });
  f.store.upsert('bob', { id: 'b1', baseRevision: 0, block: blockOf({ date: '2026-10-26' }) });
  const all = await f.request('/api/blocks', { cookie: alice });
  assert.equal(all.status, 200);
  assert.deepEqual(all.body.blocks.map(block => block.id).sort(), ['a1', 'a2']); // bob 的块不可见
  assert.ok(Number.isFinite(all.body.cursor));                                   // 首次同步用的游标
  const ranged = await f.request('/api/blocks?from=2026-10-26&to=2026-10-26', { cookie: alice });
  assert.deepEqual(ranged.body.blocks.map(block => block.id), ['a2']);
  const fromOnly = await f.request('/api/blocks?from=2026-10-26', { cookie: alice });
  assert.deepEqual(fromOnly.body.blocks.map(block => block.id), ['a2']);
  assert.equal((await f.request('/api/blocks?from=2026-1-1&to=2026-10-26', { cookie: alice })).status, 400);
  assert.equal((await f.request('/api/blocks?from=abc', { cookie: alice })).status, 400);
});

test('POST /api/blocks/sync：逐条冲突不整体 409，返回 {applied,conflicts,serverChanges,cursor}，跨用户隔离', async t => {
  const f = await startBlockServer(t);
  const alice = f.login('alice');
  // 预置 old 到 revision 2（另一台设备先改过）
  f.store.upsert('alice', { id: 'old', baseRevision: 0, block: blockOf({ title: 'old' }) });
  f.store.upsert('alice', { id: 'old', baseRevision: 1, block: blockOf({ title: 'v2' }) });
  const response = await f.request('/api/blocks/sync', {
    cookie: alice,
    body: {
      baseRevision: 0,
      changes: [
        { id: 'new1', baseRevision: 0, block: blockOf({ title: '新块' }) },
        { id: 'old', baseRevision: 1, block: blockOf({ title: 'stale edit' }) }, // 过期基准
      ],
    },
  });
  assert.equal(response.status, 200);            // 不整体 409
  assert.equal(response.body.applied, 1);        // 好的那条照常应用
  assert.equal(response.body.conflicts.length, 1);
  assert.equal(response.body.conflicts[0].id, 'old');
  assert.equal(response.body.conflicts[0].block.revision, 2); // 带回服务端当前版本
  const changedIds = response.body.serverChanges.map(block => block.id);
  assert.ok(changedIds.includes('new1'));
  assert.ok(!changedIds.includes('old'));       // 冲突块不经 serverChanges 自动下发（防覆盖本地）
  assert.ok(Number.isFinite(response.body.cursor));
  // 跨用户隔离：bob 看不到 alice 的任何变更
  const bob = f.login('bob');
  const bobView = await f.request('/api/blocks/sync', { cookie: bob, body: { baseRevision: 0, changes: [] } });
  assert.equal(bobView.body.serverChanges.length, 0);
  assert.deepEqual((await f.request('/api/blocks', { cookie: bob })).body.blocks, []);
});

test('幂等重放：同一批 changes 重发 applied 不重复计数、revision 不前进', async t => {
  const f = await startBlockServer(t);
  const alice = f.login('alice');
  const changes = [{ id: 'r1', baseRevision: 0, block: blockOf({ title: '重放块' }) }];
  const first = await f.request('/api/blocks/sync', { cookie: alice, body: { baseRevision: 0, changes } });
  assert.equal(first.status, 200);
  assert.equal(first.body.applied, 1);
  const replay = await f.request('/api/blocks/sync', { cookie: alice, body: { baseRevision: first.body.cursor, changes } });
  assert.equal(replay.status, 200);
  assert.equal(replay.body.applied, 0);         // 重放不重复计数
  assert.equal(replay.body.conflicts.length, 0);
  const view = await f.request('/api/blocks', { cookie: alice });
  assert.equal(view.body.blocks.find(block => block.id === 'r1').revision, 1);
});

test('批量原子性（安全评审 HIGH）：批内含字段非法 change（prio 2.5）→ 整批 400，好块也不落库', async t => {
  const f = await startBlockServer(t);
  const alice = f.login('alice');
  const response = await f.request('/api/blocks/sync', {
    cookie: alice,
    body: {
      baseRevision: 0,
      changes: [
        { id: 'good1', baseRevision: 0, block: blockOf({ title: '好块' }) },
        { id: 'poison', baseRevision: 0, block: blockOf({ title: '毒丸', prio: 2.5 }) }, // 字段级：store 要求 Number.isInteger
      ],
    },
  });
  assert.equal(response.status, 400);           // 整批拒（prio 非 Integer → store normalizeContent）
  assert.equal(response.body.error, 'INVALID_INPUT');
  assert.deepEqual((await f.request('/api/blocks', { cookie: alice })).body.blocks, []); // good1 未落库（无半批 COMMIT）
  // 同批去掉毒丸重发 → 200 落库（客户端按 error 事件修数据后可恢复）
  const retry = await f.request('/api/blocks/sync', { cookie: alice, body: { baseRevision: 0, changes: [{ id: 'good1', baseRevision: 0, block: blockOf({ title: '好块' }) }] } });
  assert.equal(retry.status, 200);
  assert.equal(retry.body.applied, 1);
});

test('软删除经 sync 下发：list 不出、其他设备经 serverChanges 收到 deleted_at', async t => {
  const f = await startBlockServer(t);
  const alice = f.login('alice');
  const created = await f.request('/api/blocks/sync', { cookie: alice, body: { baseRevision: 0, changes: [{ id: 'd1', baseRevision: 0, block: blockOf({ title: '待删' }) }] } });
  assert.equal(created.body.applied, 1);
  const beforeDeleteCursor = created.body.cursor;
  const removed = await f.request('/api/blocks/sync', { cookie: alice, body: { baseRevision: beforeDeleteCursor, changes: [{ id: 'd1', baseRevision: 1, deleted: true }] } });
  assert.equal(removed.status, 200);
  assert.equal(removed.body.applied, 1);
  const list = await f.request('/api/blocks', { cookie: alice });
  assert.ok(!list.body.blocks.some(block => block.id === 'd1')); // list 不出
  // 第二台设备（同 owner、游标停在删除前）应经 serverChanges 看到软删除
  const secondDevice = await f.request('/api/blocks/sync', { cookie: alice, body: { baseRevision: beforeDeleteCursor, changes: [] } });
  const deletedBlock = secondDevice.body.serverChanges.find(block => block.id === 'd1');
  assert.ok(deletedBlock, 'serverChanges 应含被删块');
  assert.ok(deletedBlock.deleted_at);
});

test('护栏：非 JSON 415、超限 body 413、changes>500 → 400、坏 JSON 400、缺 id 400', async t => {
  const f = await startBlockServer(t);
  const alice = f.login('alice');
  assert.equal((await f.request('/api/blocks/sync', { cookie: alice, body: '{"a":1}', headers: { 'Content-Type': 'text/plain' } })).status, 415);
  assert.equal((await f.request('/api/blocks/sync', { cookie: alice, body: '{oops' })).status, 400);
  assert.equal((await f.request('/api/blocks/sync', { cookie: alice, body: 'x'.repeat(150 * 1024) })).status, 413);
  const many = Array.from({ length: 501 }, (_, i) => ({ id: 'c' + i, baseRevision: 0, block: blockOf() }));
  assert.equal((await f.request('/api/blocks/sync', { cookie: alice, body: { baseRevision: 0, changes: many } })).status, 400);
  assert.equal((await f.request('/api/blocks/sync', { cookie: alice, body: { baseRevision: 0, changes: [{ baseRevision: 0, block: blockOf() }] } })).status, 400);
});
