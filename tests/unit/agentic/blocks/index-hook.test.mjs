// W1 index-hook 单测（TDD 先行）：web/agentic/sync.js 挂载段 attachBlockSync + web/index.html
// load()/save() 持久化段钩子的行为契约（实现须让本文件全绿）。
// 依据：BUILD-PLAN §3 W1-3（只在 load()/save() 段接入同步钩子；登录用户才同步；首次同步前把
// 本地数据完整备份到 tango-donego.backup.<ts>）、PRD §11.1（服务端权威、浏览器缓存；冲突不自动覆盖）。
//
// 契约：attachBlockSync({ getState, saveBase, storage, fetchImpl, getAccount, now, pollMs, timer,
//                         storeKey, onEvent }) → { notifySave, start, stop, setOnline, pending, poll }：
//   start()      未登录：静默不请求不备份。已登录：首次（该账号 flag 未置）先写
//                localStorage['tango-donego.backup.<ts>']（内容=storeKey 原文，缺原文时=JSON(状态)）
//                并置 flag 'tango-donego.blocks.backup.v1:<accountId>'，再走引擎 start() 全量拉取，
//                serverChanges 并入本地（entries/drafts 按 block.source 分流、软删除移除、非规范
//                字段保留、规范字段服务端为准）并 saveBase；随后 notifySave() 把本地块上行（首次迁移）。
//   notifySave() 只入队规范内容变化过的块（幂等：同内容重复调用不再上行），draft 以 source 'draft'
//                上行；有脏块才 flush。save() 成功后调用（先既有保存再入队）。
//   冲突         conflicts 经 onEvent 透传，本地不自动覆盖、同内容不自动重推。
//   setOnline/pending/poll 透传引擎；pollMs>0 时定时 flush 增量拉取（timer 可注入）。
// 另含 web/index.html 持久化段钩子的文本契约（动态 import、不加 script 标签、save 先存再入队、
// onboard 收尾不破坏）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { attachBlockSync, BACKUP_FLAG_PREFIX } from '../../../../web/agentic/sync.js';

const STORE_KEY = 'tango-donego.web.v1';
const entryOf = (over = {}) => ({ id: 'e1', date: '2026-10-26', start: '09:00', end: '10:00', title: '写作', kind: 'create', prio: 3, note: '', done: false, ...over });
const draftOf = (over = {}) => ({ id: 'd1', date: '2026-10-26', start: null, end: null, title: '语音草稿', kind: 'create', prio: 3, note: '', done: false, ...over });
const blockOf = (over = {}) => ({ id: 'e1', revision: 1, date: '2026-10-26', start: '09:00', end: '10:00', title: '写作', kind: 'create', prio: 3, note: '', done: false, source: 'web', deleted_at: null, ...over });

function memoryStorage(seed = {}) {
  const data = new Map(Object.entries(seed));
  return { getItem: key => (data.has(key) ? data.get(key) : null), setItem: (key, value) => { data.set(key, value); }, removeItem: key => { data.delete(key); }, data };
}
const ok = payload => ({ ok: true, status: 200, json: async () => payload });
const pathOf = url => String(url).split('?')[0];
const bodyOf = init => (typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body);

// 记录型 fetch：按序消费 responses（函数或响应负载），录下每次调用；负载自动包成 fetch 形状。
function recorder(responses) {
  const calls = [];
  let index = 0;
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    const item = responses[Math.min(index, responses.length - 1)];
    index += 1;
    const payload = typeof item === 'function' ? item({ url: String(url), init }, index - 1) : item;
    if (payload && payload.__throw) throw payload.error;
    return ok(payload);
  };
  return { calls, fetchImpl, sent: () => calls.filter(call => pathOf(call.url) === '/api/blocks/sync').map(call => bodyOf(call.init)) };
}

function harness({ state, storageSeed = {}, fetchImpl, account = { id: 'a1' }, saveBase, pollMs = 0 } = {}) {
  const stateRef = { current: state };
  const saved = [];
  const storage = memoryStorage(storageSeed);
  const events = [];
  const attached = attachBlockSync({
    getState: () => stateRef.current,
    saveBase: saveBase === 'throw' ? () => { throw new Error('quota'); } : saveBase === 'false' ? () => false : (next) => { saved.push(next); return true; },
    storage,
    fetchImpl,
    getAccount: () => account,
    now: () => 1790000000000,
    pollMs,
    onEvent: event => events.push(event),
  });
  return { attached, storage, events, saved, stateRef };
}

test('未登录：start/notifySave 都不请求、不写任何存储键（含备份与 flag）', async () => {
  const io = recorder([{ ok: false }]);
  const box = harness({ state: { entries: [entryOf()], drafts: [] }, fetchImpl: io.fetchImpl, account: null });
  await box.attached.start();
  box.attached.notifySave();
  await box.attached.setOnline(true);
  assert.equal(io.calls.length, 0);
  assert.equal(box.storage.data.size, 0);
});

test('首次同步：先整备份 tango-donego.backup.<ts>（storeKey 原文）+ 置账号 flag，再拉取并入本地、上行本地全量', async () => {
  const state = {
    v: 1, pv: 5, mode: 'real', entries: [entryOf({ state: 'kept', kept: 30 })], drafts: [draftOf()],
    trials: [], methods: [], methodUses: [], fw: {}, pal: 0, uid: '', sortBy: 'prio', name: '', wake: 960, ideal: null,
  };
  // GET：s1=本地没有的服务端块；e1=双方都有且服务端更新（rev2）。POST：只迁移本地独有的 d1
  //（e1 拉取合并后即干净，seed 基线=服务端规范内容，不回传）。
  const io = recorder([
    { blocks: [blockOf({ id: 's1', revision: 4, title: '服务已有块' }), blockOf({ id: 'e1', revision: 2, title: '服务端改过标题' })], cursor: 9 },
    { applied: 1, conflicts: [], serverChanges: [blockOf({ id: 'd1', revision: 1, start: null, end: null, title: '语音草稿', source: 'draft' })], cursor: 12 },
  ]);
  const box = harness({ state, storageSeed: { [STORE_KEY]: '{"v":1,"pv":5,"mode":"real"}' }, fetchImpl: io.fetchImpl });
  await box.attached.start();

  // 备份：键形如 tango-donego.backup.<数字>，内容 = storeKey 原文（整备份）
  const backupKeys = [...box.storage.data.keys()].filter(key => /^tango-donego\.backup\.\d+$/.test(key));
  assert.equal(backupKeys.length, 1);
  assert.equal(box.storage.data.get(backupKeys[0]), '{"v":1,"pv":5,"mode":"real"}');
  assert.equal(box.storage.data.get(BACKUP_FLAG_PREFIX + ':a1'), '1');

  // 拉取顺序：GET 全量在前，POST 上行在后
  assert.equal(pathOf(io.calls[0].url), '/api/blocks');
  assert.equal(pathOf(io.calls[1].url), '/api/blocks/sync');
  // 本地并入：新块 s1 进 entries；e1 规范字段以服务端为准、非规范字段保留
  const e1 = state.entries.find(item => item.id === 'e1');
  assert.equal(e1.title, '服务端改过标题');
  assert.equal(e1.state, 'kept'); assert.equal(e1.kept, 30);
  assert.ok(state.entries.some(item => item.id === 's1'));
  // 上行：只迁移本地独有的 d1（source draft、基准 0）；拉下来的 s1/e1 不回传
  const sent = io.sent()[0];
  assert.deepEqual(sent.changes.map(change => change.id), ['d1']);
  assert.equal(sent.changes[0].baseRevision, 0);
  assert.equal(sent.changes[0].block.source, 'draft');
  // 并入后本地已持久化，游标推进
  assert.ok(box.saved.length >= 1);
  assert.equal(box.storage.data.get('tango-donego.blocks.cursor.v1'), '12');

  // 再次 start：flag 已置，不重复备份
  await box.attached.start();
  assert.equal([...box.storage.data.keys()].filter(key => /^tango-donego\.backup\.\d+$/.test(key)).length, 1);
});

test('备份回退：storeKey 无原文时备份 JSON.stringify(当前状态)', async () => {
  const state = { v: 1, pv: 5, mode: 'real', entries: [entryOf()], drafts: [], trials: [], methods: [], methodUses: [] };
  const io = recorder([{ blocks: [], cursor: 0 }, { applied: 0, conflicts: [], serverChanges: [], cursor: 0 }]);
  const box = harness({ state, fetchImpl: io.fetchImpl });
  await box.attached.start();
  const backupKeys = [...box.storage.data.keys()].filter(key => /^tango-donego\.backup\.\d+$/.test(key));
  assert.equal(backupKeys.length, 1);
  assert.equal(box.storage.data.get(backupKeys[0]), JSON.stringify(state));
});

test('notifySave 脏检测：同内容重复调用不再上行；内容变更后只发变化块', async () => {
  const state = { v: 1, entries: [entryOf(), entryOf({ id: 'e2', title: '读论文' })], drafts: [] };
  const io = recorder([
    { blocks: [], cursor: 0 },
    { applied: 2, conflicts: [], serverChanges: [blockOf({ id: 'e1', revision: 1 }), blockOf({ id: 'e2', revision: 1, title: '读论文' })], cursor: 2 },
    { applied: 1, conflicts: [], serverChanges: [blockOf({ id: 'e1', revision: 2 })], cursor: 3 },
  ]);
  const box = harness({ state, fetchImpl: io.fetchImpl });
  await box.attached.start();          // 首次：e1/e2 全量上行
  const postsBefore = io.sent().length;
  box.attached.notifySave();           // 内容未变：不 flush
  assert.equal(io.sent().length, postsBefore);
  state.entries.find(item => item.id === 'e1').title = '改写第二章';
  box.attached.notifySave();           // 只有 e1 脏
  await box.attached.poll();           // 与 notifySave 触发的是同一 inFlight：等这轮上行落定
  const last = io.sent()[io.sent().length - 1];
  assert.deepEqual(last.changes.map(change => change.id), ['e1']);
  assert.equal(last.changes[0].baseRevision, 1);      // 上一轮响应学到的 revision
  assert.equal(last.changes[0].block.title, '改写第二章');
});

test('serverChanges 软删除：deleted_at 块从本地 entries 移除并持久化', async () => {
  const state = { v: 1, entries: [entryOf(), entryOf({ id: 'e2' })], drafts: [] };
  const io = recorder([
    { blocks: [], cursor: 0 },
    { applied: 2, conflicts: [], serverChanges: [blockOf({ id: 'e1', revision: 1 }), blockOf({ id: 'e2', revision: 1 })], cursor: 2 },
    { applied: 0, conflicts: [], serverChanges: [blockOf({ id: 'e1', revision: 3, deleted_at: '2026-10-26T08:00:00.000Z' })], cursor: 3 },
  ]);
  const box = harness({ state, fetchImpl: io.fetchImpl });
  await box.attached.start();
  state.entries.find(item => item.id === 'e2').title = '再改一笔';
  box.attached.notifySave();           // 触发 flush，响应带回 e1 的软删除
  await box.attached.poll();           // 等这轮上行落定（软删除随 serverChanges 下发）
  assert.ok(!state.entries.some(item => item.id === 'e1'), '软删除块应从本地移除');
  assert.ok(state.entries.some(item => item.id === 'e2'));
  assert.ok(box.saved.length >= 1);
});

test('冲突：onEvent 透传 conflicts，本地不自动覆盖、同内容不自动重推', async () => {
  const state = { v: 1, entries: [entryOf()], drafts: [] };
  const io = recorder([
    { blocks: [], cursor: 0 },
    { applied: 0, conflicts: [{ id: 'e1', baseRevision: 0, block: blockOf({ revision: 5, title: '服务端版本' }) }], serverChanges: [], cursor: 5 },
  ]);
  const box = harness({ state, fetchImpl: io.fetchImpl });
  await box.attached.start();
  const conflicts = box.events.filter(event => event.type === 'conflicts');
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].items[0].id, 'e1');
  assert.equal(state.entries.find(item => item.id === 'e1').title, '写作');   // 本地保留
  const posts = io.sent().length;
  box.attached.notifySave();           // 同内容：冲突块不再自动重推
  assert.equal(io.sent().length, posts);
});

test('跨列表移动：draft id 的块以 source web 下发 → 从 drafts 移入 entries', async () => {
  const state = { v: 1, entries: [], drafts: [draftOf({ id: 'd5', title: '待补时间' })] };
  const io = recorder([
    { blocks: [blockOf({ id: 'd5', revision: 1, start: '09:00', end: '10:00', title: '已补时间', source: 'web' })], cursor: 1 },
    { applied: 0, conflicts: [], serverChanges: [], cursor: 1 },
  ]);
  const box = harness({ state, fetchImpl: io.fetchImpl });
  await box.attached.start();
  assert.equal(state.drafts.length, 0);
  const moved = state.entries.find(item => item.id === 'd5');
  assert.ok(moved);
  assert.equal(moved.start, '09:00'); assert.equal(moved.title, '已补时间');
});

test('saveBase 失败（false/抛错）不阻断同步流程', async () => {
  for (const mode of ['false', 'throw']) {
    const state = { v: 1, entries: [entryOf()], drafts: [] };
    const io = recorder([
      { blocks: [blockOf({ id: 's9', revision: 1 })], cursor: 1 },
      { applied: 1, conflicts: [], serverChanges: [blockOf({ revision: 1 })], cursor: 1 },
    ]);
    const box = harness({ state, fetchImpl: io.fetchImpl, saveBase: mode });
    await box.attached.start();        // 不抛即过
    assert.ok(state.entries.some(item => item.id === 's9'), '内存态仍并入');
  }
});

test('setOnline/pending 透传引擎：断网写只排队，恢复自动补写', async () => {
  const state = { v: 1, entries: [entryOf()], drafts: [] };
  const io = recorder([
    { blocks: [], cursor: 0 },
    { applied: 1, conflicts: [], serverChanges: [blockOf({ revision: 1 })], cursor: 1 },
  ]);
  const box = harness({ state, fetchImpl: io.fetchImpl });
  await box.attached.start();
  await box.attached.setOnline(false);
  state.entries.find(item => item.id === 'e1').title = '离线改';
  box.attached.notifySave();
  assert.equal(box.attached.pending(), 1);
  const posts = io.sent().length;
  await box.attached.setOnline(true);  // 恢复上线自动补写
  assert.equal(io.sent().length, posts + 1);
  assert.equal(io.sent()[io.sent().length - 1].changes[0].block.title, '离线改');
  assert.equal(box.attached.pending(), 0);
});

test('poll：pollMs>0 时经注入 timer 定时 flush（空队列也发，用于增量拉取）；stop 清理', async () => {
  const state = { v: 1, entries: [entryOf()], drafts: [] };
  const io = recorder([{ blocks: [], cursor: 0 }, { applied: 0, conflicts: [], serverChanges: [], cursor: 0 }]);
  const timers = [];
  const storage = memoryStorage();
  const attached = attachBlockSync({
    getState: () => state,
    saveBase: () => true,
    storage,
    fetchImpl: io.fetchImpl,
    getAccount: () => ({ id: 'a1' }),
    now: () => 1790000000000,
    pollMs: 5000,
    timer: { set: (fn, ms) => { const entry = { ms, fn, cleared: false }; timers.push(entry); return entry; }, clear: entry => { entry.cleared = true; } },
    onEvent: () => {},
  });
  await attached.start();
  assert.equal(timers.length, 1);      // 启动即排定时增量拉取
  assert.equal(timers[0].ms, 5000);
  await attached.poll();               // 手动触发一轮：空队列 POST 亦发出（增量拉取通道）
  assert.equal(io.sent().length, 2);   // 首次迁移上行 1 次 + poll 增量拉取 1 次
  attached.stop();
  assert.equal(timers[0].cleared, true);
});

// ───────────────────────── web/index.html 持久化段钩子（文本契约） ─────────────────────────
const htmlPath = fileURLToPath(new URL('../../../../web/index.html', import.meta.url));
const html = readFileSync(htmlPath, 'utf8');

test('index.html：save() 先既有保存再入队（collaborationPersonal 共存），未挂载时静默', () => {
  const match = html.match(/function save\(\) \{[^\n]*\}/);
  assert.ok(match, 'save() 定义应存在');
  assert.match(match[0], /collaborationPersonal \? collaborationPersonal\.save\(\) : saveBaseState\(S\)/);
  assert.match(match[0], /notifyBlockSync\(\)/);
  assert.ok(match[0].indexOf('collaborationPersonal') < match[0].indexOf('notifyBlockSync'), '先既有保存再入队');
});

test('index.html：持久化段动态 import /agentic/sync.js，登录守卫 TangoCurrentUser，不加 script 标签', () => {
  assert.ok(!/<script[^>]*agentic\/sync\.js/.test(html), '不得加 script 标签（免构建动态 import）');
  assert.ok(html.includes("import('/agentic/sync.js')"), '持久化段应动态 import');
  const hookIndex = html.indexOf("import('/agentic/sync.js')");
  const guard = html.slice(Math.max(0, hookIndex - 400), hookIndex);
  assert.match(guard, /window\.TangoCurrentUser/, 'import 前应有登录守卫');
  assert.match(html, /attachBlockSync\(/, '应调用挂载入口');
  assert.match(html, /tango-donego\.backup\./, '首次同步备份键约定存在（实现于 sync.js）');
});

test('index.html：onboard 收尾不被破坏（collaboration.start().finally 分支保留）', () => {
  assert.match(html, /collaboration\.start\(\)\.finally\(function \(\) \{ if \(!S\.mode && !collaborationPersonal\.account\(\) && route\(\) !== 'agreements'\) onboard\(\); \}\)/);
});
