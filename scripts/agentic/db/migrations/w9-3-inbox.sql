-- W9 M3 inbox-domain（A13 inbox）
-- 依据 .s2d/plan.md §G1-M3 钉死的表结构；本文件只建 inbox 三表，不依赖 w9-1/w9-2。
--
-- w9_needs            Need 生命周期（open → answered|defaulted|waived|expired）；
--                     default_action 可空（brief 裁决⑤：无默认 → UNKNOWN/继续等待，不物化冻结 Need 对象）；
--                     revision 是乐观并发键，answer 幂等键 = (owner_id, need_id, revision)。
-- w9_need_events      append-only 生命周期事件（created/answered/waived/defaulted/overdue_waiting），只增不改不删。
-- w9_attention_items  Need → AttentionItem 投影行（W9 只写投影数据；SSE/HTTP 推送归 W13）；
--                     故意不加指向 w9_needs 的外键——投影允许先于/独立于 need 行维护。

CREATE TABLE IF NOT EXISTS w9_needs (
  id             TEXT PRIMARY KEY,
  owner_id       TEXT NOT NULL,
  mission_id     TEXT NOT NULL,
  type           TEXT NOT NULL CHECK (type IN ('decision', 'data', 'authorization', 'attendance', 'acceptance')),
  question       TEXT NOT NULL CHECK (length(question) > 0),
  due_at         TEXT NOT NULL,
  default_action TEXT NULL CHECK (default_action IN ('continue', 'pause', 'skip', 'deliver_best', 'stop')),
  status         TEXT NOT NULL CHECK (status IN ('open', 'answered', 'defaulted', 'waived', 'expired')),
  answer         TEXT NULL,
  answered_at    TEXT NULL,
  revision       INTEGER NOT NULL CHECK (revision >= 1)
);

CREATE INDEX IF NOT EXISTS idx_w9_needs_owner ON w9_needs (owner_id);
CREATE INDEX IF NOT EXISTS idx_w9_needs_owner_status_due ON w9_needs (owner_id, status, due_at);

CREATE TABLE IF NOT EXISTS w9_need_events (
  id           TEXT PRIMARY KEY,
  owner_id     TEXT NOT NULL,
  need_id      TEXT NOT NULL,
  type         TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  FOREIGN KEY (need_id) REFERENCES w9_needs (id)
);

CREATE INDEX IF NOT EXISTS idx_w9_need_events_need ON w9_need_events (need_id, created_at);

CREATE TABLE IF NOT EXISTS w9_attention_items (
  need_id      TEXT NOT NULL,
  owner_id     TEXT NOT NULL,
  kind         TEXT NOT NULL,
  payload      TEXT NOT NULL,
  state        TEXT NOT NULL,
  unknown_flag INTEGER NOT NULL CHECK (unknown_flag IN (0, 1)),
  updated_at   TEXT NOT NULL,
  PRIMARY KEY (need_id, owner_id)
);
