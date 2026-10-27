// S2D-W13 · M20 web 接缝核对（tests/unit/agentic/integration/web-seam.test.mjs）。
//
// 依据：plan.md §G3 M20「web/index.html 接缝核对（W1 已挂 sync.js；W5/W11 经 demo/组件页），
// 不覆盖既有用户数据与旧页面脚本」+ brief §3 web 接缝域 + §4.2 路由复用器挂载约定。
//
// 与既有测试的分工（不重复）：
//   - W1 tests/unit/agentic/blocks/index-hook.test.mjs：attachBlockSync 行为 + index.html
//     持久化段钩子的**文本**契约（save 顺序/dynamic import/删除接线）——本文件不重复。
//   - M14 dispatcher / M13 context 各自的形状测试：合成 handler——本文件补**真实组合**。
//   - M19 tango-release：发布清单——本文件补页面侧引用图与隔离。
//
// 本文件四组核对：
//   A. 端到端接缝链（真实 sync.js ↔ 临时 HTTP server ↔ M14 dispatcher ↔ M13 context ↔
//      W1 block routes）：「W1 已挂 sync.js」在 W13 集成栈上可通的实证——浏览器契约
//      （相对路径 /api/blocks(/sync)、x-tango-client 头、cookie 凭证）原样穿过统一
//      鉴权门与 W1 自身护栏；listen(0) 临时端口，不占 17701–17719 预算。
//   B. 冲突/错误事件透出（RED 先行）：W1 在 index.html:870 留 onEvent noop，注释自认
//      「冲突提示 UI 第 3 批（W13）接」——M20 落最小可观察接缝（console-free、无 UI、
//      不改存储语义）：onEvent → window CustomEvent('tango:block-sync')。
//   C. 旧页面脚本与用户数据不覆盖：基线（60fdc73）13 个 script src 集合原样保留、
//      STORE_KEY/AGREEMENT_STORE_KEY 字面量不变、损坏数据保护段（canWriteStorage/
//      replaceWithSnapshot/恢复提示）仍在。
//   D. W5/W11 隔离：demo/组件页自足（引用图全部落盘、不引用 legacy 脚本/存储键、
//      不被 index.html 引用），reel 三件在位。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

import { createIntegrationContext } from '../../../../scripts/agentic/integration/context.mjs';
import { createAgenticDispatcher } from '../../../../scripts/agentic/integration/dispatcher.mjs';
import { createBlocksStore } from '../../../../scripts/agentic/block-store/store.mjs';
import { createBlockRoutes } from '../../../../scripts/agentic/block-store/routes.mjs';
import { attachBlockSync } from '../../../../web/agentic/sync.js';

const WEB = fileURLToPath(new URL('../../../../web/', import.meta.url));
const html = readFileSync(join(WEB, 'index.html'), 'utf8');

// ---------------- A. 端到端接缝链 ----------------

/** 真实组合：M13 context（临时 sqlite + 确定性时钟 + cookie principal）+ W1 store/routes + M14 dispatcher + 临时 HTTP server。 */
async function seamServer() {
  const dir = mkdtempSync(join(tmpdir(), 'm20-web-seam-'));
  let tick = 0;
  const context = createIntegrationContext({
    dbFile: join(dir, 'seam.sqlite'),
    now: () => new Date(1790000000000 + tick++ * 1000).toISOString(),
    auth: (req) => (req.headers.cookie === 'tango-session=sess-o1' ? { ownerId: 'o1', id: 'o1' } : null),
  });
  const store = createBlocksStore({ db: context.db, now: () => context.clock.now() });
  const blockRoutes = createBlockRoutes({ store, authenticate: context.auth.forBlocks, requestAllowed: () => true, now: () => context.clock.now() });
  const dispatcher = createAgenticDispatcher({ context, handlers: [blockRoutes] });
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const handled = await dispatcher.handle(req, res, url.pathname + url.search);
    if (!handled) res.writeHead(404).end();
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    context, store, server, base, dir,
    close: async () => { await new Promise(done => server.close(done)); rmSync(dir, { recursive: true, force: true }); },
  };
}

/** 浏览器等价 fetchImpl：相对路径按 origin 解析 + cookie jar 逐请求附带（credentials same-origin 语义）。 */
function browserFetch(base, cookie = 'tango-session=sess-o1') {
  return (url, init = {}) => fetch(new URL(url, base), { ...init, headers: { ...(init.headers || {}), cookie } });
}

test('A1 接缝链：真实 sync.js 经统一鉴权门完成 拉取→上行→删除 往返（blocks-001 在单台账内应用）', async () => {
  const io = await seamServer();
  try {
    assert.ok(io.context.appliedMigrations.some(name => name.startsWith('blocks-')), 'W0 migrate() 单台账应已应用 blocks-001');
    const data = new Map();
    const storage = { getItem: k => (data.has(k) ? data.get(k) : null), setItem: (k, v) => data.set(k, v), removeItem: k => data.delete(k) };
    const state = { entries: [{ id: 'e1', date: '2026-10-28', start: '09:00', end: '10:00', title: '写作', kind: 'create', prio: 3, note: '', done: false }], drafts: [] };
    const events = [];
    const attached = attachBlockSync({
      getState: () => state, saveBase: () => true, storage, fetchImpl: browserFetch(io.base),
      getAccount: () => ({ id: 'a1' }), now: () => 1790000900000, pollMs: 0,
      onEvent: event => events.push(event),
    });
    await attached.start();
    // 首次同步：整备份 + 账号 flag（用户数据保护：先备份再动）
    assert.equal([...data.keys()].filter(k => /^tango-donego\.backup\.\d+$/.test(k)).length, 1);
    assert.equal(data.get('tango-donego.blocks.backup.v1:a1'), '1');
    // 上行：编辑 → notifySave → poll 落定，游标推进
    state.entries[0].title = '改写第二章';
    attached.notifySave();
    await attached.poll();
    const cursor = Number(storage.getItem('tango-donego.blocks.cursor.v1'));
    assert.ok(cursor >= 1, `游标应推进（got ${cursor}）`);
    // 删除：notifyDelete 上行 {deleted:true}，服务端终态不可见该块
    attached.notifyDelete('e1');
    await attached.poll();
    const final = await browserFetch(io.base)('/api/blocks', { headers: { 'x-tango-client': 'tango-settings/1' } });
    assert.equal(final.status, 200);
    assert.deepEqual((await final.json()).blocks, [], '软删除后 GET 不应再回该块');
    assert.ok(events.some(event => event.type === 'serverChanges'), 'serverChanges 事件应到达宿主（onEvent 透传）');
  } finally { await io.close(); }
});

test('A2 统一鉴权门：无 cookie 的 /api/blocks 由 dispatcher 401 冻结信封抢答（未进 W1 handler）', async () => {
  const io = await seamServer();
  try {
    const response = await fetch(io.base + '/api/blocks', { headers: { 'x-tango-client': 'tango-settings/1' } });
    assert.equal(response.status, 401);
    const body = await response.json();
    assert.equal(body.error.code, 'AUTH_REQUIRED');           // 冻结信封（error 为对象）
    assert.equal(typeof body.error.requestId, 'string');      // M13 确定性 idGen
  } finally { await io.close(); }
});

test('A3 W1 自身护栏在挂载后仍生效：有 cookie 但缺 x-tango-client → 403 ORIGIN_REJECTED（W1 扁平信封）', async () => {
  const io = await seamServer();
  try {
    const response = await fetch(io.base + '/api/blocks', { headers: { cookie: 'tango-session=sess-o1' } });
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error, 'ORIGIN_REJECTED'); // W1 层自己的信封，非 dispatcher 冻结信封
  } finally { await io.close(); }
});

// ---------------- B. 冲突/错误事件透出（M20 RED 先行） ----------------

/** 从 index.html 抽取指定函数源码（文本契约锚点：函数体单行、与 notifyBlockSync 同风格）。 */
function extractFunction(name) {
  const match = html.match(new RegExp(`function ${name}\\([^)]*\\) \\{[^\\n]*\\}`));
  return match ? match[0] : null;
}

test('B1 index.html 挂载配置把 onEvent 接到透出函数（不再是丢弃事件的 noop）', () => {
  assert.ok(/onEvent:\s*notifyBlockSyncEvent/.test(html), 'attachBlockSync 配置应挂 onEvent: notifyBlockSyncEvent');
  assert.ok(extractFunction('notifyBlockSyncEvent'), 'notifyBlockSyncEvent 函数应存在');
});

test('B2 冲突/错误事件经 window CustomEvent("tango:block-sync") 透出（detail 原样、console-free）', () => {
  const source = extractFunction('notifyBlockSyncEvent');
  assert.ok(source, 'notifyBlockSyncEvent 函数应存在');
  assert.ok(!/console\./.test(source), '透出函数必须 console-free');
  const dispatched = [];
  class FakeCustomEvent { constructor(type, options) { this.type = type; this.detail = options?.detail; } }
  const sandbox = { window: { dispatchEvent: event => dispatched.push(event) }, CustomEvent: FakeCustomEvent };
  vm.createContext(sandbox);
  vm.runInContext(`${source}; globalThis.__fn = notifyBlockSyncEvent;`, sandbox);
  const conflict = { type: 'conflicts', items: [{ id: 'e1' }] };
  sandbox.__fn(conflict);
  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0].type, 'tango:block-sync');
  assert.equal(dispatched[0].detail, conflict, 'detail 应原样透传（不加工不吞）');
  sandbox.__fn({ type: 'error', items: [] });
  assert.equal(dispatched.length, 2, 'error 事件同样透出');
});

test('B3 无 window / 无 dispatchEvent 环境（vm 抽取先例 tango-web-gaps）不抛、静默', () => {
  const source = extractFunction('notifyBlockSyncEvent');
  assert.ok(source);
  const bare = {};                                            // 无 window、无 CustomEvent
  vm.createContext(bare);
  vm.runInContext(`${source}; globalThis.__fn = notifyBlockSyncEvent;`, bare);
  assert.doesNotThrow(() => bare.__fn({ type: 'conflicts', items: [] }));
  const noDispatch = { window: {} };                          // 有 window 无 dispatchEvent
  vm.createContext(noDispatch);
  vm.runInContext(`${source}; globalThis.__fn = notifyBlockSyncEvent;`, noDispatch);
  assert.doesNotThrow(() => noDispatch.__fn({ type: 'error', items: [] }));
});

// ---------------- C. 旧页面脚本与用户数据不覆盖 ----------------

/** W0 基线 60fdc73:web/index.html 的 13 个 script src（git show 实取，冻结为字面清单）。 */
const BASELINE_SCRIPTS = Object.freeze([
  '/agreements.js', '/app-auth.js', '/appearance.js', '/assistant-core.js', '/assistant-ui.js',
  '/collaboration-copy.js', '/collaboration-personal.js', '/collaboration-ui.js', '/locale-copy.js',
  '/model-catalog-cn.js', '/privacy.js', '/speech-capture.js', '/users-admin.js',
]);

test('C1 基线 13 个旧页面脚本原样保留（一个不少、无新增 eager script）', () => {
  const current = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map(m => m[1]).sort();
  assert.deepEqual(current, [...BASELINE_SCRIPTS], 'script src 集合应与 W0 基线完全一致');
});

test('C2 用户数据键不覆盖：STORE_KEY/AGREEMENT_STORE_KEY 字面量与基线一致、仅一处定义', () => {
  const stores = html.match(/var STORE_KEY = '[^']+';/g) || [];
  assert.deepEqual(stores, ["var STORE_KEY = 'tango-donego.web.v1';"]);
  const agreements = html.match(/var AGREEMENT_STORE_KEY = '[^']+';/g) || [];
  assert.deepEqual(agreements, ["var AGREEMENT_STORE_KEY = 'tango-donego.agreements.v1';"]);
});

test('C3 损坏数据保护段仍在（原始内容受保护、禁止覆盖、备份后替换）', () => {
  assert.match(html, /function canWriteStorage\(\)/);
  assert.match(html, /function replaceWithSnapshot\(next\)/);
  assert.match(html, /原始内容已受保护，禁止覆盖/);
  assert.match(html, /var BACKUP_KEY = STORE_KEY \+ '\.backup';/);
});

// ---------------- D. W5/W11 隔离（经 demo/组件页） ----------------

const PAGES = ['agentic/demo.html', 'agentic/component.html'];

test('D1 demo/组件页引用图完整：src/href/import/from 全部落盘（按页面目录解析）', () => {
  for (const page of PAGES) {
    const text = readFileSync(join(WEB, page), 'utf8');
    const refs = [
      ...text.matchAll(/<script[^>]+src="([^"]+)"/g),
      ...text.matchAll(/<link[^>]+href="([^"]+)"/g),
      ...text.matchAll(/import\((['"])([^'"]+)\1\)/g),
      ...text.matchAll(/from (['"])(\.[^'"]+)\1/g),
    ].map(m => m[2] ?? m[1]);
    assert.ok(refs.length > 0, `${page} 应有引用`);
    for (const ref of refs) {
      const target = ref.startsWith('/') ? resolve(WEB, ref.slice(1)) : resolve(dirname(join(WEB, page)), ref);
      assert.ok(existsSync(target), `${page} -> ${ref} 应存在于 web/`);
    }
  }
});

test('D2 隔离：demo/组件页不引用 legacy 脚本与用户数据键；index.html 不引用 W5/W11 页面', () => {
  for (const page of PAGES) {
    const text = readFileSync(join(WEB, page), 'utf8');
    assert.ok(!text.includes('tango-donego.web.v1'), `${page} 不得触碰 legacy 用户数据键`);
    assert.ok(!/(app-auth|collaboration-|users-admin|assistant-)\.js/.test(text), `${page} 不得挂 legacy 页面脚本`);
  }
  assert.ok(!/agentic\/(demo|component)\.html/.test(html), 'index.html 不引用 demo/组件页（W5/W11 独立成页）');
});

test('D3 W11 reel 三件在位（player.js / reel.css / README.md）', () => {
  for (const file of ['agentic/reel/player.js', 'agentic/reel/reel.css', 'agentic/reel/README.md']) {
    assert.ok(existsSync(join(WEB, file)), `${file} 应在 web/agentic/reel/`);
  }
});
