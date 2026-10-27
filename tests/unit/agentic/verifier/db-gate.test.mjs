// W9 M2 verifier-domain · db-gate 单测（TDD RED 先行）
//
// 本文件是 `scripts/agentic/verifier/db-gate.mjs` 的接口规约：
//   dbVerdictGate(db, ownerId) → async (artifactId, version) => { blocking, unknownCount, highFailCount }
//   - 阻断规则（plan M2-4 钉死）：该 (artifactId, version) 的最新 verdict 中
//     存在 status='UNKNOWN' 的 check 或 status='FAIL' 且 severity='HIGH' 的 check → blocking=true。
//     只有 MEDIUM/LOW FAIL 不阻断（按 plan 字面；M4 组合测试只用 UNKNOWN/HIGH 场景）。
//   - fail closed：没有任何 verdict（含跨 owner、版本不匹配）→ blocking=true。
//   - 同 (artifactId, version) 多次核验取最新一条（later ranAt / 更晚写入者胜）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openAgenticDb, migrate } from '../../../../scripts/agentic/db/index.mjs';
import { saveVerdict } from '../../../../scripts/agentic/verifier/verdict.mjs';
import { dbVerdictGate } from '../../../../scripts/agentic/verifier/db-gate.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../../..');

function makeDb() {
  const db = openAgenticDb(':memory:');
  migrate(db, join(root, 'scripts/agentic/db/migrations'));
  return db;
}

const verdict = (checks, over = 'UNKNOWN', ranAt = '2026-10-27T10:00:00Z') => ({
  artifactId: 'art-1', version: 1, overall: over, checks, ranAt,
});
const check = (kind, status, severity) => ({ kind, ref: 'r', status, severity, reason: '' });

test('an all-PASS verdict does not block', async () => {
  const db = makeDb();
  saveVerdict(db, 'owner-a', verdict([check('dod-item', 'PASS', 'LOW')], 'VERIFIED'));
  const gate = dbVerdictGate(db, 'owner-a');
  assert.deepEqual(await gate('art-1', 1), { blocking: false, unknownCount: 0, highFailCount: 0 });
});

test('any UNKNOWN check blocks and is counted', async () => {
  const db = makeDb();
  saveVerdict(db, 'owner-a', verdict([
    check('dod-item', 'PASS', 'LOW'),
    check('citation', 'UNKNOWN', 'MEDIUM'),
    check('command-result', 'UNKNOWN', 'LOW'),
  ]));
  const gate = dbVerdictGate(db, 'owner-a');
  const summary = await gate('art-1', 1);
  assert.equal(summary.blocking, true);
  assert.equal(summary.unknownCount, 2);
  assert.equal(summary.highFailCount, 0);
});

test('a HIGH FAIL blocks and is counted', async () => {
  const db = makeDb();
  saveVerdict(db, 'owner-a', verdict([check('command-result', 'FAIL', 'HIGH')], 'FAILED'));
  const gate = dbVerdictGate(db, 'owner-a');
  const summary = await gate('art-1', 1);
  assert.equal(summary.blocking, true);
  assert.equal(summary.unknownCount, 0);
  assert.equal(summary.highFailCount, 1);
});

test('mixed UNKNOWN and HIGH FAIL are both counted', async () => {
  const db = makeDb();
  saveVerdict(db, 'owner-a', verdict([
    check('citation', 'UNKNOWN', 'MEDIUM'),
    check('injection-marker', 'FAIL', 'HIGH'),
    check('command-result', 'FAIL', 'HIGH'),
  ]));
  const summary = await dbVerdictGate(db, 'owner-a')('art-1', 1);
  assert.equal(summary.blocking, true);
  assert.equal(summary.unknownCount, 1);
  assert.equal(summary.highFailCount, 2);
});

test('MEDIUM/LOW FAIL alone does not block (plan-literal rule)', async () => {
  const db = makeDb();
  saveVerdict(db, 'owner-a', verdict([check('citation', 'FAIL', 'MEDIUM')], 'FAILED'));
  const summary = await dbVerdictGate(db, 'owner-a')('art-1', 1);
  assert.equal(summary.blocking, false);
});

test('no verdict at all fails closed', async () => {
  const db = makeDb();
  const summary = await dbVerdictGate(db, 'owner-a')('art-1', 1);
  assert.equal(summary.blocking, true);
});

test('verdicts of another owner or another version never unblock', async () => {
  const db = makeDb();
  saveVerdict(db, 'owner-a', verdict([check('dod-item', 'PASS', 'LOW')], 'VERIFIED'));
  const ownerGate = dbVerdictGate(db, 'owner-b');
  assert.equal((await ownerGate('art-1', 1)).blocking, true, 'cross-owner must fail closed');
  const ownGate = dbVerdictGate(db, 'owner-a');
  assert.equal((await ownGate('art-1', 2)).blocking, true, 'verdict for v1 must not unblock v2');
});

test('re-verification wins: the latest verdict replaces an earlier blocking one', async () => {
  const db = makeDb();
  saveVerdict(db, 'owner-a', verdict([check('citation', 'UNKNOWN', 'MEDIUM')], 'UNKNOWN', '2026-10-27T10:00:00Z'));
  saveVerdict(db, 'owner-a', verdict([check('citation', 'PASS', 'LOW')], 'VERIFIED', '2026-10-27T11:00:00Z'));
  const gate = dbVerdictGate(db, 'owner-a');
  assert.deepEqual(await gate('art-1', 1), { blocking: false, unknownCount: 0, highFailCount: 0 });

  const db2 = makeDb();
  saveVerdict(db2, 'owner-a', verdict([check('citation', 'PASS', 'LOW')], 'VERIFIED', '2026-10-27T10:00:00Z'));
  saveVerdict(db2, 'owner-a', verdict([check('citation', 'UNKNOWN', 'MEDIUM')], 'UNKNOWN', '2026-10-27T11:00:00Z'));
  assert.equal((await dbVerdictGate(db2, 'owner-a')('art-1', 1)).blocking, true, 'a later UNKNOWN must re-block');
});
