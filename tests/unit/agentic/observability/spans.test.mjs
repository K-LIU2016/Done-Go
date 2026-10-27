import test from 'node:test';
import assert from 'node:assert/strict';
import { loadModule, span } from './_harness.mjs';

const dbApi = () => import('../../../../scripts/agentic/db/index.mjs');
const spansApi = () => loadModule('spans.mjs');
const storeApi = () => loadModule('store.mjs');

async function freshSpans() {
  const { openAgenticDb } = await dbApi();
  const { applyObservabilityMigrations, createObservabilityStore } = await storeApi();
  const { createSpanRecorder } = await spansApi();
  const db = openAgenticDb(':memory:');
  applyObservabilityMigrations(db);
  const store = createObservabilityStore({ db });
  return { db, store, recorder: createSpanRecorder({ store }) };
}

test('spans: recordSpan rejects a span that violates the frozen W0 span schema', async () => {
  const { recorder } = await freshSpans();
  assert.throws(
    () => recorder.record({ id: 's1', name: 'x', kind: 'teleport', startedAt: '2026-10-27T10:00:00.000Z', status: 'ok' }, { ownerId: 'owner-a' }),
    (error) => error.code === 'CONTRACT_INVALID',
  );
});

test('spans: recordSpan rejects a span missing startedAt', async () => {
  const { recorder } = await freshSpans();
  assert.throws(
    () => recorder.record({ id: 's1', name: 'x', kind: 'chat', status: 'ok' }, { ownerId: 'owner-a' }),
    (error) => error.code === 'CONTRACT_INVALID',
  );
});

test('spans: recordSpan rejects unknown top-level fields instead of smuggling new W0 fields', async () => {
  const { recorder } = await freshSpans();
  assert.throws(
    () => recorder.record({ ...span({ id: 's1' }), model: 'gpt-6-luna' }, { ownerId: 'owner-a' }),
    (error) => error.code === 'CONTRACT_INVALID',
  );
});

test('spans: recordSpan projects provenance attributes into dedicated columns', async () => {
  const { recorder, store } = await freshSpans();
  const result = recorder.record(
    span({
      id: 's1',
      kind: 'chat',
      attributes: {
        'gen_ai.request.model': 'gpt-6-luna',
        'gen_ai.response.model': 'gpt-6-luna',
        'donego.actor.role': 'worker',
        'donego.actor.model': 'gpt-6-luna',
        'donego.model.source': 'gateway',
        'donego.model.local': false,
      },
    }),
    { ownerId: 'owner-a', runId: 'run-1' },
  );
  assert.equal(result.inserted, true);
  assert.equal(result.duplicate, false);
  const row = store.getSpan('owner-a', 's1');
  assert.equal(row.request_model, 'gpt-6-luna');
  assert.equal(row.actor_role, 'worker');
  assert.equal(row.actor_model, 'gpt-6-luna');
  assert.equal(row.resolved_model, 'gpt-6-luna');
  assert.equal(row.model_source, 'gateway');
  assert.equal(row.model_local, 0);
});

test('spans: a chat span with no actor model stores NULL resolved_model and UNKNOWN (N1, red line 7)', async () => {
  const { recorder, store } = await freshSpans();
  recorder.record(span({ id: 's1', kind: 'chat', attributes: { 'gen_ai.request.model': 'gpt-6-luna' } }), { ownerId: 'owner-a' });
  const row = store.getSpan('owner-a', 's1');
  assert.equal(row.actor_model, null);
  assert.equal(row.resolved_model, null);
  assert.equal(row.provenance, 'UNKNOWN');
});

test('spans: recordSpan never backfills resolved_model from request_model', async () => {
  const { recorder, store } = await freshSpans();
  recorder.record(
    span({ id: 's1', kind: 'chat', attributes: { 'gen_ai.request.model': 'gpt-6-luna', 'donego.actor.role': 'worker' } }),
    { ownerId: 'owner-a' },
  );
  const row = store.getSpan('owner-a', 's1');
  assert.equal(row.request_model, 'gpt-6-luna');
  assert.equal(row.resolved_model, null);
  assert.equal(row.provenance, 'UNKNOWN');
});

test('spans: attributes outside the vocabulary are preserved verbatim in attributes_json', async () => {
  const { recorder, store } = await freshSpans();
  recorder.record(
    span({ id: 's1', attributes: { 'donego.mission.id': 'm-1', 'donego.contract.hash': 'a'.repeat(64), 'custom.flag': 'yes' } }),
    { ownerId: 'owner-a' },
  );
  const row = store.getSpan('owner-a', 's1');
  const attributes = JSON.parse(row.attributes_json);
  assert.equal(attributes['donego.mission.id'], 'm-1');
  assert.equal(attributes['custom.flag'], 'yes');
});

test('spans: a whitespace-only actor model is treated as absent and stored UNKNOWN (N1 空)', async () => {
  const { recorder, store } = await freshSpans();
  recorder.record(
    span({ id: 's1', kind: 'chat', attributes: { 'donego.actor.role': 'worker', 'donego.actor.model': '   ' } }),
    { ownerId: 'owner-a' },
  );
  const row = store.getSpan('owner-a', 's1');
  assert.equal(row.actor_model, null);
  assert.equal(row.resolved_model, null);
  assert.equal(row.provenance, 'UNKNOWN');
});

test('spans: an explicit resolved-model attribute wins, a blank one falls back to the actor model', async () => {
  const { recorder, store } = await freshSpans();
  recorder.record(
    span({
      id: 's1',
      kind: 'chat',
      attributes: { 'donego.actor.role': 'worker', 'donego.actor.model': 'glm-4.7', 'donego.model.resolved': 'glm-4.7-air' },
    }),
    { ownerId: 'owner-a' },
  );
  recorder.record(
    span({
      id: 's2',
      kind: 'chat',
      attributes: { 'donego.actor.role': 'worker', 'donego.actor.model': 'glm-4.7', 'donego.model.resolved': '   ' },
    }),
    { ownerId: 'owner-a' },
  );
  assert.equal(store.getSpan('owner-a', 's1').resolved_model, 'glm-4.7-air');
  assert.equal(store.getSpan('owner-a', 's2').resolved_model, 'glm-4.7');
});

test('spans: model_local true is stored as 1 and absent stays NULL', async () => {
  const { recorder, store } = await freshSpans();
  recorder.record(
    span({ id: 's1', attributes: { 'donego.actor.role': 'worker', 'donego.actor.model': 'glm-4.7', 'donego.model.local': true } }),
    { ownerId: 'owner-a' },
  );
  recorder.record(span({ id: 's2', attributes: { 'donego.actor.role': 'worker', 'donego.actor.model': 'glm-4.7' } }), { ownerId: 'owner-a' });
  assert.equal(store.getSpan('owner-a', 's1').model_local, 1);
  assert.equal(store.getSpan('owner-a', 's2').model_local, null);
});

test('spans: re-recording a span is idempotent (N3)', async () => {
  const { recorder, store } = await freshSpans();
  recorder.record(
    span({ id: 's1', status: 'running', startedAt: '2026-10-27T10:00:00.000Z', endedAt: undefined }),
    { ownerId: 'owner-a', runId: 'run-1' },
  );
  const second = recorder.record(
    span({ id: 's1', status: 'ok', startedAt: '2026-10-27T11:00:00.000Z' }),
    { ownerId: 'owner-a', runId: 'run-1' },
  );
  assert.equal(second.duplicate, true);
  const row = store.getSpan('owner-a', 's1');
  assert.equal(row.status, 'running');
  assert.equal(row.started_at, '2026-10-27T10:00:00.000Z');
  assert.equal(store.countSpans('owner-a'), 1);
});

test('spans: recording a span id already owned by somebody else is rejected, not merged', async () => {
  const { recorder } = await freshSpans();
  recorder.record(span({ id: 's1' }), { ownerId: 'owner-a', runId: 'run-1' });
  assert.throws(
    () => recorder.record(span({ id: 's1' }), { ownerId: 'owner-b', runId: 'run-1' }),
    (error) => error.code === 'SPAN_OWNER_MISMATCH',
  );
});

test('spans: recordSpan without an owner is refused', async () => {
  const { recorder } = await freshSpans();
  assert.throws(() => recorder.record(span({ id: 's1' }), {}), (error) => error.code === 'OWNER_REQUIRED');
});

test('spans: buildSpanTree nests children by parentId and keeps orphans visible', async () => {
  const { recorder, store } = await freshSpans();
  recorder.record(span({ id: 'root', startedAt: '2026-10-27T10:00:00.000Z' }), { ownerId: 'owner-a', runId: 'run-1' });
  recorder.record(span({ id: 'child', parentId: 'root', startedAt: '2026-10-27T10:00:01.000Z' }), { ownerId: 'owner-a', runId: 'run-1' });
  recorder.record(span({ id: 'orphan', parentId: 'ghost', startedAt: '2026-10-27T10:00:02.000Z' }), { ownerId: 'owner-a', runId: 'run-1' });
  const tree = recorder.buildTree('owner-a', 'run-1');
  assert.equal(tree.roots.length, 2);
  const root = tree.roots.find((node) => node.id === 'root');
  assert.deepEqual(root.children.map((node) => node.id), ['child']);
  assert.deepEqual(tree.orphans, ['orphan']);
});

test('spans: buildTree is owner scoped (N12)', async () => {
  const { recorder } = await freshSpans();
  recorder.record(span({ id: 'a1' }), { ownerId: 'owner-a', runId: 'run-1' });
  const tree = recorder.buildTree('owner-b', 'run-1');
  assert.deepEqual(tree.roots, []);
});

test('spans: buildTree never mutates the stored rows', async () => {
  const { recorder, store } = await freshSpans();
  recorder.record(span({ id: 'root' }), { ownerId: 'owner-a', runId: 'run-1' });
  const before = JSON.stringify(store.listRunSpans('owner-a', 'run-1'));
  recorder.buildTree('owner-a', 'run-1');
  assert.equal(JSON.stringify(store.listRunSpans('owner-a', 'run-1')), before);
});

test('spans: a running span past its SLA is reported timed_out, neither failure nor success (N9)', async () => {
  const { recorder } = await freshSpans();
  recorder.record(
    span({ id: 'slow', status: 'running', startedAt: '2026-10-27T10:00:00.000Z', endedAt: undefined }),
    { ownerId: 'owner-a', runId: 'run-1' },
  );
  const outcome = recorder.classifyOutcome({
    ownerId: 'owner-a',
    runId: 'run-1',
    now: '2026-10-27T10:05:00.000Z',
    slaMs: 60_000,
  });
  const entry = outcome.spans.find((item) => item.id === 'slow');
  assert.equal(entry.outcome, 'timed_out');
  assert.equal(outcome.counts.timed_out, 1);
  assert.equal(outcome.counts.failed, 0);
  assert.equal(outcome.counts.succeeded, 0);
});

test('spans: a running span inside its SLA stays running, not timed_out', async () => {
  const { recorder } = await freshSpans();
  recorder.record(
    span({ id: 'fresh', status: 'running', startedAt: '2026-10-27T10:00:00.000Z', endedAt: undefined }),
    { ownerId: 'owner-a', runId: 'run-1' },
  );
  const outcome = recorder.classifyOutcome({ ownerId: 'owner-a', runId: 'run-1', now: '2026-10-27T10:00:30.000Z', slaMs: 60_000 });
  assert.equal(outcome.spans[0].outcome, 'running');
  assert.equal(outcome.counts.timed_out, 0);
});

test('spans: a span with startedAt but no terminal status is incomplete (N10)', async () => {
  const { recorder } = await freshSpans();
  recorder.record(
    span({ id: 'cut', status: 'running', startedAt: '2026-10-27T10:00:00.000Z', endedAt: undefined }),
    { ownerId: 'owner-a', runId: 'run-1' },
  );
  const outcome = recorder.classifyOutcome({ ownerId: 'owner-a', runId: 'run-1', now: '2026-10-27T10:00:05.000Z', slaMs: 60_000 });
  assert.equal(outcome.counts.incomplete, 1);
  assert.equal(outcome.spans[0].incomplete, true);
});

test('spans: outcomes split ok and error correctly and never count both', async () => {
  const { recorder } = await freshSpans();
  recorder.record(span({ id: 'a', status: 'ok' }), { ownerId: 'owner-a', runId: 'run-1' });
  recorder.record(span({ id: 'b', status: 'error', error: 'boom' }), { ownerId: 'owner-a', runId: 'run-1' });
  const outcome = recorder.classifyOutcome({ ownerId: 'owner-a', runId: 'run-1', now: '2026-10-27T11:00:00.000Z', slaMs: 60_000 });
  assert.equal(outcome.counts.succeeded, 1);
  assert.equal(outcome.counts.failed, 1);
  assert.equal(outcome.counts.timed_out, 0);
  assert.equal(outcome.counts.incomplete, 0);
});

test('spans: classifyOutcome requires a slaMs number and a now timestamp', async () => {
  const { recorder } = await freshSpans();
  assert.throws(() => recorder.classifyOutcome({ ownerId: 'owner-a', runId: 'run-1' }), (error) => error.code === 'INVALID_ARGUMENT');
  assert.throws(
    () => recorder.classifyOutcome({ ownerId: 'owner-a', runId: 'run-1', now: 'not-a-date', slaMs: 1000 }),
    (error) => error.code === 'INVALID_ARGUMENT',
  );
});
