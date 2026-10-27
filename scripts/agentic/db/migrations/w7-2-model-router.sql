-- W7 M5 · model-router-call（A5 模型选择台账）
-- 约定（plan.md M5 / brief 裁决④）：
--   * owner_id 为 server-derived，一切读写按 owner 过滤（跨 owner 行不可见）。
--   * model 允许 NULL：NULL = UNKNOWN（无 resolved model，不得视为完成；
--     brief 红线⑦“actor 显式绑定模型”）。
--   * provenance 为 JSON 载荷：{ rule, inputsHash, decidedAt }（decidedAt 来自注入时钟）。
--   * status ∈ selected | unknown | failed | rejected：
--       selected = transport 成功且结果带模型来源；
--       unknown  = router 无规则命中 / 双方都无模型来源（只对账，不自动重试）；
--       failed   = transport timeout / 403 等结构化失败（保留尝试过的 model 供审计）；
--       rejected = 选型前被拒（secret dataClass / router 抛错等，transport 零调用）。
--   * IF NOT EXISTS：migrate() 有 ledger，但语句自身也保持可重放。

CREATE TABLE IF NOT EXISTS w7_model_selections (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id    TEXT NOT NULL,
  actor       TEXT NOT NULL,
  task_class  TEXT NOT NULL,
  data_class  TEXT NOT NULL,
  model       TEXT,
  provenance  TEXT,
  status      TEXT NOT NULL,
  recorded_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS w7_model_selections_owner
  ON w7_model_selections (owner_id);
