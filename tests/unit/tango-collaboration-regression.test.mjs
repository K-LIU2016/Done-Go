import test from 'node:test';
import assert from 'node:assert/strict';
import { createCollaborationStore } from '../../scripts/collaboration-store.mjs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const alice = { id: 'alice', displayName: 'Alice' };
const bob = { id: 'bob', displayName: 'Bob' };
test('reopening the shared database preserves records, history and existing confirmations', () => {
  const databaseFile = join(mkdtempSync(join(tmpdir(), 'donego-collaboration-')), 'shared.sqlite');
  let store = createCollaborationStore({ databaseFile });
  let group;
  try {
    group = store.create(alice, { name: 'Persistent agreement' });
    group = store.join(bob, store.invite(alice, group.id, { revision: group.revision, role: 'member' }).token);
    group = store.change(alice, group.id, { revision: group.revision, op: 'step-add', data: { name: 'Check evidence', ownerId: bob.id } });
    group = store.change(bob, group.id, { revision: group.revision, op: 'confirm', confirmationId: group.confirmations.at(-1).id });
  } finally { store.close(); }
  for (let pass = 0; pass < 2; pass++) {
    store = createCollaborationStore({ databaseFile });
    try {
      const restored = store.get(bob, group.id);
      assert.deepEqual(restored.confirmations[0].confirmed, ['bob']);
      assert.equal(restored.steps[0].ownerId, 'bob');
      assert.equal(store.history(alice, group.id).filter(row => row.operation === 'create').length, 1);
    } finally { store.close(); }
  }
});
test('revoked materials disappear from member history and cannot be reused in old AI proposals', t => {
  const f = fixture(t, { materials: [{ id: 'source-one', title: 'Source', content: 'Shared evidence', shared: true, aiAllowed: true }], sharing: { aiAllowed: true, fields: ['materials'] } });
  f.join();
  const proposal = { id: 'proposal-one', revision: f.group.revision, policyVersion: f.group.policyVersion, reply: 'Shared evidence', actions: [], fields: ['materials'] };
  f.store.saveProposal(bob, f.group.id, proposal);
  f.change('group-edit', { materials: [{ ...f.group.materials[0], shared: false, aiAllowed: false }] });
  assert.deepEqual(f.store.get(bob, f.group.id).materials, []);
  assert.doesNotMatch(JSON.stringify(f.store.history(bob, f.group.id)), /Shared evidence/);
  assert.deepEqual(f.store.aiContext(bob, f.group.id, ['materials']).context.materials, []);
  assert.throws(() => f.store.proposal(bob, f.group.id, proposal.id), /SHARING_CHANGED/);
});
function fixture(t, data = {}) {
  const store = createCollaborationStore({ databaseFile: ':memory:' });
  t.after(() => store.close());
  let group = store.create(alice, { name: 'Evidence review', ...data });
  return { store, get group() { return group; }, change(op, data = {}, args = {}, actor = alice) {
    group = store.change(actor, group.id, { revision: group.revision, op, data, ...args }); return group;
  }, join() {
    const invite = store.invite(alice, group.id, { revision: group.revision, role: 'member' });
    group = store.join(bob, invite.token);
  } };
}
test('valid calendar dates save, impossible dates reject, and material identities survive ordinary edits', t => {
  const f = fixture(t, { startDate: '2026-10-21', endDate: '2026-12-01', materials: [{ id: 'material-123', title: 'Sources', content: 'Public evidence', shared: true }] });
  assert.equal(f.group.startDate, '2026-10-21');
  f.change('group-edit', { goal: 'Read the original sources' });
  assert.equal(f.group.materials[0].id, 'material-123');
  assert.throws(() => f.change('group-edit', { startDate: '2026-02-30' }, { reason: 'Invalid date' }), /INVALID_INPUT/);
});
test('group acceptance waits for the current delivery terms to be confirmed by affected members', t => {
  const f = fixture(t); f.join();
  f.change('step-add', { name: 'Check evidence', ownerId: bob.id });
  const stepId = f.group.steps[0].id;
  f.change('confirm', {}, { confirmationId: f.group.confirmations.at(-1).id }, bob);
  f.change('step-status', { status: 'review', result: 'Sources checked' }, { stepId }, bob);
  f.change('group-edit', { deliverables: 'Include original source links' }, { reason: 'Make results verifiable' });
  assert.throws(() => f.change('step-status', { status: 'done' }, { stepId }), /CONFIRMATION_REQUIRED/);
  const confirmationId = f.group.confirmations.at(-1).id;
  f.change('confirm', {}, { confirmationId }); f.change('confirm', {}, { confirmationId }, bob);
  assert.equal(f.change('step-status', { status: 'done' }, { stepId }).steps[0].status, 'done');
});
test('restoring old content creates increasing step versions and never restores a prior acceptance', t => {
  const f = fixture(t); f.join();
  f.change('step-add', { name: 'Check evidence', ownerId: bob.id, criteria: 'Check originals' });
  const stepId = f.group.steps[0].id;
  f.change('confirm', {}, { confirmationId: f.group.confirmations.at(-1).id }, bob);
  f.change('step-status', { status: 'review', result: 'Sources checked' }, { stepId }, bob);
  f.change('step-status', { status: 'done' }, { stepId });
  const historyId = f.store.history(alice, f.group.id)[0].id;
  for (let i = 0; i < 3; i++) f.change('step-edit', { criteria: 'Updated standard ' + i }, { stepId, reason: 'New evidence' });
  const before = f.group.steps[0];
  f.change('restore', {}, { historyId, reason: 'Use the previous wording' });
  const restored = f.group.steps[0];
  assert.ok(restored.revision > before.revision);
  assert.ok(restored.termsVersion > before.termsVersion);
  assert.equal(restored.status, 'review');
  assert.equal(restored.reviewedBy, undefined);
  assert.equal(restored.reviewedAt, undefined);
});
