// S2D-W13 · M14 路由复用器（scripts/agentic/integration/dispatcher.mjs）。
//
// 依据：brief §4.2「路由复用器」、plan.md §G2 M14、冻结契约
// contracts/agentic/README.md「错误码与 HTTP 建议」（唯一来源）+
// api-error.schema.json 统一错误信封。
//
// 职责（挂载约定与 serve-tango 既有 `options.collaboration.handle`
// 先例同构，scripts/serve-tango.mjs:106-112 @60fdc73）：
//   - 有序 prefix 复用：按注册顺序调用 handler(req, res, pathname, env)，
//     返回真值即视为 handled；全部未处理 → 落回 legacy(req, res, pathname)；
//     无 legacy → 返回 false 且不触碰响应（调用方继续走静态/既有路径）。
//   - 统一鉴权门：每请求恰好一次 context.auth(req)（W13 组合根 M13 的单一
//     principal 解析器；W10 观测要求同步形状，await 兼容两者）。受保护路径
//     未登录 → 401 AUTH_REQUIRED，不进入任何 handler。
//   - 统一 body 上限（maxBodyBytes，超出 → HTTP 413 + 信封 details.limitBytes）
//     与 JSON 解析（坏 JSON → 400 CONTRACT_INVALID）；读体惰性且缓存，
//     未读体的请求原样交给 legacy。
//   - 冻结错误信封：{ error: { code, message, details?, requestId? } }，
//     code 必须是 api-error.schema.json 枚举值；信封不泄露 key/栈/内部路径。
//   - SSE：headers/event-stream 透传；中途上游失败时最后一帧携带错误信封、
//     绝不补 [DONE] 成功标记；客户端断开时 env.signal abort 并经
//     context.events 记 outcome=UNKNOWN 事件（断开与 UNKNOWN 不吞）。
//
// 红线：无隐藏 wall clock（时间戳一律 context.clock）；不读 key；不做外部调用。
// 无配置（不挂载）时 legacy serve-tango 行为不变（本模块只是被注入方）。

/** 冻结 README「错误码与 HTTP 建议」表的唯一 JS 来源镜像（M14 校验锁定）。 */
export const ERROR_STATUS = Object.freeze({
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

const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;

/** 免鉴权路径（M17 health）：未登录也可探测，principal 保持 null 传入 env。 */
const PUBLIC_PATHS = new Set(['/api/agentic/health']);

const JSON_HEADERS = Object.freeze({
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
});

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 把 handler 抛出的任意错误归一为冻结信封载荷。
 * - code 在枚举内 → 透传 message/details（status 可被 error.status 覆盖，
 *   仅用于传输层 413 body 上限；域错误不应携带 status）。
 * - 未枚举/缺 code/Error 实例 → INTERNAL_ERROR + 通用 message，
 *   丢弃 details，绝不回显内部信息（key/栈/模块路径）。
 */
function toEnvelope(error, requestId) {
  const code = typeof error?.code === 'string' && error.code in ERROR_STATUS ? error.code : 'INTERNAL_ERROR';
  const known = code !== 'INTERNAL_ERROR';
  const status = Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599
    ? error.status
    : ERROR_STATUS[code];
  const message = known && typeof error.message === 'string' && error.message.length > 0
    ? error.message
    : (code === 'INTERNAL_ERROR' ? 'internal error' : code);
  const envelope = { error: { code, message } };
  if (known && isPlainObject(error.details)) envelope.error.details = error.details;
  if (typeof requestId === 'string' && requestId.length > 0) envelope.error.requestId = requestId;
  return { status, envelope };
}

/**
 * 有序 prefix 路由复用器。
 *
 * @param {object} options
 * @param {object} options.context        M13 组合根（db/auth/clock/idGen/events/
 *                                        traceSink/policyPort）；auth 必注。
 * @param {Array<Function>} options.handlers 有序 handler，签名
 *                                        (req, res, pathname, env) => handled:boolean
 * @param {Function} [options.legacy]     全部未处理时的落回 (req,res,pathname)
 * @param {number} [options.maxBodyBytes] env.readBody 的统一 body 上限
 * @param {Function} [options.requestId]  () => string，错误信封 requestId 来源
 */
export function createAgenticDispatcher({
  context,
  handlers = [],
  legacy = null,
  maxBodyBytes = DEFAULT_MAX_BODY_BYTES,
  requestId = null,
} = {}) {
  if (!isPlainObject(context)) throw new Error('dispatcher context required (M13 integration root)');
  if (typeof context.auth !== 'function') throw new Error('dispatcher context.auth required (single principal resolver)');
  if (!Array.isArray(handlers)) throw new Error('dispatcher handlers must be an array');
  if (legacy !== null && typeof legacy !== 'function') throw new Error('dispatcher legacy must be a function');
  if (typeof requestId !== 'function' && requestId !== null && requestId !== undefined) {
    throw new Error('dispatcher requestId must be a function');
  }
  if (!Number.isInteger(maxBodyBytes) || maxBodyBytes <= 0) throw new Error('dispatcher maxBodyBytes must be a positive integer');

  async function sendError(res, error, requestIdValue) {
    const { status, envelope } = toEnvelope(error, requestIdValue);
    if (res.headersSent) {
      // SSE 中途失败：最后一帧携带冻结信封并终止流，绝不补成功标记。
      // 真实 http.ServerResponse 用 getHeader（无 .headers 属性）；测试 fake 用 .headers。
      const contentType = String(
        (typeof res.getHeader === 'function' ? res.getHeader('content-type') : undefined)
          ?? res.headers?.['content-type']
          ?? '',
      );
      if (contentType.startsWith('text/event-stream') && !res.writableEnded) {
        res.write(`data: ${JSON.stringify(envelope)}\n\n`);
        res.end();
      } else if (!res.writableEnded) {
        res.end();
      }
      return;
    }
    res.writeHead(status, JSON_HEADERS);
    res.end(JSON.stringify(envelope));
  }

  async function handle(req, res, pathname) {
    let requestIdValue = null;
    try {
      requestIdValue = typeof requestId === 'function'
        ? requestId()
        : (typeof context.idGen?.next === 'function' ? context.idGen.next('req') : null);
    } catch {
      requestIdValue = null; // requestId 生成失败不得影响请求处理
    }

    // —— 客户端断开检测：只看响应侧 premature close（res 'close' 且未写完）
    // 与请求侧 'aborted'。不监听 req 'close'（body 读尽后流自动销毁也会触发，
    // 会把正常完成误判为断开）。断开 → env.signal abort + events 记 UNKNOWN。
    //
    // 监听生命周期（M21 修复）：handler 返回后按响应状态分流——
    //   - 已写完（res.writableEnded，普通短请求/已收尾的流）：finally 立即拆
    //     监听，零泄漏；后续 'close' 与本模块无关。
    //   - 仍开放（SSE/长连接，handler 同步返回把流留给后续写入者）：保留断连
    //     监听直到 response end/close，由 onResClose/onReqAborted 幂等自清；
    //     断开照记 client_disconnect outcome=UNKNOWN，正常写完只清理不记
    //     （writableEnded 区分正常结束与中途断开，无假阳性）。
    let disconnectRecorded = false;
    const controller = new AbortController();
    const recordDisconnect = () => {
      if (!controller.signal.aborted) controller.abort();
      if (disconnectRecorded) return;
      disconnectRecorded = true;
      const event = {
        type: 'client_disconnect',
        outcome: 'UNKNOWN', // 断开时外部副作用不可证明 → 永远 UNKNOWN，不吞不改
        requestId: requestIdValue,
        pathname,
        method: req.method,
      };
      if (typeof context.clock?.now === 'function') event.at = context.clock.now();
      try { context.events?.emit?.(event); } catch { /* 事件汇故障不得影响响应路径 */ }
    };
    const cleanupListeners = () => {
      res.removeListener?.('close', onResClose);
      req.removeListener?.('aborted', onReqAborted);
    };
    const onResClose = () => {
      if (res.writableEnded) {
        cleanupListeners(); // 正常写完后的 close：只清理，不记断开
        return;
      }
      recordDisconnect();
      cleanupListeners();
    };
    const onReqAborted = () => {
      recordDisconnect();
      cleanupListeners();
    };
    res.on?.('close', onResClose);
    req.on?.('aborted', onReqAborted);

    try {
      // —— 统一鉴权门：每请求恰好一次（测试锁定 authCalls===1）。
      let principal = null;
      try {
        principal = await context.auth(req);
      } catch {
        principal = null; // 鉴权器故障按未登录处理，public 路径不受影响
      }
      const authenticated = principal !== null && principal !== undefined;
      if (!authenticated && !PUBLIC_PATHS.has(pathname)) {
        await sendError(res, { code: 'AUTH_REQUIRED', message: 'authentication required' }, requestIdValue);
        return true; // 错误响应也算 handled
      }

      // —— env：惰性缓存的受信读体 + 断开信号。
      let bodyPromise = null;
      const readBody = () => {
        if (bodyPromise) return bodyPromise;
        bodyPromise = (async () => {
          const chunks = [];
          let bytes = 0;
          let overflowed = false;
          for await (const chunk of req) {
            bytes += chunk.length;
            if (bytes > maxBodyBytes) {
              overflowed = true;
              chunks.length = 0; // 超限后不再缓冲，仅排空（keep-alive 友好）
              continue;
            }
            chunks.push(chunk);
          }
          if (overflowed) {
            throw {
              code: 'CONTRACT_INVALID',
              status: 413,
              message: 'request body exceeds the configured limit',
              details: { limitBytes: maxBodyBytes },
            };
          }
          const raw = Buffer.concat(chunks).toString('utf8');
          try {
            return JSON.parse(raw);
          } catch {
            throw { code: 'CONTRACT_INVALID', message: 'request body is not valid JSON', details: {} };
          }
        })();
        // 缓存的是同一 promise：多次 readBody 只解析一次（测试锁定）；
        // 失败同样缓存（重复读返回同一确定性错误，不重读已耗尽的流）。
        bodyPromise.catch(() => {}); // 仅抑制 unhandledRejection 告警
        return bodyPromise;
      };
      const env = {
        principal: authenticated ? principal : null,
        requestId: requestIdValue,
        pathname,
        signal: controller.signal,
        readBody,
      };

      // —— 有序复用：第一个返回真值的 handler 胜出。
      for (const handler of handlers) {
        const handled = await handler(req, res, pathname, env);
        if (handled) return true;
      }

      // —— 未处理：落回 legacy（body 仍未读，原样可用）；无 legacy 则不碰响应。
      if (legacy) return Boolean(await legacy(req, res, pathname));
      return false;
    } catch (error) {
      await sendError(res, error, requestIdValue);
      return true;
    } finally {
      // 已结束响应：立即拆监听（短请求零泄漏）；开放响应（SSE/未结束）：
      // 保留断连监听至 response end/close 自清（onResClose/onReqAborted）。
      if (res.writableEnded) cleanupListeners();
    }
  }

  return { handle };
}
