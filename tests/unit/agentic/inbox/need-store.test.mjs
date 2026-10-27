// W9 M3 inbox-domain · need-store 单测（TDD RED 先行）
//
// 本文件是 `scripts/agentic/inbox/need-store.mjs` 的接口规约：
//   createNeedStore({ db, clock, idGen, events }) → { createNeed, get, list, answer, waive }
//   - createNeed(ownerId, { missionId, type, question, dueAt, defaultAction? })
//     → 内部记录 { id, ownerId, missionId, type, question, dueAt, defaultAction|null,
//       status: 'open', answer: null, answeredAt: null, revision: 1 }。
//     defaultAction 可空（brief 裁决⑤：无默认→UNKNOWN/继续等待；带默认的 need 才物化冻结 Need 对象）。
//   - answer(ownerId, needId, { answer, revision })：幂等键 (owner_id, need_id, revision)。
//     成功 → status 'answered'，revision+1；同 revision 重复 answer 幂等返回首答；
//     旧/错 revision → CONFLICT；跨 owner → NOT_FOUND；非 open → CONFLICT。
//   - waive(ownerId, needId) → status 'waived'，revision+1；终态不可再变。
//   - 生命周期事件 append-only 写 w9_need_events。
import test from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openAgenticDb, migrate } from '../../../../scripts/agentic/db/index.mjs';
import { createNeedStore } from '../../../../scripts/agentic/inbox/need-store.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../../..');

const T0 = Date.parse('2026-10-27T10:00:00Z');
const seqClock = (stepMs = 1000) => {
  let n = 0;
  return { now: () => new Date(T0 + n++ * stepMs).toISOString() };
};
const seqId = (prefix) => {
  let n = 0;
  return () => `${prefix}-${++n}`;
};

function makeStore(events) {
  const db = openAgenticDb(':memory:');
  migrate(db, join(root, 'scripts/agentic/db/migrations'));
  const clock = seqClock();
  return { db, clock, store: createNeedStore({ db, clock, idGen: seqId('need'), events }) };
}

const INPUT = {
  missionId: 'm1',
  type: 'decision',
  question: '大纲方向 A 还是 B？',
  dueAt: '2026-10-27T12:00:00Z',
};

test('createNeed with an explicit default action stores an open need at revision 1', async () => {
  const { db, clock, store } = makeStore();
  const need = await store.createNeed('owner-a', { ...INPUT, defaultAction: 'continue' });
  assert.equal(need.status, 'open');
  assert.equal(need.revision, 1);
  assert.equal(need.ownerId, 'owner-a');
  assert.equal(need.defaultAction, 'continue');
  assert.equal(need.answer, null);
  assert.ok(typeof need.id === 'string' && need.id.length > 0);

  const row = db.prepare('SELECT * FROM w9_needs WHERE id = ?').get(need.id);
  assert.equal(row.owner_id, 'owner-a');
  assert.equal(row.default_action, 'continue');
  assert.equal(row.status, 'open');
  const events = db.prepare('SELECT COUNT(*) AS n FROM w9_need_events WHERE need_id = ?').get(need.id);
  assert.equal(events.n, 1, 'creation appends a lifecycle event');
});

test('createNeed without a default action keeps defaultAction null and stays usable', async () => {
  const { db, store } = makeStore();
  const need = await store.createNeed('owner-a', INPUT);
  assert.equal(need.defaultAction, null);
  const row = db.prepare('SELECT default_action FROM w9_needs WHERE id = ?').get(need.id);
  assert.equal(row.default_action, null);
});

test('createNeed rejects invalid input and client-supplied server fields', async () => {
  const { store } = makeStore();
  await assert.rejects(async () => store.createNeed('owner-a', { ...INPUT, type: 'bogus' }), (e) => e.code === 'CONTRACT_INVALID');
  await assert.rejects(async () => store.createNeed('owner-a', { ...INPUT, defaultAction: 'explode' }), (e) => e.code === 'CONTRACT_INVALID');
  await assert.rejects(async () => store.createNeed('owner-a', { ...INPUT, dueAt: 'tomorrow' }), (e) => e.code === 'CONTRACT_INVALID');
  await assert.rejects(async () => store.createNeed('owner-a', { ...INPUT, question: '' }), (e) => e.code === 'CONTRACT_INVALID');
  await assert.rejects(async () => store.createNeed('owner-a', { ...INPUT, missionId: '' }), (e) => e.code === 'CONTRACT_INVALID');
  for (const field of ['id', 'status', 'revision', 'ownerId', 'answer', 'answeredAt']) {
    await assert.rejects(
      async () => store.createNeed('owner-a', { ...INPUT, [field]: 'forged' }),
      (e) => e.code === 'CONTRACT_INVALID',
      `client ${field} must be rejected`,
    );
  }
});

test('answer records the answer, bumps revision and appends an event', async () => {
  const { db, clock, store } = makeStore();
  const need = await store.createNeed('owner-a', { ...INPUT, defaultAction: 'continue' });
  const answered = await store.answer('owner-a', need.id, { answer: '选 A', revision: 1 });
  assert.equal(answered.status, 'answered');
  assert.equal(answered.answer, '选 A');
  assert.equal(answered.answeredAt, clock.now());
  assert.equal(answered.revision, 2);
  const events = db.prepare('SELECT COUNT(*) AS n FROM w9_need_events WHERE need_id = ?').get(need.id);
  assert.equal(events.n, 2);
});

test('duplicate answer with the same revision is idempotent and returns the first answer', async () => {
  const { db, store } = makeStore();
  const need = await store.createNeed('owner-a', INPUT);
  const first = await store.answer('owner-a', need.id, { answer: '选 A', revision: 1 });
  const again = await store.answer('owner-a', need.id, { answer: '完全不同的答案', revision: 1 });
  assert.equal(again.status, 'answered');
  assert.equal(again.answer, '选 A', 'first answer wins');
  assert.equal(again.answeredAt, first.answeredAt);
  assert.equal(again.revision, 2);
  const rows = db.prepare('SELECT answer, answered_at FROM w9_needs WHERE id = ?').get(need.id);
  assert.equal(rows.answer, '选 A');
  const events = db.prepare('SELECT COUNT(*) AS n FROM w9_need_events WHERE need_id = ?').get(need.id);
  assert.equal(events.n, 2, 'idempotent answer must not append another event');
});

test('answering with a stale revision conflicts', async () => {
  const { store } = makeStore();
  const need = await store.createNeed('owner-a', INPUT);
  await store.answer('owner-a', need.id, { answer: '选 A', revision: 1 });
  await assert.rejects(
    async () => store.answer('owner-a', need.id, { answer: '再答一次', revision: 1 }),
    (e) => e.code === 'CONFLICT',
  );
});

test('answering with a wrong future revision conflicts', async () => {
  const { store } = makeStore();
  const need = await store.createNeed('owner-a', INPUT);
  await assert.rejects(
    async () => store.answer('owner-a', need.id, { answer: 'x', revision: 7 }),
    (e) => e.code === 'CONFLICT',
  );
});

test('cross-owner answer and reads are NOT_FOUND', async () => {
  const { store } = makeStore();
  const need = await store.createNeed('owner-a', INPUT);
  await assert.rejects(
    async () => store.answer('owner-b', need.id, { answer: 'hijack', revision: 1 }),
    (e) => e.code === 'NOT_FOUND',
  );
  await assert.rejects(async () => store.get('owner-b', need.id), (e) => e.code === 'NOT_FOUND');
  await assert.rejects(async () => store.waive('owner-b', need.id), (e) => e.code === 'NOT_FOUND');
  const still = await store.get('owner-a', need.id);
  assert.equal(still.status, 'open');
});

test('answer validation: empty or non-string answer / bad revision rejected', async () => {
  const { store } = makeStore();
  const need = await store.createNeed('owner-a', INPUT);
  await assert.rejects(async () => store.answer('owner-a', need.id, { answer: '', revision: 1 }), (e) => e.code === 'CONTRACT_INVALID');
  await assert.rejects(async () => store.answer('owner-a', need.id, { answer: 42, revision: 1 }), (e) => e.code === 'CONTRACT_INVALID');
  await assert.rejects(async () => store.answer('owner-a', need.id, { answer: 'ok', revision: 'one' }), (e) => e.code === 'CONTRACT_INVALID');
  await assert.rejects(async () => store.answer('owner-a', need.id, { answer: 'ok' }), (e) => e.code === 'CONTRACT_INVALID');
});

test('waive moves a need to a terminal waived state and bumps revision', async () => {
  const { store } = makeStore();
  const need = await store.createNeed('owner-a', INPUT);
  const waived = await store.waive('owner-a', need.id);
  assert.equal(waived.status, 'waived');
  assert.equal(waived.revision, 2);

  await assert.rejects(
    async () => store.answer('owner-a', need.id, { answer: '太晚了', revision: 2 }),
    (e) => e.code === 'CONFLICT',
  );
  await assert.rejects(async () => store.waive('owner-a', need.id), (e) => e.code === 'CONFLICT');
});

test('an answered need cannot be answered again with the new revision or waived', async () => {
  const { store } = makeStore();
  const need = await store.createNeed('owner-a', INPUT);
  await store.answer('owner-a', need.id, { answer: '选 A', revision: 1 });
  await assert.rejects(
    async () => store.answer('owner-a', need.id, { answer: '改主意', revision: 2 }),
    (e) => e.code === 'CONFLICT',
    'answered is terminal: only the idempotent same-revision replay is allowed',
  );
  await assert.rejects(async () => store.waive('owner-a', need.id), (e) => e.code === 'CONFLICT');
});

test('list is owner-scoped and exposes revision for optimistic answering', async () => {
  const { store } = makeStore();
  const n1 = await store.createNeed('owner-a', { ...INPUT, missionId: 'm1' });
  await store.createNeed('owner-b', { ...INPUT, missionId: 'm1' });
  const mine = await store.list('owner-a');
  assert.equal(mine.length, 1);
  assert.equal(mine[0].id, n1.id);
  assert.equal(mine[0].revision, 1);
  assert.equal(mine[0].status, 'open');
});

test('clock and idGen must be injected', () => {
  const db = openAgenticDb(':memory:');
  migrate(db, join(root, 'scripts/agentic/db/migrations'));
  assert.throws(() => createNeedStore({ db }), Error);
  assert.throws(() => createNeedStore({ db, clock: seqClock() }), Error);
});

test('lifecycle events reach the injected sink', async () => {
  const emitted = [];
  const { store } = makeStore({ emit: (evt) => emitted.push(evt) });
  const need = await store.createNeed('owner-a', INPUT);
  await store.answer('owner-a', need.id, { answer: '选 A', revision: 1 });
  const needEvents = emitted.filter((e) => e.objectType === 'need' && e.objectId === need.id);
  assert.equal(needEvents.length, 2);
  assert.equal(needEvents[0].ownerId, 'owner-a');
  assert.equal(typeof needEvents[0].type, 'string');
});

test('migration w9-3-inbox.sql creates the pinned tables and columns', () => {
  const db = openAgenticDb(':memory:');
  migrate(db, join(root, 'scripts/agentic/db/migrations'));
  const columnsOf = (table) => db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  for (const col of ['id', 'owner_id', 'mission_id', 'type', 'question', 'due_at', 'default_action', 'status', 'answer', 'answered_at', 'revision']) {
    assert.ok(columnsOf('w9_needs').includes(col), `w9_needs missing ${col}`);
  }
  assert.ok(columnsOf('w9_need_events').length > 0, 'w9_need_events must exist');
  for (const col of ['need_id', 'owner_id', 'kind', 'payload', 'state', 'unknown_flag', 'updated_at']) {
    assert.ok(columnsOf('w9_attention_items').includes(col), `w9_attention_items missing ${col}`);
  }
  const names = db.prepare("SELECT name FROM _migrations WHERE name LIKE 'w9-%' ORDER BY name").all().map((r) => r.name);
  assert.ok(names.includes('w9-3-inbox.sql'), `expected w9-3-inbox.sql applied, got ${JSON.stringify(names)}`);
});
