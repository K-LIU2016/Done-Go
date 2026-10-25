// 双版本切换：默认是 Kira 版（本进程）；访问 /v2 写入 cookie 后，所有请求（含语音 WebSocket）
// 原样转发到新版进程（TANGO_NEXT_PORT）；访问 /v1 清掉 cookie 回到默认版。同一域名、同一隧道，不改 ingress/DNS。
// ponytail: 两版各自独立的数据库与登录态，切换后访客模式会自动重新登录；要共享账号再合库
import { request } from 'node:http';
import { connect } from 'node:net';

export const VERSION_COOKIE = 'donego_version';
const NEXT = 'v2';
const ONE_MONTH = 30 * 24 * 3600;

export function versionOf(req) {
  return /(?:^|;\s*)donego_version=v2(?:;|$)/.test(req.headers.cookie || '') ? NEXT : 'v1';
}

export function createVersionSwitch({ nextPort, secure = false }) {
  const cookie = (value, maxAge) => `${VERSION_COOKIE}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
  const redirect = (res, value, maxAge) => res.writeHead(302, { 'Set-Cookie': [cookie(value, maxAge)], Location: '/', 'Cache-Control': 'no-store' }).end();

  // 返回 true 表示请求已被处理（切换或转发），调用方不再继续。
  function handle(req, res) {
    const path = (req.url || '/').split('?')[0];
    if (path === '/v2' || path === '/v2/') { redirect(res, NEXT, ONE_MONTH); return true; }
    if (path === '/v1' || path === '/v1/') { redirect(res, '', 0); return true; }
    if (versionOf(req) !== NEXT) return false;
    const upstream = request({ host: '127.0.0.1', port: nextPort, method: req.method, path: req.url, headers: req.headers }, up => {
      res.writeHead(up.statusCode, up.headers);
      up.pipe(res);
    });
    upstream.on('error', () => {
      if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end('新版暂时不可用，访问 /v1 回到默认版');
    });
    req.pipe(upstream);
    return true;
  }

  function upgrade(req, socket, head) {
    if (versionOf(req) !== NEXT) return false;
    const up = connect(nextPort, '127.0.0.1', () => {
      const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
      up.write(lines.join('\r\n') + '\r\n\r\n');
      if (head && head.length) up.write(head);
      up.pipe(socket);
      socket.pipe(up);
    });
    const kill = () => { up.destroy(); socket.destroy(); };
    up.on('error', kill);
    socket.on('error', kill);
    return true;
  }

  return { handle, upgrade };
}
