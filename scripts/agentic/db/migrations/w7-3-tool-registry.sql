-- W7 M7 · tool-registry-mcp（A6 MCP 工具调用审计台账）
-- 约定（plan.md M7 / brief 裁决⑤⑥）：
--   * 每张表都携带 server-derived owner_id；一切读写按 owner 过滤（跨 owner 行不可见，
--     不泄露存在性）。引用 grant/connector 一律为普通字符串列（不设 FK），避免与
--     W2/W3 迁移耦合（同 w7-1 约定）。
--   * w7_tools：已登记 connector 能力清单的持久快照（M6 registry 为内存登记表，
--     本表是 durable 审计副本；manifest_hash 判定重登记是幂等 replay 还是冲突）。
--   * w7_tool_calls：一次工具调用尝试一条账。
--       policy_decision ∈ allowed | rejected（policyPort.check 与各闸门的综合判定）；
--       status ∈ succeeded | failed | unknown | rejected：
--         succeeded = MCP 调用往返且内容干净；
--         failed    = 已调用但工具 isError / 内容被隔离（quarantined）等已知失败；
--         unknown   = transport 超时/断连等外副作状态不可知（只对账，绝不自动重试，
--                     因此该状态没有任何出队/重试列——同 w7_unknown_outcomes 约定）；
--         rejected  = 调用前被闸门拒绝（Grant 撤销 / policy / scope / disclosure /
--                     inputSchema / quota），transport 零调用。
--       (owner_id, idempotency_key) 唯一：同 key 同 payload_hash 重放记账，异载 CONFLICT。
--   * result_payload 只存可回放的结构化结果 JSON（供幂等 replay 原样取回，不重执行）。
--   * IF NOT EXISTS：migrate() 有 ledger，但语句自身也保持可重放。

CREATE TABLE IF NOT EXISTS w7_tools (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id      TEXT NOT NULL,
  connector_id  TEXT NOT NULL,
  name          TEXT NOT NULL,
  transport     TEXT NOT NULL,
  manifest_hash TEXT NOT NULL,
  manifest      TEXT NOT NULL,
  tools         TEXT,
  registered_at TEXT NOT NULL,
  UNIQUE (owner_id, connector_id)
);

CREATE INDEX IF NOT EXISTS w7_tools_owner
  ON w7_tools (owner_id);

CREATE TABLE IF NOT EXISTS w7_tool_calls (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id        TEXT NOT NULL,
  connector_id    TEXT,
  tool_name       TEXT NOT NULL,
  grant_id        TEXT,
  policy_decision TEXT,
  result_summary  TEXT,
  status          TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  payload_hash    TEXT NOT NULL,
  external_id     TEXT,
  result_payload  TEXT,
  error_code      TEXT,
  called_at       TEXT NOT NULL,
  UNIQUE (owner_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS w7_tool_calls_owner
  ON w7_tool_calls (owner_id);

CREATE INDEX IF NOT EXISTS w7_tool_calls_owner_tool
  ON w7_tool_calls (owner_id, tool_name);
