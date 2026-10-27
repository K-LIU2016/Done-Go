// W9 M2 verifier-domain · 引用/证据完整性检查器（plan G1-M2-3）。
// 只检查 evidence 中 type === 'citation-list' 的条目；PASS 当且仅当
// uri 为非空字符串 && verified === true && detail 为非空字符串。
// 缺 uri / 未核验 / 缺 detail → UNKNOWN（brief 裁决④：不得升级为 VERIFIED；
// 可达性判定由注入 checker 扩展，W13 组装）。

import { evidenceOf } from './shape.mjs';

export function checkCitations(artifact) {
  const evidence = evidenceOf(artifact);
  return evidence
    .filter((entry) => entry && entry.type === 'citation-list')
    .map((entry) => {
      const ref = typeof entry.title === 'string' && entry.title.length > 0 ? entry.title : 'citation-list';
      const complete = typeof entry.uri === 'string' && entry.uri.length > 0
        && entry.verified === true
        && typeof entry.detail === 'string' && entry.detail.length > 0;
      return complete
        ? { kind: 'citation', ref, status: 'PASS', severity: 'LOW', reason: 'citation list has uri, detail and verification' }
        : { kind: 'citation', ref, status: 'UNKNOWN', severity: 'MEDIUM', reason: 'citation list missing uri, detail or verification' };
    });
}
