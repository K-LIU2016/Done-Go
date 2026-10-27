export const AUTONOMY_LEVELS = Object.freeze(['A0', 'A1', 'A2', 'A3', 'A4', 'A5']);
export const ACTION_RISKS = Object.freeze(['observe', 'suggest', 'prepare', 'reversible', 'external', 'financial']);
export const P0_BLOCKED_RISKS = Object.freeze(['external', 'financial']);
export const P0_BLOCKED_AUTONOMY = Object.freeze(['A4', 'A5']);

export const DECISION_CODES = Object.freeze({
  ALLOWED: 'ALLOWED',
  CONTRACT_REQUIRED: 'CONTRACT_REQUIRED',
  CONTRACT_INVALID: 'CONTRACT_INVALID',
  GRANT_REQUIRED: 'GRANT_REQUIRED',
  GRANT_INACTIVE: 'GRANT_INACTIVE',
  GRANT_OWNER_MISMATCH: 'GRANT_OWNER_MISMATCH',
  GRANT_EXPIRED: 'GRANT_EXPIRED',
  GRANT_CONTRACT_MISMATCH: 'GRANT_CONTRACT_MISMATCH',
  OWNER_MISMATCH: 'OWNER_MISMATCH',
  WONT_IMMUTABLE: 'WONT_IMMUTABLE',
  SCOPE_DENIED: 'SCOPE_DENIED',
  AUTONOMY_TOO_HIGH: 'AUTONOMY_TOO_HIGH',
  AUTONOMY_TOO_LOW: 'AUTONOMY_TOO_LOW',
  A4_CONFIRMATION_REQUIRED: 'A4_CONFIRMATION_REQUIRED',
  P0_EXTERNAL_EFFECT_BLOCKED: 'P0_EXTERNAL_EFFECT_BLOCKED',
  A5_NEVER_AUTOMATIC: 'A5_NEVER_AUTOMATIC',
  ACTOR_MODEL_UNKNOWN: 'ACTOR_MODEL_UNKNOWN',
});

export const RESULT_CODES = Object.freeze({
  SUCCEEDED: 'SUCCEEDED',
  EXECUTION_FAILED: 'EXECUTION_FAILED',
  EXTERNAL_RESULT_UNKNOWN: 'EXTERNAL_RESULT_UNKNOWN',
  AUDIT_WRITE_FAILED: 'AUDIT_WRITE_FAILED',
  CONFIRMATION_REPLAY: 'CONFIRMATION_REPLAY',
  CONFIRMATION_BINDING_MISMATCH: 'CONFIRMATION_BINDING_MISMATCH',
  CONFIRMATION_EXPIRED: 'CONFIRMATION_EXPIRED',
});

const fail = (code, message = code) => {
  const error = new Error(message);
  error.code = code;
  throw error;
};

export function normalizeAutonomyLevel(value) {
  if (!AUTONOMY_LEVELS.includes(value)) fail('AUTONOMY_LEVEL_INVALID');
  return value;
}

export function normalizeActionRisk(value) {
  if (!ACTION_RISKS.includes(value)) fail('AUTONOMY_ACTION_INVALID');
  return value;
}

export function isP0Forbidden({ risk, requestedAutonomy } = {}) {
  return P0_BLOCKED_RISKS.includes(risk) || P0_BLOCKED_AUTONOMY.includes(requestedAutonomy);
}

export function normalizeActor(actor = {}) {
  if (typeof actor.actorId !== 'string' || !actor.actorId) fail('ACTOR_INVALID');
  if (actor.modelProvider != null && typeof actor.modelProvider !== 'string') fail('ACTOR_PROVIDER_INVALID');
  if (actor.resolvedModel == null || actor.resolvedModel === '') {
    return { actorId: actor.actorId, resolvedModel: null, modelProvider: actor.modelProvider ?? null, status: 'UNKNOWN', code: 'ACTOR_MODEL_UNKNOWN' };
  }
  if (typeof actor.resolvedModel !== 'string') fail('ACTOR_MODEL_INVALID');
  return { actorId: actor.actorId, resolvedModel: actor.resolvedModel, modelProvider: actor.modelProvider ?? null, status: 'RESOLVED', code: 'ACTOR_MODEL_RESOLVED' };
}

export function normalizeAction(action = {}) {
  return { risk: normalizeActionRisk(action.risk), requestedAutonomy: normalizeAutonomyLevel(action.requestedAutonomy) };
}

export function errorResult(status, code, extra = {}) {
  return { status, code, requiresConfirmation: false, ...extra };
}

export { fail };

// P0 policy is intentionally represented as data so all callers share one boundary.
