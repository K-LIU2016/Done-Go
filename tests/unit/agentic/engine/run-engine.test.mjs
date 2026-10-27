// S2D-W2 · M3 run-engine 单测（TDD 先行：本文件即 run-engine.mjs 的实现契约）
// 依据：BUILD-PLAN §3 W2-2 L107（DBOS：startRun、step 输入哈希+检查点重放跳过、
//       pause/resume/cancel、指数退避 ≤3、outbox）；PRD §6.3 L359–373（检查点、
//       不重复外部动作）、§11.5 L844–852（失败与恢复）、§4.2 L192（run 状态集）、
//       V3-19/20；.s2d/plan.md M3 subtasks 1–6。
//
// 被测契约：
//   createRunEngine({db, policy?, outbox?, now, sleep, retryBaseMs=100}) → engine
//     engine.startRun({missionId, contractHash, dod, budget}) → run 句柄
//     engine.attach(runId) → run 句柄（重启恢复入口）
//     engine.getRun(runId) → runs 行
//     overrunToOutcome('deliver_best'|'ask_extend'|'stop') → {status, need}（纯函数）
//   run 句柄：{ id, step(name, input, fn), pause(reason?), resume({revalidate?}),
//              cancel(reason?), finish({dodMet}), status() }
//     · step(name, input, fn)：input 为可 JSON 序列化对象，执行前算
//       stepInputHash(input) 落 run_steps.input_hash；命中同 name 已 done 且
//       hash 相同 → 直接取检查点结果，fn 不再执行（重放跳过，V3-20）
//     · fn(ctx)：ctx = { spend(cost), registerAction({actionKey, payload}) → entry,
//       db, runId, stepName }；执行前写 running 检查点，成功后 result+done 同事务提交
//     · 重试：fn 抛错 → attempt+1、sleep(base*2^(attempt-1))；attempt>3 → step failed；
//       有兄弟 step 已 done → run 置 partial，否则 failed（§11.5 部分交付语义）
//     · pause 后新 step 不启动（skipped:RUN_PAUSED）；resume 前必须重校验
//       contract_hash：revalidate()（默认返回库中存档 hash）不一致 →
//       paused_pending_confirm，不消费旧 Grant、不重试 unknown 动作（V3-19）
//     · cancel 终态；outbox 中该 run 的 registered 项不再派发
//     · 预算：ctx.spend 累计超过 budget 任一维度 → 下一次 step 返回
//       skipped:BUDGET_EXHAUSTED 且 run 置 paused（§6.3 L369 预算用尽→paused+Need）
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fakeClock, fakeSleeper, makeDb } from './helpers.mjs';
import { createRunEngine, overrunToOutcome } from '../../../../scripts/agentic/engine/run-engine.mjs';
import { createOutbox } from '../../../../scripts/agentic/engine/outbox.mjs';

const CONTRACT = 'a'.repeat(64);
const budget = () => ({ modelCalls: 40, tokens: 100000, costCap: null, localSlots: 1 });

function makeEngine(db, opts = {}) {
  const clock = opts.clock ?? fakeClock();
  const sleeper = fakeSleeper();
  const engine = createRunEngine({
    db, now: clock.now, sleep: sleeper.sleep, retryBaseMs: 100, ...opts.inject,
  });
  return { engine, clock, sleeper };
}

test('startRun persists a queued run with contract hash, budget snapshot and dod', () => {
  const db = makeDb();
  const { engine } = makeEngine(db);
  const run = engine.startRun({ missionId: 'm_1', contractHash: CONTRACT, dod: ['报告完成'], budget: budget() });
  assert.ok(run.id);
  const row = engine.getRun(run.id);
  assert.equal(row.status, 'queued');
  assert.equal(row.contract_hash, CONTRACT);
  assert.deepEqual(JSON.parse(row.budget_snapshot), budget());
  assert.equal(row.mission_id, 'm_1');
  db.close();
});

test('step happy path: running checkpoint → done with result + input_hash + spent', async () => {
  const db = makeDb();
  const { engine } = makeEngine(db);
  const run = engine.startRun({ missionId: 'm_1', contractHash: CONTRACT, dod: ['x'], budget: budget() });
  let seenDuringRun = null;
  const res = await run.step('fetch', { q: 'k12' }, async (ctx) => {
    seenDuringRun = db.prepare('SELECT status FROM run_steps WHERE run_id = ? AND name = ?').get(run.id, 'fetch').status;
    ctx.spend({ modelCalls: 1, tokens: 500 });
    return { docs: 3 };
  });
  assert.equal(seenDuringRun, 'running', 'fn 执行期间检查点必须已是 running');
  assert.equal(res.skipped, false);
  assert.deepEqual(res.result, { docs: 3 });
  const row = db.prepare('SELECT * FROM run_steps WHERE run_id = ? AND name = ?').get(run.id, 'fetch');
  assert.equal(row.status, 'done');
  assert.equal(row.attempt, 1);
  assert.ok(row.input_hash, 'input_hash 必须落库');
  assert.deepEqual(JSON.parse(row.result), { docs: 3 });
  assert.deepEqual(JSON.parse(row.spent), { modelCalls: 1, tokens: 500 }, '结构化花费记录（§6.3 L372）');
  assert.equal(engine.getRun(run.id).status, 'running');
  db.close();
});

test('replay: same step name + same input skips fn and returns checkpointed result (V3-20)', async () => {
  const db = makeDb();
  const { engine } = makeEngine(db);
  const run = engine.startRun({ missionId: 'm_1', contractHash: CONTRACT, dod: ['x'], budget: budget() });
  let calls = 0;
  await run.step('fetch', { q: 'k12' }, async () => { calls += 1; return { docs: 3 }; });
  // 模拟重启：attach 同一 run，重放同一 step 程序
  const reattached = engine.attach(run.id);
  const res = await reattached.step('fetch', { q: 'k12' }, async () => { calls += 1; return { docs: 999 }; });
  assert.equal(calls, 1, 'fn 不得重复执行');
  assert.equal(res.skipped, true);
  assert.deepEqual(res.result, { docs: 3 }, '结果取自检查点，而非新 fn');
  db.close();
});

test('replay with changed input re-executes (input hash differs)', async () => {
  const db = makeDb();
  const { engine } = makeEngine(db);
  const run = engine.startRun({ missionId: 'm_1', contractHash: CONTRACT, dod: ['x'], budget: budget() });
  await run.step('fetch', { q: 'k12' }, async () => 'first');
  const res = await run.step('fetch', { q: 'k12-v2' }, async () => 'second');
  assert.equal(res.skipped, false);
  assert.equal(res.result, 'second');
  db.close();
});

test('retry with exponential backoff, zero-wait injected sleep, succeeds on 3rd attempt', async () => {
  const db = makeDb();
  const { engine, sleeper } = makeEngine(db);
  const run = engine.startRun({ missionId: 'm_1', contractHash: CONTRACT, dod: ['x'], budget: budget() });
  let calls = 0;
  const res = await run.step('flaky', { n: 1 }, async () => {
    calls += 1;
    if (calls < 3) throw new Error('transient');
    return 'ok';
  });
  assert.equal(res.result, 'ok');
  assert.equal(res.attempt, 3);
  assert.deepEqual(sleeper.delays, [100, 200], '指数退避 base*2^n（注入 sleep 零等待）');
  const row = db.prepare('SELECT attempt, status FROM run_steps WHERE run_id = ? AND name = ?').get(run.id, 'flaky');
  assert.equal(row.attempt, 3);
  assert.equal(row.status, 'done');
  db.close();
});

test('step exhausting 3 attempts fails; run → partial when siblings done, failed otherwise (§11.5)', async () => {
  const db = makeDb();
  const { engine, sleeper } = makeEngine(db);
  const run = engine.startRun({ missionId: 'm_1', contractHash: CONTRACT, dod: ['x'], budget: budget() });
  await run.step('ok-step', { n: 1 }, async () => 'fine');
  const res = await run.step('bad-step', { n: 2 }, async () => { throw new Error('boom'); });
  assert.equal(res.failed, true);
  assert.equal(res.attempt, 3, 'attempt>3 即 failed：总共至多 3 次尝试');
  assert.deepEqual(sleeper.delays, [100, 200], '两次退避（3 次尝试之间）');
  const stepRow = db.prepare('SELECT status, error FROM run_steps WHERE run_id = ? AND name = ?').get(run.id, 'bad-step');
  assert.equal(stepRow.status, 'failed');
  assert.ok(stepRow.error.includes('boom'));
  assert.equal(engine.getRun(run.id).status, 'partial', '有已完成 step → 部分交付');

  const db2 = makeDb();
  const { engine: engine2 } = makeEngine(db2);
  const run2 = engine2.startRun({ missionId: 'm_2', contractHash: CONTRACT, dod: ['x'], budget: budget() });
  await run2.step('bad-only', { n: 1 }, async () => { throw new Error('boom'); });
  assert.equal(engine2.getRun(run2.id).status, 'failed', '无任何完成 step → failed');
  db.close(); db2.close();
});

test('pause blocks new steps; resume re-validates contract hash (V3-19 four elements)', async () => {
  const db = makeDb();
  const { engine } = makeEngine(db);
  const run = engine.startRun({ missionId: 'm_1', contractHash: CONTRACT, dod: ['x'], budget: budget() });
  await run.step('s1', { n: 1 }, async () => 1);
  run.pause('user');
  assert.equal(engine.getRun(run.id).status, 'paused');
  let calls = 0;
  const blocked = await run.step('s2', { n: 2 }, async () => { calls += 1; return 2; });
  assert.equal(calls, 0, 'pause 后新 step 不启动');
  assert.equal(blocked.skipped, true);
  assert.equal(blocked.reason, 'RUN_PAUSED');
  // hash 未变 → 正常续跑
  const resumed = await run.resume({ revalidate: async () => CONTRACT });
  assert.deepEqual(resumed, { resumed: true });
  assert.equal(engine.getRun(run.id).status, 'running');
  const after = await run.step('s2', { n: 2 }, async () => { calls += 1; return 2; });
  assert.equal(after.skipped, false);
  assert.equal(calls, 1);
  db.close();
});

test('resume with changed contract hash → paused_pending_confirm, run stays paused (V3-19)', async () => {
  const db = makeDb();
  const { engine } = makeEngine(db);
  const run = engine.startRun({ missionId: 'm_1', contractHash: CONTRACT, dod: ['x'], budget: budget() });
  await run.step('s1', { n: 1 }, async () => 1);
  run.pause('user');
  const res = await run.resume({ revalidate: async () => 'f'.repeat(64) }); // 合同变了
  assert.equal(res.resumed, false);
  assert.equal(res.reason, 'CONTRACT_CHANGED');
  assert.equal(engine.getRun(run.id).status, 'paused_pending_confirm');
  let calls = 0;
  const blocked = await run.step('s2', { n: 2 }, async () => { calls += 1; return 2; });
  assert.equal(calls, 0, '待确认期间不得继续执行');
  assert.equal(blocked.reason, 'RUN_PAUSED_PENDING_CONFIRM');
  // 用户确认新合同后（revalidate 返回新 hash 且与库中合同一致）可继续
  const ok = await run.resume({ revalidate: async () => CONTRACT });
  assert.equal(ok.resumed, true);
  db.close();
});

test('cancel is terminal: steps stop, status cancelled, registered outbox never dispatched', async () => {
  const db = makeDb();
  const outbox = createOutbox(db);
  const { engine } = makeEngine(db, { inject: { outbox } });
  const run = engine.startRun({ missionId: 'm_1', contractHash: CONTRACT, dod: ['x'], budget: budget() });
  await run.step('s1', { n: 1 }, async (ctx) => ctx.registerAction({ actionKey: 'ext-1', payload: { hello: 1 } }));
  const entry = db.prepare('SELECT * FROM outbox WHERE action_key = ?').get('ext-1');
  assert.equal(entry.status, 'registered');
  run.cancel('user');
  assert.equal(engine.getRun(run.id).status, 'cancelled');
  const blocked = await run.step('s2', { n: 2 }, async () => 2);
  assert.equal(blocked.skipped, true);
  assert.equal(blocked.reason, 'RUN_CANCELLED');
  const resumedAfterCancel = await run.resume({ revalidate: async () => CONTRACT }).then((r) => r.resumed, () => false);
  assert.equal(resumedAfterCancel, false, 'cancelled 不可 resume');
  let sends = 0;
  const d = await outbox.dispatch(outbox.get(entry.id), { send: async () => { sends += 1; return { externalId: 'x1' }; }, verify: async () => ({ ok: true }) });
  assert.equal(d.dispatched, false, 'cancel 后 registered 项不再派发');
  assert.equal(sends, 0);
  assert.equal(outbox.get(entry.id).status, 'cancelled');
  db.close();
});

test('registerAction inside step is idempotent on action_key and replay does not duplicate', async () => {
  const db = makeDb();
  const outbox = createOutbox(db);
  const { engine } = makeEngine(db, { inject: { outbox } });
  const run = engine.startRun({ missionId: 'm_1', contractHash: CONTRACT, dod: ['x'], budget: budget() });
  await run.step('ext-step', { n: 1 }, async (ctx) => {
    await ctx.registerAction({ actionKey: 'ext-1', payload: { a: 1 } });
    return 'done';
  });
  // 重放同一 step：fn 不执行 → 不重复登记
  const reattached = engine.attach(run.id);
  await reattached.step('ext-step', { n: 1 }, async (ctx) => {
    await ctx.registerAction({ actionKey: 'ext-1', payload: { a: 1 } });
    return 'done2';
  });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM outbox WHERE action_key = ?').get('ext-1').n, 1);
  db.close();
});

test('step that permanently fails marks its registered outbox entries failed (never dispatched)', async () => {
  const db = makeDb();
  const outbox = createOutbox(db);
  const { engine } = makeEngine(db, { inject: { outbox } });
  const run = engine.startRun({ missionId: 'm_1', contractHash: CONTRACT, dod: ['x'], budget: budget() });
  await run.step('doomed', { n: 1 }, async (ctx) => {
    await ctx.registerAction({ actionKey: 'ext-doomed', payload: {} });
    throw new Error('boom');
  });
  const row = db.prepare('SELECT status FROM outbox WHERE action_key = ?').get('ext-doomed');
  assert.equal(row.status, 'failed', 'step 终败后其未派发动作必须标记 failed，杜绝恢复期误派发');
  db.close();
});

test('budget exhaustion pauses the run before the next step (§6.3 L369)', async () => {
  const db = makeDb();
  const { engine } = makeEngine(db);
  const run = engine.startRun({ missionId: 'm_1', contractHash: CONTRACT, dod: ['x'], budget: { ...budget(), modelCalls: 2 } });
  await run.step('s1', { n: 1 }, async (ctx) => { ctx.spend({ modelCalls: 1 }); return 1; });
  await run.step('s2', { n: 2 }, async (ctx) => { ctx.spend({ modelCalls: 1 }); return 2; });
  let calls = 0;
  const res = await run.step('s3', { n: 3 }, async () => { calls += 1; return 3; });
  assert.equal(calls, 0, '预算用尽不再启动新 step');
  assert.equal(res.skipped, true);
  assert.equal(res.reason, 'BUDGET_EXHAUSTED');
  assert.equal(engine.getRun(run.id).status, 'paused');
  db.close();
});

test('finish({dodMet}) sets succeeded / partial; overrunToOutcome maps all three policies', async () => {
  const db = makeDb();
  const { engine } = makeEngine(db);
  const run = engine.startRun({ missionId: 'm_1', contractHash: CONTRACT, dod: ['x'], budget: budget() });
  await run.step('s1', { n: 1 }, async () => 1);
  await run.finish({ dodMet: true });
  assert.equal(engine.getRun(run.id).status, 'succeeded');

  const run2 = engine.startRun({ missionId: 'm_2', contractHash: CONTRACT, dod: ['x'], budget: budget() });
  await run2.step('s1', { n: 1 }, async () => 1);
  await run2.finish({ dodMet: false });
  assert.equal(engine.getRun(run2.id).status, 'partial', 'DoD 未全满足的完成 → partial');

  // §11.4 overrun 三策略映射（deliver_best=交付当前最好并标注未完成 → partial；
  // ask_extend → paused + Need；stop → cancelled）
  assert.deepEqual(overrunToOutcome('deliver_best'), { status: 'partial', need: null });
  assert.deepEqual(overrunToOutcome('ask_extend'), { status: 'paused', need: 'EXTEND_WINDOW' });
  assert.deepEqual(overrunToOutcome('stop'), { status: 'cancelled', need: null });
  db.close();
});
