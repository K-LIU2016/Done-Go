// W1 blocks-e2e harness：双设备同账号同步 e2e（sync-two-devices.spec.ts）的自建服务。
//   真 /api/auth/*（createCollaborationService，:memory: + allowLocalAccounts，注册走真邮箱验证码，
//     sendEmail 捕获进内存 mailbox、不发真邮件——同 tests/helpers/email-server.mjs 的 fixture 配方）
//   + collaboration.authenticate/requestAllowed 接自建挂载的 createBlockRoutes（/api/blocks*，
//     不挂 serve-tango.mjs，BUILD-PLAN §2.1 L46）
//   + 自写静态段服务 web/（复用 serve-tango.mjs:204-213 的根内约束与写法，不 import 它）。
// 端口：本流段 17601–17609 的 17602（17601 留给 index-hook 的 harness-server.mjs），S2D_W1_E2E_PORT 可覆盖。
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { createCollaborationService } from '../../../scripts/collaboration-service.mjs';
import { readAuthConfig } from '../../../server/auth/config.mjs';
import { createBlocksStore } from '../../../scripts/agentic/block-store/store.mjs';
import { createBlockRoutes } from '../../../scripts/agentic/block-store/routes.mjs';

const WEB_ROOT = resolve(fileURLToPath(new URL('../../../web/', import.meta.url)));
const MIGRATION = readFileSync(fileURLToPath(new URL('../../../scripts/agentic/db/migrations/blocks-001-blocks.sql', import.meta.url)), 'utf8');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png',
  '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.ico': 'image/x-icon',
};

// ── 真 /api/auth：邮箱验证码注册（验证码只进内存 mailbox；resend 形状的 authConfig 让
//    registrationEnabled=true，RESEND_API_KEY 是 fixture 串、sendEmail 被捕获，绝不外发）。
//    fixture 时钟在每个注册流程的 send-code/register 前推进 61s，绕开 60s 重发冷却（限流逻辑本身保留）。
const mailbox = new Map();
let authTime = Date.now();
const collaboration = await createCollaborationService({
  databaseFile: ':memory:',
  allowLocalAccounts: true,
  authConfig: readAuthConfig({
    TANGO_AUTH_SECRET: 's2d-w1-blocks-e2e-fixture-only-secret',
    EMAIL_TRANSPORT: 'resend', RESEND_API_KEY: 'fixture-only', MAIL_FROM: 's2d-e2e@fixture.test', ADMIN_EMAILS: '',
  }),
  authOptions: { now: () => authTime },
  sendEmail: async message => mailbox.set(message.email, message),
});

// ── blocks：独立内存库 + 迁移 SQL 直 exec（W0 迁移器之外的挂载方约定，同 harness-server.mjs:23-24），
//    authenticate/requestAllowed 全部用 collaboration 的真实现（未登录 401、origin 校验照常生效）。
const blocksDb = new DatabaseSync(':memory:');
blocksDb.exec(MIGRATION);
const blocks = createBlockRoutes({
  store: createBlocksStore({ db: blocksDb }),
  authenticate: req => collaboration.authenticate(req),
  requestAllowed: req => collaboration.requestAllowed(req),
});

function json(res, status, value, headers = {}) {
  if (res.destroyed) return;
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers }).end(JSON.stringify(value));
}

// harness 专用注册捷径（同 tests/helpers/email-server.mjs:39 的 /__test/register）：send-code →
// register（验证码取自 mailbox）→ login，把 login 的 Set-Cookie 转发给调用方 BrowserContext。
async function registerFixture(req, res) {
  let raw = '';
  for await (const part of req) raw += part;
  const body = JSON.parse(raw);
  const email = body.username + '@fixture.test';
  const origin = 'http://' + req.headers.host;
  const call = async (path, data) => {
    if (path === 'send-code' || path === 'register') authTime += 61000;
    const response = await fetch(origin + '/api/auth/' + path, {
      method: 'POST',
      headers: { origin, 'x-tango-client': 'tango-settings/1', 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    return { response, value: await response.json() };
  };
  await call('send-code', { email });
  const registered = await call('register', {
    email,
    code: mailbox.get(email)?.code,
    password: body.password,
    confirmPassword: body.confirmPassword ?? body.password,
    displayName: body.displayName,
  });
  if (!registered.response.ok) return json(res, registered.response.status, registered.value);
  const logged = await call('login', { email, password: body.password });
  const cookie = logged.response.headers.get('set-cookie');
  json(res, logged.response.status, logged.value, cookie ? { 'Set-Cookie': cookie } : {});
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/__test/register' && req.method === 'POST') return await registerFixture(req, res);
    if (await collaboration.handle(req, res, url.pathname)) return;          // /api/auth/*、/api/collaboration/*、/api/admin/*
    if (await blocks(req, res, url.pathname + url.search)) return;           // /api/blocks*（GET 需要查询串）
    if (url.pathname.startsWith('/api/')) return json(res, 404, { error: 'NOT_FOUND' });
    // 静态 web/：serve-tango.mjs:204-213 的根内约束与分段写法（本地 e2e 不需要它的 gzip 分支）
    const target = resolve(WEB_ROOT, '.' + (url.pathname === '/' ? '/index.html' : url.pathname));
    if (!target.startsWith(WEB_ROOT.endsWith(sep) ? WEB_ROOT : WEB_ROOT + sep)) { res.writeHead(403).end(); return; }
    const body = await readFile(target);
    res.writeHead(200, { 'Content-Type': MIME[extname(target)] || 'application/octet-stream', 'Cache-Control': 'no-store', 'Content-Length': body.length });
    for (let offset = 0; offset < body.length; offset += 16384) res.write(body.subarray(offset, offset + 16384));
    res.end();
  } catch (error) {
    if (!res.headersSent) {
      const status = Number.isInteger(error.status) ? error.status : 500;
      json(res, status, { error: typeof error.code === 'string' ? error.code : 'HARNESS_ERROR' });
    } else if (!res.writableEnded) res.end();
  }
});

const port = Number(process.env.S2D_W1_E2E_PORT) || 17602;
server.listen(port, '127.0.0.1', () => process.stdout.write('s2d-w1 blocks-e2e harness ready on ' + port + '\n'));
