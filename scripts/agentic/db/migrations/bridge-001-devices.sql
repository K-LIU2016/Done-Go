-- W8 bridge hub: pairing records and owner-scoped device credentials.
-- Secrets are represented only by SHA-256 digests; timestamps are epoch milliseconds.
CREATE TABLE IF NOT EXISTS bridge_pairings (
  code_hash TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);
CREATE INDEX IF NOT EXISTS bridge_pairings_expiry_idx
  ON bridge_pairings (expires_at);

CREATE TABLE IF NOT EXISTS bridge_devices (
  device_id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS bridge_devices_owner_idx
  ON bridge_devices (owner_id, revoked_at);
CREATE INDEX IF NOT EXISTS bridge_devices_token_idx
  ON bridge_devices (token_hash);
