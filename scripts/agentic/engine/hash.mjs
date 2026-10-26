// S2D-W2 引擎基础：合同与步骤输入的规范化 SHA-256 哈希。
// 依据：PRD §8.1；BUILD-PLAN W0-4/W2，数组顺序保持语义，对象键递归排序。
import { createHash } from 'node:crypto';

function normalize(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('CANONICAL_JSON_NON_FINITE_NUMBER');
    return value;
  }
  if (typeof value === 'bigint') return `${value}n`;
  if (Array.isArray(value)) return value.map(normalize);
  if (typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      const item = value[key];
      if (item !== undefined && typeof item !== 'function' && typeof item !== 'symbol') out[key] = normalize(item);
    }
    return out;
  }
  throw new TypeError(`CANONICAL_JSON_UNSUPPORTED:${typeof value}`);
}

export function canonicalJson(value) {
  return JSON.stringify(normalize(value));
}

export function sha256Hex(value) {
  return createHash('sha256').update(String(value), 'utf8').digest('hex');
}

export function contractHash(contract) {
  return sha256Hex(canonicalJson(contract));
}

export function stepInputHash(input) {
  return sha256Hex(canonicalJson(input));
}
