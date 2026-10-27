// W1 block-routes 单测 harness：内存库 + 可注入双 user 的假 authenticate + node:http 随机端口 fetch 断言。
// 蓝本：tests/unit/tango-collaboration-http.test.mjs；护栏模式对齐
// scripts/collaboration-service.mjs:11-15（readBody）、:46（requestAllowed 本地放行）、:68-69（x-tango-client/origin）。
// 服务端路由不挂 serve-tango.mjs（BUILD-PLAN §2.1 L46），由本 harness 自建 http server 挂载：
// 挂载约定 pathname 参数 = url.pathname + url.search（GET /api/blocks 需要查询参数）。
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { createBlocksStore } from '../../../../scripts/agentic/block-store/store.mjs';
import { createBlockRoutes } from '../../../../scripts/agentic/block-store/routes.mjs';

const MIGRATION_PATH = fileURLToPath(new URL('../../../../scripts/agentic/db/migrations/blocks-001-blocks.sql', import.meta.url));

export function openMemoryDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(MIGRATION_PATH, 'utf8'));
  return db;
}

export async function startBlockServer(t, { users = ['alice', 'bob'], now } = {}) {
  const db = openMemoryDb();
  const clock = now || (() => '2026-10-26T00:00:00.000Z');
  const store = createBlocksStore({ db, now: clock });
  const authenticate = req => {
    const match = /blocks-sid=([\w-]+)/.exec(String(req.headers.cookie || ''));
    const userId = match && users.includes(match[1]) ? match[1] : null;
    if (!userId) throw Object.assign(new Error('AUTH_REQUIRED'), { code: 'AUTH_REQUIRED', status: 401 });
    return { id: userId, displayName: userId };
  };
  const requestAllowed = req => { // 同 collaboration-service.mjs:46 的本地放行逻辑
    const host = req.headers.host;
    if (!/^(?:localhost|127\.0\.0\.1):[0-9]+$/.test(host || '')) return false;
    const expected = 'http://' + host;
    const origin = req.headers.origin;
    return (!origin && ['GET', 'HEAD'].includes(req.method)) || origin === expected;
  };
  const routes = createBlockRoutes({ store, authenticate, requestAllowed, now: clock });
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    let handled = false;
    try { handled = await routes(req, res, url.pathname + url.search); }
    catch (error) {
      const status = Number.isInteger(error.status) ? error.status : 500;
      if (!res.headersSent) res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify({ error: typeof error.code === 'string' ? error.code : 'BLOCKS_UNAVAILABLE' }));
      return;
    }
    if (!handled && !res.headersSent) res.writeHead(404).end(); // 路由不接管 → 挂载方兜底（证明 handled=false）
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  t.after(async () => { await new Promise(resolve => server.close(resolve)); db.close(); });
  async function request(path, { body, method, cookie, headers } = {}) {
    const response = await fetch(origin + path, {
      method: method || (body === undefined ? 'GET' : 'POST'),
      headers: {
        'x-tango-client': 'tango-settings/1',
        origin,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(cookie ? { cookie } : {}),
        ...(headers || {}),
      },
      body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
    });
    let value; try { value = await response.json(); } catch { value = null; }
    return { status: response.status, body: value };
  }
  return { store, request, origin, login: userId => 'blocks-sid=' + userId };
}
