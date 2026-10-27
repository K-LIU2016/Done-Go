// W7 M2 · runtime-store 单测（测试先行 · RED 基线）
//
// 钉住 `scripts/agentic/runtime/store.mjs` + `scripts/agentic/db/migrations/w7-1-runtime-store.sql`
// 的契约（plan.md M2）。实现节点让本文件全绿；表结构是实现自由，但行为必须如下。
//
// 契约（brief 裁决⑥：owner 过滤 / 幂等 / 乐观锁 / 检查点）：
//   createRuntimeStore({ db })                     // db 缺失 → fail closed
//   saveWorkOrder({ ownerId, workOrder, idempotencyKey })
//     → { record, replayed }  同 key 同载 → replayed:true 不重复插入
//       同 key 异载 → CONFLICT；owner_id 参与唯一约束（跨 owner 同 key 互不冲突）
//   getWorkOrder({ ownerId, orderId })             // 跨 owner → null（NOT_FOUND 语义，不泄露存在性）
//   updateWorkOrder({ ownerId, orderId, expectedRevision, workOrder })
//     → { record }  旧 revision → CONFLICT；跨 owner → 抛 NOT_FOUND
//   saveWorkResult({ ownerId, result }) / getWorkResult({ ownerId, orderId })   // 跨 owner → null
//   recordStep({ ownerId, step }) → { record, replayed }
//     同 id + 同 inputHash → replayed:true（走检查点重放而非重执行）
//   updateStepState({ ownerId, stepId, state, checkpoint?, attempt? }) → { record }
//     非法跃迁（succeeded→running 等）→ CONFLICT；跨 owner → NOT_FOUND
//   listSteps({ ownerId, runId })                  // 只回该 owner 的行
//   recordUnknownOutcome({ ownerId, runId, stepId, source, detail }) → { record }  // 只记账，绝不触发重试
//   listUnknownOutcomes({ ownerId })               // 跨 owner 隔离
// step.state 遵循冻结 step.schema.json 枚举 pending/running/succeeded/failed/paused/skipped
// （UNKNOWN 是 run 级语义：记 unknown_outcomes 台账，不是 step 状态 —— 见 plan.md mismatch #1）
import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openAgenticDb, migrate } from '../../../../scripts/agentic/db/index.mjs';
import { createRuntimeStore } from '../../../../scripts/agentic/runtime/store.mjs';
import { loadSchema, validate } from '../../../../scripts/agentic/contracts.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../../../');
const migrationsDir = join(root, 'scripts/agentic/db/migrations');
const contractDir = join(root, 'contracts/agentic');
const stepSchema = loadSchema('step.schema.json', contractDir);

function freshStore() {
  const db = openAgenticDb(':memory:');
  migrate(db, migrationsDir);
  return { store: createRuntimeStore({ db }), db };
}

function validWorkOrder(overrides = {}) {
  return {
    id: 'wo-1',
    parentStepId: 'step-root',
    role: 'researcher',
    objective: 'summarize inbox',
    inputs: [{ artifactId: 'a-1' }],
    acceptance: ['has citations'],
    constraints: { mustNot: ['send email'] },
    budget: { calls: 3, tokens: 1000, deadline: '2026-10-27T12:00:00Z' },
    grants: [{ grantId: 'grant-1', scope: 'files.read:/Docs' }],
    output: { schema: { type: 'object' } },
    ...overrides,
  };
}

function validStep(overrides = {}) {
  return {
    id: 's-1', runId: 'run-1', name: 'draft', kind: 'execute',
    state: 'pending', attempt: 0,
    ...overrides,
  };
}

test('M2 · 迁移可重复执行且建出 w7 台账表（幂等）', () => {
  const db = openAgenticDb(':memory:');
  const applied1 = migrate(db, migrationsDir);
  assert.ok(applied1.includes('w7-1-runtime-store.sql'), `w7-1 must be applied, got ${applied1}`);
  const applied2 = migrate(db, migrationsDir);
  assert.deepEqual(applied2, [], 'rerun must apply nothing');
});

test('M2 负面 · db 缺失 → createRuntimeStore fail closed', () => {
  assert.throws(() => createRuntimeStore({}), /db/i);
  assert.throws(() => createRuntimeStore({ db: null }), /db/i);
});

test('M2 · saveWorkOrder 首写 → replayed:false，可按 owner 读回', () => {
  const { store } = freshStore();
  const workOrder = validWorkOrder();
  const { record, replayed } = store.saveWorkOrder({ ownerId: 'owner-1', workOrder, idempotencyKey: 'idem-1' });
  assert.equal(replayed, false);
  assert.equal(record.id, 'wo-1');
  assert.equal(record.ownerId, 'owner-1');
  assert.equal(record.revision, 1, '首写 revision=1');
  const back = store.getWorkOrder({ ownerId: 'owner-1', orderId: 'wo-1' });
  assert.equal(back.id, 'wo-1');
});

test('M2 · 幂等：同 key 同载 → replayed:true，不产生第二行', () => {
  const { store, db } = freshStore();
  const workOrder = validWorkOrder();
  store.saveWorkOrder({ ownerId: 'owner-1', workOrder, idempotencyKey: 'idem-1' });
  const again = store.saveWorkOrder({ ownerId: 'owner-1', workOrder, idempotencyKey: 'idem-1' });
  assert.equal(again.replayed, true);
  const count = db.prepare('SELECT COUNT(*) AS n FROM w7_work_orders').get();
  assert.equal(count.n, 1, 'idempotent replay must not insert a second row');
});

test('M2 负面 · idempotency key 同 key 异载 → CONFLICT，原行不被覆盖', () => {
  const { store } = freshStore();
  store.saveWorkOrder({ ownerId: 'owner-1', workOrder: validWorkOrder(), idempotencyKey: 'idem-1' });
  const different = validWorkOrder({ objective: 'different objective' });
  assert.throws(
    () => store.saveWorkOrder({ ownerId: 'owner-1', workOrder: different, idempotencyKey: 'idem-1' }),
    err => err.code === 'CONFLICT',
    'same idempotency key with different payload must CONFLICT',
  );
  const back = store.getWorkOrder({ ownerId: 'owner-1', orderId: 'wo-1' });
  assert.equal(back.objective, 'summarize inbox', 'original row untouched');
});

test('M2 · 跨 owner 同 idempotency key 互不冲突（owner_id 参与唯一约束）', () => {
  const { store } = freshStore();
  const a = store.saveWorkOrder({ ownerId: 'owner-1', workOrder: validWorkOrder(), idempotencyKey: 'shared-key' });
  const b = store.saveWorkOrder({
    ownerId: 'owner-2',
    workOrder: validWorkOrder({ id: 'wo-2', objective: 'other owner' }),
    idempotencyKey: 'shared-key',
  });
  assert.equal(a.replayed, false);
  assert.equal(b.replayed, false);
});

test('M2 负面 · 跨 owner 读取工单 → null（NOT_FOUND 语义，不泄露存在性）', () => {
  const { store } = freshStore();
  store.saveWorkOrder({ ownerId: 'owner-1', workOrder: validWorkOrder(), idempotencyKey: 'idem-1' });
  assert.equal(store.getWorkOrder({ ownerId: 'owner-2', orderId: 'wo-1' }), null);
  assert.equal(store.getWorkResult({ ownerId: 'owner-2', orderId: 'wo-1' }), null);
});

test('M2 · updateWorkOrder 带 revision 乐观锁，revision 递增', () => {
  const { store } = freshStore();
  store.saveWorkOrder({ ownerId: 'owner-1', workOrder: validWorkOrder(), idempotencyKey: 'idem-1' });
  const updated = store.updateWorkOrder({
    ownerId: 'owner-1', orderId: 'wo-1', expectedRevision: 1,
    workOrder: validWorkOrder({ objective: 'v2 objective' }),
  });
  assert.equal(updated.record.revision, 2);
});

test('M2 负面 · 旧 revision 写入 → CONFLICT', () => {
  const { store } = freshStore();
  store.saveWorkOrder({ ownerId: 'owner-1', workOrder: validWorkOrder(), idempotencyKey: 'idem-1' });
  store.updateWorkOrder({
    ownerId: 'owner-1', orderId: 'wo-1', expectedRevision: 1,
    workOrder: validWorkOrder({ objective: 'v2 objective' }),
  });
  // 当前 revision 已是 2；拿旧 revision=1 再写必须被拒
  assert.throws(
    () => store.updateWorkOrder({
      ownerId: 'owner-1', orderId: 'wo-1', expectedRevision: 1,
      workOrder: validWorkOrder({ objective: 'stale write' }),
    }),
    err => err.code === 'CONFLICT',
    'stale revision must CONFLICT',
  );
});

test('M2 负面 · 跨 owner 更新 → NOT_FOUND', () => {
  const { store } = freshStore();
  store.saveWorkOrder({ ownerId: 'owner-1', workOrder: validWorkOrder(), idempotencyKey: 'idem-1' });
  assert.throws(
    () => store.updateWorkOrder({
      ownerId: 'owner-2', orderId: 'wo-1', expectedRevision: 1,
      workOrder: validWorkOrder({ objective: 'hijack' }),
    }),
    err => err.code === 'NOT_FOUND',
  );
});

test('M2 · WorkResult 读写 + 跨 owner 隔离', () => {
  const { store } = freshStore();
  store.saveWorkOrder({ ownerId: 'owner-1', workOrder: validWorkOrder(), idempotencyKey: 'idem-1' });
  const result = {
    orderId: 'wo-1', status: 'done', artifacts: [{ artifactId: 'art-1' }],
    evidence: [{ type: 'test-run', title: 'unit tests' }],
    spent: { calls: 1, tokens: 10, costCny: 0, localShare: 0 },
    notes: 'ok',
  };
  store.saveWorkResult({ ownerId: 'owner-1', result });
  assert.equal(store.getWorkResult({ ownerId: 'owner-1', orderId: 'wo-1' }).status, 'done');
  assert.equal(store.getWorkResult({ ownerId: 'owner-2', orderId: 'wo-1' }), null);
});

// ---------------- steps ----------------

test('M2 · recordStep 首记 → replayed:false，记录可通过冻结 step.schema.json 校验', () => {
  const { store } = freshStore();
  const step = validStep({ inputHash: 'a'.repeat(64) });
  const { record, replayed } = store.recordStep({ ownerId: 'owner-1', step });
  assert.equal(replayed, false);
  const schemaView = validate(record, stepSchema, { schemaDir: contractDir });
  assert.equal(schemaView.valid, true, JSON.stringify(schemaView.errors));
});

test('M2 负面 · 重复 step（同 id + 同 inputHash）→ replayed:true，不重复执行不重复插入', () => {
  const { store, db } = freshStore();
  const inputHash = 'b'.repeat(64);
  store.recordStep({ ownerId: 'owner-1', step: validStep({ inputHash }) });
  const again = store.recordStep({ ownerId: 'owner-1', step: validStep({ inputHash }) });
  assert.equal(again.replayed, true, 'same id+inputHash must replay from checkpoint, not re-execute');
  const count = db.prepare('SELECT COUNT(*) AS n FROM w7_agent_steps WHERE id = ?').get('s-1');
  assert.equal(count.n, 1);
});

test('M2 · 同 id 但 inputHash 变化 → 新 attempt（不是 replay）', () => {
  const { store } = freshStore();
  store.recordStep({ ownerId: 'owner-1', step: validStep({ inputHash: 'c'.repeat(64) }) });
  const changed = store.recordStep({ ownerId: 'owner-1', step: validStep({ inputHash: 'd'.repeat(64) }) });
  assert.equal(changed.replayed, false);
});

test('M2 · updateStepState 合法跃迁 pending→running→succeeded 并落检查点', () => {
  const { store } = freshStore();
  store.recordStep({ ownerId: 'owner-1', step: validStep({ inputHash: 'e'.repeat(64) }) });
  const running = store.updateStepState({ ownerId: 'owner-1', stepId: 's-1', state: 'running', checkpoint: '{"after":"start"}' });
  assert.equal(running.record.state, 'running');
  assert.ok(running.record.checkpoint.includes('after'));
  const done = store.updateStepState({ ownerId: 'owner-1', stepId: 's-1', state: 'succeeded', checkpoint: '{"after":"done"}' });
  assert.equal(done.record.state, 'succeeded');
});

test('M2 · paused 是合法状态且携带检查点载荷（暂停/恢复只能从检查点继续）', () => {
  const { store } = freshStore();
  store.recordStep({ ownerId: 'owner-1', step: validStep({ id: 's-p', inputHash: 'f'.repeat(64) }) });
  const paused = store.updateStepState({
    ownerId: 'owner-1', stepId: 's-p', state: 'paused',
    checkpoint: JSON.stringify({ nextStep: 2, doneSteps: [1] }),
  });
  assert.equal(paused.record.state, 'paused');
  const row = store.listSteps({ ownerId: 'owner-1', runId: 'run-1' }).find(s => s.id === 's-p');
  assert.ok(row.checkpoint.includes('nextStep'), 'checkpoint payload must survive round-trip');
});

test('M2 负面 · 非法跃迁 succeeded→running → CONFLICT', () => {
  const { store } = freshStore();
  store.recordStep({ ownerId: 'owner-1', step: validStep({ id: 's-x', inputHash: '1'.repeat(64) }) });
  store.updateStepState({ ownerId: 'owner-1', stepId: 's-x', state: 'running' });
  store.updateStepState({ ownerId: 'owner-1', stepId: 's-x', state: 'succeeded' });
  assert.throws(
    () => store.updateStepState({ ownerId: 'owner-1', stepId: 's-x', state: 'running' }),
    err => err.code === 'CONFLICT',
    'terminal state must not transition back to running',
  );
});

test('M2 负面 · updateStepState 跨 owner → NOT_FOUND', () => {
  const { store } = freshStore();
  store.recordStep({ ownerId: 'owner-1', step: validStep({ inputHash: '2'.repeat(64) }) });
  assert.throws(
    () => store.updateStepState({ ownerId: 'owner-2', stepId: 's-1', state: 'running' }),
    err => err.code === 'NOT_FOUND',
  );
});

test('M2 负面 · step.state 必须落在冻结枚举内（unknown 不是 step 状态）', () => {
  const { store } = freshStore();
  store.recordStep({ ownerId: 'owner-1', step: validStep({ inputHash: '3'.repeat(64) }) });
  assert.throws(
    () => store.updateStepState({ ownerId: 'owner-1', stepId: 's-1', state: 'unknown' }),
    /state|CONTRACT/i,
    'frozen step.schema.json has no unknown state; UNKNOWN belongs to run level + ledger',
  );
});

test('M2 · listSteps 只回本 owner + 本 run 的行', () => {
  const { store } = freshStore();
  store.recordStep({ ownerId: 'owner-1', step: validStep({ id: 's-a', runId: 'run-a', inputHash: '4'.repeat(64) }) });
  store.recordStep({ ownerId: 'owner-1', step: validStep({ id: 's-b', runId: 'run-b', inputHash: '5'.repeat(64) }) });
  store.recordStep({ ownerId: 'owner-2', step: validStep({ id: 's-c', runId: 'run-a', inputHash: '6'.repeat(64) }) });
  const rows = store.listSteps({ ownerId: 'owner-1', runId: 'run-a' });
  assert.deepEqual(rows.map(r => r.id), ['s-a']);
});

// ---------------- unknown outcomes 台账（只对账、不自动重试） ----------------

test('M2 · recordUnknownOutcome 记台账；台账不产生任何重试副作用', () => {
  const { store } = freshStore();
  const { record } = store.recordUnknownOutcome({
    ownerId: 'owner-1', runId: 'run-1', stepId: 's-1',
    source: 'model-transport', detail: 'response carried no model attribution',
  });
  assert.equal(record.status, 'unknown');
  const rows = store.listUnknownOutcomes({ ownerId: 'owner-1' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].source, 'model-transport');
  // 台账只是记录：API 面上没有 retry/重新入队入口（见文件头契约清单）
});

test('M2 负面 · unknown 台账跨 owner 隔离', () => {
  const { store } = freshStore();
  store.recordUnknownOutcome({
    ownerId: 'owner-1', runId: 'run-1', stepId: 's-1',
    source: 'mcp-tool', detail: 'tool disconnected mid-call',
  });
  assert.deepEqual(store.listUnknownOutcomes({ ownerId: 'owner-2' }), []);
});

// ---------------- 补充（实现节点追加：fail-closed 分支 + 注入时钟，不削弱以上任何断言） ----------------

test('M2 补 · 空 ownerId → CONTRACT_INVALID（fail closed）', () => {
  const { store } = freshStore();
  assert.throws(
    () => store.saveWorkOrder({ ownerId: '', workOrder: validWorkOrder(), idempotencyKey: 'k' }),
    err => err.code === 'CONTRACT_INVALID',
  );
  assert.throws(
    () => store.saveWorkOrder({ ownerId: 'owner-1', workOrder: validWorkOrder(), idempotencyKey: '' }),
    err => err.code === 'CONTRACT_INVALID',
  );
});

test('M2 补负面 · 同 owner 同工单 id 换 idempotency key 再写 → CONFLICT', () => {
  const { store } = freshStore();
  store.saveWorkOrder({ ownerId: 'owner-1', workOrder: validWorkOrder(), idempotencyKey: 'idem-1' });
  assert.throws(
    () => store.saveWorkOrder({ ownerId: 'owner-1', workOrder: validWorkOrder(), idempotencyKey: 'idem-2' }),
    err => err.code === 'CONFLICT',
  );
});

test('M2 补负面 · updateWorkOrder：id 不匹配 / 非法 revision → CONTRACT_INVALID', () => {
  const { store } = freshStore();
  store.saveWorkOrder({ ownerId: 'owner-1', workOrder: validWorkOrder(), idempotencyKey: 'idem-1' });
  assert.throws(
    () => store.updateWorkOrder({
      ownerId: 'owner-1', orderId: 'wo-other', expectedRevision: 1,
      workOrder: validWorkOrder({ objective: 'x' }),
    }),
    err => err.code === 'CONTRACT_INVALID',
    'workOrder.id must match orderId',
  );
  assert.throws(
    () => store.updateWorkOrder({
      ownerId: 'owner-1', orderId: 'wo-1', expectedRevision: 0,
      workOrder: validWorkOrder({ objective: 'x' }),
    }),
    err => err.code === 'CONTRACT_INVALID',
    'expectedRevision must be a positive integer',
  );
  assert.throws(
    () => store.updateWorkOrder({
      ownerId: 'owner-1', orderId: 'missing', expectedRevision: 1,
      workOrder: validWorkOrder({ id: 'missing', objective: 'x' }),
    }),
    err => err.code === 'NOT_FOUND',
    'unknown order must be NOT_FOUND, not a silent insert',
  );
});

test('M2 补 · getWorkOrder/getWorkResult 对不存在 id → null', () => {
  const { store } = freshStore();
  assert.equal(store.getWorkOrder({ ownerId: 'owner-1', orderId: 'nope' }), null);
  assert.equal(store.getWorkResult({ ownerId: 'owner-1', orderId: 'nope' }), null);
});

test('M2 补负面 · saveWorkResult：工单不存在 → NOT_FOUND（不给悬空结果行）', () => {
  const { store } = freshStore();
  const result = {
    orderId: 'ghost', status: 'done', artifacts: [], evidence: [],
    spent: { calls: 0, tokens: 0 }, notes: '',
  };
  assert.throws(() => store.saveWorkResult({ ownerId: 'owner-1', result }), err => err.code === 'NOT_FOUND');
});

test('M2 补 · WorkResult 幂等：同载重放、异载 CONFLICT', () => {
  const { store } = freshStore();
  store.saveWorkOrder({ ownerId: 'owner-1', workOrder: validWorkOrder(), idempotencyKey: 'idem-1' });
  const result = {
    orderId: 'wo-1', status: 'done', artifacts: [], evidence: [],
    spent: { calls: 1, tokens: 5 }, notes: 'ok',
  };
  const first = store.saveWorkResult({ ownerId: 'owner-1', result });
  assert.equal(first.replayed, false);
  const replay = store.saveWorkResult({ ownerId: 'owner-1', result: { ...result } });
  assert.equal(replay.replayed, true, 'same result payload must replay, not duplicate');
  assert.throws(
    () => store.saveWorkResult({ ownerId: 'owner-1', result: { ...result, notes: 'different' } }),
    err => err.code === 'CONFLICT',
  );
});

test('M2 补 · updateStepState 支持 attempt 递进，且终态自跃迁也被拒', () => {
  const { store } = freshStore();
  store.recordStep({ ownerId: 'owner-1', step: validStep({ id: 's-att', inputHash: '7'.repeat(64) }) });
  const running = store.updateStepState({ ownerId: 'owner-1', stepId: 's-att', state: 'running', attempt: 1 });
  assert.equal(running.record.attempt, 1);
  store.updateStepState({ ownerId: 'owner-1', stepId: 's-att', state: 'failed' });
  assert.throws(
    () => store.updateStepState({ ownerId: 'owner-1', stepId: 's-att', state: 'failed', checkpoint: 'x' }),
    err => err.code === 'CONFLICT',
    'failed is terminal; even self-transition with a new checkpoint must be rejected',
  );
  assert.throws(
    () => store.updateStepState({ ownerId: 'owner-1', stepId: 'ghost-step', state: 'running' }),
    err => err.code === 'NOT_FOUND',
  );
});

test('M2 补 · recordStep 拒绝冻结枚举外的 state（CONTRACT_INVALID，经 schema 校验）', () => {
  const { store } = freshStore();
  assert.throws(
    () => store.recordStep({ ownerId: 'owner-1', step: validStep({ state: 'unknown', inputHash: '8'.repeat(64) }) }),
    err => err.code === 'CONTRACT_INVALID',
  );
});

test('M2 补 · now 可注入：recorded_at/updated_at 不依赖真实 wall clock', () => {
  const db = openAgenticDb(':memory:');
  migrate(db, migrationsDir);
  const fixed = '2026-10-27T08:00:00Z';
  let tick = 0;
  const store = createRuntimeStore({ db, now: () => { tick += 1; return `${fixed}#${tick}`; } });
  const { record } = store.recordUnknownOutcome({
    ownerId: 'owner-1', runId: 'run-1', stepId: null, source: 'test', detail: 'injected clock',
  });
  assert.equal(record.recordedAt, `${fixed}#1`);
  const rows = store.listUnknownOutcomes({ ownerId: 'owner-1' });
  assert.equal(rows[0].recordedAt, `${fixed}#1`);
  const saved = store.saveWorkOrder({ ownerId: 'owner-1', workOrder: validWorkOrder(), idempotencyKey: 'idem-c' });
  assert.ok(saved.record, 'injected-clock store still persists work orders');
});
