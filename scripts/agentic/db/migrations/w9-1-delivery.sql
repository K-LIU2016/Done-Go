-- W9 M1 delivery-domain（A11 artifact-store）
-- 依据 .s2d/plan.md §G1-M1 钉死的表结构；本文件只建 delivery 四表，不依赖 w9-2/w9-3。
--
-- w9_artifacts         工件头（current_version 指向最新版本；软删 = deleted_at 置位 + 事件行，版本链保留）
-- w9_artifact_versions append-only 版本链；版本号服务端分配（max+1），UNIQUE(artifact_id, version) 钉死
-- w9_acceptances       用户验收记录（owner_id/artifact_version 落库，对外对象保持冻结 schema 纯净）
-- w9_artifact_events   append-only 状态事件（status 变更 / 软删 / 撤回），只增不改不删

CREATE TABLE IF NOT EXISTS w9_artifacts (
  id              TEXT PRIMARY KEY,
  owner_id        TEXT NOT NULL,
  mission_id      TEXT NOT NULL,
  current_version INTEGER NOT NULL CHECK (current_version >= 1),
  title           TEXT NOT NULL,
  type            TEXT NOT NULL,
  status          TEXT NOT NULL,
  location        TEXT NOT NULL,
  source          TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  deleted_at      TEXT NULL
);

CREATE TABLE IF NOT EXISTS w9_artifact_versions (
  artifact_id   TEXT NOT NULL,
  owner_id      TEXT NOT NULL,
  version       INTEGER NOT NULL CHECK (version >= 1),
  mission_id    TEXT NOT NULL,
  type          TEXT NOT NULL,
  title         TEXT NOT NULL,
  status        TEXT NOT NULL,
  location      TEXT NOT NULL,
  source        TEXT NOT NULL,
  content_hash  TEXT NOT NULL,
  evidence_json TEXT NULL,
  created_at    TEXT NOT NULL,
  created_by    TEXT NOT NULL,
  UNIQUE (artifact_id, version),
  FOREIGN KEY (artifact_id) REFERENCES w9_artifacts (id)
);

CREATE INDEX IF NOT EXISTS idx_w9_artifact_versions_owner
  ON w9_artifact_versions (owner_id, artifact_id, version);

CREATE TABLE IF NOT EXISTS w9_acceptances (
  id               TEXT PRIMARY KEY,
  owner_id         TEXT NOT NULL,
  artifact_id      TEXT NOT NULL,
  artifact_version INTEGER NOT NULL CHECK (artifact_version >= 1),
  mission_id       TEXT NOT NULL,
  actor            TEXT NOT NULL,
  decision         TEXT NOT NULL CHECK (decision IN ('accepted', 'revision_requested', 'rejected')),
  comment          TEXT NULL,
  created_at       TEXT NOT NULL,
  FOREIGN KEY (artifact_id) REFERENCES w9_artifacts (id)
);

CREATE INDEX IF NOT EXISTS idx_w9_acceptances_owner_artifact
  ON w9_acceptances (owner_id, artifact_id, created_at);

CREATE TABLE IF NOT EXISTS w9_artifact_events (
  id           TEXT PRIMARY KEY,
  owner_id     TEXT NOT NULL,
  artifact_id  TEXT NOT NULL,
  type         TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  FOREIGN KEY (artifact_id) REFERENCES w9_artifacts (id)
);

CREATE INDEX IF NOT EXISTS idx_w9_artifact_events_artifact
  ON w9_artifact_events (artifact_id, created_at);
