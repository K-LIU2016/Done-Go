CREATE TABLE IF NOT EXISTS autonomy_action_idempotency (
  idempotency_key TEXT PRIMARY KEY,
  action_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  contract_hash TEXT NOT NULL,
  grant_id TEXT,
  actor_id TEXT NOT NULL,
  resolved_model TEXT,
  action_hash TEXT,
  status TEXT NOT NULL,
  result_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS autonomy_checkpoints (
  idempotency_key TEXT NOT NULL,
  step_id TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  result_json TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (idempotency_key, step_id),
  FOREIGN KEY (idempotency_key) REFERENCES autonomy_action_idempotency(idempotency_key)
);

CREATE TABLE IF NOT EXISTS autonomy_events (
  event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  idempotency_key TEXT,
  payload_json TEXT NOT NULL,
  occurred_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS autonomy_checkpoint_action_idx
  ON autonomy_checkpoints (idempotency_key, step_id);
