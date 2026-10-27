-- S2D-W2 persistent event timers. Times are ISO strings with Asia/Shanghai (+08:00).
CREATE TABLE IF NOT EXISTS event_timers (
  id TEXT PRIMARY KEY,
  owner_id TEXT,
  dedup_key TEXT UNIQUE,
  run_at TEXT NOT NULL,
  event TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('scheduled','fired','cancelled')),
  late INTEGER NOT NULL DEFAULT 0,
  late_ms INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  fired_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_event_timers_due ON event_timers(status, run_at);
