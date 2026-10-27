// W9 M2 verifier-domain · DoD 逐条检查器（plan G1-M2-3）。
// 覆盖规则钉死：当且仅当存在 evidence e 满足
//   e.type === 'dod-check' && e.verified === true && e.detail === <DoD 原文>
// 该条为 PASS；否则 UNKNOWN —— 缺项不得升级为 VERIFIED（brief 裁决④）。

import { contractInvalid, evidenceOf } from './shape.mjs';

export function checkDod(artifact, dod) {
  if (!Array.isArray(dod) || dod.some((item) => typeof item !== 'string')) {
    throw contractInvalid('dod must be an array of strings');
  }
  const evidence = evidenceOf(artifact);
  return dod.map((item) => {
    const covering = evidence.find(
      (entry) => entry && entry.type === 'dod-check' && entry.verified === true && entry.detail === item,
    );
    return covering
      ? {
          kind: 'dod-item',
          ref: item,
          status: 'PASS',
          severity: 'LOW',
          reason: `covered by verified dod-check evidence: ${covering.title ?? ''}`,
        }
      : {
          kind: 'dod-item',
          ref: item,
          status: 'UNKNOWN',
          severity: 'HIGH',
          reason: 'no verified dod-check evidence covers this DoD item',
        };
  });
}
