// perception-store 契约（TDD 先行，RED 基线）：
// node:sqlite DatabaseSync 内存库 + 自执行建表（BUILD-PLAN §2.1 L48：W0 交付前直接执行自己的 SQL）；
// captures / perception_cards / perception_events 三表；owner 强制过滤；参数化查询。
// 对应实现：scripts/agentic/perception/store.mjs + scripts/agentic/db/migrations/perception-0001-init.sql
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createPerceptionStore } from '../../../../scripts/agentic/perception/store.mjs';

function makeStore() {
  return createPerceptionStore({ db: new DatabaseSync(':memory:') });
}

const capture = (over = {}) => ({
  ownerId: 'alice',
  kind: 'image',
  capturedAt: '2026-10-26T15:04:05+08:00',
  uploadedAt: '2026-10-26T15:05:00+08:00',
  storedPath: '/data/alice/cap-1.jpg',
  keepOriginal: true,
  exifStripped: true,
  status: 'pending',
  ...over,
});

test('store initializes its own schema on a fresh in-memory db and round-trips a capture', () => {
  const store = makeStore();
  const row = store.insertCapture(capture({ id: undefined }));
  assert.ok(typeof row.id === 'string' && row.id.length >= 8, 'capture id 由 store 生成');
  const got = store.getCapture('alice', row.id);
  assert.equal(got.id, row.id);
  assert.equal(got.ownerId, 'alice');
  assert.equal(got.kind, 'image');
  assert.equal(got.capturedAt, '2026-10-26T15:04:05+08:00');
  assert.equal(got.uploadedAt, '2026-10-26T15:05:00+08:00');
  assert.equal(got.storedPath, '/data/alice/cap-1.jpg');
  assert.equal(got.keepOriginal, true);
  assert.equal(got.exifStripped, true);
  assert.equal(got.status, 'pending');
  assert.equal(got.blockId, null);
  assert.equal(got.confidence, null);
  assert.equal(got.candidates, null);
});

test('owner isolation: reads, updates and lists never cross owners', () => {
  const store = makeStore();
  const row = store.insertCapture(capture());
  assert.equal(store.getCapture('bob', row.id), undefined, '他人 id 读不到');
  assert.equal(store.listCaptures('bob').length, 0);
  assert.equal(store.updateAttribution('bob', row.id, { blockId: 'b9', confidence: 1 }), false, '他人更新不生效');
  assert.equal(store.getCapture('alice', row.id).blockId, null, '原归属未被污染');
  assert.equal(store.setStatus('bob', row.id, 'processing'), false);
  assert.equal(store.getCapture('alice', row.id).status, 'pending');
});

test('listCaptures returns only this owner, newest uploadedAt first', () => {
  const store = makeStore();
  const a = store.insertCapture(capture({ uploadedAt: '2026-10-26T10:00:00+08:00' }));
  const b = store.insertCapture(capture({ ownerId: 'bob', uploadedAt: '2026-10-26T12:00:00+08:00' }));
  const c = store.insertCapture(capture({ uploadedAt: '2026-10-26T11:00:00+08:00' }));
  const list = store.listCaptures('alice');
  assert.deepEqual(list.map(r => r.id), [c.id, a.id], '按 uploadedAt 倒序，bob 的不出现');
  assert.ok(!list.some(r => r.ownerId === 'bob'));
  void b;
});

test('updateAttribution persists blockId/confidence and candidates as structured JSON', () => {
  const store = makeStore();
  const row = store.insertCapture(capture());
  const candidates = [{ blockId: 'b1', confidence: 0.9 }, { blockId: 'b2', confidence: 0.5 }];
  assert.equal(store.updateAttribution('alice', row.id, { blockId: 'b1', confidence: 0.9, candidates }), true);
  const got = store.getCapture('alice', row.id);
  assert.equal(got.blockId, 'b1');
  assert.equal(got.confidence, 0.9);
  assert.ok(Array.isArray(got.candidates), 'candidates 读回为已解析数组');
  assert.deepEqual(got.candidates, candidates);
});

test('resolveCapture settles an ambiguous attribution by user choice', () => {
  const store = makeStore();
  const row = store.insertCapture(capture());
  const updated = store.resolveCapture('alice', row.id, 'b2');
  assert.equal(updated.blockId, 'b2');
  assert.equal(store.getCapture('alice', row.id).blockId, 'b2');
  assert.equal(store.resolveCapture('bob', row.id, 'b3'), undefined, '他人 resolve 无效');
});

test('perception_cards: fast card in, then upgraded in place (同一张卡，不新增行)', () => {
  const store = makeStore();
  const cap = store.insertCapture(capture());
  const card = store.insertCard({ captureId: cap.id, ownerId: 'alice', level: 'fast', model: 'qwen3.5-omni-flash', ms: 1500, seen: '正在组装书架', change: null, risk: null, suggestion: null, actions: [], state: 'created' });
  assert.ok(card.id);
  let got = store.getCard('alice', cap.id);
  assert.equal(got.level, 'fast');
  assert.equal(got.model, 'qwen3.5-omni-flash');
  assert.equal(got.ms, 1500);
  assert.equal(got.seen, '正在组装书架');
  assert.deepEqual(got.actions, []);
  store.upgradeCard('alice', cap.id, { level: 'deep', model: 'qwen3-vl-plus', ms: 6000, seen: '隔板已涂胶', change: '胶水溢出、未用夹具', risk: '可能不平', suggestion: '用湿布擦掉余胶并夹固 15 分钟', actions: ['⏱ 15 分钟后提醒我', '记下来'], state: 'upgraded' });
  got = store.getCard('alice', cap.id);
  assert.equal(got.level, 'deep', '原地升级为深卡');
  assert.equal(got.model, 'qwen3-vl-plus');
  assert.equal(got.change, '胶水溢出、未用夹具');
  assert.equal(got.risk, '可能不平');
  assert.deepEqual(got.actions, ['⏱ 15 分钟后提醒我', '记下来']);
  const cards = store.getCards('alice', cap.id);
  assert.equal(cards.length, 1, '同卡升级：始终只有一张卡');
  assert.equal(store.getCard('bob', cap.id), undefined, '卡片同样按 owner 隔离');
});

test('perception_events: append-only ledger, seq 递增，可按 owner+capture 重放（SSE）', () => {
  const store = makeStore();
  const cap = store.insertCapture(capture());
  const e1 = store.appendEvent({ captureId: cap.id, ownerId: 'alice', type: 'card.created', payload: { captureId: cap.id, level: 'fast', seen: '白板' } });
  const e2 = store.appendEvent({ captureId: cap.id, ownerId: 'alice', type: 'card.upgraded', payload: { captureId: cap.id, level: 'deep', suggestion: '生成纪要草稿' } });
  assert.ok(e1.seq < e2.seq, 'seq 单调递增');
  const events = store.listEvents('alice', cap.id);
  assert.deepEqual(events.map(e => e.type), ['card.created', 'card.upgraded'], '按写入顺序重放');
  assert.equal(events[0].payload.seen, '白板');
  assert.deepEqual(store.listEvents('bob', cap.id), [], '事件按 owner 隔离');
});

test('parameterized queries: hostile strings are data, never SQL', () => {
  const store = makeStore();
  const evil = "'; DROP TABLE captures; --";
  const row = store.insertCapture(capture({ storedPath: `/data/alice/${evil}` }));
  store.updateAttribution('alice', row.id, { blockId: `b1${evil}`, confidence: 0.5, candidates: [{ blockId: evil, confidence: 0.5 }] });
  const got = store.getCapture('alice', row.id);
  assert.equal(got.storedPath, `/data/alice/${evil}`);
  assert.equal(got.blockId, `b1${evil}`);
  assert.equal(got.candidates[0].blockId, evil);
  const next = store.insertCapture(capture()); // 表还在，可继续写
  assert.ok(next.id);
});

test('status transitions are persisted and owner-scoped', () => {
  const store = makeStore();
  const row = store.insertCapture(capture());
  assert.equal(store.setStatus('alice', row.id, 'processing'), true);
  assert.equal(store.getCapture('alice', row.id).status, 'processing');
  store.setStatus('alice', row.id, 'done');
  assert.equal(store.getCapture('alice', row.id).status, 'done');
});

test('getCapture of unknown id returns undefined instead of throwing', () => {
  const store = makeStore();
  assert.equal(store.getCapture('alice', 'no-such-id'), undefined);
  assert.deepEqual(store.listEvents('alice', 'no-such-id'), []);
  assert.equal(store.getCard('alice', 'no-such-id'), undefined);
});

test('migrations are idempotent: a second store on the same db applies cleanly', () => {
  const db = new DatabaseSync(':memory:');
  const s1 = createPerceptionStore({ db });
  const s2 = createPerceptionStore({ db });
  const row = s2.insertCapture(capture());
  assert.equal(s1.getCapture('alice', row.id).id, row.id, '两个 store 实例共享同一套表');
});

test('createPerceptionStore without db throws DB_REQUIRED', () => {
  assert.throws(() => createPerceptionStore({}), /DB_REQUIRED/);
});

test('cards and events refuse orphan rows: unknown captureId is rejected by foreign keys', () => {
  const store = makeStore();
  assert.throws(() => store.insertCard({ captureId: 'no-such-capture', ownerId: 'alice', level: 'fast', model: 'm', ms: 1, state: 'created' }), /FOREIGN KEY/);
  assert.throws(() => store.appendEvent({ captureId: 'no-such-capture', ownerId: 'alice', type: 'card.created', payload: {} }), /FOREIGN KEY/);
});

test('defaults: caller id kept, missing booleans coerce to false, status defaults, card fields default, cross-owner upgrade is a no-op', () => {
  const store = makeStore();
  const row = store.insertCapture(capture({ id: 'cap-explicit-001', keepOriginal: undefined, exifStripped: false, status: undefined }));
  assert.equal(row.id, 'cap-explicit-001');
  assert.equal(row.keepOriginal, false);
  assert.equal(row.exifStripped, false);
  assert.equal(row.status, 'pending');
  const card = store.insertCard({ captureId: row.id, ownerId: 'alice', level: 'fast', model: 'minicpm-v', ms: 8000, state: 'created' });
  assert.deepEqual(card.actions, []);
  assert.equal(card.seen, null);
  assert.equal(card.change, null);
  assert.equal(store.upgradeCard('bob', row.id, { level: 'deep', model: 'm2', ms: 5, state: 'upgraded' }), undefined, '他人升级无效');
  assert.equal(store.getCard('alice', row.id).level, 'fast', '快卡保留');
});
