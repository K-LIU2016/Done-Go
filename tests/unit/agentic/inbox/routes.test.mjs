// W9 M3 inbox-domain · routes 单测（TDD RED 先行）
//
// 本文件是 `scripts/agentic/inbox/routes.mjs` 的接口规约（BUILD-PLAN §2.2 路由工厂形态）：
//   createInboxRoutes({ db, auth, clock, idGen, events }) → (req, res, pathname) => handled:boolean
//   - GET  /api/inbox            → 200 { items: [...] }（owner 隔离；item 含 id/status/revision，
//     revision 供客户端乐观回答）。
//   - POST /api/needs/:id/answer body { answer, revision } → 200 { need: {...} }（status 'answered'）。
//   - 未登录 401 AUTH_REQUIRED；跨 owner/未知 id 404 NOT_FOUND；旧 revision 409 CONFLICT；
//     缺 answer/revision 400 CONTRACT_INVALID —— 全部 api-error 信封（过 api-error.schema.json）。
//   - 未匹配 pathname → false。不挂 serve-tango（W13 归属）；不发任何外部通知。
import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openAgenticDb, migrate } from '../../../../scripts/agentic/db/index.mjs';
import { loadSchema, validate } from '../../../../scripts/agentic/contracts.mjs';
import { createNeedStore } from '../../../../scripts/agentic/inbox/need-store.mjs';
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

function makeReq(method, url, body) {
  const req = body === undefined ? Readable.from([]) : Readable.from([JSON.stringify(body)]);
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

function makeSetup() {
  const db = openAgenticDb(':memory:');
  migrate(db, join(root, 'scripts/agentic/db/migrations'));
  const clock = fixedClock();
  const store = createNeedStore({ db, clock, idGen: seqId('need') });
  let currentOwner = null;
  const auth = () => (currentOwner ? { ownerId: currentOwner } : null);
  const routes = createInboxRoutes({ db, auth, clock, idGen: seqId('need') });
  return {
    db, store, routes,
    as: (ownerId) => { currentOwner = ownerId; },
    anon: () => { currentOwner = null; },
  };
}

const INPUT = {
  missionId: 'm1',
  type: 'decision',
  question: '大纲方向 A 还是 B？',
  dueAt: '2026-10-27T12:00:00Z',
  defaultAction: 'continue',
};

test('GET /api/inbox lists only the caller’s needs with revision', async () => {
  const s = makeSetup();
  const mine = await s.store.createNeed('owner-a', INPUT);
  await s.store.createNeed('owner-b', INPUT);
  s.as('owner-a');
  const res = makeRes();
  const handled = await s.routes(makeReq('GET', '/api/inbox'), res, '/api/inbox');
  assert.equal(handled, true);
  await res.done;
  assert.equal(res.statusCode, 200);
  const body = res.body();
  assert.equal(body.items.length, 1);
  assert.equal(body.items[0].id, mine.id);
  assert.equal(body.items[0].status, 'open');
  assert.equal(body.items[0].revision, 1);
});

test('GET /api/inbox unauthenticated returns 401 AUTH_REQUIRED envelope', async () => {
  const s = makeSetup();
  s.anon();
  const res = makeRes();
  await s.routes(makeReq('GET', '/api/inbox'), res, '/api/inbox');
  await res.done;
  assert.equal(res.statusCode, 401);
  const body = res.body();
  assert.equal(validate(body, apiErrorSchema, { schemaDir: contractDir }).valid, true);
  assert.equal(body.error.code, 'AUTH_REQUIRED');
});

test('POST /api/needs/:id/answer answers a need and returns the updated state', async () => {
  const s = makeSetup();
  const need = await s.store.createNeed('owner-a', INPUT);
  s.as('owner-a');
  const res = makeRes();
  await s.routes(makeReq('POST', `/api/needs/${need.id}/answer`, { answer: '选 A', revision: 1 }), res, `/api/needs/${need.id}/answer`);
  await res.done;
  assert.equal(res.statusCode, 200);
  const body = res.body();
  assert.equal(body.need.status, 'answered');
  assert.equal(body.need.answer, '选 A');
  assert.equal(body.need.revision, 2);
});

test('POST answer with a stale revision returns 409 CONFLICT envelope', async () => {
  const s = makeSetup();
  const need = await s.store.createNeed('owner-a', INPUT);
  await s.store.answer('owner-a', need.id, { answer: '选 A', revision: 1 });
  s.as('owner-a');
  const res = makeRes();
  await s.routes(makeReq('POST', `/api/needs/${need.id}/answer`, { answer: '旧的', revision: 1 }), res, `/api/needs/${need.id}/answer`);
  await res.done;
  assert.equal(res.statusCode, 409);
  const body = res.body();
  assert.equal(validate(body, apiErrorSchema, { schemaDir: contractDir }).valid, true);
  assert.equal(body.error.code, 'CONFLICT');
});

test('POST answer on another owner’s need returns 404 without leaking existence', async () => {
  const s = makeSetup();
  const need = await s.store.createNeed('owner-a', INPUT);
  s.as('owner-b');
  const res = makeRes();
  await s.routes(makeReq('POST', `/api/needs/${need.id}/answer`, { answer: 'hijack', revision: 1 }), res, `/api/needs/${need.id}/answer`);
  await res.done;
  assert.equal(res.statusCode, 404);
  assert.equal(res.body().error.code, 'NOT_FOUND');
});

test('POST answer for an unknown need id returns 404', async () => {
  const s = makeSetup();
  s.as('owner-a');
  const res = makeRes();
  await s.routes(makeReq('POST', '/api/needs/no-such/answer', { answer: 'x', revision: 1 }), res, '/api/needs/no-such/answer');
  await res.done;
  assert.equal(res.statusCode, 404);
  assert.equal(res.body().error.code, 'NOT_FOUND');
});

test('POST answer with missing or invalid body fields returns 400 CONTRACT_INVALID', async () => {
  const s = makeSetup();
  const need = await s.store.createNeed('owner-a', INPUT);
  s.as('owner-a');
  for (const body of [{ revision: 1 }, { answer: 'x' }, { answer: '', revision: 1 }, { answer: 'x', revision: 'one' }]) {
    const res = makeRes();
    await s.routes(makeReq('POST', `/api/needs/${need.id}/answer`, body), res, `/api/needs/${need.id}/answer`);
    await res.done;
    assert.equal(res.statusCode, 400, JSON.stringify(body));
    assert.equal(res.body().error.code, 'CONTRACT_INVALID');
  }
});

test('POST answer unauthenticated returns 401', async () => {
  const s = makeSetup();
  const need = await s.store.createNeed('owner-a', INPUT);
  s.anon();
  const res = makeRes();
  await s.routes(makeReq('POST', `/api/needs/${need.id}/answer`, { answer: 'x', revision: 1 }), res, `/api/needs/${need.id}/answer`);
  await res.done;
  assert.equal(res.statusCode, 401);
  assert.equal(res.body().error.code, 'AUTH_REQUIRED');
});

test('unmatched paths return false untouched', async () => {
  const s = makeSetup();
  s.as('owner-a');
  for (const [method, pathname] of [['GET', '/api/artifacts/x'], ['POST', '/api/needs/x/waive'], ['PUT', '/api/inbox']]) {
    const res = makeRes();
    const handled = await s.routes(makeReq(method, pathname), res, pathname);
    assert.equal(handled, false, pathname);
    assert.equal(res.statusCode, 0);
  }
});
