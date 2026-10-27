// W9 M2 verifier-domain · 共享形状守护（内部结构，无冻结 schema）。
// Verdict/Check 是 W9 内部结构：冻结契约（contracts/agentic/**）没有对应
// schema，且 W9 不得新增 schema 文件（plan G1-M2 钉死），因此形状在这里
// 手工守护，与各测试文件头部注释钉死的形状一一对应。
// isIsoDateTime 镜像 scripts/agentic/contracts.mjs:5-6 的 date-time 正则
// （该正则未被 contracts.mjs 导出，故本地复刻同一规则）。

export const CHECK_KINDS = ['dod-item', 'citation', 'command-result', 'injection-marker'];
export const CHECK_STATUSES = ['PASS', 'FAIL', 'UNKNOWN'];
export const CHECK_SEVERITIES = ['HIGH', 'MEDIUM', 'LOW'];
export const VERDICT_OVERALLS = ['VERIFIED', 'FAILED', 'UNKNOWN'];

const OFFSET = String.raw`(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)`;
const ISO_DATE_TIME = new RegExp(String.raw`^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?${OFFSET}$`);

/** True for strings shaped like schema format date-time（contracts.mjs 同一规则）。 */
export function isIsoDateTime(value) {
  if (typeof value !== 'string' || !ISO_DATE_TIME.test(value)) return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T/.exec(value);
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return date.getUTCFullYear() === Number(match[1])
    && date.getUTCMonth() === Number(match[2]) - 1
    && date.getUTCDate() === Number(match[3])
    && !Number.isNaN(Date.parse(value));
}

export function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Check 形状：kind/ref/status/severity/reason 全部按枚举与类型钉死。 */
export function isValidCheck(check) {
  return isPlainObject(check)
    && CHECK_KINDS.includes(check.kind)
    && typeof check.ref === 'string' && check.ref.length > 0
    && CHECK_STATUSES.includes(check.status)
    && CHECK_SEVERITIES.includes(check.severity)
    && typeof check.reason === 'string';
}

export function contractInvalid(message) {
  const error = new Error(`CONTRACT_INVALID: ${message}`);
  error.code = 'CONTRACT_INVALID';
  return error;
}

/** 取 artifact.evidence 数组；缺省视为空，非数组的显式值按契约错误拒绝。 */
export function evidenceOf(artifact) {
  const evidence = artifact?.evidence;
  if (evidence === undefined || evidence === null) return [];
  if (!Array.isArray(evidence)) {
    throw contractInvalid('artifact.evidence must be an array when present');
  }
  return evidence;
}
