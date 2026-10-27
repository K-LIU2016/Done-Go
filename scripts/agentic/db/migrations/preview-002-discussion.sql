-- S2D-W6 preview-002-discussion.sql — discussion threads/messages, confirmation
-- entry and contract change records (.s2d/plan.md module 1, part 2).
--
-- Design anchors:
--   * One thread per (owner, mission); messages are append-only rows carrying
--     the utterance, the parsed MissionPatch (nullable: a plain utterance or a
--     parse failure leaves no patch) and the before/after preview versions
--     (after_version NULL until the patch produces a new version).
--   * Idempotency: (owner_id, idempotency_key) UNIQUE — replaying a discussion
--     request cannot double-append (negative path "重复" in .s2d/plan.md §2).
--   * Confirmations record the decision only; confirm additionally stores the
--     contract-draft-request event JSON for W3 to consume. No external side
--     effect is triggered from storage (P0→contracted boundary).
--   * "讨论不改变合同而无记录": every contract-relevant change MUST land as a
--     contract_change_records row referencing the discussion message that
--     caused it, in the SAME transaction (patch NOT NULL — an attempted
--     record without a patch aborts that transaction, discussion-store.test.mjs
--     atomicity case).
--   * All tables carry the server-derived owner_id (NOT NULL).

CREATE TABLE discussion_threads (
  id          TEXT PRIMARY KEY,
  owner_id    TEXT    NOT NULL,
  mission_id  TEXT    NOT NULL,               -- soft ref; missions table is W3-owned
  created_at  TEXT    NOT NULL,
  updated_at  TEXT    NOT NULL,
  UNIQUE (owner_id, mission_id)
);

CREATE TABLE discussion_messages (
  id              TEXT PRIMARY KEY,
  owner_id        TEXT    NOT NULL,
  thread_id       TEXT    NOT NULL REFERENCES discussion_threads (id),
  mission_id      TEXT    NOT NULL,
  base_version    INTEGER NOT NULL,           -- version the actor was looking at
  utterance       TEXT    NOT NULL,
  patch           TEXT,                       -- MissionPatch JSON; NULL = no patch
  before_version  INTEGER NOT NULL,
  after_version   INTEGER,                    -- NULL until a new preview version exists
  actor           TEXT    NOT NULL,
  idempotency_key TEXT    NOT NULL,
  created_at      TEXT    NOT NULL,
  UNIQUE (owner_id, idempotency_key)
);

CREATE INDEX idx_discussion_messages_thread
  ON discussion_messages (owner_id, thread_id, created_at);

CREATE TABLE preview_confirmations (
  id              TEXT PRIMARY KEY,
  owner_id        TEXT    NOT NULL,
  mission_id      TEXT    NOT NULL,
  preview_version INTEGER NOT NULL CHECK (preview_version >= 1),
  actor           TEXT    NOT NULL,
  decision        TEXT    NOT NULL CHECK (decision IN ('confirm', 'request_change', 'decline')),
  note            TEXT,                       -- free-form actor note (nullable)
  event           TEXT,                       -- contract-draft-request JSON (confirm only)
  created_at      TEXT    NOT NULL,
  UNIQUE (owner_id, mission_id, preview_version, actor, decision)
);

CREATE TABLE contract_change_records (
  id              TEXT PRIMARY KEY,
  owner_id        TEXT    NOT NULL,
  mission_id      TEXT    NOT NULL,
  message_id      TEXT    NOT NULL REFERENCES discussion_messages (id),
  before_version  INTEGER NOT NULL,
  after_version   INTEGER NOT NULL,
  patch           TEXT    NOT NULL,           -- the contract-relevant patch itself
  changed_fields  TEXT    NOT NULL,           -- JSON array of dotted field paths
  created_at      TEXT    NOT NULL
);

CREATE INDEX idx_contract_change_records_mission
  ON contract_change_records (owner_id, mission_id, created_at);
