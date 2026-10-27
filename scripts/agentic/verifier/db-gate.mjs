// W9 M2 verifier-domain · DB 验收门禁（plan G1-M2-4）。
// dbVerdictGate(db, ownerId) → async (artifactId, version) => summary
// - 取该 (ownerId, artifactId, version) 的最新 verdict（ranAt DESC，rowid
//   DESC 兜底同刻写入），统计其 checks：任一 UNKNOWN 或 HIGH+FAIL →
//   blocking=true；只有 MEDIUM/LOW FAIL 不阻断（plan 字面规则）。
// - overall 门禁（brief 裁决③④，评审 HIGH 修复）：verdict.overall !==
//   'VERIFIED'（UNKNOWN/FAILED）一律 blocking=true——engine 的『没有 DoD
//   核验就没有免费 VERIFIED』不变量不得在 M2→M1 边界上被丢弃；builtin
//   可达变体（dod=[] → 只产出 injection PASS 的 UNKNOWN verdict）也因此
//   阻断，绝不计入已验收收益。FAILED+仅 MEDIUM/LOW FAIL 同样阻断
//   （严于 plan 字面，方向为收紧/fail-closed，正确性评审 [low]#1 随之收口）。
// - fail closed：没有任何 verdict（含跨 owner、版本不匹配、入参非法）→
//   blocking=true，绝不放行未核验产物进“已验收收益”。
// 导出给 W13 组装与 M4 组合测试（verdictGate 接口钉死于 plan）。

import { contractInvalid } from './shape.mjs';

const FAIL_CLOSED = { blocking: true, unknownCount: 0, highFailCount: 0 };

const LATEST_VERDICT = `
  SELECT id, overall FROM w9_verdicts
  WHERE owner_id = ? AND artifact_id = ? AND artifact_version = ?
  ORDER BY ran_at DESC, rowid DESC
  LIMIT 1
`;
const CHECKS_OF = 'SELECT status, severity FROM w9_verdict_checks WHERE verdict_id = ?';

export function dbVerdictGate(db, ownerId) {
  if (!db || typeof db.prepare !== 'function') throw contractInvalid('db must be an open agentic database');
  if (typeof ownerId !== 'string' || ownerId.length === 0) {
    throw contractInvalid('ownerId must be a non-empty string');
  }
  const latest = db.prepare(LATEST_VERDICT);
  const checksOf = db.prepare(CHECKS_OF);

  return async function verdictGate(artifactId, version) {
    if (typeof artifactId !== 'string' || artifactId.length === 0
      || !Number.isInteger(version) || version < 1) {
      return { ...FAIL_CLOSED };
    }
    const row = latest.get(ownerId, artifactId, version);
    if (!row) return { ...FAIL_CLOSED };
    const checks = checksOf.all(row.id);
    const unknownCount = checks.filter((check) => check.status === 'UNKNOWN').length;
    const highFailCount = checks.filter((check) => check.status === 'FAIL' && check.severity === 'HIGH').length;
    const overallBlocking = row.overall !== 'VERIFIED';
    return { blocking: overallBlocking || unknownCount > 0 || highFailCount > 0, unknownCount, highFailCount };
  };
}
