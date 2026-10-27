-- S2D-W2 durable external-action outbox. Unknown is never automatically resent.
CREATE TABLE IF NOT EXISTS outbox (
  id TEXT PRIMARY KEY,
  run_id TEXT,
  step_id TEXT,
  action_key TEXT NOT NULL UNIQUE,
  payload TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('registered','dispatched','verified','unknown','failed','cancelled')),
  external_id TEXT NOT NULL,
  receipt TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  manual INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_outbox_status ON outbox(status);
CREATE INDEX IF NOT EXISTS idx_outbox_run ON outbox(run_id);
