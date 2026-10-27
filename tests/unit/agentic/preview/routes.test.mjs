// S2D-W6 module 9: preview-routes — createPreviewRoutes({db,auth,parsePatch,now})
// → (req,res,pathname)=>handled. HTTP surface per DAG §3 row 9; every error is
// the frozen api-error envelope; auth is injectable; cross-owner is NOT_FOUND.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  openMigratedDb, makeClock, makePreview, call, bodyJson, checkWithSchema,
} from './_helpers.mjs';

async function loadRoutes() {
  return import('../../../../scripts/agentic/preview/routes.mjs');
}

async function loadStores() {
  const [routesMod, previewStoreMod, discussionStoreMod] = await Promise.all([
    loadRoutes(),
    import('../../../../scripts/agentic/preview/store.mjs'),
    import('../../../../scripts/agentic/discussion/store.mjs'),
  ]);
  return { routesMod, previewStoreMod, discussionStoreMod };
}

async function freshServer({ ownerId = 'owner-a' } = {}) {
  const { routesMod, previewStoreMod, discussionStoreMod } = await loadStores();
  const db = openMigratedDb();
  const now = makeClock();
  const previewStore = previewStoreMod.createPreviewStore(db, { now });
  const discussionStore = discussionStoreMod.createDiscussionStore(db, { now });
  await previewStore.put({ ownerId, missionId: 'm1', preview: makePreview({ missionId: 'm1' }) });
  const parsePatch = async utterance => {
    if (utterance.includes('只看')) return { patch: { sources: { include: ['国内 K12'] } }, origin: 'rules' };
    if (utterance.includes('失败')) { const error = new Error('upstream down'); error.code = 'UPSTREAM_UNAVAILABLE'; throw error; }
    return { patch: null, origin: 'none' };
  };
  const routes = routesMod.createPreviewRoutes({ db, auth: req => (req.headers['x-owner'] ? { ownerId: req.headers['x-owner'] } : null), parsePatch, now });
  return { db, routes, previewStore, discussionStore, ownerId };
}

const OWNER_A = { headers: { 'x-owner': 'owner-a' } };
const OWNER_B = { headers: { 'x-owner': 'owner-b' } };

async function handledFlag(routes, method, pathname, options) {
  const { handled } = await call(routes, method, pathname, options);
  return handled;
}

function assertErrorEnvelope(res, expectedCode) {
  assert.equal(res.statusCode >= 400, true, `expected 4xx/5xx, got ${res.statusCode}`);
  const body = bodyJson(res);
  assert.equal(checkWithSchema(body, 'api-error.schema.json').valid, true, 'body must match the frozen api-error envelope');
  assert.equal(body.error.code, expectedCode);
  return body;
}

test('unrelated paths are not handled', async () => {
  const world = await freshServer();
  try {
    assert.equal(await handledFlag(world.routes, 'GET', '/api/other'), false);
    assert.equal(await handledFlag(world.routes, 'POST', '/api/blocks/sync'), false);
  } finally {
    world.db.close();
  }
});

test('GET /api/missions/:id/preview returns the latest version row', async () => {
  const world = await freshServer();
  try {
    const { handled, res } = await call(world.routes, 'GET', '/api/missions/m1/preview', OWNER_A);
    assert.equal(handled, true);
    assert.equal(res.statusCode, 200);
    const body = bodyJson(res);
    assert.equal(body.version, 1);
    assert.equal(body.preview.missionId, 'm1');
    assert.equal(body.preview.shape.blocks.length, 3);
  } finally {
    world.db.close();
  }
});

test('GET preview/versions lists the chain; GET preview/timeline returns the projection', async () => {
  const world = await freshServer();
  try {
    await world.previewStore.put({ ownerId: 'owner-a', missionId: 'm1', preview: makePreview({ missionId: 'm1' }) });
    const versions = await call(world.routes, 'GET', '/api/missions/m1/preview/versions', OWNER_A);
    assert.equal(versions.res.statusCode, 200);
    assert.deepEqual(bodyJson(versions.res).map(row => row.version), [1, 2]);

    const timeline = await call(world.routes, 'GET', '/api/missions/m1/preview/timeline', OWNER_A);
    assert.equal(timeline.res.statusCode, 200);
    const vm = bodyJson(timeline.res);
    assert.equal(vm.missionId, 'm1');
    assert.equal(vm.version, 2);
    assert.equal(vm.shots.length, 4);
    assert.equal(vm.durationSec, 42);
    assert.equal(vm.narration.segments.length, 4);
  } finally {
    world.db.close();
  }
});

test('unauthenticated requests get a 401 AUTH_REQUIRED envelope on every route', async () => {
  const world = await freshServer();
  try {
    for (const [method, path, options] of [
      ['GET', '/api/missions/m1/preview', {}],
      ['POST', '/api/missions/m1/discuss', { body: { utterance: 'hi' } }],
      ['GET', '/api/missions/m1/discussion', {}],
      ['POST', '/api/missions/m1/confirm', { body: { previewVersion: 1, decision: 'confirm' } }],
    ]) {
      const { res } = await call(world.routes, method, path, options);
      assertErrorEnvelope(res, 'AUTH_REQUIRED');
      assert.equal(res.statusCode, 401);
    }
  } finally {
    world.db.close();
  }
});

test('cross-owner access is a 404 NOT_FOUND envelope (no existence leak)', async () => {
  const world = await freshServer();
  try {
    for (const path of ['/api/missions/m1/preview', '/api/missions/m1/preview/timeline', '/api/missions/m1/discussion']) {
      const { res } = await call(world.routes, 'GET', path, OWNER_B);
      assertErrorEnvelope(res, 'NOT_FOUND');
      assert.equal(res.statusCode, 404);
    }
  } finally {
    world.db.close();
  }
});

test('unknown mission preview is 404 with a valid envelope', async () => {
  const world = await freshServer();
  try {
    const { res } = await call(world.routes, 'GET', '/api/missions/m_ghost/preview', OWNER_A);
    assertErrorEnvelope(res, 'NOT_FOUND');
  } finally {
    world.db.close();
  }
});

test('POST discuss applies the patch end to end and GET discussion replays the thread', async () => {
  const world = await freshServer();
  try {
    const first = await call(world.routes, 'POST', '/api/missions/m1/discuss', {
      ...OWNER_A, body: { utterance: '研究只看国内 K12', baseVersion: 1 },
    });
    assert.equal(first.res.statusCode, 200);
    const body = bodyJson(first.res);
    assert.equal(body.preview.version, 2);
    assert.equal(body.message.afterVersion, 2);
    assert.equal(body.replayed, false);

    const thread = await call(world.routes, 'GET', '/api/missions/m1/discussion', OWNER_A);
    assert.equal(thread.res.statusCode, 200);
    const threadBody = bodyJson(thread.res);
    assert.equal(threadBody.messages.length, 1);
    assert.equal(threadBody.messages[0].utterance, '研究只看国内 K12');

    // Replay of the same body is idempotent over HTTP.
    const replay = await call(world.routes, 'POST', '/api/missions/m1/discuss', {
      ...OWNER_A, body: { utterance: '研究只看国内 K12', baseVersion: 1 },
    });
    assert.equal(replay.res.statusCode, 200);
    assert.equal(bodyJson(replay.res).replayed, true);
    assert.equal(bodyJson(replay.res).message.id, body.message.id);
  } finally {
    world.db.close();
  }
});

test('POST discuss negative paths: bad body 400, stale base 409, upstream 503', async () => {
  const world = await freshServer();
  try {
    const badBody = await call(world.routes, 'POST', '/api/missions/m1/discuss', {
      ...OWNER_A, body: { nope: true },
    });
    assertErrorEnvelope(badBody.res, 'CONTRACT_INVALID');
    assert.equal(badBody.res.statusCode, 400);

    const malformed = await call(world.routes, 'POST', '/api/missions/m1/discuss', {
      ...OWNER_A, body: '{not json',
    });
    assertErrorEnvelope(malformed.res, 'CONTRACT_INVALID');

    await world.previewStore.put({ ownerId: 'owner-a', missionId: 'm1', preview: makePreview({ missionId: 'm1' }) });
    const stale = await call(world.routes, 'POST', '/api/missions/m1/discuss', {
      ...OWNER_A, body: { utterance: '再来一条不同的话', baseVersion: 1 },
    });
    assertErrorEnvelope(stale.res, 'CONFLICT');
    assert.equal(stale.res.statusCode, 409);

    const upstream = await call(world.routes, 'POST', '/api/missions/m1/discuss', {
      ...OWNER_A, body: { utterance: '触发失败路径' },
    });
    assertErrorEnvelope(upstream.res, 'UPSTREAM_UNAVAILABLE');
    assert.equal(upstream.res.statusCode, 503);
    // Fail-closed: preview untouched by both the conflict and the upstream error.
    const latest = await world.previewStore.latest({ ownerId: 'owner-a', missionId: 'm1' });
    assert.equal(latest.version, 2);
  } finally {
    world.db.close();
  }
});

test('POST confirm records the decision; replay idempotent; bad input 400/404', async () => {
  const world = await freshServer();
  try {
    const confirm = await call(world.routes, 'POST', '/api/missions/m1/confirm', {
      ...OWNER_A, body: { previewVersion: 1, decision: 'confirm' },
    });
    assert.equal(confirm.res.statusCode, 200);
    const record = bodyJson(confirm.res);
    assert.equal(record.event.type, 'contract-draft-request');

    const replay = await call(world.routes, 'POST', '/api/missions/m1/confirm', {
      ...OWNER_A, body: { previewVersion: 1, decision: 'confirm' },
    });
    assert.equal(bodyJson(replay.res).id, record.id);
    assert.equal(bodyJson(replay.res).replayed, true);

    const badDecision = await call(world.routes, 'POST', '/api/missions/m1/confirm', {
      ...OWNER_A, body: { previewVersion: 1, decision: 'whatever' },
    });
    assertErrorEnvelope(badDecision.res, 'CONTRACT_INVALID');

    const unknownVersion = await call(world.routes, 'POST', '/api/missions/m1/confirm', {
      ...OWNER_A, body: { previewVersion: 9, decision: 'decline' },
    });
    assertErrorEnvelope(unknownVersion.res, 'NOT_FOUND');
  } finally {
    world.db.close();
  }
});

test('routes only claim their own paths and methods', async () => {
  const world = await freshServer();
  try {
    assert.equal(await handledFlag(world.routes, 'DELETE', '/api/missions/m1/preview'), false);
    assert.equal(await handledFlag(world.routes, 'GET', '/api/blocks'), false);
    assert.equal(await handledFlag(world.routes, 'GET', '/api/missions/m1/preview'), true);
  } finally {
    world.db.close();
  }
});
