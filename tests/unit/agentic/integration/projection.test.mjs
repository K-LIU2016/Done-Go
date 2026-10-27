// S2D-W13 · M16 projection 接缝（scripts/agentic/integration/projection.mjs）规格测试。
//
// 依据：brief §4.4「projection」——
//   - W6 Preview 的持久化与 Timeline projection 分离；
//   - W11 的播放字段通过 projection 消费，不扩张 Preview schema；
//   - W9 Artifact/Acceptance/Need 与 W10 trace/matrix 通过事件或显式查询接入，
//     不互写对方表；
//   - 红线 7 / brief §4.6：resolved_model=NULL、mock、cache replay 不得变真实成功。
//
// 纯函数契约：projection 不做 IO、不改输入、不写任何流的表（输出为深拷贝，
// 修改输出不得影响输入）；W6 纯投影语义以 scripts/agentic/preview/timeline.mjs
// 的既有契约为锚（shots 1:1、旁白按句分段可原样拼回、source 原样携带、未知
// 组件降级并列 fallbacks）。
//
// TDD：实现落地前 RED（ERR_MODULE_NOT_FOUND）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  projectPreviewTimeline,
  projectPlayback,
  projectAcceptedBenefit,
  projectModelProvenance,
} from '../../../../scripts/agentic/integration/projection.mjs';

/** 最小 W6 Preview 持久化形状（已过 preview.schema.json 门前提，W6 timeline.mjs 读取面）。 */
function previewFixture() {
  return {
    missionId: 'm1',
    version: 2,
    storyboard: [
      { at: 0, actor: 'user', text: '开场', need: 'n1' },
      { at: 4, actor: 'agent', text: '讲解' },
    ],
    reel: { durationSec: 12, tracks: ['bgm'] },
    narration: '第一句。第二句！未结束尾',
    samples: [{ id: 's1' }],
    shape: {
      kind: 'storyboard',
      title: 'T',
      blocks: [
        { type: 'outline', text: 'a' },
        { type: 'mysteryWidget', text: 'b' },
      ],
    },
  };
}

test('timeline projection maps storyboard shots 1:1 in order and keeps touchpoint needs', () => {
  const preview = previewFixture();
  const vm = projectPreviewTimeline(preview, { previewId: 'p1', revision: 2 });
  assert.equal(vm.missionId, 'm1');
  assert.equal(vm.version, 2);
  assert.equal(vm.shots.length, 2);
  assert.deepEqual(vm.shots.map(shot => shot.text), ['开场', '讲解']);
  assert.equal(vm.shots[0].need, 'n1');
  assert.equal('need' in vm.shots[1], false, 'untouched shots must not grow a need');
});

test('timeline projection splits narration into segments that reassemble byte-for-byte', () => {
  const preview = previewFixture();
  const vm = projectPreviewTimeline(preview, null);
  assert.equal(vm.narration.text, preview.narration);
  assert.equal(vm.narration.segments.map(segment => segment.text).join(''), preview.narration);
});

test('timeline projection degrades unknown shape components honestly and lists fallbacks', () => {
  const vm = projectPreviewTimeline(previewFixture(), null);
  const unknown = vm.shape.blocks.find(block => block.type === 'mysteryWidget');
  assert.equal(unknown.known, false);
  assert.equal(typeof unknown.fallbackText, 'string');
  assert.ok(vm.fallbacks.some(entry => String(entry).includes('mysteryWidget')));
});

test('projection is pure: mutating the output never mutates the persisted preview', () => {
  const preview = previewFixture();
  const frozen = JSON.stringify(preview);
  const vm = projectPreviewTimeline(preview, { previewId: 'p1', revision: 1 });
  vm.shots[0].text = 'tampered';
  vm.shape.title = 'tampered';
  vm.source.previewId = 'tampered';
  assert.equal(JSON.stringify(preview), frozen, 'input preview must remain untouched');
});

test('projection carries store metadata verbatim as source; absent source stays null', () => {
  assert.equal(projectPreviewTimeline(previewFixture(), null).source, null);
  const vm = projectPreviewTimeline(previewFixture(), { previewId: 'p9', revision: 4 });
  assert.deepEqual(vm.source, { previewId: 'p9', revision: 4 });
});

test('W11 playback fields are consumed via projection only: the preview never grows player keys', () => {
  const preview = previewFixture();
  const vm = projectPreviewTimeline(preview, null);
  const playback = projectPlayback(vm);
  assert.equal(playback.durationSec, 12);
  assert.deepEqual(playback.tracks, ['bgm']);
  for (const playerKey of ['autoplay', 'timelineVm', 'player', 'playback']) {
    assert.equal(playerKey in preview, false, `Preview persistence must not grow ${playerKey}`);
  }
});

/** W9-shaped acceptance/verdict view (explicit query results — never cross-written). */
function benefitEntries() {
  return [
    // legit: user acceptance + VERIFIED verdict, same owner
    {
      owner: 'owner-a',
      acceptance: { actor: 'user:owner-a', decision: 'accepted', artifactVersion: 3 },
      verdict: { overall: 'VERIFIED', checks: [{ severity: 'MEDIUM', status: 'PASS' }] },
    },
    // revision requested → not benefit
    {
      owner: 'owner-a',
      acceptance: { actor: 'user:owner-a', decision: 'revision_requested', artifactVersion: 2 },
      verdict: { overall: 'VERIFIED', checks: [] },
    },
    // unresolved UNKNOWN check → fail-closed
    {
      owner: 'owner-a',
      acceptance: { actor: 'user:owner-a', decision: 'accepted', artifactVersion: 1 },
      verdict: { overall: 'UNKNOWN', checks: [{ severity: 'LOW', status: 'UNKNOWN' }] },
    },
    // unresolved HIGH → fail-closed
    {
      owner: 'owner-a',
      acceptance: { actor: 'user:owner-a', decision: 'accepted', artifactVersion: 4 },
      verdict: { overall: 'FAILED', checks: [{ severity: 'HIGH', status: 'FAIL' }] },
    },
    // agent actor acceptance does not count as user benefit
    {
      owner: 'owner-a',
      acceptance: { actor: 'agent:verifier', decision: 'accepted', artifactVersion: 5 },
      verdict: { overall: 'VERIFIED', checks: [] },
    },
    // cross-owner acceptance must not project into owner-a's benefit
    {
      owner: 'owner-b',
      acceptance: { actor: 'user:owner-b', decision: 'accepted', artifactVersion: 6 },
      verdict: { overall: 'VERIFIED', checks: [] },
    },
  ];
}

test('accepted-benefit projection counts only legitimate user-accepted VERIFIED entries for the owner', () => {
  const result = projectAcceptedBenefit(benefitEntries(), 'owner-a');
  assert.equal(result.count, 1);
  assert.deepEqual(result.included, [{ artifactVersion: 3 }]);
});

test('empty inputs project to zero benefit, not an error', () => {
  assert.equal(projectAcceptedBenefit([], 'owner-a').count, 0);
});

test('benefit projection never upgrades: a VERIFIED overall with an open UNKNOWN check stays out', () => {
  const sneaky = [{
    owner: 'owner-a',
    acceptance: { actor: 'user:owner-a', decision: 'accepted', artifactVersion: 7 },
    verdict: { overall: 'VERIFIED', checks: [{ severity: 'LOW', status: 'UNKNOWN' }] },
  }];
  assert.equal(projectAcceptedBenefit(sneaky, 'owner-a').count, 0);
});

test('no free VERIFIED (W9 F2): user-owner accepted VERIFIED with zero checks is excluded, not counted', () => {
  // W13 评审 HIGH / W9 安全 F2 残留钉死用例：落库前 saveVerdict 已拒绝
  // 空-checks VERIFIED；投影入参来自显式查询，同样不得信任这种引擎不可能
  // 产出的『免费 VERIFIED』（engine.mjs：checks 非空才 VERIFIED）。
  const rows = [{
    owner: 'owner-a',
    acceptance: { actor: 'user:owner-a', decision: 'accepted', artifactVersion: 8 },
    verdict: { overall: 'VERIFIED', checks: [] },
  }];
  const result = projectAcceptedBenefit(rows, 'owner-a');
  assert.equal(result.count, 0, 'empty-checks VERIFIED must never count as benefit');
  assert.deepEqual(result.included, []);
  assert.equal(result.excluded.length, 1);
  assert.equal(result.excluded[0].artifactVersion, 8);
  assert.equal(result.excluded[0].reason, 'VERDICT_BLOCKING');
});

test('no free VERIFIED (W9 F2): a VERIFIED with real checks still counts (fix does not over-tighten)', () => {
  const rows = [{
    owner: 'owner-a',
    acceptance: { actor: 'user:owner-a', decision: 'accepted', artifactVersion: 9 },
    verdict: { overall: 'VERIFIED', checks: [{ severity: 'LOW', status: 'PASS' }] },
  }];
  assert.deepEqual(projectAcceptedBenefit(rows, 'owner-a').included, [{ artifactVersion: 9 }]);
});

test('model provenance: NULL resolved_model is UNKNOWN, never VERIFIED', () => {
  const result = projectModelProvenance({ actor: 'w13·评审', resolvedModel: null, modelSource: 'unknown' });
  assert.equal(result.status, 'UNKNOWN');
  assert.notEqual(result.status, 'VERIFIED');
});

test('model provenance: mock or cache-replay sources stay PROVISIONAL at best', () => {
  for (const modelSource of ['mock', 'cache-replay']) {
    const result = projectModelProvenance({ actor: 'impl', resolvedModel: 'glm-5.3', modelSource });
    assert.ok(['PROVISIONAL', 'UNKNOWN'].includes(result.status), `${modelSource} -> ${result.status}`);
    assert.notEqual(result.status, 'VERIFIED');
  }
});

test('model provenance: verifiable gateway evidence can be VERIFIED, and carries the evidence link', () => {
  const result = projectModelProvenance({
    actor: 'w13·收口',
    resolvedModel: 'glm-5.3',
    modelSource: 'gateway',
    evidence: { runId: 'dwfrun-x', spanId: 's1' },
  });
  assert.equal(result.status, 'VERIFIED');
  assert.deepEqual(result.evidence, { runId: 'dwfrun-x', spanId: 's1' });
});

test('model provenance: conflicting evidence for one actor degrades to PROVISIONAL, not VERIFIED', () => {
  const result = projectModelProvenance({
    actor: 'w8·评审',
    resolvedModel: 'glm-5.3',
    modelSource: 'gateway',
    evidence: [
      { runId: 'r1', model: 'glm-5.3' },
      { runId: 'r1', model: 'gpt-6.1-sol' },
    ],
  });
  assert.ok(['PROVISIONAL', 'UNKNOWN'].includes(result.status), `conflict -> ${result.status}`);
});

test('stale evidence marker keeps the entry degraded (W10 matrix semantics)', () => {
  const result = projectModelProvenance({
    actor: 'w10·fixer',
    resolvedModel: 'glm-5.3',
    modelSource: 'gateway',
    evidence: { runId: 'r2', model: 'glm-5.3' },
    stale: true,
  });
  assert.ok(['PROVISIONAL', 'UNKNOWN'].includes(result.status), `stale -> ${result.status}`);
});
