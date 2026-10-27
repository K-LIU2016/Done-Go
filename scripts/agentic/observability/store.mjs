/**
 * W10 observability storage.
 *
 * A thin, owner-scoped projection layer over the additive `obs_*` tables. It
 * reuses W0's `openAgenticDb`/`migrate` untouched and never writes to a W0
 * table. Two invariants drive every method:
 *
 *  - every row carries a caller-supplied `owner_id` (no hidden default owner),
 *  - every read is owner-scoped, so a foreign row is indistinguishable from a
 *    missing one (N12: no existence leak).
 */

import { fileURLToPath } from 'node:url';
import { migrate } from '../db/index.mjs';
import { loadSchema, validate } from '../contracts.mjs';
import {
  observabilityError,
  isNonEmptyString,
  validateGate,
  OBS_ERROR_CODES,
} from './vocabulary.mjs';

export const OBS_MIGRATIONS_DIR = fileURLToPath(new URL('../db/migrations/', import.meta.url));

/** Every table this stream owns. Nothing else may be obs_-prefixed (guard test). */
export const OBS_TABLES = Object.freeze([
  'obs_runs',
  'obs_spans',
  'obs_steps',
  'obs_gates',
  'obs_cache_entries',
  'obs_spend',
  'obs_acceptances',
  'obs_needs',
  'obs_grants',
]);

const CONTRACTS_DIR = fileURLToPath(new URL('../../../contracts/agentic/', import.meta.url));

/** Apply only this stream's migrations, in lexical order, idempotently. */
export function applyObservabilityMigrations(db) {
  return migrate(db, OBS_MIGRATIONS_DIR);
}

function requireOwner(ownerId) {
  if (!isNonEmptyString(ownerId)) {
    throw observabilityError(OBS_ERROR_CODES.OWNER_REQUIRED, 'an explicit ownerId is required');
  }
  return ownerId;
}

function nowIso() {
  return new Date().toISOString();
}

function jsonOr(value, fallback) {
  if (value === undefined || value === null) return JSON.stringify(fallback);
  return JSON.stringify(value);
}

function parseJsonOr(text, fallback) {
  if (typeof text !== 'string' || text.length === 0) return fallback;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function assertSchema(value, schemaName) {
  const schema = loadSchema(schemaName, CONTRACTS_DIR);
  const result = validate(value, schema, { schemaDir: CONTRACTS_DIR });
  if (!result.valid) {
    const failure = new Error(
      `CONTRACT_INVALID: ${result.errors.map((item) => `${item.path} ${item.message}`).join('; ')}`,
    );
    failure.code = 'CONTRACT_INVALID';
    failure.errors = result.errors;
    throw failure;
  }
  return value;
}

export function createObservabilityStore({ db } = {}) {
  if (!db) throw observabilityError(OBS_ERROR_CODES.INVALID_ARGUMENT, 'a database handle is required');

  const insertSpanStmt = db.prepare(`
    INSERT INTO obs_spans (
      id, owner_id, run_id, parent_id, name, kind, started_at, ended_at, status,
      input_ref, output_ref, error, attributes_json, request_model, actor_role,
      actor_model, resolved_model, model_source, model_local, provenance
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const selectSpanStmt = db.prepare('SELECT * FROM obs_spans WHERE owner_id = ? AND id = ?');

  return {
    db,

    // --- spans -------------------------------------------------------------

    /**
     * Insert one already-projected span row. Duplicate ids are idempotent (N3):
     * the original row is kept untouched and the caller is told it was a
     * duplicate. A duplicate id owned by somebody else is a hard rejection.
     */
    insertSpan(projected, { ownerId, runId } = {}) {
      const owner = requireOwner(ownerId);
      const existing = selectSpanStmt.get(owner, projected.id);
      if (existing) return { inserted: false, duplicate: true, id: projected.id };

      const foreign = db.prepare('SELECT owner_id FROM obs_spans WHERE id = ?').get(projected.id);
      if (foreign) {
        throw observabilityError(
          OBS_ERROR_CODES.SPAN_OWNER_MISMATCH,
          'span id already belongs to another owner',
          { id: projected.id },
        );
      }

      insertSpanStmt.run(
        projected.id,
        owner,
        runId ?? projected.runId ?? null,
        projected.parentId ?? null,
        projected.name,
        projected.kind,
        projected.startedAt,
        projected.endedAt ?? null,
        projected.status,
        projected.inputRef ?? null,
        projected.outputRef ?? null,
        projected.error ?? null,
        jsonOr(projected.attributes, {}),
        projected.requestModel ?? null,
        projected.actorRole ?? null,
        projected.actorModel ?? null,
        projected.resolvedModel ?? null,
        projected.modelSource ?? null,
        projected.modelLocal === undefined || projected.modelLocal === null
          ? null
          : Number(projected.modelLocal),
        projected.provenance ?? 'UNKNOWN',
      );
      return { inserted: true, duplicate: false, id: projected.id };
    },

    getSpan(ownerId, id) {
      return selectSpanStmt.get(requireOwner(ownerId), id) ?? null;
    },

    listSpans(ownerId) {
      return db
        .prepare('SELECT * FROM obs_spans WHERE owner_id = ? ORDER BY started_at, id')
        .all(requireOwner(ownerId));
    },

    listRunSpans(ownerId, runId) {
      return db
        .prepare('SELECT * FROM obs_spans WHERE owner_id = ? AND run_id = ? ORDER BY started_at, id')
        .all(requireOwner(ownerId), runId);
    },

    countSpans(ownerId) {
      const row = db.prepare('SELECT COUNT(*) AS n FROM obs_spans WHERE owner_id = ?').get(requireOwner(ownerId));
      return Number(row.n);
    },

    // --- runs --------------------------------------------------------------

    /** Validate against frozen `run.schema.json`, then upsert by run id. */
    upsertRun(run, { ownerId } = {}) {
      const owner = requireOwner(ownerId);
      assertSchema(run, 'run.schema.json');
      const existing = db.prepare('SELECT id FROM obs_runs WHERE owner_id = ? AND id = ?').get(owner, run.id);
      const provenance = run.provenance?.provenance ?? run.provenanceStatus ?? 'UNKNOWN';
      if (existing) {
        db.prepare(`
          UPDATE obs_runs
             SET mission_id = ?, contract_hash = ?, state = ?, started_at = ?, updated_at = ?,
                 finished_at = ?, current_step_id = ?, provenance = ?
           WHERE owner_id = ? AND id = ?
        `).run(
          run.missionId,
          run.contractHash,
          run.state,
          run.startedAt,
          run.updatedAt,
          run.finishedAt ?? null,
          run.currentStepId ?? null,
          provenance,
          owner,
          run.id,
        );
        return { inserted: false, updated: true, id: run.id };
      }
      db.prepare(`
        INSERT INTO obs_runs (id, owner_id, mission_id, contract_hash, state, started_at, updated_at,
                              finished_at, current_step_id, provenance)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        run.id,
        owner,
        run.missionId,
        run.contractHash,
        run.state,
        run.startedAt,
        run.updatedAt,
        run.finishedAt ?? null,
        run.currentStepId ?? null,
        provenance,
      );
      return { inserted: true, updated: false, id: run.id };
    },

    getRun(ownerId, id) {
      return db.prepare('SELECT * FROM obs_runs WHERE owner_id = ? AND id = ?').get(requireOwner(ownerId), id) ?? null;
    },

    countRuns(ownerId) {
      const row = db.prepare('SELECT COUNT(*) AS n FROM obs_runs WHERE owner_id = ?').get(requireOwner(ownerId));
      return Number(row.n);
    },

    listRuns(ownerId) {
      return db
        .prepare('SELECT * FROM obs_runs WHERE owner_id = ? ORDER BY started_at, id')
        .all(requireOwner(ownerId));
    },

    // --- gates -------------------------------------------------------------

    /** Upsert keyed on (owner, stream, name, head): same gate re-recorded updates in place (N4). */
    upsertGate(gate) {
      const owner = requireOwner(gate?.ownerId);
      validateGate(gate);
      const evidence = jsonOr(gate.evidence, []);
      const coverage = gate.coverage ? JSON.stringify(gate.coverage) : null;
      const timestamp = gate.recordedAt ?? nowIso();
      const existing = db
        .prepare('SELECT 1 AS found FROM obs_gates WHERE owner_id = ? AND stream = ? AND name = ? AND head = ?')
        .get(owner, gate.stream, gate.name, gate.head);

      if (existing) {
        db.prepare(`
          UPDATE obs_gates
             SET kind = ?, command = ?, rc = ?, passed = ?, failed = ?, skipped = ?,
                 duration_ms = ?, coverage_json = ?, contract_commit = ?, evidence_json = ?, updated_at = ?
           WHERE owner_id = ? AND stream = ? AND name = ? AND head = ?
        `).run(
          gate.kind ?? null,
          gate.command,
          gate.rc,
          gate.passed ?? 0,
          gate.failed ?? 0,
          gate.skipped ?? 0,
          gate.durationMs ?? null,
          coverage,
          gate.contractCommit ?? null,
          evidence,
          timestamp,
          owner,
          gate.stream,
          gate.name,
          gate.head,
        );
        return { inserted: false, updated: true };
      }

      db.prepare(`
        INSERT INTO obs_gates (owner_id, stream, name, head, kind, command, rc, passed, failed,
                               skipped, duration_ms, coverage_json, contract_commit, evidence_json,
                               recorded_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        owner,
        gate.stream,
        gate.name,
        gate.head,
        gate.kind ?? null,
        gate.command,
        gate.rc,
        gate.passed ?? 0,
        gate.failed ?? 0,
        gate.skipped ?? 0,
        gate.durationMs ?? null,
        coverage,
        gate.contractCommit ?? null,
        evidence,
        timestamp,
        timestamp,
      );
      return { inserted: true, updated: false };
    },

    listGates(ownerId, { stream, head } = {}) {
      const owner = requireOwner(ownerId);
      const clauses = ['owner_id = ?'];
      const params = [owner];
      if (stream !== undefined) {
        clauses.push('stream = ?');
        params.push(stream);
      }
      if (head !== undefined) {
        clauses.push('head = ?');
        params.push(head);
      }
      return db
        .prepare(`SELECT * FROM obs_gates WHERE ${clauses.join(' AND ')} ORDER BY stream, name, head`)
        .all(...params);
    },

    countGates(ownerId) {
      const row = db.prepare('SELECT COUNT(*) AS n FROM obs_gates WHERE owner_id = ?').get(requireOwner(ownerId));
      return Number(row.n);
    },

    // --- cache identity ----------------------------------------------------

    /** Idempotent on (owner, key): the latest assessment replaces the old one. */
    upsertCacheEntry(entry) {
      const owner = requireOwner(entry?.ownerId);
      const timestamp = entry.updatedAt ?? nowIso();
      const stale = entry.stale === true ? 1 : 0;
      const existing = db
        .prepare('SELECT 1 AS found FROM obs_cache_entries WHERE owner_id = ? AND key = ?')
        .get(owner, entry.key);
      const values = [
        entry.kind,
        entry.contractHash,
        entry.blockRevision,
        entry.model,
        entry.effort,
        entry.inputsHash,
        entry.modelSource,
        entry.freshness ?? 'UNKNOWN',
        stale,
        jsonOr(entry.reasons, []),
        entry.createdAt ?? null,
        timestamp,
      ];

      if (existing) {
        db.prepare(`
          UPDATE obs_cache_entries
             SET kind = ?, contract_hash = ?, block_revision = ?, model = ?, effort = ?, inputs_hash = ?,
                 model_source = ?, freshness = ?, stale = ?, reasons_json = ?, created_at = ?, updated_at = ?
           WHERE owner_id = ? AND key = ?
        `).run(...values, owner, entry.key);
        return { inserted: false, updated: true, key: entry.key };
      }

      db.prepare(`
        INSERT INTO obs_cache_entries (kind, contract_hash, block_revision, model, effort, inputs_hash,
                                       model_source, freshness, stale, reasons_json, created_at, updated_at,
                                       owner_id, key)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(...values, owner, entry.key);
      return { inserted: true, updated: false, key: entry.key };
    },

    listCacheEntries(ownerId) {
      return db
        .prepare('SELECT * FROM obs_cache_entries WHERE owner_id = ? ORDER BY key')
        .all(requireOwner(ownerId));
    },

    /** Only stale rows: a fresh or unverifiable entry is not "stale". */
    listStaleCacheEntries(ownerId) {
      return db
        .prepare('SELECT * FROM obs_cache_entries WHERE owner_id = ? AND stale = 1 ORDER BY key')
        .all(requireOwner(ownerId));
    },

    // --- spend -------------------------------------------------------------

    /** `costCny` missing stays NULL; an explicit 0 stays 0 (N6). */
    recordSpend(entry) {
      const owner = requireOwner(entry?.ownerId);
      assertSchema(
        {
          calls: entry.calls,
          tokens: entry.tokens,
          ...(entry.costCny === undefined || entry.costCny === null ? {} : { costCny: entry.costCny }),
          ...(entry.localShare === undefined || entry.localShare === null ? {} : { localShare: entry.localShare }),
        },
        'spend.schema.json',
      );
      db.prepare(`
        INSERT INTO obs_spend (owner_id, run_id, step_id, attempt, calls, tokens, cost_cny, local_share, recorded_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        owner,
        entry.runId,
        entry.stepId,
        entry.attempt ?? 0,
        entry.calls,
        entry.tokens,
        entry.costCny === undefined ? null : entry.costCny,
        entry.localShare === undefined ? null : entry.localShare,
        entry.recordedAt ?? nowIso(),
      );
      return { recorded: true };
    },

    listSpend(ownerId, runId) {
      const owner = requireOwner(ownerId);
      if (runId === undefined) {
        return db.prepare('SELECT * FROM obs_spend WHERE owner_id = ? ORDER BY id').all(owner);
      }
      return db.prepare('SELECT * FROM obs_spend WHERE owner_id = ? AND run_id = ? ORDER BY id').all(owner, runId);
    },

    // --- read-only W0 observation projections ------------------------------

    recordAcceptance(entry) {
      const owner = requireOwner(entry?.ownerId);
      db.prepare(`
        INSERT INTO obs_acceptances (id, owner_id, artifact_id, actor, decision, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET decision = excluded.decision
      `).run(entry.id, owner, entry.artifactId ?? null, entry.actor ?? null, entry.decision, entry.createdAt ?? nowIso());
      return { recorded: true };
    },

    recordNeed(entry) {
      const owner = requireOwner(entry?.ownerId);
      db.prepare(`
        INSERT INTO obs_needs (id, owner_id, mission_id, status, due_at, answered_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET status = excluded.status
      `).run(entry.id, owner, entry.missionId ?? null, entry.status, entry.dueAt ?? null, entry.answeredAt ?? null);
      return { recorded: true };
    },

    recordGrant(entry) {
      const owner = requireOwner(entry?.ownerId);
      db.prepare(`
        INSERT INTO obs_grants (id, owner_id, status, expires_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET status = excluded.status
      `).run(entry.id, owner, entry.status, entry.expiresAt ?? null, entry.updatedAt ?? nowIso());
      return { recorded: true };
    },
  };
}

export { parseJsonOr };
