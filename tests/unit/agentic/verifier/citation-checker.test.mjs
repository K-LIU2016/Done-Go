// W9 M2 verifier-domain · citation-checker 单测（TDD RED 先行）
//
// 本文件是 `scripts/agentic/verifier/citation-checker.mjs` 的接口规约：
//   checkCitations(artifact) → checks[]
//   - 只检查 evidence 中 type === 'citation-list' 的条目；其他 evidence 类型忽略。
//   - 每个 citation-list 条目一个 check：{ kind: 'citation', ref: <evidence.title>, status, severity, reason }。
//   - PASS 当且仅当：uri 为非空字符串 && verified === true && detail 为非空字符串。
//     缺 uri（null/undefined/空）/ 未核验（verified !== true）/ 缺 detail → UNKNOWN
//     （brief 裁决④：引用/证据完整性缺失不得升级为 VERIFIED；可达性判定由注入 checker 扩展，W13 组装）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkCitations } from '../../../../scripts/agentic/verifier/citation-checker.mjs';

const artifactWith = (evidence) => ({
  id: 'art-1', ownerId: 'owner-a', missionId: 'm1', version: 1,
  type: 'report', status: 'ready', title: '报告', location: '/a.md', createdAt: '2026-10-27T10:00:00Z',
  evidence,
});

test('a citation-list with uri, detail and verified=true passes', () => {
  const artifact = artifactWith([
    { type: 'citation-list', title: '来源列表', uri: '/evidence/citations.json', detail: '12 个来源，7 个保留', verified: true },
  ]);
  const checks = checkCitations(artifact);
  assert.equal(checks.length, 1);
  assert.equal(checks[0].kind, 'citation');
  assert.equal(checks[0].ref, '来源列表');
  assert.equal(checks[0].status, 'PASS');
});

test('citation-list with null or missing uri stays UNKNOWN', () => {
  const nullUri = artifactWith([{ type: 'citation-list', title: 's', uri: null, detail: 'd', verified: true }]);
  assert.equal(statusOf(checkCitations(nullUri)), 'UNKNOWN');
  const noUri = artifactWith([{ type: 'citation-list', title: 's', detail: 'd', verified: true }]);
  assert.equal(statusOf(checkCitations(noUri)), 'UNKNOWN');
  const emptyUri = artifactWith([{ type: 'citation-list', title: 's', uri: '', detail: 'd', verified: true }]);
  assert.equal(statusOf(checkCitations(emptyUri)), 'UNKNOWN');
});

test('citation-list that is not verified stays UNKNOWN', () => {
  const explicit = artifactWith([{ type: 'citation-list', title: 's', uri: '/c', detail: 'd', verified: false }]);
  assert.equal(statusOf(checkCitations(explicit)), 'UNKNOWN');
  const absent = artifactWith([{ type: 'citation-list', title: 's', uri: '/c', detail: 'd' }]);
  assert.equal(statusOf(checkCitations(absent)), 'UNKNOWN');
});

test('citation-list without detail stays UNKNOWN', () => {
  const artifact = artifactWith([{ type: 'citation-list', title: 's', uri: '/c', verified: true }]);
  assert.equal(statusOf(checkCitations(artifact)), 'UNKNOWN');
});

test('artifacts without citation-list evidence yield no citation checks', () => {
  assert.deepEqual(checkCitations(artifactWith([])), []);
  const other = artifactWith([{ type: 'test-run', title: 't', uri: '/t', detail: 'd', verified: true }]);
  assert.deepEqual(checkCitations(other), []);
});

test('every citation-list entry is checked independently', () => {
  const artifact = artifactWith([
    { type: 'citation-list', title: '好来源', uri: '/a', detail: 'd', verified: true },
    { type: 'citation-list', title: '坏来源', uri: null, detail: 'd', verified: true },
    { type: 'citation-list', title: '未核验', uri: '/c', detail: 'd', verified: false },
  ]);
  const checks = checkCitations(artifact);
  assert.deepEqual(checks.map((c) => c.ref), ['好来源', '坏来源', '未核验']);
  assert.deepEqual(checks.map((c) => c.status), ['PASS', 'UNKNOWN', 'UNKNOWN']);
});

function statusOf(checks) {
  assert.equal(checks.length, 1);
  return checks[0].status;
}
