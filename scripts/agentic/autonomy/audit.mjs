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

function eventFor(type, fields = {}, clock = () => new Date()) {
  const actor = fields.actor ?? {};
  const clockValue = clock();
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
    at: at ?? (clockValue instanceof Date ? clockValue.toISOString() : clockValue),
  };
}

export class AuditLog {
  constructor({ writer, clock = () => new Date() } = {}) {
    this.events = [];
    this.failed = false;
    this.available = true;
    this.clock = clock;
    this.writer = writer ?? (async (event) => { this.events.push(event); });
  }

  async append(event) {
    if (this.failed) throw auditError();
    const normalized = eventFor(event.type, event, this.clock);
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

  grantIssued(fields) { return this.append(eventFor(EVENT_TYPES.grantIssued, fields, this.clock)); }
  grantConsumed(fields) { return this.append(eventFor(EVENT_TYPES.grantConsumed, fields, this.clock)); }
  grantRevoked(fields) { return this.append(eventFor(EVENT_TYPES.grantRevoked, fields, this.clock)); }
  policyDenied(fields) { return this.append(eventFor(EVENT_TYPES.policyDenied, fields, this.clock)); }
  confirmationIssued(fields) { return this.append(eventFor(EVENT_TYPES.confirmationIssued, fields, this.clock)); }
  confirmationConsumed(fields) { return this.append(eventFor(EVENT_TYPES.confirmationConsumed, fields, this.clock)); }
  confirmationRejected(fields) { return this.append(eventFor(EVENT_TYPES.confirmationRejected, fields, this.clock)); }
  action(fields) { return this.append(eventFor(EVENT_TYPES.action(fields.phase ?? 'result'), fields, this.clock)); }
  unknown(fields) { return this.append(eventFor(EVENT_TYPES.unknown, fields, this.clock)); }
  recovery(fields) { return this.append(eventFor(EVENT_TYPES.recovery, fields, this.clock)); }
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
