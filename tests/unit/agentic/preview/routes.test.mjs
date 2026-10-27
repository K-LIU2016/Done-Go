// S2D-W6 module 9: preview-routes — createPreviewRoutes({db,auth,parsePatch,now})
// → (req,res,pathname)=>handled. HTTP surface per DAG §3 row 9; every error is
// the frozen api-error envelope; auth is injectable; cross-owner is NOT_FOUND.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  openMigratedDb, makeClock, makePreview, call, bodyJson, checkWithSchema,
  CONTRACTS_DIR,
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

// M1 (R1 review): the frozen contracts/agentic/README.md HTTP table maps both
// BUDGET_EXCEEDED and NEED_HUMAN to 409; W3 uses the same mapping. These codes
// are not produced by W6 routes today, but STATUS_BY_CODE must stay consistent
// with the frozen table so cross-stream error handling does not diverge.
test('BUDGET_EXCEEDED and NEED_HUMAN surface as 409 per the frozen README HTTP table', async () => {
  const { routesMod, previewStoreMod } = await loadStores();
  const db = openMigratedDb();
  try {
    const now = makeClock();
    const previewStore = previewStoreMod.createPreviewStore(db, { now });
    await previewStore.put({ ownerId: 'owner-a', missionId: 'm1', preview: makePreview({ missionId: 'm1' }) });
    for (const code of ['BUDGET_EXCEEDED', 'NEED_HUMAN']) {
      const parsePatch = async () => {
        const error = new Error(code.toLowerCase().replace(/_/g, ' '));
        error.code = code;
        throw error;
      };
      const routes = routesMod.createPreviewRoutes({
        db,
        auth: req => (req.headers['x-owner'] ? { ownerId: req.headers['x-owner'] } : null),
        parsePatch,
        now,
      });
      const hit = await call(routes, 'POST', '/api/missions/m1/discuss', {
        ...OWNER_A, body: { utterance: '触发配额/人工路径', baseVersion: 1 },
      });
      assertErrorEnvelope(hit.res, code);
      assert.equal(hit.res.statusCode, 409, `${code} must map to 409 (frozen README table), got ${hit.res.statusCode}`);
    }
    // Fail-closed: neither error path wrote a new preview version.
    const latest = await previewStore.latest({ ownerId: 'owner-a', missionId: 'm1' });
    assert.equal(latest.version, 1);
  } finally {
    db.close();
  }
});

// Remediation blocker B, hardened: the mapping regression is driven by the
// FROZEN contracts/agentic/README.md HTTP table itself, so STATUS_BY_CODE can
// never drift from the frozen contract — and every code is exercised through
// a real request, never excused as "no path triggers it today".
test('every frozen README error code maps to exactly its frozen HTTP status through the route surface', async () => {
  const readme = readFileSync(join(CONTRACTS_DIR, 'README.md'), 'utf8');
  const section = readme.slice(
    readme.indexOf('## 错误码与 HTTP 建议'),
    readme.indexOf('##', readme.indexOf('## 错误码与 HTTP 建议') + 3),
  );
  const frozenTable = [...section.matchAll(/^\| `([A-Z_]+)` \|[^|]+\| (\d{3}) \|$/gm)]
    .map(([, code, status]) => ({ code, status: Number(status) }));
  assert.equal(frozenTable.length, 10, `expected all 10 frozen error codes, got ${frozenTable.length}`);
  assert.deepEqual(
    frozenTable.filter(row => row.code === 'BUDGET_EXCEEDED' || row.code === 'NEED_HUMAN'),
    [{ code: 'BUDGET_EXCEEDED', status: 409 }, { code: 'NEED_HUMAN', status: 409 }],
    'the frozen table itself pins both gate codes to 409',
  );

  const { routesMod, previewStoreMod } = await loadStores();
  const db = openMigratedDb();
  try {
    const now = makeClock();
    const previewStore = previewStoreMod.createPreviewStore(db, { now });
    await previewStore.put({ ownerId: 'owner-a', missionId: 'm1', preview: makePreview({ missionId: 'm1' }) });
    for (const { code, status } of frozenTable) {
      const parsePatch = async () => {
        const error = new Error(`${code.toLowerCase().replace(/_/g, ' ')} (injected)`);
        error.code = code;
        throw error;
      };
      const routes = routesMod.createPreviewRoutes({
        db,
        auth: req => (req.headers['x-owner'] ? { ownerId: req.headers['x-owner'] } : null),
        parsePatch,
        now,
      });
      const hit = await call(routes, 'POST', '/api/missions/m1/discuss', {
        ...OWNER_A, body: { utterance: `触发 ${code}`, baseVersion: 1 },
      });
      assertErrorEnvelope(hit.res, code);
      assert.equal(
        hit.res.statusCode, status,
        `${code} must surface as ${status} per the frozen README table, got ${hit.res.statusCode}`,
      );
    }
    // Fail-closed: none of the injected error paths wrote a preview version.
    const latest = await previewStore.latest({ ownerId: 'owner-a', missionId: 'm1' });
    assert.equal(latest.version, 1);
  } finally {
    db.close();
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

test('defaults: deterministic kernel parses without an injected parsePatch; real clock accepted', async () => {
  const { routesMod, previewStoreMod } = await loadStores();
  const db = openMigratedDb();
  try {
    const now = makeClock();
    const previewStore = previewStoreMod.createPreviewStore(db, { now });
    await previewStore.put({ ownerId: 'owner-a', missionId: 'm1', preview: makePreview({ missionId: 'm1' }) });
    const routes = routesMod.createPreviewRoutes({
      db,
      auth: req => (req.headers['x-owner'] ? { ownerId: req.headers['x-owner'] } : null),
    });

    // R1 kernel rule: 只看… → sources.include, so a new preview version lands.
    const narrowed = await call(routes, 'POST', '/api/missions/m1/discuss', {
      ...OWNER_A, body: { utterance: '研究只看公开论文', baseVersion: 1 },
    });
    assert.equal(narrowed.res.statusCode, 200);
    assert.equal(bodyJson(narrowed.res).preview.version, 2);
    assert.equal(bodyJson(narrowed.res).preview.preview.shape.blocks[1].items[0].v, '公开论文');

    // Chatter the kernel does not match: talk recorded, preview untouched.
    const chatter = await call(routes, 'POST', '/api/missions/m1/discuss', {
      ...OWNER_A, body: { utterance: '随便聊聊', baseVersion: 2 },
    });
    assert.equal(chatter.res.statusCode, 200);
    assert.equal(bodyJson(chatter.res).preview.version, 2);
    assert.equal(bodyJson(chatter.res).message.afterVersion, 2);
  } finally {
    db.close();
  }
});

test('GET discussion: 404 before any preview exists; empty replay once previewed but not yet discussed', async () => {
  const world = await freshServer();
  try {
    const threadless = await call(world.routes, 'GET', '/api/missions/m_never/discussion', OWNER_A);
    assertErrorEnvelope(threadless.res, 'NOT_FOUND');

    // m1 has a preview (freshServer) but no recorded turn yet.
    const empty = await call(world.routes, 'GET', '/api/missions/m1/discussion', OWNER_A);
    assert.equal(empty.res.statusCode, 200);
    const body = bodyJson(empty.res);
    assert.equal(body.thread, null);
    assert.deepEqual(body.messages, []);
    assert.deepEqual(body.changeRecords, []);
  } finally {
    world.db.close();
  }
});

test('unknown body keys and bad types are CONTRACT_INVALID before any write', async () => {
  const world = await freshServer();
  try {
    const extraKey = await call(world.routes, 'POST', '/api/missions/m1/discuss', {
      ...OWNER_A, body: { utterance: '你好', extra: true, baseVersion: 1 },
    });
    assertErrorEnvelope(extraKey.res, 'CONTRACT_INVALID');

    const badBase = await call(world.routes, 'POST', '/api/missions/m1/discuss', {
      ...OWNER_A, body: { utterance: '你好', baseVersion: 'one' },
    });
    assertErrorEnvelope(badBase.res, 'CONTRACT_INVALID');

    const badUtterance = await call(world.routes, 'POST', '/api/missions/m1/discuss', {
      ...OWNER_A, body: { utterance: 42, baseVersion: 1 },
    });
    assertErrorEnvelope(badUtterance.res, 'CONTRACT_INVALID');

    const confirmExtra = await call(world.routes, 'POST', '/api/missions/m1/confirm', {
      ...OWNER_A, body: { previewVersion: 1, decision: 'confirm', unexpected: 1 },
    });
    assertErrorEnvelope(confirmExtra.res, 'CONTRACT_INVALID');

    // Nothing above wrote anything: no thread, no confirmations.
    const thread = await call(world.routes, 'GET', '/api/missions/m1/discussion', OWNER_A);
    assert.equal(bodyJson(thread.res).messages.length, 0);
  } finally {
    world.db.close();
  }
});

test('an oversized request body is rejected CONTRACT_INVALID without reading it all', async () => {
  const world = await freshServer();
  try {
    const oversized = await call(world.routes, 'POST', '/api/missions/m1/discuss', {
      ...OWNER_A, body: `{"utterance":"${'x'.repeat(70_000)}"}`,
    });
    assertErrorEnvelope(oversized.res, 'CONTRACT_INVALID');
    assert.equal(oversized.res.statusCode, 400);
  } finally {
    world.db.close();
  }
});

test('an auth function throwing surfaces INTERNAL_ERROR, not a crash', async () => {
  const { routesMod } = await loadStores();
  const db = openMigratedDb();
  try {
    const routes = routesMod.createPreviewRoutes({
      db,
      auth: () => { throw new Error('auth backend exploded'); },
      parsePatch: async () => ({ patch: null, origin: 'none' }),
      now: makeClock(),
    });
    const { res } = await call(routes, 'GET', '/api/missions/m1/preview', OWNER_A);
    assertErrorEnvelope(res, 'INTERNAL_ERROR');
    assert.equal(res.statusCode, 500);
  } finally {
    db.close();
  }
});

test('empty missionId is claimed and rejected CONTRACT_INVALID, not silently 404d', async () => {
  const world = await freshServer();
  try {
    assert.equal(await handledFlag(world.routes, 'GET', '/api/missions//preview'), true);
    const { res } = await call(world.routes, 'GET', '/api/missions//preview', OWNER_A);
    assertErrorEnvelope(res, 'CONTRACT_INVALID');
  } finally {
    world.db.close();
  }
});

test('GET versions for a foreign owner is an empty list (no existence leak)', async () => {
  const world = await freshServer();
  try {
    const foreign = await call(world.routes, 'GET', '/api/missions/m1/preview/versions', OWNER_B);
    assert.equal(foreign.res.statusCode, 200);
    assert.deepEqual(bodyJson(foreign.res), []);
  } finally {
    world.db.close();
  }
});
