// W9 M1 delivery-domain · 补充单测：acceptedBenefit 边界分支（可选字段缺省 / verdictSummary 缺计数 / 非对象输入）
// brief 裁决③：用户验收 ≠ agent 自报成功；无核验结果 fail closed。
import test from 'node:test';
import assert from 'node:assert/strict';
import { acceptedBenefit } from '../../../../scripts/agentic/delivery/benefit.mjs';

const MINIMAL_ACCEPTED = { artifactId: 'art-9', decision: 'accepted' };

test('minimal accepted record yields benefit with null identity fields and zeroed counts', () => {
  const benefit = acceptedBenefit(MINIMAL_ACCEPTED, { blocking: false });
  assert.ok(benefit);
  assert.equal(benefit.artifactId, 'art-9');
  assert.equal(benefit.acceptanceId, null);
  assert.equal(benefit.actor, null);
  assert.equal(benefit.decidedAt, null);
  assert.deepEqual(benefit.verdict, { blocking: false, unknownCount: 0, highFailCount: 0 });
});

test('verdictSummary without explicit counts defaults them to zero', () => {
  const benefit = acceptedBenefit(
    { id: 'a1', artifactId: 'art-1', decision: 'accepted', actor: 'user:alice', createdAt: '2026-10-27T10:00:00Z' },
    { blocking: false },
  );
  assert.deepEqual(benefit.verdict, { blocking: false, unknownCount: 0, highFailCount: 0 });
});

test('non-object inputs fail closed', () => {
  for (const bad of ['accepted', 42, true, [], () => {}]) {
    assert.equal(acceptedBenefit(MINIMAL_ACCEPTED, bad), null, `verdictSummary=${typeof bad}`);
  }
  for (const bad of ['accepted', 42, null, () => {}]) {
    assert.equal(acceptedBenefit(bad, { blocking: false }), null, `acceptance=${typeof bad}`);
  }
});

test('truthy but blocking summaries never count', () => {
  assert.equal(acceptedBenefit(MINIMAL_ACCEPTED, { blocking: true }), null);
  assert.equal(acceptedBenefit(MINIMAL_ACCEPTED, { blocking: 'false' }), null, 'blocking must be boolean false');
});
