// W1 Block 同步 · 前端映射段：S.entries/S.drafts ↔ 服务端 blocks 的纯函数字段映射。
// 依据：BUILD-PLAN §3 W1-2、PRD §11.1 —— 登录用户的 entries/drafts 同步到服务端 blocks
//（服务端为权威、浏览器为缓存），客户端 uid() 生成的 id 原样作为 block id，重放/补写靠它幂等。
// 本文件是浏览器原生 ES 模块（BUILD-PLAN §2.3 免构建）；映射段零依赖、无 DOM，Node 单测直接 import。
// 引擎段（createBlockSync：游标增量/离线排队/上线补写/冲突回调）由 sync-engine 节点接在本段之后。

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
