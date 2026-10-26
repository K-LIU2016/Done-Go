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
    prio: Number.isFinite(entry.prio) ? entry.prio : 3,
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
  onEvent = () => {},    // console-free 事件回调：{type:'serverChanges'|'conflicts', items}
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
   * 清掉已上报的队列；冲突只经事件上报、本地版本保留由调用方处置，绝不自动重推。 */
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
      if (!response || response.ok === false) return; // 4xx/5xx 与断网同语义，队列原样保留
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
  return { start, enqueue, flush, setOnline, pending };
}
