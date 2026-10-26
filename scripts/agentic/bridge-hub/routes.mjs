// bridge-hub HTTP/WSS 路由：桥只主动回连，服务端不监听额外端口。
// 路由工厂不挂载 serve-tango；调用方通过 routes(req,res,path) 和 handleUpgrade 自行挂载。
const HTTP_BODY_MAX = 64 * 1024; // 配对与撤销请求均为小 JSON。
const WS_OPEN = 1;

function writeJson(res, status, body) {
  const text = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader('connection', 'close');
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('content-length', Buffer.byteLength(text));
  res.end(text);
}

function readJson(req, maxBytes = HTTP_BODY_MAX) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let text = '';
    req.setEncoding('utf8');
    req.on('data', chunk => {
      size += Buffer.byteLength(chunk);
      if (size > maxBytes) { reject(Object.assign(new Error('REQUEST_TOO_LARGE'), { code: 'REQUEST_TOO_LARGE' })); req.destroy(); return; }
      text += chunk;
    });
    req.on('end', () => {
      try { resolve(text ? JSON.parse(text) : {}); }
      catch { reject(Object.assign(new Error('INVALID_JSON'), { code: 'INVALID_JSON' })); }
    });
    req.on('error', reject);
  });
}

function bearer(req) {
  const value = req.headers?.authorization;
  if (typeof value !== 'string') return null;
  const match = value.match(/^Bearer\s+(.+)$/i);
  return match?.[1] || null;
}

export function createBridgeRoutes({
  db,
  auth = () => { throw new Error('AUTH_REQUIRED'); },
  now = () => Date.now(),
  wss,
  pairing,
  devices,
  heartbeatMs = 30_000,
  maxPayloadBytes = 64 * 1024,
  onBridgeMessage = () => {},
  log = () => {},
} = {}) {
  if (!db || !wss || !pairing || !devices) throw new TypeError('db, wss, pairing and devices are required');
  const sessions = new Map(); // deviceId -> { ws, ownerId, timer }

  function authenticateOwner(req) {
    try {
      const identity = auth(req);
      if (!identity?.ownerId) throw new Error('AUTH_REQUIRED');
      return identity.ownerId;
    } catch (error) {
      throw Object.assign(new Error('AUTH_REQUIRED'), { statusCode: 401, cause: error });
    }
  }

  function rejectUpgrade(socket, status, code) {
    try { socket.end(`HTTP/1.1 ${status} ${code}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); } catch {}
  }

  function closeSession(deviceId, ws) {
    const current = sessions.get(deviceId);
    if (!current || current.ws !== ws) return;
    clearInterval(current.timer);
    sessions.delete(deviceId);
  }

  function handleUpgrade(req, socket, head) {
    const pathname = new URL(req.url || '/', 'http://localhost').pathname;
    if (pathname !== '/api/bridge') return false;
    const token = bearer(req);
    const identity = token && devices.resolveToken(token);
    if (!identity) { rejectUpgrade(socket, 401, 'UNAUTHORIZED'); return true; }
    try {
      wss.handleUpgrade(req, socket, head, ws => {
        const prior = sessions.get(identity.deviceId);
        if (prior) { clearInterval(prior.timer); try { prior.ws.close(4000, 'replaced'); } catch {} }
        const timer = setInterval(() => {
          if (ws.readyState === WS_OPEN) { try { ws.ping(); } catch {} }
          else closeSession(identity.deviceId, ws);
        }, heartbeatMs);
        const session = { ws, ownerId: identity.ownerId, deviceId: identity.deviceId, timer };
        sessions.set(identity.deviceId, session);
        ws.on('message', (data, isBinary) => {
          const bytes = Buffer.byteLength(data);
          if (bytes > maxPayloadBytes) { try { ws.close(1009, 'message too large'); } catch {} return; }
          let message;
          try { message = JSON.parse(isBinary ? Buffer.from(data).toString('utf8') : data.toString()); }
          catch { return; }
          if (message?.type === 'bridge.event') {
            try { onBridgeMessage({ ownerId: identity.ownerId, deviceId: identity.deviceId, message }); }
            catch (error) { log({ event: 'bridge-message-error', message: String(error?.message || error) }); }
          }
        });
        ws.on('close', () => closeSession(identity.deviceId, ws));
        ws.on('error', () => closeSession(identity.deviceId, ws));
      });
    } catch (error) {
      log({ event: 'bridge-upgrade-error', message: String(error?.message || error) });
      rejectUpgrade(socket, 500, 'UPGRADE_FAILED');
    }
    return true;
  }

  function sendToOwner(ownerId, message) {
    let count = 0;
    for (const session of sessions.values()) {
      if (session.ownerId !== ownerId || session.ws.readyState !== WS_OPEN) continue;
      try { session.ws.send(JSON.stringify(message)); count += 1; } catch {}
    }
    return count;
  }

  function apiError(code, message, details) {
    return { error: { code, message, ...(details ? { details } : {}) } };
  }

  // 先消费 POST body 再返回未登录，避免客户端尚未写完请求体时连接被重置。
  function unauthorizedPost(req, res) {
    readJson(req).catch(() => {}).finally(() => writeJson(res, 401, apiError('AUTH_REQUIRED', 'Owner authentication is required')));
  }

  function route(req, res, pathname = new URL(req.url || '/', 'http://localhost').pathname) {
    if (req.method === 'POST' && pathname === '/api/bridge/pair') {
      let ownerId;
      try { ownerId = authenticateOwner(req); } catch { unauthorizedPost(req, res); return true; }
      readJson(req).then(body => {
        const result = pairing.consumePairingCode(body.code, ownerId);
        if (!result.ok) {
          const status = result.code === 'OWNER_MISMATCH' ? 403 : 400;
          const code = result.code === 'OWNER_MISMATCH' ? 'FORBIDDEN' : result.code === 'PAIRING_CODE_EXPIRED' ? 'NOT_FOUND' : 'CONFLICT';
          writeJson(res, status, apiError(code, result.code));
          return;
        }
        const device = devices.issueDeviceToken(ownerId, body.label);
        writeJson(res, 200, device);
      }).catch(error => writeJson(res, error.code === 'REQUEST_TOO_LARGE' ? 413 : 400, apiError(error.code === 'REQUEST_TOO_LARGE' ? 'CONFLICT' : 'CONTRACT_INVALID', error.code || 'INVALID_JSON')));
      return true;
    }
    if (req.method === 'POST' && pathname === '/api/bridge/devices/revoke') {
      let ownerId;
      try { ownerId = authenticateOwner(req); } catch { unauthorizedPost(req, res); return true; }
      readJson(req).then(body => {
        const device = devices.listDevices(ownerId).find(item => item.deviceId === body.deviceId);
        if (!device) { writeJson(res, 404, apiError('NOT_FOUND', 'Bridge device was not found')); return; }
        devices.revokeDevice(body.deviceId, ownerId);
        const active = sessions.get(body.deviceId);
        if (active) { clearInterval(active.timer); sessions.delete(body.deviceId); try { active.ws.close(4001, 'revoked'); } catch {} }
        writeJson(res, 200, { ok: true });
      }).catch(error => writeJson(res, error.code === 'REQUEST_TOO_LARGE' ? 413 : 400, apiError(error.code === 'REQUEST_TOO_LARGE' ? 'CONFLICT' : 'CONTRACT_INVALID', error.code || 'INVALID_JSON')));
      return true;
    }
    return false;
  }

  function close() {
    for (const session of sessions.values()) { clearInterval(session.timer); try { session.ws.close(); } catch {} }
    sessions.clear();
  }

  route.handleUpgrade = handleUpgrade;
  route.sendToOwner = sendToOwner;
  route.close = close;
  return route;
}
