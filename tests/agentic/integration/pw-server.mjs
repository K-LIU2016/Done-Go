#!/usr/bin/env node
// S2D-W13 · M23 PW golden harness 服务（tests/agentic/integration/pw-server.mjs）。
//
// 最小 golden spec（pw-golden.spec.ts）的 localhost 服务，把浏览器页面接到 W13
// 集成栈（M20 web-seam A 组实证的同一接缝链，改挂静态整棵 web/）：
//   - 静态 web/（'/' → index.html；/agentic/** → W5/W11 页面与模块；根内约束
//     同 serve-tango.mjs:204 先例）；
//   - fixture 登录：/api/auth/status + /api/auth/me（W1 index-hook harness 同款
//     形状）+ 首个 HTML 响应种 tango-session cookie → index.html 的
//     window.TangoCurrentUser 登录门放行、attachBlockSync 真跑；
//   - M13 createIntegrationContext（临时 SQLite、确定性时钟、单一 cookie
//     principal）+ W1 createBlockRoutes（context.auth.forBlocks 接线）+
//     M17 health → M14 dispatcher；/api/blocks*、/api/agentic/health 走统一
//     鉴权门与冻结信封，其余 /api/* 404 信封；
//   - 端口：W13 harness 段 17701–17709（默认 17704，S2D_W13_PW_PORT 覆盖；
//     被占即失败不漂移——与 playwright.golden.config.ts 的静态探活 url 同值）。
//
// 红线：零真实上游（无 gateway/model/email）、网络只绑 127.0.0.1、唯一时间源
// =注入时钟（业务路径）、不读任何 key/env（端口与 fixture 常量除外）。
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import net from 'node:net';

import { createIntegrationContext } from '../../../scripts/agentic/integration/context.mjs';
import { createAgenticDispatcher } from '../../../scripts/agentic/integration/dispatcher.mjs';
import { createHealthHandler } from '../../../scripts/agentic/integration/health.mjs';
import { createBlocksStore } from '../../../scripts/agentic/block-store/store.mjs';
import { createBlockRoutes } from '../../../scripts/agentic/block-store/routes.mjs';

const WEB_ROOT = resolve(fileURLToPath(new URL('../../../web/', import.meta.url)));
const PORT_RANGE = { min: 17701, max: 17709 };
const SESSION_COOKIE = 'tango-session=w13-golden';
const FIXTURE_PRINCIPAL = Object.freeze({
  ownerId: 'w13-golden-owner',
  id: 'w13-golden-user', // 与 /api/auth/me 的 user.id、storage scope 键一致（W1 前提）
  actor: 'pw.golden',
  device: 'pw-golden-desktop',
});
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.mp4': 'video/mp4',
  '.woff2': 'font/woff2', '.ico': 'image/x-icon',
};

// ---------------- 端口（段内固定，绝不静默离段/漂移） ----------------
// 与 playwright.golden.config.ts 的 webServer url 探活共用同一端口值（经
// S2D_W13_PW_PORT 环境变量对流）。不做段内顺延：顺延会让 config 的静态探活
// url 与实际监听口错位（静默超时）。端口被占即立刻失败——错误信息点名段与
// 占用者处置（换 S2D_W13_PW_PORT=<17701–17709 内空闲口> 重跑）。

function canBind(port) {
  return new Promise(resolveCb => {
    const probe = net.createServer();
    probe.once('error', () => resolveCb(false));
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolveCb(true)));
  });
}

async function requirePort(preferred) {
  if (!Number.isInteger(preferred) || preferred < PORT_RANGE.min || preferred > PORT_RANGE.max) {
    throw new Error(`pw-server: S2D_W13_PW_PORT must be an integer inside the harness segment ${PORT_RANGE.min}-${PORT_RANGE.max} (got ${String(preferred)})`);
  }
  if (await canBind(preferred)) return preferred;
  throw new Error(`pw-server: port ${preferred} is busy — free it or rerun with S2D_W13_PW_PORT set to another free port inside ${PORT_RANGE.min}-${PORT_RANGE.max}`);
}

// ---------------- W13 集成栈（M13 组合根 + W1 路由 + M17 health → M14 dispatcher） ----------------

const tempDir = await mkdtemp(join(tmpdir(), 'w13-pw-golden-'));
let tick = 0;
const START_MS = Date.parse('2026-10-28T11:00:00.000Z');
const clockNow = () => new Date(START_MS + tick++ * 1000).toISOString();

const context = createIntegrationContext({
  dbFile: join(tempDir, 'pw-golden.sqlite'),
  now: clockNow,
  auth: req => (/tango-session=w13-golden/.test(String(req.headers?.cookie || ''))
    ? { ...FIXTURE_PRINCIPAL }
    : null),
});
// W1 块路由：M20 web-seam A 组实证形状（store 复用组合根 db —— 单库单台账）
const blockRoutes = createBlockRoutes({
  store: createBlocksStore({ db: context.db, now: () => context.clock.now() }),
  authenticate: context.auth.forBlocks,
  requestAllowed: req => {
    // 同 tests/agentic/blocks/harness-server.mjs:31 的本地放行（localhost e2e）
    const host = req.headers.host;
    if (!/^(?:localhost|127\.0\.0\.1):[0-9]+$/.test(host || '')) return false;
    const expected = 'http://' + host;
    const origin = req.headers.origin;
    return (!origin && ['GET', 'HEAD'].includes(req.method)) || origin === expected;
  },
  now: () => context.clock.now(),
});
const dispatcher = createAgenticDispatcher({
  context,
  handlers: [createHealthHandler(context), blockRoutes],
});

// ---------------- fixture 登录 + 静态 web/ ----------------

function json(res, status, value, headers = {}) {
  if (res.destroyed) return;
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers }).end(JSON.stringify(value));
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const pathname = decodeURIComponent(url.pathname);
    // fixture 登录（W1 index-hook harness 同款形状；app-auth.js boot 读这两个端点）
    if (pathname === '/api/auth/status') {
      return json(res, 200, { registrationEnabled: false, codeResendSeconds: 60, emailDelivery: 'console' });
    }
    if (pathname === '/api/auth/me') {
      return json(res, 200, { user: { id: FIXTURE_PRINCIPAL.id, email: 'w13@fixture.test', emailVerified: true, displayName: 'W13 Golden', role: 'user' } });
    }
    // W13 集成栈：只有 /api/* 进 dispatcher（统一鉴权门 + 冻结信封）。静态页面
    // 必须免鉴权可载——首个导航尚无 cookie，登录门由页面侧（TangoCurrentUser）
    // 与 API 侧（401 信封）各司其职（M18 serve-tango 同款前缀分流语义）。
    if (pathname.startsWith('/api/')) {
      const handled = await dispatcher.handle(req, res, pathname + url.search);
      if (handled || res.writableEnded) return;
      return json(res, 404, { error: { code: 'NOT_FOUND', message: `no handler for ${pathname}` } });
    }
    // 静态 web/：根内约束同 serve-tango.mjs:204 先例；首页种 fixture 会话 cookie
    const target = resolve(WEB_ROOT, '.' + (pathname === '/' ? '/index.html' : pathname));
    if (!target.startsWith(WEB_ROOT.endsWith(sep) ? WEB_ROOT : WEB_ROOT + sep)) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' }).end('forbidden');
      return;
    }
    try {
      const body = await readFile(target);
      if (pathname === '/' || pathname === '/index.html') {
        res.setHeader('Set-Cookie', `${SESSION_COOKIE}; Path=/; SameSite=Lax`);
      }
      res.writeHead(200, { 'Content-Type': MIME[extname(target).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' }).end(body);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('not found');
    }
  } catch {
    if (!res.headersSent) json(res, 500, { error: { code: 'INTERNAL_ERROR', message: 'internal error' } });
    else if (!res.writableEnded) res.end();
  }
});

const preferred = Number(process.env.S2D_W13_PW_PORT) || 17704;
const port = await requirePort(preferred);
server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`w13 pw-golden harness ready on http://127.0.0.1:${port}/ (requested ${preferred})\n`);
});

// 拆机：清理临时 SQLite（playwright webServer 用 SIGTERM 终止）
let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  try { context.db.close?.(); } catch { /* 可能已关 */ }
  await rm(tempDir, { recursive: true, force: true });
}
process.on('SIGTERM', () => { void shutdown().finally(() => process.exit(0)); });
process.on('SIGINT', () => { void shutdown().finally(() => process.exit(0)); });
process.on('exit', () => { try { context.db.close?.(); } catch { /* 可能已关 */ } });
