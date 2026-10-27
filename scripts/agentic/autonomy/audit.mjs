import { COMPLETION_EVENT_TYPES, normalizeActorProvenance } from './actor-model-boundary.mjs';

const EVENT_TYPES = Object.freeze({
  grantIssued: 'autonomy.grant.issued',
  grantConsumed: 'autonomy.grant.consumed',
  grantRevoked: 'autonomy.grant.revoked',
  policyDenied: 'autonomy.policy.denied',
  confirmationIssued: 'autonomy.confirmation.issued',
  confirmationConsumed: 'autonomy.confirmation.consumed',
  confirmationRejected: 'autonomy.confirmation.rejected',
  action: (phase) => `autonomy.action.${phase}`,
  unknown: 'autonomy.action.unknown',
  recovery: 'autonomy.recovery',
});

function auditError() {
  const error = new Error('AUDIT_WRITE_FAILED');
  error.code = 'AUDIT_WRITE_FAILED';
  return error;
}

function eventFor(type, fields = {}) {
  const actor = fields.actor ?? {};
  const { actor: _actor, at, ...rest } = fields;
  let provenance = null;
  if (fields.actor !== undefined) {
    try { provenance = normalizeActorProvenance(actor); } catch (error) {
      provenance = {
        status: 'UNKNOWN',
        code: error.code ?? 'ACTOR_MODEL_UNKNOWN',
        actorId: actor.actorId ?? null,
        resolvedModel: null,
      };
    }
  }
  const unknownActor = provenance?.status !== 'RESOLVED';
  const completionEvent = COMPLETION_EVENT_TYPES.includes(type);
  return {
    ...rest,
    type,
    actorId: rest.actorId ?? provenance?.actorId ?? actor.actorId ?? null,
    modelProvider: rest.modelProvider ?? provenance?.modelProvider ?? actor.modelProvider ?? null,
    requestedModel: rest.requestedModel ?? provenance?.requestedModel ?? actor.requestedModel ?? null,
    resolvedModel: rest.resolvedModel ?? provenance?.resolvedModel ?? actor.resolvedModel ?? null,
    actorStatus: rest.actorStatus ?? provenance?.status ?? null,
    status: unknownActor && completionEvent ? 'UNKNOWN' : (rest.status ?? (type.endsWith('.unknown') ? 'UNKNOWN' : undefined)),
    code: unknownActor && completionEvent ? 'ACTOR_MODEL_UNKNOWN' : rest.code,
    at: at ?? new Date().toISOString(),
  };
}

export class AuditLog {
  constructor({ writer } = {}) {
    this.events = [];
    this.failed = false;
    this.available = true;
    this.writer = writer ?? (async (event) => { this.events.push(event); });
  }

  async append(event) {
    if (this.failed) throw auditError();
    const normalized = eventFor(event.type, event);
    try {
      await this.writer(normalized);
      return normalized;
    } catch (cause) {
      this.failed = true;
      this.available = false;
      const error = auditError();
      error.cause = cause;
      throw error;
    }
  }

  grantIssued(fields) { return this.append(eventFor(EVENT_TYPES.grantIssued, fields)); }
  grantConsumed(fields) { return this.append(eventFor(EVENT_TYPES.grantConsumed, fields)); }
  grantRevoked(fields) { return this.append(eventFor(EVENT_TYPES.grantRevoked, fields)); }
  policyDenied(fields) { return this.append(eventFor(EVENT_TYPES.policyDenied, fields)); }
  confirmationIssued(fields) { return this.append(eventFor(EVENT_TYPES.confirmationIssued, fields)); }
  confirmationConsumed(fields) { return this.append(eventFor(EVENT_TYPES.confirmationConsumed, fields)); }
  confirmationRejected(fields) { return this.append(eventFor(EVENT_TYPES.confirmationRejected, fields)); }
  action(fields) { return this.append(eventFor(EVENT_TYPES.action(fields.phase ?? 'result'), fields)); }
  unknown(fields) { return this.append(eventFor(EVENT_TYPES.unknown, fields)); }
  recovery(fields) { return this.append(eventFor(EVENT_TYPES.recovery, fields)); }
}

export function createDatabaseAuditWriter(db) {
  const insert = db.prepare(`
    INSERT INTO autonomy_audit_events
      (event_type, owner_id, action_id, grant_id, actor_id, model_provider,
       resolved_model, contract_hash, status, code, reason, payload_json, occurred_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  return async (event) => {
    insert.run(
      event.type, event.ownerId ?? null, event.actionId ?? null, event.grantId ?? null,
      event.actorId ?? null, event.modelProvider ?? null, event.resolvedModel ?? null,
      event.contractHash ?? null, event.status ?? null, event.code ?? null,
      event.reason ?? null, JSON.stringify(event), event.at,
    );
  };
}

export { EVENT_TYPES };
