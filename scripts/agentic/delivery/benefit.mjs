// W9 M1 delivery-domain · 已验收收益门禁（brief 裁决③）
//
// acceptedBenefit(acceptance, verdictSummary) —— 纯函数，无 IO、无时钟。
//   - 仅 acceptance.decision === 'accepted' 且 verdictSummary.blocking === false 才计入收益；
//     其余（rejected / revision_requested / 无核验结果 / UNKNOWN 或 HIGH 未决）一律返回 null。
//   - verdictSummary 由注入的 verdictGate(artifactId, version) 提供（M2 dbVerdictGate 的形状）：
//     { blocking: boolean, unknownCount: number, highFailCount: number }
//   - verdictSummary 缺失 = 没有任何核验结果 = fail closed → null（用户验收 ≠ agent 自报成功）。
export function acceptedBenefit(acceptance, verdictSummary) {
  if (acceptance === null || typeof acceptance !== 'object') return null;
  if (acceptance.decision !== 'accepted') return null;
  if (verdictSummary === null || typeof verdictSummary !== 'object') return null;
  if (verdictSummary.blocking !== false) return null;

  return {
    artifactId: acceptance.artifactId,
    acceptanceId: acceptance.id ?? null,
    actor: acceptance.actor ?? null,
    decidedAt: acceptance.createdAt ?? null,
    verdict: {
      blocking: false,
      unknownCount: typeof verdictSummary.unknownCount === 'number' ? verdictSummary.unknownCount : 0,
      highFailCount: typeof verdictSummary.highFailCount === 'number' ? verdictSummary.highFailCount : 0,
    },
  };
}
