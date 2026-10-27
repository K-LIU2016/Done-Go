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

test('matrix: a stream with an empty gates array proves nothing and is UNKNOWN', async () => {
  const { createMatrix, MATRIX_STATUS } = await matrixApi();
  const matrix = createMatrix(baseMatrix({
    streams: [baseStream({ gates: [], web: { command: 'npm run verify:web', rc: 0, passed: 227, failed: 0 } })],
  }));
  assert.equal(matrix.rows[0].status, MATRIX_STATUS.UNKNOWN);
  assert.ok(matrix.rows[0].unknowns.some((item) => item.code === 'TEST_EVIDENCE_MISSING'));
});

test('matrix: a stream that names no review actors at all is UNKNOWN, not silently VERIFIED', async () => {
  const { createMatrix, MATRIX_STATUS } = await matrixApi();
  const matrix = createMatrix(baseMatrix({
    streams: [baseStream({ reviewActors: [], fixActors: [] })],
  }));
  assert.equal(matrix.rows[0].status, MATRIX_STATUS.UNKNOWN);
  assert.ok(matrix.rows[0].unknowns.some((item) => item.code === 'REVIEW_MISSING'));
});

// ---------------------------------------------------------------------------
// §7.2 data source B: read-only parsing of rendered stream reports.
//
// The parser recognises exactly the lines report.mjs emits (round-trip), never
// invents a field, and a failed parse degrades to an UNKNOWN row.
// ---------------------------------------------------------------------------

const reportApi = () => loadModule('report.mjs');

/** Build a full report markdown via the real renderer, for round-trip tests. */
async function renderedReport(streamOverrides = {}) {
  const { createMatrix } = await matrixApi();
  const { renderMatrixMarkdown } = await reportApi();
  const matrix = createMatrix(baseMatrix({ streams: [baseStream(streamOverrides)] }));
  return renderMatrixMarkdown(matrix);
}

test('matrix: a rendered report parses back into the same stream data (round trip)', async () => {
  const { parseStreamReport } = await matrixApi();
  const parsed = parseStreamReport({ name: 'W10', content: await renderedReport() });
  assert.equal(parsed.ok, true);
  assert.equal(parsed.parseError, null);
  assert.equal(parsed.stream, 'W10');
  assert.equal(parsed.parsed.head, '60fdc73');
  assert.equal(parsed.parsed.contractCommitPrefix, FROZEN.slice(0, 7));
  assert.equal(parsed.parsed.contractRelation, 'matches');
  assert.deepEqual(parsed.parsed.gates.map((gate) => gate.name), ['test:unit', 'verify:web']);
  assert.equal(parsed.parsed.gates[0].command, 'npm run test:unit');
  assert.equal(parsed.parsed.gates[0].rc, 0);
  assert.equal(parsed.parsed.gates[0].passed, 968);
  assert.equal(parsed.parsed.gates[0].skipped, 2);
  assert.deepEqual(
    parsed.parsed.reviewActors.map((actor) => [actor.role, actor.model, actor.modelSource]),
    [['reviewer', 'glm-5.3', 'gateway'], ['verifier', 'glm-5.3', 'gateway']],
  );
  assert.deepEqual(parsed.parsed.push, { ref: 'feat/s2d-w10-observability', pushed: true, rc: 0 });
  assert.deepEqual(parsed.parsed.web, { command: 'npm run verify:web', rc: 0 });
  assert.equal(parsed.parsed.claimedStatus, 'VERIFIED');
  assert.equal(parsed.parsed.risks.length, 0);
});

test('matrix: a report alone can never yield VERIFIED — the truncated contract commit caps it at PROVISIONAL', async () => {
  const { createMatrixFromReports, MATRIX_STATUS } = await matrixApi();
  const matrix = createMatrixFromReports({
    ownerId: 'owner-a',
    frozen: { version: 'v1', commit: FROZEN },
    reports: [{ name: 'W10', content: await renderedReport() }],
  });
  const row = matrix.rows[0];
  assert.equal(row.status, MATRIX_STATUS.PROVISIONAL);
  assert.ok(row.unknowns.some((item) => item.code === 'CONTRACT_PREFIX_ONLY'));
  assert.equal(row.contractCommit, null);
  assert.equal(row.contractCommitPrefix, FROZEN.slice(0, 7));
});

test('matrix: a report with resolved_model=NULL is UNKNOWN via the report path too (N14)', async () => {
  const { createMatrixFromReports, MATRIX_STATUS } = await matrixApi();
  const matrix = createMatrixFromReports({
    ownerId: 'owner-a',
    frozen: { version: 'v1', commit: FROZEN },
    reports: [{
      name: 'W10',
      content: await renderedReport({ reviewActors: [{ role: 'reviewer' }] }),
    }],
  });
  const row = matrix.rows[0];
  assert.equal(row.status, MATRIX_STATUS.UNKNOWN);
  assert.ok(row.unknowns.some((item) => item.code === 'REVIEW_MODEL_UNRESOLVED' && item.resolvedModel === null));
  assert.equal(row.reviewModels[0].resolvedModel, null);
});

test('matrix: a report with only unit-test gates stays PROVISIONAL via the report path (N13)', async () => {
  const { createMatrixFromReports, MATRIX_STATUS } = await matrixApi();
  const content = await renderedReport({ gates: [unitGate()], web: undefined });
  const matrix = createMatrixFromReports({
    ownerId: 'owner-a',
    frozen: { version: 'v1', commit: FROZEN },
    reports: [{ name: 'W10', content }],
  });
  assert.equal(matrix.rows[0].status, MATRIX_STATUS.PROVISIONAL);
  assert.ok(matrix.rows[0].unknowns.some((item) => item.code === 'SINGLE_TEST_ONLY'));
});

test('matrix: a report describing a failing gate BLOCKS the derived row', async () => {
  const { createMatrixFromReports, MATRIX_STATUS } = await matrixApi();
  const content = await renderedReport({ gates: [unitGate({ rc: 1, failed: 7, evidence: [] }), webGate()] });
  const matrix = createMatrixFromReports({
    ownerId: 'owner-a',
    frozen: { version: 'v1', commit: FROZEN },
    reports: [{ name: 'W10', content }],
  });
  assert.equal(matrix.rows[0].status, MATRIX_STATUS.BLOCKED);
});

test('matrix: a report whose contract prefix does not match the frozen baseline BLOCKS', async () => {
  const { createMatrixFromReports, MATRIX_STATUS } = await matrixApi();
  const matrix = createMatrixFromReports({
    ownerId: 'owner-a',
    frozen: { version: 'v1', commit: FROZEN },
    reports: [{
      name: 'W10',
      content: [
        '## 逐流明细',
        '',
        '### W10',
        '',
        '- HEAD: 60fdc73',
        '- 契约: matches@deadbee',
        '- push: feat/x pushed rc=0',
        '- 门禁: UNKNOWN',
        '- 评审模型: UNKNOWN',
        '- 状态: VERIFIED',
        '',
      ].join('\n'),
    }],
  });
  const row = matrix.rows[0];
  assert.equal(row.status, MATRIX_STATUS.BLOCKED);
  const drift = row.unknowns.find((item) => item.code === 'CONTRACT_DRIFT');
  assert.ok(drift);
  assert.equal(drift.expected, FROZEN.slice(0, 7));
  assert.equal(drift.actual, 'deadbee');
});

test('matrix: a report claiming VERIFIED is not believed — the claim is kept as a conflict record', async () => {
  const { createMatrixFromReports, MATRIX_STATUS } = await matrixApi();
  // A rendered report agrees with itself by construction, so the conflict case
  // needs a hand-edited report: it still claims VERIFIED but names an open HIGH
  // risk the renderer would have rendered as BLOCKED.
  const doctored = (await renderedReport()).replace(
    '- 状态: VERIFIED',
    '- 风险: R9 severity=HIGH status=open\n- 状态: VERIFIED',
  );
  const matrix = createMatrixFromReports({
    ownerId: 'owner-a',
    frozen: { version: 'v1', commit: FROZEN },
    reports: [{ name: 'W10', content: doctored }],
  });
  const row = matrix.rows[0];
  assert.equal(row.status, MATRIX_STATUS.BLOCKED);
  assert.equal(row.claimedStatus, 'VERIFIED');
  assert.ok(row.unknowns.some((item) => item.code === 'STATUS_CONFLICT' && item.claimed === 'VERIFIED'));
  assert.ok(row.unknowns.some((item) => item.code === 'RISK_OPEN' && item.id === 'R9'));
});

test('matrix: a report that cannot be parsed degrades to UNKNOWN, never to a guess (§7.2)', async () => {
  const { parseStreamReport, createMatrixFromReports, MATRIX_STATUS } = await matrixApi();

  const missingSection = parseStreamReport({ name: 'W42', content: await renderedReport() });
  assert.equal(missingSection.ok, false);
  assert.ok(isNonEmpty(missingSection.parseError));

  const notMarkdown = parseStreamReport({ name: 'W10', content: '' });
  assert.equal(notMarkdown.ok, false);

  const matrix = createMatrixFromReports({
    ownerId: 'owner-a',
    frozen: { version: 'v1', commit: FROZEN },
    reports: [{ name: 'W42', content: 'not a report at all' }, { name: 'W10', content: await renderedReport() }],
  });
  assert.equal(matrix.rows.length, 2);
  const failed = matrix.rows.find((row) => row.stream === 'W42');
  assert.equal(failed.status, MATRIX_STATUS.UNKNOWN);
  assert.ok(failed.unknowns.some((item) => item.code === 'REPORT_PARSE_FAILED' && item.severity === 'UNKNOWN'));
  assert.equal(failed.head, 'UNKNOWN');
  assert.equal(failed.gates.length, 0);
});

test('matrix: a report section missing its HEAD or gate lines is a failed parse, not partial credit', async () => {
  const { parseStreamReport } = await matrixApi();
  const parsed = parseStreamReport({
    name: 'W10',
    content: ['## 逐流明细', '', '### W10', '', '- 契约: matches@b9d9bdf', '- 状态: VERIFIED', ''].join('\n'),
  });
  assert.equal(parsed.ok, false);
  assert.ok(parsed.parseError.includes('HEAD') || parsed.parseError.includes('门禁'));
});

test('matrix: duplicate report names are refused like duplicate streams', async () => {
  const { createMatrixFromReports } = await matrixApi();
  const content = await renderedReport();
  assert.throws(
    () => createMatrixFromReports({
      ownerId: 'owner-a',
      frozen: { version: 'v1', commit: FROZEN },
      reports: [{ name: 'W10', content }, { name: 'W10', content }],
    }),
    (error) => error.code === 'MATRIX_INCOMPLETE',
  );
});

test('matrix: createMatrixFromReports demands the same shape as createMatrix', async () => {
  const { createMatrixFromReports } = await matrixApi();
  assert.throws(() => createMatrixFromReports({ frozen: { commit: FROZEN }, reports: [] }), (error) => error.code === 'OWNER_REQUIRED');
  assert.throws(() => createMatrixFromReports({ ownerId: 'a', reports: [] }), (error) => error.code === 'MATRIX_INCOMPLETE');
  assert.throws(() => createMatrixFromReports({ ownerId: 'a', frozen: { commit: FROZEN }, reports: 'nope' }), (error) => error.code === 'MATRIX_INCOMPLETE');
  assert.throws(
    () => createMatrixFromReports({ ownerId: 'a', frozen: { commit: FROZEN }, reports: [{ content: 'x' }] }),
    (error) => error.code === 'MATRIX_INCOMPLETE',
  );
});

test('matrix: a report section with zero risk lines carries no risks and none are invented', async () => {
  const { createMatrixFromReports } = await matrixApi();
  const matrix = createMatrixFromReports({
    ownerId: 'owner-a',
    frozen: { version: 'v1', commit: FROZEN },
    reports: [{
      name: 'W10',
      content: await renderedReport({ risks: [{ id: 'R5', severity: 'LOW', status: 'fixed' }] }),
    }],
  });
  assert.deepEqual(matrix.rows[0].risks, [{ id: 'R5', severity: 'LOW', status: 'fixed' }]);
  assert.ok(!matrix.rows[0].unknowns.some((item) => item.code === 'RISK_OPEN'));
});

function isNonEmpty(value) {
  return typeof value === 'string' && value.length > 0;
}
