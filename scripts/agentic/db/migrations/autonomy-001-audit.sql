CREATE TABLE IF NOT EXISTS autonomy_audit_events (
  event_id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type TEXT NOT NULL,
  owner_id TEXT,
  action_id TEXT,
  grant_id TEXT,
  actor_id TEXT,
  model_provider TEXT,
  resolved_model TEXT,
  contract_hash TEXT,
  status TEXT,
  code TEXT,
  reason TEXT,
  payload_json TEXT NOT NULL,
  occurred_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS autonomy_audit_action_idx
  ON autonomy_audit_events (action_id, occurred_at);
CREATE INDEX IF NOT EXISTS autonomy_audit_owner_idx
  ON autonomy_audit_events (owner_id, occurred_at);
