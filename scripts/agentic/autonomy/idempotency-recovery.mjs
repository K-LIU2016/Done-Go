import { createHash } from 'node:crypto';

import { AuditLog } from './audit.mjs';
import { normalizeActor } from './types.mjs';

export const ACTION_STATES = Object.freeze([
  'pending', 'running', 'succeeded', 'failed', 'unknown', 'paused', 'cancelled', 'blocked',
]);

const TERMINAL = new Set(['succeeded', 'failed', 'unknown', 'cancelled', 'blocked']);
const TRANSITIONS = Object.freeze({
  pending: new Set(['running', 'succeeded', 'failed', 'unknown', 'paused', 'cancelled', 'blocked']),
  running: new Set(['succeeded', 'failed', 'unknown', 'paused', 'cancelled', 'blocked']),
  paused: new Set(['running', 'cancelled', 'blocked']),
  succeeded: new Set(['unknown']),
  failed: new Set(['unknown']),
  unknown: new Set(), cancelled: new Set(), blocked: new Set(),
});

const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = (code) => ({ status: 'blocked', code });
const resultJson = (value) => value === undefined ? null : JSON.stringify(value);

function fingerprint(input) {
  let actor;
  try { actor = normalizeActor(input.actor); } catch { return null; }
  return {
    actionId: input.actionId,
    ownerId: input.ownerId,
    contractHash: input.contractHash,
    grantId: input.grantId ?? null,
    actorId: actor.actorId,
    resolvedModel: actor.resolvedModel,
    actionHash: input.actionHash ?? null,
  };
}

function contextValid(input) {
  const fp = fingerprint(input);
  if (!fp) return { error: 'ACTOR_INVALID' };
  if (fp.resolvedModel == null) return { error: 'ACTOR_MODEL_UNKNOWN' };
  if (![fp.actionId, fp.ownerId, fp.contractHash, input.idempotencyKey].every((value) => typeof value === 'string' && value.length > 0)) {
    return { error: 'IDEMPOTENCY_INPUT_INVALID' };
  }
  if (input.grantStatus && input.grantStatus !== 'active') return { error: 'GRANT_REVOKED' };
  return { fingerprint: fp };
}

export class IdempotencyRecovery {
  constructor({ db = null, audit = new AuditLog(), now = () => new Date().toISOString() } = {}) {
    this.db = db;
    this.audit = audit;
    this.now = now;
    this.actions = new Map();
    this.checkpoints = new Map();
    this.events = new Map();
    this.inFlight = new Map();
    this.inFlightFingerprints = new Map();
  }

  #row(key) {
    if (this.db) return this.db.prepare('SELECT * FROM autonomy_action_idempotency WHERE idempotency_key = ?').get(key);
    return this.actions.get(key);
  }

  #writeAction(key, record) {
    if (this.db) {
      this.db.prepare(`INSERT INTO autonomy_action_idempotency
        (idempotency_key, action_id, owner_id, contract_hash, grant_id, actor_id, resolved_model, action_hash, status, result_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(idempotency_key) DO UPDATE SET status=excluded.status, result_json=excluded.result_json, updated_at=excluded.updated_at`)
        .run(key, record.actionId, record.ownerId, record.contractHash, record.grantId, record.actorId,
          record.resolvedModel, record.actionHash, record.status, resultJson(record.result), record.createdAt, record.updatedAt);
    } else this.actions.set(key, { ...record });
  }

  #same(record, fp) {
    return (record.action_id ?? record.actionId) === fp.actionId
      && (record.owner_id ?? record.ownerId) === fp.ownerId
      && (record.contract_hash ?? record.contractHash) === fp.contractHash
      && (record.grant_id ?? record.grantId ?? null) === fp.grantId
      && (record.actor_id ?? record.actorId) === fp.actorId
      && (record.resolved_model ?? record.resolvedModel) === fp.resolvedModel
      && (record.action_hash ?? record.actionHash ?? null) === fp.actionHash;
  }

  #public(record, duplicate = false) {
    const status = record.status;
    const output = record.result_json == null ? record.result : (() => {
      try { return JSON.parse(record.result_json); } catch { return null; }
    })();
    return { status, code: status === 'succeeded' ? 'SUCCEEDED' : status === 'unknown' ? 'EXTERNAL_RESULT_UNKNOWN' : status.toUpperCase(), ...(output === undefined ? {} : { output }), ...(duplicate ? { duplicate: true } : {}) };
  }

  begin(input) {
    const checked = contextValid(input);
    if (checked.error) return fail(checked.error);
    const existing = this.#row(input.idempotencyKey);
    if (existing) return this.#same(existing, checked.fingerprint) ? { status: 'duplicate', code: 'IDEMPOTENT_REPLAY', priorStatus: existing.status } : fail('IDEMPOTENCY_KEY_CONFLICT');
    const now = this.now();
    this.#writeAction(input.idempotencyKey, { ...checked.fingerprint, status: 'pending', result: null, createdAt: now, updatedAt: now });
    return { status: 'started', code: 'STARTED' };
  }

  transition(key, next, result = undefined) {
    if (!ACTION_STATES.includes(next)) return fail('STATE_INVALID');
    const row = this.#row(key);
    if (!row) return fail('IDEMPOTENCY_NOT_FOUND');
    const current = row.status;
    if (!TRANSITIONS[current]?.has(next)) return fail('INVALID_STATE_TRANSITION');
    const now = this.now();
    const priorResult = row.result_json ? JSON.parse(row.result_json) : row.result ?? null;
    const record = { ...row, status: next, result: result ?? priorResult, result_json: resultJson(result ?? priorResult), updatedAt: now };
    if (this.db) {
      this.db.prepare('UPDATE autonomy_action_idempotency SET status = ?, result_json = ?, updated_at = ? WHERE idempotency_key = ?').run(next, record.result_json, now, key);
    } else this.actions.set(key, record);
    return { status: next, code: next.toUpperCase() };
  }

  checkpoint(key, { stepId, inputHash, result } = {}) {
    if (!stepId || !inputHash) return fail('CHECKPOINT_INPUT_INVALID');
    const action = this.#row(key);
    if (!action) return fail('IDEMPOTENCY_NOT_FOUND');
    const existing = this.getCheckpoint(key, stepId);
    if (existing) return existing.input_hash === inputHash ? { status: 'duplicate', code: 'CHECKPOINT_REPLAY' } : fail('CHECKPOINT_CONFLICT');
    const now = this.now();
    if (this.db) this.db.prepare('INSERT INTO autonomy_checkpoints (idempotency_key, step_id, input_hash, result_json, created_at) VALUES (?, ?, ?, ?, ?)').run(key, stepId, inputHash, resultJson(result), now);
    else this.checkpoints.set(`${key}:${stepId}`, { idempotency_key: key, step_id: stepId, input_hash: inputHash, result });
    return { status: 'recorded', code: 'CHECKPOINT_RECORDED' };
  }

  getCheckpoint(key, stepId) {
    if (this.db) return this.db.prepare('SELECT * FROM autonomy_checkpoints WHERE idempotency_key = ? AND step_id = ?').get(key, stepId);
    return this.checkpoints.get(`${key}:${stepId}`);
  }

  recordEvent({ eventId, type, idempotencyKey = null, payload = {} } = {}) {
    if (!eventId || !type) return fail('EVENT_INPUT_INVALID');
    const encoded = JSON.stringify({ type, idempotencyKey, payload });
    const existing = this.db
      ? this.db.prepare('SELECT * FROM autonomy_events WHERE event_id = ?').get(eventId)
      : this.events.get(eventId);
    if (existing) return existing.payload_json === encoded ? { status: 'duplicate', code: 'EVENT_REPLAY' } : fail('EVENT_ID_CONFLICT');
    const now = this.now();
    if (this.db) this.db.prepare('INSERT INTO autonomy_events (event_id, event_type, idempotency_key, payload_json, occurred_at) VALUES (?, ?, ?, ?, ?)').run(eventId, type, idempotencyKey, encoded, now);
    else this.events.set(eventId, { payload_json: encoded });
    return { status: 'recorded', code: 'EVENT_RECORDED' };
  }

  pause(key, reason = 'paused') {
    return this.transition(key, 'paused', { reason });
  }

  async #executeUnlocked(input, executor) {
    const checked = contextValid(input);
    if (checked.error) {
      const result = checked.error === 'ACTOR_MODEL_UNKNOWN' ? { status: 'UNKNOWN', code: checked.error } : fail(checked.error);
      return result;
    }
    const existing = this.#row(input.idempotencyKey);
    if (existing) {
      if (!this.#same(existing, checked.fingerprint)) return fail('IDEMPOTENCY_KEY_CONFLICT');
      if (TERMINAL.has(existing.status)) return this.#public(existing, true);
      if (existing.status === 'unknown') return this.#public(existing, true);
      const inFlight = this.inFlight.get(input.idempotencyKey);
      if (inFlight) return inFlight;
    } else {
      try {
        await this.audit.append({ type: 'autonomy.action.started', actionId: input.actionId, ownerId: input.ownerId, actor: input.actor, resolvedModel: checked.fingerprint.resolvedModel, status: 'pending' });
      } catch (error) { return fail(error.code ?? 'AUDIT_WRITE_FAILED'); }
      this.begin(input);
    }
    const row = this.#row(input.idempotencyKey);
    if (row.status === 'paused') return fail('ACTION_PAUSED');
    this.transition(input.idempotencyKey, 'running');
    try {
      const output = await executor();
      const done = this.transition(input.idempotencyKey, 'succeeded', output);
      try { await this.audit.append({ type: 'autonomy.action.result', actionId: input.actionId, ownerId: input.ownerId, actor: input.actor, status: 'succeeded', code: 'SUCCEEDED' }); }
      catch (error) { this.transition(input.idempotencyKey, 'unknown'); return fail(error.code ?? 'AUDIT_WRITE_FAILED'); }
      return { ...done, output };
    } catch (error) {
      const unknown = error?.unknown || error?.code === 'CLIENT_DISCONNECTED' || error?.code === 'TIMEOUT';
      const done = this.transition(input.idempotencyKey, unknown ? 'unknown' : 'failed', { message: error?.message ?? 'execution failed' });
      try { await this.audit.append({ type: unknown ? 'autonomy.action.unknown' : 'autonomy.action.result', actionId: input.actionId, ownerId: input.ownerId, actor: input.actor, status: done.status, code: unknown ? 'EXTERNAL_RESULT_UNKNOWN' : 'EXECUTION_FAILED' }); } catch { /* retain fail-closed state */ }
      return { status: unknown ? 'UNKNOWN' : 'failed', code: unknown ? 'EXTERNAL_RESULT_UNKNOWN' : 'EXECUTION_FAILED' };
    }
  }

  async execute(input, executor) {
    const existingWork = this.inFlight.get(input?.idempotencyKey);
    if (existingWork) {
      const checked = contextValid(input);
      if (checked.error) return fail(checked.error);
      const row = this.#row(input.idempotencyKey);
      return this.inFlightFingerprints.get(input.idempotencyKey) === digest(checked.fingerprint)
        ? existingWork
        : fail('IDEMPOTENCY_KEY_CONFLICT');
    }
    const key = input?.idempotencyKey;
    const checked = contextValid(input);
    const work = this.#executeUnlocked(input, executor);
    this.inFlightFingerprints.set(key, checked.error ? null : digest(checked.fingerprint));
    this.inFlight.set(key, work);
    try { return await work; } finally {
      this.inFlight.delete(key);
      this.inFlightFingerprints.delete(key);
    }
  }

  async #recoverUnlocked(input, executor) {
    const checked = contextValid(input);
    if (checked.error) return fail(checked.error);
    const row = this.#row(input.idempotencyKey);
    if (!row) return this.execute(input, executor);
    if (!this.#same(row, checked.fingerprint)) return fail(row.contract_hash !== input.contractHash ? 'CONTRACT_CHANGED' : 'IDEMPOTENCY_KEY_CONFLICT');
    if (input.grantStatus && input.grantStatus !== 'active') return fail('GRANT_REVOKED');
    if (row.status === 'unknown') return { ...this.#public(row), code: 'EXTERNAL_RESULT_UNKNOWN', status: 'UNKNOWN' };
    if (row.status === 'paused') {
      const resumed = this.transition(input.idempotencyKey, 'running');
      if (resumed.status === 'blocked') return resumed;
      try {
        const output = await executor();
        this.transition(input.idempotencyKey, 'succeeded', output);
        try {
          await this.audit.append({ type: 'autonomy.action.result', actionId: input.actionId, ownerId: input.ownerId, actor: input.actor, status: 'succeeded', code: 'SUCCEEDED' });
        } catch (error) {
          this.transition(input.idempotencyKey, 'unknown', output);
          return { status: 'UNKNOWN', code: error.code ?? 'AUDIT_WRITE_FAILED' };
        }
        return { status: 'succeeded', code: 'SUCCEEDED', output };
      } catch (error) {
        const next = error?.unknown ? 'unknown' : 'failed';
        this.transition(input.idempotencyKey, next);
        try {
          await this.audit.append({ type: error?.unknown ? 'autonomy.action.unknown' : 'autonomy.action.result', actionId: input.actionId, ownerId: input.ownerId, actor: input.actor, status: next, code: error?.unknown ? 'EXTERNAL_RESULT_UNKNOWN' : 'EXECUTION_FAILED' });
        } catch (auditError) {
          this.transition(input.idempotencyKey, 'unknown');
          return { status: 'UNKNOWN', code: auditError.code ?? 'AUDIT_WRITE_FAILED' };
        }
        return { status: error?.unknown ? 'UNKNOWN' : 'failed', code: error?.unknown ? 'EXTERNAL_RESULT_UNKNOWN' : 'EXECUTION_FAILED' };
      }
    }
    return this.#public(row, true);
  }

  async recover(input, executor) {
    const key = input?.idempotencyKey;
    const existingWork = this.inFlight.get(key);
    if (existingWork) {
      const checked = contextValid(input);
      if (checked.error) return fail(checked.error);
      return this.inFlightFingerprints.get(key) === digest(checked.fingerprint)
        ? existingWork
        : fail('IDEMPOTENCY_KEY_CONFLICT');
    }
    const checked = contextValid(input);
    const work = this.#recoverUnlocked(input, executor);
    this.inFlightFingerprints.set(key, checked.error ? null : digest(checked.fingerprint));
    this.inFlight.set(key, work);
    try { return await work; } finally {
      this.inFlight.delete(key);
      this.inFlightFingerprints.delete(key);
    }
  }
}
