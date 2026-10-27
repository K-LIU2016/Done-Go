-- S2D-W2 run-engine checkpoints (DBOS-style durable execution).
-- Kept idempotent for the W0 migration runner handoff.
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL,
  owner_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('queued','running','paused','paused_pending_confirm','verifying','succeeded','partial','failed','unknown','cancelled')),
  contract_hash TEXT NOT NULL,
  dod TEXT NOT NULL DEFAULT '[]',
  budget_snapshot TEXT NOT NULL DEFAULT '{}',
  spent TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS run_steps (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  seq INTEGER NOT NULL,
  input_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','running','done','failed','skipped')),
  result TEXT,
  attempt INTEGER NOT NULL DEFAULT 0,
  max_attempt INTEGER NOT NULL DEFAULT 3,
  next_retry_at TEXT,
  error TEXT,
  spent TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (run_id, name)
);

CREATE INDEX IF NOT EXISTS idx_run_steps_run_seq ON run_steps(run_id, seq);
CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status);
