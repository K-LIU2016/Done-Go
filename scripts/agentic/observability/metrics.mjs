/**
 * W10 metrics.
 *
 * Every section is a pure function of plain input records, so a metric can be
 * re-derived from the same rows the UI shows. The rule that shapes the whole
 * file: a value the data cannot support is the sentinel `UNKNOWN`, never `0`.
 * "No samples" and "zero cost" are different facts and must stay different.
 *
 * Record shapes accepted everywhere: the contract shape (camelCase field
 * names, what step/span/spend callers assemble) *and* the store's SQL rows
 * (snake_case `obs_*.sql` columns), plus span projections from
 * `spans.classifyOutcome` (`outcome`/`incomplete`). A caller feeding raw
 * `obs_steps`/`obs_spans` rows must never get silently wrong numbers (a
 * `started_at` misread as "no start", a NULL `cost_cny` summed as zero).
 * Contract names win when a record carries both spellings.
 */

import { observabilityError, RUN_STATES, OBS_ERROR_CODES, UNKNOWN } from './vocabulary.mjs';

const SECTION_STATUS = Object.freeze({
  VERIFIED: 'VERIFIED',
  PROVISIONAL: 'PROVISIONAL',
  UNKNOWN: 'UNKNOWN',
});

/** Terminal step states (step.schema.json): no further outcome can arrive. */
const TERMINAL_STEP_STATES = new Set(['succeeded', 'failed', 'skipped']);

/**
 * First present key among the given spellings. Deliberately `!== undefined`
 * (not `??`): SQL NULL is a present value and means "unknown", not "absent".
 */
function pick(record, ...keys) {
  for (const key of keys) {
    if (record[key] !== undefined) return record[key];
  }
  return undefined;
}

function parseMs(value) {
  return typeof value === 'string' ? Date.parse(value) : NaN;
}

/** Start timestamp in ms; `started_at` is the store column spelling. */
function startMs(record) {
  return parseMs(pick(record, 'startedAt', 'started_at'));
}

/** Finish timestamp in ms; steps say `finishedAt`, spans say `endedAt`. */
function finishMs(record) {
  return parseMs(pick(record, 'finishedAt', 'finished_at', 'endedAt', 'ended_at'));
}

/**
 * Outcome state of one record: the step `state`, or — for span projections
 * that carry their verdict in `outcome` — the mapped span verdict.
 */
function resolveState(record) {
  if (record.state !== undefined) return record.state;
  if (record.outcome === 'succeeded' || record.outcome === 'failed') return record.outcome;
  return undefined;
}

function resolveTimedOut(record) {
  return record.timedOut === true || record.timed_out === true || record.timed_out === 1 || record.outcome === 'timed_out';
}

function resolveIncompleteFlag(record) {
  return record.incomplete === true || record.incomplete === 1;
}

/**
 * Whether a record with a start but no finish is still waiting on a terminal
 * state (N10: started, no verdict yet → incomplete).
 */
function derivedIncomplete(record, state) {
  if (TERMINAL_STEP_STATES.has(state)) return false;
  return Number.isFinite(startMs(record)) && pick(record, 'finishedAt', 'finished_at', 'endedAt', 'ended_at') == null;
}

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
 * Step/span latency in milliseconds (PRD §12).
 *
 * A record with a start but no finish is *incomplete* (cut mid-flight), not a
 * zero-duration success: counted separately, excluded from the percentiles.
 * A record that never started is a different population (`notStarted`) — N10
 * counts incomplete only when a start exists.
 */
export function latencyMetrics(steps = []) {
  const durations = [];
  let incomplete = 0;
  let notStarted = 0;
  for (const step of Array.isArray(steps) ? steps : []) {
    const startedMs = startMs(step);
    if (!Number.isFinite(startedMs)) {
      notStarted += 1;
      continue;
    }
    const finishedMs = finishMs(step);
    if (!Number.isFinite(finishedMs)) {
      incomplete += 1;
      continue;
    }
    durations.push(Math.max(0, finishedMs - startedMs));
  }
  const p50 = percentile(durations, 50);
  const p90 = percentile(durations, 90);
  return {
    count: durations.length,
    notStarted,
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

/**
 * Failure / timeout / incompleteness rates over the whole sample.
 *
 * A timed-out record is neither a failure nor a success (N9): the SLA fired
 * before any verdict existed, so it never lands in either bucket.
 */
export function stepOutcomeMetrics(steps = []) {
  const list = Array.isArray(steps) ? steps : [];
  let succeeded = 0;
  let failed = 0;
  let timedOut = 0;
  let incomplete = 0;
  for (const step of list) {
    const state = resolveState(step);
    const isTimedOut = resolveTimedOut(step);
    const isIncomplete = resolveIncompleteFlag(step) || derivedIncomplete(step, state);
    if (isTimedOut) timedOut += 1;
    if (isIncomplete) incomplete += 1;
    if (isTimedOut) continue;
    if (!isIncomplete && state === 'succeeded') succeeded += 1;
    if (state === 'failed') failed += 1;
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
 * Retries are counted from *distinct* `attempt` values above 0 within a group,
 * so a recovery replay that re-records rows it already emitted cannot look
 * like extra work; a group's final state is the state of its highest attempt,
 * not whatever row happened to arrive last.
 */
export function retryMetrics(steps = []) {
  const groups = new Map();
  for (const step of Array.isArray(steps) ? steps : []) {
    const key = pick(step, 'inputHash', 'input_hash') ?? step.id;
    const entry = groups.get(key) ?? { attempts: new Set(), stateByAttempt: new Map(), maxAttempt: 0 };
    if (Number.isInteger(step.attempt)) entry.maxAttempt = Math.max(entry.maxAttempt, step.attempt);
    const attempt = Number.isInteger(step.attempt) ? step.attempt : 0;
    entry.attempts.add(attempt);
    entry.stateByAttempt.set(attempt, resolveState(step) ?? null);
    groups.set(key, entry);
  }

  let retriedGroups = 0;
  let totalRetries = 0;
  let recoveredGroups = 0;
  let maxAttempt = 0;
  for (const entry of groups.values()) {
    let retries = 0;
    for (const attempt of entry.attempts) {
      if (attempt > 0) retries += 1;
    }
    totalRetries += retries;
    if (retries > 0) retriedGroups += 1;
    const finalState = entry.stateByAttempt.get(entry.maxAttempt) ?? null;
    if (retries > 0 && finalState === 'succeeded') recoveredGroups += 1;
    maxAttempt = Math.max(maxAttempt, entry.maxAttempt);
  }
  return { groups: groups.size, retriedGroups, totalRetries, maxAttempt, recoveredGroups };
}

/**
 * Fold a replay over the original spend rows without double-counting calls.
 *
 * Rows are identified by `(stepId, attempt)` in either field spelling: a
 * replayed row that was already accounted for is dropped and reported as
 * `deduped`.
 */
export function reconcileSpendReplay({ original = [], replay = [] } = {}) {
  const keyOf = (row) => `${pick(row, 'stepId', 'step_id')}::${row.attempt ?? 0}`;
  const seen = new Set();
  const merged = [];
  for (const row of Array.isArray(original) ? original : []) {
    seen.add(keyOf(row));
    merged.push(row);
  }
  let deduped = 0;
  for (const row of Array.isArray(replay) ? replay : []) {
    const key = keyOf(row);
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
 * `costCny === 0` is a *known* free call; `costCny` absent/NULL is *unknown*.
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
    const rowCostCny = pick(row, 'costCny', 'cost_cny');
    if (typeof rowCostCny === 'number' && Number.isFinite(rowCostCny)) {
      knownCostRuns += 1;
      costCny += rowCostCny;
      if (rowCostCny === 0) freeRuns += 1;
    } else {
      unknownCostRuns += 1;
    }
    const rowLocalShare = pick(row, 'localShare', 'local_share');
    if (typeof rowLocalShare === 'number' && Number.isFinite(rowLocalShare)) {
      localShareSum += rowLocalShare;
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

/**
 * Need interruption quality: a defaulted or expired need is an attention
 * defect. `defaultRate` is the "no answer given" defect rate; `expiredRate`
 * is the timeout rate (plan §2.1 maps `need.expired` to the timeout metric).
 */
export function needMetrics(needs = []) {
  const list = Array.isArray(needs) ? needs : [];
  const counts = { open: 0, answered: 0, defaulted: 0, waived: 0, expired: 0 };
  for (const need of list) {
    if (need?.status in counts) counts[need.status] += 1;
  }
  return {
    total: list.length,
    ...counts,
    defaultRate: rate(counts.defaulted, list.length),
    expiredRate: rate(counts.expired, list.length),
  };
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
