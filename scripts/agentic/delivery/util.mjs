// W9 M1 delivery-domain · 共享工具
//
// 只依赖冻结契约校验器（scripts/agentic/contracts.mjs）与 node 内建模块；
// 不读 key、不联网、不 spawn。错误码只用 contracts/agentic/README.md §错误码与HTTP建议 的枚举。
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 冻结契约目录（contracts/agentic），由本模块位置推导，不从环境读取。 */
export const CONTRACT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'contracts', 'agentic');

const HTTP_BY_CODE = Object.freeze({
  AUTH_REQUIRED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONTRACT_INVALID: 400,
  CONFLICT: 409,
  RATE_LIMITED: 429,
  BUDGET_EXCEEDED: 409,
  NEED_HUMAN: 409,
  UPSTREAM_UNAVAILABLE: 503,
  INTERNAL_ERROR: 500,
});

/** 业务错误：Error 子类，携带 README 枚举 error.code。 */
export class ApiError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export function httpStatusFor(code) {
  return HTTP_BY_CODE[code] ?? 500;
}

/** 未归类异常统一 INTERNAL_ERROR（api-error 枚举内的兜底码）。 */
export function toApiError(error) {
  if (error instanceof ApiError) return error;
  const wrapped = new ApiError('INTERNAL_ERROR', 'unclassified delivery-domain failure');
  wrapped.cause = error;
  return wrapped;
}

/** 发送统一 JSON 响应（错误走 api-error 信封）。 */
export function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(payload);
}

export function sendApiError(res, error) {
  const apiError = toApiError(error);
  const envelope = { error: { code: apiError.code, message: apiError.message } };
  if (apiError.details !== undefined) envelope.error.details = apiError.details;
  sendJson(res, httpStatusFor(apiError.code), envelope);
}

const MAX_BODY_BYTES = 1024 * 1024;

/** 读取并解析 JSON 请求体；空体视为 {}；非对象/非法 JSON → CONTRACT_INVALID。 */
export async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new ApiError('CONTRACT_INVALID', 'request body too large');
    chunks.push(buffer);
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (raw === '') return {};
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ApiError('CONTRACT_INVALID', 'request body is not valid JSON');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ApiError('CONTRACT_INVALID', 'request body must be a JSON object');
  }
  return parsed;
}

/** 工厂依赖检查：db/clock/idGen 必须显式注入（业务路径禁真实 wall clock，W4 教训）。 */
export function requireInjectables(name, deps, keys) {
  const missing = keys.filter((key) => deps[key] === undefined || deps[key] === null);
  if (missing.length > 0) {
    throw new Error(`${name}: missing required injectable(s): ${missing.join(', ')}`);
  }
}

/** 非空字符串校验（owner/artifact 等 id 类字段共用）。 */
export function assertNonEmptyString(value, field) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ApiError('CONTRACT_INVALID', `${field} must be a non-empty string`, { field });
  }
  return value;
}

/** 拒绝客户端提交本应服务端生成的字段（brief 裁决②：身份/hash/来源/时间一律服务端生成）。 */
export function rejectServerOwnedFields(payload, fields, objectType) {
  const forged = fields.filter((field) => Object.prototype.hasOwnProperty.call(payload, field));
  if (forged.length > 0) {
    throw new ApiError('CONTRACT_INVALID', `${objectType} server-owned field(s) submitted by client`, {
      objectType,
      fields: forged,
    });
  }
}

/** 拒绝载荷中的未知字段（冻结契约 additionalProperties:false 的入口侧对应物）。 */
export function rejectUnknownFields(payload, allowed, objectType) {
  const unknown = Object.keys(payload).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw new ApiError('CONTRACT_INVALID', `${objectType} payload has unknown field(s)`, {
      objectType,
      fields: unknown,
    });
  }
}

/** 默认 no-op 事件 sink（W10 observability 只经注入 events.emit 对接）。 */
export const NOOP_EVENTS = { emit() {} };

/** 单语句序列包成事务：失败回滚，异常原样上抛。 */
export function withTransaction(db, fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // 保留原始异常；回滚失败时连接已不可信，由调用方处置。
    }
    throw error;
  }
}
