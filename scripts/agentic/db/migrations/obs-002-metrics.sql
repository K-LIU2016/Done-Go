-- W10 observability, part 2: gates, cache identity, spend, and read-only
-- projections of the W0 acceptance/need/grant observations. Additive only.

CREATE TABLE IF NOT EXISTS obs_gates (
  owner_id TEXT NOT NULL,
  stream TEXT NOT NULL,
  name TEXT NOT NULL,
  head TEXT NOT NULL,
  kind TEXT,
  command TEXT NOT NULL,
  rc INTEGER NOT NULL,
  passed INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  skipped INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER,
  coverage_json TEXT,
  contract_commit TEXT,
  evidence_json TEXT NOT NULL DEFAULT '[]',
  recorded_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (owner_id, stream, name, head)
);

CREATE INDEX IF NOT EXISTS idx_obs_gates_owner_head ON obs_gates (owner_id, head);

CREATE TABLE IF NOT EXISTS obs_cache_entries (
  key TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  contract_hash TEXT NOT NULL,
  block_revision TEXT NOT NULL,
  model TEXT NOT NULL,
  effort TEXT NOT NULL,
  inputs_hash TEXT NOT NULL,
  model_source TEXT NOT NULL,
  freshness TEXT NOT NULL,
  stale INTEGER NOT NULL DEFAULT 0,
  reasons_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (owner_id, key)
);

CREATE INDEX IF NOT EXISTS idx_obs_cache_owner_stale ON obs_cache_entries (owner_id, stale);

-- cost_cny is deliberately nullable: NULL means "unknown", 0 means "free".
CREATE TABLE IF NOT EXISTS obs_spend (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  step_id TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 0,
  calls INTEGER NOT NULL,
  tokens INTEGER NOT NULL,
  cost_cny REAL,
  local_share REAL,
  recorded_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_obs_spend_owner_run ON obs_spend (owner_id, run_id, step_id, attempt);

CREATE TABLE IF NOT EXISTS obs_acceptances (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  artifact_id TEXT,
  actor TEXT,
  decision TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_obs_acceptances_owner ON obs_acceptances (owner_id, decision);

CREATE TABLE IF NOT EXISTS obs_needs (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  mission_id TEXT,
  status TEXT NOT NULL,
  due_at TEXT,
  answered_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_obs_needs_owner ON obs_needs (owner_id, status);

CREATE TABLE IF NOT EXISTS obs_grants (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  status TEXT NOT NULL,
  expires_at TEXT,
  updated_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_obs_grants_owner ON obs_grants (owner_id, status);
