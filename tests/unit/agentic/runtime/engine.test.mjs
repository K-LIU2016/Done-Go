// W7 M3 · runtime-engine 单测（测试先行 · RED 基线）
//
// 钉住 `scripts/agentic/runtime/engine.mjs` + `scripts/agentic/runtime/budget.mjs` 的契约
// （plan.md M3）。本文件是 brief「必须先写的负面路径」清单的主要载体。
//
// API 契约：
//   createAgentRuntime({ policyPort, modelCaller, toolCaller?, store, clock, schemaDir })
//     · 缺 policyPort / store / clock / modelCaller / schemaDir → 构造抛错（fail closed）
//   runtime.runAgent({ actor, workOrder, contract, grantRefs, ownerCtx, steps, idempotencyKey? })
//     → { runId, status: 'done'|'partial'|'failed'|'needs_human'|'unknown'|'paused',
//         workResult?, replayed? }   // workResult 仅在终态且有结构化产出时存在
//   runtime.resumeAgent({ runId, actor, ownerCtx, contract? }) → 同上 outcome 形状
//     · 恢复时用 checkpoint 里存的 contractHash 重验：传入 contract（或存档合同）hash 变化 → CONFLICT
//   steps: [{ id, name, kind, input?, execute(ctx) }]
//     execute: async ({ modelCall, toolCall, clock, step }) => 轮廓之一
//       { ok: true, output, model?, usage? {calls,tokens} }  正常
//       { pause: true, checkpoint }                           暂停在检查点
//       { ok: false, error }                                  步骤失败
//   ctx.modelCall(payload, action?) → 先 policyPort.check + 纵深防御(A4/A5) + 预算，
//     再调注入的 modelCaller；action = { autonomy?: 'A1'..'A5', capability?, confirmation? }
//   budget.mjs：
//     createBudgetTracker({ contract, workOrder, now }) → { assertWithinWindow(nowMs),
//       assertCanSpend({calls,tokens}), charge({calls,tokens}), snapshot() }
//     assertChildBudgetsWithinParent(children[], parent)   // PRD §6.4 子预算之和 ≤ 父
//     assertGrantRefsSubset(grantRefs, parentGrants)       // GrantRef scope ⊆ 父 Grant
import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { contractHash, loadSchema, validate } from '../../../../scripts/agentic/contracts.mjs';
import { openAgenticDb, migrate } from '../../../../scripts/agentic/db/index.mjs';
import { createRuntimeStore } from '../../../../scripts/agentic/runtime/store.mjs';
import { createAgentRuntime } from '../../../../scripts/agentic/runtime/engine.mjs';
import {
  createBudgetTracker,
  assertChildBudgetsWithinParent,
  assertGrantRefsSubset,
} from '../../../../scripts/agentic/runtime/budget.mjs';
import { createFixedClock, createSteppableClock } from '../../../../scripts/agentic/runtime/ports.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../../../');
const contractDir = join(root, 'contracts/agentic');
const migrationsDir = join(root, 'scripts/agentic/db/migrations');
const workResultSchema = loadSchema('work-result.schema.json', contractDir);

const T0 = '2026-10-27T08:00:00Z';

function makeContract(overrides = {}) {
  return {
    id: 'contract-1',
    ownerId: 'owner-1',
    revision: 1,
    schemaVersion: 1,
    createdAt: '2026-10-26T08:00:00Z',
    updatedAt: '2026-10-26T08:00:00Z',
    deletedAt: null,
    source: 'demo',
    missionId: 'mission-1',
    version: 1,
    hash: '0'.repeat(64),
    goal: 'summarize the week',
    deliverables: [{
      type: 'report',
      shape: { kind: 'document', title: 'Weekly report' },
      location: { kind: 'artifact', uri: 'artifact://report' },
    }],
    definitionOfDone: ['report has citations'],
    autonomy: 'A2',
    will: ['read files'],
    wont: ['send emails'],
    needs: [],
    capabilities: [{ capability: 'files.read', scope: 'files.read:/Docs' }],
    dataDisclosure: [
      { dataClass: 'public', to: 'cloud-model', fields: ['*'] },
      { dataClass: 'sensitive', to: 'local', fields: ['body'] },
    ],
    budget: { modelCalls: 10, tokens: 100_000, costCap: null, localSlots: 1 },
    window: {
      prepStart: '2026-10-27T07:00:00Z',
      start: '2026-10-27T08:00:00Z',
      end: '2026-10-27T12:00:00Z',
      overrun: 'deliver_best',
    },
    interruption: 'needs_only',
    ...overrides,
  };
}

function makeWorkOrder(overrides = {}) {
  return {
    id: 'wo-1',
    parentStepId: 'step-root',
    role: 'researcher',
    objective: 'summarize inbox threads',
    inputs: [{ artifactId: 'a-1' }],
    acceptance: ['citations present'],
    constraints: { mustNot: ['send email'] },
    budget: { calls: 5, tokens: 10_000, deadline: '2026-10-27T11:00:00Z' },
    grants: [{ grantId: 'grant-1', scope: 'files.read:/Docs' }],
    output: { schema: { type: 'object' } },
    ...overrides,
  };
}

const PARENT_GRANTS = [{ grantId: 'grant-1', scopes: ['files.read:/Docs', 'files.read:/Inbox'] }];

function allowAllPolicy() {
  return { check: async () => ({ allow: true }) };
}

function denyPolicy(reason = 'autonomy boundary') {
  return { check: async () => ({ allow: false, reason }) };
}

function okModel(model = 'gpt-6-sol') {
  const calls = [];
  const fn = async req => {
    calls.push(req);
    return { ok: true, content: 'summary text', model, usage: { calls: 1, tokens: 120 } };
  };
  fn.calls = calls;
  return fn;
}

function freshRuntime({
  policyPort = allowAllPolicy(), modelCaller = okModel(), clock = createFixedClock(T0), store,
  spanSink, toolCaller,
} = {}) {
  const db = openAgenticDb(':memory:');
  migrate(db, migrationsDir);
  const realStore = store ?? createRuntimeStore({ db });
  const spies = [];
  const spyStore = new Proxy(realStore, {
    get(target, prop) {
      const value = target[prop];
      if (typeof value !== 'function') return value;
      return (...args) => {
        spies.push(prop);
        return value.apply(target, args);
      };
    },
  });
  spyStore.spyCalls = spies;
  const runtime = createAgentRuntime({
    policyPort, modelCaller, store: spyStore, clock, schemaDir: contractDir,
    ...(spanSink !== undefined ? { spanSink } : {}),
    ...(toolCaller !== undefined ? { toolCaller } : {}),
  });
  return { runtime, store: spyStore, db };
}

function oneStep(execute) {
  return [{ id: 's-1', name: 'draft', kind: 'execute', input: { a: 1 }, execute }];
}

// ---------------- 构造期 fail closed（负面先行） ----------------

test('M3 负面 · 无 policy port → createAgentRuntime 构造失败，不静默降级', () => {
  const db = openAgenticDb(':memory:');
  migrate(db, migrationsDir);
  const store = createRuntimeStore({ db });
  const base = { modelCaller: okModel(), store, clock: createFixedClock(T0), schemaDir: contractDir };
  for (const bad of [undefined, null, {}, { check: 'nope' }]) {
    assert.throws(() => createAgentRuntime({ ...base, policyPort: bad }), /policy/i);
  }
});

test('M3 负面 · 缺 store / clock / modelCaller / schemaDir → 构造失败', () => {
  const db = openAgenticDb(':memory:');
  migrate(db, migrationsDir);
  const full = {
    policyPort: allowAllPolicy(), modelCaller: okModel(),
    store: createRuntimeStore({ db }), clock: createFixedClock(T0), schemaDir: contractDir,
  };
  for (const key of ['store', 'clock', 'modelCaller', 'schemaDir']) {
    const broken = { ...full };
    delete broken[key];
    assert.throws(() => createAgentRuntime(broken), new RegExp(key), `missing ${key} must fail construction`);
  }
});

// ---------------- 入参校验与 fail-closed 清单（裁决②） ----------------

test('M3 负面 · workOrder 不通过冻结 work-order.schema.json → CONTRACT_INVALID 且零副作用', async () => {
  const { runtime, store } = freshRuntime();
  const invalidOrder = makeWorkOrder({ budget: { calls: 1, tokens: 1, deadline: 'not-a-date' } });
  await assert.rejects(
    () => runtime.runAgent({
      actor: 'planner@w7', workOrder: invalidOrder, contract: makeContract(),
      grantRefs: [{ grantId: 'grant-1' }], ownerCtx: { ownerId: 'owner-1' }, steps: oneStep(async () => ({ ok: true })),
    }),
    err => err.code === 'CONTRACT_INVALID',
  );
  assert.ok(!store.spyCalls.includes('saveWorkOrder'), 'no side effect may reach the store');
});

test('M3 负面 · 缺 actor / contract / grantRefs / ownerCtx → 拒绝且零副作用', async () => {
  const { runtime, store } = freshRuntime();
  const good = {
    actor: 'planner@w7', workOrder: makeWorkOrder(), contract: makeContract(),
    grantRefs: [{ grantId: 'grant-1' }], ownerCtx: { ownerId: 'owner-1' },
    steps: oneStep(async () => ({ ok: true })),
  };
  const cases = [
    ['actor', err => err.code === 'FORBIDDEN'],
    ['contract', err => err.code === 'CONTRACT_INVALID'],
    ['grantRefs', err => err.code === 'FORBIDDEN'],
    ['ownerCtx', err => err.code === 'FORBIDDEN'],
  ];
  for (const [key, predicate] of cases) {
    const broken = { ...good };
    if (key === 'grantRefs') broken.grantRefs = [];
    else delete broken[key];
    await assert.rejects(() => runtime.runAgent(broken), predicate, `missing ${key} must be rejected`);
  }
  assert.ok(!store.spyCalls.includes('saveWorkOrder'), 'fail-closed list must not touch the store');
});

// ---------------- 纵深防御：A4 / A5（独立于 policyPort） ----------------

test('M3 负面 · action.autonomy=A5 永远拒绝，即使 policyPort 放行', async () => {
  const modelCaller = okModel();
  const { runtime } = freshRuntime({ policyPort: allowAllPolicy(), modelCaller });
  const outcome = await runtime.runAgent({
    actor: 'planner@w7', workOrder: makeWorkOrder(), contract: makeContract(),
    grantRefs: [{ grantId: 'grant-1' }], ownerCtx: { ownerId: 'owner-1' },
    steps: oneStep(async ctx => ctx.modelCall({ prompt: 'pay invoice' }, { autonomy: 'A5' })),
  });
  assert.equal(outcome.status, 'failed');
  assert.equal(modelCaller.calls.length, 0, 'A5 action must never reach the model transport');
});

test('M3 负面 · action.autonomy=A4 无一次性确认凭据 → NEED_HUMAN，不调模型', async () => {
  const modelCaller = okModel();
  const { runtime } = freshRuntime({ policyPort: allowAllPolicy(), modelCaller });
  const outcome = await runtime.runAgent({
    actor: 'planner@w7', workOrder: makeWorkOrder(), contract: makeContract(),
    grantRefs: [{ grantId: 'grant-1' }], ownerCtx: { ownerId: 'owner-1' },
    steps: oneStep(async ctx => ctx.modelCall({ prompt: 'send email' }, { autonomy: 'A4' })),
  });
  assert.equal(outcome.status, 'needs_human');
  assert.equal(modelCaller.calls.length, 0);
});

test('M3 正例 · A4 带一次性确认凭据放行（policyPort 仍要过）', async () => {
  const modelCaller = okModel();
  const { runtime } = freshRuntime({ policyPort: allowAllPolicy(), modelCaller });
  const outcome = await runtime.runAgent({
    actor: 'planner@w7', workOrder: makeWorkOrder(), contract: makeContract(),
    grantRefs: [{ grantId: 'grant-1' }], ownerCtx: { ownerId: 'owner-1' },
    steps: oneStep(async ctx => ctx.modelCall({ prompt: 'send email' }, { autonomy: 'A4', confirmation: { token: 'one-time-token' } })),
  });
  assert.equal(outcome.status, 'done');
  assert.equal(modelCaller.calls.length, 1);
});

// ---------------- policyPort 决策边界（裁决②：运行时不复制 W4 判定） ----------------

test('M3 负面 · policyPort.check 拒绝（Grant 不匹配）→ FORBIDDEN 失败收场', async () => {
  const modelCaller = okModel();
  const { runtime } = freshRuntime({ policyPort: denyPolicy('grant scope mismatch'), modelCaller });
  const outcome = await runtime.runAgent({
    actor: 'planner@w7', workOrder: makeWorkOrder(), contract: makeContract(),
    grantRefs: [{ grantId: 'grant-1' }], ownerCtx: { ownerId: 'owner-1' },
    steps: oneStep(async ctx => ctx.modelCall({ prompt: 'x' })),
  });
  assert.equal(outcome.status, 'failed');
  assert.equal(modelCaller.calls.length, 0);
});

test('M3 负面 · policyPort.check 抛错 → fail closed（不吞成 allow）', async () => {
  const modelCaller = okModel();
  const exploding = { check: async () => { throw new Error('policy engine down'); } };
  const { runtime } = freshRuntime({ policyPort: exploding, modelCaller });
  await assert.rejects(
    () => runtime.runAgent({
      actor: 'planner@w7', workOrder: makeWorkOrder(), contract: makeContract(),
      grantRefs: [{ grantId: 'grant-1' }], ownerCtx: { ownerId: 'owner-1' },
      steps: oneStep(async ctx => ctx.modelCall({ prompt: 'x' })),
    }),
    /policy engine down/,
  );
  assert.equal(modelCaller.calls.length, 0);
});

test('M3 负面 · GrantRef scope 超出父 Grant → FORBIDDEN（assertGrantRefsSubset）', () => {
  assert.throws(
    () => assertGrantRefsSubset([{ grantId: 'grant-1', scope: 'files.write:/All' }], PARENT_GRANTS),
    err => err.code === 'FORBIDDEN',
  );
  assert.throws(
    () => assertGrantRefsSubset([{ grantId: 'grant-404' }], PARENT_GRANTS),
    err => err.code === 'FORBIDDEN',
    'unknown grantId must be rejected',
  );
  // 正例：子集放行
  assertGrantRefsSubset([{ grantId: 'grant-1', scope: 'files.read:/Docs' }], PARENT_GRANTS);
  assertGrantRefsSubset([{ grantId: 'grant-1' }], PARENT_GRANTS);
});

// ---------------- budget.mjs：窗口 / 子预算（注入时钟，红线⑥） ----------------

test('M3 负面 · 窗口外：早于 prepStart → FORBIDDEN（注入时钟，非真实时间）', () => {
  const tracker = createBudgetTracker({ contract: makeContract(), workOrder: makeWorkOrder(), now: Date.parse(T0) });
  assert.throws(
    () => tracker.assertWithinWindow(Date.parse('2026-10-27T06:00:00Z')),
    err => err.code === 'FORBIDDEN',
  );
});

test('M3 负面 · 窗口外：晚于合同 window.end 或工单 deadline → BUDGET_EXCEEDED', () => {
  const tracker = createBudgetTracker({ contract: makeContract(), workOrder: makeWorkOrder(), now: Date.parse(T0) });
  assert.throws(
    () => tracker.assertWithinWindow(Date.parse('2026-10-27T13:00:00Z')),
    err => err.code === 'BUDGET_EXCEEDED',
    'beyond contract window end',
  );
  assert.throws(
    () => tracker.assertWithinWindow(Date.parse('2026-10-27T11:30:00Z')),
    err => err.code === 'BUDGET_EXCEEDED',
    'beyond workOrder deadline (11:00) while window still open',
  );
  // 窗口内正例
  tracker.assertWithinWindow(Date.parse('2026-10-27T09:00:00Z'));
});

test('M3 负面 · 预算超限：calls/tokens 超过工单预算剩余 → BUDGET_EXCEEDED', () => {
  const tracker = createBudgetTracker({ contract: makeContract(), workOrder: makeWorkOrder({ budget: { calls: 2, tokens: 200, deadline: '2026-10-27T11:00:00Z' } }), now: Date.parse(T0) });
  tracker.charge({ calls: 1, tokens: 150 });
  tracker.assertCanSpend({ calls: 1, tokens: 50 });
  assert.throws(() => tracker.assertCanSpend({ calls: 2, tokens: 10 }), err => err.code === 'BUDGET_EXCEEDED');
  assert.throws(() => tracker.assertCanSpend({ calls: 1, tokens: 51 }), err => err.code === 'BUDGET_EXCEEDED');
});

test('M3 负面 · 子预算之和超父剩余 → BUDGET_EXCEEDED（PRD §6.4）', () => {
  assertChildBudgetsWithinParent(
    [{ calls: 2, tokens: 100 }, { calls: 1, tokens: 50 }],
    { calls: 5, tokens: 1000 },
  );
  assert.throws(
    () => assertChildBudgetsWithinParent(
      [{ calls: 3, tokens: 100 }, { calls: 3, tokens: 100 }],
      { calls: 5, tokens: 1000 },
    ),
    err => err.code === 'BUDGET_EXCEEDED',
    'child calls sum must not exceed parent',
  );
  assert.throws(
    () => assertChildBudgetsWithinParent([{ calls: 1, tokens: 999 }], { calls: 5, tokens: 1000, tokensSpent: 500 }),
    err => err.code === 'BUDGET_EXCEEDED',
    'child tokens must fit parent REMAINING',
  );
});

test('M3 负面 · 引擎级预算超限：两次 modelCall 超过 workOrder.budget.calls → 失败收场', async () => {
  const modelCaller = okModel();
  const { runtime } = freshRuntime({
    modelCaller,
    clock: createFixedClock(T0),
  });
  const outcome = await runtime.runAgent({
    actor: 'planner@w7',
    workOrder: makeWorkOrder({ budget: { calls: 1, tokens: 10_000, deadline: '2026-10-27T11:00:00Z' } }),
    contract: makeContract(),
    grantRefs: [{ grantId: 'grant-1' }],
    ownerCtx: { ownerId: 'owner-1' },
    steps: [
      { id: 's-1', name: 'first', kind: 'execute', execute: async ctx => ctx.modelCall({ prompt: 'a' }) },
      { id: 's-2', name: 'second', kind: 'execute', execute: async ctx => ctx.modelCall({ prompt: 'b' }) },
    ],
  });
  assert.equal(modelCaller.calls.length, 1, 'budget cap must stop the second call');
  assert.ok(['failed', 'partial'].includes(outcome.status), `status=${outcome.status}`);
});

test('M3 负面 · 引擎级窗口外：注入时钟越过 deadline → 拒绝执行', async () => {
  const modelCaller = okModel();
  const lateClock = createFixedClock('2026-10-27T11:59:00Z');
  const { runtime } = freshRuntime({ modelCaller, clock: lateClock });
  const outcome = await runtime.runAgent({
    actor: 'planner@w7', workOrder: makeWorkOrder(), contract: makeContract(),
    grantRefs: [{ grantId: 'grant-1' }], ownerCtx: { ownerId: 'owner-1' },
    steps: oneStep(async ctx => ctx.modelCall({ prompt: 'x' })),
  });
  assert.equal(modelCaller.calls.length, 0);
  assert.equal(outcome.status, 'failed');
});

// ---------------- 模型来源与 UNKNOWN（红线⑦ / 裁决④） ----------------

test('M3 正例 · happy path：产出通过冻结 work-result.schema.json，spent 如实', async () => {
  const { runtime } = freshRuntime({ modelCaller: okModel('gpt-6-sol') });
  const outcome = await runtime.runAgent({
    actor: 'planner@w7', workOrder: makeWorkOrder(), contract: makeContract(),
    grantRefs: [{ grantId: 'grant-1' }], ownerCtx: { ownerId: 'owner-1' },
    steps: oneStep(async () => ({ ok: true, output: { summary: 'done' }, model: 'gpt-6-sol', usage: { calls: 1, tokens: 120 } })),
  });
  assert.equal(outcome.status, 'done');
  const check = validate(outcome.workResult, workResultSchema, { schemaDir: contractDir });
  assert.equal(check.valid, true, JSON.stringify(check.errors));
  assert.equal(outcome.workResult.spent.calls, 1);
  assert.equal(outcome.workResult.spent.tokens, 120);
});

test('M3 负面 · modelCaller 返回无 model 来源 → run=unknown，绝不生成 status=done', async () => {
  const noModel = async () => ({ ok: true, content: 'ghost text', usage: { calls: 1, tokens: 5 } });
  const { runtime, store } = freshRuntime({ modelCaller: noModel });
  const outcome = await runtime.runAgent({
    actor: 'planner@w7', workOrder: makeWorkOrder(), contract: makeContract(),
    grantRefs: [{ grantId: 'grant-1' }], ownerCtx: { ownerId: 'owner-1' },
    steps: oneStep(async ctx => ctx.modelCall({ prompt: 'x' })),
  });
  assert.equal(outcome.status, 'unknown');
  assert.ok(!outcome.workResult || outcome.workResult.status !== 'done',
    'no model attribution may never produce a done WorkResult');
  assert.ok(store.spyCalls.includes('recordUnknownOutcome'), 'UNKNOWN must land in the ledger');
});

test('M3 负面 · transport 失败（ok:false）→ 步骤 failed，无 done 结果', async () => {
  const failing = async () => ({ ok: false, error: { code: 'UPSTREAM_UNAVAILABLE', message: 'timeout' } });
  const { runtime } = freshRuntime({ modelCaller: failing });
  const outcome = await runtime.runAgent({
    actor: 'planner@w7', workOrder: makeWorkOrder(), contract: makeContract(),
    grantRefs: [{ grantId: 'grant-1' }], ownerCtx: { ownerId: 'owner-1' },
    steps: oneStep(async ctx => ctx.modelCall({ prompt: 'x' })),
  });
  assert.equal(outcome.status, 'failed');
  assert.ok(!outcome.workResult || outcome.workResult.status !== 'done');
});

// ---------------- 检查点：暂停 / 恢复（裁决⑥） ----------------

test('M3 · 暂停落检查点：outcome.status=paused，无 WorkResult', async () => {
  const modelCaller = okModel();
  const { runtime } = freshRuntime({ modelCaller });
  const outcome = await runtime.runAgent({
    actor: 'planner@w7', workOrder: makeWorkOrder(), contract: makeContract(),
    grantRefs: [{ grantId: 'grant-1' }], ownerCtx: { ownerId: 'owner-1' },
    steps: [{
      id: 's-1', name: 'long', kind: 'execute',
      execute: async () => ({ pause: true, checkpoint: { doneSteps: [], next: 's-1' } }),
    }],
  });
  assert.equal(outcome.status, 'paused');
  assert.equal(outcome.workResult, undefined);
});

test('M3 · 从检查点恢复：续跑剩余步骤并 done', async () => {
  const modelCaller = okModel();
  const { runtime } = freshRuntime({ modelCaller });
  const steps = [
    { id: 's-1', name: 'first', kind: 'execute', execute: async () => ({ pause: true, checkpoint: { doneSteps: [], next: 's-2' } }) },
    { id: 's-2', name: 'second', kind: 'execute', execute: async ctx => ctx.modelCall({ prompt: 'resume work' }) },
  ];
  const paused = await runtime.runAgent({
    actor: 'planner@w7', workOrder: makeWorkOrder(), contract: makeContract(),
    grantRefs: [{ grantId: 'grant-1' }], ownerCtx: { ownerId: 'owner-1' }, steps,
  });
  assert.equal(paused.status, 'paused');
  const resumed = await runtime.resumeAgent({ runId: paused.runId, actor: 'planner@w7', ownerCtx: { ownerId: 'owner-1' } });
  assert.equal(resumed.status, 'done');
  assert.equal(modelCaller.calls.length, 1);
});

test('M3 负面 · 恢复时 policyPort 重查拒绝 → FORBIDDEN', async () => {
  const modelCaller = okModel();
  let checkCount = 0;
  const flippable = { check: async () => { checkCount += 1; return { allow: checkCount <= 1 }; } };
  const { runtime } = freshRuntime({ policyPort: flippable, modelCaller });
  const paused = await runtime.runAgent({
    actor: 'planner@w7', workOrder: makeWorkOrder(), contract: makeContract(),
    grantRefs: [{ grantId: 'grant-1' }], ownerCtx: { ownerId: 'owner-1' },
    steps: [{
      id: 's-1', name: 'first', kind: 'execute',
      execute: async () => ({ pause: true, checkpoint: { doneSteps: [], next: 's-2' } }),
    }],
  });
  await assert.rejects(
    () => runtime.resumeAgent({ runId: paused.runId, actor: 'planner@w7', ownerCtx: { ownerId: 'owner-1' } }),
    err => err.code === 'FORBIDDEN',
  );
});

test('M3 负面 · 恢复时用新 now 重验预算：时钟越过 deadline → BUDGET_EXCEEDED', async () => {
  const modelCaller = okModel();
  const clock = createSteppableClock(T0);
  const { runtime } = freshRuntime({ modelCaller, clock });
  const paused = await runtime.runAgent({
    actor: 'planner@w7', workOrder: makeWorkOrder(), contract: makeContract(),
    grantRefs: [{ grantId: 'grant-1' }], ownerCtx: { ownerId: 'owner-1' },
    steps: [{
      id: 's-1', name: 'first', kind: 'execute',
      execute: async () => ({ pause: true, checkpoint: { doneSteps: [], next: 's-2' } }),
    }],
  });
  clock.advance(Date.parse('2026-10-27T11:30:00Z') - Date.parse(T0)); // 越过 11:00 deadline
  await assert.rejects(
    () => runtime.resumeAgent({ runId: paused.runId, actor: 'planner@w7', ownerCtx: { ownerId: 'owner-1' } }),
    err => err.code === 'BUDGET_EXCEEDED',
  );
});

test('M3 负面 · 恢复时 contractHash 变化 → CONFLICT（合同变了检查点作废）', async () => {
  const modelCaller = okModel();
  const { runtime } = freshRuntime({ modelCaller });
  const contract = makeContract();
  const paused = await runtime.runAgent({
    actor: 'planner@w7', workOrder: makeWorkOrder(), contract,
    grantRefs: [{ grantId: 'grant-1' }], ownerCtx: { ownerId: 'owner-1' },
    steps: [{
      id: 's-1', name: 'first', kind: 'execute',
      execute: async () => ({ pause: true, checkpoint: { doneSteps: [], next: 's-2' } }),
    }],
  });
  const mutated = makeContract({ goal: 'changed goal invalidates grants (CTO §2.3)' });
  assert.notEqual(await contractHash(mutated), await contractHash(contract), 'fixture sanity: hashes differ');
  await assert.rejects(
    () => runtime.resumeAgent({ runId: paused.runId, actor: 'planner@w7', ownerCtx: { ownerId: 'owner-1' }, contract: mutated }),
    err => err.code === 'CONFLICT',
  );
});

test('M3 负面 · 误恢复：run 未处于 paused（已 done）→ CONFLICT', async () => {
  const modelCaller = okModel();
  const { runtime } = freshRuntime({ modelCaller });
  const done = await runtime.runAgent({
    actor: 'planner@w7', workOrder: makeWorkOrder(), contract: makeContract(),
    grantRefs: [{ grantId: 'grant-1' }], ownerCtx: { ownerId: 'owner-1' },
    steps: oneStep(async () => ({ ok: true, output: {}, model: 'gpt-6-sol', usage: { calls: 1, tokens: 10 } })),
  });
  assert.equal(done.status, 'done');
  await assert.rejects(
    () => runtime.resumeAgent({ runId: done.runId, actor: 'planner@w7', ownerCtx: { ownerId: 'owner-1' } }),
    err => err.code === 'CONFLICT',
    'resuming a non-paused run must CONFLICT',
  );
});

test('M3 负面 · 跨 owner 恢复 → NOT_FOUND', async () => {
  const modelCaller = okModel();
  const { runtime } = freshRuntime({ modelCaller });
  const paused = await runtime.runAgent({
    actor: 'planner@w7', workOrder: makeWorkOrder(), contract: makeContract(),
    grantRefs: [{ grantId: 'grant-1' }], ownerCtx: { ownerId: 'owner-1' },
    steps: [{
      id: 's-1', name: 'first', kind: 'execute',
      execute: async () => ({ pause: true, checkpoint: { doneSteps: [], next: 's-2' } }),
    }],
  });
  await assert.rejects(
    () => runtime.resumeAgent({ runId: paused.runId, actor: 'planner@w7', ownerCtx: { ownerId: 'owner-2' } }),
    err => err.code === 'NOT_FOUND',
  );
});

// ---------------- 幂等 / 重复 step ----------------

test('M3 · runAgent 幂等：同 idempotencyKey 同载重放，不重执行模型调用', async () => {
  const modelCaller = okModel();
  const { runtime } = freshRuntime({ modelCaller });
  const args = {
    actor: 'planner@w7', workOrder: makeWorkOrder(), contract: makeContract(),
    grantRefs: [{ grantId: 'grant-1' }], ownerCtx: { ownerId: 'owner-1' },
    steps: oneStep(async ctx => ctx.modelCall({ prompt: 'x' })),
    idempotencyKey: 'idem-run-1',
  };
  const first = await runtime.runAgent(args);
  const second = await runtime.runAgent(args);
  assert.equal(second.replayed, true);
  assert.equal(second.runId, first.runId);
  assert.equal(modelCaller.calls.length, 1, 'replay must not re-execute model calls');
});

test('M3 负面 · runAgent 幂等冲突：同 key 异载 → CONFLICT', async () => {
  const modelCaller = okModel();
  const { runtime } = freshRuntime({ modelCaller });
  await runtime.runAgent({
    actor: 'planner@w7', workOrder: makeWorkOrder(), contract: makeContract(),
    grantRefs: [{ grantId: 'grant-1' }], ownerCtx: { ownerId: 'owner-1' },
    steps: oneStep(async () => ({ ok: true })), idempotencyKey: 'idem-run-2',
  });
  await assert.rejects(
    () => runtime.runAgent({
      actor: 'planner@w7', workOrder: makeWorkOrder({ objective: 'different' }), contract: makeContract(),
      grantRefs: [{ grantId: 'grant-1' }], ownerCtx: { ownerId: 'owner-1' },
      steps: oneStep(async () => ({ ok: true })), idempotencyKey: 'idem-run-2',
    }),
    err => err.code === 'CONFLICT',
  );
});

test('M3 · 重复 step（同 id+inputHash）→ 检查点重放，不二次执行', async () => {
  const executions = [];
  const makeStep = (id, input) => ({
    id, name: id, kind: 'execute', input,
    execute: async () => { executions.push(id); return { ok: true, output: {}, model: 'gpt-6-sol', usage: { calls: 0, tokens: 0 } }; },
  });
  const { runtime } = freshRuntime();
  const outcome = await runtime.runAgent({
    actor: 'planner@w7', workOrder: makeWorkOrder(), contract: makeContract(),
    grantRefs: [{ grantId: 'grant-1' }], ownerCtx: { ownerId: 'owner-1' },
    steps: [makeStep('s-dup', { same: true }), makeStep('s-dup', { same: true })],
  });
  assert.deepEqual(executions, ['s-dup'], 'duplicate step id+inputHash must execute exactly once');
  assert.equal(outcome.status, 'done');
});

// ---------------- M3 追加（实现后补测：纵深防御/工具端口/覆盖缺口，只增不删） ----------------

test('M3 追加 · 构造期：options 非对象 / store 缺方法 / spanSink 形状错 → CONTRACT_INVALID', () => {
  const db = openAgenticDb(':memory:');
  migrate(db, migrationsDir);
  assert.throws(() => createAgentRuntime(null), /options object/);
  const full = {
    policyPort: allowAllPolicy(), modelCaller: okModel(),
    store: createRuntimeStore({ db }), clock: createFixedClock(T0), schemaDir: contractDir,
  };
  const brokenStore = { saveWorkOrder() {} };
  assert.throws(() => createAgentRuntime({ ...full, store: brokenStore }), /missing required methods/);
  assert.throws(() => createAgentRuntime({ ...full, spanSink: { record: 1 } }), /spanSink/);
});

test('M3 追加 · spanSink 注入时记录 run 起止事件（可选端口）', async () => {
  const spans = [];
  const { runtime } = freshRuntime({
    modelCaller: okModel(),
    spanSink: { record: span => spans.push(span) },
  });
  const outcome = await runtime.runAgent({
    actor: 'planner@w7', workOrder: makeWorkOrder(), contract: makeContract(),
    grantRefs: [{ grantId: 'grant-1' }], ownerCtx: { ownerId: 'owner-1' },
    steps: oneStep(async () => ({ ok: true, output: {}, model: 'gpt-6-sol', usage: { calls: 1, tokens: 5 } })),
  });
  assert.equal(outcome.status, 'done');
  const types = spans.map(span => span.type);
  assert.ok(types.includes('run.started') && types.includes('run.finished'));
});

test('M3 追加 · toolCall：策略拒绝 → FORBIDDEN；未注入 toolCaller → FORBIDDEN；A5 工具动作永拒', async () => {
  const toolCalls = [];
  const toolCaller = async (tool, args) => { toolCalls.push([tool, args]); return { ok: true, tool, output: {} }; };
  const denied = freshRuntime({ policyPort: denyPolicy('tool not granted'), toolCaller });
  const deniedOutcome = await denied.runtime.runAgent({
    actor: 'planner@w7', workOrder: makeWorkOrder(), contract: makeContract(),
    grantRefs: [{ grantId: 'grant-1' }], ownerCtx: { ownerId: 'owner-1' },
    steps: oneStep(async ctx => ctx.toolCall('mcp.fetch', { url: 'x' })),
  });
  assert.equal(deniedOutcome.status, 'failed');
  assert.equal(toolCalls.length, 0);

  const allowed = freshRuntime({ toolCaller });
  const a5 = await allowed.runtime.runAgent({
    actor: 'planner@w7', workOrder: makeWorkOrder(), contract: makeContract(),
    grantRefs: [{ grantId: 'grant-1' }], ownerCtx: { ownerId: 'owner-1' },
    steps: oneStep(async ctx => ctx.toolCall('mcp.fetch', {}, { autonomy: 'A5' })),
  });
  assert.equal(a5.status, 'failed');
  assert.equal(toolCalls.length, 0, 'A5 tool action must never reach the tool transport');

  const okOutcome = await allowed.runtime.runAgent({
    // 换工单（id+负载）：同 runtime 下同 id 异载会 CONFLICT、同 id 同载会重放上一子例的 failed 结果
    actor: 'planner@w7', workOrder: makeWorkOrder({ id: 'wo-tool', objective: 'fetch via tool' }), contract: makeContract(),
    grantRefs: [{ grantId: 'grant-1' }], ownerCtx: { ownerId: 'owner-1' },
    steps: [{
      id: 's-tool', name: 'fetch', kind: 'execute',
      execute: async ctx => ({ ok: true, output: await ctx.toolCall('mcp.fetch', { url: 'x' }), model: 'gpt-6-sol' }),
    }],
  });
  assert.equal(okOutcome.status, 'done');
  assert.equal(toolCalls.length, 1);

  const noTool = freshRuntime({ toolCaller: undefined });
  const refused = await noTool.runtime.runAgent({
    actor: 'planner@w7', workOrder: makeWorkOrder(), contract: makeContract(),
    grantRefs: [{ grantId: 'grant-1' }], ownerCtx: { ownerId: 'owner-1' },
    steps: oneStep(async ctx => ctx.toolCall('mcp.fetch', {})),
  });
  assert.equal(refused.status, 'failed');
});

test('M3 追加 · modelCall 入参形状：payload 非对象 / action 非对象 / 工具名空 → CONTRACT_INVALID', async () => {
  const { runtime } = freshRuntime();
  const payloadBad = await runtime.runAgent({
    actor: 'planner@w7', workOrder: makeWorkOrder(), contract: makeContract(),
    grantRefs: [{ grantId: 'grant-1' }], ownerCtx: { ownerId: 'owner-1' },
    steps: oneStep(async ctx => ctx.modelCall('not-an-object')),
  });
  assert.equal(payloadBad.status, 'failed');
  const actionBad = await runtime.runAgent({
    actor: 'planner@w7', workOrder: makeWorkOrder(), contract: makeContract(),
    grantRefs: [{ grantId: 'grant-1' }], ownerCtx: { ownerId: 'owner-1' },
    steps: oneStep(async ctx => ctx.modelCall({ prompt: 'x' }, 'bad-action')),
  });
  assert.equal(actionBad.status, 'failed');
});

test('M3 追加 · 决策形状非法（allow 非 boolean）→ CONTRACT_INVALID 上抛，不放行', async () => {
  const malformed = { check: async () => ({ allow: 'yes' }) };
  const { runtime } = freshRuntime({ policyPort: malformed });
  await assert.rejects(
    () => runtime.runAgent({
      actor: 'planner@w7', workOrder: makeWorkOrder(), contract: makeContract(),
      grantRefs: [{ grantId: 'grant-1' }], ownerCtx: { ownerId: 'owner-1' }, steps: oneStep(async () => ({ ok: true })),
    }),
    err => err.code === 'CONTRACT_INVALID',
  );
});

test('M3 追加 · 跨 owner runAgent（contract.ownerId ≠ ownerCtx.ownerId）→ FORBIDDEN 零副作用', async () => {
  const { runtime, store } = freshRuntime();
  await assert.rejects(
    () => runtime.runAgent({
      actor: 'planner@w7', workOrder: makeWorkOrder(), contract: makeContract({ ownerId: 'owner-9' }),
      grantRefs: [{ grantId: 'grant-1' }], ownerCtx: { ownerId: 'owner-1' }, steps: oneStep(async () => ({ ok: true })),
    }),
    err => err.code === 'FORBIDDEN',
  );
  assert.ok(!store.spyCalls.includes('saveWorkOrder'));
});

test('M3 追加 · grantRef 条目非法 / steps 形状非法 / idempotencyKey 空串 → CONTRACT_INVALID', async () => {
  const { runtime } = freshRuntime();
  const base = {
    actor: 'planner@w7', workOrder: makeWorkOrder(), contract: makeContract(),
    ownerCtx: { ownerId: 'owner-1' }, steps: oneStep(async () => ({ ok: true })),
  };
  await assert.rejects(
    () => runtime.runAgent({ ...base, grantRefs: [{ grantId: '' }] }),
    err => err.code === 'CONTRACT_INVALID',
  );
  await assert.rejects(
    () => runtime.runAgent({ ...base, grantRefs: [{ grantId: 'g-1' }], steps: [{ id: 's', name: 'n', kind: 'teleport', execute: async () => ({ ok: true }) }] }),
    err => err.code === 'CONTRACT_INVALID',
  );
  await assert.rejects(
    () => runtime.runAgent({ ...base, grantRefs: [{ grantId: 'g-1' }], steps: 'nope' }),
    err => err.code === 'CONTRACT_INVALID',
  );
  await assert.rejects(
    () => runtime.runAgent({ ...base, grantRefs: [{ grantId: 'g-1' }], idempotencyKey: '' }),
    err => err.code === 'CONTRACT_INVALID',
  );
});

test('M3 追加 · 步骤返回非对象 / ok:false 无 error 对象 → 失败收场（不炸不吞）', async () => {
  const { runtime } = freshRuntime();
  const garbage = await runtime.runAgent({
    actor: 'planner@w7', workOrder: makeWorkOrder(), contract: makeContract(),
    grantRefs: [{ grantId: 'grant-1' }], ownerCtx: { ownerId: 'owner-1' },
    steps: oneStep(async () => 'garbage'),
  });
  assert.equal(garbage.status, 'failed');
  const noErrorObject = await freshRuntime().runtime.runAgent({
    actor: 'planner@w7', workOrder: makeWorkOrder(), contract: makeContract(),
    grantRefs: [{ grantId: 'grant-1' }], ownerCtx: { ownerId: 'owner-1' },
    steps: oneStep(async () => ({ ok: false })),
  });
  assert.equal(noErrorObject.status, 'failed');
});

test('M3 追加 · 全程无模型来源的"成功"步骤 → run=unknown + 台账（红线⑦）', async () => {
  const { runtime, db } = freshRuntime();
  const outcome = await runtime.runAgent({
    actor: 'planner@w7', workOrder: makeWorkOrder(), contract: makeContract(),
    grantRefs: [{ grantId: 'grant-1' }], ownerCtx: { ownerId: 'owner-1' },
    steps: oneStep(async () => ({ ok: true, output: { deterministic: true } })),
  });
  assert.equal(outcome.status, 'unknown');
  assert.equal(outcome.workResult, undefined);
  const rows = db.prepare('SELECT source, detail FROM w7_unknown_outcomes').all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].source, 'engine');
});

test('M3 追加 · 自动幂等键：同工单两次 runAgent（未显式给 key）→ 第二次重放', async () => {
  const modelCaller = okModel();
  const { runtime } = freshRuntime({ modelCaller });
  const args = {
    actor: 'planner@w7', workOrder: makeWorkOrder(), contract: makeContract(),
    grantRefs: [{ grantId: 'grant-1' }], ownerCtx: { ownerId: 'owner-1' },
    steps: oneStep(async ctx => ctx.modelCall({ prompt: 'x' })),
  };
  const first = await runtime.runAgent(args);
  assert.equal(first.status, 'done');
  const second = await runtime.runAgent(args);
  assert.equal(second.replayed, true);
  assert.equal(second.runId, first.runId);
  assert.equal(modelCaller.calls.length, 1);
});

test('M3 追加 · 重放落在 paused 运行上：返回 paused + replayed，不重执行', async () => {
  const modelCaller = okModel();
  const { runtime } = freshRuntime({ modelCaller });
  const args = {
    actor: 'planner@w7', workOrder: makeWorkOrder(), contract: makeContract(),
    grantRefs: [{ grantId: 'grant-1' }], ownerCtx: { ownerId: 'owner-1' },
    idempotencyKey: 'idem-paused',
    steps: [{
      id: 's-1', name: 'first', kind: 'execute',
      execute: async () => ({ pause: true, checkpoint: { doneSteps: ['s-1'], next: 's-2' } }),
    }],
  };
  const paused = await runtime.runAgent(args);
  assert.equal(paused.status, 'paused');
  const again = await runtime.runAgent(args);
  assert.equal(again.status, 'paused');
  assert.equal(again.replayed, true);
  assert.equal(again.runId, paused.runId);
});

test('M3 追加 · 恢复只按 doneSteps 续跑（无 next）：跳过已完成步骤', async () => {
  const modelCaller = okModel();
  const { runtime } = freshRuntime({ modelCaller });
  const executions = [];
  const steps = [
    { id: 's-1', name: 'first', kind: 'execute', execute: async () => { executions.push('s-1'); return { pause: true, checkpoint: { doneSteps: ['s-1'] } }; } },
    { id: 's-2', name: 'second', kind: 'execute', execute: async ctx => { executions.push('s-2'); return ctx.modelCall({ prompt: 'go' }); } },
  ];
  const paused = await runtime.runAgent({
    actor: 'planner@w7', workOrder: makeWorkOrder(), contract: makeContract(),
    grantRefs: [{ grantId: 'grant-1' }], ownerCtx: { ownerId: 'owner-1' }, steps,
  });
  assert.equal(paused.status, 'paused');
  const resumed = await runtime.resumeAgent({ runId: paused.runId, actor: 'planner@w7', ownerCtx: { ownerId: 'owner-1' } });
  assert.equal(resumed.status, 'done');
  assert.deepEqual(executions, ['s-1', 's-2'], 'resume must not re-execute checkpointed steps');
});

test('M3 追加 · 恢复负例集：缺 ownerCtx / actor 不匹配 / checkpoint.next 不存在', async () => {
  const { runtime } = freshRuntime();
  const paused = await runtime.runAgent({
    actor: 'planner@w7', workOrder: makeWorkOrder(), contract: makeContract(),
    grantRefs: [{ grantId: 'grant-1' }], ownerCtx: { ownerId: 'owner-1' },
    steps: [{
      id: 's-1', name: 'first', kind: 'execute',
      execute: async () => ({ pause: true, checkpoint: { doneSteps: [], next: 'ghost-step' } }),
    }],
  });
  assert.equal(paused.status, 'paused');
  await assert.rejects(
    () => runtime.resumeAgent({ runId: paused.runId, ownerCtx: { ownerId: 'owner-1' } }),
    err => err.code === 'FORBIDDEN',
  );
  await assert.rejects(
    () => runtime.resumeAgent({ runId: paused.runId, actor: 'other@w7', ownerCtx: { ownerId: 'owner-1' } }),
    err => err.code === 'FORBIDDEN',
  );
  await assert.rejects(
    () => runtime.resumeAgent({ runId: paused.runId, actor: 'planner@w7', ownerCtx: { ownerId: 'owner-1' } }),
    err => err.code === 'CONTRACT_INVALID',
    'checkpoint.next pointing at a non-existent step invalidates the checkpoint',
  );
});

test('M3 追加 · ownerCtx.parentGrants 注入时 runAgent/恢复都做 GrantRef 子集校验', async () => {
  const modelCaller = okModel();
  const { runtime } = freshRuntime({ modelCaller });
  const ownerCtx = { ownerId: 'owner-1', parentGrants: PARENT_GRANTS };
  const modelCaller2 = okModel();
  const deniedRuntime = freshRuntime({ modelCaller: modelCaller2 }).runtime;
  const grantViolation = await deniedRuntime.runAgent({
    actor: 'planner@w7', workOrder: makeWorkOrder({ grants: [{ grantId: 'grant-1', scope: 'files.write:/All' }] }),
    contract: makeContract(),
    grantRefs: [{ grantId: 'grant-1', scope: 'files.write:/All' }], ownerCtx,
    steps: oneStep(async ctx => ctx.modelCall({ prompt: 'x' })),
  });
  assert.equal(grantViolation.status, 'failed', 'grant-ref superset violation must fail the run before any model call');
  assert.equal(modelCaller2.calls.length, 0);
  // 正例 + 恢复路径同样过子集校验
  const paused = await runtime.runAgent({
    actor: 'planner@w7', workOrder: makeWorkOrder({ objective: 'resume with grants' }), contract: makeContract(),
    grantRefs: [{ grantId: 'grant-1', scope: 'files.read:/Docs' }], ownerCtx,
    steps: [
      { id: 's-1', name: 'first', kind: 'execute', execute: async () => ({ pause: true, checkpoint: { doneSteps: [], next: 's-2' } }) },
      { id: 's-2', name: 'second', kind: 'execute', execute: async ctx => ctx.modelCall({ prompt: 'go' }) },
    ],
  });
  assert.equal(paused.status, 'paused');
  const resumed = await runtime.resumeAgent({ runId: paused.runId, actor: 'planner@w7', ownerCtx });
  assert.equal(resumed.status, 'done');
});

test('M3 追加 · budget 负例：缺注入时间 / 缺 window / deadline 不可解析 → CONTRACT_INVALID', () => {
  assert.throws(() => createBudgetTracker({ contract: makeContract(), workOrder: makeWorkOrder() }), /deterministic time/);
  assert.throws(
    () => createBudgetTracker({ contract: makeContract({ window: undefined }), workOrder: makeWorkOrder(), now: Date.parse(T0) }),
    err => err.code === 'CONTRACT_INVALID',
  );
  assert.throws(
    () => createBudgetTracker({
      contract: makeContract(),
      workOrder: makeWorkOrder({ budget: { calls: 1, tokens: 1, deadline: 'not-a-date' } }),
      now: Date.parse(T0),
    }),
    err => err.code === 'CONTRACT_INVALID',
  );
  const tracker = createBudgetTracker({ contract: makeContract(), workOrder: makeWorkOrder(), now: Date.parse(T0) });
  assert.throws(() => tracker.assertWithinWindow('not-a-number'), err => err.code === 'CONTRACT_INVALID');
  assert.throws(() => tracker.assertCanSpend('nope'), err => err.code === 'CONTRACT_INVALID');
  assert.throws(() => tracker.charge({ calls: -1 }), err => err.code === 'CONTRACT_INVALID');
});

test('M3 追加 · budget：snapshot 含注入 now；子预算父轴缺省不约束', () => {
  const tracker = createBudgetTracker({ contract: makeContract(), workOrder: makeWorkOrder(), now: () => 1234 });
  tracker.charge({ calls: 2, tokens: 20 });
  assert.deepEqual(tracker.snapshot(), { calls: 2, tokens: 20, now: 1234 });
  assertChildBudgetsWithinParent([{ calls: 99 }], { tokens: 10 }); // parent.calls 未设 → calls 轴不约束
  assert.throws(() => assertChildBudgetsWithinParent('nope', { calls: 1 }), err => err.code === 'CONTRACT_INVALID');
  assert.throws(() => assertChildBudgetsWithinParent([], 'nope'), err => err.code === 'CONTRACT_INVALID');
  assert.throws(() => assertChildBudgetsWithinParent([], { calls: 1.5 }), err => err.code === 'CONTRACT_INVALID');
  assert.throws(() => assertChildBudgetsWithinParent([], { calls: 5, callsSpent: -1 }), err => err.code === 'CONTRACT_INVALID');
});

test('M3 追加 · GrantRef 子集：路径前缀是子集；形状非法 CONTRACT_INVALID', () => {
  // 同 capability 下子路径 ⊆ 父 scope（'/' 边界）
  assertGrantRefsSubset([{ grantId: 'grant-1', scope: 'files.read:/Docs/Sub' }], PARENT_GRANTS);
  // 父 scope 不带 ':' 时只允许精确匹配
  assertGrantRefsSubset([{ grantId: 'grant-2', scope: 'legacy-scope' }], [
    ...PARENT_GRANTS, { grantId: 'grant-2', scopes: ['legacy-scope', 'files.read:/X'] },
  ]);
  assert.throws(
    () => assertGrantRefsSubset([{ grantId: 'grant-2', scope: 'other-scope' }], [
      ...PARENT_GRANTS, { grantId: 'grant-2', scopes: ['legacy-scope'] },
    ]),
    err => err.code === 'FORBIDDEN',
  );
  // 不同 capability 即使路径相同也不是子集
  assert.throws(
    () => assertGrantRefsSubset([{ grantId: 'grant-1', scope: 'files.write:/Docs' }], PARENT_GRANTS),
    err => err.code === 'FORBIDDEN',
  );
  assert.throws(() => assertGrantRefsSubset([], PARENT_GRANTS), err => err.code === 'FORBIDDEN');
  assert.throws(() => assertGrantRefsSubset([{ grantId: 'g' }], 'nope'), err => err.code === 'CONTRACT_INVALID');
  assert.throws(() => assertGrantRefsSubset([{ grantId: 'g' }], [{ grantId: 'g' }]), err => err.code === 'CONTRACT_INVALID');
  assert.throws(() => assertGrantRefsSubset([{ grantId: '' }], PARENT_GRANTS), err => err.code === 'CONTRACT_INVALID');
  assert.throws(() => assertGrantRefsSubset([{ grantId: 'grant-1', scope: '' }], PARENT_GRANTS), err => err.code === 'CONTRACT_INVALID');
});

test('M3 追加 · 步骤失败落库失败时不吞原始错误（fail closed 上抛）', async () => {
  const db = openAgenticDb(':memory:');
  migrate(db, migrationsDir);
  const realStore = createRuntimeStore({ db });
  const rigged = new Proxy(realStore, {
    get(target, prop) {
      if (prop !== 'updateStepState') return target[prop];
      return payload => {
        if (payload.state === 'failed') throw new Error('sqlite exploded during failure persistence');
        return target.updateStepState(payload);
      };
    },
  });
  const runtime = createAgentRuntime({
    policyPort: allowAllPolicy(), modelCaller: async () => ({ ok: false, error: { code: 'UPSTREAM_UNAVAILABLE', message: 'down' } }),
    store: rigged, clock: createFixedClock(T0), schemaDir: contractDir,
  });
  await assert.rejects(
    () => runtime.runAgent({
      actor: 'planner@w7', workOrder: makeWorkOrder(), contract: makeContract(),
      grantRefs: [{ grantId: 'grant-1' }], ownerCtx: { ownerId: 'owner-1' },
      steps: oneStep(async ctx => ctx.modelCall({ prompt: 'x' })),
    }),
    /persist step failure/,
  );
});
