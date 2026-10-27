// W9 M2 verifier-domain · 防御路径补充单测（实现期补测，不改动 RED 规约文件）。
// 目标：把 db-gate/engine 的 fail-closed 防御分支纳入覆盖（逐模块
// line/branch/function ≥80% 门禁）。语义全部来自 plan G1-M2 钉死规则：
// 缺失/异常不得升级为 VERIFIED，门禁对任何未知输入 fail closed。
import test from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openAgenticDb, migrate } from '../../../../scripts/agentic/db/index.mjs';
import { saveVerdict } from '../../../../scripts/agentic/verifier/verdict.mjs';
import { dbVerdictGate } from '../../../../scripts/agentic/verifier/db-gate.mjs';
import { verify } from '../../../../scripts/agentic/verifier/engine.mjs';
import { checkDod } from '../../../../scripts/agentic/verifier/dod-checker.mjs';
import { checkCitations } from '../../../../scripts/agentic/verifier/citation-checker.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../../..');

function makeDb() {
  const db = openAgenticDb(':memory:');
  migrate(db, join(root, 'scripts/agentic/db/migrations'));
  return db;
}

const T0 = '2026-10-27T10:00:00Z';
const clock = () => ({ now: () => T0 });
const runCommandOk = async () => ({ rc: 0, stdout: '1..1\nok 1\n# pass 1\n', timedOut: false });

const ART = {
  id: 'art-1', ownerId: 'owner-a', missionId: 'm1', version: 1,
  type: 'report', status: 'ready', location: '/a.md', createdAt: T0,
  evidence: [],
};

const VERDICT = {
  artifactId: 'art-1', version: 1, overall: 'UNKNOWN',
  checks: [{ kind: 'dod-item', ref: 'r', status: 'UNKNOWN', severity: 'HIGH', reason: '' }],
  ranAt: T0,
};

test('dbVerdictGate rejects bad construction input', () => {
  const db = makeDb();
  assert.throws(() => dbVerdictGate(null, 'owner-a'), (e) => e.code === 'CONTRACT_INVALID');
  assert.throws(() => dbVerdictGate(db, ''), (e) => e.code === 'CONTRACT_INVALID');
  assert.throws(() => dbVerdictGate(db, 42), (e) => e.code === 'CONTRACT_INVALID');
});

test('dbVerdictGate fails closed on invalid lookup arguments', async () => {
  const db = makeDb();
  saveVerdict(db, 'owner-a', {
    ...VERDICT,
    overall: 'VERIFIED',
    checks: [{ kind: 'dod-item', ref: 'r', status: 'PASS', severity: 'LOW', reason: '' }],
  });
  const gate = dbVerdictGate(db, 'owner-a');
  for (const [artifactId, version] of [['', 1], [null, 1], ['art-1', 0], ['art-1', '1'], ['art-1', 1.5]]) {
    const summary = await gate(artifactId, version);
    assert.equal(summary.blocking, true, `${JSON.stringify(artifactId)}, ${version} must fail closed`);
  }
});

test('saveVerdict rejects bad db, owner, verdict shape and idGen', () => {
  const db = makeDb();
  assert.throws(() => saveVerdict(null, 'owner-a', VERDICT), (e) => e.code === 'CONTRACT_INVALID');
  assert.throws(() => saveVerdict(db, '', VERDICT), (e) => e.code === 'CONTRACT_INVALID');
  assert.throws(() => saveVerdict(db, 'owner-a', null), (e) => e.code === 'CONTRACT_INVALID');
  assert.throws(() => saveVerdict(db, 'owner-a', { ...VERDICT, checks: 'nope' }), (e) => e.code === 'CONTRACT_INVALID');
  assert.throws(() => saveVerdict(db, 'owner-a', VERDICT, { idGen: () => 42 }), (e) => e.code === 'CONTRACT_INVALID');
});

test('verify rejects malformed artifact, dod and clock inputs', async () => {
  await assert.rejects(async () => verify('x', [], { runCommand: runCommandOk, clock: clock() }), (e) => e.code === 'CONTRACT_INVALID');
  await assert.rejects(async () => verify({ ...ART, id: '' }, [], { runCommand: runCommandOk, clock: clock() }), (e) => e.code === 'CONTRACT_INVALID');
  await assert.rejects(async () => verify({ ...ART, version: 0 }, [], { runCommand: runCommandOk, clock: clock() }), (e) => e.code === 'CONTRACT_INVALID');
  await assert.rejects(async () => verify(ART, 'nope', { runCommand: runCommandOk, clock: clock() }), (e) => e.code === 'CONTRACT_INVALID');
  await assert.rejects(async () => verify(ART, [1], { runCommand: runCommandOk, clock: clock() }), (e) => e.code === 'CONTRACT_INVALID');
  await assert.rejects(async () => verify(ART, [], { runCommand: runCommandOk, clock: {} }), (e) => e.code === 'CONTRACT_INVALID');
  await assert.rejects(
    async () => verify(ART, [], { runCommand: runCommandOk, clock: { now: () => 'not-a-time' } }),
    (e) => e.code === 'CONTRACT_INVALID',
  );
});

test('a checker returning a non-array becomes one UNKNOWN check for its kind', async () => {
  const verdict = await verify(ART, [], {
    checkers: { citation: () => 'not-an-array' },
    runCommand: runCommandOk,
    clock: clock(),
  });
  const citation = verdict.checks.find((c) => c.kind === 'citation');
  assert.equal(citation.status, 'UNKNOWN');
  assert.equal(verdict.overall, 'UNKNOWN');
});

test('test-run evidence with a uri but no injected runner stays UNKNOWN', async () => {
  const artifact = { ...ART, evidence: [{ type: 'test-run', title: '单测', uri: 'node --test x/', verified: true }] };
  const verdict = await verify(artifact, [], { clock: clock() });
  const command = verdict.checks.find((c) => c.kind === 'command-result');
  assert.equal(command.status, 'UNKNOWN');
  assert.match(command.reason, /no command runner injected/);
  assert.equal(verdict.overall, 'UNKNOWN');
});

test('a throwing command runner stays UNKNOWN, never VERIFIED', async () => {
  const artifact = { ...ART, evidence: [{ type: 'test-run', title: '单测', uri: 'x', verified: true }] };
  const verdict = await verify(artifact, [], {
    runCommand: async () => { throw new Error('runner exploded'); },
    clock: clock(),
  });
  const command = verdict.checks.find((c) => c.kind === 'command-result');
  assert.equal(command.status, 'UNKNOWN');
  assert.match(command.reason, /command runner failed/);
});

test('an artifact with no scannable text gets an UNKNOWN injection check, not a free PASS', async () => {
  const bare = { id: 'art-1', version: 1, evidence: [{ type: 'metric' }] };
  const verdict = await verify(bare, [], { runCommand: runCommandOk, clock: clock() });
  const injection = verdict.checks.find((c) => c.kind === 'injection-marker');
  assert.equal(injection.status, 'UNKNOWN');
  assert.equal(verdict.overall, 'UNKNOWN');
});

test('non-array artifact.evidence is contract-invalid at the checkers', () => {
  const bad = { ...ART, evidence: 'nope' };
  assert.throws(() => checkDod(bad, []), (e) => e.code === 'CONTRACT_INVALID');
  assert.throws(() => checkCitations(bad), (e) => e.code === 'CONTRACT_INVALID');
});

test('engine degrades non-array evidence to UNKNOWN checks instead of throwing', async () => {
  const verdict = await verify({ ...ART, evidence: 'nope' }, [], { runCommand: runCommandOk, clock: clock() });
  assert.equal(verdict.overall, 'UNKNOWN');
  for (const kind of ['dod-item', 'citation', 'injection-marker']) {
    assert.ok(verdict.checks.some((c) => c.kind === kind && c.status === 'UNKNOWN'), `${kind} must be UNKNOWN`);
  }
});
