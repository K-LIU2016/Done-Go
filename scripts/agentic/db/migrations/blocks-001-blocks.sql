-- blocks-001-blocks.sql — W1 Block 同步：服务端权威 blocks 表 + block_changes 游标日志。
-- 依据：PRD §11.1（字段清单）、BUILD-PLAN §3 W1-1、§2.1 L48（W0 迁移器交付前，各流测试
-- 直接在内存库 exec 本文件；W0 交付后由 migrate() 按文件名排序执行并记账）。
-- 游标 = block_changes 的全局自增 seq（按 owner 过滤可见），避免 updated_at 撞秒导致漏拉。

CREATE TABLE IF NOT EXISTS blocks (
  id          TEXT NOT NULL,            -- 客户端 uid() 生成即 block id（重放幂等关键）
  owner_id    TEXT NOT NULL,            -- 登录用户 id；owner+id 才是键（同 id 不同 owner 互不干扰）
  revision    INTEGER NOT NULL,         -- 服务端递增，客户端自带值不生效
  date        TEXT NOT NULL,            -- YYYY-MM-DD（list 的 from/to 区间过滤键）
  "start"     TEXT,                     -- HH:MM；draft 可为 NULL
  "end"       TEXT,                     -- HH:MM；draft 可为 NULL
  title       TEXT NOT NULL,
  kind        TEXT NOT NULL,
  prio        INTEGER NOT NULL DEFAULT 3,
  note        TEXT NOT NULL DEFAULT '',
  done        INTEGER NOT NULL DEFAULT 0,
  source      TEXT NOT NULL DEFAULT 'web',
  deleted_at  TEXT,                     -- 软删除：置位不物理删（NULL = 未删除）
  updated_at  TEXT NOT NULL,            -- 服务端 now()（注入时钟，测试可固定）
  PRIMARY KEY (owner_id, id)
);

CREATE INDEX IF NOT EXISTS idx_blocks_owner_date ON blocks(owner_id, date);

-- 变更日志：每次 applied 的 change 一行；seq 单调，changesSince(owner, cursor) 只回
-- 每个块的最新状态（按块取 MAX(seq)），cursor 为该 owner 可见（本 owner 行）的最大全局 seq。
CREATE TABLE IF NOT EXISTS block_changes (
  seq       INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id  TEXT NOT NULL,
  block_id  TEXT NOT NULL,
  at        TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_block_changes_owner_block ON block_changes(owner_id, block_id, seq);
