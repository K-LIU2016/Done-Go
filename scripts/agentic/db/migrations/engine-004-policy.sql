-- S2D-W2 policy persistence. Idempotent so W0's migration runner can replay it.
CREATE TABLE IF NOT EXISTS grants (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  actor TEXT NOT NULL,
  contract_hash TEXT NOT NULL,
  capabilities TEXT NOT NULL,
  scope TEXT NOT NULL,
  data_disclosure TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('proposed','active','consumed','revoked','expired','invalidated')),
  consumed_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_grants_owner_status ON grants(owner_id, status);
CREATE INDEX IF NOT EXISTS idx_grants_contract_hash ON grants(contract_hash);

CREATE TABLE IF NOT EXISTS audit (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  actor TEXT NOT NULL,
  grant_id TEXT,
  action TEXT NOT NULL,
  contract_hash TEXT,
  outcome TEXT NOT NULL,
  external_id TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_owner_created ON audit(owner_id, created_at);
CREATE INDEX IF NOT EXISTS idx_audit_grant_created ON audit(grant_id, created_at);
