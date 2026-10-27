import test from 'node:test';
import assert from 'node:assert/strict';
import { loadModule } from './_harness.mjs';

const provenance = () => loadModule('provenance.mjs');
const actor = (role, extra = {}) => ({ role, ...extra });

test('provenance: assertActorResolved passes a resolved gateway actor', async () => {
  const { assertActorResolved } = await provenance();
  const resolved = assertActorResolved(actor('worker', { model: 'gpt-6-luna', modelSource: 'gateway' }));
  assert.equal(resolved.model, 'gpt-6-luna');
  assert.equal(resolved.verifiable, true);
});

test('provenance: assertActorResolved throws PROVENANCE_UNRESOLVED for a missing model (N1)', async () => {
  const { assertActorResolved } = await provenance();
  assert.throws(
    () => assertActorResolved(actor('reviewer')),
    (error) => {
      assert.equal(error.code, 'PROVENANCE_UNRESOLVED');
      assert.equal(error.details.role, 'reviewer');
      return true;
    },
  );
});

test('provenance: assertActorResolved does not fabricate a model for a blank model', async () => {
  const { assertActorResolved } = await provenance();
  assert.throws(
    () => assertActorResolved(actor('verifier', { model: '   ' })),
    (error) => error.code === 'PROVENANCE_UNRESOLVED',
  );
});

test('provenance: assertActorResolved rejects a resolved model with unknown source', async () => {
  const { assertActorResolved } = await provenance();
  assert.throws(
    () => assertActorResolved(actor('fixer', { model: 'glm-5.3' })),
    (error) => {
      assert.equal(error.code, 'PROVENANCE_UNRESOLVED');
      assert.equal(error.details.reason, 'MODEL_SOURCE_UNVERIFIABLE');
      return true;
    },
  );
});

test('provenance: assertActorsResolved reports every unresolved actor at once', async () => {
  const { assertActorsResolved } = await provenance();
  assert.throws(
    () => assertActorsResolved([
      actor('reviewer'),
      actor('worker', { model: 'gpt-6-luna', modelSource: 'gateway' }),
      actor('fixer'),
    ]),
    (error) => {
      assert.equal(error.code, 'PROVENANCE_UNRESOLVED');
      assert.deepEqual(error.details.unresolvedRoles, ['reviewer', 'fixer']);
      return true;
    },
  );
});

test('provenance: assertActorsResolved accepts an empty roster as vacuously resolved', async () => {
  const { assertActorsResolved } = await provenance();
  assert.deepEqual(assertActorsResolved([]), []);
});

test('provenance: markRunComplete throws RUN_NOT_VERIFIABLE for an unresolved actor (N2)', async () => {
  const { markRunComplete } = await provenance();
  const run = { id: 'run-1', state: 'running' };
  assert.throws(
    () => markRunComplete({ run, actors: [actor('reviewer')] }),
    (error) => error.code === 'RUN_NOT_VERIFIABLE',
  );
  assert.equal(run.state, 'running', 'the run object must not be mutated on rejection');
});

test('provenance: markRunComplete returns the completed run with a resolved roster', async () => {
  const { markRunComplete } = await provenance();
  const run = { id: 'run-1', state: 'running' };
  const completed = markRunComplete({
    run,
    actors: [actor('conductor', { model: 'gpt-6.1-sol', modelSource: 'gateway' })],
  });
  assert.equal(completed.state, 'succeeded');
  assert.equal(completed.id, 'run-1');
  assert.equal(completed.provenance.resolved, 1);
  assert.equal(completed.provenance.unknown, 0);
  assert.equal(completed.provenance.verifiable, true);
});

test('provenance: markRunComplete honours an explicit terminal state', async () => {
  const { markRunComplete } = await provenance();
  const completed = markRunComplete({
    run: { id: 'run-2', state: 'running' },
    actors: [actor('worker', { model: 'gpt-6-luna', modelSource: 'gateway' })],
    state: 'partial',
  });
  assert.equal(completed.state, 'partial');
});

test('provenance: markRunComplete refuses to invent a non-terminal completion state', async () => {
  const { markRunComplete } = await provenance();
  assert.throws(
    () => markRunComplete({ run: { id: 'run-3' }, actors: [actor('worker', { model: 'x', modelSource: 'gateway' })], state: 'running' }),
    (error) => error.code === 'RUN_STATE_INVALID',
  );
});

test('provenance: mock-only rosters complete but are not verifiable (BRIEF §3)', async () => {
  const { markRunComplete } = await provenance();
  const completed = markRunComplete({
    run: { id: 'run-4' },
    actors: [actor('reviewer', { model: 'glm-5.3', modelSource: 'mock' })],
  });
  assert.equal(completed.state, 'succeeded');
  assert.equal(completed.provenance.verifiable, false);
  assert.equal(completed.provenance.evidenceStatus, 'PROVISIONAL');
});

test('provenance: summarizeProvenance counts resolved, unknown, verifiable and mock actors', async () => {
  const { summarizeProvenance } = await provenance();
  const summary = summarizeProvenance([
    actor('conductor', { model: 'gpt-6.1-sol', modelSource: 'gateway' }),
    actor('worker', { model: 'gpt-6-luna', modelSource: 'gateway' }),
    actor('reviewer'),
    actor('fixer', { model: 'glm-5.3', modelSource: 'mock' }),
  ]);
  assert.equal(summary.total, 4);
  assert.equal(summary.resolved, 3);
  assert.equal(summary.unknown, 1);
  assert.equal(summary.verifiable, 2);
  assert.equal(summary.mock, 1);
  assert.deepEqual(summary.unresolvedRoles, ['reviewer']);
});

test('provenance: summarizeProvenance with a fully verifiable roster marks evidence VERIFIED', async () => {
  const { summarizeProvenance } = await provenance();
  const summary = summarizeProvenance([
    actor('conductor', { model: 'gpt-6.1-sol', modelSource: 'gateway' }),
  ]);
  assert.equal(summary.evidenceStatus, 'VERIFIED');
});

test('provenance: summarizeProvenance with any unknown actor marks evidence UNKNOWN', async () => {
  const { summarizeProvenance } = await provenance();
  const summary = summarizeProvenance([actor('reviewer')]);
  assert.equal(summary.evidenceStatus, 'UNKNOWN');
});

test('provenance: summarizeProvenance marks a fixture-sourced roster PROVISIONAL', async () => {
  const { summarizeProvenance } = await provenance();
  const summary = summarizeProvenance([actor('worker', { model: 'gpt-6-luna', modelSource: 'fixture' })]);
  assert.equal(summary.evidenceStatus, 'PROVISIONAL');
  assert.equal(summary.verifiable, 0);
});

test('provenance: summarizeProvenance keeps an empty roster UNKNOWN, never verified', async () => {
  const { summarizeProvenance } = await provenance();
  const summary = summarizeProvenance([]);
  assert.equal(summary.total, 0);
  assert.equal(summary.evidenceStatus, 'UNKNOWN');
});

test('provenance: markRunComplete cannot promote a mock roster to VERIFIED evidence', async () => {
  const { markRunComplete } = await provenance();
  const completed = markRunComplete({
    run: { id: 'run-5' },
    actors: [actor('worker', { model: 'gpt-6-luna', modelSource: 'mock' })],
  });
  assert.notEqual(completed.provenance.evidenceStatus, 'VERIFIED');
  assert.equal(completed.verifiable, false);
});

test('provenance: actorRoster dedupes one role appearing twice only when models agree', async () => {
  const { actorRoster } = await provenance();
  const roster = actorRoster([
    actor('worker', { model: 'gpt-6-luna', modelSource: 'gateway' }),
    actor('worker', { model: 'gpt-6-luna', modelSource: 'gateway' }),
  ]);
  assert.equal(roster.length, 1);
  assert.throws(
    () => actorRoster([
      actor('worker', { model: 'gpt-6-luna', modelSource: 'gateway' }),
      actor('worker', { model: 'glm-5.3', modelSource: 'gateway' }),
    ]),
    (error) => error.code === 'PROVENANCE_CONFLICT',
  );
});
