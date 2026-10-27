/**
 * W10 metrics.
 *
 * Every section is a pure function of plain input records, so a metric can be
 * re-derived from the same rows the UI shows. The rule that shapes the whole
 * file: a value the data cannot support is the sentinel `UNKNOWN`, never `0`.
 * "No samples" and "zero cost" are different facts and must stay different.
 */

import { observabilityError, RUN_STATES, OBS_ERROR_CODES, UNKNOWN } from './vocabulary.mjs';

const SECTION_STATUS = Object.freeze({
  VERIFIED: 'VERIFIED',
  PROVISIONAL: 'PROVISIONAL',
  UNKNOWN: 'UNKNOWN',
});

/** Nearest-rank percentile over a sorted copy of the finite samples. */
export function percentile(samples, p) {
  if (typeof p !== 'number' || !Number.isFinite(p) || p < 1 || p > 100) {
    throw observabilityError(OBS_ERROR_CODES.INVALID_ARGUMENT, 'percentile must be a number in 1..100', { p });
  }
  const finite = (Array.isArray(samples) ? samples : []).filter((value) => typeof value === 'number' && Number.isFinite(value));
  if (finite.length === 0) return null;
  const sorted = [...finite].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}

/**
 * Step latency in milliseconds (PRD §12).
 *
 * A step with a start but no finish is *incomplete*, not a zero-duration
 * success: it is counted separately and excluded from the percentiles.
 */
export function latencyMetrics(steps = []) {
  const durations = [];
  let incomplete = 0;
  for (const step of Array.isArray(steps) ? steps : []) {
    const startedMs = typeof step.startedAt === 'string' ? Date.parse(step.startedAt) : NaN;
    const finishedMs = typeof step.finishedAt === 'string' ? Date.parse(step.finishedAt) : NaN;
    if (!Number.isFinite(startedMs) || !Number.isFinite(finishedMs)) {
      incomplete += 1;
      continue;
    }
    durations.push(Math.max(0, finishedMs - startedMs));
  }
  const p50 = percentile(durations, 50);
  const p90 = percentile(durations, 90);
  return {
    count: durations.length,
    incomplete,
    p50: p50 === null ? UNKNOWN : p50,
    p90: p90 === null ? UNKNOWN : p90,
    max: durations.length === 0 ? UNKNOWN : Math.max(...durations),
    unit: 'ms',
  };
}

function rate(part, total) {
  return total === 0 ? UNKNOWN : part / total;
}

/** Failure / timeout / incompleteness rates over the whole step sample. */
export function stepOutcomeMetrics(steps = []) {
  const list = Array.isArray(steps) ? steps : [];
  let succeeded = 0;
  let failed = 0;
  let timedOut = 0;
  let incomplete = 0;
  for (const step of list) {
    const isTimedOut = step.timedOut === true;
    const isIncomplete = step.incomplete === true;
    if (isTimedOut) timedOut += 1;
    if (isIncomplete) incomplete += 1;
    if (!isTimedOut && !isIncomplete && step.state === 'succeeded') succeeded += 1;
    if (step.state === 'failed') failed += 1;
  }
  const total = list.length;
  return {
    total,
    succeeded,
    failed,
    timedOut,
    incomplete,
    failureRate: rate(failed, total),
    timeoutRate: rate(timedOut, total),
    incompleteRate: rate(incomplete, total),
  };
}

/**
 * Retry behaviour keyed on `inputHash` (N11).
 *
 * Retries are counted from `attempt > 0` rather than from row count, so a
 * replayed step that reuses its attempt numbers cannot look like extra work.
 */
export function retryMetrics(steps = []) {
  const groups = new Map();
  for (const step of Array.isArray(steps) ? steps : []) {
    const key = step.inputHash ?? step.id;
    const entry = groups.get(key) ?? { attempts: [], finalState: null, maxAttempt: 0 };
    if (Number.isInteger(step.attempt)) entry.maxAttempt = Math.max(entry.maxAttempt, step.attempt);
    entry.attempts.push(step.attempt ?? 0);
    entry.finalState = step.state ?? null;
    groups.set(key, entry);
  }

  let retriedGroups = 0;
  let totalRetries = 0;
  let recoveredGroups = 0;
  let maxAttempt = 0;
  for (const entry of groups.values()) {
    const retries = entry.attempts.filter((attempt) => attempt > 0).length;
    totalRetries += retries;
    if (retries > 0) retriedGroups += 1;
    if (retries > 0 && entry.finalState === 'succeeded') recoveredGroups += 1;
    maxAttempt = Math.max(maxAttempt, entry.maxAttempt);
  }
  return { groups: groups.size, retriedGroups, totalRetries, maxAttempt, recoveredGroups };
}

/**
 * Fold a replay over the original spend rows without double-counting calls.
 *
 * Rows are identified by `(stepId, attempt)`: a replayed row that was already
 * accounted for is dropped and reported as `deduped`.
 */
export function reconcileSpendReplay({ original = [], replay = [] } = {}) {
  const seen = new Set();
  const merged = [];
  for (const row of Array.isArray(original) ? original : []) {
    seen.add(`${row.stepId}::${row.attempt ?? 0}`);
    merged.push(row);
  }
  let deduped = 0;
  for (const row of Array.isArray(replay) ? replay : []) {
    const key = `${row.stepId}::${row.attempt ?? 0}`;
    if (seen.has(key)) {
      deduped += 1;
      continue;
    }
    seen.add(key);
    merged.push(row);
  }
  const total = merged.reduce(
    (acc, row) => ({ calls: acc.calls + (row.calls ?? 0), tokens: acc.tokens + (row.tokens ?? 0) }),
    { calls: 0, tokens: 0 },
  );
  return { calls: total.calls, tokens: total.tokens, deduped };
}

/**
 * Cost rollup (N6).
 *
 * `costCny === 0` is a *known* free call; `costCny` absent/null is *unknown*.
 * Both survive into the output with different statuses, and an unknown row is
 * never added as zero — the total simply reports `PARTIAL`.
 */
export function costMetrics(spend = []) {
  const rows = Array.isArray(spend) ? spend : [];
  let calls = 0;
  let tokens = 0;
  let knownCostRuns = 0;
  let unknownCostRuns = 0;
  let freeRuns = 0;
  let costCny = 0;
  let localShareSum = 0;
  let localShareSamples = 0;

  for (const row of rows) {
    calls += row.calls ?? 0;
    tokens += row.tokens ?? 0;
    if (typeof row.costCny === 'number' && Number.isFinite(row.costCny)) {
      knownCostRuns += 1;
      costCny += row.costCny;
      if (row.costCny === 0) freeRuns += 1;
    } else {
      unknownCostRuns += 1;
    }
    if (typeof row.localShare === 'number' && Number.isFinite(row.localShare)) {
      localShareSum += row.localShare;
      localShareSamples += 1;
    }
  }

  if (rows.length === 0) {
    return {
      calls,
      tokens,
      runs: 0,
      knownCostRuns: 0,
      unknownCostRuns: 0,
      freeRuns: 0,
      costCny: UNKNOWN,
      costStatus: SECTION_STATUS.UNKNOWN,
      unknownCost: false,
      localShare: UNKNOWN,
      localShareSamples: 0,
    };
  }

  const costStatus = unknownCostRuns === 0
    ? 'KNOWN'
    : knownCostRuns === 0
      ? SECTION_STATUS.UNKNOWN
      : 'PARTIAL';

  return {
    calls,
    tokens,
    runs: rows.length,
    knownCostRuns,
    unknownCostRuns,
    freeRuns,
    costCny: knownCostRuns === 0 ? null : costCny,
    costStatus,
    unknownCost: unknownCostRuns > 0,
    localShare: localShareSamples === 0 ? UNKNOWN : localShareSum / localShareSamples,
    localShareSamples,
  };
}

/** Run state histogram over the frozen 8-state enum. Unknown states are a contract violation. */
export function runMetrics(runs = []) {
  const byState = Object.fromEntries(RUN_STATES.map((state) => [state, 0]));
  const list = Array.isArray(runs) ? runs : [];
  for (const run of list) {
    if (!RUN_STATES.includes(run.state)) {
      throw observabilityError(OBS_ERROR_CODES.CONTRACT_INVALID, `run state must be one of ${RUN_STATES.join(', ')}`, {
        state: run.state ?? null,
      });
    }
    byState[run.state] += 1;
  }
  return { total: list.length, byState };
}

function decisionMetrics(decisions, labels) {
  const list = Array.isArray(decisions) ? decisions : [];
  const counts = Object.fromEntries(labels.map((label) => [label, 0]));
  for (const item of list) {
    if (item?.decision in counts) counts[item.decision] += 1;
  }
  const total = list.length;
  return {
    total,
    ...counts,
    accepted: counts.accepted,
    acceptanceRate: rate(counts.accepted, total),
    revisionRate: rate(counts.revision_requested, total),
    rejectionRate: rate(counts.rejected, total),
  };
}

/** Acceptance rate (PRD §5.6): only `accepted` counts as a benefit. */
export function acceptanceMetrics(acceptances = []) {
  return decisionMetrics(acceptances, ['accepted', 'revision_requested', 'rejected']);
}

/** Need interruption quality: a defaulted or expired need is an attention defect. */
export function needMetrics(needs = []) {
  const list = Array.isArray(needs) ? needs : [];
  const counts = { open: 0, answered: 0, defaulted: 0, waived: 0, expired: 0 };
  for (const need of list) {
    if (need?.status in counts) counts[need.status] += 1;
  }
  return { total: list.length, ...counts, defaultRate: rate(counts.defaulted, list.length) };
}

/** Grant lifecycle: invalidated/expired are revocation counts, kept separate from consumed. */
export function grantMetrics(grants = []) {
  const list = Array.isArray(grants) ? grants : [];
  const counts = { proposed: 0, active: 0, consumed: 0, revoked: 0, expired: 0, invalidated: 0 };
  for (const grant of list) {
    if (grant?.status in counts) counts[grant.status] += 1;
  }
  return { total: list.length, ...counts };
}

/**
 * Compose every section and derive one overall status.
 *
 * Any data at all can only reach `PROVISIONAL`: these are metrics over
 * recorded rows, not an end-to-end run, so `VERIFIED` is not theirs to claim.
 */
export function buildMetrics({ steps, spend, runs, acceptances, needs, grants } = {}) {
  const latency = latencyMetrics(steps);
  const outcomes = stepOutcomeMetrics(steps);
  const retries = retryMetrics(steps);
  const cost = costMetrics(spend);
  const runSummary = runMetrics(runs);
  const acceptance = acceptanceMetrics(acceptances);
  const needSummary = needMetrics(needs);
  const grantSummary = grantMetrics(grants);

  const hasAnyData = [steps, spend, runs, acceptances, needs, grants].some(
    (list) => Array.isArray(list) && list.length > 0,
  );

  return {
    latency,
    outcomes,
    retries,
    cost,
    runs: runSummary,
    acceptance,
    needs: needSummary,
    grants: grantSummary,
    status: hasAnyData ? SECTION_STATUS.PROVISIONAL : SECTION_STATUS.UNKNOWN,
  };
}
