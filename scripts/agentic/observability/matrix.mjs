/**
 * W10 batch acceptance matrix (pure data).
 *
 * One row per delivery stream, with the only columns a reviewer can re-check:
 * HEAD, contract relation, gate results, end-to-end evidence, push outcome,
 * review/fix actor models and residual risks. Status is derived, never
 * declared, and follows the same one-way ladder as `bundle.mjs`:
 *
 *   BLOCKED > UNKNOWN > PROVISIONAL > VERIFIED
 *
 * Two traps this file exists to avoid (BRIEF §3): a stream proven only by unit
 * tests is PROVISIONAL at best (N13), and a review actor with no resolved model
 * is PROVISIONAL with `resolvedModel: null` — never silently counted as a real
 * review (N14).
 */

import { UNKNOWN, isNonEmptyString, normalizeActor, observabilityError, OBS_ERROR_CODES } from './vocabulary.mjs';
import { assessGate } from './gates.mjs';
import { verdictFor } from './bundle.mjs';

export const MATRIX_STATUS = Object.freeze({
  VERIFIED: 'VERIFIED',
  PROVISIONAL: 'PROVISIONAL',
  UNKNOWN: 'UNKNOWN',
  BLOCKED: 'BLOCKED',
});

const CODE = Object.freeze({
  SINGLE_TEST_ONLY: 'SINGLE_TEST_ONLY',
  REVIEW_MODEL_UNRESOLVED: 'REVIEW_MODEL_UNRESOLVED',
  REVIEW_NOT_VERIFIABLE: 'REVIEW_NOT_VERIFIABLE',
  GATE_FAILED: 'GATE_FAILED',
  GATE_INCOMPLETE: 'GATE_INCOMPLETE',
  E2E_EVIDENCE_MISSING: 'E2E_EVIDENCE_MISSING',
  CONTRACT_DRIFT: 'CONTRACT_DRIFT',
  CONTRACT_UNKNOWN: 'CONTRACT_UNKNOWN',
  PUSH_UNCONFIRMED: 'PUSH_UNCONFIRMED',
  RISK_OPEN: 'RISK_OPEN',
});

const SEVERITY = Object.freeze({ BLOCKED: 'BLOCKED', UNKNOWN: 'UNKNOWN', PROVISIONAL: 'PROVISIONAL' });

/** Gate kinds or names that can count as an end-to-end (non-unit) check. */
const E2E_HINTS = /^(web|e2e|playwright|browser)$|verify:web|playwright|\.spec\./i;

function isE2EGate(gate) {
  const kind = String(gate?.kind ?? '');
  const name = String(gate?.name ?? '');
  return E2E_HINTS.test(kind) || E2E_HINTS.test(name);
}

function assertStream(stream) {
  if (!isNonEmptyString(stream?.stream)) {
    throw observabilityError(OBS_ERROR_CODES.MATRIX_INCOMPLETE, 'every stream needs a non-empty name', { stream: stream?.stream ?? null });
  }
  if (!isNonEmptyString(stream?.head)) {
    throw observabilityError(OBS_ERROR_CODES.MATRIX_INCOMPLETE, `stream ${stream.stream} needs a head`, { stream: stream.stream });
  }
  if (!Array.isArray(stream?.gates)) {
    throw observabilityError(OBS_ERROR_CODES.MATRIX_INCOMPLETE, `stream ${stream.stream} needs a gates array`, { stream: stream.stream });
  }
  return stream;
}

function gateUnknowns(gates) {
  const unknowns = [];
  for (const gate of gates) {
    if (!isNonEmptyString(gate?.name) || !Number.isInteger(gate?.rc)) {
      unknowns.push({ code: CODE.GATE_INCOMPLETE, severity: SEVERITY.UNKNOWN, gate: gate?.name ?? null });
      continue;
    }
    const assessment = assessGate(gate);
    if (!assessment.passed) {
      unknowns.push({ code: CODE.GATE_FAILED, severity: SEVERITY.BLOCKED, gate: gate.name, rc: gate.rc, failed: gate.failed ?? 0 });
    } else if (assessment.evidenceStatus === 'UNKNOWN') {
      unknowns.push({ code: CODE.GATE_INCOMPLETE, severity: SEVERITY.UNKNOWN, gate: gate.name, reason: 'NO_EVIDENCE' });
    } else if (assessment.evidenceStatus === 'PROVISIONAL') {
      unknowns.push({ code: CODE.GATE_INCOMPLETE, severity: SEVERITY.PROVISIONAL, gate: gate.name, reason: 'UNTYPED_EVIDENCE' });
    }
  }
  return unknowns;
}

function webUnknowns(stream) {
  const unknowns = [];
  const web = stream.web;
  const hasE2EGate = stream.gates.some(isE2EGate);
  const webHasRc = web !== undefined && web !== null && Number.isInteger(web.rc);

  if (!webHasRc && !hasE2EGate) {
    unknowns.push({ code: CODE.SINGLE_TEST_ONLY, severity: SEVERITY.PROVISIONAL, reason: 'UNIT_TESTS_ONLY' });
  }
  if (web === undefined || web === null) return unknowns;

  if (!isNonEmptyString(web.command) || !Number.isInteger(web.rc)) {
    unknowns.push({ code: CODE.E2E_EVIDENCE_MISSING, severity: SEVERITY.UNKNOWN, reason: 'NO_RC' });
    return unknowns;
  }
  if (web.rc !== 0 || (Number.isInteger(web.failed) && web.failed > 0)) {
    unknowns.push({ code: CODE.GATE_FAILED, severity: SEVERITY.BLOCKED, gate: 'verify:web', rc: web.rc });
  }
  return unknowns;
}

function contractUnknowns(stream, frozen) {
  if (!isNonEmptyString(stream.contractCommit)) {
    return [{ code: CODE.CONTRACT_UNKNOWN, severity: SEVERITY.UNKNOWN, expected: frozen.commit }];
  }
  if (stream.contractCommit !== frozen.commit) {
    return [{ code: CODE.CONTRACT_DRIFT, severity: SEVERITY.BLOCKED, expected: frozen.commit, actual: stream.contractCommit }];
  }
  return [];
}

function pushUnknowns(stream) {
  const push = stream.push;
  if (push?.pushed === true && (push.rc === undefined || push.rc === 0)) return [];
  return [
    {
      code: CODE.PUSH_UNCONFIRMED,
      severity: SEVERITY.UNKNOWN,
      ref: push?.ref ?? null,
      rc: push?.rc ?? null,
    },
  ];
}

function riskUnknowns(risks) {
  const unknowns = [];
  for (const risk of Array.isArray(risks) ? risks : []) {
    if (risk?.status !== 'open') continue;
    const high = String(risk.severity ?? '').toUpperCase() === 'HIGH' || String(risk.severity ?? '').toUpperCase() === 'CRITICAL';
    unknowns.push({
      code: CODE.RISK_OPEN,
      severity: high ? SEVERITY.BLOCKED : SEVERITY.PROVISIONAL,
      id: risk.id ?? null,
      severityLabel: risk.severity ?? null,
    });
  }
  return unknowns;
}

/**
 * Normalize one actor list into matrix-facing review models.
 *
 * A missing model is carried through as `resolvedModel: null` on purpose: the
 * report renders it literally as `resolved_model=NULL` so a reader can tell an
 * unresolved actor from a blank cell.
 */
function reviewModels(actors, unknowns) {
  const models = [];
  for (const raw of Array.isArray(actors) ? actors : []) {
    const actor = normalizeActor(raw);
    models.push({
      role: actor.role,
      model: actor.model,
      modelSource: actor.modelSource,
      resolvedModel: actor.model,
      verifiable: actor.verifiable,
    });
    if (actor.provenance === UNKNOWN) {
      unknowns.push({
        code: CODE.REVIEW_MODEL_UNRESOLVED,
        // Red line 7: a NULL resolved_model is UNKNOWN, never a completion.
        severity: SEVERITY.UNKNOWN,
        role: actor.role,
        resolvedModel: null,
        reason: actor.unresolvedReason,
      });
    } else if (!actor.verifiable) {
      unknowns.push({
        code: CODE.REVIEW_NOT_VERIFIABLE,
        severity: SEVERITY.PROVISIONAL,
        role: actor.role,
        modelSource: actor.modelSource,
      });
    }
  }
  return models;
}

function deriveRow(stream, frozen) {
  assertStream(stream);
  const unknowns = [
    ...gateUnknowns(stream.gates),
    ...webUnknowns(stream),
    ...contractUnknowns(stream, frozen),
    ...pushUnknowns(stream),
    ...riskUnknowns(stream.risks),
  ];
  const models = [
    ...reviewModels(stream.reviewActors, unknowns),
    ...reviewModels(stream.fixActors, unknowns),
  ];

  return {
    stream: stream.stream,
    head: stream.head,
    contractCommit: stream.contractCommit ?? null,
    contractRelation: stream.contractRelation ?? (stream.contractCommit === frozen.commit ? 'matches' : 'unknown'),
    status: verdictFor(unknowns),
    unknowns,
    reviewModels: models,
    risks: (Array.isArray(stream.risks) ? stream.risks : []).map((risk) => ({ ...risk })),
    gates: stream.gates.map((gate) => ({
      name: gate?.name ?? null,
      kind: gate?.kind ?? null,
      command: gate?.command ?? null,
      rc: gate?.rc ?? null,
      passed: gate?.passed ?? null,
      failed: gate?.failed ?? null,
      skipped: gate?.skipped ?? null,
    })),
    web: stream.web ?? null,
    push: stream.push ?? null,
  };
}

/**
 * Build the matrix from already-collected stream data.
 *
 * Structurally incomplete input is refused rather than guessed at: a stream
 * without a head or without gates cannot be placed in an acceptance matrix.
 */
export function createMatrix({ ownerId, frozen, generatedAt, streams } = {}) {
  if (!isNonEmptyString(ownerId)) {
    throw observabilityError(OBS_ERROR_CODES.OWNER_REQUIRED, 'an explicit ownerId is required');
  }
  if (!frozen || !isNonEmptyString(frozen.commit)) {
    throw observabilityError(OBS_ERROR_CODES.MATRIX_INCOMPLETE, 'a frozen baseline commit is required');
  }
  if (!Array.isArray(streams)) {
    throw observabilityError(OBS_ERROR_CODES.MATRIX_INCOMPLETE, 'streams must be an array');
  }

  const seen = new Set();
  for (const stream of streams) {
    assertStream(stream);
    if (seen.has(stream.stream)) {
      throw observabilityError(OBS_ERROR_CODES.MATRIX_INCOMPLETE, `duplicate stream ${stream.stream}`, { stream: stream.stream });
    }
    seen.add(stream.stream);
  }

  const rows = streams.map((stream) => deriveRow(stream, frozen));
  const counts = { verified: 0, provisional: 0, unknown: 0, blocked: 0 };
  for (const row of rows) {
    if (row.status === MATRIX_STATUS.VERIFIED) counts.verified += 1;
    else if (row.status === MATRIX_STATUS.PROVISIONAL) counts.provisional += 1;
    else if (row.status === MATRIX_STATUS.BLOCKED) counts.blocked += 1;
    else counts.unknown += 1;
  }

  let status;
  if (rows.length === 0) status = MATRIX_STATUS.UNKNOWN;
  else if (counts.blocked > 0) status = MATRIX_STATUS.BLOCKED;
  else if (counts.unknown > 0) status = MATRIX_STATUS.UNKNOWN;
  else if (counts.provisional > 0) status = MATRIX_STATUS.PROVISIONAL;
  else status = MATRIX_STATUS.VERIFIED;

  return {
    ownerId,
    frozen: { version: frozen.version ?? null, commit: frozen.commit },
    generatedAt: generatedAt ?? new Date().toISOString(),
    rows,
    summary: { total: rows.length, ...counts, status },
  };
}
