// S2D-W6 module 1: preview-migrations — preview-001-store.sql + preview-002-discussion.sql.
// These tests ARE the DDL contract between the migration SQL and the W6 stores:
// tables, owner_id NOT NULL, canonical row shapes, UNIQUE idempotency keys,
// FK enforcement and the decision CHECK. Runs the W0 migrate() runner.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { openAgenticDb, migrate } from '../../../../scripts/agentic/db/index.mjs';
import { MIGRATIONS_DIR } from './_helpers.mjs';

const PREVIEW_MIGRATIONS = ['preview-001-store.sql', 'preview-002-discussion.sql'];

function migratedDb() {
  const db = openAgenticDb(':memory:');
  migrate(db, MIGRATIONS_DIR);
  return db;
}

/** Insert a canonical previews row (the exact shape preview-store relies on). */
function insertPreview(db, { id = 'pv_1', owner = 'owner-a', mission = 'm1', version = 1, payload = '{"ok":1}' } = {}) {
  db.prepare(
    `INSERT INTO previews (id, owner_id, mission_id, version, payload, revision, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 1, '2026-10-27T10:00:00Z', '2026-10-27T10:00:00Z')`,
  ).run(id, owner, mission, version, payload);
}

test('migration files preview-001-store.sql and preview-002-discussion.sql exist', () => {
  for (const name of PREVIEW_MIGRATIONS) {
    const file = join(MIGRATIONS_DIR, name);
    assert.ok(existsSync(file), `${name} must exist at ${file}`);
    assert.ok(readFileSync(file, 'utf8').trim().length > 0, `${name} must not be empty`);
  }
});

test('migrate applies preview migrations in filename order and is idempotent', () => {
  const db = openAgenticDb(':memory:');
  try {
    const applied = migrate(db, MIGRATIONS_DIR);
    const previewApplied = applied.filter(name => name.startsWith('preview-'));
    assert.deepEqual(previewApplied, PREVIEW_MIGRATIONS);
    // Rerun: nothing new, ledger intact (duplicate replay is a no-op).
    assert.deepEqual(migrate(db, MIGRATIONS_DIR), []);
    const ledger = db.prepare('SELECT name FROM _migrations ORDER BY name').all().map(row => row.name);
    for (const name of PREVIEW_MIGRATIONS) assert.ok(ledger.includes(name), `${name} recorded in _migrations`);
  } finally {
    db.close();
  }
});

test('all five W6 tables exist with owner_id NOT NULL', () => {
  const db = migratedDb();
  try {
    for (const table of ['previews', 'discussion_threads', 'discussion_messages', 'preview_confirmations', 'contract_change_records']) {
      const info = db.prepare(`PRAGMA table_info(${table})`).all();
      assert.ok(info.length > 0, `${table} must exist`);
      const owner = info.find(column => column.name === 'owner_id');
      assert.ok(owner, `${table} must have owner_id`);
      assert.equal(owner.notnull, 1, `${table}.owner_id must be NOT NULL`);
    }
  } finally {
    db.close();
  }
});

test('previews accepts the canonical immutable row and rejects duplicate (owner, mission, version)', () => {
  const db = migratedDb();
  try {
    insertPreview(db);
    // Same owner+mission+version again (even different id) violates the version chain.
    assert.throws(() => insertPreview(db, { id: 'pv_dup' }), /UNIQUE/i);
    // Different owner or mission is a separate chain.
    insertPreview(db, { id: 'pv_b', owner: 'owner-b', version: 1 });
    insertPreview(db, { id: 'pv_m2', mission: 'm2', version: 1 });
    // deleted_at stays nullable.
    db.prepare("UPDATE previews SET deleted_at = '2026-10-27T11:00:00Z' WHERE id = 'pv_1'").run();
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM previews WHERE deleted_at IS NOT NULL').get().n, 1);
  } finally {
    db.close();
  }
});

test('discussion_threads is one per (owner, mission); messages carry the idempotency key', () => {
  const db = migratedDb();
  try {
    db.prepare(
      `INSERT INTO discussion_threads (id, owner_id, mission_id, created_at, updated_at)
       VALUES ('th_1', 'owner-a', 'm1', '2026-10-27T10:00:00Z', '2026-10-27T10:00:00Z')`,
    ).run();
    assert.throws(() => db.prepare(
      `INSERT INTO discussion_threads (id, owner_id, mission_id, created_at, updated_at)
       VALUES ('th_2', 'owner-a', 'm1', '2026-10-27T10:01:00Z', '2026-10-27T10:01:00Z')`,
    ).run(), /UNIQUE/i);

    const insertMessage = db.prepare(
      `INSERT INTO discussion_messages
         (id, owner_id, thread_id, mission_id, base_version, utterance, patch, before_version, after_version,
          actor, idempotency_key, created_at)
       VALUES (?, 'owner-a', 'th_1', 'm1', 1, '只看国内 K12', NULL, 1, NULL, 'user', ?, '2026-10-27T10:02:00Z')`,
    );
    insertMessage.run('msg_1', 'key-1');
    // Idempotency key is unique per owner: replaying the same key cannot double-append.
    assert.throws(() => insertMessage.run('msg_2', 'key-1'), /UNIQUE/i);
    // Same key under another owner is a different discussion.
    // (owner-b needs its own thread first: thread_id is FK-checked against
    // discussion_threads(id) — spec repair, see .s2d/impl-preview-migrations.md.)
    db.prepare(
      `INSERT INTO discussion_threads (id, owner_id, mission_id, created_at, updated_at)
       VALUES ('th_b', 'owner-b', 'm1', '2026-10-27T10:02:30Z', '2026-10-27T10:02:30Z')`,
    ).run();
    db.prepare(
      `INSERT INTO discussion_messages
         (id, owner_id, thread_id, mission_id, base_version, utterance, patch, before_version, after_version,
          actor, idempotency_key, created_at)
       VALUES ('msg_3', 'owner-b', 'th_b', 'm1', 1, 'x', NULL, 1, NULL, 'user', 'key-1', '2026-10-27T10:03:00Z')`,
    ).run();
    // FK: a message must belong to an existing thread.
    assert.throws(() => db.prepare(
      `INSERT INTO discussion_messages
         (id, owner_id, thread_id, mission_id, base_version, utterance, patch, before_version, after_version,
          actor, idempotency_key, created_at)
       VALUES ('msg_4', 'owner-a', 'th_missing', 'm1', 1, 'x', NULL, 1, NULL, 'user', 'key-4', '2026-10-27T10:04:00Z')`,
    ).run(), /FOREIGN KEY/i);
  } finally {
    db.close();
  }
});

test('preview_confirmations decision CHECK and replay-unique key; change records FK to messages', () => {
  const db = migratedDb();
  try {
    insertPreview(db);
    const insertConfirmation = db.prepare(
      `INSERT INTO preview_confirmations (id, owner_id, mission_id, preview_version, actor, decision, note, event, created_at)
       VALUES (?, 'owner-a', 'm1', 1, 'user', ?, NULL, NULL, '2026-10-27T10:05:00Z')`,
    );
    insertConfirmation.run('cf_1', 'confirm');
    // Only the three defined decisions are storable.
    assert.throws(() => insertConfirmation.run('cf_2', 'maybe'), /CHECK/i);
    // Replay of the same (owner, mission, version, actor, decision) is one row.
    assert.throws(() => insertConfirmation.run('cf_3', 'confirm'), /UNIQUE/i);
    // A different decision on the same version is a distinct record.
    insertConfirmation.run('cf_4', 'request_change');

    // Change records must reference a real discussion message.
    assert.throws(() => db.prepare(
      `INSERT INTO contract_change_records
         (id, owner_id, mission_id, message_id, before_version, after_version, patch, changed_fields, created_at)
       VALUES ('cr_1', 'owner-a', 'm1', 'msg_missing', 1, 2, '{}', '["boundary.wont"]', '2026-10-27T10:06:00Z')`,
    ).run(), /FOREIGN KEY/i);
  } finally {
    db.close();
  }
});
