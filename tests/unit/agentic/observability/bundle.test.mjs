import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { loadModule, CONTRACTS_DIR } from './_harness.mjs';

const bundleApi = () => loadModule('bundle.mjs');
const contractsApi = () => import('../../../../scripts/agentic/contracts.mjs');
const contractsDir = () => fileURLToPath(CONTRACTS_DIR);

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

test('bundle: every emitted evidence entry validates against the frozen evidence schema (plan §2.1, N15 spirit)', async () => {
  const { assembleBundle } = await bundleApi();
  const { loadSchema, validate } = await contractsApi();
  const schema = loadSchema('evidence.schema.json', contractsDir());
  const bundle = assembleBundle(baseBundleInput({
    cache: { verified: [{ key: 'k1', kind: 'block-summary', freshness: 'FRESH', verifiable: true }], stale: [], unverifiable: [] },
  }));
  // 2 verified gate items + 1 fresh cache metric + 1 web test-run must all travel.
  assert.ok(bundle.evidence.length >= 4, `expected >=4 evidence entries, got ${bundle.evidence.length}`);
  for (const item of bundle.evidence) {
    const result = validate(item, schema, { schemaDir: contractsDir() });
    assert.equal(result.valid, true, `evidence item violates frozen schema: ${JSON.stringify(item)} errors=${JSON.stringify(result.errors)}`);
  }
  // Attribution that no longer fits the frozen shape must remain discoverable
  // in schema-legal fields (detail), not in smuggled top-level keys.
  const cacheMetric = bundle.evidence.find((item) => item.type === 'metric');
  assert.ok(cacheMetric && cacheMetric.detail.includes('k1'), 'cache key must survive inside detail');
  const webRun = bundle.evidence.find((item) => item.type === 'test-run' && item.title === 'npm run verify:web');
  assert.ok(webRun && webRun.detail.includes('rc=0') && webRun.detail.includes('227'), 'web counts must survive inside detail');
});

test('bundle: mock-marked evidence never travels as verified evidence and caps the run (BRIEF §3)', async () => {
  const { assembleBundle, BUNDLE_STATUS } = await bundleApi();
  const bundle = assembleBundle(baseBundleInput({
    gates: [
      verifiedGate({ evidence: [{ type: 'test-run', title: 'mocked run', verified: true, source: 'mock' }] }),
      verifiedGate({ kind: 'web', name: 'verify:web', command: 'npm run verify:web' }),
    ],
  }));
  assert.notEqual(bundle.status, BUNDLE_STATUS.VERIFIED);
  assert.ok(bundle.unknowns.some((item) => item.code === 'EVIDENCE_INVALID' && item.severity === 'PROVISIONAL'));
  assert.ok(bundle.evidence.every((item) => item.title !== 'mocked run'));
});

test('bundle: an unresolved HIGH finding blocks the run (plan §2.4: HIGH 未修 → BLOCKED)', async () => {
  const { assembleBundle, BUNDLE_STATUS } = await bundleApi();
  const bundle = assembleBundle(baseBundleInput({
    findings: [{ id: 'R-1', severity: 'HIGH', status: 'open', title: 'unpatched injection' }],
  }));
  assert.equal(bundle.status, BUNDLE_STATUS.BLOCKED);
  assert.ok(bundle.unknowns.some((item) => item.code === 'FINDING_OPEN' && item.id === 'R-1' && item.severity === 'BLOCKED'));

  const critical = assembleBundle(baseBundleInput({
    findings: [{ id: 'R-1b', severity: 'CRITICAL', status: 'open' }],
  }));
  assert.equal(critical.status, BUNDLE_STATUS.BLOCKED);
});

test('bundle: resolved findings do not block; an open MEDIUM caps at PROVISIONAL (plan §2.4)', async () => {
  const { assembleBundle, BUNDLE_STATUS } = await bundleApi();
  const bundle = assembleBundle(baseBundleInput({
    findings: [
      { id: 'R-2', severity: 'HIGH', status: 'resolved' },
      { id: 'R-3', severity: 'MEDIUM', status: 'open' },
    ],
  }));
  assert.equal(bundle.status, BUNDLE_STATUS.PROVISIONAL);
  assert.ok(!bundle.unknowns.some((item) => item.id === 'R-2'));
  const medium = bundle.unknowns.find((item) => item.code === 'FINDING_OPEN' && item.id === 'R-3');
  assert.equal(medium.severity, 'PROVISIONAL');
});

test('bundle: absent findings change nothing (no heuristic guessing about reviews that never ran)', async () => {
  const { assembleBundle, BUNDLE_STATUS } = await bundleApi();
  const bundle = assembleBundle(baseBundleInput());
  assert.equal(bundle.status, BUNDLE_STATUS.VERIFIED);
  assert.ok(!bundle.unknowns.some((item) => item.code === 'FINDING_OPEN'));
});

test('bundle: a passing gate with no evidence at all is UNKNOWN (plan §2.1: gate 必挂 evidence)', async () => {
  const { assembleBundle, BUNDLE_STATUS } = await bundleApi();
  const bundle = assembleBundle(baseBundleInput({
    gates: [verifiedGate(), verifiedGate({ kind: 'web', name: 'verify:web', command: 'npm run verify:web' }), verifiedGate({ name: 'lint', evidence: [] })],
  }));
  assert.equal(bundle.status, BUNDLE_STATUS.UNKNOWN);
  assert.ok(bundle.unknowns.some((item) => item.code === 'GATE_INCOMPLETE' && item.reason === 'NO_EVIDENCE' && item.gate === 'lint'));
});

test('bundle: a span that ended in error is a demonstrated failure and blocks the run (N10 family)', async () => {
  const { assembleBundle, BUNDLE_STATUS } = await bundleApi();
  const bundle = assembleBundle(baseBundleInput({
    spans: [{ id: 'boom', name: 'worker', kind: 'invoke_agent', status: 'error', outcome: 'failed', incomplete: false }],
  }));
  assert.equal(bundle.status, BUNDLE_STATUS.BLOCKED);
  assert.ok(bundle.unknowns.some((item) => item.code === 'SPAN_INCOMPLETE' && item.id === 'boom' && item.severity === 'BLOCKED'));
});

test('bundle: a run with zero gates proves nothing and is UNKNOWN (plan §2.4: 缺 test 命令/rc)', async () => {
  const { assembleBundle, BUNDLE_STATUS } = await bundleApi();
  const bundle = assembleBundle(baseBundleInput({ gates: [] }));
  assert.equal(bundle.status, BUNDLE_STATUS.UNKNOWN);
  assert.ok(bundle.unknowns.some((item) => item.code === 'GATE_INCOMPLETE' && item.reason === 'NO_GATES'));
  assert.equal(bundle.gates.summary.status, 'UNKNOWN');
});

test('bundle: malformed inputs degrade to explicit unknowns and empty projections, never to a crash', async () => {
  const { assembleBundle, BUNDLE_STATUS } = await bundleApi();
  const bundle = assembleBundle(baseBundleInput({
    gates: [{ kind: 'unit' }, verifiedGate()],
    webEvidence: { command: 'npm run verify:web', rc: 1 },
    metrics: {},
    cache: null,
    spans: null,
    findings: [{ id: 'R-4', status: 'open' }],
  }));
  assert.equal(bundle.status, BUNDLE_STATUS.BLOCKED);
  const gateUnknown = bundle.unknowns.find((item) => item.code === 'GATE_INCOMPLETE' && Array.isArray(item.fields));
  assert.equal(gateUnknown.fields.length, 4);
  assert.ok(bundle.unknowns.some((item) => item.code === 'GATE_FAILED' && item.gate === 'verify:web' && item.rc === 1));
  assert.ok(bundle.unknowns.some((item) => item.code === 'COST_UNKNOWN' && !item.costStatus));
  assert.ok(bundle.unknowns.some((item) => item.code === 'FINDING_OPEN' && item.id === 'R-4' && item.severityLevel === null && item.severity === 'PROVISIONAL'));
  assert.deepEqual(bundle.cache, { stale: [], unverifiable: [], verified: [] });
  assert.deepEqual(bundle.spans, []);
  assert.equal(bundle.gates.summary.unknown, 1);
  assert.equal(bundle.gates.summary.total, 2);
});
