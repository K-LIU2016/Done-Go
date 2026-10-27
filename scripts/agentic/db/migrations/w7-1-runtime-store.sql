-- W7 M2 · runtime-store（A4 agent runtime 持久化）
-- 约定（plan.md M2 / brief 裁决⑥）：
--   * 每张表都携带 server-derived owner_id；一切读写都按 owner 过滤（跨 owner = NOT_FOUND/null，不泄露存在性）。
--   * 引用 mission/contract/grant 一律为普通字符串列（不设 FK），避免与 W2/W3 迁移耦合。
--   * w7_work_orders：idempotency (owner_id, idempotency_key) 唯一 + revision 乐观锁。
--   * w7_agent_steps：state 遵循冻结 step.schema.json 枚举 pending/running/succeeded/failed/paused/skipped
--     （无 unknown）；checkpoint 为 TEXT 载荷。UNKNOWN 只进 w7_unknown_outcomes 台账（只对账、不自动重试，
--     因此该表没有任何出队/重试状态列）。
--   * 全部 IF NOT EXISTS：migrate() 有 ledger，但语句自身也保持可重放。

CREATE TABLE IF NOT EXISTS w7_work_orders (
  owner_id        TEXT NOT NULL,
  id              TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  payload_hash    TEXT NOT NULL,
  revision        INTEGER NOT NULL DEFAULT 1,
  work_order      TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  PRIMARY KEY (owner_id, id),
  UNIQUE (owner_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS w7_work_results (
  owner_id     TEXT NOT NULL,
  order_id     TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  result       TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  PRIMARY KEY (owner_id, order_id)
);

CREATE TABLE IF NOT EXISTS w7_agent_steps (
  owner_id    TEXT NOT NULL,
  id          TEXT NOT NULL,
  run_id      TEXT NOT NULL,
  state       TEXT NOT NULL,
  attempt     INTEGER NOT NULL,
  input_hash  TEXT,
  checkpoint  TEXT,
  payload     TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (owner_id, id)
);

CREATE INDEX IF NOT EXISTS w7_agent_steps_owner_run
  ON w7_agent_steps (owner_id, run_id);

CREATE TABLE IF NOT EXISTS w7_unknown_outcomes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id    TEXT NOT NULL,
  run_id      TEXT NOT NULL,
  step_id     TEXT,
  source      TEXT NOT NULL,
  detail      TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'unknown',
  recorded_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS w7_unknown_outcomes_owner
  ON w7_unknown_outcomes (owner_id);
