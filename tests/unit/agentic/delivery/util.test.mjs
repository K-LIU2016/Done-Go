// W9 M1 delivery-domain · 补充单测：util.mjs 各分支直测（提升 branch 覆盖，RED 规约文件之外的新增）
import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openAgenticDb, migrate } from '../../../../scripts/agentic/db/index.mjs';
import {
  ApiError, NOOP_EVENTS, assertNonEmptyString, httpStatusFor, readJsonBody,
  rejectServerOwnedFields, rejectUnknownFields, requireInjectables, sendApiError, sendJson,
  toApiError, withTransaction,
} from '../../../../scripts/agentic/delivery/util.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../../..');

function makeRes() {
  const chunks = [];
  const res = {
    statusCode: 0,
    headers: {},
    setHeader(key, value) { this.headers[key.toLowerCase()] = value; return this; },
    writeHead(status, headers = {}) { this.statusCode = status; for (const [k, v] of Object.entries(headers)) this.setHeader(k, v); return this; },
    write(chunk) { chunks.push(Buffer.from(chunk)); return true; },
    end(chunk) { if (chunk !== undefined && chunk !== null) chunks.push(Buffer.from(chunk)); },
  };
  res.body = () => JSON.parse(Buffer.concat(chunks).toString('utf8'));
  return res;
}

const streamOf = (value) => Readable.from(value === undefined ? [] : [value]);

test('httpStatusFor maps README codes and defaults unknown to 500', () => {
  assert.equal(httpStatusFor('AUTH_REQUIRED'), 401);
  assert.equal(httpStatusFor('FORBIDDEN'), 403);
  assert.equal(httpStatusFor('NOT_FOUND'), 404);
  assert.equal(httpStatusFor('CONTRACT_INVALID'), 400);
  assert.equal(httpStatusFor('CONFLICT'), 409);
  assert.equal(httpStatusFor('RATE_LIMITED'), 429);
  assert.equal(httpStatusFor('BUDGET_EXCEEDED'), 409);
  assert.equal(httpStatusFor('NEED_HUMAN'), 409);
  assert.equal(httpStatusFor('UPSTREAM_UNAVAILABLE'), 503);
  assert.equal(httpStatusFor('INTERNAL_ERROR'), 500);
  assert.equal(httpStatusFor('NO_SUCH_CODE'), 500);
});

test('toApiError passes ApiError through and wraps others as INTERNAL_ERROR with cause', () => {
  const original = new ApiError('CONFLICT', 'keep me');
  assert.equal(toApiError(original), original);
  const wrapped = toApiError(new TypeError('boom'));
  assert.equal(wrapped.code, 'INTERNAL_ERROR');
  assert.equal(wrapped.cause.message, 'boom');
});

test('sendJson writes status, content-type and payload', () => {
  const res = makeRes();
  sendJson(res, 200, { ok: true });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['content-type'], 'application/json; charset=utf-8');
  assert.deepEqual(res.body(), { ok: true });
});

test('sendApiError renders the api-error envelope with and without details', () => {
  const withDetails = makeRes();
  sendApiError(withDetails, new ApiError('CONTRACT_INVALID', 'bad', { field: 'x' }));
  assert.equal(withDetails.statusCode, 400);
  assert.deepEqual(withDetails.body(), { error: { code: 'CONTRACT_INVALID', message: 'bad', details: { field: 'x' } } });

  const bare = makeRes();
  sendApiError(bare, new ApiError('NOT_FOUND', 'missing'));
  assert.deepEqual(bare.body(), { error: { code: 'NOT_FOUND', message: 'missing' } });
  assert.equal('details' in bare.body().error, false);

  const foreign = makeRes();
  sendApiError(foreign, new Error('raw'));
  assert.deepEqual(foreign.body(), { error: { code: 'INTERNAL_ERROR', message: 'unclassified delivery-domain failure' } });
});

test('readJsonBody: empty body → {}, valid object → parsed', async () => {
  assert.deepEqual(await readJsonBody(streamOf()), {});
  assert.deepEqual(await readJsonBody(streamOf('   ')), {});
  assert.deepEqual(await readJsonBody(streamOf(JSON.stringify({ a: 1 }))), { a: 1 });
  assert.deepEqual(await readJsonBody(streamOf(Buffer.from(JSON.stringify({ b: 2 })))), { b: 2 });
});

test('readJsonBody rejects invalid JSON and non-object bodies', async () => {
  await assert.rejects(async () => readJsonBody(streamOf('{oops')), (e) => e.code === 'CONTRACT_INVALID');
  await assert.rejects(async () => readJsonBody(streamOf('[1,2]')), (e) => e.code === 'CONTRACT_INVALID');
  await assert.rejects(async () => readJsonBody(streamOf('null')), (e) => e.code === 'CONTRACT_INVALID');
  await assert.rejects(async () => readJsonBody(streamOf('5')), (e) => e.code === 'CONTRACT_INVALID');
});

test('readJsonBody rejects oversized bodies', async () => {
  const huge = JSON.stringify({ blob: 'x'.repeat(1024 * 1024 + 64) });
  await assert.rejects(async () => readJsonBody(streamOf(huge)), (e) => e.code === 'CONTRACT_INVALID');
});

test('requireInjectables passes when present, throws naming missing keys', () => {
  const db = {}; const clock = {}; const idGen = () => 'x';
  requireInjectables('t', { db, clock, idGen }, ['db', 'clock', 'idGen']);
  assert.throws(() => requireInjectables('t', { db }, ['db', 'clock']), /clock/);
  assert.throws(() => requireInjectables('t', { db: null, clock }, ['db', 'clock']), /db/);
});

test('assertNonEmptyString accepts strings and rejects others', () => {
  assert.equal(assertNonEmptyString('ok', 'f'), 'ok');
  assert.throws(() => assertNonEmptyString('', 'f'), (e) => e.code === 'CONTRACT_INVALID');
  assert.throws(() => assertNonEmptyString(42, 'f'), (e) => e.code === 'CONTRACT_INVALID');
});

test('rejectServerOwnedFields / rejectUnknownFields only throw on offending payloads', () => {
  rejectServerOwnedFields({ a: 1 }, ['id', 'hash'], 'artifact');
  rejectUnknownFields({ a: 1, artifactId: 'x' }, ['a', 'artifactId'], 'artifact');
  assert.throws(
    () => rejectServerOwnedFields({ id: 'forged', hash: 'x', keep: 1 }, ['id', 'hash'], 'artifact'),
    (e) => e.code === 'CONTRACT_INVALID' && e.details.fields.includes('id') && e.details.fields.includes('hash'),
  );
  assert.throws(
    () => rejectUnknownFields({ keep: 1, bogus: 2 }, ['keep'], 'artifact'),
    (e) => e.code === 'CONTRACT_INVALID' && e.details.fields.includes('bogus'),
  );
});

test('withTransaction commits on success and rolls back on failure', async () => {
  const db = openAgenticDb(':memory:');
  migrate(db, join(root, 'scripts/agentic/db/migrations'));
  const clock = { now: () => '2026-10-27T10:00:00Z' };
  let n = 0;
  const { createArtifactStore } = await import('../../../../scripts/agentic/delivery/artifact-store.mjs');
  const store = createArtifactStore({ db, clock, idGen: () => `tx-${++n}` });
  const art = await store.put('owner-a', { missionId: 'm1', type: 'report', title: 't', location: '/a', status: 'ready' });
  const insertEvent = (id) => db.prepare(
    "INSERT INTO w9_artifact_events (id, owner_id, artifact_id, type, payload_json, created_at) VALUES (?,'owner-a',?,'deleted','{}','2026-10-27T10:00:00Z')",
  ).run(id, art.id);

  const count = () => db.prepare('SELECT COUNT(*) AS n FROM w9_artifact_events').get().n;
  assert.equal(count(), 0);

  const returned = withTransaction(db, () => {
    insertEvent('e1');
    return 'done';
  });
  assert.equal(returned, 'done');
  assert.equal(count(), 1);

  assert.throws(() => withTransaction(db, () => {
    insertEvent('e2');
    throw new Error('abort');
  }), /abort/);
  assert.equal(count(), 1, 'failed transaction must leave no partial writes');
});

test('NOOP_EVENTS.emit is a harmless default', () => {
  assert.equal(NOOP_EVENTS.emit({ type: 'x' }), undefined);
});
