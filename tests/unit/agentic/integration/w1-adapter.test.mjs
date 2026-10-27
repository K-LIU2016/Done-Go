// S2D-W13 · M15 W1 legacy DTO → W0 Agentic Block 适配器
// （scripts/agentic/integration/w1-adapter.mjs）规格测试。
//
// 依据：brief §4.3「边界 adapter」——只有完成时间、来源、owner、schemaVersion
// 和服务端时间戳补全后才转成 W0 Agentic Block；草稿或缺字段留在同步层并明确
// 返回 UNKNOWN/不可执行原因。
//
// 语义锚点（W1 tests/unit/agentic/blocks/contract-consistency.test.mjs 文件头注，
// 非凭空约定）：
//   prio 上行 1|2→high、3→normal、4|5→low；
//   source 上行 web|draft→manual（契约枚举无 web/draft）；
//   schemaVersion 常量 1；createdAt/updatedAt 由服务端时钟补全（集成根有
//   server now，不再沿用 W1 测试适配层「以 updated_at 兜底」的有损路径）。
//   draft（start/end 为 null，BUILD-PLAN W1-2 允许）在 W0 v1 schema 必填
//   start/end 下不合法 → 不转换，outcome=UNKNOWN（TA1 缺口保持显式，待 CTO）。
//
// TDD：实现落地前 RED（ERR_MODULE_NOT_FOUND）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adaptW1DtoToBlock } from '../../../../scripts/agentic/integration/w1-adapter.mjs';
import { assertValidAgainst, blockSchema, makeClock } from './_helpers.mjs';

const NOW = '2026-10-28T10:00:00.000Z';
const clock = makeClock(NOW);

/** W1 store rowToBlock 形状（scripts/agentic/block-store/store.mjs:46-47 实测）。 */
function w1Row(overrides = {}) {
  return {
    id: 'e1',
    revision: 3,
    date: '2026-10-28',
    start: '14:00',
    end: '15:00',
    title: '写作',
    kind: 'create',
    prio: 2,
    note: '',
    done: false,
    source: 'web',
    deleted_at: null,
    updated_at: '2026-10-27T09:00:00.000Z',
    ...overrides,
  };
}

test('complete W1 row converts to a frozen-schema-valid Agentic Block', () => {
  const result = adaptW1DtoToBlock(w1Row(), { ownerId: 'owner-a', now: clock.now });
  assert.equal(result.ok, true);
  assertValidAgainst(result.block, blockSchema, 'converted block');
});

test('conversion maps prio int to the frozen enum exactly as the W1 precedent pins it', () => {
  const expectations = [[1, 'high'], [2, 'high'], [3, 'normal'], [4, 'low'], [5, 'low']];
  for (const [prio, expected] of expectations) {
    const result = adaptW1DtoToBlock(w1Row({ prio }), { ownerId: 'owner-a', now: clock.now });
    assert.equal(result.ok, true, `prio ${prio}`);
    assert.equal(result.block.prio, expected);
  }
});

test('conversion maps W1 source web/draft to manual; frozen enum values pass through', () => {
  for (const [source, expected] of [['web', 'manual'], ['draft', 'manual'], ['voice', 'voice'], ['agent', 'agent'], ['sync', 'sync']]) {
    const result = adaptW1DtoToBlock(w1Row({ source }), { ownerId: 'owner-a', now: clock.now });
    assert.equal(result.ok, true, `source ${source}`);
    assert.equal(result.block.source, expected);
  }
});

test('ownerId comes from the server session, never from the DTO', () => {
  const forged = w1Row();
  forged.owner_id = 'owner-attacker'; // stray snake_case owner must not leak in
  const result = adaptW1DtoToBlock(forged, { ownerId: 'owner-a', now: clock.now });
  assert.equal(result.ok, true);
  assert.equal(result.block.ownerId, 'owner-a');
  assert.ok(!('owner_id' in result.block), 'snake_case owner must be stripped (additionalProperties:false anyway)');
});

test('server timestamps are stamped by the integration clock, not trusted from the DTO', () => {
  const result = adaptW1DtoToBlock(w1Row({ updated_at: '1999-01-01T00:00:00.000Z' }), { ownerId: 'owner-a', now: clock.now });
  assert.equal(result.block.createdAt, NOW);
  assert.equal(result.block.updatedAt, NOW);
  assert.equal(result.block.schemaVersion, 1);
});

test('draft without start/end is NOT converted: UNKNOWN outcome + reason, stays in the sync layer', () => {
  const draft = w1Row({ start: null, end: null });
  const result = adaptW1DtoToBlock(draft, { ownerId: 'owner-a', now: clock.now });
  assert.equal(result.ok, false);
  assert.equal(result.outcome, 'UNKNOWN');
  assert.equal(result.executionReady, false);
  assert.ok(typeof result.reason === 'string' && result.reason.length > 0, 'must carry a human-auditable reason');
  assert.deepEqual(result.missing.sort(), ['end', 'start']);
  assert.equal(result.block, undefined, 'a rejected draft must not produce a block');
});

test('draft with only start missing is equally rejected', () => {
  const result = adaptW1DtoToBlock(w1Row({ start: null }), { ownerId: 'owner-a', now: clock.now });
  assert.equal(result.ok, false);
  assert.equal(result.outcome, 'UNKNOWN');
  assert.deepEqual(result.missing, ['start']);
});

test('missing title is rejected with the field named', () => {
  const result = adaptW1DtoToBlock(w1Row({ title: '' }), { ownerId: 'owner-a', now: clock.now });
  assert.equal(result.ok, false);
  assert.equal(result.outcome, 'UNKNOWN');
  assert.ok(result.missing.includes('title'));
});

test('kind outside the frozen enum is rejected, not coerced', () => {
  const result = adaptW1DtoToBlock(w1Row({ kind: 'party' }), { ownerId: 'owner-a', now: clock.now });
  assert.equal(result.ok, false);
  assert.equal(result.outcome, 'UNKNOWN');
  assert.ok(String(result.reason).includes('kind'));
});

test('prio outside 1..5 is rejected instead of silently defaulted', () => {
  const result = adaptW1DtoToBlock(w1Row({ prio: 9 }), { ownerId: 'owner-a', now: clock.now });
  assert.equal(result.ok, false);
  assert.equal(result.outcome, 'UNKNOWN');
});

test('soft-deleted rows never become executable blocks', () => {
  const result = adaptW1DtoToBlock(w1Row({ deleted_at: '2026-10-27T00:00:00.000Z' }), { ownerId: 'owner-a', now: clock.now });
  assert.equal(result.ok, false);
  assert.equal(result.outcome, 'UNKNOWN');
});

test('24:00 end (frozen pattern) converts fine', () => {
  const result = adaptW1DtoToBlock(w1Row({ start: '23:00', end: '24:00' }), { ownerId: 'owner-a', now: clock.now });
  assert.equal(result.ok, true);
  assertValidAgainst(result.block, blockSchema, 'late-night block');
});

test('non-canonical fields (state/use/intent/…) are stripped by the conversion', () => {
  const noisy = w1Row();
  noisy.state = 'kept';
  noisy.use = 'x';
  noisy.intent = 'y';
  const result = adaptW1DtoToBlock(noisy, { ownerId: 'owner-a', now: clock.now });
  assert.equal(result.ok, true);
  for (const stray of ['state', 'use', 'intent', 'deleted_at', 'updated_at', 'owner_id']) {
    assert.equal(stray in result.block, false, stray);
  }
});

test('bad date format is rejected rather than repaired', () => {
  const result = adaptW1DtoToBlock(w1Row({ date: '2026/10/28' }), { ownerId: 'owner-a', now: clock.now });
  assert.equal(result.ok, false);
  assert.equal(result.outcome, 'UNKNOWN');
});

// ── M15 补强组（实现节点追加，2026-10-28；只增场景，不删不放宽任何既有断言；
//    覆盖率预检 branch/funcs ≥80% 门）───────────────────────────────────────────

test('supplement: mapping tables are frozen and pinned to the W1 precedent anchors', async () => {
  const { PRIO_TO_ENUM, SOURCE_TO_ENUM } = await import('../../../../scripts/agentic/integration/w1-adapter.mjs');
  assert.deepEqual(PRIO_TO_ENUM, { 1: 'high', 2: 'high', 3: 'normal', 4: 'low', 5: 'low' });
  assert.deepEqual(SOURCE_TO_ENUM, { web: 'manual', draft: 'manual' });
  assert.ok(Object.isFrozen(PRIO_TO_ENUM) && Object.isFrozen(SOURCE_TO_ENUM));
});

test('supplement: missing integration clock throws — no hidden wall clock fallback', () => {
  assert.throws(() => adaptW1DtoToBlock(w1Row(), { ownerId: 'owner-a' }), /integration clock/);
  assert.throws(() => adaptW1DtoToBlock(w1Row()), /integration clock/);
});

test('supplement: non-object dto is UNKNOWN, never a crash and never a block', () => {
  for (const bad of [null, undefined, 'row', 42, ['array'], () => {}]) {
    const result = adaptW1DtoToBlock(bad, { ownerId: 'owner-a', now: clock.now });
    assert.equal(result.ok, false, JSON.stringify(bad));
    assert.equal(result.outcome, 'UNKNOWN');
    assert.equal(result.block, undefined);
    assert.ok(result.reason.length > 0);
  }
});

test('supplement: no server session owner → UNKNOWN naming ownerId, draft fields still named', () => {
  const result = adaptW1DtoToBlock(w1Row(), { now: clock.now });
  assert.equal(result.ok, false);
  assert.equal(result.outcome, 'UNKNOWN');
  assert.deepEqual(result.missing, ['ownerId']);
  // 组合缺陷：owner 缺 + 草稿缺时刻，全部点名、互不吞并
  const combo = adaptW1DtoToBlock(w1Row({ start: null, end: null }), { now: clock.now });
  assert.deepEqual(combo.missing.sort(), ['end', 'ownerId', 'start']);
});

test('supplement: invalid id / revision / done / note are each named, nothing defaulted', () => {
  for (const [overrides, field] of [
    [{ id: '' }, 'id'],
    [{ id: null }, 'id'],
    [{ revision: 0 }, 'revision'],
    [{ revision: '3' }, 'revision'],
    [{ done: 'yes' }, 'done'],
    [{ note: 5 }, 'note'],
  ]) {
    const result = adaptW1DtoToBlock(w1Row(overrides), { ownerId: 'owner-a', now: clock.now });
    assert.equal(result.ok, false, field);
    assert.equal(result.outcome, 'UNKNOWN');
    assert.ok(result.missing.includes(field), `${field} in ${JSON.stringify(result.missing)}`);
  }
  // note 缺省（null/undefined）不算缺陷：补 '' 后正常转换
  const okay = adaptW1DtoToBlock(w1Row({ note: null }), { ownerId: 'owner-a', now: clock.now });
  assert.equal(okay.ok, true);
  assert.equal(okay.block.note, '');
});

test('supplement: present-but-malformed time is rejected (not only null drafts)', () => {
  for (const [overrides, field] of [[{ start: '9am' }, 'start'], [{ start: '' }, 'start'], [{ end: '25:00' }, 'end'], [{ end: '14-00' }, 'end']]) {
    const result = adaptW1DtoToBlock(w1Row(overrides), { ownerId: 'owner-a', now: clock.now });
    assert.equal(result.ok, false, JSON.stringify(overrides));
    assert.deepEqual(result.missing, [field]);
  }
});

test('supplement: unmappable source stays UNKNOWN in the sync layer', () => {
  for (const source of ['android', 'WEB', '', null]) {
    const result = adaptW1DtoToBlock(w1Row({ source }), { ownerId: 'owner-a', now: clock.now });
    assert.equal(result.ok, false, JSON.stringify(source));
    assert.ok(result.missing.includes('source'));
    assert.ok(result.reason.includes('source'));
  }
});

test('supplement: non-ISO clock stamp is refused instead of stamped through', () => {
  for (const bad of [() => 'yesterday', () => 12345, () => null, () => '2026-10-28 10:00']) {
    const result = adaptW1DtoToBlock(w1Row(), { ownerId: 'owner-a', now: bad });
    assert.equal(result.ok, false, String(bad()));
    assert.equal(result.outcome, 'UNKNOWN');
    assert.equal(result.block, undefined);
    assert.ok(result.reason.includes('ISO-8601'));
  }
});

test('supplement: schemaVersion override below the frozen minimum hits the schema backstop', () => {
  const result = adaptW1DtoToBlock(w1Row(), { ownerId: 'owner-a', now: clock.now, schemaVersion: 0 });
  assert.equal(result.ok, false);
  assert.equal(result.outcome, 'UNKNOWN');
  assert.equal(result.block, undefined);
  assert.ok(result.reason.includes('block.schema.json'));
  assert.ok(result.missing.includes('schemaVersion'), JSON.stringify(result.missing));
});

test('supplement: draft with source=draft and no time combines both anchors — UNKNOWN, exactly start/end missing', () => {
  const draft = w1Row({ source: 'draft', start: null, end: null });
  const result = adaptW1DtoToBlock(draft, { ownerId: 'owner-a', now: clock.now });
  assert.equal(result.ok, false);
  assert.equal(result.outcome, 'UNKNOWN');
  assert.equal(result.executionReady, false);
  assert.deepEqual(result.missing.sort(), ['end', 'start']);
  assert.ok(result.reason.includes('draft'));
});
