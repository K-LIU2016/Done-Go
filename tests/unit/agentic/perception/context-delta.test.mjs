// context-delta 契约：ContextDelta {blockId, seen, change, risk, evidence(imageRef)}（PRD §6.8.2 L491）
// 与建议卡（一句话建议 + 动作按钮，prototype capcard L383-391：即时卡→深卡原地升级）。
// 对应实现：scripts/agentic/perception/context-delta.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildContextDelta, buildSuggestionCard } from '../../../../scripts/agentic/perception/context-delta.mjs';

const fast = { seen: '正在按说明书组装书架，胶水和螺丝已就位。' };
const deep = {
  seen: '隔板已上胶，但胶水溢出、没用夹具固定，可能会不平。',
  change: '胶水溢出、未用夹具',
  risk: '隔板可能不平',
  suggestion: '用湿布擦掉多余胶水 → 直尺检查隔板水平 → 夹子固定 15 分钟再拧螺丝',
  actions: ['⏱ 15 分钟后提醒我', '步骤卡跳到第 4 步', '记下来'],
};

test('buildContextDelta maps the deep result into PRD §6.8.2 shape', () => {
  const delta = buildContextDelta({ captureId: 'cap-1', blockId: 'b-shelf', fast, deep });
  assert.deepEqual(delta, {
    blockId: 'b-shelf',
    seen: deep.seen,
    change: deep.change,
    risk: deep.risk,
    evidence: { imageRef: 'cap-1' },
  });
});

test('buildContextDelta falls back to the fast card’s seen when deep omits it', () => {
  const delta = buildContextDelta({ captureId: 'cap-2', blockId: 'b-1', fast, deep: { seen: null, change: 'x', risk: null } });
  assert.equal(delta.seen, fast.seen, '深感知没给 seen 时用快卡的一句话');
  assert.equal(delta.change, 'x');
  assert.equal(delta.risk, null);
});

test('buildContextDelta tolerates unattributed captures (blockId null) and missing deep fields', () => {
  const delta = buildContextDelta({ captureId: 'cap-3', blockId: null, fast, deep: {} });
  assert.deepEqual(delta, { blockId: null, seen: fast.seen, change: null, risk: null, evidence: { imageRef: 'cap-3' } });
});

test('buildSuggestionCard: 一句话建议 + 逐字保留的动作按钮（记下来/加待办/调整计划/设提醒/交给 agent）', () => {
  const delta = buildContextDelta({ captureId: 'cap-1', blockId: 'b-shelf', fast, deep });
  const card = buildSuggestionCard({ contextDelta: delta, suggestion: deep.suggestion, actions: deep.actions });
  assert.deepEqual(card, {
    blockId: 'b-shelf',
    summary: '用湿布擦掉多余胶水 → 直尺检查隔板水平 → 夹子固定 15 分钟再拧螺丝',
    actions: [
      { id: 'act-1', label: '⏱ 15 分钟后提醒我' },
      { id: 'act-2', label: '步骤卡跳到第 4 步' },
      { id: 'act-3', label: '记下来' },
    ],
  });
});

test('buildSuggestionCard degrades gracefully on empty model output', () => {
  const card = buildSuggestionCard({ contextDelta: { blockId: null }, suggestion: null, actions: null });
  assert.deepEqual(card, { blockId: null, summary: '', actions: [] });
  const single = buildSuggestionCard({ contextDelta: { blockId: 'b' }, suggestion: '记一下', actions: '加待办' });
  assert.deepEqual(single.actions, [{ id: 'act-1', label: '加待办' }], '单个动作字符串归一为一按钮');
});

test('upgrade keeps the same card identity: delta reuses captureId as the only evidence reference', () => {
  const a = buildContextDelta({ captureId: 'cap-9', blockId: 'b', fast, deep });
  const b = buildContextDelta({ captureId: 'cap-9', blockId: 'b', fast, deep: { ...deep, seen: '升级后的描述' } });
  assert.equal(a.evidence.imageRef, b.evidence.imageRef, '原地升级不换引用（同 captureId）');
  assert.equal(b.seen, '升级后的描述');
});
