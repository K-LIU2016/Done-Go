// W9 M1 delivery-domain · acceptance 单测（TDD RED 先行）
//
// 本文件是 `scripts/agentic/delivery/acceptance.mjs` 的接口规约：
//   createAcceptance({ db, clock, idGen, events }) → { record(ownerId, artifactId, opts) }
//   record(ownerId, artifactId, { actor, decision, comment?, version? })
//   - decision 动词枚举：'accept' | 'revise' | 'reject'
//     → 落库/返回对象映射为 acceptance.schema.json 的 accepted | revision_requested | rejected。
//   - version 缺省绑定 artifact 当前最新版本；显式 version ≠ 最新 → CONFLICT。
//   - 返回对象必须通过 acceptance.schema.json（id, artifactId, actor, decision, createdAt[, comment]）。
// 钉死约定（brief 裁决③ + README 状态机）：
//   - 只有 status='ready'（或 revision_requested 产生新版本后的 ready）可验收；
//     对 generating / accepted / rejected 再验收 → CONFLICT（非法 transition）。
//   - actor 前缀约定：'user:*' 为用户 actor；'agent:*' 为 agent 自报 → FORBIDDEN（用户验收≠agent 自报成功）。
//   - revise 必须带非空 comment；reject/accept 的 comment 可选。
//   - accepted / rejected 对新 put 关闭版本链（CONFLICT）；revision_requested 允许新版本继续。
//   - w9_acceptances 行必须记录 owner_id 与 artifact_version（对外对象保持冻结 schema 纯净）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openAgenticDb, migrate } from '../../../../scripts/agentic/db/index.mjs';
import { loadSchema, validate } from '../../../../scripts/agentic/contracts.mjs';
import { createArtifactStore } from '../../../../scripts/agentic/delivery/artifact-store.mjs';
import { createAcceptance } from '../../../../scripts/agentic/delivery/acceptance.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../../..');
const contractDir = join(root, 'contracts/agentic');
const acceptanceSchema = loadSchema('acceptance.schema.json', contractDir);

const T0 = Date.parse('2026-10-27T10:00:00Z');
const seqClock = (stepMs = 1000) => {
  let n = 0;
  return { now: () => new Date(T0 + n++ * stepMs).toISOString() };
};
const seqId = (prefix) => {
  let n = 0;
  return () => `${prefix}-${++n}`;
};

function makeSetup(status = 'ready') {
  const db = openAgenticDb(':memory:');
  migrate(db, join(root, 'scripts/agentic/db/migrations'));
  const clock = seqClock();
  const store = createArtifactStore({ db, clock, idGen: seqId('art') });
  const acceptance = createAcceptance({ db, clock, idGen: seqId('acc') });
  return { db, clock, store, acceptance };
}

const PAYLOAD = {
  missionId: 'm1',
  type: 'report',
  title: '研究报告',
  location: '/artifacts/r1.md',
  status: 'ready',
  evidence: [{ type: 'dod-check', title: 'DoD', detail: '含 3 节', verified: true }],
};

async function readyArtifact(store, ownerId = 'owner-a') {
  return store.put(ownerId, PAYLOAD);
}

test('accept on a ready artifact records a schema-valid acceptance bound to the latest version', async () => {
  const { db, clock, store, acceptance } = makeSetup();
  const art = await readyArtifact(store);
  const record = await acceptance.record('owner-a', art.id, { actor: 'user:alice', decision: 'accept', comment: '不错' });

  assert.equal(record.decision, 'accepted');
  assert.equal(record.artifactId, art.id);
  assert.equal(record.actor, 'user:alice');
  assert.equal(record.createdAt, clock.now());
  assert.equal(validate(record, acceptanceSchema, { schemaDir: contractDir }).valid, true);

  const after = await store.get('owner-a', art.id);
  assert.equal(after.status, 'accepted');

  const row = db.prepare('SELECT owner_id, artifact_version, mission_id, decision FROM w9_acceptances WHERE id = ?').get(record.id);
  assert.equal(row.owner_id, 'owner-a');
  assert.equal(row.artifact_version, art.version);
  assert.equal(row.mission_id, 'm1');
  assert.equal(row.decision, 'accepted');
});

test('accepting a generating artifact is an illegal transition (CONFLICT)', async () => {
  const { store, acceptance } = makeSetup();
  const art = await store.put('owner-a', { ...PAYLOAD, status: 'generating' });
  await assert.rejects(
    async () => acceptance.record('owner-a', art.id, { actor: 'user:alice', decision: 'accept' }),
    (e) => e.code === 'CONFLICT',
  );
});

test('reject is terminal: no re-accept, no re-reject, no new versions', async () => {
  const { store, acceptance } = makeSetup();
  const art = await readyArtifact(store);
  const record = await acceptance.record('owner-a', art.id, { actor: 'user:alice', decision: 'reject', comment: '方向错了' });
  assert.equal(record.decision, 'rejected');
  assert.equal((await store.get('owner-a', art.id)).status, 'rejected');

  await assert.rejects(
    async () => acceptance.record('owner-a', art.id, { actor: 'user:alice', decision: 'accept' }),
    (e) => e.code === 'CONFLICT',
  );
  await assert.rejects(
    async () => acceptance.record('owner-a', art.id, { actor: 'user:alice', decision: 'reject' }),
    (e) => e.code === 'CONFLICT',
  );
  await assert.rejects(
    async () => store.put('owner-a', { ...PAYLOAD, artifactId: art.id, title: '试图覆盖' }),
    (e) => e.code === 'CONFLICT',
  );
});

test('accepted artifacts reject further puts until a revision is requested (no version overwrite)', async () => {
  const { store, acceptance } = makeSetup();
  const art = await readyArtifact(store);
  await acceptance.record('owner-a', art.id, { actor: 'user:alice', decision: 'accept' });
  await assert.rejects(
    async () => store.put('owner-a', { ...PAYLOAD, artifactId: art.id, title: '悄悄加一版' }),
    (e) => e.code === 'CONFLICT',
  );
});

test('revise requires a comment and allows a new version which can then be accepted', async () => {
  const { db, store, acceptance } = makeSetup();
  const art = await readyArtifact(store);

  await assert.rejects(
    async () => acceptance.record('owner-a', art.id, { actor: 'user:alice', decision: 'revise' }),
    (e) => e.code === 'CONTRACT_INVALID',
  );
  await assert.rejects(
    async () => acceptance.record('owner-a', art.id, { actor: 'user:alice', decision: 'revise', comment: '' }),
    (e) => e.code === 'CONTRACT_INVALID',
  );

  const record = await acceptance.record('owner-a', art.id, { actor: 'user:alice', decision: 'revise', comment: '第二节展开' });
  assert.equal(record.decision, 'revision_requested');
  assert.equal(record.comment, '第二节展开');
  assert.equal((await store.get('owner-a', art.id)).status, 'revision_requested');

  const v2 = await store.put('owner-a', { ...PAYLOAD, artifactId: art.id, title: 'v2 按意见修改' });
  assert.equal(v2.version, 2);
  assert.equal(v2.status, 'ready');

  const accepted = await acceptance.record('owner-a', art.id, { actor: 'user:alice', decision: 'accept' });
  assert.equal(accepted.decision, 'accepted');
  const row = db.prepare('SELECT artifact_version FROM w9_acceptances WHERE id = ?').get(accepted.id);
  assert.equal(row.artifact_version, 2, 'acceptance after revise must bind to the new latest version');
});

test('acceptance must target the latest version (CONFLICT on stale version)', async () => {
  const { store, acceptance } = makeSetup();
  const art = await readyArtifact(store);
  await store.put('owner-a', { ...PAYLOAD, artifactId: art.id, title: 'v2' });

  await assert.rejects(
    async () => acceptance.record('owner-a', art.id, { actor: 'user:alice', decision: 'accept', version: 1 }),
    (e) => e.code === 'CONFLICT',
  );
});

test('explicit acceptance of the current latest version is allowed', async () => {
  const { store, acceptance } = makeSetup();
  const art = await readyArtifact(store);
  const record = await acceptance.record('owner-a', art.id, { actor: 'user:alice', decision: 'accept', version: art.version });
  assert.equal(record.decision, 'accepted');
});

test('agent self-reported actors are FORBIDDEN for every decision', async () => {
  const { store, acceptance } = makeSetup();
  const art = await readyArtifact(store);
  for (const decision of ['accept', 'revise', 'reject']) {
    await assert.rejects(
      async () => acceptance.record('owner-a', art.id, { actor: 'agent:writer-1', decision, comment: 'c' }),
      (e) => e.code === 'FORBIDDEN',
      `agent actor must not ${decision}`,
    );
  }
});

test('empty or missing actor is contract-invalid', async () => {
  const { store, acceptance } = makeSetup();
  const art = await readyArtifact(store);
  await assert.rejects(
    async () => acceptance.record('owner-a', art.id, { actor: '', decision: 'accept' }),
    (e) => e.code === 'CONTRACT_INVALID',
  );
});

test('unknown decision verbs are contract-invalid', async () => {
  const { store, acceptance } = makeSetup();
  const art = await readyArtifact(store);
  await assert.rejects(
    async () => acceptance.record('owner-a', art.id, { actor: 'user:alice', decision: 'love' }),
    (e) => e.code === 'CONTRACT_INVALID',
  );
});

test('cross-owner acceptance is NOT_FOUND and leaves no rows', async () => {
  const { db, store, acceptance } = makeSetup();
  const art = await readyArtifact(store);
  await assert.rejects(
    async () => acceptance.record('owner-b', art.id, { actor: 'user:bob', decision: 'accept' }),
    (e) => e.code === 'NOT_FOUND',
  );
  await assert.rejects(
    async () => acceptance.record('owner-b', 'no-such-id', { actor: 'user:bob', decision: 'accept' }),
    (e) => e.code === 'NOT_FOUND',
  );
  const rows = db.prepare('SELECT COUNT(*) AS n FROM w9_acceptances').get();
  assert.equal(rows.n, 0);
});

test('decision events reach the injected events sink', async () => {
  const db = openAgenticDb(':memory:');
  migrate(db, join(root, 'scripts/agentic/db/migrations'));
  const clock = seqClock();
  const emitted = [];
  const events = { emit: (evt) => emitted.push(evt) };
  const store = createArtifactStore({ db, clock, idGen: seqId('art') });
  const acceptance = createAcceptance({ db, clock, idGen: seqId('acc'), events });
  const art = await store.put('owner-a', PAYLOAD);

  await acceptance.record('owner-a', art.id, { actor: 'user:alice', decision: 'reject', comment: '不要' });
  const rejection = emitted.find((e) => e.objectType === 'acceptance');
  assert.ok(rejection, 'rejection must emit an event (learning signal)');
  assert.equal(rejection.ownerId, 'owner-a');
  assert.equal(rejection.data.decision, 'rejected');
});
