// W9 M3 inbox-domain · 路由工厂（plan §G1-M3-5；挂载与 SSE/HTTP 归 W13，本模块不挂 serve-tango）
//
// createInboxRoutes({ db, auth, clock, idGen, events? }) → async (req, res, pathname) => handled:boolean
//   - GET  /api/inbox                    → 200 { items: [...] }（owner 隔离；item 含 id/status/revision，
//                                          revision 供客户端乐观回答）。
//   - POST /api/needs/:id/answer         → 200 { need: {...} }，body { answer, revision }。
//   - auth(req) → { ownerId } | null；null → 401 AUTH_REQUIRED（api-error 信封）。
//   - 未匹配的 pathname 返回 false 且不写响应（由挂载方继续分发）。
//   - 错误码只用 contracts/agentic/README.md §错误码与HTTP建议 枚举；不发任何外部通知（红线3）。
import { createNeedStore } from './need-store.mjs';

const GET_INBOX = /^\/api\/inbox$/;
const POST_ANSWER = /^\/api\/needs\/([^/]+)\/answer$/;

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

class ApiError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

function httpStatusFor(code) {
  return HTTP_BY_CODE[code] ?? 500;
}

function toApiError(error) {
  if (error instanceof ApiError) return error;
  if (HTTP_BY_CODE[error?.code] !== undefined) {
    return new ApiError(error.code, error.message);
  }
  const wrapped = new ApiError('INTERNAL_ERROR', 'unclassified inbox-domain failure');
  wrapped.cause = error;
  return wrapped;
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function sendApiError(res, error) {
  const apiError = toApiError(error);
  const envelope = { error: { code: apiError.code, message: apiError.message } };
  if (apiError.details !== undefined) envelope.error.details = apiError.details;
  sendJson(res, httpStatusFor(apiError.code), envelope);
}

const MAX_BODY_BYTES = 1024 * 1024;

/** 读取并解析 JSON 请求体；空体视为 {}；非对象/非法 JSON/超限 → CONTRACT_INVALID。 */
async function readJsonBody(req) {
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

export function createInboxRoutes({ db, auth, clock, idGen, events }) {
  for (const [key, value] of [['db', db], ['auth', auth], ['clock', clock], ['idGen', idGen]]) {
    if (value === undefined || value === null) {
      throw new Error(`createInboxRoutes: missing required injectable(s): ${key}`);
    }
  }
  const store = createNeedStore({ db, clock, idGen, events });

  return async function inboxRoutes(req, res, pathname) {
    const rawPath = typeof pathname === 'string' && pathname !== '' ? pathname : req?.url;
    if (typeof rawPath !== 'string' || rawPath === '') return false;
    const path = rawPath.split('?')[0];

    const method = req?.method;
    const isInboxList = method === 'GET' && GET_INBOX.test(path);
    const answerMatch = method === 'POST' ? POST_ANSWER.exec(path) : null;
    if (!isInboxList && answerMatch === null) return false;

    try {
      const session = auth(req);
      if (session === null || session === undefined || typeof session.ownerId !== 'string' || session.ownerId === '') {
        throw new ApiError('AUTH_REQUIRED', 'authentication required');
      }
      const { ownerId } = session;

      if (isInboxList) {
        const items = await store.list(ownerId);
        sendJson(res, 200, { items });
        return true;
      }

      const needId = decodeURIComponent(answerMatch[1]);
      const body = await readJsonBody(req);
      const need = await store.answer(ownerId, needId, { answer: body.answer, revision: body.revision });
      sendJson(res, 200, { need });
      return true;
    } catch (error) {
      sendApiError(res, error);
      return true;
    }
  };
}
