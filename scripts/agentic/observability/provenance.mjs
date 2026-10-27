/**
 * W10 actor/model provenance gate (red line 7, BRIEF §3).
 *
 * An actor's model is a fact only when the actor itself declared it. This module
 * refuses to infer it from a neighbour, a request model, a previous run or a
 * default. A roster that still contains an unresolved actor cannot complete a
 * run, and a roster proven only by mock or fixture calls is never VERIFIED.
 */

import {
  normalizeActor,
  observabilityError,
  PROVENANCE,
  OBS_ERROR_CODES,
} from './vocabulary.mjs';

/** Terminal run states that may legitimately follow a verified roster. */
const COMPLETABLE_STATES = Object.freeze(['succeeded', 'partial', 'unknown']);

const EVIDENCE_STATUS = Object.freeze({
  VERIFIED: 'VERIFIED',
  PROVISIONAL: 'PROVISIONAL',
  UNKNOWN: 'UNKNOWN',
});

/**
 * Normalize one actor and insist that its model is resolved *and* verifiable.
 * `modelSource: 'mock' | 'fixture'` resolves the name but cannot prove a call,
 * so it is rejected here with an explicit reason.
 */
export function assertActorResolved(actor) {
  const normalized = normalizeActor(actor);
  if (normalized.model === null) {
    throw observabilityError(
      OBS_ERROR_CODES.PROVENANCE_UNRESOLVED,
      `actor ${normalized.role} has no resolved model`,
      { role: normalized.role, reason: 'MODEL_MISSING' },
    );
  }
  if (!normalized.verifiable) {
    throw observabilityError(
      OBS_ERROR_CODES.PROVENANCE_UNRESOLVED,
      `actor ${normalized.role} model source ${normalized.modelSource} is not verifiable`,
      { role: normalized.role, reason: 'MODEL_SOURCE_UNVERIFIABLE', modelSource: normalized.modelSource },
    );
  }
  return normalized;
}

/**
 * Check a whole roster. Every unresolved actor is reported at once so a caller
 * fixes the full set rather than discovering them one per retry.
 */
export function assertActorsResolved(actors) {
  const list = Array.isArray(actors) ? actors : [];
  const normalized = list.map((actor) => normalizeActor(actor));
  const unresolved = normalized.filter((actor) => !actor.verifiable);
  if (unresolved.length > 0) {
    throw observabilityError(
      OBS_ERROR_CODES.PROVENANCE_UNRESOLVED,
      `unresolved actors: ${unresolved.map((actor) => actor.role).join(', ')}`,
      {
        unresolvedRoles: unresolved.map((actor) => actor.role),
        reasons: unresolved.map((actor) => ({
          role: actor.role,
          reason: actor.unresolvedReason ?? 'MODEL_SOURCE_UNVERIFIABLE',
        })),
      },
    );
  }
  return normalized;
}

function evidenceStatusFor(summary) {
  if (summary.total === 0) return EVIDENCE_STATUS.UNKNOWN;
  if (summary.unknown > 0) return EVIDENCE_STATUS.UNKNOWN;
  if (summary.verifiable === summary.total) return EVIDENCE_STATUS.VERIFIED;
  return EVIDENCE_STATUS.PROVISIONAL;
}

/** Count a roster without throwing: unknown actors become a reported fact. */
export function summarizeProvenance(actors) {
  const normalized = (Array.isArray(actors) ? actors : []).map((actor) => normalizeActor(actor));
  const summary = {
    total: normalized.length,
    resolved: normalized.filter((actor) => actor.provenance === PROVENANCE.RESOLVED).length,
    unknown: normalized.filter((actor) => actor.provenance === PROVENANCE.UNKNOWN).length,
    verifiable: normalized.filter((actor) => actor.verifiable).length,
    mock: normalized.filter((actor) => actor.modelSource === 'mock').length,
    unresolvedRoles: normalized
      .filter((actor) => actor.provenance === PROVENANCE.UNKNOWN)
      .map((actor) => actor.role),
  };
  summary.evidenceStatus = evidenceStatusFor(summary);
  return summary;
}

/**
 * Complete a run only if every actor declared a model.
 *
 * The gate is on *existence* of a model, not on its verifiability: a mock or
 * fixture roster is a real roster that simply cannot prove an end-to-end call,
 * so it completes with `PROVISIONAL` evidence instead of being rejected. Only a
 * missing model is fatal (N2), and the input run object is never mutated, so a
 * rejected claim cannot half-apply.
 */
export function markRunComplete({ run, actors, state = 'succeeded' } = {}) {
  const source = run && typeof run === 'object' ? run : {};
  const targetState = state ?? 'succeeded';
  if (!COMPLETABLE_STATES.includes(targetState)) {
    throw observabilityError(
      OBS_ERROR_CODES.RUN_STATE_INVALID,
      `completion state must be one of ${COMPLETABLE_STATES.join(', ')}`,
      { state: targetState },
    );
  }

  const normalized = (Array.isArray(actors) ? actors : []).map((actor) => normalizeActor(actor));
  const missing = normalized.filter((actor) => actor.provenance === PROVENANCE.UNKNOWN);
  if (missing.length > 0) {
    throw observabilityError(
      OBS_ERROR_CODES.RUN_NOT_VERIFIABLE,
      `run cannot complete with unresolved actors: ${missing.map((actor) => actor.role).join(', ')}`,
      { unresolvedRoles: missing.map((actor) => actor.role) },
    );
  }

  const summary = summarizeProvenance(actors);
  const verifiable = summary.evidenceStatus === EVIDENCE_STATUS.VERIFIED;
  return {
    ...source,
    state: targetState,
    provenance: { ...summary, verifiable },
    verifiable,
  };
}

/** Collapse repeated roles; a role declared with two different models is a conflict. */
export function actorRoster(actors) {
  const byRole = new Map();
  for (const actor of Array.isArray(actors) ? actors : []) {
    const normalized = normalizeActor(actor);
    const existing = byRole.get(normalized.role);
    if (!existing) {
      byRole.set(normalized.role, normalized);
      continue;
    }
    if (existing.model !== normalized.model || existing.modelSource !== normalized.modelSource) {
      throw observabilityError(
        OBS_ERROR_CODES.PROVENANCE_CONFLICT,
        `actor ${normalized.role} is declared with conflicting models`,
        {
          role: normalized.role,
          models: [existing.model, normalized.model],
          sources: [existing.modelSource, normalized.modelSource],
        },
      );
    }
  }
  return [...byRole.values()];
}

export { EVIDENCE_STATUS };
