import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadModule, span } from './_harness.mjs';

const dbApi = () => import('../../../../scripts/agentic/db/index.mjs');
const storeApi = () => loadModule('store.mjs');

async function freshStore() {
  const { openAgenticDb } = await dbApi();
  const { applyObservabilityMigrations, createObservabilityStore } = await storeApi();
  const db = openAgenticDb(':memory:');
  applyObservabilityMigrations(db);
  return { db, store: createObservabilityStore({ db }) };
}

test('store: applyObservabilityMigrations is idempotent and creates every obs_ table', async () => {
  const { openAgenticDb } = await dbApi();
  const { applyObservabilityMigrations, OBS_TABLES } = await storeApi();
  const db = openAgenticDb(':memory:');
  const first = applyObservabilityMigrations(db);
  const second = applyObservabilityMigrations(db);
  assert.ok(first.length >= 2);
  assert.deepEqual(second, []);
  const names = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name));
  for (const table of OBS_TABLES) assert.ok(names.has(table), `missing ${table}`);
  assert.ok([...names].every((name) => !name.startsWith('obs_') || OBS_TABLES.includes(name)));
  db.close();
});

test('store: migrations run against a file database without touching other tables', async () => {
  const { openAgenticDb, migrate } = await dbApi();
  const { OBS_MIGRATIONS_DIR, OBS_TABLES } = await storeApi();
  const dir = mkdtempSync(join(tmpdir(), 'donego-obs-store-'));
  const db = openAgenticDb(join(dir, 'agentic.sqlite'));
  migrate(db, OBS_MIGRATIONS_DIR);
  const names = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name));
  for (const table of OBS_TABLES) assert.ok(names.has(table));
  const ledger = db.prepare('SELECT name FROM _migrations ORDER BY name').all().map((row) => row.name);
  assert.ok(ledger.every((name) => name.startsWith('obs-')));
  db.close();
});

test('store: insertSpan stores a projected row and reports a new insert', async () => {
  const { store } = await freshStore();
  const result = store.insertSpan(span({ id: 's1' }), { ownerId: 'owner-a', runId: 'run-1' });
  assert.equal(result.inserted, true);
  assert.equal(result.duplicate, false);
  const row = store.getSpan('owner-a', 's1');
  assert.equal(row.id, 's1');
  assert.equal(row.run_id, 'run-1');
  assert.equal(row.status, 'ok');
  assert.equal(row.owner_id, 'owner-a');
});

test('store: re-inserting the same span id is idempotent and keeps the original columns (N3)', async () => {
  const { store } = await freshStore();
  store.insertSpan(span({ id: 's1', status: 'ok' }), { ownerId: 'owner-a', runId: 'run-1' });
  const second = store.insertSpan(
    span({ id: 's1', status: 'error', startedAt: '2026-10-27T11:00:00.000Z' }),
    { ownerId: 'owner-a', runId: 'run-1' },
  );
  assert.equal(second.inserted, false);
  assert.equal(second.duplicate, true);
  const row = store.getSpan('owner-a', 's1');
  assert.equal(row.status, 'ok');
  assert.equal(row.started_at, '2026-10-27T10:00:00.000Z');
  assert.equal(store.countSpans('owner-a'), 1);
});

test('store: a duplicate span from a different owner is rejected, not silently merged', async () => {
  const { store } = await freshStore();
  store.insertSpan(span({ id: 's1' }), { ownerId: 'owner-a', runId: 'run-1' });
  assert.throws(
    () => store.insertSpan(span({ id: 's1' }), { ownerId: 'owner-b', runId: 'run-9' }),
    (error) => error.code === 'SPAN_OWNER_MISMATCH',
  );
});

test('store: insertSpan requires an owner', async () => {
  const { store } = await freshStore();
  assert.throws(() => store.insertSpan(span({ id: 's1' }), {}), (error) => error.code === 'OWNER_REQUIRED');
  assert.throws(() => store.insertSpan(span({ id: 's2' }), { ownerId: '' }), (error) => error.code === 'OWNER_REQUIRED');
});

test('store: listSpans filters by owner and never leaks another tenant (N12)', async () => {
  const { store } = await freshStore();
  store.insertSpan(span({ id: 'a1' }), { ownerId: 'owner-a', runId: 'run-1' });
  store.insertSpan(span({ id: 'b1' }), { ownerId: 'owner-b', runId: 'run-2' });
  assert.deepEqual(store.listSpans('owner-a').map((row) => row.id), ['a1']);
  assert.deepEqual(store.listSpans('owner-b').map((row) => row.id), ['b1']);
  assert.deepEqual(store.listSpans('owner-c'), []);
});

test('store: getSpan returns null for another owner instead of the row (N12)', async () => {
  const { store } = await freshStore();
  store.insertSpan(span({ id: 'a1' }), { ownerId: 'owner-a', runId: 'run-1' });
  assert.equal(store.getSpan('owner-b', 'a1'), null);
  assert.equal(store.getSpan('owner-a', 'missing'), null);
});

test('store: listRunSpans is owner-scoped and ordered by start time', async () => {
  const { store } = await freshStore();
  store.insertSpan(span({ id: 'late', startedAt: '2026-10-27T10:00:05.000Z' }), { ownerId: 'owner-a', runId: 'run-1' });
  store.insertSpan(span({ id: 'early', startedAt: '2026-10-27T10:00:01.000Z' }), { ownerId: 'owner-a', runId: 'run-1' });
  store.insertSpan(span({ id: 'other-run' }), { ownerId: 'owner-a', runId: 'run-2' });
  store.insertSpan(span({ id: 'foreign-run' }), { ownerId: 'owner-b', runId: 'run-1' });
  assert.deepEqual(store.listRunSpans('owner-a', 'run-1').map((row) => row.id), ['early', 'late']);
});

test('store: upsertGate dedupes on (stream, name, head) and updates in place (N4)', async () => {
  const { store } = await freshStore();
  const base = {
    stream: 'W10', name: 'test:unit', head: 'abc1234', command: 'npm run test:unit',
    rc: 1, passed: 961, failed: 7, skipped: 2, ownerId: 'owner-a',
  };
  const first = store.upsertGate(base);
  const second = store.upsertGate({ ...base, rc: 0, failed: 0, passed: 968 });
  assert.equal(first.inserted, true);
  assert.equal(second.inserted, false);
  assert.equal(second.updated, true);
  const rows = store.listGates('owner-a', { stream: 'W10' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].rc, 0);
  assert.equal(rows[0].failed, 0);
  assert.equal(store.countGates('owner-a'), 1);
});

test('store: upsertGate still enforces the gate contract (N5)', async () => {
  const { store } = await freshStore();
  const base = { stream: 'W10', name: 'test:unit', head: 'abc1234', command: 'npm run test:unit', rc: 0, ownerId: 'owner-a' };
  assert.throws(() => store.upsertGate({ ...base, command: undefined }), (error) => error.code === 'GATE_INCOMPLETE');
  assert.throws(() => store.upsertGate({ ...base, rc: undefined }), (error) => error.code === 'GATE_INCOMPLETE');
  assert.throws(() => store.upsertGate({ ...base, head: undefined }), (error) => error.code === 'GATE_INCOMPLETE');
  assert.throws(() => store.upsertGate({ ...base, rc: 'zero' }), (error) => error.code === 'GATE_INCOMPLETE');
  assert.throws(() => store.upsertGate({ ...base, ownerId: undefined }), (error) => error.code === 'OWNER_REQUIRED');
});

test('store: gate evidence is stored as JSON and survives a round trip', async () => {
  const { store } = await freshStore();
  store.upsertGate({
    stream: 'W10', name: 'verify:web', head: 'abc1234', command: 'npm run verify:web', rc: 0,
    ownerId: 'owner-a',
    evidence: [{ type: 'test-run', title: 'verify:web', verified: true }],
  });
  const [row] = store.listGates('owner-a', { stream: 'W10' });
  assert.deepEqual(JSON.parse(row.evidence_json), [{ type: 'test-run', title: 'verify:web', verified: true }]);
});

test('store: upsertCacheEntry is idempotent on the cache key', async () => {
  const { store } = await freshStore();
  const entry = {
    key: 'k1', kind: 'block-summary', contractHash: 'a'.repeat(64), blockRevision: 'r1',
    model: 'gpt-6-luna', effort: 'low', inputsHash: 'b'.repeat(64), modelSource: 'gateway',
    ownerId: 'owner-a',
  };
  assert.equal(store.upsertCacheEntry(entry).inserted, true);
  assert.equal(store.upsertCacheEntry({ ...entry, modelSource: 'mock' }).inserted, false);
  const rows = store.listCacheEntries('owner-a');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].model_source, 'mock');
});

test('store: upsertRun stores a W0-valid run and is idempotent on the run id', async () => {
  const { store } = await freshStore();
  const run = {
    id: 'run-1',
    missionId: 'm-1',
    contractHash: 'a'.repeat(64),
    state: 'running',
    startedAt: '2026-10-27T10:00:00.000Z',
    updatedAt: '2026-10-27T10:00:30.000Z',
  };
  assert.equal(store.upsertRun(run, { ownerId: 'owner-a' }).inserted, true);
  const second = store.upsertRun({ ...run, state: 'succeeded', updatedAt: '2026-10-27T10:01:00.000Z' }, { ownerId: 'owner-a' });
  assert.equal(second.inserted, false);
  assert.equal(second.updated, true);
  const stored = store.getRun('owner-a', 'run-1');
  assert.equal(stored.state, 'succeeded');
  assert.equal(stored.mission_id, 'm-1');
  assert.equal(store.countRuns('owner-a'), 1);
});

test('store: upsertRun refuses an invalid W0 run payload', async () => {
  const { store } = await freshStore();
  assert.throws(
    () => store.upsertRun({ id: 'run-1', missionId: 'm-1', contractHash: 'a'.repeat(64), state: 'done', startedAt: '2026-10-27T10:00:00.000Z', updatedAt: '2026-10-27T10:00:00.000Z' }, { ownerId: 'owner-a' }),
    (error) => error.code === 'CONTRACT_INVALID',
  );
});

test('store: getRun never returns another owner run (N12)', async () => {
  const { store } = await freshStore();
  store.upsertRun({ id: 'run-secret', missionId: 'm', contractHash: 'a'.repeat(64), state: 'succeeded', startedAt: '2026-10-27T10:00:00.000Z', updatedAt: '2026-10-27T10:00:00.000Z' }, { ownerId: 'owner-b' });
  assert.equal(store.getRun('owner-a', 'run-secret'), null);
  assert.equal(store.getRun('owner-b', 'run-secret').id, 'run-secret');
});

test('store: listStaleCacheEntries returns only stale rows and never another owner (N7/N12)', async () => {
  const { store } = await freshStore();
  const base = {
    kind: 'block-summary', contractHash: 'a'.repeat(64), blockRevision: 'r1',
    model: 'gpt-6-luna', effort: 'low', inputsHash: 'b'.repeat(64), modelSource: 'gateway',
  };
  store.upsertCacheEntry({ ...base, key: 'k-fresh', ownerId: 'owner-a', stale: false, freshness: 'FRESH' });
  store.upsertCacheEntry({ ...base, key: 'k-stale', ownerId: 'owner-a', stale: true, freshness: 'STALE', reasons: ['contractHash'] });
  store.upsertCacheEntry({ ...base, key: 'k-foreign', ownerId: 'owner-b', stale: true, freshness: 'STALE' });
  const stale = store.listStaleCacheEntries('owner-a');
  assert.deepEqual(stale.map((row) => row.key), ['k-stale']);
  assert.deepEqual(JSON.parse(stale[0].reasons_json), ['contractHash']);
});

test('store: recordSpend keeps a missing costCny as NULL, never 0 (N6)', async () => {
  const { store } = await freshStore();
  store.recordSpend({ ownerId: 'owner-a', runId: 'run-1', stepId: 'step-1', attempt: 0, calls: 3, tokens: 1200 });
  store.recordSpend({ ownerId: 'owner-a', runId: 'run-1', stepId: 'step-2', attempt: 0, calls: 1, tokens: 300, costCny: 0, localShare: 1 });
  const rows = store.listSpend('owner-a', 'run-1');
  assert.equal(rows.length, 2);
  const free = rows.find((row) => row.step_id === 'step-2');
  const unknown = rows.find((row) => row.step_id === 'step-1');
  assert.equal(free.cost_cny, 0);
  assert.equal(unknown.cost_cny, null);
  assert.notEqual(free.cost_cny, unknown.cost_cny);
});

test('store: listSpend is owner scoped', async () => {
  const { store } = await freshStore();
  store.recordSpend({ ownerId: 'owner-a', runId: 'run-1', stepId: 'step-1', calls: 1, tokens: 10 });
  store.recordSpend({ ownerId: 'owner-b', runId: 'run-1', stepId: 'step-1', calls: 9, tokens: 90 });
  assert.equal(store.listSpend('owner-a', 'run-1').length, 1);
  assert.equal(store.listSpend('owner-a', 'run-1')[0].calls, 1);
});

test('store: recordSpend rejects negative counters', async () => {
  const { store } = await freshStore();
  assert.throws(
    () => store.recordSpend({ ownerId: 'owner-a', runId: 'r', stepId: 's', calls: -1, tokens: 0 }),
    (error) => error.code === 'CONTRACT_INVALID',
  );
});

test('store: observability tables never carry a hidden default owner', async () => {
  const { db } = await freshStore();
  const columns = db.prepare('PRAGMA table_info(obs_spans)').all();
  const owner = columns.find((column) => column.name === 'owner_id');
  assert.ok(owner);
  assert.equal(owner.notnull, 1);
  assert.equal(owner.dflt_value, null);
});

test('store: listSpend without a runId returns every row for that owner only', async () => {
  const { store } = await freshStore();
  store.recordSpend({ ownerId: 'owner-a', runId: 'run-1', stepId: 's1', calls: 1, tokens: 10 });
  store.recordSpend({ ownerId: 'owner-a', runId: 'run-2', stepId: 's2', calls: 2, tokens: 20 });
  store.recordSpend({ ownerId: 'owner-b', runId: 'run-1', stepId: 's1', calls: 9, tokens: 90 });
  assert.deepEqual(
    store.listSpend('owner-a').map((row) => row.run_id).sort(),
    ['run-1', 'run-2'],
  );
});

test('store: countRuns counts only the requesting owner (N12)', async () => {
  const { store } = await freshStore();
  const run = (id) => ({
    id, missionId: 'm', contractHash: 'a'.repeat(64), state: 'succeeded',
    startedAt: '2026-10-27T10:00:00.000Z', updatedAt: '2026-10-27T10:00:00.000Z',
  });
  store.upsertRun(run('a1'), { ownerId: 'owner-a' });
  store.upsertRun(run('a2'), { ownerId: 'owner-a' });
  store.upsertRun(run('b1'), { ownerId: 'owner-b' });
  assert.equal(store.countRuns('owner-a'), 2);
  assert.equal(store.countRuns('owner-b'), 1);
  assert.equal(store.countRuns('owner-c'), 0);
});

test('store: listRuns is owner scoped and ordered by start time', async () => {
  const { store } = await freshStore();
  const run = (id, startedAt) => ({
    id, missionId: 'm', contractHash: 'a'.repeat(64), state: 'succeeded',
    startedAt, updatedAt: startedAt,
  });
  store.upsertRun(run('late', '2026-10-27T10:00:09.000Z'), { ownerId: 'owner-a' });
  store.upsertRun(run('early', '2026-10-27T10:00:01.000Z'), { ownerId: 'owner-a' });
  store.upsertRun(run('foreign', '2026-10-27T10:00:00.000Z'), { ownerId: 'owner-b' });
  assert.deepEqual(store.listRuns('owner-a').map((row) => row.id), ['early', 'late']);
  assert.deepEqual(store.listRuns('owner-c'), []);
});

test('store: listGates filters by head within one owner (N12)', async () => {
  const { store } = await freshStore();
  const gate = (head, stream = 'W10') => ({
    stream, name: `gate-${stream}-${head}`, head, command: 'npm test', rc: 0, ownerId: 'owner-a',
  });
  store.upsertGate(gate('h1'));
  store.upsertGate(gate('h2'));
  store.upsertGate(gate('h1', 'W6'));
  store.upsertGate({ ...gate('h1'), ownerId: 'owner-b' });
  assert.deepEqual(
    store.listGates('owner-a', { head: 'h1' }).map((row) => row.stream).sort(),
    ['W10', 'W6'],
  );
  assert.deepEqual(
    store.listGates('owner-a', { stream: 'W10', head: 'h2' }).map((row) => row.head),
    ['h2'],
  );
});

test('store: recordAcceptance is idempotent per id and owner scoped', async () => {
  const { store, db } = await freshStore();
  store.recordAcceptance({ id: 'acc-1', ownerId: 'owner-a', artifactId: 'art-1', actor: 'reviewer', decision: 'accepted' });
  store.recordAcceptance({ id: 'acc-1', ownerId: 'owner-a', artifactId: 'art-1', actor: 'reviewer', decision: 'rejected' });
  store.recordAcceptance({ id: 'acc-2', ownerId: 'owner-b', decision: 'accepted' });
  const rows = db.prepare("SELECT * FROM obs_acceptances WHERE owner_id = 'owner-a'").all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].decision, 'rejected');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM obs_acceptances").get().n, 2);
  assert.throws(
    () => store.recordAcceptance({ id: 'acc-3', decision: 'accepted' }),
    (error) => error.code === 'OWNER_REQUIRED',
  );
});

test('store: recordNeed upserts status and recordGrant upserts status', async () => {
  const { store, db } = await freshStore();
  store.recordNeed({ id: 'need-1', ownerId: 'owner-a', missionId: 'm-1', status: 'open', dueAt: '2026-10-27T12:00:00.000Z' });
  store.recordNeed({ id: 'need-1', ownerId: 'owner-a', missionId: 'm-1', status: 'defaulted', answeredAt: '2026-10-27T12:00:01.000Z' });
  store.recordGrant({ id: 'grant-1', ownerId: 'owner-a', status: 'granted', expiresAt: '2026-10-28T00:00:00.000Z' });
  store.recordGrant({ id: 'grant-1', ownerId: 'owner-a', status: 'invalidated' });
  const need = db.prepare("SELECT * FROM obs_needs WHERE id = 'need-1'").get();
  assert.equal(need.status, 'defaulted');
  assert.equal(need.answered_at, '2026-10-27T12:00:01.000Z');
  const grant = db.prepare("SELECT * FROM obs_grants WHERE id = 'grant-1'").get();
  assert.equal(grant.status, 'invalidated');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM obs_needs').get().n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM obs_grants').get().n, 1);
  assert.throws(
    () => store.recordNeed({ id: 'need-x', status: 'open' }),
    (error) => error.code === 'OWNER_REQUIRED',
  );
  assert.throws(
    () => store.recordGrant({ id: 'grant-x', status: 'granted' }),
    (error) => error.code === 'OWNER_REQUIRED',
  );
});

test('store: parseJsonOr falls back on empty or invalid JSON text', async () => {
  const { parseJsonOr } = await storeApi();
  assert.deepEqual(parseJsonOr('', []), []);
  assert.deepEqual(parseJsonOr(null, {}), {});
  assert.deepEqual(parseJsonOr('not json', []), []);
  assert.deepEqual(parseJsonOr('["a"]', []), ['a']);
});
