// W7 M8 · w7-contract-consistency（测试先行 · RED 基线）
//
// 只新增对冻结 schema 的验证，不改 schema、不改 fixtures（brief 文件归属）。
// 依赖 G1/G2/G3 产出的真实对象 —— 本文件在实现落地前必须保持 RED。
//
// 覆盖：
//   1. FROZEN 基线仍为 v1 b9d9bdfa0511905a95b729753b82e574adab6bb，且
//      contracts/agentic/** 相对 git HEAD 零改动（本流不得动契约）。
//   2. G1 runtime 产出的 WorkResult / Step / Spend / Evidence 逐一对冻结 schema assertValid。
//   3. G2 router 的 CodexChoice 过 codex-choice.schema.json；UNKNOWN 决策不产生 done WorkResult。
//   4. 8 份 W7 相关 fixtures：valid 全过、invalid 全拒（吃 W0 冻结样例，不改）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertValid, loadSchema, validate } from '../../../../scripts/agentic/contracts.mjs';
import { openAgenticDb, migrate } from '../../../../scripts/agentic/db/index.mjs';
import { createRuntimeStore } from '../../../../scripts/agentic/runtime/store.mjs';
import { createAgentRuntime } from '../../../../scripts/agentic/runtime/engine.mjs';
import { selectModel } from '../../../../scripts/agentic/model-router/router.mjs';
import { createFixedClock } from '../../../../scripts/agentic/runtime/ports.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../../../');
const contractDir = join(root, 'contracts/agentic');
const fixtureDir = join(contractDir, 'fixtures');
const migrationsDir = join(root, 'scripts/agentic/db/migrations');

const FROZEN_EXPECTED = 'v1 b9d9bdfa0511905a95b729753b82e574adab6bb';

// ---------------- 冻结基线完整性 ----------------

test('M8 · FROZEN 仍为 W0 基线，本流未改 contracts/agentic/**', () => {
  const frozen = readFileSync(join(contractDir, 'FROZEN'), 'utf8').trim();
  assert.equal(frozen, FROZEN_EXPECTED, 'frozen baseline must be untouched');
  const dirty = execFileSync('git', ['status', '--porcelain', '--', 'contracts/agentic'], { cwd: root, encoding: 'utf8' });
  assert.equal(dirty.trim(), '', `contracts/agentic must be clean, got: ${dirty}`);
  const drifted = execFileSync('git', ['diff', '--name-only', 'HEAD', '--', 'contracts/agentic'], { cwd: root, encoding: 'utf8' });
  assert.equal(drifted.trim(), '', 'no schema may drift from HEAD');
});

// ---------------- 冻结 fixtures 对账（8 份 W7 相关） ----------------

const W7_FIXTURES = [
  'work-order', 'work-result', 'grant-ref', 'spend', 'evidence', 'step', 'connector', 'codex-choice',
];

test('M8 · W7 相关 fixtures：valid 全过 / invalid 全拒（吃 W0 冻结样例）', () => {
  for (const name of W7_FIXTURES) {
    const fixture = JSON.parse(readFileSync(join(fixtureDir, `${name}.fixtures.json`), 'utf8'));
    const schema = loadSchema(`${name}.schema.json`, contractDir);
    for (const value of fixture.valid) {
      const result = validate(value, schema, { schemaDir: contractDir });
      assert.equal(result.valid, true, `${name} valid sample rejected: ${JSON.stringify(result.errors)}`);
    }
    for (const value of fixture.invalid) {
      const result = validate(value, schema, { schemaDir: contractDir });
      assert.equal(result.valid, false, `${name} invalid sample unexpectedly passed`);
    }
  }
});

// ---------------- G1 runtime 真实产出对冻结 schema ----------------

const T0 = '2026-10-27T08:00:00Z';

function contractFixture() {
  return {
    id: 'contract-1', ownerId: 'owner-1', revision: 1, schemaVersion: 1,
    createdAt: '2026-10-26T08:00:00Z', updatedAt: '2026-10-26T08:00:00Z', deletedAt: null,
    source: 'demo', missionId: 'm-1', version: 1, hash: '0'.repeat(64),
    goal: 'g', deliverables: [{ type: 'report', shape: {}, location: {} }],
    definitionOfDone: ['d'], autonomy: 'A2', will: [], wont: ['x'], needs: [],
    capabilities: [{ capability: 'files.read', scope: 'files.read:/Docs' }],
    dataDisclosure: [{ dataClass: 'public', to: 'cloud-model', fields: ['*'] }],
    budget: { modelCalls: 10, tokens: 100_000, costCap: null, localSlots: 1 },
    window: {
      prepStart: '2026-10-27T07:00:00Z', start: '2026-10-27T08:00:00Z',
      end: '2026-10-27T12:00:00Z', overrun: 'deliver_best',
    },
    interruption: 'needs_only',
  };
}

function workOrderFixture() {
  return {
    id: 'wo-m8', parentStepId: 'step-root', role: 'researcher', objective: 'summarize',
    inputs: [{ artifactId: 'a-1' }], acceptance: ['cited'],
    constraints: { mustNot: ['send email'] },
    budget: { calls: 5, tokens: 10_000, deadline: '2026-10-27T11:00:00Z' },
    grants: [{ grantId: 'grant-1', scope: 'files.read:/Docs' }],
    output: { schema: { type: 'object' } },
  };
}

function buildRuntime(modelCaller) {
  const db = openAgenticDb(':memory:');
  migrate(db, migrationsDir);
  const runtime = createAgentRuntime({
    policyPort: { check: async () => ({ allow: true }) },
    modelCaller,
    store: createRuntimeStore({ db }),
    clock: createFixedClock(T0),
    schemaDir: contractDir,
  });
  return { runtime, db };
}

const RUN_ARGS = (modelCaller) => ({
  actor: 'planner@w7',
  workOrder: workOrderFixture(),
  contract: contractFixture(),
  grantRefs: [{ grantId: 'grant-1' }],
  ownerCtx: { ownerId: 'owner-1' },
  steps: [{
    id: 's-1', name: 'draft', kind: 'execute',
    execute: async () => ({ ok: true, output: { summary: 'ok' }, model: 'gpt-6-sol', usage: { calls: 1, tokens: 120 } }),
  }],
});

test('M8 · engine 真实产出：WorkResult（含 Spend/Evidence）逐字段过冻结 schema', async () => {
  const { runtime } = buildRuntime(async () => ({ ok: true, content: 'text', model: 'gpt-6-sol', usage: { calls: 1, tokens: 120 } }));
  const outcome = await runtime.runAgent(RUN_ARGS());
  assert.equal(outcome.status, 'done', 'fixture sanity: happy path must be done');
  assertValid(outcome.workResult, loadSchema('work-result.schema.json', contractDir), { schemaDir: contractDir });
  assertValid(outcome.workResult.spent, loadSchema('spend.schema.json', contractDir), { schemaDir: contractDir });
  for (const item of outcome.workResult.evidence) {
    assertValid(item, loadSchema('evidence.schema.json', contractDir), { schemaDir: contractDir });
  }
});

test('M8 · store 真实产出：Step 行过冻结 step.schema.json', async () => {
  const db = openAgenticDb(':memory:');
  migrate(db, migrationsDir);
  const store = createRuntimeStore({ db });
  const { record } = store.recordStep({
    ownerId: 'owner-1',
    step: {
      id: 's-m8', runId: 'run-m8', name: 'draft', kind: 'execute',
      state: 'pending', attempt: 0, inputHash: 'a'.repeat(64),
    },
  });
  assertValid(record, loadSchema('step.schema.json', contractDir), { schemaDir: contractDir });
});

test('M8 · 无模型来源的 run 绝不产生 status=done 的 WorkResult（红线⑦）', async () => {
  const { runtime } = buildRuntime(async () => ({ ok: true, content: 'ghost', usage: { calls: 1, tokens: 1 } }));
  const outcome = await runtime.runAgent(RUN_ARGS());
  assert.equal(outcome.status, 'unknown');
  if (outcome.workResult) {
    // 若实现选择产出部分结果，也不得是 done
    assert.notEqual(outcome.workResult.status, 'done');
    assertValid(outcome.workResult, loadSchema('work-result.schema.json', contractDir), { schemaDir: contractDir });
  }
});

// ---------------- G2 router 真实产出 ----------------

test('M8 · router Codex 路径产出过冻结 codex-choice.schema.json', () => {
  const decision = selectModel('code', 'public', {
    actor: 'planner@w7', budget: { calls: 5, tokens: 50_000 },
    localAvailable: true, now: '2026-10-27T08:30:00Z',
  });
  assert.equal(decision.status, 'selected');
  assertValid(decision.codexChoice, loadSchema('codex-choice.schema.json', contractDir), { schemaDir: contractDir });
});

test('M8 · GrantRef 子集形状在 WorkOrder.grants 内过冻结 grant-ref.schema.json', () => {
  const schema = loadSchema('grant-ref.schema.json', contractDir);
  for (const ref of workOrderFixture().grants) {
    assertValid(ref, schema, { schemaDir: contractDir });
  }
});
