import test from 'node:test';
import assert from 'node:assert/strict';
import { loadModule } from './_harness.mjs';

const matrixApi = () => loadModule('matrix.mjs');

const FROZEN = 'b9d9bdfa0511905a95b729753b82e5734adab6bb';

const unitGate = (overrides = {}) => ({
  kind: 'unit',
  name: 'test:unit',
  command: 'npm run test:unit',
  rc: 0,
  passed: 968,
  failed: 0,
  skipped: 2,
  evidence: [{ type: 'test-run', title: 'npm run test:unit', verified: true }],
  ...overrides,
});

const webGate = (overrides = {}) => ({
  kind: 'web',
  name: 'verify:web',
  command: 'npm run verify:web',
  rc: 0,
  passed: 227,
  failed: 0,
  skipped: 0,
  evidence: [{ type: 'test-run', title: 'npm run verify:web', verified: true }],
  ...overrides,
});

const reviewer = (overrides = {}) => ({ role: 'reviewer', model: 'glm-5.3', modelSource: 'gateway', ...overrides });

const baseStream = (overrides = {}) => ({
  stream: 'W10',
  head: '60fdc73',
  contractCommit: FROZEN,
  contractRelation: 'matches',
  gates: [unitGate(), webGate()],
  web: { command: 'npm run verify:web', rc: 0, passed: 227, failed: 0 },
  push: { pushed: true, rc: 0, ref: 'feat/s2d-w10-observability' },
  reviewActors: [reviewer(), reviewer({ role: 'verifier' })],
  fixActors: [],
  risks: [],
  ...overrides,
});

const baseMatrix = (overrides = {}) => ({
  ownerId: 'owner-a',
  frozen: { version: 'v1', commit: FROZEN },
  generatedAt: '2026-10-27T12:00:00.000Z',
  streams: [baseStream()],
  ...overrides,
});

test('matrix: a fully evidenced stream is VERIFIED and records every required column', async () => {
  const { createMatrix, MATRIX_STATUS } = await matrixApi();
  const matrix = createMatrix(baseMatrix());
  const row = matrix.rows[0];
  assert.equal(row.stream, 'W10');
  assert.equal(row.head, '60fdc73');
  assert.equal(row.contractCommit, FROZEN);
  assert.equal(row.status, MATRIX_STATUS.VERIFIED);
  assert.deepEqual(row.unknowns, []);
  assert.equal(matrix.summary.total, 1);
  assert.equal(matrix.summary.verified, 1);
  assert.equal(matrix.summary.status, MATRIX_STATUS.VERIFIED);
});

test('matrix: a stream proven only by unit tests is PROVISIONAL, never VERIFIED (N13)', async () => {
  const { createMatrix, MATRIX_STATUS } = await matrixApi();
  const matrix = createMatrix(baseMatrix({
    streams: [baseStream({ gates: [unitGate()], web: undefined })],
  }));
  const row = matrix.rows[0];
  assert.equal(row.status, MATRIX_STATUS.PROVISIONAL);
  assert.ok(row.unknowns.some((item) => item.code === 'SINGLE_TEST_ONLY'));
});

test('matrix: a review actor with resolved_model NULL forces UNKNOWN, never completion (red line 7)', async () => {
  const { createMatrix, MATRIX_STATUS } = await matrixApi();
  const matrix = createMatrix(baseMatrix({
    streams: [baseStream({ reviewActors: [{ role: 'reviewer' }] })],
  }));
  const row = matrix.rows[0];
  assert.equal(row.status, MATRIX_STATUS.UNKNOWN);
  assert.ok(row.unknowns.some((item) => item.code === 'REVIEW_MODEL_UNRESOLVED' && item.role === 'reviewer' && item.severity === 'UNKNOWN'));
  assert.equal(row.reviewModels[0].resolvedModel, null);
});

test('matrix: a fix actor with resolved_model NULL is reported too, not just reviewers', async () => {
  const { createMatrix, MATRIX_STATUS } = await matrixApi();
  const matrix = createMatrix(baseMatrix({
    streams: [baseStream({ fixActors: [{ role: 'fixer' }] })],
  }));
  const row = matrix.rows[0];
  assert.equal(row.status, MATRIX_STATUS.UNKNOWN);
  assert.ok(row.unknowns.some((item) => item.code === 'REVIEW_MODEL_UNRESOLVED' && item.role === 'fixer' && item.severity === 'UNKNOWN'));
});

test('matrix: a mock review actor is PROVISIONAL and reported by source', async () => {
  const { createMatrix, MATRIX_STATUS } = await matrixApi();
  const matrix = createMatrix(baseMatrix({
    streams: [baseStream({ reviewActors: [reviewer({ modelSource: 'mock' })] })],
  }));
  assert.equal(matrix.rows[0].status, MATRIX_STATUS.PROVISIONAL);
  assert.ok(matrix.rows[0].unknowns.some((item) => item.code === 'REVIEW_NOT_VERIFIABLE'));
});

test('matrix: a failing gate makes the stream BLOCKED (never a pass)', async () => {
  const { createMatrix, MATRIX_STATUS } = await matrixApi();
  const matrix = createMatrix(baseMatrix({
    streams: [baseStream({ gates: [unitGate({ rc: 1, failed: 7, evidence: [] }), webGate()] })],
  }));
  assert.equal(matrix.rows[0].status, MATRIX_STATUS.BLOCKED);
  assert.ok(matrix.rows[0].unknowns.some((item) => item.code === 'GATE_FAILED'));
});

test('matrix: a gate without rc is UNKNOWN because nothing was proven (N5)', async () => {
  const { createMatrix, MATRIX_STATUS } = await matrixApi();
  const matrix = createMatrix(baseMatrix({
    streams: [baseStream({ gates: [unitGate({ rc: undefined }), webGate()] })],
  }));
  assert.equal(matrix.rows[0].status, MATRIX_STATUS.UNKNOWN);
  assert.ok(matrix.rows[0].unknowns.some((item) => item.code === 'GATE_INCOMPLETE'));
});

test('matrix: missing web evidence keeps a stream at UNKNOWN', async () => {
  const { createMatrix, MATRIX_STATUS } = await matrixApi();
  const matrix = createMatrix(baseMatrix({
    streams: [baseStream({
      gates: [unitGate()],
      web: { command: 'npm run verify:web' },
    })],
  }));
  assert.equal(matrix.rows[0].status, MATRIX_STATUS.UNKNOWN);
  assert.ok(matrix.rows[0].unknowns.some((item) => item.code === 'E2E_EVIDENCE_MISSING'));
});

test('matrix: contract drift from the frozen baseline BLOCKS the stream and names both commits', async () => {
  const { createMatrix, MATRIX_STATUS } = await matrixApi();
  const drifted = 'c'.repeat(40);
  const matrix = createMatrix(baseMatrix({
    streams: [baseStream({ contractCommit: drifted, contractRelation: 'drift' })],
  }));
  const row = matrix.rows[0];
  assert.equal(row.status, MATRIX_STATUS.BLOCKED);
  const drift = row.unknowns.find((item) => item.code === 'CONTRACT_DRIFT');
  assert.ok(drift);
  assert.equal(drift.expected, FROZEN);
  assert.equal(drift.actual, drifted);
});

test('matrix: a missing contractCommit is UNKNOWN rather than assumed frozen', async () => {
  const { createMatrix, MATRIX_STATUS } = await matrixApi();
  const matrix = createMatrix(baseMatrix({
    streams: [baseStream({ contractCommit: undefined })],
  }));
  assert.equal(matrix.rows[0].status, MATRIX_STATUS.UNKNOWN);
  assert.ok(matrix.rows[0].unknowns.some((item) => item.code === 'CONTRACT_UNKNOWN'));
});

test('matrix: a stream that was never pushed is reported as UNKNOWN, not as success', async () => {
  const { createMatrix, MATRIX_STATUS } = await matrixApi();
  const matrix = createMatrix(baseMatrix({
    streams: [baseStream({ push: { pushed: false, rc: 1, ref: 'feat/s2d-w10-observability' } })],
  }));
  assert.equal(matrix.rows[0].status, MATRIX_STATUS.UNKNOWN);
  assert.ok(matrix.rows[0].unknowns.some((item) => item.code === 'PUSH_UNCONFIRMED'));
});

test('matrix: BLOCKED outranks everything in the overall summary', async () => {
  const { createMatrix, MATRIX_STATUS } = await matrixApi();
  const matrix = createMatrix(baseMatrix({
    streams: [
      baseStream({ stream: 'W10' }),
      baseStream({ stream: 'W11', gates: [unitGate({ rc: 1, evidence: [] }), webGate()] }),
    ],
  }));
  assert.deepEqual(matrix.rows.map((row) => row.stream), ['W10', 'W11']);
  assert.equal(matrix.summary.blocked, 1);
  assert.equal(matrix.summary.verified, 1);
  assert.equal(matrix.summary.status, MATRIX_STATUS.BLOCKED);
});

test('matrix: a stream with no rows at all yields UNKNOWN overall, never VERIFIED', async () => {
  const { createMatrix, MATRIX_STATUS } = await matrixApi();
  const matrix = createMatrix(baseMatrix({ streams: [] }));
  assert.equal(matrix.summary.total, 0);
  assert.equal(matrix.summary.status, MATRIX_STATUS.UNKNOWN);
});

test('matrix: structurally incomplete input is refused with MATRIX_INCOMPLETE', async () => {
  const { createMatrix } = await matrixApi();
  assert.throws(() => createMatrix(baseMatrix({ streams: [baseStream({ stream: '' })] })), (error) => error.code === 'MATRIX_INCOMPLETE');
  assert.throws(() => createMatrix(baseMatrix({ streams: [baseStream({ head: undefined })] })), (error) => error.code === 'MATRIX_INCOMPLETE');
  assert.throws(() => createMatrix(baseMatrix({ streams: [baseStream({ gates: undefined })] })), (error) => error.code === 'MATRIX_INCOMPLETE');
  assert.throws(() => createMatrix(baseMatrix({ streams: undefined })), (error) => error.code === 'MATRIX_INCOMPLETE');
  assert.throws(() => createMatrix(baseMatrix({ frozen: undefined })), (error) => error.code === 'MATRIX_INCOMPLETE');
  assert.throws(() => createMatrix(baseMatrix({ ownerId: undefined })), (error) => error.code === 'OWNER_REQUIRED');
});

test('matrix: duplicate stream names are refused instead of silently overwritten', async () => {
  const { createMatrix } = await matrixApi();
  assert.throws(
    () => createMatrix(baseMatrix({ streams: [baseStream(), baseStream()] })),
    (error) => error.code === 'MATRIX_INCOMPLETE',
  );
});

test('matrix: a review actor roster is preserved with role, model and source for audit', async () => {
  const { createMatrix } = await matrixApi();
  const matrix = createMatrix(baseMatrix({
    streams: [baseStream({
      reviewActors: [
        reviewer({ role: 'reviewer', model: 'glm-5.3' }),
        reviewer({ role: 'verifier', model: 'gpt-6.1-sol' }),
      ],
    })],
  }));
  const [first, second] = matrix.rows[0].reviewModels;
  assert.deepEqual({ role: first.role, model: first.model, source: first.modelSource }, { role: 'reviewer', model: 'glm-5.3', source: 'gateway' });
  assert.equal(second.model, 'gpt-6.1-sol');
});

test('matrix: risks are carried through and any unresolvable risk is UNKNOWN', async () => {
  const { createMatrix, MATRIX_STATUS } = await matrixApi();
  const matrix = createMatrix(baseMatrix({
    streams: [baseStream({ risks: [{ id: 'R1', severity: 'MEDIUM', status: 'open' }] })],
  }));
  const row = matrix.rows[0];
  assert.equal(row.risks.length, 1);
  assert.equal(row.risks[0].severity, 'MEDIUM');
  assert.equal(row.status, MATRIX_STATUS.PROVISIONAL);
  assert.ok(row.unknowns.some((item) => item.code === 'RISK_OPEN' && item.id === 'R1'));
});

test('matrix: a HIGH open risk BLOCKS the stream', async () => {
  const { createMatrix, MATRIX_STATUS } = await matrixApi();
  const matrix = createMatrix(baseMatrix({
    streams: [baseStream({ risks: [{ id: 'R2', severity: 'HIGH', status: 'open' }] })],
  }));
  assert.equal(matrix.rows[0].status, MATRIX_STATUS.BLOCKED);
});

test('matrix: a resolved risk does not degrade the stream', async () => {
  const { createMatrix, MATRIX_STATUS } = await matrixApi();
  const matrix = createMatrix(baseMatrix({
    streams: [baseStream({ risks: [{ id: 'R3', severity: 'HIGH', status: 'fixed' }] })],
  }));
  assert.equal(matrix.rows[0].status, MATRIX_STATUS.VERIFIED);
});

test('matrix: the matrix is JSON serialisable and carries the frozen baseline', async () => {
  const { createMatrix } = await matrixApi();
  const matrix = createMatrix(baseMatrix());
  assert.doesNotThrow(() => JSON.stringify(matrix));
  assert.deepEqual(matrix.frozen, { version: 'v1', commit: FROZEN });
  assert.equal(matrix.generatedAt, '2026-10-27T12:00:00.000Z');
  assert.equal(matrix.ownerId, 'owner-a');
});
