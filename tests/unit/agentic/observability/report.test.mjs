import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadModule } from './_harness.mjs';

const matrixApi = () => loadModule('matrix.mjs');
const reportApi = () => loadModule('report.mjs');

const FROZEN = 'b9d9bdfa0511905a95b729753b82e5734adab6bb';

const gate = (overrides = {}) => ({
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

const stream = (overrides = {}) => ({
  stream: 'W10',
  head: '60fdc73',
  contractCommit: FROZEN,
  contractRelation: 'matches',
  gates: [
    gate({ kind: 'unit', name: 'test:unit', command: 'npm run test:unit', passed: 968, failed: 0, skipped: 2 }),
    gate(),
  ],
  web: { command: 'npm run verify:web', rc: 0, passed: 227, failed: 0 },
  push: { pushed: true, rc: 0, ref: 'feat/s2d-w10-observability' },
  reviewActors: [{ role: 'reviewer', model: 'glm-5.3', modelSource: 'gateway' }],
  fixActors: [],
  risks: [],
  ...overrides,
});

async function buildMatrix(streams) {
  const { createMatrix } = await matrixApi();
  return createMatrix({
    ownerId: 'owner-a',
    frozen: { version: 'v1', commit: FROZEN },
    generatedAt: '2026-10-27T12:00:00.000Z',
    streams,
  });
}

test('report: renders a Markdown table with one row per stream', async () => {
  const { renderMatrixMarkdown } = await reportApi();
  const matrix = await buildMatrix([stream(), stream({ stream: 'W11', head: '4a51457' })]);
  const markdown = renderMatrixMarkdown(matrix);
  assert.match(markdown, /^\| 流 \| HEAD \| 契约 \| push \| 门禁 \| 评审模型 \| 未修风险 \| 状态 \|/m);
  assert.match(markdown, /\| W10 \| 60fdc73 \|/);
  assert.match(markdown, /\| W11 \| 4a51457 \|/);
  assert.match(markdown, /VERIFIED/);
});

test('report: the frozen baseline and generation time are stated at the top', async () => {
  const { renderMatrixMarkdown } = await reportApi();
  const markdown = renderMatrixMarkdown(await buildMatrix([stream()]));
  assert.ok(markdown.includes(FROZEN));
  assert.ok(markdown.includes('2026-10-27T12:00:00.000Z'));
  assert.match(markdown, /^# /m);
});

test('report: gate results render command, rc and pass/fail/skip numbers', async () => {
  const { renderMatrixMarkdown } = await reportApi();
  const markdown = renderMatrixMarkdown(await buildMatrix([stream()]));
  assert.ok(markdown.includes('npm run test:unit'));
  assert.ok(markdown.includes('rc=0'));
  assert.ok(markdown.includes('968'));
  assert.ok(markdown.includes('227'));
});

test('report: an UNKNOWN stream appears in an explicit UNKNOWN section, never silently dropped', async () => {
  const { renderMatrixMarkdown } = await reportApi();
  const matrix = await buildMatrix([
    stream({ stream: 'W8', reviewActors: [{ role: 'reviewer' }], head: '9a6dffd' }),
  ]);
  const markdown = renderMatrixMarkdown(matrix);
  assert.match(markdown, /## UNKNOWN/);
  const unknownSection = markdown.split('## UNKNOWN')[1] ?? '';
  assert.ok(unknownSection.includes('W8'));
  assert.ok(unknownSection.includes('REVIEW_MODEL_UNRESOLVED'));
});

test('report: a resolved_model NULL review actor is rendered literally as NULL, not blank', async () => {
  const { renderMatrixMarkdown } = await reportApi();
  const matrix = await buildMatrix([stream({ stream: 'W8', reviewActors: [{ role: 'reviewer' }] })]);
  const markdown = renderMatrixMarkdown(matrix);
  assert.ok(markdown.includes('resolved_model=NULL'));
});

test('report: an empty unknown list still renders the section with an explicit none', async () => {
  const { renderMatrixMarkdown } = await reportApi();
  const markdown = renderMatrixMarkdown(await buildMatrix([stream()]));
  assert.match(markdown, /## UNKNOWN/);
  assert.match(markdown, /无|none/i);
});

test('report: BLOCKED streams render their blocking reasons', async () => {
  const { renderMatrixMarkdown } = await reportApi();
  const matrix = await buildMatrix([
    stream({ stream: 'W11', gates: [gate({ kind: 'unit', name: 'test:unit', rc: 1, failed: 3, evidence: [] }), gate()] }),
  ]);
  const markdown = renderMatrixMarkdown(matrix);
  assert.match(markdown, /## BLOCKED/);
  assert.ok((markdown.split('## BLOCKED')[1] ?? '').includes('W11'));
  assert.ok(markdown.includes('GATE_FAILED'));
});

test('report: unavailable data is marked UNKNOWN instead of being rendered as 0', async () => {
  const { renderMatrixMarkdown } = await reportApi();
  const matrix = await buildMatrix([
    stream({ risks: [{ id: 'R1', severity: 'LOW', status: 'open' }] }),
  ]);
  const markdown = renderMatrixMarkdown(matrix);
  assert.ok(markdown.includes('UNKNOWN'));
  assert.equal(/\|\s*0\s*\|/.test(markdown.split('## UNKNOWN')[1] ?? ''), false);
});

test('report: writeMatrixReport writes the markdown to the caller path and returns it', async () => {
  const { writeMatrixReport } = await reportApi();
  const dir = mkdtempSync(join(tmpdir(), 'donego-obs-report-'));
  const target = join(dir, 's2d-w10-report.md');
  const matrix = await buildMatrix([stream()]);
  const result = writeMatrixReport({ matrix, path: target });
  assert.equal(result.path, target);
  assert.ok(existsSync(target));
  assert.equal(readFileSync(target, 'utf8'), result.markdown);
  assert.ok(readFileSync(target, 'utf8').includes('W10'));
});

test('report: writeMatrixReport creates missing directories', async () => {
  const { writeMatrixReport } = await reportApi();
  const dir = mkdtempSync(join(tmpdir(), 'donego-obs-report-'));
  const target = join(dir, 'nested', 'deep', 'report.md');
  const result = writeMatrixReport({ matrix: await buildMatrix([stream()]), path: target });
  assert.ok(existsSync(result.path));
});

test('report: writeMatrixReport refuses to overwrite an unrelated file without an explicit flag', async () => {
  const { writeMatrixReport } = await reportApi();
  const dir = mkdtempSync(join(tmpdir(), 'donego-obs-report-'));
  const target = join(dir, 'existing.md');
  writeFileSync(target, 'hand written');
  const matrix = await buildMatrix([stream()]);
  assert.throws(
    () => writeMatrixReport({ matrix, path: target }),
    (error) => error.code === 'REPORT_EXISTS',
  );
  assert.equal(readFileSync(target, 'utf8'), 'hand written');
  const overwritten = writeMatrixReport({ matrix, path: target, overwrite: true });
  assert.notEqual(readFileSync(overwritten.path, 'utf8'), 'hand written');
});

test('report: a matrix with no rows renders UNKNOWN overall, never a pass', async () => {
  const { renderMatrixMarkdown } = await reportApi();
  const markdown = renderMatrixMarkdown(await buildMatrix([]));
  assert.ok(markdown.includes('UNKNOWN'));
  assert.equal(markdown.includes('| VERIFIED |'), false);
});

test('report: the rendered report is deterministic for the same matrix', async () => {
  const { renderMatrixMarkdown } = await reportApi();
  const matrix = await buildMatrix([stream(), stream({ stream: 'W11', head: '4a51457' })]);
  assert.equal(renderMatrixMarkdown(matrix), renderMatrixMarkdown(matrix));
});

test('report: risks and push status are visible per stream so claims can be re-checked', async () => {
  const { renderMatrixMarkdown } = await reportApi();
  const matrix = await buildMatrix([
    stream({ risks: [{ id: 'R9', severity: 'MEDIUM', status: 'open' }], push: { pushed: false, rc: 1, ref: 'feat/x' } }),
  ]);
  const markdown = renderMatrixMarkdown(matrix);
  assert.ok(markdown.includes('feat/x'));
  assert.ok(markdown.includes('R9'));
});
