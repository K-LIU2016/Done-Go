// W9 M1 delivery-domain · benefit 单测（TDD RED 先行）
//
// 本文件是 `scripts/agentic/delivery/benefit.mjs` 的接口规约：
//   acceptedBenefit(acceptance, verdictSummary) —— 纯函数，无 IO。
//   - 仅 acceptance.decision === 'accepted' 且 verdictSummary.blocking === false 时计入：
//     返回包含 artifactId 的对象；其余一律返回 null（不计入已验收收益）。
//   - verdictSummary 形状（由注入的 verdictGate 提供，见 M2 dbVerdictGate）：
//     { blocking: boolean, unknownCount: number, highFailCount: number }
//   - verdictSummary 缺失（null/undefined）= 没有任何核验结果 = fail closed → null。
// brief 裁决③：用户验收≠agent 自报成功；rejected/revision_requested 永不进收益。
import test from 'node:test';
import assert from 'node:assert/strict';
import { acceptedBenefit } from '../../../../scripts/agentic/delivery/benefit.mjs';

const ACCEPTED = { id: 'acc-1', artifactId: 'art-1', actor: 'user:alice', decision: 'accepted', createdAt: '2026-10-27T10:00:00Z' };
const REVISED = { ...ACCEPTED, decision: 'revision_requested', comment: '再改改' };
const REJECTED = { ...ACCEPTED, decision: 'rejected', comment: '不要' };
const NOT_BLOCKING = { blocking: false, unknownCount: 0, highFailCount: 0 };

test('accepted + non-blocking verdict counts as benefit', () => {
  const benefit = acceptedBenefit(ACCEPTED, NOT_BLOCKING);
  assert.ok(benefit, 'expected a benefit entry');
  assert.equal(benefit.artifactId, 'art-1');
});

test('accepted with unknown verdict checks never counts', () => {
  assert.equal(acceptedBenefit(ACCEPTED, { blocking: true, unknownCount: 2, highFailCount: 0 }), null);
});

test('accepted with unresolved HIGH failures never counts', () => {
  assert.equal(acceptedBenefit(ACCEPTED, { blocking: true, unknownCount: 0, highFailCount: 1 }), null);
});

test('a rejected acceptance never counts as benefit (user rejection is final)', () => {
  assert.equal(acceptedBenefit(REJECTED, NOT_BLOCKING), null);
});

test('a revision request never counts as benefit', () => {
  assert.equal(acceptedBenefit(REVISED, NOT_BLOCKING), null);
});

test('missing verdict summary fails closed (no verification = no benefit)', () => {
  assert.equal(acceptedBenefit(ACCEPTED, null), null);
  assert.equal(acceptedBenefit(ACCEPTED, undefined), null);
});

test('missing or non-accepted decision never counts', () => {
  assert.equal(acceptedBenefit(null, NOT_BLOCKING), null);
  assert.equal(acceptedBenefit({ ...ACCEPTED, decision: undefined }, NOT_BLOCKING), null);
  assert.equal(acceptedBenefit({ ...ACCEPTED, decision: 'self-reported' }, NOT_BLOCKING), null);
});

test('pure function: same inputs, same output, no mutation', () => {
  const a = { ...ACCEPTED };
  const v = { ...NOT_BLOCKING };
  const first = acceptedBenefit(a, v);
  const second = acceptedBenefit(a, v);
  assert.deepEqual(first, second);
  assert.equal(a.decision, 'accepted');
  assert.equal(v.blocking, false);
});
