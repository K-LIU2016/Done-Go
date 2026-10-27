import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { AuditLog, createDatabaseAuditWriter } from '../../../../scripts/agentic/autonomy/audit.mjs';
import { openAgenticDb, migrate } from '../../../../scripts/agentic/db/index.mjs';

const ACTOR = { actorId: 'worker-1', resolvedModel: 'gpt-6.1-sol', modelProvider: 'gateway' };
const NOW = '2026-10-27T10:00:00.000Z';

function migrationDir() {
  return join(decodeURIComponent(new URL('../../../../scripts/agentic/db/migrations/', import.meta.url).pathname));
}

test('records grant, policy, confirmation, action, unknown, and recovery audit events', async () => {
  const audit = new AuditLog();
  await audit.grantIssued({ grantId: 'g-1', ownerId: 'owner-1', actor: ACTOR, contractHash: 'hash-1', at: NOW });
  await audit.grantConsumed({ grantId: 'g-1', ownerId: 'owner-1', actor: ACTOR, at: NOW });
  await audit.grantRevoked({ grantId: 'g-1', ownerId: 'owner-1', reason: 'contract_changed', at: NOW });
  await audit.policyDenied({ actionId: 'a-1', ownerId: 'owner-1', actor: ACTOR, code: 'SCOPE_DENIED', at: NOW });
  await audit.confirmationIssued({ actionId: 'a-2', ownerId: 'owner-1', actor: ACTOR, contractHash: 'hash-1', at: NOW });
  await audit.confirmationRejected({ actionId: 'a-2', code: 'CONFIRMATION_REPLAY', at: NOW });
  await audit.action({ actionId: 'a-3', ownerId: 'owner-1', actor: ACTOR, phase: 'started', at: NOW });
  await audit.unknown({ actionId: 'a-3', ownerId: 'owner-1', reason: 'client_disconnected', at: NOW });
  await audit.recovery({ actionId: 'a-3', ownerId: 'owner-1', decision: 'not_retried', at: NOW });

  assert.deepEqual(audit.events.map((event) => event.type), [
    'autonomy.grant.issued', 'autonomy.grant.consumed', 'autonomy.grant.revoked',
    'autonomy.policy.denied', 'autonomy.confirmation.issued', 'autonomy.confirmation.rejected',
    'autonomy.action.started', 'autonomy.action.unknown', 'autonomy.recovery',
  ]);
  assert.equal(audit.events[0].resolvedModel, ACTOR.resolvedModel);
  assert.equal(audit.events[7].status, 'UNKNOWN');
});

test('fails closed and latches audit availability after a write failure', async () => {
  const audit = new AuditLog({ writer: async () => { throw new Error('read only'); } });
  await assert.rejects(() => audit.policyDenied({ actionId: 'a-1' }), (error) => error.code === 'AUDIT_WRITE_FAILED');
  assert.equal(audit.available, false);
  await assert.rejects(() => audit.recovery({ actionId: 'a-1' }), (error) => error.code === 'AUDIT_WRITE_FAILED');
});

test('persists structured audit events through the allowed autonomy migration', async () => {
  const db = openAgenticDb(':memory:');
  migrate(db, migrationDir());
  const audit = new AuditLog({ writer: createDatabaseAuditWriter(db) });
  await audit.action({ actionId: 'a-1', ownerId: 'owner-1', actor: ACTOR, phase: 'result', result: 'succeeded', at: NOW });
  const row = db.prepare('SELECT event_type, action_id, owner_id, actor_id, resolved_model, occurred_at FROM autonomy_audit_events').get();
  assert.deepEqual(row, {
    event_type: 'autonomy.action.result', action_id: 'a-1', owner_id: 'owner-1',
    actor_id: 'worker-1', resolved_model: 'gpt-6.1-sol', occurred_at: NOW,
  });
  db.close();
});
