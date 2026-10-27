// W9 M3 inbox-domain · 实现期补充防御测试（只加不删不放宽，参照 M2 defensive.test.mjs 先例）。
// 覆盖 RED 规约未触达的 fail-closed / 原子性 / 输入防御分支：
//   expiry 工厂守护、非法 now、attention 缺行补写、并发跳过不计数、sink 崩溃回滚原子性；
//   routes 非法 JSON / 超限 / 非对象 body、未分类异常 → INTERNAL_ERROR 信封、工厂守护；
//   attention-projection 坏 defaultAction、needView 坏 dueAt → CONTRACT_INVALID。
import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openAgenticDb, migrate } from '../../../../scripts/agentic/db/index.mjs';
import { loadSchema, validate } from '../../../../scripts/agentic/contracts.mjs';
import { createNeedStore } from '../../../../scripts/agentic/inbox/need-store.mjs';
import { createExpiry } from '../../../../scripts/agentic/inbox/expiry.mjs';
import { toAttentionItem, needView } from '../../../../scripts/agentic/inbox/attention-projection.mjs';
import { createInboxRoutes } from '../../../../scripts/agentic/inbox/routes.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../../..');
const contractDir = join(root, 'contracts/agentic');
const apiErrorSchema = loadSchema('api-error.schema.json', contractDir);

const T0 = Date.parse('2026-10-27T10:00:00Z');
const fixedClock = () => ({ now: () => new Date(T0).toISOString() });
const seqId = (prefix) => {
  let n = 0;
  return () => `${prefix}-${++n}`;
};

function makeDb() {
  const db = openAgenticDb(':memory:');
  migrate(db, join(root, 'scripts/agentic/db/migrations'));
  return db;
}

function makeReq(method, url, rawBody) {
  const req = rawBody === undefined ? Readable.from([]) : Readable.from([rawBody]);
  req.method = method;
  req.url = url;
  req.headers = {};
  return req;
}

function makeRes() {
  const chunks = [];
  const res = {
    statusCode: 0,
    headers: {},
    finished: false,
    setHeader(key, value) { this.headers[key.toLowerCase()] = value; return this; },
    writeHead(status, headers = {}) { this.statusCode = status; for (const [k, v] of Object.entries(headers)) this.setHeader(k, v); return this; },
    write(chunk) { chunks.push(Buffer.from(chunk)); return true; },
  };
  res.done = new Promise((resolve) => {
    res.end = (chunk) => {
      if (chunk !== undefined && chunk !== null) chunks.push(Buffer.from(chunk));
      res.finished = true;
      resolve();
    };
  });
  res.body = () => JSON.parse(Buffer.concat(chunks).toString('utf8'));
  return res;
}

// ---------- expiry 防御 ----------

test('expiry factory: db required, events.emit must be a function when provided', () => {
  assert.throws(() => createExpiry(), (e) => e.code === 'CONTRACT_INVALID');
  assert.throws(() => createExpiry({}), (e) => e.code === 'CONTRACT_INVALID');
  const db = makeDb();
  assert.throws(() => createExpiry({ db, events: {} }), (e) => e.code === 'CONTRACT_INVALID');
  assert.doesNotThrow(() => createExpiry({ db }));
});

test('sweep rejects a non-ISO now with CONTRACT_INVALID', async () => {
  const expiry = createExpiry({ db: makeDb() });
  await assert.rejects(async () => expiry.sweep('tomorrow'), (e) => e.code === 'CONTRACT_INVALID');
  await assert.rejects(async () => expiry.sweep(undefined), (e) => e.code === 'CONTRACT_INVALID');
});

test('overdue need without an attention row gets one on first sweep, and repeat sweeps append nothing', async () => {
  const db = makeDb();
  // 直接 INSERT（绕过 store）：模拟迁移进来的历史行，attention 投影尚不存在。
  db.prepare(`
    INSERT INTO w9_needs (id, owner_id, mission_id, type, question, due_at, default_action, status, answer, answered_at, revision)
    VALUES ('legacy-1', 'owner-a', 'm1', 'data', '缺省口径？', '2026-10-27T11:00:00Z', NULL, 'open', NULL, NULL, 1)
  `).run();

  const emitted = [];
  const expiry = createExpiry({ db, events: { emit: (evt) => emitted.push(evt) } });
  const first = await expiry.sweep('2026-10-27T12:00:00Z');
  assert.deepEqual(first, { defaulted: 0, waiting: 1 });
  const attention = db.prepare('SELECT unknown_flag, state FROM w9_attention_items WHERE need_id = ?').get('legacy-1');
  assert.deepEqual(attention, { unknown_flag: 1, state: 'open' });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM w9_need_events WHERE need_id = ? AND type = 'need.overdue_waiting'").get('legacy-1').n, 1);
  assert.equal(emitted.filter((e) => e.type === 'need.overdue_waiting').length, 1);

  const second = await expiry.sweep('2026-10-27T13:00:00Z');
  assert.deepEqual(second, { defaulted: 0, waiting: 1 });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM w9_need_events WHERE need_id = ? AND type = 'need.overdue_waiting'").get('legacy-1').n, 1, 'unchanged row must not append another event');
  assert.equal(emitted.filter((e) => e.type === 'need.overdue_waiting').length, 1);
});

test('concurrent skip (UPDATE matched 0 rows) is not counted as defaulted', async () => {
  const db = makeDb();
  const clock = fixedClock();
  const store = createNeedStore({ db, clock, idGen: seqId('need') });
  const need = await store.createNeed('owner-a', {
    missionId: 'm1', type: 'decision', question: 'A 还是 B？',
    dueAt: '2026-10-27T11:00:00Z', defaultAction: 'continue',
  });
  // 包装 db：把 defaulted UPDATE 桩成 changes=0（模拟行在 SELECT 与 UPDATE 之间已被迁移）。
  const stubbed = {
    prepare(sql) {
      if (sql.includes("SET status = 'defaulted'")) return { run: () => ({ changes: 0, lastInsertRowid: 0n }) };
      return db.prepare(sql);
    },
    exec(sql) { return db.exec(sql); },
  };
  const expiry = createExpiry({ db: stubbed });
  const result = await expiry.sweep('2026-10-27T12:00:00Z');
  assert.equal(result.defaulted, 0, 'a skipped migration must not be counted');
  assert.equal(db.prepare('SELECT status FROM w9_needs WHERE id = ?').get(need.id).status, 'open');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM w9_need_events WHERE need_id = ?').get(need.id).n, 1, 'only the creation event remains');
});

test('a crashing event sink rolls the default migration back atomically', async () => {
  const db = makeDb();
  const clock = fixedClock();
  const store = createNeedStore({ db, clock, idGen: seqId('need') });
  const need = await store.createNeed('owner-a', {
    missionId: 'm1', type: 'decision', question: 'A 还是 B？',
    dueAt: '2026-10-27T11:00:00Z', defaultAction: 'continue',
  });
  const expiry = createExpiry({ db, events: { emit: () => { throw new Error('sink down'); } } });
  await assert.rejects(async () => expiry.sweep('2026-10-27T12:00:00Z'), /sink down/);
  const row = db.prepare('SELECT status, answered_at FROM w9_needs WHERE id = ?').get(need.id);
  assert.equal(row.status, 'open', 'UPDATE must be rolled back');
  assert.equal(row.answered_at, null);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM w9_need_events WHERE need_id = ? AND type = 'need.defaulted'").get(need.id).n, 0, 'event insert must be rolled back too');
});

// ---------- routes 防御 ----------

test('routes factory requires db/auth/clock/idGen', () => {
  const db = makeDb();
  const auth = () => ({ ownerId: 'o' });
  const clock = fixedClock();
  assert.throws(() => createInboxRoutes({}), Error);
  assert.throws(() => createInboxRoutes({ db, auth }), Error);
  assert.throws(() => createInboxRoutes({ db, auth, clock }), Error);
});

test('POST answer with malformed JSON body returns 400 CONTRACT_INVALID', async () => {
  const db = makeDb();
  const clock = fixedClock();
  const store = createNeedStore({ db, clock, idGen: seqId('need') });
  const need = await store.createNeed('owner-a', {
    missionId: 'm1', type: 'decision', question: 'q', dueAt: '2026-10-27T12:00:00Z', defaultAction: 'continue',
  });
  const routes = createInboxRoutes({ db, auth: () => ({ ownerId: 'owner-a' }), clock, idGen: seqId('need') });
  const res = makeRes();
  await routes(makeReq('POST', `/api/needs/${need.id}/answer`, '{not json'), res, `/api/needs/${need.id}/answer`);
  await res.done;
  assert.equal(res.statusCode, 400);
  assert.equal(res.body().error.code, 'CONTRACT_INVALID');
});

test('POST answer with a non-object JSON body returns 400 CONTRACT_INVALID', async () => {
  const db = makeDb();
  const clock = fixedClock();
  const routes = createInboxRoutes({ db, auth: () => ({ ownerId: 'owner-a' }), clock, idGen: seqId('need') });
  for (const raw of ['"just a string"', '[1,2]', 'null']) {
    const res = makeRes();
    await routes(makeReq('POST', '/api/needs/x/answer', raw), res, '/api/needs/x/answer');
    await res.done;
    assert.equal(res.statusCode, 400, raw);
    assert.equal(res.body().error.code, 'CONTRACT_INVALID', raw);
  }
});

test('POST answer with an oversized body returns 400 CONTRACT_INVALID', async () => {
  const db = makeDb();
  const clock = fixedClock();
  const routes = createInboxRoutes({ db, auth: () => ({ ownerId: 'owner-a' }), clock, idGen: seqId('need') });
  const huge = `{"answer":"${'x'.repeat(1024 * 1024 + 64)}","revision":1}`;
  const res = makeRes();
  await routes(makeReq('POST', '/api/needs/x/answer', huge), res, '/api/needs/x/answer');
  await res.done;
  assert.equal(res.statusCode, 400);
  assert.equal(res.body().error.code, 'CONTRACT_INVALID');
});

test('unclassified failures surface as 500 INTERNAL_ERROR envelopes, never raw crashes', async () => {
  // 未迁移的 db：store.list 抛 SqliteError（未分类）→ 必须收敛为 api-error 信封。
  const db = openAgenticDb(':memory:');
  const routes = createInboxRoutes({ db, auth: () => ({ ownerId: 'owner-a' }), clock: fixedClock(), idGen: seqId('need') });
  const res = makeRes();
  const handled = await routes(makeReq('GET', '/api/inbox'), res, '/api/inbox');
  await res.done;
  assert.equal(handled, true);
  assert.equal(res.statusCode, 500);
  const body = res.body();
  assert.equal(validate(body, apiErrorSchema, { schemaDir: contractDir }).valid, true);
  assert.equal(body.error.code, 'INTERNAL_ERROR');
});

// ---------- attention-projection 防御 ----------

const RECORD = {
  id: 'need-1', ownerId: 'owner-a', missionId: 'm1', type: 'decision',
  question: 'q', dueAt: '2026-10-27T12:00:00Z', defaultAction: 'continue',
  status: 'open', answer: null, answeredAt: null, revision: 1,
};

test('toAttentionItem rejects a malformed defaultAction', () => {
  assert.throws(() => toAttentionItem({ ...RECORD, defaultAction: 5 }), (e) => e.code === 'CONTRACT_INVALID');
  assert.throws(() => toAttentionItem({ ...RECORD, status: '' }), (e) => e.code === 'CONTRACT_INVALID');
  assert.throws(() => toAttentionItem(null), (e) => e.code === 'CONTRACT_INVALID');
});

test('needView rejects records whose fields violate the frozen schema', () => {
  assert.throws(() => needView({ ...RECORD, dueAt: 'not-a-date' }), (e) => e.code === 'CONTRACT_INVALID');
  assert.throws(() => needView({ ...RECORD, missionId: '' }), (e) => e.code === 'CONTRACT_INVALID');
});
