import test from 'node:test';
import assert from 'node:assert/strict';
import { loadModule } from './_harness.mjs';

const metricsApi = () => loadModule('metrics.mjs');

// Deterministic step samples: 10 latencies (ms) used across percentile tests.
const latencySteps = [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000].map((ms, index) => ({
  id: `step-${index}`,
  runId: 'run-1',
  kind: 'execute',
  state: 'succeeded',
  attempt: 0,
  startedAt: `2026-10-27T10:00:00.000Z`,
  finishedAt: new Date(Date.parse('2026-10-27T10:00:00.000Z') + ms).toISOString(),
}));

test('metrics: percentile uses nearest-rank on a sorted sample', async () => {
  const { percentile } = await metricsApi();
  assert.equal(percentile([], 50), null);
  assert.equal(percentile([5], 50), 5);
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 50), 5);
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90), 9);
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 99), 10);
  assert.equal(percentile([4, 1, 3, 2], 50), 2);
});

test('metrics: percentile rejects an out-of-range p and ignores non-finite samples', async () => {
  const { percentile } = await metricsApi();
  assert.throws(() => percentile([1, 2, 3], 0), (error) => error.code === 'INVALID_ARGUMENT');
  assert.throws(() => percentile([1, 2, 3], 101), (error) => error.code === 'INVALID_ARGUMENT');
  assert.equal(percentile([1, 2, Number.NaN, 3, Infinity], 50), 2);
});

test('metrics: step latency reports p50 and p90 from step timestamps (PRD §12)', async () => {
  const { latencyMetrics } = await metricsApi();
  const result = latencyMetrics(latencySteps);
  assert.equal(result.count, 10);
  assert.equal(result.p50, 500);
  assert.equal(result.p90, 900);
  assert.equal(result.max, 1000);
  assert.equal(result.unit, 'ms');
});

test('metrics: latency is UNKNOWN (not 0) when there is no measurable step', async () => {
  const { latencyMetrics } = await metricsApi();
  const result = latencyMetrics([]);
  assert.equal(result.count, 0);
  assert.equal(result.p50, 'UNKNOWN');
  assert.equal(result.p90, 'UNKNOWN');
});

test('metrics: a step missing finishedAt is excluded from latency but counted incomplete', async () => {
  const { latencyMetrics } = await metricsApi();
  const result = latencyMetrics([...latencySteps, { id: 'cut', state: 'running', startedAt: '2026-10-27T10:00:00.000Z' }]);
  assert.equal(result.count, 10);
  assert.equal(result.incomplete, 1);
  assert.equal(result.p50, 500);
});

test('metrics: failure, timeout and incomplete rates are computed over total steps', async () => {
  const { stepOutcomeMetrics } = await metricsApi();
  const result = stepOutcomeMetrics([
    { id: 'a', state: 'succeeded' },
    { id: 'b', state: 'failed' },
    { id: 'c', state: 'succeeded', timedOut: true },
    { id: 'd', state: 'running', incomplete: true },
  ]);
  assert.equal(result.total, 4);
  assert.equal(result.succeeded, 1);
  assert.equal(result.failed, 1);
  assert.equal(result.timedOut, 1);
  assert.equal(result.incomplete, 1);
  assert.equal(result.failureRate, 0.25);
  assert.equal(result.timeoutRate, 0.25);
  assert.equal(result.incompleteRate, 0.25);
});

test('metrics: rates are UNKNOWN rather than 0 for an empty sample', async () => {
  const { stepOutcomeMetrics } = await metricsApi();
  const result = stepOutcomeMetrics([]);
  assert.equal(result.failureRate, 'UNKNOWN');
  assert.equal(result.timeoutRate, 'UNKNOWN');
  assert.equal(result.incompleteRate, 'UNKNOWN');
});

test('metrics: retries are counted as attempt>0 grouped by inputHash (recovery semantics, N11)', async () => {
  const { retryMetrics } = await metricsApi();
  const steps = [
    { id: 's1', inputHash: 'h1', attempt: 0, state: 'failed' },
    { id: 's2', inputHash: 'h1', attempt: 1, state: 'failed' },
    { id: 's3', inputHash: 'h1', attempt: 2, state: 'succeeded' },
    { id: 's4', inputHash: 'h2', attempt: 0, state: 'succeeded' },
  ];
  const result = retryMetrics(steps);
  assert.equal(result.groups, 2);
  assert.equal(result.retriedGroups, 1);
  assert.equal(result.totalRetries, 2);
  assert.equal(result.maxAttempt, 2);
  assert.equal(result.recoveredGroups, 1);
});

test('metrics: a replay that reuses attempt numbers does not double-count calls (N11)', async () => {
  const { reconcileSpendReplay } = await metricsApi();
  const original = [{ stepId: 's1', attempt: 0, calls: 3, tokens: 900, costCny: 0.12 }];
  const replay = [
    { stepId: 's1', attempt: 0, calls: 3, tokens: 900, costCny: 0.12 },
    { stepId: 's1', attempt: 1, calls: 2, tokens: 400, costCny: 0.05 },
  ];
  const result = reconcileSpendReplay({ original, replay });
  assert.equal(result.calls, 5);
  assert.equal(result.tokens, 1300);
  assert.equal(result.deduped, 1);
});

test('metrics: cost metrics keep an unknown costCny as UNKNOWN and never sum it as 0 (N6)', async () => {
  const { costMetrics } = await metricsApi();
  const result = costMetrics([
    { calls: 3, tokens: 900, costCny: 0.12, localShare: 0 },
    { calls: 2, tokens: 400, costCny: null, localShare: 1 },
    { calls: 1, tokens: 100, costCny: 0, localShare: 1 },
  ]);
  assert.equal(result.calls, 6);
  assert.equal(result.tokens, 1400);
  assert.equal(result.runs, 3);
  assert.equal(result.knownCostRuns, 2);
  assert.equal(result.unknownCostRuns, 1);
  assert.equal(Number(result.costCny.toFixed(2)), 0.12);
  assert.equal(result.costStatus, 'PARTIAL');
  assert.equal(result.unknownCost, true);
});

test('metrics: cost is UNKNOWN when every spend row is missing costCny', async () => {
  const { costMetrics } = await metricsApi();
  const result = costMetrics([{ calls: 1, tokens: 10, costCny: null }]);
  assert.equal(result.costCny, null);
  assert.equal(result.costStatus, 'UNKNOWN');
  assert.equal(result.unknownCost, true);
});

test('metrics: an explicit free model (costCny=0) is distinguishable from unknown', async () => {
  const { costMetrics } = await metricsApi();
  const free = costMetrics([{ calls: 3, tokens: 900, costCny: 0, localShare: 1 }]);
  assert.equal(free.costCny, 0);
  assert.equal(free.costStatus, 'KNOWN');
  assert.equal(free.unknownCost, false);
  assert.equal(free.freeRuns, 1);
  assert.equal(free.localShare, 1);
});

test('metrics: localShare aggregates only rows that report it', async () => {
  const { costMetrics } = await metricsApi();
  const result = costMetrics([
    { calls: 1, tokens: 10, costCny: 0, localShare: 1 },
    { calls: 1, tokens: 10, costCny: 0.1, localShare: 0 },
    { calls: 1, tokens: 10, costCny: 0.1 },
  ]);
  assert.equal(result.localShare, 0.5);
  assert.equal(result.localShareSamples, 2);
});

test('metrics: run metrics group by state using the frozen 8-state enum', async () => {
  const { runMetrics } = await metricsApi();
  const result = runMetrics([
    { id: 'r1', state: 'succeeded' },
    { id: 'r2', state: 'succeeded' },
    { id: 'r3', state: 'unknown' },
  ]);
  assert.equal(result.total, 3);
  assert.equal(result.byState.succeeded, 2);
  assert.equal(result.byState.unknown, 1);
  assert.equal(result.byState.failed, 0);
  assert.equal(result.byState.partial, 0);
});

test('metrics: run metrics reject an out-of-enum run state', async () => {
  const { runMetrics } = await metricsApi();
  assert.throws(() => runMetrics([{ id: 'r1', state: 'done' }]), (error) => error.code === 'CONTRACT_INVALID');
});

test('metrics: acceptance rate counts only accepted decisions (PRD §5.6)', async () => {
  const { acceptanceMetrics } = await metricsApi();
  const result = acceptanceMetrics([
    { id: 'a1', decision: 'accepted' },
    { id: 'a2', decision: 'revision_requested' },
    { id: 'a3', decision: 'rejected' },
    { id: 'a4', decision: 'accepted' },
  ]);
  assert.equal(result.total, 4);
  assert.equal(result.accepted, 2);
  assert.equal(result.acceptanceRate, 0.5);
  assert.equal(result.revisionRate, 0.25);
  assert.equal(result.rejectionRate, 0.25);
});

test('metrics: acceptance rate is UNKNOWN with no decisions', async () => {
  const { acceptanceMetrics } = await metricsApi();
  assert.equal(acceptanceMetrics([]).acceptanceRate, 'UNKNOWN');
});

test('metrics: need metrics count defaulted/expired as attention defects', async () => {
  const { needMetrics } = await metricsApi();
  const result = needMetrics([
    { id: 'n1', status: 'answered' },
    { id: 'n2', status: 'defaulted' },
    { id: 'n3', status: 'expired' },
    { id: 'n4', status: 'open' },
  ]);
  assert.equal(result.total, 4);
  assert.equal(result.defaulted, 1);
  assert.equal(result.expired, 1);
  assert.equal(result.open, 1);
  assert.equal(result.defaultRate, 0.25);
});

test('metrics: grant metrics count invalidated and expired revocations', async () => {
  const { grantMetrics } = await metricsApi();
  const result = grantMetrics([
    { id: 'g1', status: 'active' },
    { id: 'g2', status: 'invalidated' },
    { id: 'g3', status: 'expired' },
    { id: 'g4', status: 'consumed' },
  ]);
  assert.equal(result.total, 4);
  assert.equal(result.invalidated, 1);
  assert.equal(result.expired, 1);
  assert.equal(result.consumed, 1);
  assert.equal(result.active, 1);
});

test('metrics: buildMetrics composes every section with per-section evidence status', async () => {
  const { buildMetrics } = await metricsApi();
  const metrics = buildMetrics({
    steps: latencySteps,
    spend: [{ calls: 3, tokens: 900, costCny: 0.12, localShare: 0 }],
    runs: [{ id: 'r1', state: 'succeeded' }],
    acceptances: [{ id: 'a1', decision: 'accepted' }],
    needs: [{ id: 'n1', status: 'answered' }],
    grants: [{ id: 'g1', status: 'active' }],
  });
  assert.equal(metrics.latency.p50, 500);
  assert.equal(metrics.cost.calls, 3);
  assert.equal(metrics.runs.total, 1);
  assert.equal(metrics.acceptance.acceptanceRate, 1);
  assert.equal(metrics.status, 'PROVISIONAL');
  for (const section of ['latency', 'outcomes', 'retries', 'cost', 'runs', 'acceptance', 'needs', 'grants']) {
    assert.ok(section in metrics, `missing ${section}`);
  }
});

test('metrics: buildMetrics marks sections with no data UNKNOWN, not zero', async () => {
  const { buildMetrics } = await metricsApi();
  const metrics = buildMetrics({});
  assert.equal(metrics.latency.p50, 'UNKNOWN');
  assert.equal(metrics.cost.costCny, 'UNKNOWN');
  assert.equal(metrics.acceptance.acceptanceRate, 'UNKNOWN');
  assert.equal(metrics.status, 'UNKNOWN');
});

// ---------------------------------------------------------------------------
// Re-run additions (plan §2.1/§2.3/N6/N9/N10/N11 + DAG edge obs-spans →
// obs-metrics). These pin the store-row seam (obs_*.sql snake_case columns),
// the span-row seam (ended_at) and the replay/timeout semantics the plan words
// exactly. Written RED before the implementation change.
// ---------------------------------------------------------------------------

const T0 = '2026-10-27T10:00:00.000Z';
const at = (ms) => new Date(Date.parse(T0) + ms).toISOString();

test('metrics: latency reads store rows (obs_steps snake_case columns) without silently marking them incomplete', async () => {
  const { latencyMetrics } = await metricsApi();
  const result = latencyMetrics([
    { id: 'db1', run_id: 'run-1', name: 'execute', kind: 'execute', state: 'succeeded', attempt: 0, input_hash: 'h1', started_at: T0, finished_at: at(250) },
  ]);
  assert.equal(result.count, 1);
  assert.equal(result.notStarted, 0);
  assert.equal(result.incomplete, 0);
  assert.equal(result.p50, 250);
  assert.equal(result.max, 250);
});

test('metrics: latency reads span rows (endedAt/ended_at) so span trees feed the same metric', async () => {
  const { latencyMetrics } = await metricsApi();
  const result = latencyMetrics([
    { id: 'sp1', name: 'chat m', kind: 'chat', status: 'ok', startedAt: T0, endedAt: at(1000) },
    { id: 'sp2', name: 'chat m', kind: 'chat', status: 'ok', started_at: T0, ended_at: at(3000) },
  ]);
  assert.equal(result.count, 2);
  assert.equal(result.incomplete, 0);
  assert.equal(result.p50, 1000);
  assert.equal(result.p90, 3000);
});

test('metrics: a step that never started is notStarted, not incomplete (N10 needs startedAt)', async () => {
  const { latencyMetrics } = await metricsApi();
  const result = latencyMetrics([
    { id: 's1', runId: 'run-1', kind: 'execute', state: 'succeeded', attempt: 0, startedAt: T0, finishedAt: at(500) },
    { id: 'p1', runId: 'run-1', kind: 'plan', state: 'pending', attempt: 0 },
  ]);
  assert.equal(result.count, 1);
  assert.equal(result.notStarted, 1);
  assert.equal(result.incomplete, 0);
  assert.equal(result.p50, 500);
});

test('metrics: a running store row with no finished_at is derived incomplete (N10)', async () => {
  const { stepOutcomeMetrics } = await metricsApi();
  const result = stepOutcomeMetrics([
    { id: 'db1', run_id: 'run-1', name: 'execute', kind: 'execute', state: 'running', attempt: 0, input_hash: 'h1', started_at: T0, finished_at: null },
  ]);
  assert.equal(result.total, 1);
  assert.equal(result.incomplete, 1);
  assert.equal(result.succeeded, 0);
  assert.equal(result.failed, 0);
  assert.equal(result.timedOut, 0);
});

test('metrics: a timed-out step counts as neither failed nor succeeded (N9)', async () => {
  const { stepOutcomeMetrics } = await metricsApi();
  const result = stepOutcomeMetrics([{ id: 't1', state: 'failed', timedOut: true }]);
  assert.equal(result.timedOut, 1);
  assert.equal(result.succeeded, 0);
  assert.equal(result.failed, 0);
  assert.equal(result.timeoutRate, 1);
  assert.equal(result.failureRate, 0);
});

test('metrics: classifyOutcome-style span records feed outcome metrics (DAG obs-spans → obs-metrics)', async () => {
  const { stepOutcomeMetrics } = await metricsApi();
  const result = stepOutcomeMetrics([
    { id: 'sp1', status: 'ok', outcome: 'succeeded', incomplete: false },
    { id: 'sp2', status: 'running', outcome: 'timed_out', incomplete: true },
    { id: 'sp3', status: 'error', outcome: 'failed', incomplete: false },
  ]);
  assert.equal(result.total, 3);
  assert.equal(result.succeeded, 1);
  assert.equal(result.failed, 1);
  assert.equal(result.timedOut, 1);
  assert.equal(result.incomplete, 1);
  assert.equal(result.failureRate, 1 / 3);
  assert.equal(result.timeoutRate, 1 / 3);
});

test('metrics: a replay that re-records attempts does not double-count retries (N11)', async () => {
  const { retryMetrics } = await metricsApi();
  const result = retryMetrics([
    { id: 's1', inputHash: 'h1', attempt: 0, state: 'failed' },
    { id: 's2', inputHash: 'h1', attempt: 1, state: 'succeeded' },
    { id: 's1', inputHash: 'h1', attempt: 0, state: 'failed' }, // replay re-record
    { id: 's2', inputHash: 'h1', attempt: 1, state: 'succeeded' }, // replay re-record
  ]);
  assert.equal(result.groups, 1);
  assert.equal(result.retriedGroups, 1);
  assert.equal(result.totalRetries, 1);
  assert.equal(result.maxAttempt, 1);
  assert.equal(result.recoveredGroups, 1);
});

test('metrics: retry recovery follows the highest attempt, not row order (N11)', async () => {
  const { retryMetrics } = await metricsApi();
  const result = retryMetrics([
    { id: 's2', inputHash: 'h1', attempt: 1, state: 'succeeded' },
    { id: 's1', inputHash: 'h1', attempt: 0, state: 'failed' },
  ]);
  assert.equal(result.groups, 1);
  assert.equal(result.totalRetries, 1);
  assert.equal(result.recoveredGroups, 1);
});

test('metrics: retry groups read store rows keyed by input_hash', async () => {
  const { retryMetrics } = await metricsApi();
  const result = retryMetrics([
    { id: 's1', run_id: 'r', input_hash: 'h1', attempt: 0, state: 'failed' },
    { id: 's2', run_id: 'r', input_hash: 'h1', attempt: 1, state: 'failed' },
    { id: 's3', run_id: 'r', input_hash: 'h2', attempt: 0, state: 'succeeded' },
  ]);
  assert.equal(result.groups, 2);
  assert.equal(result.totalRetries, 1);
  assert.equal(result.recoveredGroups, 0);
});

test('metrics: reconcileSpendReplay dedupes across store and contract row shapes (N11)', async () => {
  const { reconcileSpendReplay } = await metricsApi();
  const result = reconcileSpendReplay({
    original: [{ run_id: 'r1', step_id: 's1', attempt: 0, calls: 3, tokens: 900, cost_cny: 0.12, local_share: 0 }],
    replay: [{ stepId: 's1', attempt: 0, calls: 3, tokens: 900, costCny: 0.12, localShare: 0 }],
  });
  assert.equal(result.deduped, 1);
  assert.equal(result.calls, 3);
  assert.equal(result.tokens, 900);
});

test('metrics: cost metrics read store rows and keep NULL cost_cny unknown (N6)', async () => {
  const { costMetrics } = await metricsApi();
  const result = costMetrics([
    { run_id: 'r1', step_id: 's1', attempt: 0, calls: 2, tokens: 120, cost_cny: null, local_share: 1 },
  ]);
  assert.equal(result.runs, 1);
  assert.equal(result.calls, 2);
  assert.equal(result.tokens, 120);
  assert.equal(result.knownCostRuns, 0);
  assert.equal(result.unknownCostRuns, 1);
  assert.equal(result.costCny, null);
  assert.equal(result.costStatus, 'UNKNOWN');
  assert.equal(result.unknownCost, true);
  assert.equal(result.localShare, 1);
  assert.equal(result.localShareSamples, 1);
});

test('metrics: cost metrics read an explicit free store row as free, not unknown (N6)', async () => {
  const { costMetrics } = await metricsApi();
  const result = costMetrics([{ step_id: 's1', attempt: 0, calls: 1, tokens: 5, cost_cny: 0, local_share: 1 }]);
  assert.equal(result.knownCostRuns, 1);
  assert.equal(result.costCny, 0);
  assert.equal(result.costStatus, 'KNOWN');
  assert.equal(result.freeRuns, 1);
  assert.equal(result.unknownCost, false);
});

test('metrics: need metrics expose the expired (timeout) rate alongside the default rate', async () => {
  const { needMetrics } = await metricsApi();
  const result = needMetrics([
    { id: 'n1', status: 'answered' },
    { id: 'n2', status: 'expired' },
  ]);
  assert.equal(result.expired, 1);
  assert.equal(result.expiredRate, 0.5);
  assert.equal(result.defaultRate, 0);
});
