// S2D-W13 · M16 projection 接缝补充测试（projection.test.mjs 主规格之外的补强，
// M14「补充组」先例：主规格 RED→GREEN 后加测提覆盖率，不删测试、不放宽校验）。
//
// 覆盖 plan.md M16 明列但主规格未展开的分支与围栏：
//   - projectPlayback 对残缺 VM 的诚实降级与输出深拷贝；
//   - projectAcceptedBenefit 的围栏顺序与诚实排除原因（W9 db-gate 字面规则：
//     仅 MEDIUM/LOW FAIL 不阻断；verdict 缺失 fail-closed）；
//   - projectModelProvenance 的降级阶梯（mock+有证据=PROVISIONAL、stale 无证据
//     =UNKNOWN、空白模型=MODEL_MISSING、证据不回写声明）；
//   - R-7/红线 4 源码自审：projection.mjs 无 db/写表/墙钟/env/外呼（context-seams
//     .test.mjs:408 先例）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  projectPreviewTimeline,
  projectPlayback,
  projectAcceptedBenefit,
  projectModelProvenance,
} from '../../../../scripts/agentic/integration/projection.mjs';

const MODULE_PATH = join(
  fileURLToPath(new URL('../../../../scripts/agentic/integration/', import.meta.url)),
  'projection.mjs',
);

function minimalPreview() {
  return {
    missionId: 'm',
    version: 1,
    storyboard: [{ at: 0, actor: 'user', text: 't' }],
    reel: { durationSec: 5, tracks: ['bgm'] },
    narration: '一句。',
    samples: [],
    shape: { kind: 'storyboard', title: 'T', blocks: [{ type: 'outline', text: 'a' }] },
  };
}

// ---------------- projectPlayback：残缺 VM 诚实降级 + 深拷贝 ----------------

test('playback degrades honestly on a broken view-model instead of inventing values', () => {
  assert.deepEqual(projectPlayback(null), { durationSec: null, tracks: [] });
  assert.deepEqual(projectPlayback({}), { durationSec: null, tracks: [] });
  assert.deepEqual(projectPlayback({ durationSec: '12', tracks: 'bgm' }), { durationSec: null, tracks: [] });
});

test('playback output never aliases the view-model', () => {
  const vm = projectPreviewTimeline(minimalPreview(), null);
  const playback = projectPlayback(vm);
  playback.tracks.push('tampered');
  assert.deepEqual(vm.tracks, ['bgm']);
});

test('vm.source is a copy, not a reference to the caller metadata', () => {
  const meta = { previewId: 'p1', revision: 1 };
  const vm = projectPreviewTimeline(minimalPreview(), meta);
  vm.source.previewId = 'tampered';
  assert.equal(meta.previewId, 'p1');
});

// ---------------- projectAcceptedBenefit：围栏顺序与诚实原因 ----------------

test('benefit projection accepts VERIFIED verdicts whose only failures are MEDIUM/LOW (W9 literal rule)', () => {
  const result = projectAcceptedBenefit([{
    owner: 'o1',
    acceptance: { actor: 'user:o1', decision: 'accepted', artifactVersion: 9 },
    verdict: { overall: 'VERIFIED', checks: [{ severity: 'MEDIUM', status: 'FAIL' }] },
  }], 'o1');
  assert.equal(result.count, 1);
  assert.deepEqual(result.included, [{ artifactVersion: 9 }]);
});

test('benefit projection reports an honest reason per excluded row, never silent drops', () => {
  const result = projectAcceptedBenefit([
    { owner: 'o2', acceptance: { actor: 'user:o2', decision: 'accepted', artifactVersion: 1 }, verdict: { overall: 'VERIFIED', checks: [] } },
    { owner: 'o1', acceptance: { actor: 'agent:x', decision: 'accepted', artifactVersion: 2 }, verdict: { overall: 'VERIFIED', checks: [] } },
    { owner: 'o1', acceptance: { actor: 'user:o1', decision: 'revision_requested', artifactVersion: 3 }, verdict: { overall: 'VERIFIED', checks: [] } },
    { owner: 'o1', acceptance: { actor: 'user:o1', decision: 'accepted', artifactVersion: 4 }, verdict: null },
    { owner: 'o1', acceptance: { actor: 'user:o1', decision: 'accepted', artifactVersion: 5 }, verdict: { overall: 'VERIFIED', checks: [{ severity: 'HIGH', status: 'FAIL' }] } },
    null,
  ], 'o1');
  assert.equal(result.count, 0);
  assert.deepEqual(result.included, []);
  const reasons = result.excluded.map((row) => row.reason);
  assert.deepEqual(reasons, [
    'OWNER_MISMATCH',
    'ACTOR_NOT_USER_OWNER',
    'DECISION_NOT_ACCEPTED:revision_requested',
    'VERDICT_MISSING',
    'VERDICT_BLOCKING',
    'OWNER_MISMATCH',
  ]);
  const blocking = result.excluded.find((row) => row.reason === 'VERDICT_BLOCKING');
  assert.equal(blocking.unknownCount, 0);
  assert.equal(blocking.highFailCount, 1);
});

test('benefit projection with no ownerId or non-array input counts zero, never throws', () => {
  assert.equal(projectAcceptedBenefit([], null).count, 0);
  assert.equal(projectAcceptedBenefit(null, 'o1').count, 0);
  assert.deepEqual(projectAcceptedBenefit(undefined, 'o1').included, []);
});

// ---------------- projectModelProvenance：降级阶梯 ----------------

test('provenance: mock source with real-looking evidence stays PROVISIONAL, not UNKNOWN', () => {
  const result = projectModelProvenance({
    actor: 'a', resolvedModel: 'glm-5.3', modelSource: 'mock',
    evidence: { runId: 'r1', spanId: 's1' },
  });
  assert.equal(result.status, 'PROVISIONAL');
  assert.deepEqual(result.reasons, ['MODEL_SOURCE_UNVERIFIABLE:mock']);
});

test('provenance: local runtime truth with consistent evidence is VERIFIED (W10 verifiable set)', () => {
  const result = projectModelProvenance({
    actor: 'a', resolvedModel: 'glm-5.3', modelSource: 'local',
    evidence: [{ runId: 'r1', model: 'glm-5.3' }],
  });
  assert.equal(result.status, 'VERIFIED');
  assert.deepEqual(result.reasons, []);
});

test('provenance: blank resolved model is MODEL_MISSING even with gateway source and evidence', () => {
  const result = projectModelProvenance({ actor: 'a', resolvedModel: '  ', modelSource: 'gateway', evidence: { runId: 'r1' } });
  assert.equal(result.status, 'UNKNOWN');
  assert.deepEqual(result.reasons, ['MODEL_MISSING']);
});

test('provenance: null/undefined input degrades to UNKNOWN, never throws', () => {
  for (const input of [null, undefined, {}]) {
    const result = projectModelProvenance(input);
    assert.equal(result.status, 'UNKNOWN');
    assert.equal(result.resolvedModel, null);
    assert.deepEqual(result.reasons, ['MODEL_MISSING']);
  }
});

test('provenance: evidence naming a different model than the declaration is a conflict', () => {
  const result = projectModelProvenance({
    actor: 'a', resolvedModel: 'glm-5.3', modelSource: 'gateway',
    evidence: { runId: 'r1', model: 'gpt-6.1-sol' },
  });
  assert.equal(result.status, 'PROVISIONAL');
  assert.ok(result.reasons.includes('EVIDENCE_CONFLICT'));
});

test('provenance: stale without any evidence stays UNKNOWN (missing evidence outranks degradation)', () => {
  const result = projectModelProvenance({ actor: 'a', resolvedModel: 'glm-5.3', modelSource: 'gateway', stale: true });
  assert.equal(result.status, 'UNKNOWN');
  assert.ok(result.reasons.includes('EVIDENCE_MISSING'));
  assert.ok(result.reasons.includes('EVIDENCE_STALE'));
});

test('provenance: opaque evidence entries cannot crash the projection nor fabricate a conflict', () => {
  const result = projectModelProvenance({
    actor: 'a', resolvedModel: 'glm-5.3', modelSource: 'gateway',
    evidence: ['opaque-string', { runId: 'r1' }],
  });
  assert.equal(result.status, 'VERIFIED');
  assert.deepEqual(result.reasons, []);
});

test('provenance: returned evidence is a copy — mutating it never touches the input', () => {
  const evidence = { runId: 'r1', model: 'glm-5.3' };
  const result = projectModelProvenance({ actor: 'a', resolvedModel: 'glm-5.3', modelSource: 'gateway', evidence });
  result.evidence.runId = 'tampered';
  assert.equal(evidence.runId, 'r1');
});

// ---------------- R-7/红线 4 源码自审：projection.mjs 无 db/写表/墙钟/外呼 ----------------

test('source fence: projection.mjs never opens a db, writes a table, reads a wall clock or env, or calls out', () => {
  const source = readFileSync(MODULE_PATH, 'utf8');
  assert.ok(!source.includes('Date.now('), 'no wall clock reads');
  assert.ok(!source.includes('new Date('), 'no wall clock construction');
  assert.ok(!source.includes('process.env'), 'no environment reads');
  assert.ok(!/\bfrom '\.\.\/(db|engine|mission|autonomy|runtime|bridge|perception)\//.test(source), 'no flow-internal write-side imports (db/engine/mission/autonomy/runtime/bridge/perception)');
  assert.ok(!source.includes('prepare('), 'no sql statements');
  assert.ok(!/\b(INSERT INTO|UPDATE |DELETE FROM|CREATE TABLE)/.test(source), 'no table writes');
  assert.ok(!/\b(fetch\(|http\.|https\.|child_process|spawn|exec)/.test(source), 'no external calls');
});
