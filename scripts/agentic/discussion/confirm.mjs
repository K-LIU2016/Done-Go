// S2D-W6 module 8: confirm-entry (.s2d/plan.md:57) — the 确认入口 on a preview
// version (PRD §5.3 boundary card → 签约意图).
//
// record() persists one decision (confirm / request_change / decline) bound to
// (owner, mission, previewVersion, actor) in preview_confirmations
// (preview-002-discussion.sql). It NEVER touches missions or contracts:
//   * "confirm" additionally stores a contract-draft-request EVENT (the W3
//     interface, CTO-BATCH2-BRIEF §3) as JSON in the row's event column;
//   * request_change / decline record the decision only (event NULL);
//   * P0→contracted: no external side effect is triggered from here — no
//     network, no model call, no clock read (`now` is injected). The event is
//     a stored record, not a dispatch (confirm.test.mjs side-effect boundary).
//
// Idempotency (plan §2 重复): the UNIQUE (owner_id, mission_id,
// preview_version, actor, decision) key IS the idempotency key. Replaying the
// same decision returns the stored record with replayed:true — looked up
// BEFORE the live-version check, so a retry still replays after the version
// was later soft-deleted (a recorded decision is history, not preview state).
// The only non-key field, `note`, never overwrites: the stored value wins.
//
// Fail-closed reads: the stored event JSON is re-parsed on the way out; a
// corrupted row surfaces as CONTRACT_INVALID, never as a plausible event.
//
// Async by contract: failures surface as rejections (not synchronous throws)
// so HTTP routes (module 9) can map them onto the frozen api-error envelope.
import { randomUUID } from 'node:crypto';
import { canonicalJson } from '../contracts.mjs';

/** The only decisions the 确认入口 accepts (CHECK constraint in preview-002). */
export const CONFIRM_DECISIONS = ['confirm', 'request_change', 'decline'];

/** Event type emitted (stored) on confirm — the W3-facing interface name. */
export const CONTRACT_DRAFT_REQUEST_EVENT = 'contract-draft-request';

/** Upper bound for the free-form note, mirroring MAX_UTTERANCE_LENGTH. */
export const MAX_NOTE_LENGTH = 2000;

function contractInvalid(detail, path = '$') {
  const error = new Error(`CONTRACT_INVALID: ${detail}`);
  error.code = 'CONTRACT_INVALID';
  error.errors = [{ path, message: detail }];
  return error;
}

function notFound(detail) {
  const error = new Error(`NOT_FOUND: ${detail}`);
  error.code = 'NOT_FOUND';
  return error;
}

function requireNonEmptyString(value, name) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw contractInvalid(`${name} must be a non-empty string`, `$.${name}`);
  }
}

/** Parse stored JSON text; fail closed on corruption instead of leaking SyntaxError. */
function fromJson(text, column) {
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch (error) {
    throw contractInvalid(`stored ${column} is not parseable JSON: ${error.message}`);
  }
}

/**
 * Create the confirmation entry over an already-migrated Agentic database
 * (preview-002-discussion.sql). `options.now` supplies ISO timestamps; it is
 * injected so tests are deterministic and request paths never read the clock.
 */
export function createConfirmEntry(db, options = {}) {
  const now = options?.now ?? (() => new Date().toISOString());

  const statements = {
    findByKey: db.prepare(
      `SELECT * FROM preview_confirmations
       WHERE owner_id = ? AND mission_id = ? AND preview_version = ? AND actor = ? AND decision = ?`,
    ),
    liveVersion: db.prepare(
      'SELECT 1 AS ok FROM previews WHERE owner_id = ? AND mission_id = ? AND version = ? AND deleted_at IS NULL',
    ),
    insert: db.prepare(
      `INSERT INTO preview_confirmations
         (id, owner_id, mission_id, preview_version, actor, decision, note, event, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    listByMission: db.prepare(
      `SELECT * FROM preview_confirmations
       WHERE owner_id = ? AND mission_id = ?
       ORDER BY created_at ASC, rowid ASC`,
    ),
  };

  function rowToRecord(row, replayed) {
    return {
      id: row.id,
      ownerId: row.owner_id,
      missionId: row.mission_id,
      previewVersion: row.preview_version,
      actor: row.actor,
      decision: row.decision,
      note: row.note,
      event: fromJson(row.event, 'confirmation event'),
      createdAt: row.created_at,
      replayed,
    };
  }

  function existingRecordOrReplay(ownerId, missionId, previewVersion, actor, decision) {
    const existing = statements.findByKey.get(ownerId, missionId, previewVersion, actor, decision);
    return existing ? rowToRecord(existing, true) : null;
  }

  /**
   * Record one decision on a preview version.
   *
   * Validation order matters: the identity-key shape (CONTRACT_INVALID) is
   * checked first so malformed keys can never bind; then the replay lookup —
   * a drifted retry (different note) collapses onto the stored record; then
   * the note shape; and only then the live-version existence check, so a
   * well-formed request for a missing/foreign/soft-deleted version observes
   * NOT_FOUND with zero existence leakage across owners.
   */
  async function record(params) {
    requireNonEmptyString(params.ownerId, 'ownerId');
    requireNonEmptyString(params.missionId, 'missionId');
    requireNonEmptyString(params.actor, 'actor');
    if (!Number.isInteger(params.previewVersion) || params.previewVersion < 1) {
      throw contractInvalid('previewVersion must be an integer >= 1', '$.previewVersion');
    }
    if (!CONFIRM_DECISIONS.includes(params.decision)) {
      throw contractInvalid(
        `decision must be one of ${CONFIRM_DECISIONS.map(value => `'${value}'`).join(', ')}`,
        '$.decision',
      );
    }
    if (params.note !== undefined && params.note !== null) {
      if (typeof params.note !== 'string') {
        throw contractInvalid('note must be a string or null', '$.note');
      }
      if (params.note.length > MAX_NOTE_LENGTH) {
        throw contractInvalid(`note must be at most ${MAX_NOTE_LENGTH} characters`, '$.note');
      }
    }

    const replay = existingRecordOrReplay(
      params.ownerId, params.missionId, params.previewVersion, params.actor, params.decision,
    );
    if (replay) return replay;

    const id = randomUUID();
    const createdAt = now();
    // confirm stores the contract-draft-request event for W3; the other two
    // decisions carry no event. canonicalJson keeps the stored bytes stable.
    const event = params.decision === 'confirm'
      ? {
        type: CONTRACT_DRAFT_REQUEST_EVENT,
        missionId: params.missionId,
        previewVersion: params.previewVersion,
        actor: params.actor,
        emittedAt: createdAt,
      }
      : null;

    db.exec('BEGIN IMMEDIATE');
    try {
      // Re-check inside the transaction: another process may have recorded the
      // same key between the pre-check and BEGIN — that is a replay, not a clash.
      const raced = statements.findByKey.get(
        params.ownerId, params.missionId, params.previewVersion, params.actor, params.decision,
      );
      if (raced) {
        db.exec('ROLLBACK');
        return rowToRecord(raced, true);
      }
      // The decision must bind to a live version of THIS owner's mission; a
      // soft-deleted, unknown or foreign version is uniformly NOT_FOUND.
      const live = statements.liveVersion.get(params.ownerId, params.missionId, params.previewVersion);
      if (live === undefined) {
        throw notFound(
          `no live preview version ${params.previewVersion} for this owner and mission`,
        );
      }
      statements.insert.run(
        id,
        params.ownerId,
        params.missionId,
        params.previewVersion,
        params.actor,
        params.decision,
        params.note ?? null,
        event === null ? null : canonicalJson(event),
        createdAt,
      );
      db.exec('COMMIT');
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // Connection already rolled back; surface the original error.
      }
      // A UNIQUE hit on the idempotency key means another process recorded the
      // same decision first: return their record as a replay.
      if (error && error.code === undefined && /UNIQUE/i.test(String(error.message))) {
        const winner = statements.findByKey.get(
          params.ownerId, params.missionId, params.previewVersion, params.actor, params.decision,
        );
        if (winner) return rowToRecord(winner, true);
      }
      throw error;
    }

    return {
      id,
      ownerId: params.ownerId,
      missionId: params.missionId,
      previewVersion: params.previewVersion,
      actor: params.actor,
      decision: params.decision,
      note: params.note ?? null,
      event,
      createdAt,
      replayed: false,
    };
  }

  /**
   * All decisions recorded for the (owner, mission) preview discussion, in
   * append order. Other owners' decisions are never visible (owner_id is part
   * of every predicate). The stored event JSON is re-parsed on the way out.
   */
  async function list({ ownerId, missionId }) {
    requireNonEmptyString(ownerId, 'ownerId');
    requireNonEmptyString(missionId, 'missionId');
    return statements.listByMission.all(ownerId, missionId).map(row => rowToRecord(row, false));
  }

  return { record, list };
}
