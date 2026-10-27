import test from 'node:test';
import assert from 'node:assert/strict';
import {
  transitionMission,
  replayMission,
  missionStateForCommand,
} from '../../../../scripts/agentic/mission/state-machine.mjs';

const base = (overrides = {}) => ({
  id: 'm1', ownerId: 'o1', revision: 1, state: 'draft', autonomy: 'A2',
  scanId: null, previewId: null, contractId: null, contractHash: null,
  ...overrides,
});

function ok(mission, event, context = {}) {
  const result = transitionMission(mission, event, context);
  assert.equal(result.ok, true, result.error?.message);
  return result.mission;
}

function rejected(mission, event, context, code) {
  const result = transitionMission(mission, event, context);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, code);
  return result;
}

test('allows the signed mission lifecycle and increments revision', () => {
  let mission = base();
  mission = ok(mission, 'scan', { scanId: 's1' });
  mission = ok(mission, 'preview', { previewId: 'p1' });
  mission = ok(mission, 'discuss');
  mission = ok(mission, 'preview');
  mission = ok(mission, 'contract', { contractId: 'c1', contractHash: 'a'.repeat(64), autonomy: 'A2' });
  mission = ok(mission, 'prepare');
  mission = ok(mission, 'start');
  mission = ok(mission, 'review');
  mission = ok(mission, 'deliver');
  assert.equal(mission.state, 'delivered');
  assert.equal(mission.revision, 10);
});

test('rejects execution before scan preview and contract prerequisites', () => {
  rejected(base(), 'preview', {}, 'PRECONDITION_FAILED');
  rejected(base({ state: 'scanned', scanId: 's1' }), 'contract', { contractId: 'c', contractHash: 'a'.repeat(64), autonomy: 'A2' }, 'PRECONDITION_FAILED');
  rejected(base({ state: 'previewed', scanId: 's1', previewId: 'p1' }), 'prepare', {}, 'PRECONDITION_FAILED');
});

test('rejects A4 and A5 as default contract autonomy', () => {
  const mission = base({ state: 'previewed', scanId: 's1', previewId: 'p1' });
  rejected(mission, 'contract', { contractId: 'c', contractHash: 'a'.repeat(64), autonomy: 'A4' }, 'AUTONOMY_REQUIRES_CONFIRMATION');
  rejected(mission, 'contract', { contractId: 'c', contractHash: 'a'.repeat(64), autonomy: 'A5' }, 'AUTONOMY_FORBIDDEN');
});

test('blocks with a need, pauses and resumes only with the same contract hash', () => {
  let mission = base({ state: 'contracted', contractHash: 'a'.repeat(64), contractId: 'c1' });
  mission = ok(mission, 'prepare');
  mission = ok(mission, 'block', { reason: 'need:open bridge' });
  assert.equal(mission.state, 'blocked');
  mission = ok(mission, 'resume', { contractHash: 'a'.repeat(64) });
  assert.equal(mission.state, 'prepping');
  mission = ok(mission, 'pause', { reason: 'user requested' });
  rejected(mission, 'resume', { contractHash: 'b'.repeat(64) }, 'CONTRACT_MISMATCH');
  mission = ok(mission, 'resume', { contractHash: 'a'.repeat(64) });
  assert.equal(mission.state, 'prepping');
});

test('expires unsigned missions at the window start and never auto-starts them', () => {
  const mission = base({ state: 'previewed', scanId: 's1', previewId: 'p1' });
  const result = transitionMission(mission, 'expire', { now: '2026-10-27T14:00:00Z', windowStart: '2026-10-27T14:00:00Z' });
  assert.equal(result.ok, true);
  assert.equal(result.mission.state, 'expired');
  rejected(result.mission, 'prepare', {}, 'TERMINAL_STATE');
});

test('rejects invalid transitions, terminal recovery, stale revisions and owner mismatch', () => {
  rejected(base({ state: 'delivered' }), 'resume', {}, 'TERMINAL_STATE');
  rejected(base({ state: 'scanned' }), 'preview', { expectedRevision: 99 }, 'CONFLICT');
  rejected(base({ ownerId: 'owner-a' }), 'scan', { ownerId: 'owner-b', scanId: 's1' }, 'NOT_FOUND');
  rejected(base(), 'start', {}, 'INVALID_TRANSITION');
});

test('replays accepted events and rejects a tampered event stream', () => {
  const initial = base();
  const first = transitionMission(initial, 'scan', { scanId: 's1' });
  assert.equal(first.ok, true);
  const second = transitionMission(first.mission, 'preview', { previewId: 'p1' });
  assert.equal(second.ok, true);
  const replay = replayMission(initial, [first.event, second.event]);
  assert.equal(replay.ok, true);
  assert.equal(replay.mission.state, 'previewed');
  const bad = replayMission(initial, [{ ...first.event, to: 'delivered' }]);
  assert.equal(bad.ok, false);
  assert.equal(bad.error.code, 'EVENT_TAMPERED');
});

test('maps command names to the state-machine events without accepting unknown commands', () => {
  assert.equal(missionStateForCommand('scan'), 'scan');
  assert.equal(missionStateForCommand('pause'), 'pause');
  assert.equal(missionStateForCommand('resume'), 'resume');
  assert.equal(missionStateForCommand('unknown'), null);
});
