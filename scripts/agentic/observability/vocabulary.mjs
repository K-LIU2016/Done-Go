/**
 * W10 observability vocabulary.
 *
 * Single source of truth for attribute keys, enums mirrored from the frozen W0
 * contracts, and the provenance rules that decide whether an actor's model is a
 * verifiable fact. Nothing here mutates W0: `contracts/agentic/**` stays frozen
 * and every enum below is kept honest by `vocabulary.test.mjs` drift checks.
 */

/** Sentinel used everywhere a value is genuinely not known. Never rendered as 0. */
export const UNKNOWN = 'UNKNOWN';

/** BRIEF §3 actor roster. Order is stable because reports print it. */
export const ACTOR_ROLES = Object.freeze([
  'conductor',
  'block_agent',
  'worker',
  'verifier',
  'reviewer',
  'fixer',
]);

/**
 * Where an actor's model name came from. Only `gateway` and `local` are runtime
 * truth; `mock`, `fixture` and `unknown` can never prove end-to-end success.
 */
export const MODEL_SOURCES = Object.freeze(['fixture', 'gateway', 'local', 'mock', 'unknown']);
export const VERIFIABLE_MODEL_SOURCES = Object.freeze(['gateway', 'local']);

/** Provenance verdict for a single actor. `UNKNOWN` doubles as the sentinel value. */
export const PROVENANCE = Object.freeze({ RESOLVED: 'RESOLVED', UNKNOWN });

/**
 * The only sanctioned extension point in the frozen contracts: `span.attributes`
 * is a free-form object; every other top-level field is additionalProperties:false.
 * Keys are namespaced `gen_ai.` (OTel GenAI) or `donego.`.
 */
export const ATTRIBUTE_KEYS = Object.freeze({
  agentName: 'gen_ai.agent.name',
  requestModel: 'gen_ai.request.model',
  responseModel: 'gen_ai.response.model',
  actorRole: 'donego.actor.role',
  actorModel: 'donego.actor.model',
  resolvedModel: 'donego.model.resolved',
  modelSource: 'donego.model.source',
  modelLocal: 'donego.model.local',
  missionId: 'donego.mission.id',
  contractHash: 'donego.contract.hash',
  workOrderId: 'donego.work_order.id',
  runId: 'donego.run.id',
  stepId: 'donego.step.id',
  gateStream: 'donego.gate.stream',
  gateName: 'donego.gate.name',
});

// Mirrors of the frozen W0 enums. `vocabulary.test.mjs` asserts equality against
// the live schema files, so drift is a test failure rather than a silent skew.
export const SPAN_KINDS = Object.freeze(['invoke_agent', 'execute_tool', 'chat', 'donego.need']);
export const SPAN_STATUSES = Object.freeze(['running', 'ok', 'error']);
export const RUN_STATES = Object.freeze([
  'queued',
  'running',
  'verifying',
  'succeeded',
  'partial',
  'failed',
  'unknown',
  'cancelled',
]);
export const STEP_KINDS = Object.freeze(['plan', 'schedule', 'execute', 'verify', 'merge']);
export const STEP_STATES = Object.freeze([
  'pending',
  'running',
  'succeeded',
  'failed',
  'paused',
  'skipped',
]);

/** Frozen W0 API error codes (api-error.schema.json). */
export const API_ERROR_CODES = Object.freeze([
  'AUTH_REQUIRED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONTRACT_INVALID',
  'CONFLICT',
  'RATE_LIMITED',
  'BUDGET_EXCEEDED',
  'NEED_HUMAN',
  'UPSTREAM_UNAVAILABLE',
  'INTERNAL_ERROR',
]);

/**
 * Observability-internal rejection codes. These are thrown locally, carry no
 * HTTP status and never leak upstream credentials.
 */
export const OBS_ERROR_CODES = Object.freeze({
  ACTOR_INVALID: 'ACTOR_INVALID',
  ACTOR_ROLE_INVALID: 'ACTOR_ROLE_INVALID',
  CACHE_KEY_INCOMPLETE: 'CACHE_KEY_INCOMPLETE',
  CACHE_UNVERIFIABLE: 'CACHE_UNVERIFIABLE',
  CONTRACT_INVALID: 'CONTRACT_INVALID',
  GATE_INCOMPLETE: 'GATE_INCOMPLETE',
  ID_OWNER_MISMATCH: 'ID_OWNER_MISMATCH',
  INVALID_ARGUMENT: 'INVALID_ARGUMENT',
  MATRIX_INCOMPLETE: 'MATRIX_INCOMPLETE',
  MODEL_SOURCE_INVALID: 'MODEL_SOURCE_INVALID',
  OWNER_REQUIRED: 'OWNER_REQUIRED',
  PROVENANCE_CONFLICT: 'PROVENANCE_CONFLICT',
  PROVENANCE_UNRESOLVED: 'PROVENANCE_UNRESOLVED',
  REPORT_EXISTS: 'REPORT_EXISTS',
  RUN_NOT_VERIFIABLE: 'RUN_NOT_VERIFIABLE',
  RUN_STATE_INVALID: 'RUN_STATE_INVALID',
  SPAN_OWNER_MISMATCH: 'SPAN_OWNER_MISMATCH',
});

export function observabilityError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = details ?? {};
  return error;
}

export function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Validate the minimum a gate must carry before it can be recorded (N5).
 *
 * A gate without a command or without an exit code proves nothing, and a gate
 * without a head cannot be attributed to a commit. All three are rejections,
 * not defaults.
 */
export function validateGate(gate) {
  if (gate === null || typeof gate !== 'object' || Array.isArray(gate)) {
    throw observabilityError(OBS_ERROR_CODES.GATE_INCOMPLETE, 'gate must be an object');
  }
  const missing = ['stream', 'name', 'head', 'command'].filter((field) => !isNonEmptyString(gate[field]));
  if (missing.length > 0) {
    throw observabilityError(
      OBS_ERROR_CODES.GATE_INCOMPLETE,
      `gate is missing ${missing.join(', ')}`,
      { missing },
    );
  }
  if (!Number.isInteger(gate.rc)) {
    throw observabilityError(
      OBS_ERROR_CODES.GATE_INCOMPLETE,
      'gate must carry an integer rc',
      { rc: gate.rc ?? null },
    );
  }
  for (const field of ['passed', 'failed', 'skipped']) {
    const value = gate[field];
    if (value !== undefined && value !== null && !Number.isInteger(value)) {
      throw observabilityError(
        OBS_ERROR_CODES.GATE_INCOMPLETE,
        `gate ${field} must be an integer`,
        { field },
      );
    }
  }
  return gate;
}

function trimmedOrNull(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Normalize one actor declaration.
 *
 * Hard rules (red line 7, BRIEF §3):
 *  - a missing or blank `model` yields `model = null`, provenance `UNKNOWN`,
 *    reason `MODEL_MISSING`, and is never backfilled from anything else;
 *  - the second argument is accepted and deliberately ignored, so a caller
 *    cannot accidentally inherit a neighbour's model;
 *  - `modelSource` outside the enum throws instead of being coerced.
 */
export function normalizeActor(actor, _neighbour) {
  if (actor === null || typeof actor !== 'object' || Array.isArray(actor)) {
    throw observabilityError(OBS_ERROR_CODES.ACTOR_INVALID, 'actor must be an object');
  }
  const role = trimmedOrNull(actor.role);
  if (role === null || !ACTOR_ROLES.includes(role)) {
    throw observabilityError(
      OBS_ERROR_CODES.ACTOR_ROLE_INVALID,
      `actor role must be one of ${ACTOR_ROLES.join(', ')}`,
      { role: actor.role ?? null },
    );
  }

  const model = trimmedOrNull(actor.model);
  const rawSource = actor.modelSource;
  if (rawSource !== undefined && rawSource !== null && !MODEL_SOURCES.includes(rawSource)) {
    throw observabilityError(
      OBS_ERROR_CODES.MODEL_SOURCE_INVALID,
      `modelSource must be one of ${MODEL_SOURCES.join(', ')}`,
      { role, modelSource: rawSource },
    );
  }
  const modelSource = model === null ? 'unknown' : rawSource ?? 'unknown';
  const resolved = model !== null;
  const verifiable = resolved && VERIFIABLE_MODEL_SOURCES.includes(modelSource);

  return {
    role,
    model,
    modelSource,
    provenance: resolved ? PROVENANCE.RESOLVED : PROVENANCE.UNKNOWN,
    verifiable,
    unresolvedReason: resolved ? null : 'MODEL_MISSING',
  };
}
