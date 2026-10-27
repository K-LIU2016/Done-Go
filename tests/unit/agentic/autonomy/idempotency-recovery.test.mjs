import test from 'node:test';
import assert from 'node:assert/strict';

import { AuditLog } from '../../../../scripts/agentic/autonomy/audit.mjs';
import {
  ACTION_STATES,
  IdempotencyRecovery,
} from '../../../../scripts/agentic/autonomy/idempotency-recovery.mjs';
import { openAgenticDb, migrate } from '../../../../scripts/agentic/db/index.mjs';

const NOW = '2026-10-27T10:00:00.000Z';
const ACTOR = { actorId: 'worker-1', resolvedModel: 'gpt-6.1-sol', modelProvider: 'gateway' };
const INPUT = {
  idempotencyKey: 'idem-1', actionId: 'action-1', ownerId: 'owner-1',
  contractHash: 'contract-1', grantId: 'grant-1', actor: ACTOR,
  actionHash: 'action-hash-1',
};

const migrationDir = () => decodeURIComponent(new URL('../../../../scripts/agentic/db/migrations/', import.meta.url).pathname);

function make(options = {}) {
  return new IdempotencyRecovery({ now: () => NOW, ...options });
}

test('exports the recovery state machine and rejects impossible transitions', () => {
  assert.deepEqual(ACTION_STATES, ['pending', 'running', 'succeeded', 'failed', 'unknown', 'paused', 'cancelled', 'blocked']);
  const recovery = make();
  const started = recovery.begin(INPUT);
  assert.equal(started.status, 'started');
  assert.equal(recovery.transition(INPUT.idempotencyKey, 'succeeded').status, 'succeeded');
  assert.deepEqual(recovery.transition(INPUT.idempotencyKey, 'running'), {
    status: 'blocked', code: 'INVALID_STATE_TRANSITION',
  });
});

test('deduplicates the same action and rejects an idempotency-key collision', () => {
  const recovery = make();
  assert.equal(recovery.begin(INPUT).status, 'started');
  assert.equal(recovery.begin(INPUT).status, 'duplicate');
  assert.equal(recovery.begin({ ...INPUT, actionHash: 'different' }).code, 'IDEMPOTENCY_KEY_CONFLICT');
  assert.equal(recovery.begin({ ...INPUT, ownerId: 'owner-2' }).code, 'IDEMPOTENCY_KEY_CONFLICT');
});

test('deduplicates checkpoints and rejects a step replay with different input', () => {
  const recovery = make();
  recovery.begin(INPUT);
  assert.equal(recovery.checkpoint(INPUT.idempotencyKey, { stepId: 'plan', inputHash: 'h1', result: { ok: true } }).status, 'recorded');
  assert.equal(recovery.checkpoint(INPUT.idempotencyKey, { stepId: 'plan', inputHash: 'h1', result: { ok: true } }).status, 'duplicate');
  assert.equal(recovery.checkpoint(INPUT.idempotencyKey, { stepId: 'plan', inputHash: 'h2' }).code, 'CHECKPOINT_CONFLICT');
  assert.deepEqual(recovery.getCheckpoint(INPUT.idempotencyKey, 'plan').result, { ok: true });
});

test('runs an action once and returns the stored result for duplicate requests', async () => {
  const recovery = make();
  let calls = 0;
  const first = await recovery.execute(INPUT, async () => { calls += 1; return { artifactId: 'artifact-1' }; });
  const second = await recovery.execute(INPUT, async () => { calls += 1; return { artifactId: 'artifact-2' }; });
  assert.equal(first.status, 'succeeded');
  assert.deepEqual(second.output, first.output);
  assert.equal(second.duplicate, true);
  assert.equal(calls, 1);
});

test('marks timeout and client disconnect as UNKNOWN and recovery never retries', async () => {
  const recovery = make();
  let calls = 0;
  const result = await recovery.execute(INPUT, async () => {
    calls += 1;
    const error = new Error('client disconnected');
    error.code = 'CLIENT_DISCONNECTED';
    throw error;
  });
  assert.deepEqual({ status: result.status, code: result.code }, { status: 'UNKNOWN', code: 'EXTERNAL_RESULT_UNKNOWN' });
  const recovered = await recovery.recover(INPUT, async () => { calls += 1; });
  assert.equal(recovered.status, 'UNKNOWN');
  assert.equal(recovered.code, 'EXTERNAL_RESULT_UNKNOWN');
  assert.equal(calls, 1);
});

test('pause, grant revocation, and contract changes block recovery until the exact context is restored', async () => {
  const recovery = make();
  recovery.begin(INPUT);
  assert.equal(recovery.pause(INPUT.idempotencyKey, 'user_paused').status, 'paused');
  const changed = await recovery.recover({ ...INPUT, contractHash: 'contract-2' }, async () => ({ nope: true }));
  assert.equal(changed.code, 'CONTRACT_CHANGED');
  const revoked = await recovery.recover({ ...INPUT, grantStatus: 'revoked' }, async () => ({ nope: true }));
  assert.equal(revoked.code, 'GRANT_REVOKED');
  let calls = 0;
  const resumed = await recovery.recover({ ...INPUT, grantStatus: 'active' }, async () => { calls += 1; return 'ok'; });
  assert.equal(resumed.status, 'succeeded');
  assert.equal(calls, 1);
});

test('event ids are idempotent and event payload collisions fail closed', () => {
  const recovery = make();
  assert.equal(recovery.recordEvent({ eventId: 'event-1', type: 'action.started', payload: { n: 1 } }).status, 'recorded');
  assert.equal(recovery.recordEvent({ eventId: 'event-1', type: 'action.started', payload: { n: 1 } }).status, 'duplicate');
  assert.equal(recovery.recordEvent({ eventId: 'event-1', type: 'action.started', payload: { n: 2 } }).code, 'EVENT_ID_CONFLICT');
});

test('fails closed when the audit sink fails before execution and persists records in SQLite', async () => {
  const db = openAgenticDb(':memory:');
  migrate(db, migrationDir());
  let calls = 0;
  const audit = new AuditLog({ writer: async () => { throw new Error('disk unavailable'); } });
  const blocked = await new IdempotencyRecovery({ db, audit, now: () => NOW }).execute(INPUT, async () => { calls += 1; });
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.code, 'AUDIT_WRITE_FAILED');
  assert.equal(calls, 0);

  const recovery = new IdempotencyRecovery({ db, now: () => NOW });
  const started = recovery.begin({ ...INPUT, idempotencyKey: 'idem-2', actionId: 'action-2' });
  assert.equal(started.status, 'started');
  const row = db.prepare('SELECT status, action_id, contract_hash FROM autonomy_action_idempotency WHERE idempotency_key = ?').get('idem-2');
  assert.deepEqual(row, { status: 'pending', action_id: 'action-2', contract_hash: 'contract-1' });
  db.close();
});


test('unresolved actor models remain UNKNOWN and cannot enter execution', async () => {
  let calls = 0;
  const result = await make().execute({ ...INPUT, actor: { actorId: 'worker-1', resolvedModel: null } }, async () => { calls += 1; });
  assert.equal(result.status, 'UNKNOWN');
  assert.equal(result.code, 'ACTOR_MODEL_UNKNOWN');
  assert.equal(calls, 0);
});
