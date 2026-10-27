// S2D-W13 · 黄金场景驱动测试（brief §5 场景 1–7，node 侧；plan.md M22）。
//
// 依赖 M21 harness（tests/agentic/integration/harness.mjs，本节点不实现）：
//
//   const harness = await createGoldenHarness({ scenario, port? });
//   harness.port                    // 17701–17719 段（W13 专用，brief 端口约定）
//   harness.baseUrl                 // http://127.0.0.1:<port>
//   harness.as(ownerKey)            // → { request(method, path, body), sse(path) }
//   harness.clock                   // 确定性时钟 { now(), advance(ms) }
//   harness.events()                // 组合根事件序列（含 SSE 断开/UNKNOWN 记录）
//   harness.externalEffects()       // 假副作用端口台账（W4 fence 计数）
//   harness.modelTransport          // 假模型 transport（可脚本化、记录调用）
//   harness.adapt(dto)              // M15 W1 DTO→Block 适配器入口
//   harness.executionLayerBlocks()  // 进入执行层（mission/scan 可见）的块清单
//   harness.close()
//
// 全部外部依赖为 harness 内假件（假模型/假 checker/假网关/假 vision/假 side-effect
// 端口），真实 gateway/Codex/media/email 调用 0 次。场景期望值来自
// fixtures/golden-scenarios.json（由 golden-fixtures.test.mjs 自检）。
//
// TDD：harness 未实现 → 每个场景独立 RED（ERR_MODULE_NOT_FOUND）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSchema, validate } from '../../../scripts/agentic/contracts.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const contractDir = join(here, '../../../contracts/agentic');
const blockSchema = loadSchema('block.schema.json', contractDir);
const golden = JSON.parse(await readFile(join(here, 'fixtures/golden-scenarios.json'), 'utf8'));

function scenario(id) {
  return golden.scenarios.find(entry => entry.id === id);
}

async function withHarness(scenarioId, run) {
  const { createGoldenHarness } = await import('./harness.mjs');
  const harness = await createGoldenHarness({ scenario: scenarioId });
  try {
    assert.ok(harness.port >= 17701 && harness.port <= 17719, `harness port must stay in the W13 range 17701-17719, got ${harness.port}`);
    return await run(harness);
  } finally {
    await harness.close();
  }
}

test('golden-1 (§5.1): complete schedule converts to a legal block; the time-less draft stays out of execution', async () => {
  const spec = scenario('golden-1-block-sync-adapter');
  await withHarness(spec.id, async harness => {
    const owner = harness.as('primary');
    // device-side sync of both rows through the W1 store seam
    const synced = await owner.request('POST', '/api/blocks/sync', {
      baseRevision: 0,
      changes: [
        { id: spec.inputs.completeRow.id, baseRevision: 0, block: spec.inputs.completeRow },
        { id: spec.inputs.draftRow.id, baseRevision: 0, block: spec.inputs.draftRow },
      ],
    });
    assert.equal(synced.status, 200);
    assert.equal(synced.body.applied, 2, 'both rows persist in the sync layer');

    const converted = harness.adapt(spec.inputs.completeRow);
    assert.equal(converted.ok, true);
    assert.equal(validate(converted.block, blockSchema, { schemaDir: contractDir }).valid, true, 'converted block must pass the frozen schema');
    assert.equal(converted.block.source, spec.expect.convertedSource);
    assert.equal(converted.block.prio, spec.expect.convertedPrio);

    const rejected = harness.adapt(spec.inputs.draftRow);
    assert.equal(rejected.ok, false);
    assert.equal(rejected.outcome, spec.expect.rejectionOutcome);
    assert.deepEqual([...rejected.missing].sort(), [...spec.expect.rejectedMissingFields].sort());

    const executionBlocks = harness.executionLayerBlocks();
    assert.equal(executionBlocks.length, spec.expect.executionLayerBlockCount);
    assert.deepEqual(executionBlocks.map(block => block.id), spec.expect.convertedBlockIds);
  });
});

test('golden-2 (§5.2): capture → W12 scan → W6 preview → patch → traceable timeline projection', async () => {
  const spec = scenario('golden-2-perception-preview-projection');
  await withHarness(spec.id, async harness => {
    const owner = harness.as('primary');
    const uploaded = await owner.request('POST', '/api/captures', { fixture: spec.inputs.captureFixture });
    assert.equal(uploaded.status, 200, 'W12 scan accepts the fixture (fake vision, zero real calls)');
    const scanned = await owner.request('GET', uploaded.body.scanUrl);
    assert.equal(scanned.status, 200);

    const previewBefore = await owner.request('GET', '/api/missions/m-g2/preview');
    assert.equal(previewBefore.status, 200, 'preview persisted and readable');
    const revisionBefore = previewBefore.body.version ?? previewBefore.body.revision;

    const discussed = await owner.request('POST', '/api/missions/m-g2/discuss', { utterance: spec.inputs.discussionUtterance });
    assert.equal(discussed.status, 200, 'discussion patch applies');
    const revisionAfter = discussed.body.preview.version ?? discussed.body.preview.revision;
    assert.notEqual(revisionAfter, revisionBefore, 'patch must produce a new preview revision');

    const timeline = discussed.body.timeline ?? await owner.request('GET', '/api/missions/m-g2/preview/timeline');
    assert.ok(timeline, 'timeline projection is consumable');
    const previewRowAfterProjection = await owner.request('GET', '/api/missions/m-g2/preview');
    assert.deepEqual(
      previewRowAfterProjection.body.version ?? previewRowAfterProjection.body.revision,
      revisionAfter,
      'projection must not mutate the persisted preview row',
    );
  });
});

test('golden-3 (§5.3): A4 confirms once; repeat/expired/cross-owner/A5-auto all rejected with zero new effects', async () => {
  const spec = scenario('golden-3-autonomy-fence');
  await withHarness(spec.id, async harness => {
    const owner = harness.as('primary');
    const intruder = harness.as('secondary');

    const signed = await owner.request('POST', '/api/contracts/c-g3/sign', { goal: spec.inputs.contractGoal });
    assert.equal(signed.status, 200);

    // A4 #1: explicit per-action confirmation → exactly one external effect
    const first = await owner.request('POST', `/api/actions/${spec.inputs.a4Action.confirmationId}/confirm`, spec.inputs.a4Action);
    assert.equal(first.status, 200);
    assert.equal(harness.externalEffects().length, spec.expect.firstConfirmExternalEffects);

    // A4 repeat of the same confirmation → rejected, no second effect
    const repeat = await owner.request('POST', `/api/actions/${spec.inputs.a4Action.confirmationId}/confirm`, spec.inputs.a4Action);
    assert.ok(repeat.status >= 400, `repeat confirm must be rejected, got ${repeat.status}`);
    assert.ok(repeat.body.error && repeat.body.error.code, 'rejection uses the frozen envelope');
    assert.equal(harness.externalEffects().length, spec.expect.repeatConfirm.newExternalEffects + 1);

    // expired grant: advance past TTL, then attempt a fresh A4
    harness.clock.advance((spec.inputs.grantTtlSeconds + 60) * 1000);
    const expired = await owner.request('POST', '/api/actions/confirm-2/confirm', { ...spec.inputs.a4Action, confirmationId: 'confirm-2' });
    assert.ok(expired.status >= 400, 'action under an expired grant must be rejected');
    assert.equal(harness.externalEffects().length, spec.expect.expiredGrant.newExternalEffects + 1);

    // cross owner: owner-b tries to confirm owner-a's action → NOT_FOUND (existence hidden)
    const cross = await intruder.request('POST', `/api/actions/${spec.inputs.a4Action.confirmationId}/confirm`, spec.inputs.a4Action);
    assert.equal(cross.status, spec.expect.crossOwner.httpStatus);
    assert.equal(cross.body.error.code, spec.expect.crossOwner.code);
    assert.equal(harness.externalEffects().length, spec.expect.crossOwner.newExternalEffects + 1);

    // A5 auto-execution attempt → hard stop, no effect
    const a5 = await owner.request('POST', '/api/actions/auto-a5/execute', { kind: 'A5', action: 'money.transfer' });
    assert.ok(a5.status >= 400, 'A5 auto-execution must be rejected outright');
    assert.equal(harness.externalEffects().length, spec.expect.a5AutoAttempt.newExternalEffects + 1);
    assert.equal(harness.externalEffects().length, spec.expect.totalExternalEffects);
  });
});

test('golden-4 (§5.4): mission lifecycle, checkpointed runtime, crash recovery without duplicate external actions', async () => {
  const spec = scenario('golden-4-mission-runtime-recovery');
  await withHarness(spec.id, async harness => {
    const owner = harness.as('primary');
    const mission = await owner.request('POST', '/api/missions', { goal: '整理并发布周报' });
    assert.equal(mission.status, 200);
    const missionId = mission.body.id;

    for (const state of spec.inputs.missionStates) {
      const transition = await owner.request('POST', `/api/missions/${missionId}/state`, { to: state });
      assert.equal(transition.status, 200, `transition to ${state}`);
    }
    const missionStates = harness.events().filter(event => event.type === 'mission.state').map(event => event.state);
    assert.deepEqual(missionStates.slice(-3), spec.expect.stateSequence);

    // run with checkpoints; crash injection at step 2; recovery resumes without re-sending
    const run = await owner.request('POST', `/api/missions/${missionId}/runs`, { steps: spec.inputs.steps, crashAtStep: spec.inputs.crashAtStep });
    assert.equal(run.status, 200);
    const recovered = await owner.request('POST', `/api/runs/${run.body.id}/resume`, {});
    assert.equal(recovered.status, 200, 'recovery resumes from checkpoint');
    assert.equal(harness.externalEffects().filter(effect => effect.kind === 'external.send').length, spec.expect.externalSendsAfterRecovery, 'no external action duplicated after crash');

    // budget exhaustion → BUDGET_EXCEEDED envelope
    const bounded = await owner.request('POST', `/api/missions/${missionId}/runs`, { steps: 1, budget: spec.inputs.budget, exhaustAfter: spec.inputs.budgetExhaustAfter });
    assert.equal(bounded.status, spec.expect.budgetExhaustedHttp);
    assert.equal(bounded.body.error.code, spec.expect.budgetExhaustedCode);

    // resolved_model NULL → outcome unknown, no WorkResult success, no auto retry
    const modelless = await owner.request('POST', `/api/missions/${missionId}/runs`, { steps: 1, model: null });
    assert.equal(modelless.status, 200);
    const unknownRuns = harness.events().filter(event => event.type === 'run.completed' && event.outcome === spec.expect.nullModelOutcome);
    assert.ok(unknownRuns.length >= 1, 'a null-model run must complete as unknown');
    assert.equal(harness.modelTransport.successfulResultsFor(modelless.body.id), spec.expect.nullModelWorkResults);
    assert.equal(harness.modelTransport.retryCount(modelless.body.id), spec.expect.nullModelAutoRetries);
  });
});

test('golden-5 (§5.5): version chain, verifier gate and the accepted-benefit projection', async () => {
  const spec = scenario('golden-5-delivery-benefit-gate');
  await withHarness(spec.id, async harness => {
    const owner = harness.as('primary');
    const intruder = harness.as('secondary');

    for (const artifact of spec.inputs.artifacts) {
      const created = await owner.request('POST', '/api/artifacts', { version: artifact.version, content: `v${artifact.version}` });
      assert.equal(created.status, 200);
      const verified = await owner.request('POST', `/api/artifacts/${created.body.id}/verify`, { verdict: artifact.verdict, check: artifact.check });
      assert.equal(verified.status, 200);
      const decided = await owner.request('POST', `/api/artifacts/${created.body.id}/${artifact.decision === 'accepted' ? 'accept' : 'revise'}`, { comment: '' });
      assert.equal(decided.status, 200);
    }

    // cross-owner acceptance of the same artifact family → hidden
    const target = await owner.request('GET', '/api/artifacts?owner=self');
    const firstId = target.body.artifacts[0].id;
    const crossRead = await intruder.request('GET', `/api/artifacts/${firstId}`);
    assert.equal(crossRead.status, spec.expect.crossOwnerReadHttpStatus);

    const chain = await owner.request('GET', `/api/artifacts/${firstId}/versions`);
    assert.equal(chain.body.versions.length, spec.expect.versionChainLength);

    const inbox = await owner.request('GET', '/api/inbox');
    assert.equal(inbox.status, 200);
    assert.ok(inbox.body.items.some(item => item.kind === 'revision_request' || item.kind === 'need'), 'revision request projects into the Need inbox');

    const benefit = await owner.request('GET', '/api/artifacts/benefit');
    assert.equal(benefit.body.count, spec.expect.acceptedBenefitCount);
    assert.deepEqual(benefit.body.versions, spec.expect.countedVersions);
  });
});

test('golden-6 (§5.6): dual-device incremental sync, conflicts never overwrite, offline flush idempotent', async () => {
  const spec = scenario('golden-6-dual-device-sync');
  await withHarness(spec.id, async harness => {
    const deviceA = harness.as('device-a'); // same owner, two devices
    const deviceB = harness.as('device-b');

    const pushed = await deviceA.request('POST', '/api/blocks/sync', {
      baseRevision: 0,
      changes: spec.inputs.deviceAChanges.map(change => ({ id: change.id, baseRevision: 0, block: { date: '2026-10-29', start: '11:00', end: '12:00', title: change.title, kind: 'create', prio: 3, note: '', done: false, source: 'web' } })),
    });
    assert.equal(pushed.status, 200);
    const cursor = pushed.body.cursor;

    const pulled = await deviceB.request('POST', '/api/blocks/sync', { baseRevision: 0, changes: [] });
    const titles = pulled.body.serverChanges.map(change => change.block?.title ?? change.title).sort();
    assert.deepEqual(titles, [...spec.expect.deviceBReplayedTitles].sort(), 'device B replays both changes');

    // conflict: B edits blk-a1 against a stale base while A already moved ahead
    const conflicting = await deviceB.request('POST', '/api/blocks/sync', {
      baseRevision: 1,
      changes: [{ id: spec.inputs.conflictingEdit.id, baseRevision: 1, block: { date: '2026-10-29', start: '11:00', end: '12:00', title: spec.inputs.conflictingEdit.title, kind: 'create', prio: 3, note: '', done: false, source: 'web' } }],
    });
    assert.equal(conflicting.body.applied, 0);
    assert.ok(conflicting.body.conflicts.length >= 1, 'conflict must be reported, not overwritten');
    const serverTitle = conflicting.body.serverChanges.find(change => (change.id ?? change.block?.id) === 'blk-a1')?.block?.title
      ?? (await deviceA.request('GET', '/api/blocks?from=2026-10-29&to=2026-10-29')).body.blocks.find(block => block.id === 'blk-a1').title;
    assert.equal(serverTitle, spec.expect.serverTitleAfterConflict, 'server keeps the earlier write; the loser is told, not clobbered');

    // offline write + reconnect flush, then idempotent replay of the same batch
    const offline = { baseRevision: 2, changes: [{ id: 'blk-offline-1', baseRevision: 0, block: { date: '2026-10-29', start: '13:00', end: '14:00', title: '离线补写', kind: 'necessary', prio: 3, note: '', done: false, source: 'web' } }] };
    const flushed = await deviceB.request('POST', '/api/blocks/sync', offline);
    assert.equal(flushed.body.applied, spec.expect.offlineWritesFlushed);
    const replayed = await deviceB.request('POST', '/api/blocks/sync', offline);
    assert.equal(replayed.body.applied, spec.expect.replayAppliedCount, 'same-batch replay applies nothing new (idempotent)');
    assert.equal(replayed.body.cursor, flushed.body.cursor, spec.expect.cursorStableAfterReplay ? 'cursor stable across replay' : '');
  });
});

test('golden-7 (§5.7): observability records run/actor/model/gate/latency/cost and never upgrades degraded evidence', async () => {
  const spec = scenario('golden-7-observability-provenance');
  await withHarness(spec.id, async harness => {
    const owner = harness.as('primary');
    const trace = await owner.request('POST', '/api/runs/run-g7/trace', { actors: spec.inputs.actors, conflictingEvidence: spec.inputs.conflictingEvidence });
    assert.equal(trace.status, 200);

    for (const kind of spec.expect.recordedMetricKinds) {
      assert.ok(harness.events().some(event => String(event.type).includes(kind)) || trace.body.metrics?.[kind] !== undefined, `metric kind ${kind} must be recorded`);
    }

    const matrix = trace.body.matrix ?? await owner.request('GET', '/api/runs/run-g7/matrix');
    const rows = matrix.rows ?? matrix;
    const nullModelRow = rows.find(row => row.actor === 'w8·review' && row.resolvedModel === null);
    assert.equal(nullModelRow.status, spec.expect.nullModelStatus, 'NULL resolved_model stays UNKNOWN');
    const staleRow = rows.find(row => row.stale === true);
    assert.ok(spec.expect.staleStatusIn.includes(staleRow.status), `stale evidence must stay degraded, got ${staleRow.status}`);
    const conflictRow = rows.find(row => row.conflicting === true);
    assert.ok(spec.expect.conflictStatusIn.includes(conflictRow.status), `conflicting evidence must stay degraded, got ${conflictRow.status}`);
    assert.equal(rows.some(row => (row.actor === 'w8·review') && row.status === 'VERIFIED'), spec.expect.upgradedToVerified);
  });
});
