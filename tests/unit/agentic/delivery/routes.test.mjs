// W9 M1 delivery-domain · routes 单测（TDD RED 先行）
//
// 本文件是 `scripts/agentic/delivery/routes.mjs` 的接口规约（BUILD-PLAN §2.2 路由工厂形态）：
//   createDeliveryRoutes({ db, auth, clock, idGen, events, verdictGate? }) → (req, res, pathname) => handled:boolean
//   - auth(req) → { ownerId } | null；null → 401 AUTH_REQUIRED（api-error 信封）。
//   - GET  /api/artifacts/:id            → 200 artifact 对象（过 artifact.schema.json）；?version=N 支持。
//   - POST /api/artifacts/:id/accept     → 200 { acceptance, verdict? }
//   - POST /api/artifacts/:id/revise     → 200 { acceptance, verdict? }（body 必须带非空 comment）
//   - POST /api/artifacts/:id/reject     → 200 { acceptance, verdict? }
//     acceptance 过 acceptance.schema.json；verdictGate 提供时附 verdict 摘要，未提供则无 verdict 字段。
//   - 错误一律 api-error 信封（过 api-error.schema.json），HTTP 码按 README §错误码表。
//   - 未匹配的 pathname 返回 false 且不写响应（挂载与集成归 W13）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openAgenticDb, migrate } from '../../../../scripts/agentic/db/index.mjs';
import { loadSchema, validate } from '../../../../scripts/agentic/contracts.mjs';
import { createArtifactStore } from '../../../../scripts/agentic/delivery/artifact-store.mjs';
import { createDeliveryRoutes } from '../../../../scripts/agentic/delivery/routes.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../../..');
const contractDir = join(root, 'contracts/agentic');
const artifactSchema = loadSchema('artifact.schema.json', contractDir);
const acceptanceSchema = loadSchema('acceptance.schema.json', contractDir);
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
  const store = createArtifactStore({ db, clock, idGen: seqId('art') });
  let currentOwner = null;
  const auth = () => (currentOwner ? { ownerId: currentOwner } : null);
  const routes = createDeliveryRoutes({ db, auth, clock, idGen: seqId('acc') });
  return {
    db, clock, store, routes,
    as: (ownerId) => { currentOwner = ownerId; },
    anon: () => { currentOwner = null; },
  };
}

const PAYLOAD = {
  missionId: 'm1',
  type: 'report',
  title: '研究报告',
  location: '/artifacts/r1.md',
  status: 'ready',
  evidence: [{ type: 'dod-check', title: 'DoD', detail: '含 3 节', verified: true }],
};

test('GET /api/artifacts/:id returns a schema-valid artifact', async () => {
  const s = makeSetup();
  const art = await s.store.put('owner-a', PAYLOAD);
  s.as('owner-a');
  const res = makeRes();
  const handled = await s.routes(makeReq('GET', `/api/artifacts/${art.id}`), res, `/api/artifacts/${art.id}`);
  assert.equal(handled, true);
  await res.done;
  assert.equal(res.statusCode, 200);
  const body = res.body();
  assert.equal(validate(body, artifactSchema, { schemaDir: contractDir }).valid, true, JSON.stringify(body));
  assert.equal(body.id, art.id);
});

test('GET /api/artifacts/:id?version=1 returns the requested version', async () => {
  const s = makeSetup();
  const art = await s.store.put('owner-a', { ...PAYLOAD, title: 'v1' });
  await s.store.put('owner-a', { ...PAYLOAD, artifactId: art.id, title: 'v2' });
  s.as('owner-a');
  const res = makeRes();
  await s.routes(makeReq('GET', `/api/artifacts/${art.id}?version=1`), res, `/api/artifacts/${art.id}?version=1`);
  await res.done;
  assert.equal(res.statusCode, 200);
  assert.equal(res.body().title, 'v1');
});

test('GET unknown or cross-owner artifact returns a 404 api-error envelope', async () => {
  const s = makeSetup();
  const art = await s.store.put('owner-a', PAYLOAD);
  s.as('owner-b');
  const res = makeRes();
  await s.routes(makeReq('GET', `/api/artifacts/${art.id}`), res, `/api/artifacts/${art.id}`);
  await res.done;
  assert.equal(res.statusCode, 404);
  const body = res.body();
  assert.equal(validate(body, apiErrorSchema, { schemaDir: contractDir }).valid, true);
  assert.equal(body.error.code, 'NOT_FOUND');
});

test('unauthenticated requests get 401 AUTH_REQUIRED before any object access', async () => {
  const s = makeSetup();
  const art = await s.store.put('owner-a', PAYLOAD);
  s.anon();
  for (const spec of [
    ['GET', `/api/artifacts/${art.id}`, undefined],
    ['POST', `/api/artifacts/${art.id}/accept`, { actor: 'user:alice' }],
  ]) {
    const res = makeRes();
    await s.routes(makeReq(spec[0], spec[1], spec[2]), res, spec[1]);
    await res.done;
    assert.equal(res.statusCode, 401, spec[1]);
    const body = res.body();
    assert.equal(validate(body, apiErrorSchema, { schemaDir: contractDir }).valid, true);
    assert.equal(body.error.code, 'AUTH_REQUIRED');
  }
});

test('POST accept records a schema-valid acceptance and flips the artifact', async () => {
  const s = makeSetup();
  const art = await s.store.put('owner-a', PAYLOAD);
  s.as('owner-a');
  const res = makeRes();
  await s.routes(makeReq('POST', `/api/artifacts/${art.id}/accept`, { actor: 'user:alice', comment: '好' }), res, `/api/artifacts/${art.id}/accept`);
  await res.done;
  assert.equal(res.statusCode, 200);
  const body = res.body();
  assert.equal(validate(body.acceptance, acceptanceSchema, { schemaDir: contractDir }).valid, true);
  assert.equal(body.acceptance.decision, 'accepted');
  assert.equal((await s.store.get('owner-a', art.id)).status, 'accepted');
  assert.equal(body.verdict, undefined, 'no verdictGate → no verdict field');
});

test('POST accept with an injected verdictGate attaches the verdict summary', async () => {
  const db = openAgenticDb(':memory:');
  migrate(db, join(root, 'scripts/agentic/db/migrations'));
  const clock = fixedClock();
  const store = createArtifactStore({ db, clock, idGen: seqId('art') });
  const art = await store.put('owner-a', PAYLOAD);
  const verdictGate = async (artifactId, version) => {
    assert.equal(artifactId, art.id);
    assert.equal(version, 1);
    return { blocking: false, unknownCount: 0, highFailCount: 0 };
  };
  const routes = createDeliveryRoutes({ db, auth: () => ({ ownerId: 'owner-a' }), clock, idGen: seqId('acc'), verdictGate });
  const res = makeRes();
  await routes(makeReq('POST', `/api/artifacts/${art.id}/accept`, { actor: 'user:alice' }), res, `/api/artifacts/${art.id}/accept`);
  await res.done;
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body().verdict, { blocking: false, unknownCount: 0, highFailCount: 0 });
});

test('POST revise without comment returns 400 CONTRACT_INVALID envelope', async () => {
  const s = makeSetup();
  const art = await s.store.put('owner-a', PAYLOAD);
  s.as('owner-a');
  const res = makeRes();
  await s.routes(makeReq('POST', `/api/artifacts/${art.id}/revise`, { actor: 'user:alice' }), res, `/api/artifacts/${art.id}/revise`);
  await res.done;
  assert.equal(res.statusCode, 400);
  const body = res.body();
  assert.equal(validate(body, apiErrorSchema, { schemaDir: contractDir }).valid, true);
  assert.equal(body.error.code, 'CONTRACT_INVALID');
});

test('POST accept on a generating artifact returns 409 CONFLICT envelope', async () => {
  const s = makeSetup();
  const art = await s.store.put('owner-a', { ...PAYLOAD, status: 'generating' });
  s.as('owner-a');
  const res = makeRes();
  await s.routes(makeReq('POST', `/api/artifacts/${art.id}/accept`, { actor: 'user:alice' }), res, `/api/artifacts/${art.id}/accept`);
  await res.done;
  assert.equal(res.statusCode, 409);
  assert.equal(res.body().error.code, 'CONFLICT');
});

test('POST accept with an agent actor returns 403 FORBIDDEN envelope', async () => {
  const s = makeSetup();
  const art = await s.store.put('owner-a', PAYLOAD);
  s.as('owner-a');
  const res = makeRes();
  await s.routes(makeReq('POST', `/api/artifacts/${art.id}/accept`, { actor: 'agent:writer-1' }), res, `/api/artifacts/${art.id}/accept`);
  await res.done;
  assert.equal(res.statusCode, 403);
  const body = res.body();
  assert.equal(validate(body, apiErrorSchema, { schemaDir: contractDir }).valid, true);
  assert.equal(body.error.code, 'FORBIDDEN');
});

test('POST reject with cross-owner auth returns 404 without leaking existence', async () => {
  const s = makeSetup();
  const art = await s.store.put('owner-a', PAYLOAD);
  s.as('owner-b');
  const res = makeRes();
  await s.routes(makeReq('POST', `/api/artifacts/${art.id}/reject`, { actor: 'user:bob' }), res, `/api/artifacts/${art.id}/reject`);
  await res.done;
  assert.equal(res.statusCode, 404);
  assert.equal(res.body().error.code, 'NOT_FOUND');
});

test('unmatched paths and unknown sub-actions return false untouched', async () => {
  const s = makeSetup();
  s.as('owner-a');
  for (const [method, pathname] of [
    ['GET', '/api/inbox'],
    ['GET', '/api/artifacts'],
    ['POST', '/api/artifacts/art-1/unknown-action'],
    ['DELETE', '/api/artifacts/art-1'],
  ]) {
    const res = makeRes();
    const handled = await s.routes(makeReq(method, pathname), res, pathname);
    assert.equal(handled, false, pathname);
    assert.equal(res.statusCode, 0, `${pathname} must not be written`);
  }
});
