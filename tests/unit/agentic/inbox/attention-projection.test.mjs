// W9 M3 inbox-domain · attention-projection 单测（TDD RED 先行）
//
// 本文件是 `scripts/agentic/inbox/attention-projection.mjs` 的接口规约：
//   toAttentionItem(record) → 行对象：{ needId, ownerId, kind, payload, state, unknownFlag }
//   - kind = record.type；payload 含 question（JSON 对象）；state = record.status（简单映射，W13 可再扩展）；
//     unknownFlag：defaultAction 为 null → 1（UNKNOWN/继续等待），否则 0。
//   syncAttentionItem(db, record) → upsert（need_id+owner_id 唯一），返回写入后的行。
//   needView(record) → 冻结 need.schema.json 对象：只保留 schema 字段。
//     defaultAction 为 null 的记录不可物化 → 抛 CONTRACT_INVALID（plan 契约张力③：
//     无默认的 need 走 AttentionItem 投影，不落冻结 Need 对象）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openAgenticDb, migrate } from '../../../../scripts/agentic/db/index.mjs';
import { loadSchema, validate } from '../../../../scripts/agentic/contracts.mjs';
import { toAttentionItem, syncAttentionItem, needView } from '../../../../scripts/agentic/inbox/attention-projection.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../../..');
const contractDir = join(root, 'contracts/agentic');
const needSchema = loadSchema('need.schema.json', contractDir);

function makeDb() {
  const db = openAgenticDb(':memory:');
  migrate(db, join(root, 'scripts/agentic/db/migrations'));
  return db;
}

const RECORD = {
  id: 'need-1', ownerId: 'owner-a', missionId: 'm1', type: 'decision',
  question: '大纲方向 A 还是 B？', dueAt: '2026-10-27T12:00:00Z',
  defaultAction: 'continue', status: 'open', answer: null, answeredAt: null, revision: 1,
};

test('toAttentionItem maps a need record to an attention row', () => {
  const item = toAttentionItem(RECORD);
  assert.equal(item.needId, 'need-1');
  assert.equal(item.ownerId, 'owner-a');
  assert.equal(item.kind, 'decision');
  assert.equal(item.state, 'open');
  assert.equal(item.unknownFlag, 0);
  assert.ok(item.payload && typeof item.payload === 'object');
  assert.equal(item.payload.question, '大纲方向 A 还是 B？');
});

test('a need without a default action projects unknownFlag=1', () => {
  const item = toAttentionItem({ ...RECORD, defaultAction: null });
  assert.equal(item.unknownFlag, 1);
});

test('syncAttentionItem upserts one row per need and updates it in place', () => {
  const db = makeDb();
  syncAttentionItem(db, RECORD);
  syncAttentionItem(db, { ...RECORD, status: 'answered', answer: '选 A' });
  const rows = db.prepare('SELECT * FROM w9_attention_items WHERE need_id = ?').all('need-1');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].state, 'answered');
  assert.equal(rows[0].owner_id, 'owner-a');
  assert.equal(rows[0].kind, 'decision');
});

test('needView materializes a schema-valid frozen Need for needs with a default', () => {
  const view = needView(RECORD);
  assert.equal(view.id, 'need-1');
  assert.equal(view.defaultAction, 'continue');
  assert.equal(view.status, 'open');
  assert.equal('ownerId' in view, false, 'internal fields must not leak into the frozen object');
  assert.equal('revision' in view, false);
  const result = validate(view, needSchema, { schemaDir: contractDir });
  assert.equal(result.valid, true, JSON.stringify(result.errors));

  const answeredView = needView({ ...RECORD, status: 'answered', answer: '选 A', answeredAt: '2026-10-27T11:00:00Z' });
  assert.equal(validate(answeredView, needSchema, { schemaDir: contractDir }).valid, true);
  assert.equal(answeredView.answer, '选 A');
});

test('needView refuses to materialize a need without a default action', () => {
  assert.throws(() => needView({ ...RECORD, defaultAction: null }), (e) => e.code === 'CONTRACT_INVALID');
});

test('attention rows are owner-scoped: same needId under another owner is a separate row', () => {
  const db = makeDb();
  syncAttentionItem(db, RECORD);
  syncAttentionItem(db, { ...RECORD, ownerId: 'owner-b' });
  const count = db.prepare('SELECT COUNT(*) AS n FROM w9_attention_items WHERE need_id = ?').get('need-1');
  assert.equal(count.n, 2);
});
