// M6 codex-adapter · execute/steer/interrupt/fork/revert/审批 单测（TDD RED 先行）。
// 契约来源：PRD §6.5 L415–422（执行回合 workspace-write 仅 worktree、steer 不重开、interrupt、fork/revert、
// 三类审批请求映射）、§6.5.1 L436–439（pause/defer 由选模输出、adapter 必须尊重）、.s2d/plan.md §2 M6-4。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCodexAdapter } from '../../../../packages/donego-bridge/src/codex/adapter.mjs';
import { fakeSessionFactory, callsOf, PLAN_FIXTURE, MISSION } from './_fake-codex.mjs';

const script = {
  initialize: () => ({ protocolVersion: 1 }),
  'thread/start': () => ({ threadId: 'th_1' }),
  'thread/goal/set': () => ({ ok: true }),
  'turn/start': p => (p.model === 'gpt-6-luna' ? { output: PLAN_FIXTURE } : { output: { status: 'completed', diff: 'diff --git' } }),
  'turn/steer': () => ({ ok: true }),
  'turn/interrupt': () => ({ ok: true }),
  'thread/fork': () => ({ threadId: 'th_2' }),
  'thread/revert': () => ({ ok: true }),
};

async function plannedAdapter(over = {}) {
  const factory = fakeSessionFactory(script);
  const adapter = createCodexAdapter({
    sessionFactory: factory,
    chooseModel: () => { throw new Error('execute 由调用方传 choice'); },
    chooseReviewModel: () => { throw new Error('评审测试在 review 文件'); },
    decideApproval: () => ({ decision: 'approve', reason: 'in scope' }),
    onNeed: () => {},
    now: () => 1_000,
    log: () => {},
    ...over,
  });
  await adapter.start();
  const mission = MISSION();
  const { threadId } = await adapter.plan(mission);
  factory.calls.length = 0; // 清掉 plan 阶段调用，专看 execute
  return { adapter, factory, mission, threadId };
}

test('execute：model/effort 用 choice（M3 选模结果），沙箱 workspace-write 且可写根=worktree', async () => {
  const { adapter, factory, mission } = await plannedAdapter();
  const out = await adapter.execute(mission.missionId, { model: 'gpt-6-sol', effort: 'medium', reason: '标准', quotaSnapshot: {} });
  const turn = callsOf(factory, 'turn/start').at(-1);
  assert.equal(turn.params.model, 'gpt-6-sol');
  assert.equal(turn.params.effort, 'medium');
  assert.equal(turn.params.sandbox?.mode, 'workspace-write', '执行回合必须 workspace-write');
  assert.deepEqual(turn.params.sandbox?.writableRoots, [mission.worktree], '可写仅限 worktree（PRD L415/L441）');
  assert.equal(turn.params.threadId, 'th_1');
  assert.deepEqual(out.output, { status: 'completed', diff: 'diff --git' });
});

test('execute 尊重选模 pause：不发 turn，返回 {paused:true}', async () => {
  const { adapter, factory } = await plannedAdapter();
  const out = await adapter.execute('m1', { pause: true, reason: 'SPEND_CONTROL_REACHED' });
  assert.equal(out.paused, true);
  assert.equal(callsOf(factory, 'turn/start').length, 0, '暂停绝不发起执行回合');
});

test('execute 尊重选模 defer：不发 turn，返回 {deferred:true}（让路排队）', async () => {
  const { adapter, factory } = await plannedAdapter();
  const out = await adapter.execute('m1', { defer: true, reason: 'YIELD_TO_INTERACTIVE' });
  assert.equal(out.deferred, true);
  assert.equal(callsOf(factory, 'turn/start').length, 0);
});

test('审批·approve：decideApproval=approve → 立即回 JSON-RPC 响应 approved，不产生 Need', async () => {
  const { adapter, factory } = await plannedAdapter({
    decideApproval: () => ({ decision: 'approve', reason: 'in worktree+deliverables' }),
  });
  const reply = factory.serverRequest('item/commandExecution/requestApproval', { command: 'node --test', cwd: '/wt/mission-m1' });
  assert.deepEqual(await reply, { result: { decision: 'approved' } });
  assert.equal(factory.unrepliedCount(), 0);
});

test('审批·reject：黑名单命中 → 回 denied，不产生 Need', async () => {
  const { adapter } = await plannedAdapter({
    decideApproval: () => ({ decision: 'reject', reason: 'HIGH_RISK_COMMAND rm -rf' }),
  });
  const reply = factory.serverRequest('applyPatchApproval', { patch: 'x' });
  assert.deepEqual(await reply, { result: { decision: 'denied' } });
});

test('审批·need：范围外 → 挂起（不回包）+ onNeed 上报，等 JC 决定后再回', async () => {
  const needs = [];
  const { adapter, factory } = await plannedAdapter({
    decideApproval: () => ({ decision: 'need', reason: 'NET_INSTALL', need: { missionId: 'm1' } }),
    onNeed: n => needs.push(n),
  });
  const reply = factory.serverRequest('item/commandExecution/requestApproval', { command: 'npm install x', cwd: '/wt/mission-m1' });
  await new Promise(r => setTimeout(r, 50));
  assert.equal(factory.unrepliedCount(), 1, 'need 决策不能擅自回包（挂起）');
  assert.equal(needs.length, 1, '必须上报 Need 事件');
  assert.equal(needs[0].method, 'item/commandExecution/requestApproval');
  assert.ok(needs[0].requestId, 'Need 载荷带 requestId，供 JC 决定后回包');
  assert.equal(needs[0].reason, 'NET_INSTALL');
  void reply;
});

test('审批请求原样喂给 decideApproval（含 method/params 与 mission 上下文）', async () => {
  const seen = [];
  const { adapter, factory } = await plannedAdapter({ decideApproval: (req, contract, ctx) => { seen.push({ req, contract, ctx }); return { decision: 'approve', reason: 'x' }; } });
  await factory.serverRequest('item/fileChange/requestApproval', { path: 'src/a.mjs', changeKind: 'write' });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].req.method, 'item/fileChange/requestApproval');
  assert.equal(seen[0].req.params.path, 'src/a.mjs');
  assert.ok(seen[0].contract, '注入合同（worktree+deliverables）');
});

test('steer：turn/steer 注入讨论补丁，不重开 thread（PRD L416）', async () => {
  const { adapter, factory } = await plannedAdapter();
  await adapter.steer('m1', '改用防抖而不是节流');
  const s = callsOf(factory, 'turn/steer').at(-1);
  assert.equal(s.params.threadId, 'th_1');
  assert.match(JSON.stringify(s.params), /防抖/);
  assert.equal(callsOf(factory, 'thread/start').length, 0, 'steer 不得重开 thread');
});

test('interrupt：turn/interrupt（PRD L417）', async () => {
  const { adapter, factory } = await plannedAdapter();
  await adapter.interrupt('m1');
  assert.equal(callsOf(factory, 'turn/interrupt').length, 1);
});

test('fork / revert：thread/fork 返回新 threadId；thread/revert 带回退目标（PRD L418）', async () => {
  const { adapter, factory } = await plannedAdapter();
  const f = await adapter.fork('m1');
  assert.equal(f.threadId, 'th_2');
  assert.equal(callsOf(factory, 'thread/fork').at(-1).params.threadId, 'th_1');
  await adapter.revert('m1', 'checkpoint-3');
  const r = callsOf(factory, 'thread/revert').at(-1);
  assert.equal(r.params.threadId, 'th_1');
  assert.equal(r.params.checkpoint, 'checkpoint-3');
});

test('未知 mission：execute/steer → MISSION_NOT_FOUND（threads 注册表，plan 先行）', async () => {
  const { adapter } = await plannedAdapter();
  await assert.rejects(() => adapter.execute('ghost', { model: 'gpt-6-sol', effort: 'medium' }), /MISSION_NOT_FOUND/);
  await assert.rejects(() => adapter.steer('ghost', 'x'), /MISSION_NOT_FOUND/);
});
