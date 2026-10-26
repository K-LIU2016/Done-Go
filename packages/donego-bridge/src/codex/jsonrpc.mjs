// Codex App Server 的 stdio JSON-RPC 客户端内核。协议帧按换行分隔，避免把半包误判为完整消息。
// spawn、回调和时钟均可注入，单测不启动真实 Codex 进程。

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const JSONRPC_VERSION = '2.0';

/**
 * 创建一个通过 stdio 与 Codex App Server 通信的 JSON-RPC 会话。
 * @param {object} options
 * @param {Function} options.spawn node:child_process.spawn 或兼容注入
 * @param {string[]} options.argv 要执行的命令和参数
 * @param {Function} [options.onNotify] 接收服务端通知 (method, params)
 * @param {Function} [options.onServerRequest] 接收服务端请求 (request, reply)
 * @param {Function} [options.onParseError] 接收坏 JSON 行 (line, error)
 * @param {Function} [options.now] 可注入的当前时间函数
 * @param {number} [options.requestTimeoutMs] 单请求超时
 */
export function createJsonRpcSession({
  spawn,
  argv = [],
  onNotify,
  onServerRequest,
  onParseError,
  now = Date.now,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
} = {}) {
  if (typeof spawn !== 'function') throw new TypeError('spawn is required');
  if (!Array.isArray(argv) || argv.length === 0) throw new TypeError('argv is required');

  // 保留 now 作为注入契约的一部分，也用于在错误中记录请求发起时刻。
  const startedAt = now();
  const child = spawn(argv[0], argv.slice(1), { stdio: ['pipe', 'pipe', 'pipe'] });
  if (!child?.stdin || !child?.stdout) throw new TypeError('spawn must return piped child');

  let nextId = 1;
  let closed = false;
  let buffer = '';
  const pending = new Map();

  function makeError(message, code, extra = {}) {
    const error = new Error(message);
    if (code !== undefined) error.code = code;
    Object.assign(error, extra);
    return error;
  }

  function rejectPending(error) {
    for (const item of pending.values()) {
      clearTimeout(item.timer);
      item.reject(error);
    }
    pending.clear();
  }

  function failSession(error) {
    if (closed) return;
    closed = true;
    rejectPending(error);
  }

  function writeFrame(frame) {
    if (closed) throw makeError('CLOSE: JSON-RPC session is closed', 'CLOSE');
    const line = `${JSON.stringify(frame)}\n`;
    try {
      child.stdin.write(line);
    } catch (error) {
      failSession(error);
      throw error;
    }
  }

  function replyFor(requestId) {
    let replied = false;
    return ({ result, error } = {}) => {
      if (replied || closed) return false;
      replied = true;
      const frame = { jsonrpc: JSONRPC_VERSION, id: requestId };
      if (error !== undefined) frame.error = error;
      else frame.result = result;
      writeFrame(frame);
      return true;
    };
  }

  function handleFrame(frame) {
    if (frame && Object.prototype.hasOwnProperty.call(frame, 'id') &&
        (Object.prototype.hasOwnProperty.call(frame, 'result') ||
         Object.prototype.hasOwnProperty.call(frame, 'error'))) {
      const item = pending.get(frame.id);
      if (!item) return;
      pending.delete(frame.id);
      clearTimeout(item.timer);
      if (frame.error !== undefined) {
        const rpcError = makeError(frame.error.message || 'JSON_RPC_ERROR', frame.error.code, {
          data: frame.error.data,
          rpcError: frame.error,
        });
        item.reject(rpcError);
      } else {
        item.resolve(frame.result);
      }
      return;
    }

    if (!frame || typeof frame.method !== 'string') return;
    if (Object.prototype.hasOwnProperty.call(frame, 'id')) {
      const reply = replyFor(frame.id);
      try {
        onServerRequest?.(frame, reply);
      } catch (error) {
        reply({ error: { code: -32603, message: error?.message || 'INTERNAL_ERROR' } });
      }
    } else {
      onNotify?.(frame.method, frame.params);
    }
  }

  function consume(chunk) {
    buffer += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    let newline;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline).replace(/\r$/, '');
      buffer = buffer.slice(newline + 1);
      if (!line.trim()) continue;
      try {
        handleFrame(JSON.parse(line));
      } catch (error) {
        if (error instanceof SyntaxError) onParseError?.(line, error);
        else onParseError?.(line, error);
      }
    }
  }

  child.stdout.on('data', consume);
  child.stdout.once('end', () => failSession(makeError('EOF: Codex App Server closed stdout', 'EOF')));
  child.stdout.once('error', error => failSession(error));
  if (child.once) child.once('error', error => failSession(error));

  function request(method, params) {
    if (closed) return Promise.reject(makeError('CLOSE: JSON-RPC session is closed', 'CLOSE'));
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!pending.has(id)) return;
        pending.delete(id);
        reject(makeError(`TIMEOUT: ${method}`, 'TIMEOUT', { method, id, startedAt }));
      }, Math.max(0, Number(requestTimeoutMs) || 0));
      pending.set(id, { resolve, reject, timer });
      try {
        writeFrame({ jsonrpc: JSONRPC_VERSION, id, method, params });
      } catch (error) {
        clearTimeout(timer);
        pending.delete(id);
        reject(error);
      }
    });
  }

  function notify(method, params) {
    writeFrame({ jsonrpc: JSONRPC_VERSION, method, params });
  }

  function close() {
    if (closed) return;
    closed = true;
    rejectPending(makeError('CLOSE: JSON-RPC session closed', 'CLOSE'));
    try { child.kill?.(); } catch { /* 子进程已退出时忽略 kill 错误 */ }
    try { child.stdin.end?.(); } catch { /* stdin 已关闭 */ }
  }

  return Object.freeze({ request, notify, close });
}

export const JSON_RPC_VERSION = JSONRPC_VERSION;
