import test from 'node:test';
import assert from 'node:assert/strict';
import { loadModule } from './_harness.mjs';

const bundleApi = () => loadModule('bundle.mjs');

const HASH_A = 'a'.repeat(64);

const verifiedGate = (overrides = {}) => ({
  stream: 'W10',
  kind: 'unit',
  name: 'test:unit',
  head: '60fdc73',
  command: 'npm run test:unit',
  rc: 0,
  passed: 968,
  failed: 0,
  skipped: 2,
  evidence: [{ type: 'test-run', title: 'npm run test:unit', verified: true }],
  ...overrides,
});

const gatewayActor = (role, model = 'gpt-6-luna') => ({ role, model, modelSource: 'gateway' });

const emptyMetrics = () => ({
  latency: { count: 1, p50: 10, p90: 10, max: 10, unit: 'ms', incomplete: 0, status: 'KNOWN' },
  outcomes: { total: 1, succeeded: 1, failed: 0, timedOut: 0, incomplete: 0, failureRate: 0, timeoutRate: 0, incompleteRate: 0 },
  retries: { groups: 1, retriedGroups: 0, totalRetries: 0, maxAttempt: 0, recoveredGroups: 0 },
  cost: { calls: 1, tokens: 10, costCny: 0, costStatus: 'KNOWN', unknownCost: false, localShare: 1, localShareSamples: 1, freeRuns: 1, knownCostRuns: 1, unknownCostRuns: 0, runs: 1 },
  runs: { total: 1, byState: { succeeded: 1 } },
  acceptance: { total: 1, accepted: 1, acceptanceRate: 1, revisionRate: 0, rejectionRate: 0 },
  needs: { total: 0, defaulted: 0, expired: 0, open: 0, defaultRate: 'UNKNOWN' },
  grants: { total: 0, invalidated: 0, expired: 0, consumed: 0, active: 0 },
  status: 'KNOWN',
});

const baseBundleInput = (overrides = {}) => ({
  ownerId: 'owner-a',
  run: { id: 'run-1', missionId: 'm-1', contractHash: HASH_A, state: 'succeeded', startedAt: '2026-10-27T10:00:00.000Z', updatedAt: '2026-10-27T10:01:00.000Z' },
  actors: [gatewayActor('conductor', 'gpt-6.1-sol'), gatewayActor('verifier')],
  gates: [verifiedGate(), verifiedGate({ kind: 'web', name: 'verify:web', command: 'npm run verify:web' })],
  webEvidence: { command: 'npm run verify:web', rc: 0, passed: 227, failed: 0, skipped: 0 },
  metrics: emptyMetrics(),
  cache: { verified: [], stale: [], unverifiable: [] },
  spans: [],
  now: '2026-10-27T11:00:00.000Z',
  slaMs: 60_000,
  ...overrides,
});

test('bundle: a fully evidenced run verdicts VERIFIED and lists its evidence', async () => {
  const { assembleBundle, BUNDLE_STATUS } = await bundleApi();
  const bundle = assembleBundle(baseBundleInput());
  assert.equal(bundle.status, BUNDLE_STATUS.VERIFIED);
  assert.deepEqual(bundle.unknowns, []);
  assert.equal(bundle.run.id, 'run-1');
  assert.equal(bundle.provenance.resolved, 2);
  assert.equal(bundle.gates.summary.verified, 2);
  assert.ok(bundle.evidence.length >= 2);
  assert.ok(bundle.evidence.every((item) => item.verified === true));
});

test('bundle: a run with an unresolved actor is UNKNOWN, not VERIFIED (red line 7)', async () => {
  const { assembleBundle, BUNDLE_STATUS } = await bundleApi();
  const bundle = assembleBundle(baseBundleInput({
    actors: [gatewayActor('conductor', 'gpt-6.1-sol'), { role: 'reviewer' }],
  }));
  assert.equal(bundle.status, BUNDLE_STATUS.UNKNOWN);
  assert.ok(bundle.unknowns.some((item) => item.code === 'ACTOR_UNRESOLVED' && item.role === 'reviewer'));
});

test('bundle: mock review evidence downgrades to PROVISIONAL (BRIEF §3)', async () => {
  const { assembleBundle, BUNDLE_STATUS } = await bundleApi();
  const bundle = assembleBundle(baseBundleInput({
    actors: [gatewayActor('conductor', 'gpt-6.1-sol'), { role: 'reviewer', model: 'glm-5.3', modelSource: 'mock' }],
  }));
  assert.equal(bundle.status, BUNDLE_STATUS.PROVISIONAL);
  assert.ok(bundle.unknowns.some((item) => item.code === 'ACTOR_NOT_VERIFIABLE' && item.role === 'reviewer'));
});

test('bundle: a failing gate BLOCKS the run regardless of everything else', async () => {
  const { assembleBundle, BUNDLE_STATUS } = await bundleApi();
  const bundle = assembleBundle(baseBundleInput({
    gates: [verifiedGate({ rc: 1, failed: 3, evidence: [] })],
  }));
  assert.equal(bundle.status, BUNDLE_STATUS.BLOCKED);
  assert.ok(bundle.unknowns.some((item) => item.code === 'GATE_FAILED'));
});

test('bundle: a gate with no rc is UNKNOWN, because nothing was proven (N5)', async () => {
  const { assembleBundle, BUNDLE_STATUS } = await bundleApi();
  const bundle = assembleBundle(baseBundleInput({
    gates: [verifiedGate({ rc: undefined })],
  }));
  assert.equal(bundle.status, BUNDLE_STATUS.UNKNOWN);
  assert.ok(bundle.unknowns.some((item) => item.code === 'GATE_INCOMPLETE'));
});

test('bundle: unit tests alone can never reach VERIFIED (N13)', async () => {
  const { assembleBundle, BUNDLE_STATUS } = await bundleApi();
  const bundle = assembleBundle(baseBundleInput({
    gates: [verifiedGate({ kind: 'unit' }), verifiedGate({ kind: 'contract', name: 'contracts' })],
    webEvidence: null,
  }));
  assert.equal(bundle.status, BUNDLE_STATUS.PROVISIONAL);
  assert.ok(bundle.unknowns.some((item) => item.code === 'E2E_EVIDENCE_MISSING'));
});

test('bundle: missing web evidence is UNKNOWN-class, never a silent pass', async () => {
  const { assembleBundle, BUNDLE_STATUS } = await bundleApi();
  const bundle = assembleBundle(baseBundleInput({
    webEvidence: { command: 'npm run verify:web' },
  }));
  assert.notEqual(bundle.status, BUNDLE_STATUS.VERIFIED);
  assert.ok(bundle.unknowns.some((item) => item.code === 'E2E_EVIDENCE_MISSING'));
});

test('bundle: a failing web gate blocks the run', async () => {
  const { assembleBundle, BUNDLE_STATUS } = await bundleApi();
  const bundle = assembleBundle(baseBundleInput({
    webEvidence: { command: 'npm run verify:web', rc: 1, passed: 220, failed: 7 },
  }));
  assert.equal(bundle.status, BUNDLE_STATUS.BLOCKED);
});

test('bundle: a stale cache entry is reported and excluded from evidence (N7)', async () => {
  const { assembleBundle } = await bundleApi();
  const bundle = assembleBundle(baseBundleInput({
    cache: {
      verified: [{ key: 'k1', kind: 'block-summary', freshness: 'FRESH', verifiable: true }],
      stale: [{ key: 'k2', kind: 'block-summary', freshness: 'STALE', reasons: ['contractHash'], verifiable: false }],
      unverifiable: [],
    },
  }));
  assert.equal(bundle.cache.stale.length, 1);
  assert.ok(bundle.unknowns.some((item) => item.code === 'CACHE_STALE' && item.key === 'k2'));
  assert.ok(bundle.evidence.every((item) => item.key !== 'k2'));
});

test('bundle: a mock cache entry is never counted as end-to-end success (N8)', async () => {
  const { assembleBundle, BUNDLE_STATUS } = await bundleApi();
  const bundle = assembleBundle(baseBundleInput({
    cache: {
      verified: [],
      stale: [],
      unverifiable: [{ key: 'k3', kind: 'block-summary', freshness: 'UNVERIFIABLE', modelSource: 'mock', verifiable: false }],
    },
  }));
  assert.equal(bundle.status, BUNDLE_STATUS.PROVISIONAL);
  assert.ok(bundle.unknowns.some((item) => item.code === 'CACHE_UNVERIFIABLE' && item.key === 'k3'));
});

test('bundle: an incomplete span propagates UNKNOWN into the bundle (N10)', async () => {
  const { assembleBundle, BUNDLE_STATUS } = await bundleApi();
  const bundle = assembleBundle(baseBundleInput({
    spans: [
      { id: 'cut', name: 'worker', kind: 'invoke_agent', status: 'running', outcome: 'running', incomplete: true },
    ],
  }));
  assert.equal(bundle.status, BUNDLE_STATUS.UNKNOWN);
  assert.ok(bundle.unknowns.some((item) => item.code === 'SPAN_INCOMPLETE' && item.id === 'cut'));
});

test('bundle: a timed-out span is neither success nor failure but does not by itself verify', async () => {
  const { assembleBundle, BUNDLE_STATUS } = await bundleApi();
  const bundle = assembleBundle(baseBundleInput({
    spans: [{ id: 'slow', name: 'worker', kind: 'invoke_agent', status: 'running', outcome: 'timed_out', incomplete: true }],
  }));
  assert.notEqual(bundle.status, BUNDLE_STATUS.VERIFIED);
  assert.ok(bundle.unknowns.some((item) => item.code === 'SPAN_TIMED_OUT' && item.id === 'slow'));
});

test('bundle: cost UNKNOWN surfaces as an explicit unknown instead of a 0 (N6)', async () => {
  const { assembleBundle } = await bundleApi();
  const metrics = emptyMetrics();
  metrics.cost = { ...metrics.cost, costCny: null, costStatus: 'UNKNOWN', unknownCost: true };
  const bundle = assembleBundle(baseBundleInput({ metrics }));
  assert.ok(bundle.unknowns.some((item) => item.code === 'COST_UNKNOWN'));
  assert.equal(bundle.metrics.cost.costCny, null);
});

test('bundle: an empty roster is UNKNOWN (nothing to prove with)', async () => {
  const { assembleBundle, BUNDLE_STATUS } = await bundleApi();
  const bundle = assembleBundle(baseBundleInput({ actors: [] }));
  assert.equal(bundle.status, BUNDLE_STATUS.UNKNOWN);
  assert.ok(bundle.unknowns.some((item) => item.code === 'ACTOR_ROSTER_EMPTY'));
});

test('bundle: BLOCKED outranks UNKNOWN and PROVISIONAL never outranks a failure', async () => {
  const { assembleBundle, BUNDLE_STATUS } = await bundleApi();
  const bundle = assembleBundle(baseBundleInput({
    actors: [],
    gates: [verifiedGate({ rc: 1, evidence: [] })],
  }));
  assert.equal(bundle.status, BUNDLE_STATUS.BLOCKED);
});

test('bundle: owner scoping is explicit and required', async () => {
  const { assembleBundle } = await bundleApi();
  assert.throws(() => assembleBundle(baseBundleInput({ ownerId: undefined })), (error) => error.code === 'OWNER_REQUIRED');
});

test('bundle: the bundle is JSON serialisable so it can be persisted as evidence', async () => {
  const { assembleBundle } = await bundleApi();
  const bundle = assembleBundle(baseBundleInput());
  assert.doesNotThrow(() => JSON.stringify(bundle));
  assert.equal(typeof bundle.status, 'string');
  assert.ok(Array.isArray(bundle.unknowns));
  assert.ok(Array.isArray(bundle.evidence));
});
