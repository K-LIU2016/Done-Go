// W1 block-routes：createBlockRoutes——block-store 的 HTTP 层（PRD §11.1、BUILD-PLAN §3 W1-1、§2.1 L46）。
// 不挂 serve-tango.mjs：导出 (req, res, pathname) => handled:boolean，由挂载方（第 3 批 W13）或测试
// harness 自建 server 调用；pathname 含查询串（GET /api/blocks?from&to 需要它）。
// 行为契约见 tests/unit/agentic/blocks/routes.test.mjs 头注：
//   GET  /api/blocks[?from&to] → 200 {blocks, cursor}   只含本 owner 未删除块；from/to 合法
//     YYYY-MM-DD、可单边；非法 → 400（store.list 是校验唯一来源，本层不重复正则）。
//   POST /api/blocks/sync      body {baseRevision, changes:[{id, baseRevision, block|deleted}]}
//     → 200 {applied, conflicts, serverChanges, cursor}。冲突 = change.baseRevision ≠ 服务端当前
//     revision（判定模式同 collaboration-store.mjs:69 的 revision 基准检查，但逐条进 conflicts、
//     不整体 409）；幂等重放 applied 不计数、revision 不前进。批内任何一条（含字段级内容）非法
//     → 整批 400、一条也不落库（原子：store.validateChange 预检先于应用循环）。
// 护栏（安全评审落代码，对齐 collaboration-service.mjs）：x-tango-client/origin 校验(:68-69)、
//   JSON content-type 415 / body≤128KB 413 / 坏 JSON 400（:11-15 readBody）、单次 changes≤500。
import { blocksError } from './store.mjs';

const MAX_CHANGES = 500;
const MAX_BODY = 128 * 1024;

function need(ok, code = 'INVALID_INPUT', status = 400) { if (!ok) throw blocksError(code, status); }

// 同 collaboration-service.mjs:11-15：先验 content-type，流式累计超 128KB 即断，坏 JSON/非对象 400。
async function readBody(req) {
  need(/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || ''), 'JSON_REQUIRED', 415);
  let size = 0; const chunks = [];
  for await (const part of req) { size += part.length; if (size > MAX_BODY) throw blocksError('BODY_TOO_LARGE', 413); chunks.push(part); }
  let body; try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw blocksError('INVALID_JSON'); }
  need(body && typeof body === 'object' && !Array.isArray(body));
  return body;
}

export function createBlockRoutes({ store, authenticate, requestAllowed, now }) {
  // now 保留在签名里（与 store 共用同一注入时钟的挂载约定）；时间戳一律由 store 落，本层不重复盖章。
  need(typeof store === 'object' && store, 'STORE_REQUIRED', 500);
  need(typeof authenticate === 'function', 'AUTH_REQUIRED', 500);
  need(typeof requestAllowed === 'function', 'ORIGIN_REJECTED', 500);

  function send(res, status, value) {
    if (!res.destroyed) res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }).end(JSON.stringify(value));
  }

  // 应用一条 change 并分类。prior = 本批开始前该块的服务端最新状态（undefined = 服务端没见过）。
  // 真应用与重放 store 都回 applied:true 且事后 revision 同为 base+1，只能靠 prior.revision 区分：
  // base = prior.revision → 真应用（store 写 block_changes、revision 前进）；base = prior.revision-1 →
  // 重放（store 不写日志），applied 不计数。store 判 applied:false 时带回服务端当前块（可能为 null）。
  function applyChange(owner, change, prior) {
    const result = change.deleted === true ? store.softDelete(owner, change) : store.upsert(owner, change);
    if (!result.applied) return { conflict: { id: change.id, block: result.block } };
    return { block: result.block, applied: !(prior && change.baseRevision === prior.revision - 1) };
  }

  async function syncBlocks(owner, body) {
    need(Number.isInteger(body.baseRevision) && body.baseRevision >= 0, 'INVALID_BASE_REVISION');
    need(Array.isArray(body.changes), 'INVALID_CHANGES');
    need(body.changes.length <= MAX_CHANGES, 'TOO_MANY_CHANGES');
    // 结构 + 内容校验全部前置（原子性：任何一条坏数据都在写库前整体 400，绝不半批落库——
    // 安全评审 HIGH）。字段级内容校验的唯一来源仍是 store：validateChange 与真实应用走同一条
    // normalizeContent，本层不重复实现；预检与下方应用循环之间无 await，校验通过的批不会再在
    // 应用期抛错。
    for (const change of body.changes) {
      need(change && typeof change === 'object' && !Array.isArray(change));
      need(typeof change.id === 'string' && change.id.length > 0 && change.id.length <= 200);
      need(Number.isInteger(change.baseRevision) && change.baseRevision >= 0);
      need(change.deleted === true || (change.block && typeof change.block === 'object'));
      store.validateChange(change);
    }
    // 应用前快照：owner 全部块（含已软删）的最新状态，每块一条（changesSince(owner,0) 的语义），
    // 用于区分真应用/重放。代价 O(该 owner 的历史块数)，W1 规模（单人日程，数百块）可接受。
    const current = new Map(store.changesSince(owner, 0).changes.map(entry => [entry.block.id, entry.block]));
    let applied = 0; const conflicts = [];
    for (const change of body.changes) {
      const outcome = applyChange(owner, change, current.get(change.id));
      if (outcome.conflict) conflicts.push(outcome.conflict);
      else { if (outcome.applied) applied++; current.set(change.id, outcome.block); }
    }
    // 下发：baseRevision 之后每个块的最新状态（含本批新应用的），冲突块剔除——不自动下发防覆盖
    // 本地（PRD §11.1：冲突交前端提示合并）。cursor = 该 owner 可见最大全局 seq，无变更时原样回传。
    const conflictIds = new Set(conflicts.map(conflict => conflict.id));
    const pulled = store.changesSince(owner, body.baseRevision);
    const serverChanges = pulled.changes.filter(entry => !conflictIds.has(entry.block.id)).map(entry => entry.block);
    return { applied, conflicts, serverChanges, cursor: pulled.cursor };
  }

  return async function handle(req, res, pathname) {
    const path = pathname.split('?')[0];
    if (path !== '/api/blocks' && !path.startsWith('/api/blocks/')) return false;
    try {
      need(req.headers['x-tango-client'] === 'tango-settings/1', 'ORIGIN_REJECTED', 403);   // 同 collaboration-service.mjs:68
      need(requestAllowed(req), 'ORIGIN_REJECTED', 403);                                    // 同 collaboration-service.mjs:69
      const body = req.method === 'POST' ? await readBody(req) : {};
      const url = new URL(pathname, 'http://blocks.local');
      let result;
      if (url.pathname === '/api/blocks' && req.method === 'GET') {
        const actor = authenticate(req);
        result = { blocks: store.list(actor.id, url.searchParams.get('from'), url.searchParams.get('to')), cursor: store.changesSince(actor.id, 0).cursor };
      } else if (url.pathname === '/api/blocks/sync' && req.method === 'POST') {
        const actor = authenticate(req);
        result = await syncBlocks(actor.id, body);
      } else throw blocksError('NOT_FOUND', 404);
      send(res, 200, result);
    } catch (error) {
      const status = Number.isInteger(error.status) ? error.status : 500;
      send(res, status, { error: typeof error.code === 'string' ? error.code : 'BLOCKS_UNAVAILABLE' });
    }
    return true;
  };
}
