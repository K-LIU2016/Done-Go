// W1 sync-engine 单测（TDD 先行）：web/agentic/sync.js 引擎段契约（实现须让本文件全绿）。
// 依据：BUILD-PLAN §3 W1-2（增量同步/离线排队/上线补写/冲突不自动覆盖、console-free 事件回调）、
// 规划 DAG sync-engine 节（全依赖注入、浏览器/Node 双跑，风格同 scripts/voice-pipeline/gateway.mjs）。
//
// 契约：createBlockSync({ fetchImpl, storage, now, getAccount, onEvent }) →
//   start()                  登录后的首次同步：GET /api/blocks（可带查询参数=全量）→
//                            onEvent({type:'serverChanges', items:<blocks>})，
//                            游标写入 storage['tango-donego.blocks.cursor.v1']。
//   enqueue(entry, {source}) 本地脏块入队（新块 baseRevision 0；服务端响应里见过的块用其 revision）。
//   flush()                  在线时 POST /api/blocks/sync（带 x-tango-client 头、JSON body
//                            {baseRevision:<游标>, changes:[{id, baseRevision, block}]}）；
//                            offline 或 fetch 抛错 → 只排队不抛；成功后按响应发 serverChanges /
//                            conflicts 事件、推进游标、清空已上报队列。
//   setOnline(bool)          可注入 online 状态；false→true 时自动补写，返回的 promise 在补写完成后 resolve。
//   pending()                当前排队待写的块数。
// 未登录（getAccount() 返回 null/undefined）：一切入口不发请求、不入队。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBlockSync } from '../../../../web/agentic/sync.js';

const CURSOR_KEY = 'tango-donego.blocks.cursor.v1';

function memoryStorage() {
  const data = new Map();
  return { getItem: key => (data.has(key) ? data.get(key) : null), setItem: (key, value) => { data.set(key, value); }, data };
}
const ok = payload => ({ ok: true, status: 200, json: async () => payload });
const entryOf = (over = {}) => ({ id: 'e1', date: '2026-10-26', start: '09:00', end: '10:00', title: '写作', kind: 'create', prio: 3, ...over });
const pathOf = url => String(url).split('?')[0];
const headerOf = (init, name) => {
  const headers = init?.headers;
  if (!headers) return undefined;
  if (typeof headers.get === 'function') return headers.get(name);
  for (const [key, value] of Object.entries(headers)) if (key.toLowerCase() === name.toLowerCase()) return value;
  return undefined;
};
const bodyOf = init => (typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body);

test('未登录（getAccount()=null）：start/flush/enqueue 都不发请求、不入队', async () => {
  const calls = [];
  const sync = createBlockSync({
    fetchImpl: async (...args) => { calls.push(args); return ok({ applied: 0, conflicts: [], serverChanges: [], cursor: 0 }); },
    storage: memoryStorage(),
    getAccount: () => null,
    onEvent: () => {},
  });
  sync.enqueue(entryOf());
  await sync.flush();
  await sync.start();
  assert.equal(calls.length, 0);
  assert.equal(sync.pending(), 0);
});

test('断网写 → 恢复上线补写：offline 只排队不请求，setOnline(true) 自动补写，draft 带 source', async () => {
  const calls = [];
  const storage = memoryStorage();
  const sync = createBlockSync({
    fetchImpl: async (url, init) => { calls.push({ url: String(url), init }); return ok({ applied: 2, conflicts: [], serverChanges: [], cursor: 5 }); },
    storage,
    getAccount: () => ({ id: 'alice', displayName: 'Alice' }),
    onEvent: () => {},
  });
  await sync.setOnline(false);
  sync.enqueue(entryOf({ id: 'e1', title: '断网时写的' }));
  sync.enqueue(entryOf({ id: 'd9', title: '语音草稿', start: undefined, end: undefined }), { source: 'draft' });
  await sync.flush();
  assert.equal(calls.length, 0);                 // offline：只排队不请求
  assert.equal(sync.pending(), 2);
  await sync.setOnline(true);                    // online 事件触发补写
  assert.equal(calls.length, 1);
  assert.equal(pathOf(calls[0].url), '/api/blocks/sync');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(headerOf(calls[0].init, 'x-tango-client'), 'tango-settings/1');
  const sent = bodyOf(calls[0].init);
  assert.equal(sent.baseRevision, 0);            // 尚无游标
  assert.deepEqual(sent.changes.map(change => change.id).sort(), ['d9', 'e1']);
  const e1 = sent.changes.find(change => change.id === 'e1');
  assert.equal(e1.baseRevision, 0);              // 新块基准 0
  assert.equal(e1.block.title, '断网时写的');
  assert.equal(e1.block.date, '2026-10-26');
  assert.equal(sent.changes.find(change => change.id === 'd9').block.source, 'draft');
  assert.equal(sync.pending(), 0);               // 补写成功后清空
  assert.equal(Number(storage.getItem(CURSOR_KEY)), 5);
});

test('fetch 失败：只排队不丢不抛，网络恢复后 flush 补写成功', async () => {
  const calls = [];
  let broken = true;
  const sync = createBlockSync({
    fetchImpl: async (url, init) => { if (broken) throw new TypeError('network down'); calls.push(init); return ok({ applied: 1, conflicts: [], serverChanges: [], cursor: 2 }); },
    storage: memoryStorage(),
    getAccount: () => ({ id: 'a' }),
    onEvent: () => {},
  });
  sync.enqueue(entryOf());
  await sync.flush();
  assert.equal(sync.pending(), 1);               // 失败只排队
  broken = false;
  await sync.flush();
  assert.equal(calls.length, 1);
  assert.equal(sync.pending(), 0);
});

test('冲突：conflicts 事件触发且冲突块不随 serverChanges 自动下发（本地版本保留），已知块 baseRevision 取最近 revision', async () => {
  const calls = [];
  const events = [];
  const responses = [
    { applied: 1, conflicts: [], cursor: 3, serverChanges: [{ id: 'e1', revision: 1, date: '2026-10-26', start: '09:00', end: '10:00', title: 'v1', kind: 'create', prio: 3, note: '', done: false, source: 'web', deleted_at: null }] },
    { applied: 0, conflicts: [{ id: 'e1', baseRevision: 1, block: { id: 'e1', revision: 2, title: 'server-v2' } }], cursor: 4, serverChanges: [{ id: 'other', revision: 1, title: '别的块' }] },
  ];
  let index = 0;
  const storage = memoryStorage();
  const sync = createBlockSync({
    fetchImpl: async (url, init) => { calls.push(init); return ok(responses[index++]); },
    storage,
    getAccount: () => ({ id: 'a' }),
    onEvent: event => events.push(event),
  });
  sync.enqueue(entryOf({ title: 'v1' }));
  await sync.flush();
  sync.enqueue(entryOf({ title: 'local-v2' }));
  await sync.flush();
  assert.equal(bodyOf(calls[1]).changes[0].baseRevision, 1);      // 从上一轮响应学到的 revision
  const conflicts = events.filter(event => event.type === 'conflicts');
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].items[0].id, 'e1');
  assert.equal(conflicts[0].items[0].block.revision, 2);
  const serverChanges = events.filter(event => event.type === 'serverChanges');
  assert.equal(serverChanges.length, 2);
  assert.ok(serverChanges[1].items.some(block => block.id === 'other'));
  assert.ok(!serverChanges[1].items.some(block => block.id === 'e1')); // 冲突块不自动覆盖本地
  assert.equal(sync.pending(), 0);                                 // 已上报，交回调用方决定
  assert.equal(Number(storage.getItem(CURSOR_KEY)), 4);
});

test('start()：GET /api/blocks 全量拉取下发 serverChanges，游标落盘、后续 flush 复用（不重复拉）', async () => {
  const calls = [];
  const events = [];
  const storage = memoryStorage();
  const sync = createBlockSync({
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      if (pathOf(url) === '/api/blocks') return ok({ blocks: [{ id: 's1', revision: 1, title: '已有块' }], cursor: 7 });
      return ok({ applied: 0, conflicts: [], serverChanges: [], cursor: 7 });
    },
    storage,
    getAccount: () => ({ id: 'a' }),
    onEvent: event => events.push(event),
  });
  await sync.start();
  assert.equal(calls.length, 1);
  assert.equal(pathOf(calls[0].url), '/api/blocks');
  const initial = events.filter(event => event.type === 'serverChanges');
  assert.equal(initial.length, 1);
  assert.deepEqual(initial[0].items.map(block => block.id), ['s1']);
  assert.equal(Number(storage.getItem(CURSOR_KEY)), 7);
  await sync.flush();
  assert.equal(calls.length, 2);
  assert.equal(bodyOf(calls[1].init).baseRevision, 7);            // 游标推进：增量从 7 开始，不重复拉
});
