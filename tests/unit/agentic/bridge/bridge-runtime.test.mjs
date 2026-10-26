// M8 bridge-runtime 单测（TDD RED 先行）。
// 契约来源：PRD §6.5 L412（每 Mission 一个 thread+worktree）、L441（离线→blocked(need: 打开本机桥)）、
// V3-19（interrupt 恢复前重新校验合同 hash）、§8.1（规范化 JSON 的 SHA-256）、.s2d/plan.md §2 M8。
// 假 adapter（M6 接口）+ 假 worktree 管理器注入；W0 未冻结，hash 按 PRD §8.1 最小自实现（待裁决 5）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBridgeRuntime, hashContract } from '../../../../packages/donego-bridge/src/runtime/session.mjs';

const PLAN = {
  files: ['src/a.mjs'], summary: 'x', estimatedDiffLines: 40, kinds: ['code'],
  crossModule: false, riskFlags: [], needsNewTests: true,
  signals: { architecture: false, concurrency: false, performance: false, security: false, dataMigration: false },
};
const CONTRACT = () => ({
  id: 'c1', missionId: 'm1', goal: 'g', summary: 's',
  definitionOfDone: ['单测全绿'], deliverables: ['src/**'],
});

function fakeAdapter() {
  const ops = [];
  let needHandler = null;
  const threads = new Map();
  const adapter = {
    ops,
    start: async () => ops.push({ op: 'start' }),
    plan: async m => { ops.push({ op: 'plan', m }); threads.set(m.missionId, 'th_1'); return { threadId: 'th_1', plan: PLAN }; },
    adoptThread: (missionId, threadId) => { ops.push({ op: 'adoptThread', missionId, threadId }); threads.set(missionId, threadId); },
    execute: async (missionId, choice) => { ops.push({ op: 'execute', missionId, choice }); return { output: { status: 'completed' } }; },
    steer: async (m, text) => { ops.push({ op: 'steer', m, text }); },
    interrupt: async m => { ops.push({ op: 'interrupt', m }); },
    resume: async m => { ops.push({ op: 'resume', m }); return { ok: true }; },
    fork: async m => { ops.push({ op: 'fork', m }); return { threadId: 'th_2' }; },
    revert: async (m, ref) => { ops.push({ op: 'revert', m, ref }); },
    review: async (m, diff, choice) => { ops.push({ op: 'review', m, diff, choice }); return { verdict: 'pass', findings: [] }; },
    rateLimits: async () => ({ weeklyUsedPercent: 10, spendControlReached: false, activeForeignThreads: 0 }),
    threadOf: m => threads.get(m),
  };
  return {
    adapter,
    makeAdapter: hooks => { needHandler = hooks.onNeed; return adapter; },
    emitNeed: n => needHandler?.(n),
  };
}

function fakeWorktrees() {
  const created = [];
  return {
    created,
    create: async missionId => { const p = `/wt/mission-${missionId}`; created.push({ missionId, p }); return { path: p, branch: `feat/donego-${missionId}` }; },
    cleanup: async () => {},
  };
}

function makeRuntime(over = {}) {
  const fake = fakeAdapter();
  const worktrees = fakeWorktrees();
  const events = [];
  const stateDir = mkdtempSync(join(tmpdir(), 'donego-rt-'));
  const stateFile = join(stateDir, 'runtime-state.json');
  const chooseCalls = [];
  const runtime = createBridgeRuntime({
    makeAdapter: fake.makeAdapter,
    worktrees,
    repoRoot: '/repo',
    chooseModel: (...a) => { chooseCalls.push(a); return over.choice ?? { model: 'gpt-6-sol', effort: 'medium', reason: '标准', quotaSnapshot: {} }; },
    chooseReviewModel: exec => ({ model: exec.model.includes('sol') ? 'gpt-6-luna' : 'gpt-6-sol', effort: exec.model.includes('sol') ? 'high' : 'medium' }),
    sendEvent: e => events.push(e),
    stateFile,
    now: () => 1_000,
    log: () => {},
  });
  return { runtime, fake, worktrees, events, stateFile, chooseCalls, cleanup: () => rmSync(stateDir, { recursive: true, force: true }) };
}

test('mission.plan：先建 worktree（每 Mission 一个），再 adapter.plan，向上发 planned 事件', async () => {
  const t = makeRuntime();
  try {
    await t.runtime.handleCommand({ type: 'mission.plan', mission: { missionId: 'm1', contract: CONTRACT() } });
    assert.deepEqual(t.worktrees.created, [{ missionId: 'm1', p: '/wt/mission-m1' }], '先建 worktree');
    const planned = t.fake.adapter.ops.find(o => o.op === 'plan');
    assert.equal(planned.m.worktree, '/wt/mission-m1', 'adapter.plan 拿到 worktree 路径');
    assert.ok(t.events.some(e => e.type === 'mission.planned' && e.missionId === 'm1' && e.plan === PLAN));
  } finally { t.cleanup(); }
});

test('mission.plan 后 threadId 持久化到 stateFile（重启可恢复，PRD L412 thread/resume）', async () => {
  const t = makeRuntime();
  try {
    await t.runtime.handleCommand({ type: 'mission.plan', mission: { missionId: 'm1', contract: CONTRACT() } });
    const saved = JSON.parse(readFileSync(t.stateFile, 'utf8'));
    assert.equal(saved.missions?.m1?.threadId ?? saved.m1?.threadId, 'th_1', 'stateFile 记录 missionId→threadId');
  } finally { t.cleanup(); }
});

test('mission.execute：chooseModel(plan, rateLimits, history) 驱动执行并回传结果', async () => {
  const t = makeRuntime();
  try {
    await t.runtime.handleCommand({ type: 'mission.plan', mission: { missionId: 'm1', contract: CONTRACT() } });
    await t.runtime.handleCommand({ type: 'mission.execute', missionId: 'm1' });
    assert.equal(t.chooseCalls.length, 1);
    assert.equal(t.chooseCalls[0][0], PLAN, '第一参数=plan 结果');
    assert.ok(t.chooseCalls[0][1] && typeof t.chooseCalls[0][1].weeklyUsedPercent === 'number', '第二参数=额度快照');
    const exec = t.fake.adapter.ops.find(o => o.op === 'execute');
    assert.equal(exec.missionId, 'm1');
    assert.equal(exec.choice.model, 'gpt-6-sol');
    assert.ok(t.events.some(e => e.type === 'mission.executed'));
  } finally { t.cleanup(); }
});

test('mission.execute：选模 pause → 不执行、上抛暂停事件（spendControlReached 全停，§6.5.1 L437）', async () => {
  const t = makeRuntime({ choice: { pause: true, reason: 'SPEND_CONTROL_REACHED' } });
  try {
    await t.runtime.handleCommand({ type: 'mission.plan', mission: { missionId: 'm1', contract: CONTRACT() } });
    await t.runtime.handleCommand({ type: 'mission.execute', missionId: 'm1' });
    assert.equal(t.fake.adapter.ops.filter(o => o.op === 'execute').length, 0);
    assert.ok(t.events.some(e => e.type === 'mission.paused' && /SPEND|暂停/.test(e.reason ?? '')));
  } finally { t.cleanup(); }
});

test('mission.execute：选模 defer → 排队不执行、上抛让路事件（§6.5.1 L438）', async () => {
  const t = makeRuntime({ choice: { defer: true, reason: 'YIELD_TO_INTERACTIVE' } });
  try {
    await t.runtime.handleCommand({ type: 'mission.plan', mission: { missionId: 'm1', contract: CONTRACT() } });
    await t.runtime.handleCommand({ type: 'mission.execute', missionId: 'm1' });
    assert.equal(t.fake.adapter.ops.filter(o => o.op === 'execute').length, 0);
    assert.ok(t.events.some(e => e.type === 'mission.deferred'));
  } finally { t.cleanup(); }
});

test('Need 上行：adapter 审批 need → sendEvent({type:"need"})（PRD L420 范围外升级 Need）', async () => {
  const t = makeRuntime();
  try {
    await t.runtime.handleCommand({ type: 'mission.plan', mission: { missionId: 'm1', contract: CONTRACT() } });
    t.fake.emitNeed({ method: 'item/commandExecution/requestApproval', requestId: 901, reason: 'NET_INSTALL' });
    const need = t.events.find(e => e.type === 'need');
    assert.ok(need, '必须上抛 need 事件');
    assert.equal(need.requestId, 901);
    assert.equal(need.reason, 'NET_INSTALL');
  } finally { t.cleanup(); }
});

test('mission.review：评审用「不同档」选模结果调 adapter.review，结论上抛（PRD L419）', async () => {
  const t = makeRuntime();
  try {
    await t.runtime.handleCommand({ type: 'mission.plan', mission: { missionId: 'm1', contract: CONTRACT() } });
    await t.runtime.handleCommand({ type: 'mission.execute', missionId: 'm1' });
    await t.runtime.handleCommand({ type: 'mission.review', missionId: 'm1', diff: 'diff --git …' });
    const rv = t.fake.adapter.ops.find(o => o.op === 'review');
    assert.equal(rv.choice.model, 'gpt-6-luna', 'sol 执行 → luna/high 评审');
    assert.equal(rv.choice.effort, 'high');
    assert.equal(rv.diff, 'diff --git …');
    assert.ok(t.events.some(e => e.type === 'mission.reviewed' && e.verdict === 'pass'));
  } finally { t.cleanup(); }
});

test('V3-19：interrupt 后 resume 必须重验合同 hash；不一致 → CONTRACT_HASH_MISMATCH 且不 resume', async () => {
  const t = makeRuntime();
  try {
    const c = CONTRACT();
    await t.runtime.handleCommand({ type: 'mission.plan', mission: { missionId: 'm1', contract: c } });
    await t.runtime.handleCommand({ type: 'mission.interrupt', missionId: 'm1' });
    await assert.rejects(
      () => t.runtime.handleCommand({ type: 'mission.resume', missionId: 'm1', contract: { ...c, goal: '被篡改' } }),
      /CONTRACT_HASH_MISMATCH/,
    );
    assert.equal(t.fake.adapter.ops.filter(o => o.op === 'resume').length, 0, 'hash 不符绝不 resume');
    await t.runtime.handleCommand({ type: 'mission.resume', missionId: 'm1', contract: c });
    assert.equal(t.fake.adapter.ops.filter(o => o.op === 'resume').length, 1, 'hash 一致才 resume');
  } finally { t.cleanup(); }
});

test('离线：连接断开 → 上抛 blocked(need: 打开本机桥)（PRD L441）', async () => {
  const t = makeRuntime();
  try {
    await t.runtime.handleCommand({ type: 'mission.plan', mission: { missionId: 'm1', contract: CONTRACT() } });
    t.events.length = 0;
    t.runtime.setConnectionState(false);
    const blocked = t.events.find(e => e.type === 'blocked');
    assert.ok(blocked, '必须发 blocked 事件');
    assert.match(String(blocked.need), /打开本机桥|open_bridge/);
  } finally { t.cleanup(); }
});

test('重启恢复：新 runtime 读同一 stateFile → adoptThread 恢复 mission→thread 映射', async () => {
  const t = makeRuntime();
  try {
    await t.runtime.handleCommand({ type: 'mission.plan', mission: { missionId: 'm1', contract: CONTRACT() } });
    const t2 = makeRuntime();
    try {
      await t2.runtime.handleCommand({ type: 'mission.execute', missionId: 'm1' });
      const adopt = t2.fake.adapter.ops.find(o => o.op === 'adoptThread');
      assert.ok(adopt, '恢复时必须把持久化 threadId 交还 adapter');
      assert.equal(adopt.missionId, 'm1');
      assert.equal(adopt.threadId, 'th_1');
      assert.ok(t2.fake.adapter.ops.some(o => o.op === 'execute'), '恢复后可继续执行');
    } finally { t2.cleanup(); }
  } finally { t.cleanup(); }
});

test('hashContract（PRD §8.1 最小自实现）：键序无关、任一字段变则变、64 位十六进制', () => {
  const a = { id: 'c1', goal: 'g', wont: ['x'], nested: { b: 2, a: 1 } };
  const b = { nested: { a: 1, b: 2 }, wont: ['x'], goal: 'g', id: 'c1' };
  const h1 = hashContract(a);
  assert.match(h1, /^[0-9a-f]{64}$/);
  assert.equal(hashContract(b), h1, '字段顺序不同 hash 相同');
  assert.notEqual(hashContract({ ...a, goal: 'g2' }), h1, '任一字段变化 hash 变化');
});
