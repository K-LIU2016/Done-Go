// W0 契约一致性测试（BUILD-PLAN §2.2 L55 收尾必做、§2.4 门禁第 6 条）：
// 1) 合并进来的 W0 冻结契约（FROZEN v1）自身 fixtures 用 W0 校验器逐个过——valid 全过、
//    invalid 全拒（校验器与 fixtures 完好，非我流改动）；2) 我流产出的感知对象经
//    contract-projection.mjs 投影后用 W0 校验器 assertValid（自己产出的对象校验通过）；
// 3) 我流「吃下」W0 fixtures（buildSuggestionCard 直接消费 W0 ContextDelta fixture）；
// 4) 已知 schema 表达力缺口如实断言为「拒投影 + reason」，不编造字段硬过——
//    分叉点（risk 枚举 vs 自由文本、evidence 数组 vs {imageRef}、全字段非空 vs 流水线
//    null 语义）列终报「待 CTO 裁决」，本测试是该清单的机器可读版。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';
import { loadSchema, validate } from '../../../../scripts/agentic/contracts.mjs';
import { buildContextDelta, buildSuggestionCard } from '../../../../scripts/agentic/perception/context-delta.mjs';
import { toContractContextDelta, toContractSuggestionCard, mapRisk, mapActionKind } from '../../../../scripts/agentic/perception/contract-projection.mjs';

const CONTRACTS_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../../../contracts/agentic');
const loadFixtures = name => JSON.parse(readFileSync(join(CONTRACTS_DIR, 'fixtures', name), 'utf8'));

const contextDeltaSchema = loadSchema('context-delta.schema.json', CONTRACTS_DIR);
const suggestionCardSchema = loadSchema('suggestion-card.schema.json', CONTRACTS_DIR);

// 真实冒烟里深感知的典型输出（白板轮：change 非空、risk null——提示词不产 risk）
const deepWhiteboard = {
  seen: '白板手写Q4目标：1.语音输入上线11/15；2.日程到交付PRD评审；3.招1名前端',
  change: '「日程到交付PRD评审」未标注具体日期，存在交付节点模糊风险',
  risk: null,
  suggestion: '在白板第2条后补写PRD评审截止日（如11/8），并同步更新Jira Epic截止时间',
  actions: ['记下来', '加待办', '设提醒'],
};

test('W0 冻结契约自身完好：context-delta / suggestion-card 的 fixtures valid 全过、invalid 全拒', () => {
  for (const [fixtureName, schema] of [['context-delta.fixtures.json', contextDeltaSchema], ['suggestion-card.fixtures.json', suggestionCardSchema]]) {
    const fixtures = loadFixtures(fixtureName);
    assert.ok(fixtures.valid.length >= 2, fixtureName);
    for (const v of fixtures.valid) assert.equal(validate(v, schema).valid, true, `${fixtureName} valid 应过：${JSON.stringify(v)}`);
    for (const iv of fixtures.invalid) assert.equal(validate(iv, schema).valid, false, `${fixtureName} invalid 应拒：${JSON.stringify(iv)}`);
  }
});

test('我流产出的 ContextDelta 投影后通过 W0 schema（自己产出的对象校验通过）', () => {
  const mine = buildContextDelta({ captureId: 'cap_smoke_whiteboard_1', blockId: 'blk-whiteboard', fast: { seen: '白板三个目标' }, deep: deepWhiteboard });
  const projected = toContractContextDelta(mine);
  assert.equal(projected.ok, true, projected.reason);
  assert.deepEqual(projected.value, {
    blockId: 'blk-whiteboard',
    seen: deepWhiteboard.seen,
    change: deepWhiteboard.change,
    risk: 'none',
    evidence: ['cap_smoke_whiteboard_1'],
  });
  const result = validate(projected.value, contextDeltaSchema);
  assert.equal(result.valid, true, JSON.stringify(result.errors));
});

test('我流产出的建议卡投影后通过 W0 schema：动词表映射 kind、fast/deep → instant/upgraded', () => {
  const contextDelta = buildContextDelta({ captureId: 'cap-1', blockId: 'blk-craft', fast: {}, deep: deepWhiteboard });
  const card = buildSuggestionCard({ contextDelta, suggestion: deepWhiteboard.suggestion, actions: deepWhiteboard.actions });
  const projected = toContractSuggestionCard({ captureId: 'cap-1', card, level: 'deep' });
  assert.equal(projected.ok, true, projected.reason);
  assert.deepEqual(projected.value.actions.map(a => a.kind), ['remember', 'todo', 'remind']);
  assert.equal(projected.value.status, 'upgraded');
  assert.equal(projected.value.id, 'sc-cap-1');
  assert.equal(validate(projected.value, suggestionCardSchema).valid, true);
  const fast = toContractSuggestionCard({ captureId: 'cap-1', card, level: 'fast' });
  assert.equal(fast.value.status, 'instant');
});

test('我流「吃下」W0 fixtures：buildSuggestionCard 直接消费 W0 ContextDelta fixture（blockId 透传）', () => {
  for (const fixture of loadFixtures('context-delta.fixtures.json').valid) {
    const card = buildSuggestionCard({ contextDelta: fixture, suggestion: '按变化调整当前块剩余步骤', actions: ['调整计划'] });
    assert.equal(card.blockId, fixture.blockId);
    assert.equal(card.actions[0].label, '调整计划');
  }
});

test('schema 表达力缺口如实拒投影（不编造字段硬过）：未归属 / 无变化 / 快卡空建议 / 不可分 risk', () => {
  // 未归属（歧义待裁决）：blockId null——真实存在（歧义返回候选交用户选，BUILD-PLAN L142）
  const unattributed = buildContextDelta({ captureId: 'cap-2', blockId: null, fast: { seen: 'x' }, deep: deepWhiteboard });
  assert.deepEqual(toContractContextDelta(unattributed), { ok: false, reason: 'missing-blockId' });
  // 「无变化填 null」（提示词契约，prompts.mjs）：change null——冰箱场景真实发生
  const noChange = buildContextDelta({ captureId: 'cap-3', blockId: 'blk-fridge', fast: { seen: 'x' }, deep: { seen: '食材盘点', change: null, risk: null } });
  assert.deepEqual(toContractContextDelta(noChange), { ok: false, reason: 'missing-change' });
  // 快卡阶段：summary 空、actions 空
  const early = toContractSuggestionCard({ captureId: 'cap-4', card: { blockId: 'b', summary: '', actions: [] } });
  assert.equal(early.ok, false);
  // 自由文本 risk 不可分类 → 拒投影（不猜枚举档；注意避开 高/中/低/可能 等分类关键词）
  const freeText = buildContextDelta({ captureId: 'cap-5', blockId: 'b', fast: {}, deep: { seen: 's', change: 'c', risk: '不平但说不清' } });
  assert.equal(toContractContextDelta(freeText).reason, 'unmappable-risk');
});

test('mapRisk / mapActionKind 分类表：空→none，高中低关键词→对应档；标签动词表全覆盖+保守回退', () => {
  assert.equal(mapRisk(null), 'none');
  assert.equal(mapRisk(''), 'none');
  assert.equal(mapRisk('无'), 'none');
  assert.equal(mapRisk('进度高风险'), 'high');
  assert.equal(mapRisk('可能延误'), 'medium');
  assert.equal(mapRisk('轻微偏差'), 'low');
  assert.equal(mapRisk('难说'), null);
  assert.equal(mapActionKind('记下来'), 'remember');
  assert.equal(mapActionKind('⏱ 15 分钟后提醒我'), 'remind');
  assert.equal(mapActionKind('加待办'), 'todo');
  assert.equal(mapActionKind('调整计划'), 'adjust');
  assert.equal(mapActionKind('交给 agent 做'), 'delegate');
  assert.equal(mapActionKind('未知动作'), 'remember', '未命中保守落 remember（回退规则列待裁决）');
});
