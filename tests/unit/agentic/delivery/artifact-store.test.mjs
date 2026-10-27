// W9 M1 delivery-domain · artifact-store 单测（TDD RED 先行）
//
// 本文件是 `scripts/agentic/delivery/artifact-store.mjs` 的接口规约：
//   createArtifactStore({ db, clock, idGen, events }) → { put, get, list, versions, delete }
//   - put(ownerId, payload): payload = { artifactId?, missionId, type, title, location,
//     status?('generating'|'ready'), evidence?[] }。返回通过 artifact.schema.json 的对象。
//     带 artifactId → 追加新版本（版本号 = 服务端 max+1）；不带 → 新工件 v1。
//     与该工件当前最新版本内容完全相同的重复 put 幂等返回既有版本，不新增版本行。
//   - get(ownerId, artifactId, { version? }) / list(ownerId, { missionId? }) /
//     versions(ownerId, artifactId) / delete(ownerId, artifactId)（软删，只写事件）。
// 钉死约定（来自 brief 裁决②与 contracts/agentic/README.md）：
//   - id/version/createdAt/ownerId/source/hash 一律服务端生成，客户端提交即 CONTRACT_INVALID。
//   - 跨 owner 一律 NOT_FOUND（README §owner 隔离：不泄露对象存在性）。
//   - 业务错误为 Error 且 error.code ∈ README 错误码枚举。
//   - clock.now() 产生全部时间；events.emit({type, ownerId, objectType, objectId, at, data}) 默认 no-op。
import test from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openAgenticDb, migrate } from '../../../../scripts/agentic/db/index.mjs';
import { loadSchema, validate } from '../../../../scripts/agentic/contracts.mjs';
import { createArtifactStore } from '../../../../scripts/agentic/delivery/artifact-store.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../../..');
const contractDir = join(root, 'contracts/agentic');
const artifactSchema = loadSchema('artifact.schema.json', contractDir);

const T0 = Date.parse('2026-10-27T10:00:00Z');
const fixedClock = (at = '2026-10-27T10:00:00Z') => ({ now: () => at });
const seqClock = (baseMs = T0, stepMs = 1000) => {
  let n = 0;
  return { now: () => new Date(baseMs + n++ * stepMs).toISOString() };
};
const seqId = (prefix) => {
  let n = 0;
  return () => `${prefix}-${++n}`;
};
const eventsRecorder = () => {
  const emitted = [];
  return { emitted, sink: { emit: (evt) => { emitted.push(evt); } } };
};

function makeDb() {
  const db = openAgenticDb(':memory:');
  migrate(db, join(root, 'scripts/agentic/db/migrations'));
  return db;
}

const PAYLOAD = {
  missionId: 'm1',
  type: 'report',
  title: '研究报告',
  location: '/artifacts/r1.md',
  status: 'ready',
  evidence: [{ type: 'test-run', title: '单测', uri: 'node --test', verified: true }],
};

test('put creates version 1 with server-generated identity fields', async () => {
  const db = makeDb();
  const clock = fixedClock('2026-10-27T10:00:00Z');
  const store = createArtifactStore({ db, clock, idGen: seqId('art') });
  const art = await store.put('owner-a', PAYLOAD);
  assert.equal(art.version, 1);
  assert.equal(art.ownerId, 'owner-a');
  assert.equal(art.status, 'ready');
  assert.equal(art.createdAt, '2026-10-27T10:00:00Z');
  assert.ok(typeof art.id === 'string' && art.id.length > 0);
  const result = validate(art, artifactSchema, { schemaDir: contractDir });
  assert.equal(result.valid, true, JSON.stringify(result.errors));
});

test('put without status defaults to generating', async () => {
  const db = makeDb();
  const store = createArtifactStore({ db, clock: fixedClock(), idGen: seqId('art') });
  const art = await store.put('owner-a', { ...PAYLOAD, status: undefined });
  assert.equal(art.status, 'generating');
});

test('client cannot submit server-generated fields', async () => {
  const db = makeDb();
  const store = createArtifactStore({ db, clock: fixedClock(), idGen: seqId('art') });
  for (const field of ['id', 'version', 'createdAt', 'ownerId', 'source', 'hash']) {
    await assert.rejects(
      async () => store.put('owner-a', { ...PAYLOAD, [field]: 'forged' }),
      (error) => error.code === 'CONTRACT_INVALID',
      `payload with ${field} must be rejected`,
    );
  }
});

test('client cannot put acceptance-owned statuses', async () => {
  const db = makeDb();
  const store = createArtifactStore({ db, clock: fixedClock(), idGen: seqId('art') });
  for (const status of ['accepted', 'revision_requested', 'rejected']) {
    await assert.rejects(
      async () => store.put('owner-a', { ...PAYLOAD, status }),
      (error) => error.code === 'CONTRACT_INVALID',
    );
  }
});

test('invalid payloads and invalid evidence items are rejected', async () => {
  const db = makeDb();
  const store = createArtifactStore({ db, clock: fixedClock(), idGen: seqId('art') });
  await assert.rejects(async () => store.put('owner-a', { ...PAYLOAD, type: 'bogus' }), (e) => e.code === 'CONTRACT_INVALID');
  await assert.rejects(async () => store.put('owner-a', { ...PAYLOAD, title: '' }), (e) => e.code === 'CONTRACT_INVALID');
  await assert.rejects(async () => store.put('owner-a', { ...PAYLOAD, evidence: 'nope' }), (e) => e.code === 'CONTRACT_INVALID');
  await assert.rejects(
    async () => store.put('owner-a', { ...PAYLOAD, evidence: [{ type: 'not-a-type', title: 'x' }] }),
    (e) => e.code === 'CONTRACT_INVALID',
  );
  await assert.rejects(
    async () => store.put('owner-a', { ...PAYLOAD, evidence: [{ type: 'test-run', title: 'x', bogusField: 1 }] }),
    (e) => e.code === 'CONTRACT_INVALID',
  );
});

test('new versions increment monotonically and isolate evidence per version', async () => {
  const db = makeDb();
  const clock = seqClock();
  const store = createArtifactStore({ db, clock, idGen: seqId('art') });
  const v1 = await store.put('owner-a', { ...PAYLOAD, title: 'v1 标题' });
  const v2 = await store.put('owner-a', { ...PAYLOAD, artifactId: v1.id, title: 'v2 标题', evidence: [{ type: 'diff', title: 'd' }] });

  assert.equal(v2.version, 2);
  assert.equal(v2.id, v1.id);

  const latest = await store.get('owner-a', v1.id);
  assert.equal(latest.version, 2);
  assert.equal(latest.title, 'v2 标题');

  const old = await store.get('owner-a', v1.id, { version: 1 });
  assert.equal(old.title, 'v1 标题');
  assert.deepEqual(old.evidence, PAYLOAD.evidence);

  const versions = await store.versions('owner-a', v1.id);
  assert.deepEqual(versions.map((v) => v.version), [1, 2]);
  for (const v of versions) {
    assert.equal(validate(v, artifactSchema, { schemaDir: contractDir }).valid, true);
  }
});

test('duplicate put of identical latest content is idempotent', async () => {
  const db = makeDb();
  const clock = fixedClock();
  const store = createArtifactStore({ db, clock, idGen: seqId('art') });
  const first = await store.put('owner-a', PAYLOAD);
  const again = await store.put('owner-a', { ...PAYLOAD, artifactId: first.id });
  assert.deepEqual(again, first);

  const versions = await store.versions('owner-a', first.id);
  assert.equal(versions.length, 1);
  const rows = db.prepare('SELECT version, content_hash FROM w9_artifact_versions WHERE artifact_id = ?').all(first.id);
  assert.equal(rows.length, 1);
});

test('re-putting an older version’s content creates a new version instead of rolling back', async () => {
  const db = makeDb();
  const clock = fixedClock();
  const store = createArtifactStore({ db, clock, idGen: seqId('art') });
  const contentV1 = { ...PAYLOAD, title: 'A' };
  const contentV2 = { ...PAYLOAD, title: 'B' };
  const v1 = await store.put('owner-a', contentV1);
  await store.put('owner-a', { ...contentV2, artifactId: v1.id });
  const v3 = await store.put('owner-a', { ...contentV1, artifactId: v1.id });

  assert.equal(v3.version, 3, 'same-as-v1 content must append v3, never roll back to v1');
  const versions = await store.versions('owner-a', v1.id);
  assert.equal(versions.length, 3);

  const rows = db.prepare('SELECT version, content_hash FROM w9_artifact_versions WHERE artifact_id = ? ORDER BY version').all(v1.id);
  assert.equal(rows.length, 3);
  assert.match(rows[0].content_hash, /^[0-9a-f]{64}$/);
  assert.equal(rows[2].content_hash, rows[0].content_hash, 'identical content must hash identically');
  assert.notEqual(rows[1].content_hash, rows[0].content_hash);
});

test('content_hash is deterministic across artifacts with identical content', async () => {
  const db = makeDb();
  const clock = fixedClock();
  const store = createArtifactStore({ db, clock, idGen: seqId('art') });
  const a = await store.put('owner-a', PAYLOAD);
  const b = await store.put('owner-a', PAYLOAD);
  assert.notEqual(a.id, b.id, 'two creates are two distinct artifacts');
  const rows = db.prepare('SELECT artifact_id, content_hash FROM w9_artifact_versions WHERE version = 1').all();
  const byArtifact = Object.fromEntries(rows.map((r) => [r.artifact_id, r.content_hash]));
  assert.equal(byArtifact[a.id], byArtifact[b.id], 'hash identifies content, not artifact identity');
});

test('get errors: unknown artifact, bad version, cross-owner', async () => {
  const db = makeDb();
  const store = createArtifactStore({ db, clock: fixedClock(), idGen: seqId('art') });
  const art = await store.put('owner-a', PAYLOAD);
  await store.put('owner-a', { ...PAYLOAD, artifactId: art.id, title: 'v2' });

  await assert.rejects(async () => store.get('owner-a', 'no-such-id'), (e) => e.code === 'NOT_FOUND');
  await assert.rejects(async () => store.get('owner-a', art.id, { version: 99 }), (e) => e.code === 'NOT_FOUND');
  await assert.rejects(async () => store.get('owner-a', art.id, { version: 'x' }), (e) => e.code === 'CONTRACT_INVALID');
  await assert.rejects(async () => store.get('owner-a', art.id, { version: 0 }), (e) => e.code === 'CONTRACT_INVALID');
  await assert.rejects(async () => store.get('owner-b', art.id), (e) => e.code === 'NOT_FOUND');
  await assert.rejects(async () => store.get('owner-b', art.id, { version: 1 }), (e) => e.code === 'NOT_FOUND');
  await assert.rejects(async () => store.versions('owner-b', art.id), (e) => e.code === 'NOT_FOUND');
});

test('cross-owner writes are rejected as NOT_FOUND', async () => {
  const db = makeDb();
  const store = createArtifactStore({ db, clock: fixedClock(), idGen: seqId('art') });
  const art = await store.put('owner-a', PAYLOAD);
  await assert.rejects(
    async () => store.put('owner-b', { ...PAYLOAD, artifactId: art.id, title: 'hijack' }),
    (e) => e.code === 'NOT_FOUND',
  );
  await assert.rejects(async () => store.delete('owner-b', art.id), (e) => e.code === 'NOT_FOUND');
  const versions = await store.versions('owner-a', art.id);
  assert.equal(versions.length, 1);
});

test('list is owner-scoped and filters by mission', async () => {
  const db = makeDb();
  const store = createArtifactStore({ db, clock: fixedClock(), idGen: seqId('art') });
  const a1 = await store.put('owner-a', { ...PAYLOAD, missionId: 'm1' });
  await store.put('owner-a', { ...PAYLOAD, missionId: 'm2', title: 'm2 工件' });
  await store.put('owner-b', { ...PAYLOAD, missionId: 'm1', title: 'B 的工件' });

  const all = await store.list('owner-a');
  assert.equal(all.length, 2);
  assert.ok(all.every((a) => a.ownerId === 'owner-a'));

  const m1 = await store.list('owner-a', { missionId: 'm1' });
  assert.deepEqual(m1.map((a) => a.id), [a1.id]);

  const none = await store.list('owner-c');
  assert.equal(none.length, 0);
});

test('soft delete preserves version history and only writes events', async () => {
  const db = makeDb();
  const store = createArtifactStore({ db, clock: fixedClock(), idGen: seqId('art') });
  const art = await store.put('owner-a', PAYLOAD);
  await store.put('owner-a', { ...PAYLOAD, artifactId: art.id, title: 'v2' });

  await store.delete('owner-a', art.id);

  await assert.rejects(async () => store.get('owner-a', art.id), (e) => e.code === 'NOT_FOUND');
  const listed = await store.list('owner-a');
  assert.equal(listed.length, 0);

  const versionRows = db.prepare('SELECT version FROM w9_artifact_versions WHERE artifact_id = ?').all(art.id);
  assert.equal(versionRows.length, 2, 'deletion must never erase version rows');

  const events = db.prepare('SELECT * FROM w9_artifact_events WHERE artifact_id = ?').all(art.id);
  assert.equal(events.length, 1);

  await assert.rejects(async () => store.delete('owner-a', art.id), (e) => e.code === 'NOT_FOUND');
});

test('events sink receives artifact lifecycle events with injected clock time', async () => {
  const db = makeDb();
  const { emitted, sink } = eventsRecorder();
  const clock = fixedClock('2026-10-27T11:22:33Z');
  const store = createArtifactStore({ db, clock, idGen: seqId('art'), events: sink });
  const art = await store.put('owner-a', PAYLOAD);

  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].ownerId, 'owner-a');
  assert.equal(emitted[0].objectType, 'artifact');
  assert.equal(emitted[0].objectId, art.id);
  assert.equal(emitted[0].at, '2026-10-27T11:22:33Z');
  assert.equal(typeof emitted[0].type, 'string');
  assert.ok(emitted[0].type.length > 0);
  assert.equal(emitted[0].data.version, 1);
});

test('events sink is optional (default no-op)', async () => {
  const db = makeDb();
  const store = createArtifactStore({ db, clock: fixedClock(), idGen: seqId('art') });
  const art = await store.put('owner-a', PAYLOAD);
  assert.equal(art.version, 1);
});

test('createdAt follows the injected clock, not the wall clock', async () => {
  const db = makeDb();
  const clock = seqClock(T0, 60_000);
  const store = createArtifactStore({ db, clock, idGen: seqId('art') });
  const v1 = await store.put('owner-a', PAYLOAD);
  const v2 = await store.put('owner-a', { ...PAYLOAD, artifactId: v1.id, title: 'next' });
  assert.equal(v1.createdAt, new Date(T0).toISOString());
  assert.equal(v2.createdAt, new Date(T0 + 60_000).toISOString());
  assert.ok(v2.createdAt > v1.createdAt);
});

test('clock and idGen must be injected explicitly', () => {
  const db = makeDb();
  assert.throws(() => createArtifactStore({ db }), Error);
  assert.throws(() => createArtifactStore({ db, clock: fixedClock() }), Error);
});

test('migration w9-1-delivery.sql creates the pinned tables, columns and unique constraint', () => {
  const db = makeDb();
  const columnsOf = (table) => db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);

  for (const col of ['id', 'owner_id', 'mission_id', 'current_version', 'status', 'created_at']) {
    assert.ok(columnsOf('w9_artifacts').includes(col), `w9_artifacts missing ${col}`);
  }
  for (const col of ['artifact_id', 'owner_id', 'version', 'content_hash', 'evidence_json', 'created_at']) {
    assert.ok(columnsOf('w9_artifact_versions').includes(col), `w9_artifact_versions missing ${col}`);
  }
  for (const col of ['id', 'owner_id', 'artifact_id', 'artifact_version', 'actor', 'decision', 'created_at']) {
    assert.ok(columnsOf('w9_acceptances').includes(col), `w9_acceptances missing ${col}`);
  }
  assert.ok(columnsOf('w9_artifact_events').length > 0, 'w9_artifact_events must exist');

  // UNIQUE(artifact_id, version) 钉死：存在 origin='u' 的唯一索引且列恰为 artifact_id+version
  const indexes = db.prepare('PRAGMA index_list(w9_artifact_versions)').all();
  const unique = indexes.filter((i) => i.origin === 'u');
  assert.ok(unique.length > 0, 'w9_artifact_versions needs a UNIQUE index');
  const covered = unique.some((idx) => {
    const cols = db.prepare(`PRAGMA index_info(${idx.name})`).all().map((c) => c.name).sort();
    return cols.length === 2 && cols[0] === 'artifact_id' && cols[1] === 'version';
  });
  assert.ok(covered, 'UNIQUE(artifact_id, version) must be enforced');

  const names = db.prepare("SELECT name FROM _migrations WHERE name LIKE 'w9-%' ORDER BY name").all().map((r) => r.name);
  assert.ok(names.includes('w9-1-delivery.sql'), `expected w9-1-delivery.sql applied, got ${JSON.stringify(names)}`);
});
