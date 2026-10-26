-- W12 现场感知 · 初始结构（PRD §6.8 / BUILD-PLAN §3 W12）
-- 三张表：captures（捕获原始记录 + 归属）、perception_cards（快慢双路的同一张卡）、
-- perception_events（append-only 事件台账，SSE card.created/card.upgraded 可重放）。
-- 幂等 DDL（IF NOT EXISTS）：W0 迁移运行器按文件名排序执行、记账；W0 交付前由
-- perception/store.mjs 在内存库直接执行（BUILD-PLAN §2.1 L48）。
-- 注意：PRAGMA（WAL、foreign_keys）不写在迁移里——那是 openAgenticDb/运行器的职责；
-- 运行器把迁移包进事务时 PRAGMA 也会失效。

CREATE TABLE IF NOT EXISTS captures (
  id            TEXT PRIMARY KEY,              -- store 生成（cap_ + 随机 hex）
  owner_id      TEXT NOT NULL,                 -- 所有读写强制按 owner 过滤
  kind          TEXT NOT NULL CHECK (kind IN ('image', 'video')),
  captured_at   TEXT NOT NULL,                 -- 拍摄时间（EXIF；无则回落上传时间）
  uploaded_at   TEXT NOT NULL,                 -- 上传时间（归属兜底 + 列表排序键）
  stored_path   TEXT NOT NULL,                 -- owner 私有目录内的相对/绝对路径
  keep_original INTEGER NOT NULL DEFAULT 0,    -- 敏感画面默认不存原图（PRD §6.8.4）
  exif_stripped INTEGER NOT NULL DEFAULT 0,    -- EXIF 位置默认剥离
  status        TEXT NOT NULL DEFAULT 'pending', -- pending → processing → done | failed
  block_id      TEXT,                          -- 归属结果：日程块 id（歧义未决时为 NULL）
  confidence    REAL,                          -- 归属置信度 0..1（用户拍板 = 1）
  candidates    TEXT                           -- 歧义时候选列表（JSON 数组，用户选完清空）
);

CREATE INDEX IF NOT EXISTS idx_captures_owner_uploaded
  ON captures (owner_id, uploaded_at);

-- 一张捕获只有一张卡：快卡 insert，深卡原地 UPDATE 升级（UNIQUE 保证不新增行）。
CREATE TABLE IF NOT EXISTS perception_cards (
  id          TEXT PRIMARY KEY,
  capture_id  TEXT NOT NULL REFERENCES captures (id) ON DELETE CASCADE,
  owner_id    TEXT NOT NULL,
  level       TEXT NOT NULL CHECK (level IN ('fast', 'deep')),
  model       TEXT NOT NULL,                   -- qwen3.5-omni-flash / qwen3-vl-plus / minicpm-v
  ms          INTEGER NOT NULL,                -- 感知耗时（延迟目标 fast≤2s deep≤8s 的实测记录）
  seen        TEXT,                            -- 看到了什么（一句话）
  change      TEXT,                            -- 相对计划的变化（深路）
  risk        TEXT,                            -- 风险（深路）
  suggestion  TEXT,                            -- 一句话建议（深路）
  actions     TEXT NOT NULL DEFAULT '[]',      -- 动作按钮（JSON 数组：记下来/加待办/调计划…）
  state       TEXT NOT NULL,                   -- created | upgraded | …（流水线语义）
  updated_at  TEXT NOT NULL,
  UNIQUE (capture_id)
);

CREATE INDEX IF NOT EXISTS idx_cards_owner_capture
  ON perception_cards (owner_id, capture_id);

-- 事件台账：append-only，seq 用 AUTOINCREMENT 保证单调不重用；SSE 断线重放按
-- owner+capture 过滤、seq 升序读回。
CREATE TABLE IF NOT EXISTS perception_events (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  capture_id TEXT NOT NULL REFERENCES captures (id) ON DELETE CASCADE,
  owner_id   TEXT NOT NULL,
  type       TEXT NOT NULL,                    -- card.created / card.upgraded / …
  payload    TEXT NOT NULL DEFAULT '{}',       -- JSON 对象
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_owner_capture_seq
  ON perception_events (owner_id, capture_id, seq);
