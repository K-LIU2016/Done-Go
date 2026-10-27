// W9 M2 verifier-domain · verdict 持久化单测（TDD RED 先行）
//
// 本文件是 `scripts/agentic/verifier/verdict.mjs` 的接口规约：
//   saveVerdict(db, ownerId, verdict, { idGen?, events? } = {}) → 持久化后的 verdict（含 id）
//   - verdict 为 W9 内部结构（冻结契约无此 schema，禁止新增 schema 文件）：
//     { artifactId, version, overall: 'VERIFIED'|'FAILED'|'UNKNOWN',
//       checks: [{ kind: 'dod-item'|'citation'|'command-result'|'injection-marker',
//                  ref, status: 'PASS'|'FAIL'|'UNKNOWN', severity: 'HIGH'|'MEDIUM'|'LOW', reason }],
//       ranAt }
//   - 写 w9_verdicts（1 行）与 w9_verdict_checks（每 check 1 行）；手工守护形状，坏形状 → CONTRACT_INVALID。
//   - events 注入时 emit({ type, ownerId, objectType: 'verdict', objectId, at: ranAt, data })。
import test from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openAgenticDb, migrate } from '../../../../scripts/agentic/db/index.mjs';
import { saveVerdict } from '../../../../scripts/agentic/verifier/verdict.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../../..');

function makeDb() {
  const db = openAgenticDb(':memory:');
  migrate(db, join(root, 'scripts/agentic/db/migrations'));
  return db;
}

const VERDICT = {
  artifactId: 'art-1',
  version: 2,
  overall: 'VERIFIED',
  checks: [
    { kind: 'dod-item', ref: '含 3 节', status: 'PASS', severity: 'LOW', reason: 'covered' },
    { kind: 'citation', ref: '来源列表', status: 'PASS', severity: 'LOW', reason: 'verified' },
  ],
  ranAt: '2026-10-27T10:00:00Z',
};

test('persists one verdict row and one row per check, returning an id', () => {
  const db = makeDb();
  const saved = saveVerdict(db, 'owner-a', VERDICT);
  assert.ok(typeof saved.id === 'string' && saved.id.length > 0);
  assert.equal(saved.overall, 'VERIFIED');

  const verdictRow = db.prepare('SELECT * FROM w9_verdicts WHERE id = ?').get(saved.id);
  assert.equal(verdictRow.owner_id, 'owner-a');
  assert.equal(verdictRow.artifact_id, 'art-1');
  assert.equal(verdictRow.artifact_version, 2);
  assert.equal(verdictRow.overall, 'VERIFIED');
  assert.equal(verdictRow.ran_at, '2026-10-27T10:00:00Z');

  const checkRows = db.prepare('SELECT * FROM w9_verdict_checks WHERE verdict_id = ? ORDER BY rowid').all(saved.id);
  assert.equal(checkRows.length, 2);
  assert.equal(checkRows[0].kind, 'dod-item');
  assert.equal(checkRows[0].status, 'PASS');
  assert.equal(checkRows[1].kind, 'citation');
});

test('invalid overall values are rejected', () => {
  const db = makeDb();
  assert.throws(() => saveVerdict(db, 'owner-a', { ...VERDICT, overall: 'MAYBE' }), (e) => e.code === 'CONTRACT_INVALID');
  assert.throws(() => saveVerdict(db, 'owner-a', { ...VERDICT, overall: undefined }), (e) => e.code === 'CONTRACT_INVALID');
});

test('malformed checks are rejected', () => {
  const db = makeDb();
  assert.throws(
    () => saveVerdict(db, 'owner-a', { ...VERDICT, checks: [{ kind: 'dod-item', ref: 'x' }] }),
    (e) => e.code === 'CONTRACT_INVALID',
  );
  assert.throws(
    () => saveVerdict(db, 'owner-a', { ...VERDICT, checks: [{ kind: 'weird', ref: 'x', status: 'PASS', severity: 'LOW', reason: '' }] }),
    (e) => e.code === 'CONTRACT_INVALID',
  );
  assert.throws(
    () => saveVerdict(db, 'owner-a', { ...VERDICT, checks: [{ kind: 'dod-item', ref: 'x', status: 'SO_SO', severity: 'LOW', reason: '' }] }),
    (e) => e.code === 'CONTRACT_INVALID',
  );
  assert.throws(
    () => saveVerdict(db, 'owner-a', { ...VERDICT, checks: [{ kind: 'dod-item', ref: 'x', status: 'PASS', severity: 'EXTREME', reason: '' }] }),
    (e) => e.code === 'CONTRACT_INVALID',
  );
});

test('missing artifact identity or ranAt is rejected', () => {
  const db = makeDb();
  assert.throws(() => saveVerdict(db, 'owner-a', { ...VERDICT, artifactId: '' }), (e) => e.code === 'CONTRACT_INVALID');
  assert.throws(() => saveVerdict(db, 'owner-a', { ...VERDICT, version: 0 }), (e) => e.code === 'CONTRACT_INVALID');
  assert.throws(() => saveVerdict(db, 'owner-a', { ...VERDICT, ranAt: 'not-a-time' }), (e) => e.code === 'CONTRACT_INVALID');
});

test('emits a verdict event through the injected sink', () => {
  const db = makeDb();
  const emitted = [];
  const saved = saveVerdict(db, 'owner-a', VERDICT, { events: { emit: (evt) => emitted.push(evt) } });
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].ownerId, 'owner-a');
  assert.equal(emitted[0].objectType, 'verdict');
  assert.equal(emitted[0].objectId, saved.id);
  assert.equal(emitted[0].at, VERDICT.ranAt);
});

test('injected idGen supplies ids; without it a server-side id is still generated', () => {
  const db = makeDb();
  let n = 0;
  const withGen = saveVerdict(db, 'owner-a', VERDICT, { idGen: () => `vd-${++n}` });
  assert.equal(withGen.id, 'vd-1');
  const withoutGen = saveVerdict(db, 'owner-a', { ...VERDICT, ranAt: '2026-10-27T10:01:00Z' });
  assert.ok(typeof withoutGen.id === 'string' && withoutGen.id.length > 0);
});
