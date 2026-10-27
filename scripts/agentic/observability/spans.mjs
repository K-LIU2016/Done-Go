/**
 * W10 span recording.
 *
 * Sits between the frozen W0 `span` contract and the `obs_spans` projection:
 *
 *  - the incoming value is validated against `span.schema.json` before anything
 *    is written, so no new top-level field can be smuggled in (W0 stays frozen);
 *  - provenance lives in `span.attributes` and is projected into dedicated
 *    columns, never inferred from a neighbour or from the request model;
 *  - a resume/replay of the same span id is idempotent (N3).
 */

import { fileURLToPath } from 'node:url';
import { loadSchema, validate } from '../contracts.mjs';
import { ATTRIBUTE_KEYS, PROVENANCE, observabilityError, OBS_ERROR_CODES } from './vocabulary.mjs';

const CONTRACTS_DIR = fileURLToPath(new URL('../../../contracts/agentic/', import.meta.url));
const SPAN_SCHEMA = 'span.schema.json';

function assertSpan(spanValue) {
  const result = validate(spanValue, loadSchema(SPAN_SCHEMA, CONTRACTS_DIR), { schemaDir: CONTRACTS_DIR });
  if (!result.valid) {
    const failure = new Error(
      `CONTRACT_INVALID: ${result.errors.map((item) => `${item.path} ${item.message}`).join('; ')}`,
    );
    failure.code = OBS_ERROR_CODES.CONTRACT_INVALID;
    failure.errors = result.errors;
    throw failure;
  }
  return spanValue;
}

function trimmedOrNull(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function toBoolColumn(value) {
  if (value === undefined || value === null) return null;
  return value === true || value === 1 ? 1 : 0;
}

/**
 * Project the sanctioned `attributes` extension point into queryable columns.
 *
 * `resolved_model` is derived only from the actor's own declared model — never
 * from `gen_ai.request.model` — so a chat span can never look resolved merely
 * because a request was attempted (red line 7 / N1).
 */
export function projectAttributes(attributes) {
  const source = attributes && typeof attributes === 'object' ? attributes : {};
  const actorModel = trimmedOrNull(source[ATTRIBUTE_KEYS.actorModel]);
  const resolvedModel = trimmedOrNull(source[ATTRIBUTE_KEYS.resolvedModel]) ?? actorModel;
  return {
    attributes: source,
    requestModel: trimmedOrNull(source[ATTRIBUTE_KEYS.requestModel]),
    actorRole: trimmedOrNull(source[ATTRIBUTE_KEYS.actorRole]),
    actorModel,
    resolvedModel,
    modelSource: trimmedOrNull(source[ATTRIBUTE_KEYS.modelSource]),
    modelLocal: toBoolColumn(source[ATTRIBUTE_KEYS.modelLocal]),
    provenance: resolvedModel === null ? PROVENANCE.UNKNOWN : PROVENANCE.RESOLVED,
  };
}

function spanOutcome(row, referenceMs, slaMs) {
  if (row.status === 'ok') return { id: row.id, status: row.status, outcome: 'succeeded', incomplete: false };
  if (row.status === 'error') return { id: row.id, status: row.status, outcome: 'failed', incomplete: false };
  // `running` with a start timestamp but no terminal status: never silently
  // promoted to success, and never folded into failure (N9 / N10).
  const startedMs = Date.parse(row.started_at);
  const timedOut = Number.isFinite(startedMs) && referenceMs - startedMs > slaMs;
  return {
    id: row.id,
    status: row.status,
    outcome: timedOut ? 'timed_out' : 'running',
    incomplete: true,
  };
}

export function createSpanRecorder({ store } = {}) {
  if (!store) throw observabilityError(OBS_ERROR_CODES.INVALID_ARGUMENT, 'a store is required');

  return {
    /** Validate, project and store one span. Returns `{ inserted, duplicate }`. */
    record(spanValue, { ownerId, runId } = {}) {
      assertSpan(spanValue);
      const projected = projectAttributes(spanValue.attributes);
      return store.insertSpan(
        {
          id: spanValue.id,
          name: spanValue.name,
          kind: spanValue.kind,
          startedAt: spanValue.startedAt,
          endedAt: spanValue.endedAt,
          status: spanValue.status,
          parentId: spanValue.parentId,
          inputRef: spanValue.inputRef,
          outputRef: spanValue.outputRef,
          error: spanValue.error,
          ...projected,
        },
        { ownerId, runId },
      );
    },

    /**
     * Assemble the span tree for one owner run.
     *
     * A span whose parent is absent from this run is still surfaced as a root so
     * it cannot disappear from the trace, and is additionally listed in
     * `orphans` so the break in the tree is visible rather than silent.
     */
    buildTree(ownerId, runId) {
      const rows = store.listRunSpans(ownerId, runId);
      const nodes = new Map(rows.map((row) => [row.id, { ...row, children: [] }]));
      const roots = [];
      const orphans = [];
      for (const row of rows) {
        const node = nodes.get(row.id);
        if (row.parent_id === null || row.parent_id === undefined) {
          roots.push(node);
          continue;
        }
        const parent = nodes.get(row.parent_id);
        if (parent) parent.children.push(node);
        else {
          roots.push(node);
          orphans.push(row.id);
        }
      }
      return { roots, orphans };
    },

    /**
     * Classify every span of a run into exactly one outcome bucket, plus an
     * `incomplete` flag for spans that never reached a terminal status.
     *
     * `timed_out` and `incomplete` are separate from both `succeeded` and
     * `failed`: a dropped connection must not be reported as a failure the
     * system chose, nor as a success.
     */
    classifyOutcome({ ownerId, runId, now, slaMs } = {}) {
      if (typeof slaMs !== 'number' || !Number.isFinite(slaMs) || slaMs < 0) {
        throw observabilityError(OBS_ERROR_CODES.INVALID_ARGUMENT, 'slaMs must be a finite non-negative number');
      }
      const referenceMs = typeof now === 'string' ? Date.parse(now) : NaN;
      if (!Number.isFinite(referenceMs)) {
        throw observabilityError(OBS_ERROR_CODES.INVALID_ARGUMENT, 'now must be a parseable timestamp');
      }
      const spans = store.listRunSpans(ownerId, runId).map((row) => spanOutcome(row, referenceMs, slaMs));
      const counts = { succeeded: 0, failed: 0, timed_out: 0, incomplete: 0, running: 0 };
      for (const entry of spans) {
        if (entry.incomplete) counts.incomplete += 1;
        if (entry.outcome === 'succeeded') counts.succeeded += 1;
        else if (entry.outcome === 'failed') counts.failed += 1;
        else if (entry.outcome === 'timed_out') counts.timed_out += 1;
        else counts.running += 1;
      }
      return { spans, counts };
    },
  };
}
