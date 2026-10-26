// 本机桥出站 WSS 客户端：只主动连接 hub，不创建监听端口。
// WebSocket 构造器注入，便于离线夹具测试并保持独立包零运行时依赖。
const OPEN = 1;
const REVOKED_CLOSE = 4001;

function withToken(url, token) {
  const target = new URL(url);
  target.searchParams.set('token', token);
  return target.toString();
}

export function createBridgeClient({
  url,
  token,
  WebSocket,
  heartbeatMs = 30_000,
  minBackoffMs = 250,
  maxBackoffMs = 30_000,
  onMessage = () => {},
  onRevoked = () => {},
  onStateChange = () => {},
  log = () => {},
} = {}) {
  if (!url || !token || typeof WebSocket !== 'function') throw new TypeError('url, token and WebSocket are required');
  let socket = null;
  let timer = null;
  let heartbeat = null;
  let stopped = true;
  let revoked = false;
  let reconnectDelay = minBackoffMs;

  const state = (name, info) => { try { onStateChange(name, info); } catch (error) { log({ event: 'state-handler-error', error }); } };
  const clearTimers = () => {
    if (timer) { clearTimeout(timer); timer = null; }
    if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
  };
  const markRevoked = reason => {
    if (revoked) return;
    revoked = true;
    clearTimers();
    state('revoked', { reason });
    try { onRevoked(reason); } catch (error) { log({ event: 'revoked-handler-error', error }); }
  };
  const scheduleReconnect = code => {
    if (stopped || revoked) return;
    const delayMs = reconnectDelay;
    reconnectDelay = Math.min(maxBackoffMs, Math.max(minBackoffMs, reconnectDelay * 2));
    state('reconnecting', { code, delayMs });
    timer = setTimeout(() => { timer = null; if (!stopped && !revoked) connect(); }, delayMs);
  };
  function connect() {
    if (stopped || revoked) return;
    clearTimers();
    state('connecting');
    let ws;
    try {
      ws = new WebSocket(withToken(url, token), {
        headers: { authorization: `Bearer ${token}` },
      });
    }
    catch (error) { state('error', { error }); scheduleReconnect('constructor'); return; }
    socket = ws;
    ws.on('open', () => {
      if (socket !== ws || stopped || revoked) return;
      reconnectDelay = minBackoffMs;
      state('connected');
      heartbeat = setInterval(() => {
        if (ws.readyState === undefined || ws.readyState === OPEN) { try { ws.ping(); } catch {} }
      }, heartbeatMs);
    });
    ws.on('message', data => {
      let message;
      try { message = JSON.parse(Buffer.isBuffer(data) ? data.toString('utf8') : String(data)); }
      catch (error) { log({ event: 'invalid-message', error }); return; }
      if (message?.type === 'device.revoked') { markRevoked('message'); try { ws.close(REVOKED_CLOSE, 'revoked'); } catch {} return; }
      try { onMessage(message); } catch (error) { log({ event: 'message-handler-error', error }); }
    });
    ws.on('close', code => {
      if (socket !== ws) return;
      clearTimers();
      socket = null;
      if (code === REVOKED_CLOSE) { markRevoked('close'); return; }
      if (!stopped && !revoked) scheduleReconnect(code);
      else state('stopped', { code });
    });
    ws.on('error', error => { log({ event: 'socket-error', error }); });
  }
  return {
    connect() { if (stopped && !revoked) { stopped = false; connect(); } },
    stop() { stopped = true; clearTimers(); const current = socket; socket = null; if (current) { try { current.close(); } catch {} } state('stopped'); },
    isRevoked() { return revoked; },
    getState() { return { connected: Boolean(socket && (socket.readyState === undefined || socket.readyState === OPEN)), revoked, stopped }; },
  };
}
