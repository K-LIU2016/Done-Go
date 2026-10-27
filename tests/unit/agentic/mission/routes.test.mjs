import test from 'node:test';
import assert from 'node:assert/strict';
import { createMissionRoutes } from '../../../../scripts/agentic/mission/routes.mjs';
import { openAgenticDb, migrate } from '../../../../scripts/agentic/db/index.mjs';
import { createMissionStore } from '../../../../scripts/agentic/mission/store.mjs';

import { fileURLToPath } from 'node:url';
const dir = fileURLToPath(new URL('../../../../scripts/agentic/db/migrations/', import.meta.url));
const body = value => ({ headers: { 'content-type': 'application/json' }, async json() { return value; } });
const res = () => ({ statusCode: 200, headers: {}, body: null, writeHead(code, headers) { this.statusCode = code; this.headers = headers; }, end(value) { this.body = value ? JSON.parse(value) : null; } });
const mission = { id: 'm1', ownerId: 'ignored', revision: 1, schemaVersion: 1, blockId: 'b1', goal: 'research', state: 'draft', autonomy: 'A2', scanId: null, previewId: null, contractId: null, createdAt: '2026-10-27T12:00:00Z', updatedAt: '2026-10-27T12:00:00Z', deletedAt: null };

function harness() {
  const db = openAgenticDb(':memory:'); migrate(db, dir);
  const store = createMissionStore(db);
  const routes = createMissionRoutes({ db, auth: { ownerId(req) { return req.ownerId; } }, store });
  return { db, routes };
}
async function call(routes, method, path, ownerId, payload) {
  const request = body(payload); request.method = method; request.url = path; request.ownerId = ownerId;
  const response = res();
  const handled = await routes(request, response, path);
  return { handled, response };
}

test('creates, reads and transitions a mission through an owner-scoped route', async () => {
  const { db, routes } = harness();
  try {
    let result = await call(routes, 'POST', '/api/missions', 'o1', mission);
    assert.equal(result.response.statusCode, 201);
    result = await call(routes, 'GET', '/api/missions/m1', 'o1');
    assert.equal(result.response.statusCode, 200);
    assert.equal(result.response.body.ownerId, 'o1');
    result = await call(routes, 'POST', '/api/missions/m1/transition', 'o1', { commandId: 'c1', event: 'scan', scanId: 's1' });
    assert.equal(result.response.statusCode, 200);
    assert.equal(result.response.body.mission.state, 'scanned');
    result = await call(routes, 'POST', '/api/missions/m1/transition', 'o1', { commandId: 'c1', event: 'scan', scanId: 's1' });
    assert.equal(result.response.statusCode, 200);
    assert.equal(result.response.body.replayed, true);
  } finally { db.close(); }
});

test('hides another owner and rejects stale route commands', async () => {
  const { db, routes } = harness();
  try {
    await call(routes, 'POST', '/api/missions', 'o1', mission);
    let result = await call(routes, 'GET', '/api/missions/m1', 'o2');
    assert.equal(result.response.statusCode, 404);
    result = await call(routes, 'POST', '/api/missions/m1/transition', 'o1', { commandId: 'c2', expectedRevision: 99, event: 'scan', scanId: 's1' });
    assert.equal(result.response.statusCode, 409);
    assert.equal(result.response.body.error.code, 'CONFLICT');
  } finally { db.close(); }
});

test('returns false for paths outside the mission route boundary', async () => {
  const { db, routes } = harness();
  try {
    const result = await call(routes, 'GET', '/api/other', 'o1');
    assert.equal(result.handled, false);
  } finally { db.close(); }
});
