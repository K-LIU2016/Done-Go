// W9 M3 inbox-domain · expiry 单测（TDD RED 先行）
//
// 本文件是 `scripts/agentic/inbox/expiry.mjs` 的接口规约：
//   createExpiry({ db, events? }) → { sweep(now) }
//   - sweep(now)：now 为注入的 ISO 时刻（确定性时钟；实现与测试都不得依赖真实 wall clock）。
//     只处理 owner 名下 due_at <= now 且 status='open' 的 need：
//       default_action 显式存在 → status 'defaulted'，answered_at = now；
//       default_action 为 NULL   → status 保持 'open'，attention 行 unknown_flag=1（继续等待，绝不 defaulted/expired）。
//   - 返回 { defaulted: <本次迁移数>, waiting: <逾期但无默认仍等待数> }，只此两个键；
//     不发邮件、不推送、不改日历（brief 红线3；本模块无任何外部副作用）。
//   - 幂等：重复 sweep 不产生新迁移、不追加事件。
import test from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openAgenticDb, migrate } from '../../../../scripts/agentic/db/index.mjs';
import { createNeedStore } from '../../../../scripts/agentic/inbox/need-store.mjs';
import { createExpiry } from '../../../../scripts/agentic/inbox/expiry.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../../..');

const T0 = Date.parse('2026-10-27T10:00:00Z');
const clockAt = (iso) => ({ now: () => iso });

function makeSetup() {
  const db = openAgenticDb(':memory:');
  migrate(db, join(root, 'scripts/agentic/db/migrations'));
  const clock = clockAt(new Date(T0).toISOString());
  const store = createNeedStore({ db, clock, idGen: (() => { let n = 0; return () => `need-${++n}`; })() });
  const expiry = createExpiry({ db });
  return { db, store, expiry };
}

const INPUT = {
  missionId: 'm1',
  type: 'decision',
  question: '大纲方向 A 还是 B？',
  dueAt: '2026-10-27T11:00:00Z',
};

test('an overdue need with an explicit default action becomes defaulted at sweep time', async () => {
  const { db, store, expiry } = makeSetup();
  const need = await store.createNeed('owner-a', { ...INPUT, defaultAction: 'continue' });

  const result = await expiry.sweep('2026-10-27T12:00:00Z');
  assert.deepEqual(Object.keys(result).sort(), ['defaulted', 'waiting']);
  assert.equal(result.defaulted, 1);
  assert.equal(result.waiting, 0);

  const row = db.prepare('SELECT status, answered_at FROM w9_needs WHERE id = ?').get(need.id);
  assert.equal(row.status, 'defaulted');
  assert.equal(row.answered_at, '2026-10-27T12:00:00Z');
});

test('an overdue need without a default action stays open and flags attention UNKNOWN', async () => {
  const { db, store, expiry } = makeSetup();
  const need = await store.createNeed('owner-a', INPUT);

  const result = await expiry.sweep('2026-10-27T12:00:00Z');
  assert.equal(result.defaulted, 0);
  assert.equal(result.waiting, 1);

  const row = db.prepare('SELECT status FROM w9_needs WHERE id = ?').get(need.id);
  assert.equal(row.status, 'open', 'no default → keep waiting, never defaulted nor expired');

  const attention = db.prepare('SELECT unknown_flag FROM w9_attention_items WHERE need_id = ?').get(need.id);
  assert.ok(attention, 'sweep must maintain an attention row for the waiting need');
  assert.equal(attention.unknown_flag, 1);
});

test('a need not yet due is untouched', async () => {
  const { db, store, expiry } = makeSetup();
  const need = await store.createNeed('owner-a', { ...INPUT, defaultAction: 'continue' });
  const result = await expiry.sweep('2026-10-27T10:30:00Z');
  assert.equal(result.defaulted, 0);
  assert.equal(result.waiting, 0);
  assert.equal(db.prepare('SELECT status FROM w9_needs WHERE id = ?').get(need.id).status, 'open');
});

test('due exactly at sweep time counts as overdue (inclusive boundary)', async () => {
  const { db, store, expiry } = makeSetup();
  const need = await store.createNeed('owner-a', { ...INPUT, defaultAction: 'pause' });
  await expiry.sweep(INPUT.dueAt);
  assert.equal(db.prepare('SELECT status FROM w9_needs WHERE id = ?').get(need.id).status, 'defaulted');
});

test('sweep is idempotent: a second sweep migrates nothing new', async () => {
  const { db, store, expiry } = makeSetup();
  const need = await store.createNeed('owner-a', { ...INPUT, defaultAction: 'continue' });
  await expiry.sweep('2026-10-27T12:00:00Z');
  const again = await expiry.sweep('2026-10-27T13:00:00Z');
  assert.equal(again.defaulted, 0);
  const row = db.prepare('SELECT status, answered_at FROM w9_needs WHERE id = ?').get(need.id);
  assert.equal(row.status, 'defaulted');
  assert.equal(row.answered_at, '2026-10-27T12:00:00Z', 'first sweep time wins');
});

test('answered and waived needs are never re-defaulted', async () => {
  const { db, store, expiry } = makeSetup();
  const answered = await store.createNeed('owner-a', { ...INPUT, defaultAction: 'continue' });
  await store.answer('owner-a', answered.id, { answer: '选 A', revision: 1 });
  const waived = await store.createNeed('owner-a', { ...INPUT, missionId: 'm2', defaultAction: 'skip' });
  await store.waive('owner-a', waived.id);

  const result = await expiry.sweep('2026-10-27T12:00:00Z');
  assert.equal(result.defaulted, 0);
  assert.equal(db.prepare('SELECT status FROM w9_needs WHERE id = ?').get(answered.id).status, 'answered');
  assert.equal(db.prepare('SELECT status FROM w9_needs WHERE id = ?').get(waived.id).status, 'waived');
});

test('a defaulted need rejects late answers (只能按 defaulted 语义走)', async () => {
  const { db, store, expiry } = makeSetup();
  const need = await store.createNeed('owner-a', { ...INPUT, defaultAction: 'continue' });
  await expiry.sweep('2026-10-27T12:00:00Z');
  const current = await store.get('owner-a', need.id);
  await assert.rejects(
    async () => store.answer('owner-a', need.id, { answer: '迟到的回答', revision: current.revision }),
    (e) => e.code === 'CONFLICT',
  );
});

test('sweep has no external side effects: returns counts only, no notification channels', async () => {
  const { store, expiry } = makeSetup();
  await store.createNeed('owner-a', { ...INPUT, defaultAction: 'continue' });
  const result = await expiry.sweep('2026-10-27T12:00:00Z');
  assert.deepEqual(result, { defaulted: 1, waiting: 0 });
  // 红线3：不发送邮件/推送/改日历——本模块没有也不允许引入任何通知通道；
  // 结构性断言：sweep 的返回不携带任何 message/channel/recipient 字段。
  for (const key of Object.keys(result)) {
    assert.ok(['defaulted', 'waiting'].includes(key), `unexpected channel-ish key: ${key}`);
  }
});
