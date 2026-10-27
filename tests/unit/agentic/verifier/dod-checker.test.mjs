// W9 M2 verifier-domain · dod-checker 单测（TDD RED 先行）
//
// 本文件是 `scripts/agentic/verifier/dod-checker.mjs` 的接口规约：
//   checkDod(artifact, dod) → checks[]
//   - dod: string[]（每条为可检查的 DoD 验收标准）。
//   - 每条 DoD 产生一个 check：{ kind: 'dod-item', ref: <DoD 原文>, status, severity, reason }。
//   - 覆盖规则（钉死）：当且仅当存在 evidence e 满足
//       e.type === 'dod-check' && e.verified === true && e.detail === <DoD 原文>
//     时该条为 PASS；否则 status === 'UNKNOWN'（缺项不得升级为 VERIFIED，brief 裁决④）。
//   - dod 非数组或元素非字符串 → 抛 CONTRACT_INVALID。
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkDod } from '../../../../scripts/agentic/verifier/dod-checker.mjs';

const artifactWith = (evidence) => ({
  id: 'art-1', ownerId: 'owner-a', missionId: 'm1', version: 1,
  type: 'report', status: 'ready', title: '报告', location: '/a.md', createdAt: '2026-10-27T10:00:00Z',
  evidence,
});

test('a DoD item covered by verified dod-check evidence passes', () => {
  const artifact = artifactWith([{ type: 'dod-check', title: 'DoD1', detail: '报告含 3 节', verified: true }]);
  const checks = checkDod(artifact, ['报告含 3 节']);
  assert.equal(checks.length, 1);
  assert.equal(checks[0].kind, 'dod-item');
  assert.equal(checks[0].ref, '报告含 3 节');
  assert.equal(checks[0].status, 'PASS');
});

test('a DoD item with no matching evidence stays UNKNOWN', () => {
  const artifact = artifactWith([]);
  const checks = checkDod(artifact, ['报告含 3 节']);
  assert.equal(checks[0].status, 'UNKNOWN');
});

test('dod-check evidence that is not verified does not cover the item', () => {
  const artifact = artifactWith([
    { type: 'dod-check', title: 'DoD1', detail: '报告含 3 节', verified: false },
  ]);
  assert.equal(checkStatus(checkDod(artifact, ['报告含 3 节'])), 'UNKNOWN');

  const unverifiedAbsent = artifactWith([{ type: 'dod-check', title: 'DoD1', detail: '报告含 3 节' }]);
  assert.equal(checkStatus(checkDod(unverifiedAbsent, ['报告含 3 节'])), 'UNKNOWN');
});

test('a verified dod-check with different detail text does not cover the item', () => {
  const artifact = artifactWith([{ type: 'dod-check', title: 'DoD1', detail: '完全另一条', verified: true }]);
  assert.equal(checkStatus(checkDod(artifact, ['报告含 3 节'])), 'UNKNOWN');
});

test('every DoD item yields exactly one check, in order', () => {
  const artifact = artifactWith([
    { type: 'dod-check', title: 'DoD1', detail: 'A 标准', verified: true },
    { type: 'dod-check', title: 'DoD2', detail: 'C 标准', verified: true },
  ]);
  const checks = checkDod(artifact, ['A 标准', 'B 标准', 'C 标准']);
  assert.deepEqual(checks.map((c) => c.ref), ['A 标准', 'B 标准', 'C 标准']);
  assert.deepEqual(checks.map((c) => c.status), ['PASS', 'UNKNOWN', 'PASS']);
});

test('empty dod yields no checks; only dod-check evidence participates', () => {
  const artifact = artifactWith([
    { type: 'test-run', title: 't', detail: '报告含 3 节', verified: true },
  ]);
  assert.deepEqual(checkDod(artifact, []), []);
  assert.equal(checkStatus(checkDod(artifact, ['报告含 3 节'])), 'UNKNOWN', 'test-run evidence must not cover a DoD item');
});

test('malformed dod input is contract-invalid', () => {
  const artifact = artifactWith([]);
  assert.throws(() => checkDod(artifact, 'not-an-array'), (e) => e.code === 'CONTRACT_INVALID');
  assert.throws(() => checkDod(artifact, ['ok', 42]), (e) => e.code === 'CONTRACT_INVALID');
});

function checkStatus(checks) {
  assert.equal(checks.length, 1);
  return checks[0].status;
}
