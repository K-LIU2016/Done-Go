import test from 'node:test';
import assert from 'node:assert/strict';
import { loadModule } from './_harness.mjs';

const dbApi = () => import('../../../../scripts/agentic/db/index.mjs');
const gatesApi = () => loadModule('gates.mjs');
const storeApi = () => loadModule('store.mjs');

async function freshGates() {
  const { openAgenticDb } = await dbApi();
  const { applyObservabilityMigrations, createObservabilityStore } = await storeApi();
  const { createGateRecorder } = await gatesApi();
  const db = openAgenticDb(':memory:');
  applyObservabilityMigrations(db);
  const store = createObservabilityStore({ db });
  return { db, store, gates: createGateRecorder({ store }) };
}

const baseGate = {
  stream: 'W10',
  name: 'test:unit',
  head: '60fdc73',
  command: 'npm run test:unit',
  rc: 1,
  passed: 961,
  failed: 7,
  skipped: 2,
  ownerId: 'owner-a',
};

test('gates: recordGate stores a complete gate with counters and head', async () => {
  const { gates, store } = await freshGates();
  const result = gates.record(baseGate);
  assert.equal(result.recorded, true);
  const [row] = store.listGates('owner-a', { stream: 'W10' });
  assert.equal(row.name, 'test:unit');
  assert.equal(row.rc, 1);
  assert.equal(row.passed, 961);
  assert.equal(row.failed, 7);
  assert.equal(row.skipped, 2);
  assert.equal(row.head, '60fdc73');
  assert.equal(row.command, 'npm run test:unit');
});

test('gates: a gate with no command is rejected as GATE_INCOMPLETE (N5)', async () => {
  const { gates } = await freshGates();
  assert.throws(() => gates.record({ ...baseGate, command: undefined }), (error) => error.code === 'GATE_INCOMPLETE');
  assert.throws(() => gates.record({ ...baseGate, command: '' }), (error) => error.code === 'GATE_INCOMPLETE');
  assert.throws(() => gates.record({ ...baseGate, command: '   ' }), (error) => error.code === 'GATE_INCOMPLETE');
});

test('gates: a gate with no rc is rejected, because a run without rc proves nothing (N5)', async () => {
  const { gates } = await freshGates();
  assert.throws(() => gates.record({ ...baseGate, rc: undefined }), (error) => error.code === 'GATE_INCOMPLETE');
  assert.throws(() => gates.record({ ...baseGate, rc: null }), (error) => error.code === 'GATE_INCOMPLETE');
  assert.throws(() => gates.record({ ...baseGate, rc: '1' }), (error) => error.code === 'GATE_INCOMPLETE');
});

test('gates: a gate with no head cannot be attributed to a commit', async () => {
  const { gates } = await freshGates();
  assert.throws(() => gates.record({ ...baseGate, head: undefined }), (error) => error.code === 'GATE_INCOMPLETE');
  assert.throws(() => gates.record({ ...baseGate, head: '' }), (error) => error.code === 'GATE_INCOMPLETE');
});

test('gates: a gate with no stream or name is rejected', async () => {
  const { gates } = await freshGates();
  assert.throws(() => gates.record({ ...baseGate, stream: undefined }), (error) => error.code === 'GATE_INCOMPLETE');
  assert.throws(() => gates.record({ ...baseGate, name: undefined }), (error) => error.code === 'GATE_INCOMPLETE');
});

test('gates: duplicate (stream,name,head) updates in place rather than adding a row (N4)', async () => {
  const { gates, store } = await freshGates();
  gates.record(baseGate);
  const second = gates.record({ ...baseGate, rc: 0, failed: 0, passed: 968 });
  assert.equal(second.recorded, true);
  assert.equal(second.duplicate, true);
  assert.equal(store.countGates('owner-a'), 1);
  assert.equal(store.listGates('owner-a', { stream: 'W10' })[0].rc, 0);
});

test('gates: the same gate name on a different head is a different gate', async () => {
  const { gates, store } = await freshGates();
  gates.record(baseGate);
  gates.record({ ...baseGate, head: 'ffffff0', rc: 0, failed: 0 });
  assert.equal(store.countGates('owner-a'), 2);
});

test('gates: a passing gate without evidence is recorded but not verifiable', async () => {
  const { gates } = await freshGates();
  const result = gates.record({ ...baseGate, rc: 0, failed: 0 });
  assert.equal(result.evidenceStatus, 'UNKNOWN');
  assert.equal(result.verifiable, false);
});

test('gates: evidence with verified=true makes a passing gate verifiable', async () => {
  const { gates } = await freshGates();
  const result = gates.record({
    ...baseGate,
    rc: 0,
    failed: 0,
    evidence: [{ type: 'test-run', title: 'npm run test:unit', verified: true, uri: 'evidence/s2d-w10-tests.md' }],
  });
  assert.equal(result.evidenceStatus, 'VERIFIED');
  assert.equal(result.verifiable, true);
});

test('gates: evidence with verified!==true does not count as passing evidence', async () => {
  const { gates } = await freshGates();
  const result = gates.record({
    ...baseGate,
    rc: 0,
    failed: 0,
    evidence: [{ type: 'test-run', title: 'npm run test:unit' }],
  });
  assert.notEqual(result.evidenceStatus, 'VERIFIED');
  assert.equal(result.verifiable, false);
});

test('gates: mock-sourced evidence can never reach VERIFIED (BRIEF §3)', async () => {
  const { gates } = await freshGates();
  const result = gates.record({
    ...baseGate,
    rc: 0,
    failed: 0,
    evidence: [{ type: 'test-run', title: 'mocked run', verified: true, source: 'mock' }],
  });
  assert.equal(result.evidenceStatus, 'PROVISIONAL');
  assert.equal(result.verifiable, false);
});

test('gates: a failing rc can never be reported as passing', async () => {
  const { gates } = await freshGates();
  const result = gates.record({ ...baseGate, rc: 1, failed: 7, evidence: [{ type: 'test-run', title: 'x', verified: true }] });
  assert.equal(result.passed, false);
  assert.equal(result.verifiable, false);
  assert.notEqual(result.evidenceStatus, 'VERIFIED');
});

test('gates: coverage is stored as JSON and reported as a number', async () => {
  const { gates, store } = await freshGates();
  const result = gates.record({
    ...baseGate,
    rc: 0,
    failed: 0,
    coverage: { line: 91.5, branch: 84.2, function: 93 },
    evidence: [{ type: 'test-run', title: 'coverage', verified: true }],
  });
  assert.equal(result.coverage.line, 91.5);
  const [row] = store.listGates('owner-a', { stream: 'W10' });
  assert.deepEqual(JSON.parse(row.coverage_json), { line: 91.5, branch: 84.2, function: 93 });
});

test('gates: coverage below the 80% line floor blocks a VERIFIED status', async () => {
  const { gates } = await freshGates();
  const result = gates.record({
    ...baseGate,
    rc: 0,
    failed: 0,
    coverage: { line: 71.4, branch: 60 },
    evidence: [{ type: 'test-run', title: 'x', verified: true }],
  });
  assert.equal(result.coverageOk, false);
  assert.notEqual(result.evidenceStatus, 'VERIFIED');
});

test('gates: contractCommit is recorded so drift from the frozen baseline is visible', async () => {
  const { gates, store } = await freshGates();
  gates.record({ ...baseGate, contractCommit: 'b9d9bdfa0511905a95b729753b82e5734adab6bb' });
  const [row] = store.listGates('owner-a', { stream: 'W10' });
  assert.equal(row.contract_commit, 'b9d9bdfa0511905a95b729753b82e5734adab6bb');
});

test('gates: gates are owner scoped (N12)', async () => {
  const { gates, store } = await freshGates();
  gates.record(baseGate);
  gates.record({ ...baseGate, ownerId: 'owner-b' });
  assert.equal(store.countGates('owner-a'), 1);
  assert.equal(store.countGates('owner-b'), 1);
});

test('gates: listGates can filter by head', async () => {
  const { gates, store } = await freshGates();
  gates.record({ ...baseGate, head: 'aaa1111' });
  gates.record({ ...baseGate, head: 'bbb2222' });
  assert.deepEqual(store.listGates('owner-a', { head: 'bbb2222' }).map((row) => row.head), ['bbb2222']);
});

test('gates: summarizeGates separates pass, fail, unverifiable and mock evidence', async () => {
  const { gates } = await freshGates();
  gates.record({ ...baseGate, name: 'a', rc: 0, failed: 0, evidence: [{ type: 'test-run', title: 'a', verified: true }] });
  gates.record({ ...baseGate, name: 'b', rc: 1, failed: 3 });
  gates.record({ ...baseGate, name: 'c', rc: 0, failed: 0 });
  gates.record({ ...baseGate, name: 'd', rc: 0, failed: 0, evidence: [{ type: 'test-run', title: 'd', verified: true, source: 'mock' }] });
  const summary = gates.summarize('owner-a', '60fdc73');
  assert.equal(summary.total, 4);
  assert.equal(summary.failed, 1);
  assert.equal(summary.verified, 1);
  assert.equal(summary.provisional, 1);
  assert.equal(summary.unknown, 1);
  assert.equal(summary.status, 'BLOCKED');
});

test('gates: summarizeGates with all verified gates reports VERIFIED', async () => {
  const { gates } = await freshGates();
  gates.record({ ...baseGate, name: 'a', rc: 0, failed: 0, evidence: [{ type: 'test-run', title: 'a', verified: true }] });
  gates.record({ ...baseGate, name: 'b', rc: 0, failed: 0, evidence: [{ type: 'test-run', title: 'b', verified: true }] });
  assert.equal(gates.summarize('owner-a', '60fdc73').status, 'VERIFIED');
});

test('gates: summarizeGates with no gates at all is UNKNOWN, never VERIFIED', async () => {
  const { gates } = await freshGates();
  const summary = gates.summarize('owner-a', '60fdc73');
  assert.equal(summary.total, 0);
  assert.equal(summary.status, 'UNKNOWN');
});

test('gates: summarizeGates reports provisional when every gate passes but none is verified', async () => {
  const { gates } = await freshGates();
  gates.record({ ...baseGate, name: 'a', rc: 0, failed: 0 });
  assert.equal(gates.summarize('owner-a', '60fdc73').status, 'PROVISIONAL');
});
