// W9 M2 verifier-domain · 提示注入/外部内容标记（PRD §8.3，plan G1-M2-3）。
// 钉死三类指令式模式；命中 → FAIL + HIGH。正常措辞（请参考/请查看/执行
// 摘要/请求执行…）不得误报。ref 取调用方给的来源标识，缺省用截断文本。

import { contractInvalid } from './shape.mjs';

const INJECTION_PATTERNS = [
  { name: '忽略之前指令', pattern: /忽略(?:之前|先前|以上|上述)指令/ },
  { name: '请执行<命令>', pattern: /请执行\s*\S+/ },
  { name: 'ignore … previous instructions', pattern: /\bignore\b[^\n]{0,120}?previous\s+instructions/i },
];

function truncate(text) {
  return text.length <= 80 ? text : `${text.slice(0, 80)}…`;
}

export function checkInjection(text, ref) {
  if (typeof text !== 'string') throw contractInvalid('text must be a string');
  const hit = INJECTION_PATTERNS.find((entry) => entry.pattern.test(text));
  const label = typeof ref === 'string' && ref.length > 0 ? ref : (text.length > 0 ? truncate(text) : '(empty text)');
  return hit
    ? {
        kind: 'injection-marker',
        ref: label,
        status: 'FAIL',
        severity: 'HIGH',
        reason: `instruction-style injection pattern matched: ${hit.name}`,
      }
    : {
        kind: 'injection-marker',
        ref: label,
        status: 'PASS',
        severity: 'LOW',
        reason: 'no instruction-style injection pattern found',
      };
}
