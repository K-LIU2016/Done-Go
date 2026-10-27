// S2D-W13 · 黄金场景 fixture 自检（只依赖 W0 冻结契约，当前树必须 PASS）。
//
// 目的（W6 先例「fixture 经冻结 schema 直验通过」）：证明 RED 失败来自实现缺失
// 而非 fixture 本身坏——fixture 中的 W0 对象必须过冻结 schema；已知契约缺口
// （draft 无 start/end 在 v1 schema 下非法）按 W1 一致性测试 ③ 的方式锚定现状。
//
// 本文件不 import 任何未实现的 W13 模块，随测试先行节点提交时即 GREEN。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSchema, validate } from '../../../../scripts/agentic/contracts.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const contractDir = join(here, '../../../../contracts/agentic');
const blockSchema = loadSchema('block.schema.json', contractDir);

// The golden fixture data lives with the golden harness tree (tests/agentic/integration/fixtures).
const goldenPath = join(here, '../../../agentic/integration/fixtures/golden-scenarios.json');
const golden = JSON.parse(await readFile(goldenPath, 'utf8'));

// Fixture-side expectation mirror of the W1 bridging semantics pinned by
// tests/unit/agentic/blocks/contract-consistency.test.mjs (prio 1|2→high、
// 3→normal、4|5→low；source web|draft→manual；schemaVersion 1). Test-only;
// the runtime adapter under spec lives in scripts/agentic/integration/w1-adapter.mjs.
const PRIO_TO_CONTRACT = { 1: 'high', 2: 'high', 3: 'normal', 4: 'low', 5: 'low' };
const toContractSource = value => (value === 'web' || value === 'draft' ? 'manual' : value);

function expectedConversion(row, ownerId) {
  return {
    id: row.id,
    ownerId,
    revision: row.revision,
    schemaVersion: 1,
    date: row.date,
    start: row.start,
    end: row.end,
    title: row.title,
    kind: row.kind,
    prio: PRIO_TO_CONTRACT[row.prio] || 'normal',
    note: row.note,
    done: row.done,
    source: toContractSource(row.source),
    deletedAt: row.deleted_at,
    createdAt: '2026-10-28T10:00:00.000Z',
    updatedAt: '2026-10-28T10:00:00.000Z',
  };
}

test('golden fixture file carries the seven brief §5 node scenarios with stable ids', () => {
  assert.equal(golden.schemaVersion, 1);
  assert.deepEqual(
    golden.scenarios.map(scenario => scenario.id),
    [
      'golden-1-block-sync-adapter',
      'golden-2-perception-preview-projection',
      'golden-3-autonomy-fence',
      'golden-4-mission-runtime-recovery',
      'golden-5-delivery-benefit-gate',
      'golden-6-dual-device-sync',
      'golden-7-observability-provenance',
    ],
  );
  for (const scenario of golden.scenarios) {
    assert.ok(scenario.brief.startsWith('§5.'), `${scenario.id} must cite its brief section`);
    assert.ok(typeof scenario.owner === 'string' && scenario.owner.length > 0);
    assert.ok(scenario.expect && typeof scenario.expect === 'object');
  }
});

test('golden-1 expected conversion of the complete row is schema-valid with the pinned mapping', () => {
  const scenario = golden.scenarios.find(entry => entry.id === 'golden-1-block-sync-adapter');
  const expectation = expectedConversion(scenario.inputs.completeRow, scenario.owner);
  const result = validate(expectation, blockSchema, { schemaDir: contractDir });
  assert.equal(result.valid, true, JSON.stringify(result.errors));
  assert.equal(expectation.source, scenario.expect.convertedSource);
  assert.equal(expectation.prio, scenario.expect.convertedPrio);
});

test('golden-1 anchors the TA1 gap: the draft row stays invalid under frozen v1 (no silent bridging)', () => {
  const scenario = golden.scenarios.find(entry => entry.id === 'golden-1-block-sync-adapter');
  const draft = expectedConversion(scenario.inputs.draftRow, scenario.owner);
  const result = validate(draft, blockSchema, { schemaDir: contractDir });
  assert.equal(result.valid, false, 'a draft without start/end must NOT validate as an executable v1 block');
});

test('golden-3 fence expectations never allow extra external effects after rejection', () => {
  const scenario = golden.scenarios.find(entry => entry.id === 'golden-3-autonomy-fence');
  const expect = scenario.expect;
  assert.equal(expect.firstConfirmExternalEffects, 1);
  for (const rejection of [expect.repeatConfirm, expect.expiredGrant, expect.crossOwner, expect.a5AutoAttempt]) {
    assert.equal(rejection.rejected, true);
    assert.equal(rejection.newExternalEffects, 0, 'rejections must be side-effect free');
  }
  assert.equal(expect.totalExternalEffects, 1);
});

test('golden-4 pins UNKNOWN semantics for the null-model run (never success, never auto-retry)', () => {
  const expect = golden.scenarios.find(entry => entry.id === 'golden-4-mission-runtime-recovery').expect;
  assert.equal(expect.nullModelOutcome, 'unknown');
  assert.equal(expect.nullModelWorkResults, 0);
  assert.equal(expect.nullModelAutoRetries, 0);
});

test('golden-5 benefit gate counts only the legitimate accepted version', () => {
  const scenario = golden.scenarios.find(entry => entry.id === 'golden-5-delivery-benefit-gate');
  assert.deepEqual(scenario.expect.countedVersions, [3]);
  assert.equal(scenario.expect.acceptedBenefitCount, 1);
  assert.equal(scenario.expect.crossOwnerReadHttpStatus, 404);
});

test('golden-7 forbids upgrading stale/conflicting/null provenance to VERIFIED', () => {
  const expect = golden.scenarios.find(entry => entry.id === 'golden-7-observability-provenance').expect;
  assert.equal(expect.nullModelStatus, 'UNKNOWN');
  assert.ok(expect.staleStatusIn.includes('PROVISIONAL') || expect.staleStatusIn.includes('UNKNOWN'));
  assert.equal(expect.upgradedToVerified, false);
});

test('every scenario keeps real external calls at zero (harness fakes only)', () => {
  assert.equal(golden.scenarios.every(scenario => !JSON.stringify(scenario).match(/api\.bigmodel|openai\.com|smtp:\/\//)), true);
});
