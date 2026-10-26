// W1 index-hook e2e harness：静态 web/ + fixture 登录（/api/auth/status|me）+ 自建挂载 createBlockRoutes。
// 路由不挂 serve-tango.mjs（BUILD-PLAN §2.1 L46：测试用自建 harness）；首个 HTML 响应种
// blocks-sid 会话 cookie，routes 的 authenticate 只认这个 cookie（401 路径由 routes 单测覆盖）。
// 端口：本流段 17601–17609（默认 17601，可用 S2D_W1_PORT 覆盖）。
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { createBlocksStore } from '../../../scripts/agentic/block-store/store.mjs';
import { createBlockRoutes } from '../../../scripts/agentic/block-store/routes.mjs';

const WEB_ROOT = resolve(fileURLToPath(new URL('../../../web/', import.meta.url)));
const MIGRATION = readFileSync(fileURLToPath(new URL('../../../scripts/agentic/db/migrations/blocks-001-blocks.sql', import.meta.url)), 'utf8');
const USER = { id: 'e2e-user', email: 'e2e@fixture.test', emailVerified: true, displayName: 'E2E', role: 'user' };
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png',
  '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.ico': 'image/x-icon',
};

const db = new DatabaseSync(':memory:');
db.exec(MIGRATION);
let tick = 0;
const clock = () => new Date(Date.parse('2026-10-26T00:00:00.000Z') + tick++).toISOString();
const store = createBlocksStore({ db, now: clock });
const requestAllowed = req => { // 同 tests/unit/agentic/blocks/harness.mjs:31 的本地放行逻辑
  const host = req.headers.host;
  if (!/^(?:localhost|127\.0\.0\.1):[0-9]+$/.test(host || '')) return false;
  const expected = 'http://' + host;
  const origin = req.headers.origin;
  return (!origin && ['GET', 'HEAD'].includes(req.method)) || origin === expected;
};
const authenticate = req => {
  if (!/blocks-sid=e2e-user/.test(String(req.headers.cookie || ''))) {
    throw Object.assign(new Error('AUTH_REQUIRED'), { code: 'AUTH_REQUIRED', status: 401 });
  }
  return USER;
};
const routes = createBlockRoutes({ store, authenticate, requestAllowed, now: clock });

function json(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }).end(JSON.stringify(value));
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/api/auth/status') return json(res, 200, { registrationEnabled: false, codeResendSeconds: 60, emailDelivery: 'console' });
    if (url.pathname === '/api/auth/me') return json(res, 200, { user: USER });
    const handled = await routes(req, res, url.pathname + url.search);
    if (handled || res.writableEnded) return;
    // 静态 web/（serve-tango.mjs:204 同款根内约束）；首页响应种 fixture 会话 cookie
    const target = resolve(WEB_ROOT, '.' + (url.pathname === '/' ? '/index.html' : url.pathname));
    if (!target.startsWith(WEB_ROOT.endsWith(sep) ? WEB_ROOT : WEB_ROOT + sep)) { res.writeHead(403).end(); return; }
    try {
      const body = await readFile(target);
      if (url.pathname === '/' || url.pathname === '/index.html') res.setHeader('Set-Cookie', 'blocks-sid=e2e-user; Path=/; SameSite=Lax');
      res.writeHead(200, { 'Content-Type': MIME[extname(target)] || 'application/octet-stream' }).end(body);
    } catch { res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found'); }
  } catch (error) {
    const status = Number.isInteger(error.status) ? error.status : 500;
    if (!res.headersSent) json(res, status, { error: typeof error.code === 'string' ? error.code : 'HARNESS_ERROR' });
  }
});

const port = Number(process.env.S2D_W1_PORT) || 17601;
server.listen(port, '127.0.0.1', () => process.stdout.write('s2d-w1 index-hook harness ready on ' + port + '\n'));
