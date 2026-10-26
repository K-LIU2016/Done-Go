// M6 codex-adapter · review 与额度/线程读取单测（TDD RED 先行）。
// 契约来源：PRD §6.5 L419（review/start 用与执行「不同档」模型）、L421（account/rateLimits/read、
// model/list、thread/loaded/list 驱动降档与让路）、§6.5.1 评审行、.s2d/plan.md §2 M6-2/3。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCodexAdapter } from '../../../../packages/donego-bridge/src/codex/adapter.mjs';
import { fakeSessionFactory, callsOf, PLAN_FIXTURE, MISSION } from './_fake-codex.mjs';

const RATE_LIMITS = { weeklyUsedPercent: 42, spendControlReached: false, activeForeignThreads: 1 };

const script = {
  initialize: () => ({ protocolVersion: 1 }),
  'thread/start': () => ({ threadId: 'th_1' }),
  'thread/goal/set': () => ({ ok: true }),
  'turn/start': p => (p.model === 'gpt-6-luna' ? { output: PLAN_FIXTURE } : { output: { status: 'completed' } }),
  'review/start': () => ({ findings: [{ severity: 'medium', note: '缺错误分支测试' }], verdict: 'needs_work' }),
  'account/rateLimits/read': () => RATE_LIMITS,
  'model/list': () => ({ models: [{ id: 'gpt-6-luna' }, { id: 'gpt-6-sol' }, { id: 'gpt-6.1-sol' }] }),
  'thread/loaded/list': () => ({ threads: [{ threadId: 't_x', cwd: '/other/project' }] }),
};

async function reviewReady(over = {}) {
  const factory = fakeSessionFactory(script);
  const adapter = createCodexAdapter({
    sessionFactory: factory,
    chooseModel: () => { throw new Error('不在本文件'); },
    chooseReviewModel: exec => (exec.model.includes('sol')
      ? { model: 'gpt-6-luna', effort: 'high' }
      : { model: 'gpt-6-sol', effort: 'medium' }),
    decideApproval: () => ({ decision: 'approve', reason: 'x' }),
    onNeed: () => {},
    now: () => 1_000,
    log: () => {},
    ...over,
  });
  await adapter.start();
  await adapter.plan(MISSION());
  factory.calls.length = 0;
  return { adapter, factory };
}

test('review：sol 系执行后评审用 luna/high（不同档），diff 原样进 review/start', async () => {
  const { adapter, factory } = await reviewReady();
  const exec = { model: 'gpt-6-sol', effort: 'medium' };
  const out = await adapter.review('m1', 'diff --git a/src/a.mjs …', exec);
  const rs = callsOf(factory, 'review/start').at(-1);
  assert.equal(rs.params.model, 'gpt-6-luna', '评审模型=不同档（luna 系）');
  assert.equal(rs.params.effort, 'high');
  assert.equal(rs.params.model, 'gpt-6-luna');
  assert.equal(rs.params.diff, 'diff --git a/src/a.mjs …');
  assert.equal(rs.params.threadId, 'th_1');
  assert.deepEqual(out.findings, [{ severity: 'medium', note: '缺错误分支测试' }]);
  assert.equal(out.verdict, 'needs_work', '评审意见原样回传（进证据区，PRD L419）');
});

test('review：luna 执行后评审用 sol/medium（反向不同档）', async () => {
  const { adapter, factory } = await reviewReady();
  await adapter.review('m1', 'diff', { model: 'gpt-6-luna', effort: 'medium' });
  const rs = callsOf(factory, 'review/start').at(-1);
  assert.equal(rs.params.model, 'gpt-6-sol');
  assert.equal(rs.params.effort, 'medium');
});

test('review 负例：mission 未规划（无 thread）→ MISSION_NOT_FOUND', async () => {
  const { adapter } = await reviewReady();
  await assert.rejects(() => adapter.review('ghost', 'diff', { model: 'gpt-6-sol', effort: 'medium' }), /MISSION_NOT_FOUND/);
});

test('rateLimits()：account/rateLimits/read 透传快照（M3 的输入）', async () => {
  const { adapter } = await reviewReady();
  assert.deepEqual(await adapter.rateLimits(), RATE_LIMITS);
});

test('listModels()：model/list 透传', async () => {
  const { adapter } = await reviewReady();
  const r = await adapter.listModels();
  assert.deepEqual(r.models.map(m => m.id), ['gpt-6-luna', 'gpt-6-sol', 'gpt-6.1-sol']);
});

test('listLoadedThreads()：thread/loaded/list 透传（让路检测的原始输入）', async () => {
  const { adapter } = await reviewReady();
  const r = await adapter.listLoadedThreads();
  assert.equal(r.threads[0].threadId, 't_x');
  assert.equal(r.threads[0].cwd, '/other/project');
});
