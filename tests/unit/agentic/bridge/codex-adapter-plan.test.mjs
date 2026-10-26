// M6 codex-adapter · plan 能力单测（TDD RED 先行）。
// 契约来源：PRD §6.5 协议映射表 L410–422 逐行、§6.5.1 表第 1 行（预演规划=只读沙箱、gpt-6-luna、effort=low、
// outputSchema=改动方案 JSON：要改文件/方案要点/风险/将跑测试/预计 diff 规模）、BUILD-PLAN §3 W8-2/3。
// 夹具驱动：sessionFactory 注入假会话（_fake-codex.mjs），不真起 codex。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCodexAdapter } from '../../../../packages/donego-bridge/src/codex/adapter.mjs';
import { fakeSessionFactory, callsOf, PLAN_FIXTURE, MISSION } from './_fake-codex.mjs';

function makeAdapter(script, over = {}) {
  const factory = fakeSessionFactory(script);
  const adapter = createCodexAdapter({
    sessionFactory: factory,
    chooseModel: () => { throw new Error('plan 阶段不应选执行模型'); },
    chooseReviewModel: () => { throw new Error('plan 阶段不应选评审模型'); },
    decideApproval: () => { throw new Error('plan 阶段不应触发审批'); },
    onNeed: () => { throw new Error('plan 阶段不应产生 Need'); },
    now: () => 1_000,
    log: () => {},
    ...over,
  });
  return { adapter, factory };
}

const script = {
  initialize: () => ({ protocolVersion: 1 }),
  'thread/start': () => ({ threadId: 'th_1' }),
  'thread/goal/set': () => ({ ok: true }),
  'turn/start': p => (p.model === 'gpt-6-luna' ? { output: PLAN_FIXTURE } : { output: { done: true } }),
};

test('start()：先 initialize 请求、成功后发 initialized 通知（BUILD-PLAN W8-2）', async () => {
  const { adapter, factory } = makeAdapter(script);
  await adapter.start();
  const init = callsOf(factory, 'initialize');
  assert.equal(init.length, 1);
  const notified = callsOf(factory, 'initialized');
  assert.equal(notified.length, 1, 'initialize 成功后必须发 initialized 通知');
  assert.ok(factory.calls.findIndex(c => c.method === 'initialize') < factory.calls.findIndex(c => c.method === 'initialized'), '顺序：请求在前、通知在后');
});

test('plan(mission)：thread/start cwd=worktree、approvalPolicy、developerInstructions=合同摘要', async () => {
  const { adapter, factory } = makeAdapter(script);
  await adapter.start();
  const mission = MISSION();
  const out = await adapter.plan(mission);
  const ts = callsOf(factory, 'thread/start').at(-1);
  assert.equal(ts.params.cwd, '/wt/mission-m1');
  assert.ok(ts.params.approvalPolicy !== undefined, '必须显式带 approvalPolicy');
  assert.equal(ts.params.developerInstructions, mission.contract.summary);
  assert.equal(out.threadId, 'th_1');
});

test('plan(mission)：thread/goal/set 把合同 DoD 原样写入（PRD L413）', async () => {
  const { adapter, factory } = makeAdapter(script);
  await adapter.start();
  const mission = MISSION();
  await adapter.plan(mission);
  const goal = callsOf(factory, 'thread/goal/set').at(-1);
  assert.deepEqual(goal.params.goal, mission.contract.definitionOfDone, 'DoD 原样、不改写');
  assert.equal(goal.params.threadId, 'th_1');
});

test('plan(mission)：turn/start 只读沙箱 + gpt-6-luna + effort=low + outputSchema（§6.5.1 第 1 行）', async () => {
  const { adapter, factory } = makeAdapter(script);
  await adapter.start();
  const out = await adapter.plan(MISSION());
  const turn = callsOf(factory, 'turn/start').at(-1);
  assert.equal(turn.params.model, 'gpt-6-luna');
  assert.equal(turn.params.effort, 'low');
  assert.equal(turn.params.sandbox?.mode, 'read-only', '预演规划必须只读沙箱');
  const schema = turn.params.outputSchema;
  assert.ok(schema, '必须带 outputSchema=改动方案 JSON');
  const props = JSON.stringify(schema);
  for (const field of ['files', 'summary', 'riskFlags', 'tests', 'estimatedDiffLines']) {
    assert.ok(props.includes(field), `outputSchema 需覆盖「${field}」（PRD L414 产出清单）`);
  }
  assert.deepEqual(out.plan, PLAN_FIXTURE, '结构化方案原样返回（喂 M3 chooseModel）');
});

test('plan 负例：mission 缺 worktree / 缺合同 → 拒绝，不发起 turn', async () => {
  const { adapter, factory } = makeAdapter(script);
  await adapter.start();
  await assert.rejects(() => adapter.plan({ missionId: 'x', contract: MISSION().contract }), /WORKTREE|CONTRACT/);
  await assert.rejects(() => adapter.plan({ missionId: 'x', worktree: '/wt/x' }), /WORKTREE|CONTRACT/);
  assert.equal(callsOf(factory, 'turn/start').length, 0);
});

test('plan 负例：turn 响应缺 output → 拒绝（宁失败不臆造方案）', async () => {
  const { adapter } = makeAdapter({ ...script, 'turn/start': () => ({}) });
  await adapter.start();
  await assert.rejects(() => adapter.plan(MISSION()), /output|OUTPUT/);
});
