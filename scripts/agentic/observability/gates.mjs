/**
 * W10 gate recording.
 *
 * A gate is only evidence if it carries a command, an exit code and a commit
 * head (N5), and a passing gate is only `VERIFIED` when its evidence is marked
 * `verified: true` *and* comes from a real source. Mock evidence and coverage
 * below the line floor cap a gate at `PROVISIONAL` — they never upgrade it
 * (BRIEF §3: a mock or a unit test is not end-to-end success).
 */

import { observabilityError, validateGate, OBS_ERROR_CODES } from './vocabulary.mjs';
import { parseJsonOr } from './store.mjs';

export const GATE_EVIDENCE_STATUS = Object.freeze({
  VERIFIED: 'VERIFIED',
  PROVISIONAL: 'PROVISIONAL',
  UNKNOWN: 'UNKNOWN',
  BLOCKED: 'BLOCKED',
});

/** BUILD-PLAN §2.3/§2.4: per-module line coverage floor (≥80%). */
export const COVERAGE_LINE_FLOOR = 80;

/** Evidence sources that cannot prove a real run happened. */
const NON_VERIFIABLE_SOURCES = Object.freeze(['mock', 'fixture', 'synthetic']);

function isPassing(gate) {
  if (Number.isInteger(gate.failed) && gate.failed > 0) return false;
  return gate.rc === 0;
}

function coverageOk(gate) {
  const line = gate.coverage?.line;
  if (typeof line !== 'number' || !Number.isFinite(line)) return false;
  return line >= COVERAGE_LINE_FLOOR;
}

/**
 * Decide one gate's evidence status. Deliberately ordered from strongest
 * rejection to weakest claim: a failure always wins, an absent check can never
 * be silently treated as a pass.
 */
export function assessGate(gate) {
  const passing = isPassing(gate);
  const coverage = gate.coverage ?? null;
  const coveragePasses = coverage === null ? null : coverageOk(gate);
  const evidence = Array.isArray(gate.evidence) ? gate.evidence : [];

  if (!passing) {
    return { passed: false, coverageOk: coveragePasses, evidenceStatus: GATE_EVIDENCE_STATUS.BLOCKED, verifiable: false };
  }
  if (evidence.length === 0) {
    return { passed: true, coverageOk: coveragePasses, evidenceStatus: GATE_EVIDENCE_STATUS.UNKNOWN, verifiable: false };
  }
  const verified = evidence.filter((item) => item?.verified === true);
  if (verified.length === 0) {
    return { passed: true, coverageOk: coveragePasses, evidenceStatus: GATE_EVIDENCE_STATUS.PROVISIONAL, verifiable: false };
  }
  if (verified.some((item) => NON_VERIFIABLE_SOURCES.includes(item.source))) {
    return { passed: true, coverageOk: coveragePasses, evidenceStatus: GATE_EVIDENCE_STATUS.PROVISIONAL, verifiable: false };
  }
  if (coveragePasses === false) {
    return { passed: true, coverageOk: false, evidenceStatus: GATE_EVIDENCE_STATUS.PROVISIONAL, verifiable: false };
  }
  return { passed: true, coverageOk: coveragePasses, evidenceStatus: GATE_EVIDENCE_STATUS.VERIFIED, verifiable: true };
}

export function createGateRecorder({ store } = {}) {
  if (!store) throw observabilityError(OBS_ERROR_CODES.INVALID_ARGUMENT, 'a store is required');

  return {
    /**
     * Record one gate result, keyed on `(owner, stream, name, head)`.
     *
     * Re-recording the same gate on the same head updates it in place and
     * reports `duplicate: true` rather than adding a second row (N4), so a
     * re-run cannot inflate the gate count.
     */
    record(gate) {
      validateGate(gate);
      const assessment = assessGate(gate);
      const upsert = store.upsertGate({
        ownerId: gate.ownerId,
        stream: gate.stream,
        name: gate.name,
        head: gate.head,
        kind: gate.kind,
        command: gate.command,
        rc: gate.rc,
        passed: gate.passed,
        failed: gate.failed,
        skipped: gate.skipped,
        durationMs: gate.durationMs,
        coverage: gate.coverage,
        contractCommit: gate.contractCommit,
        evidence: gate.evidence,
        recordedAt: gate.recordedAt,
      });
      return {
        recorded: true,
        duplicate: upsert.updated === true,
        ownerId: gate.ownerId,
        stream: gate.stream,
        name: gate.name,
        head: gate.head,
        coverage: gate.coverage ?? null,
        ...assessment,
      };
    },

    /**
     * Aggregate every gate recorded at one head.
     *
     * Any failed gate blocks the whole head; zero gates is `UNKNOWN`; a mix of
     * verified and provisional-but-passing gates stays `PROVISIONAL` — only an
     * all-verified head may claim `VERIFIED`.
     */
    summarize(ownerId, head) {
      const rows = store.listGates(ownerId, { head });
      let failed = 0;
      let verified = 0;
      let provisional = 0;
      let unknown = 0;
      for (const row of rows) {
        const assessment = assessGate({
          rc: row.rc,
          failed: row.failed,
          evidence: parseJsonOr(row.evidence_json, []),
          coverage: parseJsonOr(row.coverage_json, null),
        });
        if (!assessment.passed) failed += 1;
        else if (assessment.evidenceStatus === GATE_EVIDENCE_STATUS.VERIFIED) verified += 1;
        else if (assessment.evidenceStatus === GATE_EVIDENCE_STATUS.PROVISIONAL) provisional += 1;
        else unknown += 1;
      }

      let status;
      if (rows.length === 0) status = GATE_EVIDENCE_STATUS.UNKNOWN;
      else if (failed > 0) status = GATE_EVIDENCE_STATUS.BLOCKED;
      else if (verified === rows.length) status = GATE_EVIDENCE_STATUS.VERIFIED;
      else status = GATE_EVIDENCE_STATUS.PROVISIONAL;

      return { head, total: rows.length, failed, verified, provisional, unknown, status };
    },
  };
}
