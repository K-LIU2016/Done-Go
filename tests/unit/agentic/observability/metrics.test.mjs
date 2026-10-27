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
