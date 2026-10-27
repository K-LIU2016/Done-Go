// W9 M2 verifier-domain · verdict 持久化（plan G1-M2-5）。
// saveVerdict(db, ownerId, verdict, { idGen?, events? })：写 w9_verdicts 1 行
// + w9_verdict_checks 每 check 1 行。形状手工守护（冻结契约无此 schema，
// 不得新增 schema 文件），坏形状 → CONTRACT_INVALID。ranAt 用调用方给的
// 值（来自注入 clock），本模块不读 wall clock。events 是注入事件 sink，
// W10 observability 只经此对接（plan 钉死接口 evt={type,ownerId,objectType,objectId,at,data}）。

import { randomUUID } from 'node:crypto';
import {
  VERDICT_OVERALLS,
  contractInvalid,
  isIsoDateTime,
  isPlainObject,
  isValidCheck,
} from './shape.mjs';

const INSERT_VERDICT = `
  INSERT INTO w9_verdicts (id, owner_id, artifact_id, artifact_version, overall, ran_at)
  VALUES (?, ?, ?, ?, ?, ?)
`;
const INSERT_CHECK = `
  INSERT INTO w9_verdict_checks (verdict_id, seq, kind, ref, status, severity, reason)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`;

export function saveVerdict(db, ownerId, verdict, options = {}) {
  if (!db || typeof db.prepare !== 'function') throw contractInvalid('db must be an open agentic database');
  if (typeof ownerId !== 'string' || ownerId.length === 0) {
    throw contractInvalid('ownerId must be a non-empty string');
  }
  if (!isPlainObject(verdict)) throw contractInvalid('verdict must be an object');
  if (typeof verdict.artifactId !== 'string' || verdict.artifactId.length === 0) {
    throw contractInvalid('verdict.artifactId must be a non-empty string');
  }
  if (!Number.isInteger(verdict.version) || verdict.version < 1) {
    throw contractInvalid('verdict.version must be an integer >= 1');
  }
  if (!VERDICT_OVERALLS.includes(verdict.overall)) {
    throw contractInvalid('verdict.overall must be one of VERIFIED | FAILED | UNKNOWN');
  }
  if (!Array.isArray(verdict.checks)) throw contractInvalid('verdict.checks must be an array');
  verdict.checks.forEach((check, index) => {
    if (!isValidCheck(check)) throw contractInvalid(`verdict.checks[${index}] does not match the check shape`);
  });
  if (!isIsoDateTime(verdict.ranAt)) {
    throw contractInvalid('verdict.ranAt must be an ISO date-time string');
  }

  const { idGen, events } = options;
  const id = typeof idGen === 'function' ? idGen() : randomUUID();
  if (typeof id !== 'string' || id.length === 0) {
    throw contractInvalid('idGen must return a non-empty string');
  }

  db.prepare(INSERT_VERDICT).run(id, ownerId, verdict.artifactId, verdict.version, verdict.overall, verdict.ranAt);
  const insertCheck = db.prepare(INSERT_CHECK);
  verdict.checks.forEach((check, index) => {
    insertCheck.run(id, index + 1, check.kind, check.ref, check.status, check.severity, check.reason);
  });

  const saved = {
    id,
    artifactId: verdict.artifactId,
    version: verdict.version,
    overall: verdict.overall,
    checks: verdict.checks,
    ranAt: verdict.ranAt,
  };
  if (events && typeof events.emit === 'function') {
    events.emit({
      type: 'verdict.saved',
      ownerId,
      objectType: 'verdict',
      objectId: id,
      at: verdict.ranAt,
      data: { artifactId: verdict.artifactId, artifactVersion: verdict.version, overall: verdict.overall },
    });
  }
  return saved;
}
