import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadModule, createRequest, createResponse, span, CONTRACTS_DIR } from './_harness.mjs';

const dbApi = () => import('../../../../scripts/agentic/db/index.mjs');
const storeApi = () => loadModule('store.mjs');
const routesApi = () => loadModule('routes.mjs');

const schemaDir = fileURLToPath(CONTRACTS_DIR);
const apiErrorSchema = () => JSON.parse(readFileSync(`${schemaDir}api-error.schema.json`, 'utf8'));

async function freshRoutes(auth = () => ({ ownerId: 'owner-a' })) {
  const { openAgenticDb } = await dbApi();
  const { applyObservabilityMigrations, createObservabilityStore } = await storeApi();
  const { createObservabilityRoutes } = await routesApi();
  const db = openAgenticDb(':memory:');
  applyObservabilityMigrations(db);
  const store = createObservabilityStore({ db });
  const route = createObservabilityRoutes({ db, auth });
  return { db, store, route };
}

function call(route, { method = 'GET', url = '/', headers = {} } = {}) {
  const req = createRequest({ method, url, headers });
  const res = createResponse();
  const handled = route(req, res, url.split('?')[0]);
  return { handled, res };
}

async function seedRun(store, ownerId = 'owner-a', runId = 'run-1') {
  store.upsertRun({
    id: runId,
    missionId: 'm-1',
    contractHash: 'a'.repeat(64),
    state: 'succeeded',
    startedAt: '2026-10-27T10:00:00.000Z',
    updatedAt: '2026-10-27T10:01:00.000Z',
  }, { ownerId });
}

test('routes: an unrelated path is not handled and writes nothing', async () => {
  const { route } = await freshRoutes();
  const { handled, res } = call(route, { url: '/api/blocks' });
  assert.equal(handled, false);
  assert.equal(res.ended, false);
  assert.equal(res.statusCode, null);
});

test('routes: a method other than GET falls through instead of pretending to handle it', async () => {
  const { route } = await freshRoutes();
  const { handled } = call(route, { method: 'POST', url: '/api/runs/run-1/trace' });
  assert.equal(handled, false);
});

test('routes: an unauthenticated request is 401 AUTH_REQUIRED (W0 api-error envelope)', async () => {
  const { route } = await freshRoutes(() => null);
  const { handled, res } = call(route, { url: '/api/runs/run-1/trace' });
  assert.equal(handled, true);
  assert.equal(res.statusCode, 401);
  assert.equal(res.headers['content-type'], 'application/json; charset=utf-8');
  const body = res.json();
  assert.equal(body.error.code, 'AUTH_REQUIRED');
  const { validate } = await import('../../../../scripts/agentic/contracts.mjs');
  assert.equal(validate(body, apiErrorSchema(), { schemaDir }).valid, true, 'must match the frozen api-error schema');
});

test('routes: an auth function that throws is 401, never a 500 leak', async () => {
  const { route } = await freshRoutes(() => {
    throw new Error('token=secret-value');
  });
  const { res } = call(route, { url: '/api/runs/run-1/trace' });
  assert.equal(res.statusCode, 401);
  assert.equal(/secret-value/.test(res.body), false, 'the auth failure message must not leak');
});

test('routes: GET /api/runs/:id/trace returns the owner run trace with a span tree', async () => {
  const { route, store } = await freshRoutes();
  await seedRun(store);
  store.insertSpan(span({ id: 'root', startedAt: '2026-10-27T10:00:00.000Z' }), { ownerId: 'owner-a', runId: 'run-1' });
  store.insertSpan(span({ id: 'child', parentId: 'root', startedAt: '2026-10-27T10:00:01.000Z' }), { ownerId: 'owner-a', runId: 'run-1' });
  const { handled, res } = call(route, { url: '/api/runs/run-1/trace' });
  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.run.id, 'run-1');
  assert.equal(body.tree.roots[0].id, 'root');
  assert.deepEqual(body.tree.roots[0].children.map((node) => node.id), ['child']);
  assert.equal(body.spans.length, 2);
});

test('routes: an unknown run is 404 NOT_FOUND', async () => {
  const { route } = await freshRoutes();
  const { res } = call(route, { url: '/api/runs/nope/trace' });
  assert.equal(res.statusCode, 404);
  assert.equal(res.json().error.code, 'NOT_FOUND');
});

test('routes: a cross-owner run is byte-identically 404, leaking no existence (N12)', async () => {
  const { route, store } = await freshRoutes();
  await seedRun(store, 'owner-b', 'run-secret');
  store.insertSpan(span({ id: 'b-span' }), { ownerId: 'owner-b', runId: 'run-secret' });
  const foreign = call(route, { url: '/api/runs/run-secret/trace' });
  const unknown = call(route, { url: '/api/runs/run-does-not-exist/trace' });
  assert.equal(foreign.res.statusCode, 404);
  assert.equal(unknown.res.statusCode, 404);
  assert.equal(foreign.res.statusCode, unknown.res.statusCode);
  assert.equal(foreign.res.body, unknown.res.body);
  assert.equal(/run-secret|b-span/.test(foreign.res.body), false);
});

test('routes: GET /api/runs/:id/activity summarises span outcomes for the owner run', async () => {
  const { route, store } = await freshRoutes();
  await seedRun(store);
  store.insertSpan(span({ id: 'ok-1', status: 'ok' }), { ownerId: 'owner-a', runId: 'run-1' });
  store.insertSpan(span({ id: 'bad-1', status: 'error', error: 'boom' }), { ownerId: 'owner-a', runId: 'run-1' });
  const { handled, res } = call(route, { url: '/api/runs/run-1/activity' });
  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.runId, 'run-1');
  assert.equal(body.counts.succeeded, 1);
  assert.equal(body.counts.failed, 1);
  assert.deepEqual(body.items.map((item) => item.id).sort(), ['bad-1', 'ok-1']);
});

test('routes: activity is owner scoped as well (N12)', async () => {
  const { route, store } = await freshRoutes();
  await seedRun(store, 'owner-b', 'run-secret');
  const { res } = call(route, { url: '/api/runs/run-secret/activity' });
  assert.equal(res.statusCode, 404);
  assert.equal(res.json().error.code, 'NOT_FOUND');
});

test('routes: GET /api/cache/stale lists only stale entries for the owner', async () => {
  const { route, store } = await freshRoutes();
  const base = {
    kind: 'block-summary',
    contractHash: 'a'.repeat(64),
    blockRevision: 'r1',
    model: 'gpt-6-luna',
    effort: 'low',
    inputsHash: 'b'.repeat(64),
    modelSource: 'gateway',
    ownerId: 'owner-a',
  };
  store.upsertCacheEntry({ ...base, key: 'k-fresh', stale: false, freshness: 'FRESH' });
  store.upsertCacheEntry({ ...base, key: 'k-stale', stale: true, freshness: 'STALE', reasons: ['contractHash'] });
  store.upsertCacheEntry({ ...base, key: 'k-foreign', stale: true, freshness: 'STALE', reasons: ['inputsHash'], ownerId: 'owner-b' });
  const { handled, res } = call(route, { url: '/api/cache/stale' });
  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.deepEqual(body.entries.map((entry) => entry.key), ['k-stale']);
  assert.deepEqual(body.entries[0].reasons, ['contractHash']);
  assert.equal(body.count, 1);
});

test('routes: /api/cache/stale accepts a query string and reports UNKNOWN-safe empty results', async () => {
  const { route } = await freshRoutes();
  const { handled, res } = call(route, { url: '/api/cache/stale?kind=block-summary' });
  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { entries: [], count: 0 });
});

test('routes: a run id needing URL escaping is decoded before lookup', async () => {
  const { route, store } = await freshRoutes();
  await seedRun(store, 'owner-a', 'run/with space');
  const { res } = call(route, { url: `/api/runs/${encodeURIComponent('run/with space')}/trace` });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().run.id, 'run/with space');
});

test('routes: /api/runs (no id) is not handled', async () => {
  const { route } = await freshRoutes();
  assert.equal(call(route, { url: '/api/runs' }).handled, false);
  assert.equal(call(route, { url: '/api/runs//trace' }).handled, false);
  assert.equal(call(route, { url: '/api/runs/run-1/unknown-sub' }).handled, false);
});

test('routes: every route response is JSON so the client never guesses a format', async () => {
  const { route, store } = await freshRoutes();
  await seedRun(store);
  for (const url of ['/api/runs/run-1/trace', '/api/runs/run-1/activity', '/api/cache/stale']) {
    const { res } = call(route, { url });
    assert.equal(res.statusCode, 200, url);
    assert.equal(res.headers['content-type'], 'application/json; charset=utf-8', url);
    assert.doesNotThrow(() => res.json(), url);
  }
});

test('routes: the factory does not require a mounted http server to be testable', async () => {
  const { createObservabilityRoutes } = await routesApi();
  const { openAgenticDb } = await dbApi();
  const { applyObservabilityMigrations } = await storeApi();
  const db = openAgenticDb(':memory:');
  applyObservabilityMigrations(db);
  const route = createObservabilityRoutes({ db, auth: () => ({ ownerId: 'owner-z' }) });
  assert.equal(typeof route, 'function');
  assert.equal(route.length, 3);
  db.close();
});
