/**
 * W10 run evidence bundle.
 *
 * One function that answers "what, exactly, did this run prove?" by folding the
 * roster, the gates, the web evidence, the metrics, the cache state, the span
 * outcomes and the open review findings into a single verdict. The escalation
 * ladder is one-way (plan §2.4):
 *
 *     BLOCKED  — something demonstrably failed, or an open HIGH finding
 *     UNKNOWN  — a required fact is missing (no rc, unresolved model, cut span)
 *     PROVISIONAL — everything passed, but only via mock/unit/local evidence
 *     VERIFIED — real end-to-end evidence, every actor on a real model
 *
 * Nothing here can upgrade a claim: a mock, a unit test, a cache summary or a
 * parent process being alive is never promoted to end-to-end success. Evidence
 * entries that leave this module must satisfy the frozen W0
 * `evidence.schema.json` (additionalProperties:false), so attribution travels
 * in `detail` — never in smuggled top-level fields.
 */

import { fileURLToPath } from 'node:url';
import { loadSchema, validate } from '../contracts.mjs';
import { UNKNOWN, isNonEmptyString, normalizeActor, observabilityError, OBS_ERROR_CODES } from './vocabulary.mjs';
import { summarizeProvenance } from './provenance.mjs';
import { assessGate } from './gates.mjs';

const CONTRACTS_DIR = fileURLToPath(new URL('../../../contracts/agentic/', import.meta.url));
const EVIDENCE_SCHEMA = 'evidence.schema.json';

export const BUNDLE_STATUS = Object.freeze({
  VERIFIED: 'VERIFIED',
  PROVISIONAL: 'PROVISIONAL',
  UNKNOWN: 'UNKNOWN',
  BLOCKED: 'BLOCKED',
});

export const BUNDLE_UNKNOWN_CODES = Object.freeze({
  ACTOR_UNRESOLVED: 'ACTOR_UNRESOLVED',
  ACTOR_NOT_VERIFIABLE: 'ACTOR_NOT_VERIFIABLE',
  ACTOR_ROSTER_EMPTY: 'ACTOR_ROSTER_EMPTY',
  FINDING_OPEN: 'FINDING_OPEN',
  GATE_FAILED: 'GATE_FAILED',
  GATE_INCOMPLETE: 'GATE_INCOMPLETE',
  E2E_EVIDENCE_MISSING: 'E2E_EVIDENCE_MISSING',
  EVIDENCE_INVALID: 'EVIDENCE_INVALID',
  CACHE_STALE: 'CACHE_STALE',
  CACHE_UNVERIFIABLE: 'CACHE_UNVERIFIABLE',
  SPAN_INCOMPLETE: 'SPAN_INCOMPLETE',
  SPAN_TIMED_OUT: 'SPAN_TIMED_OUT',
  COST_UNKNOWN: 'COST_UNKNOWN',
});

const SEVERITY = Object.freeze({ BLOCKED: 'BLOCKED', UNKNOWN: 'UNKNOWN', PROVISIONAL: 'PROVISIONAL' });
const CODE = BUNDLE_UNKNOWN_CODES;

function missing(value) {
  return value === undefined || value === null || (typeof value === 'string' && value.trim().length === 0);
}

/** A gate that cannot even be assessed is a rejection, not a pass. */
function gateUnknowns(gate) {
  const unknownFields = ['stream', 'name', 'head', 'command'].filter((field) => !isNonEmptyString(gate?.[field]));
  if (unknownFields.length > 0 || !Number.isInteger(gate?.rc)) {
    return [{ code: CODE.GATE_INCOMPLETE, severity: SEVERITY.UNKNOWN, gate: gate?.name ?? null, fields: unknownFields }];
  }
  const assessment = assessGate(gate);
  if (!assessment.passed) {
    return [{ code: CODE.GATE_FAILED, severity: SEVERITY.BLOCKED, gate: gate.name, rc: gate.rc, failed: gate.failed ?? 0 }];
  }
  if (assessment.evidenceStatus === 'UNKNOWN') {
    return [{ code: CODE.GATE_INCOMPLETE, severity: SEVERITY.UNKNOWN, gate: gate.name, reason: 'NO_EVIDENCE' }];
  }
  if (assessment.evidenceStatus === 'PROVISIONAL') {
    return [{ code: CODE.GATE_INCOMPLETE, severity: SEVERITY.PROVISIONAL, gate: gate.name, reason: 'UNTYPED_EVIDENCE' }];
  }
  return [];
}

function webEvidenceUnknowns(webEvidence) {
  if (missing(webEvidence)) {
    // No end-to-end attempt at all: the strongest honest claim is provisional.
    return [{ code: CODE.E2E_EVIDENCE_MISSING, severity: SEVERITY.PROVISIONAL, reason: 'NO_WEB_EVIDENCE' }];
  }
  if (!isNonEmptyString(webEvidence.command) || !Number.isInteger(webEvidence.rc)) {
    return [{ code: CODE.E2E_EVIDENCE_MISSING, severity: SEVERITY.UNKNOWN, reason: 'NO_RC' }];
  }
  if (webEvidence.rc !== 0 || (Number.isInteger(webEvidence.failed) && webEvidence.failed > 0)) {
    return [{ code: CODE.GATE_FAILED, severity: SEVERITY.BLOCKED, gate: 'verify:web', rc: webEvidence.rc }];
  }
  return [];
}

function spanUnknowns(spans) {
  const unknowns = [];
  for (const spanValue of Array.isArray(spans) ? spans : []) {
    if (spanValue?.incomplete === true) {
      const timedOut = spanValue.outcome === 'timed_out';
      unknowns.push({
        code: timedOut ? CODE.SPAN_TIMED_OUT : CODE.SPAN_INCOMPLETE,
        severity: SEVERITY.UNKNOWN,
        id: spanValue.id,
        outcome: spanValue.outcome ?? null,
      });
      continue;
    }
    if (spanValue?.status === 'error') {
      unknowns.push({ code: CODE.SPAN_INCOMPLETE, severity: SEVERITY.BLOCKED, id: spanValue.id, outcome: 'failed' });
    }
  }
  return unknowns;
}

function cacheUnknowns(cache) {
  const unknowns = [];
  for (const entry of Array.isArray(cache?.stale) ? cache.stale : []) {
    unknowns.push({ code: CODE.CACHE_STALE, severity: SEVERITY.PROVISIONAL, key: entry?.key ?? null, reasons: entry?.reasons ?? [] });
  }
  for (const entry of Array.isArray(cache?.unverifiable) ? cache.unverifiable : []) {
    unknowns.push({
      code: CODE.CACHE_UNVERIFIABLE,
      severity: SEVERITY.PROVISIONAL,
      key: entry?.key ?? null,
      modelSource: entry?.modelSource ?? 'unknown',
    });
  }
  return unknowns;
}

function actorUnknowns(actors) {
  const unknowns = [];
  if (!Array.isArray(actors) || actors.length === 0) {
    unknowns.push({ code: CODE.ACTOR_ROSTER_EMPTY, severity: SEVERITY.UNKNOWN });
    return unknowns;
  }
  for (const raw of actors) {
    const actor = normalizeActor(raw);
    if (actor.provenance === UNKNOWN) {
      unknowns.push({ code: CODE.ACTOR_UNRESOLVED, severity: SEVERITY.UNKNOWN, role: actor.role, reason: actor.unresolvedReason });
    } else if (!actor.verifiable) {
      unknowns.push({ code: CODE.ACTOR_NOT_VERIFIABLE, severity: SEVERITY.PROVISIONAL, role: actor.role, modelSource: actor.modelSource });
    }
  }
  return unknowns;
}

function costUnknowns(metrics) {
  const cost = metrics?.cost;
  if (!cost) return [{ code: CODE.COST_UNKNOWN, severity: SEVERITY.PROVISIONAL }];
  const unknown = cost.unknownCost === true || cost.costStatus === 'UNKNOWN' || cost.costCny === UNKNOWN;
  return unknown ? [{ code: CODE.COST_UNKNOWN, severity: SEVERITY.PROVISIONAL, costStatus: cost.costStatus ?? UNKNOWN }] : [];
}

function gateSummary(gates) {
  const list = Array.isArray(gates) ? gates : [];
  let failed = 0;
  let verified = 0;
  let provisional = 0;
  let unknown = 0;
  for (const gate of list) {
    if (!isNonEmptyString(gate?.name) || !Number.isInteger(gate?.rc)) {
      unknown += 1;
      continue;
    }
    const assessment = assessGate(gate);
    if (!assessment.passed) failed += 1;
    else if (assessment.evidenceStatus === 'VERIFIED') verified += 1;
    else if (assessment.evidenceStatus === 'PROVISIONAL') provisional += 1;
    else unknown += 1;
  }
  let status;
  if (list.length === 0) status = 'UNKNOWN';
  else if (failed > 0) status = 'BLOCKED';
  else if (verified === list.length) status = 'VERIFIED';
  else status = 'PROVISIONAL';
  return { total: list.length, failed, verified, provisional, unknown, status };
}

/**
 * Only evidence entries that are actually verified *and* valid against the
 * frozen W0 `evidence.schema.json` travel as evidence (plan §2.1). The frozen
 * contract is additionalProperties:false, so attribution that used to ride in
 * smuggled top-level keys (gate/head, cache key, pass counts) now lives in the
 * schema-legal `detail` field or in the `gates` section. A verified-but-invalid
 * entry — e.g. a mock-marked one carrying a non-schema `source` — is excluded
 * and reported as `EVIDENCE_INVALID`, never silently upgraded (BRIEF §3).
 */
function collectEvidence({ gates, cache, webEvidence }) {
  const schema = loadSchema(EVIDENCE_SCHEMA, CONTRACTS_DIR);
  const evidence = [];
  const invalid = [];
  const travel = (item, origin) => {
    const check = validate(item, schema, { schemaDir: CONTRACTS_DIR });
    if (check.valid) {
      evidence.push(item);
      return;
    }
    invalid.push({
      origin,
      title: isNonEmptyString(item?.title) ? item.title : null,
      errors: (check.errors ?? []).map((entry) => `${entry.path} ${entry.message}`),
    });
  };

  for (const gate of Array.isArray(gates) ? gates : []) {
    for (const item of Array.isArray(gate?.evidence) ? gate.evidence : []) {
      if (item?.verified === true) travel(item, gate.name ?? null);
    }
  }
  for (const entry of Array.isArray(cache?.verified) ? cache.verified : []) {
    // Plan §2.3: content-identical (non-stale) cache entries may enter the
    // verified evidence set; the entry itself remains a *metric about cache
    // state*, never proof of an end-to-end run.
    travel(
      {
        type: 'metric',
        title: `cache:${entry?.kind ?? 'unknown'}`,
        detail: `cache key ${entry?.key ?? 'unknown'} content-identical (${entry?.freshness ?? 'FRESH'})`,
        verified: true,
      },
      'cache',
    );
  }
  if (isNonEmptyString(webEvidence?.command) && webEvidence?.rc === 0) {
    const parts = ['end-to-end rc=0'];
    if (Number.isInteger(webEvidence.passed)) parts.push(`passed ${webEvidence.passed}`);
    if (Number.isInteger(webEvidence.failed)) parts.push(`failed ${webEvidence.failed}`);
    if (Number.isInteger(webEvidence.skipped)) parts.push(`skipped ${webEvidence.skipped}`);
    travel({ type: 'test-run', title: webEvidence.command, detail: parts.join(', '), verified: true }, 'verify:web');
  }
  return { evidence, invalid };
}

/**
 * Plan §2.4, last line: an open HIGH (or CRITICAL) finding blocks the run;
 * any other open finding caps it at PROVISIONAL. Mirrors the stream-level
 * `riskUnknowns` semantics in matrix.mjs — only `status === 'open'` counts,
 * so callers must state resolution explicitly; absence is never guessed.
 */
function findingUnknowns(findings) {
  const unknowns = [];
  for (const finding of Array.isArray(findings) ? findings : []) {
    if (finding?.status !== 'open') continue;
    const severityLevel = String(finding.severity ?? '').toUpperCase();
    const blocking = severityLevel === 'HIGH' || severityLevel === 'CRITICAL';
    unknowns.push({
      code: CODE.FINDING_OPEN,
      severity: blocking ? SEVERITY.BLOCKED : SEVERITY.PROVISIONAL,
      id: finding.id ?? null,
      severityLevel: severityLevel || null,
      title: isNonEmptyString(finding.title) ? finding.title : null,
    });
  }
  return unknowns;
}

/** Fold a set of unknowns into the single strongest verdict they support. */
export function verdictFor(unknowns) {
  const severities = unknowns.map((item) => item.severity);
  if (severities.includes(SEVERITY.BLOCKED)) return BUNDLE_STATUS.BLOCKED;
  if (severities.includes(SEVERITY.UNKNOWN)) return BUNDLE_STATUS.UNKNOWN;
  if (severities.includes(SEVERITY.PROVISIONAL)) return BUNDLE_STATUS.PROVISIONAL;
  return BUNDLE_STATUS.VERIFIED;
}

/**
 * Assemble the evidence bundle for one owner run.
 *
 * Pure: the inputs are not mutated and the output is plain JSON.
 */
export function assembleBundle({
  ownerId,
  run,
  actors,
  gates,
  webEvidence,
  metrics,
  cache,
  spans,
  findings,
} = {}) {
  if (!isNonEmptyString(ownerId)) {
    throw observabilityError(OBS_ERROR_CODES.OWNER_REQUIRED, 'an explicit ownerId is required');
  }

  const { evidence, invalid } = collectEvidence({ gates, cache, webEvidence });
  const unknowns = [
    ...actorUnknowns(actors),
    ...findingUnknowns(findings),
    ...(Array.isArray(gates) ? gates : []).flatMap((gate) => gateUnknowns(gate)),
    ...webEvidenceUnknowns(webEvidence),
    ...cacheUnknowns(cache),
    ...spanUnknowns(spans),
    ...costUnknowns(metrics),
    ...invalid.map((entry) => ({ code: CODE.EVIDENCE_INVALID, severity: SEVERITY.PROVISIONAL, ...entry })),
  ];

  const summary = gateSummary(gates);
  if (summary.total === 0) {
    unknowns.push({ code: CODE.GATE_INCOMPLETE, severity: SEVERITY.UNKNOWN, reason: 'NO_GATES' });
  }

  const provenance = summarizeProvenance(actors);
  if (provenance.total === 0) {
    // Already reported as ACTOR_ROSTER_EMPTY; keep the summary shape stable.
    provenance.evidenceStatus = UNKNOWN;
  }

  return {
    ownerId,
    status: verdictFor(unknowns),
    unknowns,
    run: run ?? null,
    provenance,
    gates: { summary, items: Array.isArray(gates) ? gates : [] },
    evidence,
    metrics: metrics ?? null,
    cache: {
      stale: Array.isArray(cache?.stale) ? cache.stale : [],
      unverifiable: Array.isArray(cache?.unverifiable) ? cache.unverifiable : [],
      verified: Array.isArray(cache?.verified) ? cache.verified : [],
    },
    spans: Array.isArray(spans) ? spans : [],
  };
}
