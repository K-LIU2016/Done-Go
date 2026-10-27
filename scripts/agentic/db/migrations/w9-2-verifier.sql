-- W9 M2 verifier-kit tables（plan G1-M2 钉死形状）。
-- w9_verdicts 是 append-only 台账：复核只插入新行，读取方按
-- (ran_at DESC, rowid DESC) 取最新一条（更晚 ranAt / 更晚写入者胜）。
-- Verdict 是 W9 内部结构，冻结契约无对应 schema，故形状在
-- scripts/agentic/verifier/verdict.mjs 手工守护（CONTRACT_INVALID），不新增 schema 文件。

CREATE TABLE IF NOT EXISTS w9_verdicts (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  artifact_version INTEGER NOT NULL CHECK (artifact_version >= 1),
  overall TEXT NOT NULL CHECK (overall IN ('VERIFIED', 'FAILED', 'UNKNOWN')),
  ran_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS w9_verdicts_owner_artifact
  ON w9_verdicts (owner_id, artifact_id, artifact_version, ran_at);

CREATE TABLE IF NOT EXISTS w9_verdict_checks (
  verdict_id TEXT NOT NULL REFERENCES w9_verdicts (id) ON DELETE CASCADE,
  seq INTEGER NOT NULL CHECK (seq >= 1),
  kind TEXT NOT NULL CHECK (kind IN ('dod-item', 'citation', 'command-result', 'injection-marker')),
  ref TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('PASS', 'FAIL', 'UNKNOWN')),
  severity TEXT NOT NULL CHECK (severity IN ('HIGH', 'MEDIUM', 'LOW')),
  reason TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (verdict_id, seq)
);
