// S2D-W2 · M6 crash-recovery 单测（TDD 先行）
// 依据：BUILD-PLAN §3 W2-4 L109 第一句「崩溃恢复（在 step 中途 kill 子进程后重启，
//       结果一致且外部动作不重复）、暂停后恢复必须重新校验合同 hash」；
//       PRD §11.5 L850（服务重启从检查点恢复、外部动作按 outbox 对账）、§4.2 L197
//       （V3-19 精准失效）；.s2d/plan.md M6 subtasks 1–4。
// 场景 A：step2 外部副作用已发生、send 未返回处 SIGKILL → 重启重放：
//         step1 结果逐字节一致、marker 恰好 1 行、run 终态 succeeded。
// 场景 B：暂停 + 合同变化（V3-19）：resume 前重校验，不一致停在
//         paused_pending_confirm，旧 Grant invalidated（未被消费），unknown 不盲重试。
// 场景 C：cancel 后 registered outbox 项不再派发、step 停止、终态 cancelled。
// 场景 D：resume 入口统一先重校验 hash：相同续跑 / 不同暂停待确认。
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { MIGRATIONS_DIR, fakeClock, makeDb, tempDir } from './helpers.mjs';
import { openEngineDb, applyEngineMigrations } from '../../../../scripts/agentic/engine/db.mjs';
import { createRunEngine } from '../../../../scripts/agentic/engine/run-engine.mjs';
import { createOutbox } from '../../../../scripts/agentic/engine/outbox.mjs';
import { createPolicyEngine } from '../../../../scripts/agentic/engine/policy.mjs';

const CONTRACT = 'a'.repeat(64);
const CHILD = fileURLToPath(new URL('./fixtures/child-run.mjs', import.meta.url));

function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function waitFor(predicate, { timeoutMs = 20_000, everyMs = 25 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await wait(everyMs);
  }
  return false;
}

function runChild(args, { timeoutMs = 30_000 } = {}) {
  let childProcess;
  const promise = new Promise((resolve, reject) => {
    const child = childProcess = spawn(process.execPath, [CHILD, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`child timeout: ${err || out}`)); }, timeoutMs);
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { err += c; });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('exit', (code, signal) => { clearTimeout(timer); resolve({ code, signal, out, err }); });
  });
  promise.child = childProcess;
  return promise;
}

test('scenario A: SIGKILL mid-step after external effect → restart replays consistently, no duplicate action', { timeout: 90_000 }, async () => {
  const dir = tempDir('s2d-crash-a-');
  const dbFile = join(dir, 'run.sqlite');
  const marker = join(dir, 'marker.txt');
  const statusFile = join(dir, 'status.json');
  try {
    const first = runChild(['--mode', 'initial', '--db', dbFile, '--marker', marker, '--status', statusFile]);
    const appeared = await waitFor(() => existsSync(marker));
    assert.equal(appeared, true, '外部动作标记文件必须出现（外部副作用已发生）');
    first.child.kill('SIGKILL'); // step2 中途 kill：副作用已发生、检查点未落
    const crashed = await first;
    assert.notEqual(crashed.signal ?? crashed.code, 0, '子进程必须是被杀/非零退出');

    const { runId, step1Result } = JSON.parse(readFileSync(statusFile, 'utf8'));
    assert.equal(step1Result, 'first-result');

    // 崩溃现场：step1 已 done；outbox 停在 dispatched（副作用已发生、未核验）；run 未终态
    const inspect = openEngineDb({ file: dbFile });
    applyEngineMigrations(inspect, MIGRATIONS_DIR);
    const step1Row = inspect.prepare('SELECT status, result FROM run_steps WHERE run_id = ? AND name = ?').get(runId, 'step1');
    assert.equal(step1Row.status, 'done');
    assert.equal(JSON.parse(step1Row.result), 'first-result');
    const entryRow = inspect.prepare('SELECT status FROM outbox WHERE action_key = ?').get('ext-marker');
    assert.equal(entryRow.status, 'dispatched', '崩溃点位：外部动作已派发、未核验');
    inspect.close();

    // 重启重放：resume 前重校验（hash 未变）→ 续跑完成
    const resumed = await runChild(['--mode', 'resume', '--db', dbFile, '--marker', marker, '--run', runId]);
    assert.equal(resumed.code, 0, `resume 子进程应成功退出：${resumed.err}`);
    const final = JSON.parse(resumed.out.trim().split('\n').pop());
    assert.equal(final.status, 'succeeded', 'run 终态 succeeded');

    // 外部动作恰好一次：marker 恰好 1 行 X
    const lines = readFileSync(marker, 'utf8').split('\n').filter((l) => l === 'X');
    assert.equal(lines.length, 1, `外部动作必须恰好发生 1 次，实际 ${lines.length} 次`);

    const verifyDb = openEngineDb({ file: dbFile });
    applyEngineMigrations(verifyDb, MIGRATIONS_DIR);
    // 已完成 step 结果与首跑逐字节一致（重放取检查点，不重算）
    const again = verifyDb.prepare('SELECT status, result FROM run_steps WHERE run_id = ? AND name = ?').get(runId, 'step1');
    assert.equal(again.status, 'done');
    assert.equal(JSON.parse(again.result), 'first-result', 'step1 结果与首跑逐字节一致');
    for (const name of ['step2', 'step3']) {
      assert.equal(verifyDb.prepare('SELECT status FROM run_steps WHERE run_id = ? AND name = ?').get(runId, name).status, 'done');
    }
    const outboxFinal = verifyDb.prepare('SELECT status, external_id FROM outbox WHERE action_key = ?').get('ext-marker');
    assert.ok(['verified', 'unknown'].includes(outboxFinal.status), '重启后动作经对账收敛，且绝不重发');
    assert.equal(outboxFinal.external_id, 'ext-marker', '对账沿用原外部 ID（V3-22）');
    verifyDb.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('scenario B: paused run + changed contract → paused_pending_confirm, old grant invalidated not consumed, unknown not blindly retried (V3-19)', { timeout: 30_000 }, async () => {
  const db = makeDb();
  const clock = fakeClock('2026-10-26T09:30:00+08:00');
  const outbox = createOutbox({ db });
  const policy = createPolicyEngine({ db, now: clock.now });
  const engine = createRunEngine({ db, outbox, now: clock.now, sleep: async () => {}, retryBaseMs: 10 });
  const budget = { modelCalls: 40, tokens: 100000, costCap: null, localSlots: 1 };

  // step1 完成 + 一个 unknown 的外部动作（send 超时），随后暂停
  const run = engine.startRun({ missionId: 'm_b', contractHash: CONTRACT, dod: ['x'], budget });
  await run.step('s1', { n: 1 }, async (ctx) => {
    await ctx.registerAction({ actionKey: 'unk-1', payload: {} });
    return 'ok';
  });
  const entry = outbox.listByStatus('registered').find((e) => e.action_key === 'unk-1');
  await outbox.dispatch(entry, { send: async () => { throw new Error('ETIMEDOUT'); }, verify: async () => ({ ok: true }) });
  assert.equal(outbox.get(entry.id).status, 'unknown');
  run.pause('user');
  const pausedRun = engine.attach(run.id);
  assert.equal(engine.getRun(run.id).status, 'paused');

  // 签约发放 Grant，随后合同变化
  const normalized = await policy.normalizeContract({
    id: 'c_1', missionId: 'm_b', version: 1, autonomy: 'A2',
    will: [], wont: [], dataDisclosure: [{ dataClass: 'public', to: 'cloud-model', fields: ['*'] }],
    budget, window: { prepStart: '2026-10-26T08:00:00+08:00', start: '2026-10-26T09:00:00+08:00', end: '2026-10-26T12:00:00+08:00', overrun: 'stop' },
  });
  const grant = await policy.grantIssue({ ownerId: 'o', actor: 'block-agent', contractHash: normalized.hash, capabilities: ['fs.read'], scope: { folders: ['/d'] }, dataDisclosure: [{ dataClass: 'public', to: 'cloud-model', fields: ['*'] }], expiresAt: '2026-10-26T18:00:00+08:00' });
  await policy.grantActivate(grant.id);
  await policy.grantInvalidateForContract(normalized.hash, { reason: 'CONTRACT_CHANGED' });
  assert.equal(policy.getGrant(grant.id).status, 'invalidated', '旧 Grant 精准失效');
  assert.notEqual(policy.getGrant(grant.id).status, 'consumed', '旧 Grant 不得被消费');

  // resume 前重校验：hash 不一致 → paused_pending_confirm
  const mismatch = await pausedRun.resume({ revalidate: async () => 'b'.repeat(64) });
  assert.equal(mismatch.resumed, false);
  assert.equal(mismatch.reason, 'CONTRACT_CHANGED');
  assert.equal(engine.getRun(run.id).status, 'paused_pending_confirm');

  // unknown 动作不盲重试：dispatch 拒绝，send 零调用
  let sends = 0;
  const unk = outbox.listByStatus('unknown').find((e) => e.action_key === 'unk-1');
  const d = await outbox.dispatch(unk, { send: async () => { sends += 1; return { externalId: 'n' }; }, verify: async () => ({ ok: true }) });
  assert.equal(d.dispatched, false);
  assert.equal(sends, 0, 'unknown 只可对账，禁止生成新 ID 重做');

  // hash 未变路径（回到一致）→ 正常续跑
  const ok = await pausedRun.resume({ revalidate: async () => CONTRACT });
  assert.equal(ok.resumed, true);
  const res = await pausedRun.step('s2', { n: 2 }, async () => 'after-resume');
  assert.equal(res.skipped, false);
  await pausedRun.finish({ dodMet: true });
  assert.equal(engine.getRun(run.id).status, 'succeeded');
  db.close();
});

test('scenario C: cancel stops steps, registered outbox never dispatched (also via recover), terminal cancelled', { timeout: 30_000 }, async () => {
  const db = makeDb();
  const clock = fakeClock('2026-10-26T09:30:00+08:00');
  const outbox = createOutbox({ db });
  const engine = createRunEngine({ db, outbox, now: clock.now, sleep: async () => {}, retryBaseMs: 10 });
  const run = engine.startRun({ missionId: 'm_c', contractHash: CONTRACT, dod: ['x'], budget: { modelCalls: 40, tokens: 100000, costCap: null, localSlots: 1 } });
  await run.step('s1', { n: 1 }, async (ctx) => ctx.registerAction({ actionKey: 'c-1', payload: {} }));
  run.cancel('user');
  assert.equal(engine.getRun(run.id).status, 'cancelled');
  const blocked = await run.step('s2', { n: 2 }, async () => 2);
  assert.equal(blocked.skipped, true, 'cancel 后 step 停止');
  let sends = 0;
  const stats = await createOutbox({ db }).recover({
    send: async () => { sends += 1; return { externalId: 'x' }; },
    verify: async () => ({ ok: true }),
    probe: async () => ({ status: 'verified' }),
  });
  assert.equal(sends, 0, '恢复期也绝不派发已取消 run 的 registered 项');
  assert.equal(stats.dispatched, 0);
  db.close();
});

test('scenario D: resume entry always revalidates contract hash — both branches (BUILD-PLAN L109)', { timeout: 30_000 }, async () => {
  const db = makeDb();
  const clock = fakeClock('2026-10-26T09:30:00+08:00');
  const engine = createRunEngine({ db, now: clock.now, sleep: async () => {}, retryBaseMs: 10 });
  const run = engine.startRun({ missionId: 'm_d', contractHash: CONTRACT, dod: ['x'], budget: { modelCalls: 40, tokens: 100000, costCap: null, localSlots: 1 } });
  await run.step('s1', { n: 1 }, async () => 1);
  run.pause('user');
  // 分支 1：hash 相同 → 续跑
  const same = await run.resume({ revalidate: async () => CONTRACT });
  assert.equal(same.resumed, true);
  await run.step('s2', { n: 2 }, async () => 2);
  // 分支 2：hash 不同 → 暂停待确认，不再执行
  run.pause('user');
  const diff = await run.resume({ revalidate: async () => 'c'.repeat(64) });
  assert.equal(diff.resumed, false);
  assert.equal(diff.reason, 'CONTRACT_CHANGED');
  assert.equal(engine.getRun(run.id).status, 'paused_pending_confirm');
  const blocked = await run.step('s3', { n: 3 }, async () => 3);
  assert.equal(blocked.skipped, true);
  db.close();
});
