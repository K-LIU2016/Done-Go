// S2D-W6 module 3 preview-store (.s2d/plan.md:52): the immutable, per-mission
// Preview version chain behind scripts/agentic/db/migrations/preview-001-store.sql.
//
// Guarantees (tests/unit/agentic/preview/store.test.mjs is the spec):
//   * Immutable versions — put() assigns the next version for
//     (owner_id, mission_id) itself (MAX(version) over ALL rows, soft-deleted
//     included, so a number is never recycled onto a deleted row); the stored
//     payload's `version` field is rewritten to the assigned number. Rows are
//     never updated after insert (UNIQUE(owner_id, mission_id, version) is the
//     last line of defense for multi-process file databases).
//   * Owner scoping — every query filters owner_id; a foreign owner observes
//     null/[]/NOT_FOUND and can never distinguish "missing" from "someone
//     else's" (contract README:52 — no existence leak).
//   * Optimistic concurrency — an optional baseVersion must equal the current
//     live version or the write fails CONFLICT having written nothing.
//   * Fail-closed reads — every read-out payload re-validates against the
//     FROZEN preview.schema.json via assertPreviewRoundTrip, so a corrupted or
//     torn row surfaces as CONTRACT_INVALID instead of a plausible Preview.
//   * Crash safety — put/softDelete run inside BEGIN IMMEDIATE transactions;
//     a failure anywhere rolls back the whole write (no orphan versions).
//
// Hard rules (CTO-DECISIONS-2026-10-27 §2.3, plan §1/§2):
//   * The frozen contract is read-only input; W11 playback fields are consumed
//     downstream through the timeline projection, never persisted here.
//   * P0→contracted: no external side effects in this module (no network, no
//     model calls, no clock reads — `now` is injected).
//   * The clock is injectable for determinism; ids are random UUIDs.
import { randomUUID } from 'node:crypto';
import { canonicalJson } from '../contracts.mjs';
import { assertPreviewRoundTrip, assertValidPreview } from './validate.mjs';

const SELECT_COLUMNS = `
  SELECT id, owner_id, mission_id, version, revision, payload, created_at, updated_at
`;

function fail(code, message, extra = {}) {
  const failure = new Error(`${code}: ${message}`);
  failure.code = code;
  for (const [key, value] of Object.entries(extra)) failure[key] = value;
  throw failure;
}

function requireScope(ownerId, missionId) {
  if (typeof ownerId !== 'string' || ownerId.length === 0) {
    fail('CONTRACT_INVALID', 'ownerId must be a non-empty string');
  }
  if (typeof missionId !== 'string' || missionId.length === 0) {
    fail('CONTRACT_INVALID', 'missionId must be a non-empty string');
  }
}

function requireVersion(version) {
  if (!Number.isInteger(version) || version < 1) {
    fail('CONTRACT_INVALID', 'version must be an integer >= 1');
  }
}

/** Validate a stored row's payload (fail closed) and shape it as a plain record. */
function rowFromDb(row) {
  return {
    id: row.id,
    ownerId: row.owner_id,
    missionId: row.mission_id,
    version: row.version,
    revision: row.revision,
    preview: assertPreviewRoundTrip(row.payload),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Sentinel for withTransaction: fn returns `new TransactionRollback(value)`
 * to roll the transaction back WITHOUT failing — the writes unwind, but the
 * coordinator still receives `value` (used when an idempotency replay races
 * the turn inside the shared transaction and the derived writes must vanish).
 */
export class TransactionRollback {
  constructor(value) {
    this.value = value;
  }
}

export function createPreviewStore(db, options = {}) {
  const now = typeof options.now === 'function' ? options.now : () => new Date().toISOString();

  const statements = {
    maxVersion: db.prepare(`
      SELECT MAX(version) AS max_version FROM previews
      WHERE owner_id = ? AND mission_id = ?
    `),
    latestLive: db.prepare(`
      ${SELECT_COLUMNS} FROM previews
      WHERE owner_id = ? AND mission_id = ? AND deleted_at IS NULL
      ORDER BY version DESC LIMIT 1
    `),
    byVersionLive: db.prepare(`
      ${SELECT_COLUMNS} FROM previews
      WHERE owner_id = ? AND mission_id = ? AND version = ? AND deleted_at IS NULL
    `),
    listLive: db.prepare(`
      ${SELECT_COLUMNS} FROM previews
      WHERE owner_id = ? AND mission_id = ? AND deleted_at IS NULL
      ORDER BY version ASC
    `),
    insert: db.prepare(`
      INSERT INTO previews (id, owner_id, mission_id, version, payload, revision, created_at, updated_at, deleted_at)
      VALUES (?, ?, ?, ?, ?, 1, ?, ?, NULL)
    `),
    markDeleted: db.prepare(`
      UPDATE previews SET deleted_at = ?, updated_at = ? WHERE id = ?
    `),
  };

  /** Pre-write validation for a version insert (pure; no writes, no txn). */
  function validateForPut({ ownerId, missionId, preview, baseVersion } = {}) {
    requireScope(ownerId, missionId);
    if (preview === null || typeof preview !== 'object' || Array.isArray(preview)) {
      fail('CONTRACT_INVALID', 'preview must be an object');
    }
    // Frozen-schema gate before anything is written (W0 preview.schema.json).
    assertValidPreview(preview);
    if (preview.missionId !== missionId) {
      fail('CONTRACT_INVALID', 'preview.missionId does not match the target missionId');
    }
    if (baseVersion !== undefined) requireVersion(baseVersion);
  }

  /**
   * In-transaction body of a version insert: stale-base check, version
   * assignment and the INSERT itself. The CALLER owns the surrounding
   * BEGIN IMMEDIATE/COMMIT — either put() for a standalone version write, or
   * the shared multi-store transaction (withTransaction) through which
   * discussion/apply.mjs lands the preview version, the discussion message
   * and the contract change record in ONE commit (remediation blocker A).
   */
  function writeVersion({ ownerId, missionId, preview, baseVersion } = {}) {
    try {
      const live = statements.latestLive.get(ownerId, missionId) ?? null;
      if (baseVersion !== undefined && (live === null || live.version !== baseVersion)) {
        // Stale base (someone wrote a newer version, or the base never existed):
        // reject before touching anything; the caller's transaction rolls back.
        fail('CONFLICT', `baseVersion ${baseVersion} is stale; current version is ${live === null ? null : live.version}`, {
          currentVersion: live === null ? null : live.version,
        });
      }
      // Include soft-deleted rows so a deleted version number is never reused.
      const maxVersion = statements.maxVersion.get(ownerId, missionId).max_version;
      const version = (maxVersion === null ? 0 : maxVersion) + 1;
      const stored = { ...preview, version };
      const id = randomUUID();
      const timestamp = now();
      statements.insert.run(id, ownerId, missionId, version, canonicalJson(stored), timestamp, timestamp);
      return {
        id,
        ownerId,
        missionId,
        version,
        revision: 1,
        preview: stored,
        createdAt: timestamp,
        updatedAt: timestamp,
        deletedAt: null,
      };
    } catch (error) {
      // A UNIQUE hit means another process inserted the same version between
      // our SELECT and INSERT: that is a concurrency conflict, not corruption.
      if (error && error.code === undefined && /UNIQUE/i.test(String(error.message))) {
        fail('CONFLICT', 'concurrent write assigned the same preview version');
      }
      throw error;
    }
  }

  /**
   * Run `fn` (synchronous store calls only) inside ONE BEGIN IMMEDIATE /
   * COMMIT on this store's database; any throw rolls everything back and
   * rethrows. This is the shared transaction coordination path (remediation
   * blocker A): discussion/apply.mjs writes the preview version, the
   * discussion message and the contract change record through store txn
   * seams INSIDE this single transaction, so no crash window can leave a
   * moved preview boundary without its message and change record. fn may
   * return a TransactionRollback to discard the writes without failing.
   */
  function withTransaction(fn) {
    db.exec('BEGIN IMMEDIATE');
    let result;
    try {
      result = fn();
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // Connection already rolled back; surface the original error.
      }
      throw error;
    }
    if (result instanceof TransactionRollback) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // see above
      }
      return result.value;
    }
    try {
      db.exec('COMMIT');
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // see above
      }
      throw error;
    }
    return result;
  }

  async function put(params = {}) {
    validateForPut(params);
    return withTransaction(() => writeVersion(params));
  }

  async function get({ ownerId, missionId, version } = {}) {
    requireScope(ownerId, missionId);
    requireVersion(version);
    const row = statements.byVersionLive.get(ownerId, missionId, version) ?? null;
    return row === null ? null : rowFromDb(row);
  }

  async function latest({ ownerId, missionId } = {}) {
    requireScope(ownerId, missionId);
    const row = statements.latestLive.get(ownerId, missionId) ?? null;
    return row === null ? null : rowFromDb(row);
  }

  async function list({ ownerId, missionId } = {}) {
    requireScope(ownerId, missionId);
    return statements.listLive.all(ownerId, missionId).map(rowFromDb);
  }

  async function softDelete({ ownerId, missionId, version } = {}) {
    requireScope(ownerId, missionId);
    requireVersion(version);
    const timestamp = now();
    db.exec('BEGIN IMMEDIATE');
    try {
      // Live rows only: deleting an already-deleted (or absent, or foreign)
      // version is NOT_FOUND — no existence information crosses owners.
      const row = statements.byVersionLive.get(ownerId, missionId, version) ?? null;
      if (row === null) {
        fail('NOT_FOUND', `no live preview version ${version} for this owner and mission`);
      }
      statements.markDeleted.run(timestamp, timestamp, row.id);
      db.exec('COMMIT');
      return { id: row.id, ownerId, missionId, version, deletedAt: timestamp };
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // Connection already rolled back; surface the original error.
      }
      throw error;
    }
  }

  return {
    put,
    get,
    latest,
    list,
    softDelete,
    // Shared-transaction coordination (remediation blocker A): apply.mjs runs
    // a whole discussion turn — preview version + discussion message +
    // contract change record — inside ONE withTransaction via these
    // in-transaction seams. txn.putVersion validates then writes WITHOUT
    // managing its own transaction.
    withTransaction,
    txn: {
      putVersion: params => {
        validateForPut(params);
        return writeVersion(params);
      },
    },
  };
}
