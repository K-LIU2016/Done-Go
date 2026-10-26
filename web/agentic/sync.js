// W1 Block 同步 · 前端映射段：S.entries/S.drafts ↔ 服务端 blocks 的纯函数字段映射。
// 依据：BUILD-PLAN §3 W1-2、PRD §11.1 —— 登录用户的 entries/drafts 同步到服务端 blocks
//（服务端为权威、浏览器为缓存），客户端 uid() 生成的 id 原样作为 block id，重放/补写靠它幂等。
// 本文件是浏览器原生 ES 模块（BUILD-PLAN §2.3 免构建）；映射段零依赖、无 DOM，Node 单测直接 import。
// 引擎段（createBlockSync：游标增量/离线排队/上线补写/冲突回调）在本段之后。

// 时间格式与 web/index.html:781 isHM 用同一字面正则（24:00 合法＝一天结束边界）；改一处必须同步另一处。
const HM_RE = /^(?:(?:[01]\d|2[0-3]):[0-5]\d|24:00)$/;
// 日期格式同 web/index.html ymd() 的输出（月/日补零的 YYYY-MM-DD）。
const DATE_RE = /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/;

/**
 * entry → block（上行）。只挑规范字段上行：state/kept/use/intent/freed/collaborationRef 等
 * stillness/协作的本地字段不上行，下行合并时保留在本地（见 mergeBlockIntoEntry）。
 * draft 以 { source: 'draft' } 上行，可无 start/end（映射为 null）。
 * date/start/end 存在但格式非法、或缺 id/date/非对象 → 返回 null（不同步脏数据）。
 * @param {object} entry S.entries / S.drafts 里的一条
 * @param {{source?: string}} options 上行来源，默认 'web'；draft 用 'draft'
 * @returns {object|null} 规范化 block（id/date/start/end/title/kind/prio/note/done/source）
 */
export function entryToBlock(entry, { source = 'web' } = {}) {
  if (!entry || typeof entry !== 'object') return null;
  if (typeof entry.id !== 'string' || !entry.id) return null; // id 是重放幂等键，缺了不同步
  if (typeof entry.date !== 'string' || !DATE_RE.test(entry.date)) return null;
  const start = entry.start || null, end = entry.end || null; // draft 待补时间 → null
  if ((start !== null && !HM_RE.test(start)) || (end !== null && !HM_RE.test(end))) return null;
  if (typeof entry.title !== 'string' || typeof entry.kind !== 'string') return null;
  return {
    id: entry.id,
    date: entry.date,
    start,
    end,
    title: entry.title,
    kind: entry.kind,
    prio: Number.isInteger(entry.prio) ? entry.prio : 3, // 与服务端 store normalizeContent 的 Number.isInteger 对齐：浮点（旧数据/导入）按缺省 3 上行，绝不产出服务端必拒的毒丸
    note: typeof entry.note === 'string' ? entry.note : '',
    done: entry.done === true,
    source,
  };
}

/**
 * block → entry（下行）。只还原规范字段；start/end 为 null 保持 null（draft 待补时间）。
 * 块归属（source==='draft' 还原进 S.drafts，其余进 S.entries）由引擎段按 block.source 分流，
 * entry 本身不携带 source。
 * @param {object} block 服务端返回/写入的 block
 * @returns {object} entry 形状的规范字段（id/date/start/end/title/kind/prio/note/done）
 */
export function blockToEntry(block) {
  return {
    id: block.id,
    date: block.date,
    start: block.start || null,
    end: block.end || null,
    title: block.title,
    kind: block.kind,
    prio: Number.isFinite(block.prio) ? block.prio : 3,
    note: typeof block.note === 'string' ? block.note : '',
    done: block.done === true,
  };
}

/**
 * 服务端块并入本地 entry：规范字段以 block 为准（服务端权威），state/kept/use/intent/freed/
 * collaborationRef 等非规范字段全部保留本地，不丢数据。返回新对象，不改入参。
 * @param {object} localEntry 本地现有 entry（含非规范扩展字段）
 * @param {object} block 服务端下发的 block
 * @returns {object} 合并后的新 entry
 */
export function mergeBlockIntoEntry(localEntry, block) {
  // 先铺开本地（保留全部非规范字段），再用 blockToEntry 的规范字段整体覆盖
  return { ...localEntry, ...blockToEntry(block) };
}

// ─────────────────────────────────────────────────────────────────────────────
// W1 Block 同步 · 引擎段：createBlockSync——游标增量拉取、离线排队、上线补写、冲突回调。
// 契约见 tests/unit/agentic/blocks/sync-engine.test.mjs 头注（BUILD-PLAN §3 W1-2）。
// 全依赖注入（fetchImpl/storage/now/getAccount/onEvent），浏览器与 Node 双跑；风格同
// scripts/voice-pipeline/gateway.mjs 的 createXxx 工厂。分工：引擎只管传输与队列，
// 不持有 S.entries——serverChanges 经 onEvent 交还调用方，用上面的 mergeBlockIntoEntry
// 并入本地（规范字段服务端权威、非规范字段保留），所以冲突时本地版本天然不丢。
export const BLOCKS_CURSOR_KEY = 'tango-donego.blocks.cursor.v1';
// 与 scripts/agentic/block-store/routes.mjs:83 的固定客户端标识一致（同 collaboration 系）。
const TANGO_CLIENT = 'tango-settings/1';

export function createBlockSync({
  fetchImpl,             // 类 fetch(url, init)；缺省用全局 fetch（Node 单测一律注入 mock）
  storage,               // localStorage 形状 {getItem,setItem}：游标持久化
  now = Date.now,        // 引擎自身不落时间戳（服务端 store 盖章）；保留注入位给挂载方约定
  getAccount = () => null, // 返回账号对象或 null/undefined（null = 未登录，一切入口静默不动）
  onEvent = () => {},    // console-free 事件回调：{type:'serverChanges'|'conflicts'|'error', items}
} = {}) {
  const doFetch = typeof fetchImpl === 'function' ? fetchImpl : (...args) => globalThis.fetch(...args);
  if (!storage || typeof storage.getItem !== 'function' || typeof storage.setItem !== 'function') {
    throw new Error('SYNC_STORAGE_REQUIRED'); // 游标不落盘会重复全量拉，宁可不构建
  }
  const emit = event => { try { onEvent(event); } catch { /* 回调抛错不阻断同步 */ } };
  const account = () => { const value = getAccount(); return value && typeof value === 'object' ? value : null; };

  // 队列按 id 去重（同块再脏只保留最新一条）；revisions 记录服务端告知的最新 revision，
  // 作为下次上行该块的 baseRevision。冲突块的 revision 故意不学——学了解下次上行会静默
  // 覆盖服务端，违反"冲突不自动覆盖"（PRD §11.1：交前端提示合并）。
  const queue = new Map();
  const revisions = new Map();
  let online = true;
  let cursorLoaded = false;
  let cursor = 0;
  let inFlight = null;

  const readCursor = () => {
    if (!cursorLoaded) { cursor = Number(storage.getItem(BLOCKS_CURSOR_KEY)) || 0; cursorLoaded = true; }
    return cursor;
  };
  const advanceCursor = next => {
    if (!Number.isFinite(next) || next <= readCursor()) return;
    cursor = next;
    storage.setItem(BLOCKS_CURSOR_KEY, String(next));
  };
  const learnRevisions = blocks => {
    if (!Array.isArray(blocks)) return;
    for (const block of blocks) if (block && typeof block === 'object' && Number.isFinite(block.revision)) revisions.set(block.id, block.revision);
  };

  /** 本地脏块入队。entry 先过 entryToBlock 规范化（非法不入队，不上行脏数据）；
   * source 'draft' 上行为草稿块。新块 baseRevision 0，服务端见过的块用已知的最新 revision。 */
  function enqueue(entry, { source = 'web' } = {}) {
    if (!account()) return false;
    const block = entryToBlock(entry, { source });
    if (!block) return false;
    queue.set(block.id, { id: block.id, baseRevision: revisions.get(block.id) ?? 0, block });
    return true;
  }

  /** 本地删除入队（安全评审 HIGH：删除上行通道）：上行 {id, baseRevision, deleted:true}（服务端
   *  softDelete）。同 id 再入队会覆盖此前的编辑入队——本地已删，最新意图就是删。服务端没见过
   *  的块也照发：softDelete 对不存在的块返回 {applied:false, block:null}，走 conflicts 通道，
   *  队列照清、不卡通道。 */
  function enqueueDelete(id) {
    if (!account()) return false;
    if (typeof id !== 'string' || !id) return false;
    queue.set(id, { id, baseRevision: revisions.get(id) ?? 0, deleted: true });
    return true;
  }

  /** 登录后的首次同步：GET /api/blocks 全量拉取 → serverChanges 事件 + 游标落盘。
   * 未登录/离线/网络失败：静默返回（首次同步由挂载方在上线时机重试）。 */
  async function start() {
    if (!account() || !online) return;
    let response;
    try { response = await doFetch('/api/blocks', { headers: { 'x-tango-client': TANGO_CLIENT } }); }
    catch { return; } // 网络失败=离线语义：不抛、不重试
    if (!response || response.ok === false) return;
    let data; try { data = await response.json(); } catch { return; }
    learnRevisions(data?.blocks);
    if (Array.isArray(data?.blocks) && data.blocks.length) emit({ type: 'serverChanges', items: data.blocks });
    advanceCursor(data?.cursor);
  }

  /** 在线时 POST /api/blocks/sync：上行排队块（各带 baseRevision），下行 baseRevision=游标
   * 之后的增量 serverChanges（含冲突块，服务端已剔除）与 conflicts。成功后推进游标、
   * 清掉已上报的队列；冲突只经事件上报、本地版本保留由调用方处置，绝不自动重推。
   * 请求非法类 4xx（400/413/415）不清队列重试也永不成功——清队 + error 事件（防毒丸卡死通道），
   * 其余非 ok（401/403/5xx）与 fetch 抛错同语义：只排队不丢不抛。 */
  function flush() {
    if (!account() || !online) return Promise.resolve();
    if (inFlight) return inFlight; // 并发 flush 合一，避免重复上行同批
    inFlight = (async () => {
      const sent = [...queue.values()]; // 快照：发送期间新入队的留给下一轮
      let response;
      try {
        response = await doFetch('/api/blocks/sync', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-tango-client': TANGO_CLIENT },
          body: JSON.stringify({ baseRevision: readCursor(), changes: sent }),
        });
      } catch { return; } // fetch 抛错：只排队不丢不抛
      if (!response || response.ok === false) {
        // 请求本身非法的 4xx（400 字段校验 / 413 body 超限 / 415 content-type）与断网不同：重试
        // 永不成功。绝不能当离线无限重试——一条毒丸 change 会永久卡死上行+增量下行通道（安全评审
        // HIGH）。清掉本批并经 error 事件交还调用方：本地数据仍在宿主 state/存储（saveBase 已落），
        // 放弃的只是这次上行；清队后 poll 的空队列 POST 照常工作，增量下行恢复。
        // 401/403/404/5xx 仍与断网同语义（登录态/服务端可能恢复）：队列原样保留。
        if (response && (response.status === 400 || response.status === 413 || response.status === 415)) {
          for (const change of sent) if (queue.get(change.id) === change) queue.delete(change.id);
          emit({ type: 'error', status: response.status, items: sent });
        }
        return;
      }
      let data; try { data = await response.json(); } catch { return; }
      learnRevisions(data?.serverChanges);
      if (Array.isArray(data?.serverChanges) && data.serverChanges.length) emit({ type: 'serverChanges', items: data.serverChanges });
      if (Array.isArray(data?.conflicts) && data.conflicts.length) emit({ type: 'conflicts', items: data.conflicts });
      advanceCursor(data?.cursor);
      for (const change of sent) if (queue.get(change.id) === change) queue.delete(change.id); // 只清本轮真正上报的
    })().finally(() => { inFlight = null; });
    return inFlight;
  }

  /** 注入 online 状态；false→true 的恢复沿自动补写，返回的 promise 在补写完成后 resolve。 */
  function setOnline(next) {
    return Promise.resolve().then(async () => {
      const wasOnline = online;
      online = next === true;
      if (online && !wasOnline && account()) await flush();
    });
  }

  const pending = () => queue.size;
  return { start, enqueue, enqueueDelete, flush, setOnline, pending };
}

// ─────────────────────────────────────────────────────────────────────────────
// W1 Block 同步 · 挂载段：attachBlockSync——web/index.html load()/save() 持久化段的接入入口
//（BUILD-PLAN §3 W1-3、PRD §11.1）。分工：引擎只管传输与队列（见上），本段负责宿主侧三件事：
//   1. 首次同步前把本地数据完整备份到 localStorage['tango-donego.backup.<ts>']（全局键——
//      不匹配 TangoAccountStorage 的 scope 正则 web/app-auth.js:97，登录态也不改名），
//      完成后置 BACKUP_FLAG_PREFIX + ':<accountId>' 防重复备份（flag 含账号 id：同浏览器多账号各备一次）。
//   2. serverChanges 并入本地 state：block.source==='draft' → S.drafts，其余 → S.entries（跨列表
//      同 id 视为晋级，从旧列表移除）；deleted_at 置位的块从本地移除（软删除传播）；规范字段以服务端
//      为准、非规范字段保留（mergeBlockIntoEntry）；并入后经 saveBase 落盘——必须传 saveBaseState
//      语义的函数，不能传挂了 enqueue 的 save()，否则下行→保存→上行回环。
//   3. notifySave 脏检测：只上行规范内容变化过的块（内容 key = entryToBlock 输出），冲突块上报后
//      不自动重推（内容不变不再入队），冲突本身经 onEvent 透传、本地版本保留（第 3 批接提示 UI）。
//   4. notifyDelete(id) 本地删除上行（安全评审 HIGH）：入队 {id, deleted:true}（引擎 enqueueDelete）
//      + 墓碑拦住删除落定前的下行回填，防止已删块经 serverChanges/全量 GET 复活。
// 全依赖注入（无 DOM/localStorage 直引），浏览器与 Node 双跑；引擎 dequeue 失败时队列保留，
// 乐观标记的 key 不丢数据（内容仍在引擎队列里，下一轮 flush 照发）。
export const BACKUP_FLAG_PREFIX = 'tango-donego.blocks.backup.v1';

export function attachBlockSync({
  getState,               // () => S：live 状态（index.html 的 S 会被整体替换，必须经 getter 取引用）
  saveBase = () => {},    // (state) => boolean 本地持久化（saveBaseState 语义；返回 false/抛错不阻断）
  storage,                // localStorage 形状 {getItem,setItem}：游标 + 备份键
  fetchImpl,              // 类 fetch；缺省用全局 fetch
  getAccount = () => globalThis.TangoCurrentUser || null, // 登录账号或 null（null = 未登录，静默不动）
  now = Date.now,         // 备份键时间戳与 flag 的时间来源
  pollMs = 30000,         // 增量拉取轮询间隔（空队列 flush 也会带回游标后的 serverChanges）；0 = 关
  timer = { set: (fn, ms) => setInterval(fn, ms), clear: handle => clearInterval(handle) }, // 可注入定时器
  storeKey = 'tango-donego.web.v1', // index.html:737 的 STORE_KEY；备份优先取其原文（最忠实）
  onEvent = () => {},     // console-free 事件透传（{type:'serverChanges'|'conflicts', items}）
} = {}) {
  if (typeof getState !== 'function') throw new Error('SYNC_STATE_REQUIRED');
  if (!storage || typeof storage.getItem !== 'function' || typeof storage.setItem !== 'function') {
    throw new Error('SYNC_STORAGE_REQUIRED'); // 与引擎同约定：游标/备份不落盘宁可不构建
  }
  const engine = createBlockSync({ fetchImpl, storage, now, getAccount, onEvent: handleEngineEvent });
  const account = () => { const value = getAccount(); return value && typeof value === 'object' ? value : null; };
  const pushedKeys = new Map(); // id → 上次入队时 entryToBlock 的内容 key（脏检测）
  // 本地已删、上行未落定的块 id（墓碑）：拦住下行对该块的回填——另一台设备先改产生新 seq 也
  // 不复活本地已删的块（安全评审 HIGH）。删除 change 上行落定后服务端不再下发该块的非删除态；
  // 收到 deleted_at 下发（删除已生效）即清墓碑。仅内存态：与引擎队列同寿命（重载即空），此时
  // 删除早已 flush，服务端为权威不会再回填。
  const tombstones = new Set();
  let pollHandle = null;

  /** serverChanges 并入本地（引擎事件 → 宿主 state）。任何一步失败只影响本次并入，不抛给引擎。 */
  function applyServerChanges(blocks) {
    if (!Array.isArray(blocks)) return;
    const state = getState();
    if (!state || typeof state !== 'object') return;
    let changed = false;
    for (const block of blocks) {
      if (!block || typeof block !== 'object' || typeof block.id !== 'string' || !block.id) continue;
      const listName = block.source === 'draft' ? 'drafts' : 'entries';
      const otherName = listName === 'drafts' ? 'entries' : 'drafts';
      if (!Array.isArray(state[listName])) state[listName] = [];
      const list = state[listName];
      const other = Array.isArray(state[otherName]) ? state[otherName] : null;
      const index = list.findIndex(item => item && item.id === block.id);
      const otherIndex = other ? other.findIndex(item => item && item.id === block.id) : -1;
      if (block.deleted_at != null) {
        // 软删除传播：两列表里都清（晋级残留一并回收）；本地的待上行删除也在此刻落定 → 清墓碑
        if (index >= 0) { list.splice(index, 1); changed = true; }
        if (otherIndex >= 0) { other.splice(otherIndex, 1); changed = true; }
        tombstones.delete(block.id);
        continue;
      }
      if (tombstones.has(block.id)) continue; // 本地已删、上行未落定：不回填（防复活），等删除 change 落定
      if (index >= 0) {
        const before = JSON.stringify(list[index]);
        const merged = mergeBlockIntoEntry(list[index], block);
        if (JSON.stringify(merged) !== before) { list[index] = merged; changed = true; } // 回声相同不落盘
      } else {
        if (otherIndex >= 0) other.splice(otherIndex, 1); // 跨设备晋级（draft→web）：换列表
        list.push(blockToEntry(block));
        changed = true;
      }
      // 种脏检测基线：刚从服务端拿到/并入的规范内容不算脏——否则首次同步会把拉下来的块原样回传
      const seeded = entryToBlock(blockToEntry(block), { source: block.source === 'draft' ? 'draft' : 'web' });
      if (seeded) pushedKeys.set(seeded.id, JSON.stringify(seeded));
    }
    if (changed) { try { saveBase(state); } catch { /* 存不下不阻断同步：内存态已并入 */ } }
  }

  function handleEngineEvent(event) {
    if (event && event.type === 'serverChanges') applyServerChanges(event.items);
    try { onEvent(event); } catch { /* 回调抛错不阻断同步 */ }
  }

  /** 首次同步前整备份（PRD §11.1：迁移现有本地数据，保留本地备份）。任何存储异常都静默——
   *  备份失败不让同步停摆（本地原文仍在 storeKey 里，未被动过）。 */
  function ensureFirstSyncBackup() {
    const user = account();
    if (!user) return;
    const flagKey = BACKUP_FLAG_PREFIX + ':' + user.id;
    try {
      if (storage.getItem(flagKey)) return;                    // 该账号已备份过
      const raw = storage.getItem(storeKey);
      const snapshot = typeof raw === 'string' && raw ? raw : JSON.stringify(getState());
      storage.setItem('tango-donego.backup.' + now(), snapshot);
      storage.setItem(flagKey, '1');
    } catch { /* 备份失败不阻断：下次 start 仍会重试整备份 */ }
  }

  /** save() 成功后调用（先既有保存再入队）：脏块入队并 flush。入队即标记内容 key——
   *  flush 失败时引擎队列保留该块，标记不影响重发；冲突块上报后同内容不再自动重推。 */
  function notifySave() {
    const user = account();
    if (!user) return 0;
    const state = getState();
    if (!state || typeof state !== 'object') return 0;
    let dirty = 0;
    const visit = (list, source) => {
      if (!Array.isArray(list)) return;
      for (const entry of list) {
        if (!entry || typeof entry !== 'object') continue;
        const block = entryToBlock(entry, { source });
        if (!block) continue;                                  // 非法/缺 id：不上行脏数据（同引擎约定）
        const key = JSON.stringify(block);
        if (pushedKeys.get(block.id) === key) continue;        // 规范内容没变：幂等跳过
        engine.enqueue(entry, { source });
        pushedKeys.set(block.id, key);
        dirty += 1;
      }
    };
    visit(state.entries, 'web');
    visit(state.drafts, 'draft');
    if (dirty) engine.flush();
    return dirty;
  }

  /** 本地删除后调用（index.html 的 del / draft-del / 冲突整段裁剪）：入队 deleted:true 上行 +
   *  记墓碑拦住删除落定前的下行回填（防复活）。删除与基准不符（他端先改）→ conflicts 通道交回
   *  调用方，墓碑保留、本地不复活。未登录静默。 */
  function notifyDelete(id) {
    if (!account()) return false;
    if (typeof id !== 'string' || !id) return false;
    tombstones.add(id);
    pushedKeys.delete(id); // 已删的块不再参与脏检测
    const queued = engine.enqueueDelete(id);
    if (queued) engine.flush();
    return queued;
  }

  const poll = () => engine.flush();

  /** 登录后的挂载入口：整备份（首次）→ 引擎 start() 全量拉取并入 → notifySave 上行本地（首次迁移，
   *  迁移 POST 在本 promise 内完成，e2e/调用方可直接 await）。未登录静默；网络失败由引擎静默吞
   *  （下次 poll/notifySave 补）。幂等：重复 start 不重复备份、干净时不多发。 */
  async function start() {
    if (!account()) return;
    ensureFirstSyncBackup();
    await engine.start();
    if (notifySave() > 0) await engine.flush(); // flush 与 notifySave 触发的是同一 inFlight，合一等待
    if (pollMs > 0 && !pollHandle && timer && typeof timer.set === 'function') {
      pollHandle = timer.set(poll, pollMs);
    }
  }

  /** 卸载：清轮询定时器（测试/登出场景）。 */
  function stop() {
    if (pollHandle != null && timer && typeof timer.clear === 'function') timer.clear(pollHandle);
    pollHandle = null;
  }

  return { notifySave, notifyDelete, start, stop, poll, setOnline: online => engine.setOnline(online), pending: () => engine.pending() };
}
