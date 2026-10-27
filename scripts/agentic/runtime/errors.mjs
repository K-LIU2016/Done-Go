// W7 M1 · runtime-ports — fail-closed error primitives (errors.mjs)
//
// 契约依据：.s2d/plan.md M1；brief 裁决②（fail closed，不静默降级）。
// 所有错误码必须落在冻结 `contracts/agentic/api-error.schema.json` 的
// `error.code` 枚举内；错误 message 一律脱敏，绝不携带
// key / Authorization / cookie 等凭据正文（红线①：不读写打印任何 key）。

/**
 * Fail-closed error codes (strict subset of the frozen api-error enum).
 * NOT frozen on purpose: consumers (incl. tests) may sort the array in place.
 * Aligned with api-error.schema.json:
 * AUTH_REQUIRED, FORBIDDEN, NOT_FOUND, CONTRACT_INVALID, CONFLICT,
 * RATE_LIMITED, BUDGET_EXCEEDED, NEED_HUMAN, UPSTREAM_UNAVAILABLE, INTERNAL_ERROR.
 */
export const FAIL_CLOSED_CODES = [
  'FORBIDDEN',
  'BUDGET_EXCEEDED',
  'NEED_HUMAN',
  'UPSTREAM_UNAVAILABLE',
  'CONTRACT_INVALID',
  'CONFLICT',
];

/** Envelope fallback codes guaranteed to exist in the frozen enum. */
const GENERIC_CODE = 'INTERNAL_ERROR';

const REDACTIONS = [
  // bare "Bearer <token>" (with or without an Authorization header around it)
  [/\bbearer\s+\S+/gi, 'bearer [REDACTED]'],
  // Authorization: <scheme> <token> / authorization=<token>
  [/(authorization)(\s*[:=]\s*)(bearer\s+)?\S+/gi, '$1$2$3[REDACTED]'],
  // OpenAI-style secret keys sk-...
  [/\bsk-[A-Za-z0-9_-]{4,}/g, 'sk-[REDACTED]'],
  // cookie: <value> / cookie=<value>
  [/\b(cookie)(\s*[:=]\s*)\S+/gi, '$1$2[REDACTED]'],
  // api-key / api_key / x-api-key / token: <value>
  [/((?:x-)?api[_-]?key|token)(\s*[:=]\s*)\S+/gi, '$1$2[REDACTED]'],
];

/**
 * Redact credential-shaped substrings from a message. Never returns an
 * empty string: falls back to `fallback` so the api-error schema's
 * `message.minLength: 1` always holds.
 */
export function sanitizeMessage(message, fallback = 'fail-closed error') {
  let text = typeof message === 'string' ? message : '';
  for (const [pattern, replacement] of REDACTIONS) {
    text = text.replaceAll(pattern, replacement);
  }
  text = text.trim();
  return text === '' ? fallback : text;
}

function describeValue(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/**
 * Create a structured fail-closed error. Unknown codes are themselves a
 * programming error and throw immediately (no silent degradation into a
 * made-up code outside the frozen enum).
 */
export function failClosed(code, message, details) {
  if (!FAIL_CLOSED_CODES.includes(code)) {
    throw new TypeError(`invalid failClosed code ${describeValue(code)}; expected one of ${FAIL_CLOSED_CODES.join(', ')}`);
  }
  const error = new Error(sanitizeMessage(message, `${code} (no message)`));
  error.code = code;
  if (details !== undefined) error.details = details;
  return error;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Wrap any error into the frozen api-error envelope
 * `{ error: { code, message, details? } }` (validated against
 * api-error.schema.json by callers/tests).
 *
 * - failClosed errors keep their code; the message is re-sanitized.
 * - anything else (unknown Error, thrown string, null, ...) collapses to
 *   INTERNAL_ERROR with a generic message: arbitrary error text may carry
 *   credential material and must never be echoed back.
 */
export function toApiError(error) {
  const code = error !== null
    && typeof error === 'object'
    && typeof error.code === 'string'
    && FAIL_CLOSED_CODES.includes(error.code)
    ? error.code
    : GENERIC_CODE;
  if (code === GENERIC_CODE) {
    return { error: { code: GENERIC_CODE, message: 'internal error' } };
  }
  const envelope = {
    error: {
      code,
      message: sanitizeMessage(error.message, `${code} (no message)`),
    },
  };
  if (isPlainObject(error.details)) envelope.error.details = error.details;
  return envelope;
}
