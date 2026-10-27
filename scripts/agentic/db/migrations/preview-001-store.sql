-- S2D-W6 preview-001-store.sql — immutable Preview version chain.
-- Scope: previews table only (W6 persistence base, .s2d/plan.md module 1).
--
-- Design anchors:
--   * mission_id is a SOFT reference: the missions table belongs to W3 and must
--     NOT be created here (CTO-BATCH2-BRIEF 2026-10-27 §3; confirmed by
--     confirm.test.mjs "no missions table may exist from W6").
--   * owner_id is server-derived and never defaulted (db/index.mjs contract).
--   * payload stores the canonical frozen Preview JSON validated against
--     contracts/agentic/preview.schema.json (W0 FROZEN b9d9bdfa); W11 playback
--     fields are consumed via projection, never added to the frozen contract
--     (CTO-DECISIONS 2026-10-27 §2.3).
--   * Versions are immutable and per (owner, mission): one row per version,
--     enforced by UNIQUE; soft delete keeps the audit trail intact.

CREATE TABLE previews (
  id          TEXT PRIMARY KEY,
  owner_id    TEXT    NOT NULL,
  mission_id  TEXT    NOT NULL,               -- soft ref; missions table is W3-owned
  version     INTEGER NOT NULL CHECK (version >= 1),
  payload     TEXT    NOT NULL,               -- canonical Preview JSON (frozen schema)
  revision    INTEGER NOT NULL,               -- optimistic concurrency counter
  created_at  TEXT    NOT NULL,
  updated_at  TEXT    NOT NULL,
  deleted_at  TEXT,                           -- soft delete (nullable)
  UNIQUE (owner_id, mission_id, version)
);

-- Latest/list scans skip soft-deleted versions.
CREATE INDEX idx_previews_live
  ON previews (owner_id, mission_id, version)
  WHERE deleted_at IS NULL;
