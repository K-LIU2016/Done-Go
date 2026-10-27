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
  REVIEW_MISSING: 'REVIEW_MISSING',
  GATE_FAILED: 'GATE_FAILED',
  GATE_INCOMPLETE: 'GATE_INCOMPLETE',
  TEST_EVIDENCE_MISSING: 'TEST_EVIDENCE_MISSING',
  E2E_EVIDENCE_MISSING: 'E2E_EVIDENCE_MISSING',
  CONTRACT_DRIFT: 'CONTRACT_DRIFT',
  CONTRACT_UNKNOWN: 'CONTRACT_UNKNOWN',
  CONTRACT_PREFIX_ONLY: 'CONTRACT_PREFIX_ONLY',
  PUSH_UNCONFIRMED: 'PUSH_UNCONFIRMED',
  RISK_OPEN: 'RISK_OPEN',
  REPORT_PARSE_FAILED: 'REPORT_PARSE_FAILED',
  STATUS_CONFLICT: 'STATUS_CONFLICT',
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
      // Counters quoted from a rendered report (`reportedOnly`) are a claim, not
      // primary evidence: §2.4 caps them at PROVISIONAL instead of pretending
      // nothing was run. Structured input without evidence stays UNKNOWN.
      if (gate.reportedOnly === true) {
        unknowns.push({ code: CODE.GATE_INCOMPLETE, severity: SEVERITY.PROVISIONAL, gate: gate.name, reason: 'REPORTED_ONLY' });
      } else {
        unknowns.push({ code: CODE.GATE_INCOMPLETE, severity: SEVERITY.UNKNOWN, gate: gate.name, reason: 'NO_EVIDENCE' });
      }
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
  if (isNonEmptyString(stream.contractCommit)) {
    if (stream.contractCommit !== frozen.commit) {
      return [{ code: CODE.CONTRACT_DRIFT, severity: SEVERITY.BLOCKED, expected: frozen.commit, actual: stream.contractCommit }];
    }
    return [];
  }
  // A rendered report carries only the first 7 characters of the contract
  // commit. A prefix that disagrees with the frozen baseline is drift (BLOCKED);
  // a prefix that agrees still cannot prove full-commit equality, so it is
  // recorded as PROVISIONAL evidence and can never support VERIFIED (§7.2).
  if (isNonEmptyString(stream.contractCommitPrefix)) {
    const expected = frozen.commit.slice(0, stream.contractCommitPrefix.length);
    if (stream.contractCommitPrefix !== expected) {
      return [{ code: CODE.CONTRACT_DRIFT, severity: SEVERITY.BLOCKED, expected, actual: stream.contractCommitPrefix }];
    }
    return [{ code: CODE.CONTRACT_PREFIX_ONLY, severity: SEVERITY.PROVISIONAL, prefix: stream.contractCommitPrefix, expected: frozen.commit }];
  }
  return [{ code: CODE.CONTRACT_UNKNOWN, severity: SEVERITY.UNKNOWN, expected: frozen.commit }];
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
  // A stream whose gate list is empty has no test rc at all: §2.4 makes that
  // UNKNOWN, never a pass. (Also covers rows synthesised from failed parses.)
  if (stream.gates.length === 0) {
    unknowns.push({ code: CODE.TEST_EVIDENCE_MISSING, severity: SEVERITY.UNKNOWN, reason: 'NO_GATES' });
  }
  if (stream.parseError) {
    unknowns.push({ code: CODE.REPORT_PARSE_FAILED, severity: SEVERITY.UNKNOWN, reason: stream.parseError });
  }
  const models = [
    ...reviewModels(stream.reviewActors, unknowns),
    ...reviewModels(stream.fixActors, unknowns),
  ];
  // Red line 7: actors must be named and bound to models. An empty roster is a
  // missing review, not a passed one — no review actor means no review evidence.
  if (models.length === 0) {
    unknowns.push({ code: CODE.REVIEW_MISSING, severity: SEVERITY.UNKNOWN, reason: 'NO_REVIEW_ACTORS' });
  }

  let status = verdictFor(unknowns);
  // The status written in a source report is a claim, never an input: when it
  // disagrees with the derivation the disagreement itself is recorded, and a
  // VERIFIED derivation against a contradicting claim is capped at PROVISIONAL.
  const claimedStatus = isNonEmptyString(stream.claimedStatus) ? stream.claimedStatus : null;
  if (claimedStatus !== null && claimedStatus !== status) {
    unknowns.push({ code: CODE.STATUS_CONFLICT, severity: SEVERITY.PROVISIONAL, claimed: claimedStatus, derived: status });
    status = verdictFor(unknowns);
  }

  const prefixMatches = isNonEmptyString(stream.contractCommitPrefix)
    && stream.contractCommitPrefix === frozen.commit.slice(0, stream.contractCommitPrefix.length);

  return {
    stream: stream.stream,
    head: stream.head,
    contractCommit: stream.contractCommit ?? null,
    contractCommitPrefix: isNonEmptyString(stream.contractCommitPrefix) ? stream.contractCommitPrefix : null,
    contractRelation: stream.contractRelation
      ?? (stream.contractCommit === frozen.commit ? 'matches' : prefixMatches ? 'matches-prefix' : 'unknown'),
    status,
    unknowns,
    claimedStatus,
    parseError: stream.parseError ?? null,
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
      reportedOnly: gate?.reportedOnly === true ? true : null,
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

// ---------------------------------------------------------------------------
// §7.2 data source B: read-only parsing of rendered stream reports.
//
// `parseStreamReport` recognises exactly the lines `report.mjs` emits in its
// 逐流明细 section — a round trip, not a guess. Every field the section fails
// to carry stays null and is derived as UNKNOWN downstream; a missing HEAD or
// gate block, or a missing section entirely, is a failed parse. Nothing is ever
// inferred from prose.
// ---------------------------------------------------------------------------

function intOrNull(token) {
  if (typeof token !== 'string' || token === 'UNKNOWN') return null;
  return /^-?\d+$/.test(token) ? Number.parseInt(token, 10) : null;
}

/** Take the first capture of `regex` executed on `section`, or null. */
function first(section, regex) {
  const match = section.match(regex);
  return match === null ? null : match[1];
}

function sectionFor(lines, name) {
  const start = lines.findIndex((line) => line === `### ${name}`);
  if (start === -1) return null;
  const end = lines.findIndex((line, index) => index > start && /^#{1,3} /.test(line));
  return lines.slice(start + 1, end === -1 ? undefined : end).join('\n');
}

function parseGatesLine(line) {
  if (line === null || line === 'UNKNOWN') return [];
  const gates = [];
  for (const chunk of line.split('; ')) {
    const match = chunk.match(/^(.+?): (.+) rc=(\S+) pass=(\S+) fail=(\S+) skip=(\S+)$/);
    if (match === null) {
      // An unrecognisable fragment still occupies a slot, so its missing rc is
      // reported as GATE_INCOMPLETE instead of the gate silently disappearing.
      gates.push({ name: chunk.split(':')[0] ?? null, kind: null, command: null, rc: null, passed: null, failed: null, skipped: null, reportedOnly: true });
      continue;
    }
    gates.push({
      name: match[1],
      kind: null,
      command: match[2],
      rc: intOrNull(match[3]),
      passed: intOrNull(match[4]),
      failed: intOrNull(match[5]),
      skipped: intOrNull(match[6]),
      reportedOnly: true,
    });
  }
  return gates;
}

function parseActorLine(line) {
  const match = line.match(/^(\S+) resolved_model=(\S+) source=(\S+)$/);
  if (match === null) return null;
  const actor = { role: match[1] };
  if (match[2] !== 'NULL') actor.model = match[2];
  if (match[3] !== 'UNKNOWN') actor.modelSource = match[3];
  return actor;
}

function parseRisks(section) {
  const risks = [];
  for (const match of section.matchAll(/^- 风险: (\S+) severity=(\S+) status=(\S+)$/gm)) {
    risks.push({ id: match[1], severity: match[2], status: match[3] });
  }
  return risks;
}

/**
 * Parse one rendered stream report section.
 *
 * Returns `{ ok: true, stream, parseError: null, parsed }` or
 * `{ ok: false, stream, parseError, parsed: null }`. Pure: takes the report
 * content as a string, touches no filesystem, throws only on a missing name.
 */
export function parseStreamReport({ name, content } = {}) {
  if (!isNonEmptyString(name)) {
    throw observabilityError(OBS_ERROR_CODES.MATRIX_INCOMPLETE, 'a report name is required');
  }
  const fail = (reason) => ({ ok: false, stream: name, parseError: reason, parsed: null });
  if (typeof content !== 'string') return fail('CONTENT_NOT_STRING');

  const section = sectionFor(content.split('\n'), name);
  if (section === null) return fail('SECTION_NOT_FOUND');

  const head = first(section, /^- HEAD: (.+)$/m);
  const gatesLine = first(section, /^- 门禁: (.+)$/m);
  const missing = [];
  if (head === null || head === 'UNKNOWN') missing.push('HEAD');
  if (gatesLine === null) missing.push('门禁');
  if (missing.length > 0) return fail(`MISSING_FIELD:${missing.join(',')}`);

  const contract = first(section, /^- 契约: (.+)$/m);
  const contractMatch = contract === null || contract === 'UNKNOWN' ? null : contract.match(/^([^@]+)@([^@]+)$/);

  const push = first(section, /^- push: (.+)$/m);
  const pushMatch = push === null || push === 'UNKNOWN' ? null : push.match(/^(\S+) (pushed|not-pushed) rc=(\S+)$/);

  const web = first(section, /^- web 证据: (.+)$/m);
  const webMatch = web === null || web === 'UNKNOWN' ? null : web.match(/^(.*) rc=(\S+)$/);

  const reviewActors = [];
  for (const match of section.matchAll(/^- 评审模型: (.+)$/gm)) {
    const actor = parseActorLine(match[1]);
    if (actor !== null) reviewActors.push(actor);
  }

  const claimedStatus = first(section, /^- 状态: (\S+)$/m);

  return {
    ok: true,
    stream: name,
    parseError: null,
    parsed: {
      head,
      contractRelation: contractMatch === null ? null : contractMatch[1],
      contractCommitPrefix: contractMatch === null ? null : contractMatch[2],
      gates: parseGatesLine(gatesLine),
      reviewActors,
      fixActors: [],
      risks: parseRisks(section),
      push: pushMatch === null ? null : { ref: pushMatch[1], pushed: pushMatch[2] === 'pushed', rc: intOrNull(pushMatch[3]) },
      web: webMatch === null ? null : { command: webMatch[1], rc: intOrNull(webMatch[2]) },
      claimedStatus: claimedStatus === null || claimedStatus === 'UNKNOWN' ? null : claimedStatus,
    },
  };
}

function streamFromReport({ name, content }) {
  const report = parseStreamReport({ name, content });
  if (report.ok) return { stream: name, ...report.parsed };
  // 解析失败即 UNKNOWN (§7.2): the row exists, every field is UNKNOWN, and the
  // reason is carried on the record. Nothing is guessed from the remainder.
  return {
    stream: name,
    head: 'UNKNOWN',
    contractRelation: 'unknown',
    gates: [],
    reviewActors: [],
    fixActors: [],
    risks: [],
    web: undefined,
    push: undefined,
    claimedStatus: null,
    parseError: report.parseError,
  };
}

/**
 * Build the matrix from rendered stream reports instead of structured JSON.
 *
 * Same input contract as `createMatrix` for everything but `streams`: reports
 * are `{ name, content }` pairs, one per stream, parsed strictly by
 * `parseStreamReport`. Duplicate names are refused.
 */
export function createMatrixFromReports({ ownerId, frozen, generatedAt, reports } = {}) {
  if (!Array.isArray(reports)) {
    throw observabilityError(OBS_ERROR_CODES.MATRIX_INCOMPLETE, 'reports must be an array');
  }
  const seen = new Set();
  for (const report of reports) {
    if (!isNonEmptyString(report?.name)) {
      throw observabilityError(OBS_ERROR_CODES.MATRIX_INCOMPLETE, 'every report needs a name');
    }
    if (seen.has(report.name)) {
      throw observabilityError(OBS_ERROR_CODES.MATRIX_INCOMPLETE, `duplicate stream ${report.name}`, { stream: report.name });
    }
    seen.add(report.name);
  }
  return createMatrix({
    ownerId,
    frozen,
    generatedAt,
    streams: reports.map((report) => streamFromReport(report)),
  });
}
