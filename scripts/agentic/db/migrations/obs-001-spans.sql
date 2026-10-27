-- W10 observability, part 1: runs, spans, steps.
-- Additive only: every table is obs_-prefixed and carries a server-derived
-- owner_id with no default, so no row can exist without an owner.

CREATE TABLE IF NOT EXISTS obs_runs (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  mission_id TEXT NOT NULL,
  contract_hash TEXT NOT NULL,
  state TEXT NOT NULL,
  started_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  finished_at TEXT,
  current_step_id TEXT,
  provenance TEXT NOT NULL DEFAULT 'UNKNOWN'
);

CREATE INDEX IF NOT EXISTS idx_obs_runs_owner_state ON obs_runs (owner_id, state);
CREATE INDEX IF NOT EXISTS idx_obs_runs_owner_mission ON obs_runs (owner_id, mission_id);

CREATE TABLE IF NOT EXISTS obs_spans (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  run_id TEXT,
  parent_id TEXT,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  status TEXT NOT NULL,
  input_ref TEXT,
  output_ref TEXT,
  error TEXT,
  attributes_json TEXT NOT NULL DEFAULT '{}',
  request_model TEXT,
  actor_role TEXT,
  actor_model TEXT,
  resolved_model TEXT,
  model_source TEXT,
  model_local INTEGER,
  provenance TEXT NOT NULL DEFAULT 'UNKNOWN'
);

CREATE INDEX IF NOT EXISTS idx_obs_spans_owner_run ON obs_spans (owner_id, run_id, started_at);
CREATE INDEX IF NOT EXISTS idx_obs_spans_owner_status ON obs_spans (owner_id, status);

CREATE TABLE IF NOT EXISTS obs_steps (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  parent_step_id TEXT,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  state TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 0,
  input_hash TEXT,
  checkpoint TEXT,
  started_at TEXT,
  finished_at TEXT,
  evidence_json TEXT NOT NULL DEFAULT '[]'
);

CREATE INDEX IF NOT EXISTS idx_obs_steps_owner_run ON obs_steps (owner_id, run_id, attempt);
CREATE INDEX IF NOT EXISTS idx_obs_steps_owner_hash ON obs_steps (owner_id, input_hash);
