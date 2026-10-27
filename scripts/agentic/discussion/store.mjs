// S2D-W6 module 4: discussion-store (.s2d/plan.md:53) — append-only discussion
// threads and messages per (owner, mission).
//
// - One thread per (owner_id, mission_id), created implicitly by the first
//   message; messages are append-only rows carrying the actor's utterance, the
//   parsed MissionPatch (nullable: plain chatter or a parse failure leaves no
//   patch) and the before/after preview versions (after NULL until a new
//   version exists).
// - Idempotency: (owner_id, idempotency_key) UNIQUE. appendMessage first
//   looks the key up and returns the stored message with replayed:true — the
//   replay check runs BEFORE input validation so a drifted retry (e.g. a
//   re-sent utterance) still collapses onto the original turn. A second
//   in-transaction re-check guards the cross-process window.
// - "讨论不改变合同而无记录" (CTO-DECISIONS-2026-10-27 §4 W6 row): when the
//   caller reports a contract-relevant change, the contract_change_records row
//   is written in the SAME transaction as the message. The record's patch
//   column is NOT NULL, so a null contract patch aborts the whole transaction
//   (thread + message + record roll back together) — an unrecorded contract
//   change is unreachable at the storage layer.
// - Storage only: no HTTP, no external calls, no clock reads (now is
//   injected), no preview validation (that is preview/validate.mjs and
//   discussion/apply.mjs). Owner scoping is enforced on every query.
import { randomUUID } from 'node:crypto';

/** Upper bound for a single utterance (PRD §11.3 discussion input; shared with apply.mjs). */
export const MAX_UTTERANCE_LENGTH = 2000;

function contractInvalid(detail, path = '$') {
  const error = new Error(`CONTRACT_INVALID: ${detail}`);
  error.code = 'CONTRACT_INVALID';
  error.errors = [{ path, message: detail }];
  return error;
}

function requireNonEmptyString(value, name) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw contractInvalid(`${name} must be a non-empty string`, `$.${name}`);
  }
}

function requirePositiveInteger(value, name, allowNull) {
  if (value == null) {
    if (allowNull) return;
    throw contractInvalid(`${name} is required`, `$.${name}`);
  }
  if (!Number.isInteger(value) || value < 1) {
    throw contractInvalid(`${name} must be a positive integer`, `$.${name}`);
  }
}

/** JSON text for storage; null/undefined both map to SQL NULL. */
function toJson(value) {
  return value === undefined || value === null ? null : JSON.stringify(value);
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
 * Create the discussion store over an already-migrated Agentic database
 * (preview-002-discussion.sql). `options.now` supplies ISO timestamps; it is
 * injected so tests are deterministic and request paths never read the clock.
 */
export function createDiscussionStore(db, options = {}) {
  const now = options?.now ?? (() => new Date().toISOString());

  const statements = {
    findMessageByKey: db.prepare(
      'SELECT * FROM discussion_messages WHERE owner_id = ? AND idempotency_key = ?',
    ),
    insertThread: db.prepare(
      `INSERT INTO discussion_threads (id, owner_id, mission_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (owner_id, mission_id) DO NOTHING`,
    ),
    findThread: db.prepare(
      'SELECT * FROM discussion_threads WHERE owner_id = ? AND mission_id = ?',
    ),
    touchThread: db.prepare(
      'UPDATE discussion_threads SET updated_at = ? WHERE id = ?',
    ),
    insertMessage: db.prepare(
      `INSERT INTO discussion_messages
         (id, owner_id, thread_id, mission_id, base_version, utterance, patch,
          before_version, after_version, actor, idempotency_key, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    listMessages: db.prepare(
      `SELECT * FROM discussion_messages
       WHERE owner_id = ? AND thread_id = ?
       ORDER BY created_at ASC, rowid ASC`,
    ),
    insertChangeRecord: db.prepare(
      `INSERT INTO contract_change_records
         (id, owner_id, mission_id, message_id, before_version, after_version,
          patch, changed_fields, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    listChangeRecords: db.prepare(
      `SELECT * FROM contract_change_records
       WHERE owner_id = ? AND mission_id = ?
       ORDER BY created_at ASC, rowid ASC`,
    ),
  };

  function rowToMessage(row, replayed) {
    return {
      id: row.id,
      ownerId: row.owner_id,
      threadId: row.thread_id,
      missionId: row.mission_id,
      baseVersion: row.base_version,
      utterance: row.utterance,
      patch: fromJson(row.patch, 'message patch'),
      beforeVersion: row.before_version,
      afterVersion: row.after_version,
      actor: row.actor,
      idempotencyKey: row.idempotency_key,
      createdAt: row.created_at,
      replayed,
    };
  }

  function validateAppend(params) {
    requireNonEmptyString(params.ownerId, 'ownerId');
    requireNonEmptyString(params.missionId, 'missionId');
    requireNonEmptyString(params.actor, 'actor');
    requireNonEmptyString(params.idempotencyKey, 'idempotencyKey');
    requireNonEmptyString(params.utterance, 'utterance');
    if (params.utterance.length > MAX_UTTERANCE_LENGTH) {
      throw contractInvalid(`utterance must be at most ${MAX_UTTERANCE_LENGTH} characters`, '$.utterance');
    }
    requirePositiveInteger(params.baseVersion, 'baseVersion', false);
    requirePositiveInteger(params.beforeVersion, 'beforeVersion', false);
    requirePositiveInteger(params.afterVersion, 'afterVersion', true);
    if (params.patch !== undefined && params.patch !== null) {
      if (typeof params.patch !== 'object' || Array.isArray(params.patch)) {
        throw contractInvalid('patch must be a MissionPatch object or null', '$.patch');
      }
    }
    if (params.contractChange !== undefined && params.contractChange !== null) {
      const { patch, changedFields } = params.contractChange;
      if (patch !== undefined && patch !== null && (typeof patch !== 'object' || Array.isArray(patch))) {
        throw contractInvalid('contractChange.patch must be an object', '$.contractChange.patch');
      }
      // A null contractChange.patch is NOT rejected here on purpose: the
      // NOT NULL constraint on contract_change_records.patch aborts the
      // transaction, which is the atomicity guarantee under test.
      if (
        !Array.isArray(changedFields)
        || changedFields.length === 0
        || changedFields.some(field => typeof field !== 'string' || field.trim() === '')
      ) {
        throw contractInvalid(
          'contractChange.changedFields must be a non-empty array of field paths',
          '$.contractChange.changedFields',
        );
      }
    }
  }

  function existingMessageOrReplay(ownerId, idempotencyKey) {
    const existing = statements.findMessageByKey.get(ownerId, idempotencyKey);
    return existing ? rowToMessage(existing, true) : null;
  }

  /**
   * Append one discussion turn. Implicitly creates the (owner, mission)
   * thread. When `contractChange` is given ({patch, changedFields}), the
   * contract_change_records row lands in the same transaction — any failure
   * (including a null contract patch hitting the NOT NULL column) rolls the
   * whole append back. Returns the stored message with `replayed:false`, or
   * the previously stored message with `replayed:true` when the
   * (owner_id, idempotency_key) already exists.
   *
   * Async by contract: callers await it, and failures must surface as
   * rejections (not synchronous throws) so HTTP routes can map them onto the
   * api-error envelope.
   */
  async function appendMessage(params) {
    const replay = existingMessageOrReplay(params.ownerId, params.idempotencyKey);
    if (replay) return replay;

    validateAppend(params);

    const messageId = randomUUID();
    const recordId = randomUUID();
    const createdAt = now();
    // Filled inside the transaction: the thread the message lands in (an
    // existing one when the (owner, mission) thread was created by an earlier
    // turn — INSERT ... ON CONFLICT DO NOTHING keeps it).
    let storedThreadId;

    db.exec('BEGIN IMMEDIATE');
    try {
      // Re-check inside the transaction: another process may have appended
      // the same idempotency key between the pre-check and BEGIN.
      const raced = statements.findMessageByKey.get(params.ownerId, params.idempotencyKey);
      if (raced) {
        db.exec('ROLLBACK');
        return rowToMessage(raced, true);
      }

      statements.insertThread.run(randomUUID(), params.ownerId, params.missionId, createdAt, createdAt);
      const thread = statements.findThread.get(params.ownerId, params.missionId);
      storedThreadId = thread.id;

      statements.insertMessage.run(
        messageId,
        params.ownerId,
        thread.id,
        params.missionId,
        params.baseVersion,
        params.utterance,
        toJson(params.patch),
        params.beforeVersion,
        params.afterVersion ?? null,
        params.actor,
        params.idempotencyKey,
        createdAt,
      );

      if (params.contractChange !== undefined && params.contractChange !== null) {
        statements.insertChangeRecord.run(
          recordId,
          params.ownerId,
          params.missionId,
          messageId,
          params.beforeVersion,
          params.afterVersion,
          toJson(params.contractChange.patch), // null patch → SQL NULL → NOT NULL aborts the transaction
          JSON.stringify(params.contractChange.changedFields),
          createdAt,
        );
      }

      statements.touchThread.run(createdAt, thread.id);
      db.exec('COMMIT');
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // Keep the original error even if the connection is already closed.
      }
      throw error;
    }

    return {
      id: messageId,
      ownerId: params.ownerId,
      threadId: storedThreadId,
      missionId: params.missionId,
      baseVersion: params.baseVersion,
      utterance: params.utterance,
      patch: params.patch ?? null,
      beforeVersion: params.beforeVersion,
      afterVersion: params.afterVersion ?? null,
      actor: params.actor,
      idempotencyKey: params.idempotencyKey,
      createdAt,
      replayed: false,
    };
  }

  /**
   * Read the (owner, mission) thread with all its messages in append order,
   * or null when no turn was ever recorded. Messages from other owners are
   * never visible (owner_id is part of every predicate).
   */
  function getThread({ ownerId, missionId }) {
    const thread = statements.findThread.get(ownerId, missionId);
    if (!thread) return null;
    const messages = statements.listMessages.all(ownerId, thread.id).map(row => rowToMessage(row, false));
    return {
      id: thread.id,
      ownerId: thread.owner_id,
      missionId: thread.mission_id,
      createdAt: thread.created_at,
      updatedAt: thread.updated_at,
      messages,
    };
  }

  /**
   * Contract change records for the (owner, mission) discussion, oldest
   * first: every contract-relevant patch that ever landed, with the message
   * that caused it and the before/after preview version pair.
   */
  function listChangeRecords({ ownerId, missionId }) {
    return statements.listChangeRecords.all(ownerId, missionId).map(row => ({
      id: row.id,
      ownerId: row.owner_id,
      missionId: row.mission_id,
      messageId: row.message_id,
      beforeVersion: row.before_version,
      afterVersion: row.after_version,
      patch: fromJson(row.patch, 'change-record patch'),
      changedFields: fromJson(row.changed_fields, 'change-record changed_fields'),
      createdAt: row.created_at,
    }));
  }

  return { appendMessage, getThread, listChangeRecords };
}
