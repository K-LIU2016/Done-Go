CREATE TABLE IF NOT EXISTS missions (
  id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  schema_version INTEGER NOT NULL,
  block_id TEXT NOT NULL,
  goal TEXT NOT NULL,
  state TEXT NOT NULL,
  autonomy TEXT NOT NULL,
  scan_id TEXT,
  preview_id TEXT,
  contract_id TEXT,
  contract_hash TEXT,
  blocked_reason TEXT,
  resume_state TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  PRIMARY KEY (owner_id, id)
);

CREATE TABLE IF NOT EXISTS mission_events (
  owner_id TEXT NOT NULL,
  mission_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  from_state TEXT NOT NULL,
  to_state TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (owner_id, event_id),
  FOREIGN KEY (owner_id, mission_id) REFERENCES missions(owner_id, id)
);

CREATE TABLE IF NOT EXISTS mission_grants (
  owner_id TEXT NOT NULL,
  id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  contract_hash TEXT NOT NULL,
  actor TEXT NOT NULL,
  capabilities_json TEXT NOT NULL,
  data_disclosure_json TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  status TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (owner_id, id)
);

CREATE TABLE IF NOT EXISTS mission_idempotency (
  owner_id TEXT NOT NULL,
  command_id TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (owner_id, command_id)
);

CREATE INDEX IF NOT EXISTS mission_events_lookup ON mission_events(owner_id, mission_id, revision);
CREATE INDEX IF NOT EXISTS mission_grants_lookup ON mission_grants(owner_id, contract_hash, status);
