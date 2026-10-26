// W1 block-store：blocks 表的服务端权威存储（PRD §11.1、BUILD-PLAN §3 W1-1、规划 DAG blocks-db 节）。
// 建表 SQL 在 scripts/agentic/db/migrations/blocks-001-blocks.sql；W0 迁移器未交付前由调用方/测试
// 直接 exec（BUILD-PLAN §2.1 L48），本模块只约定表已存在。
// 语义（行为契约见 tests/unit/agentic/blocks/store.test.mjs 头注）：
//   upsert(owner, {id, baseRevision, block})  新建 base=0；更新 base=当前 revision；revision 服务端
//     递增；同一 change 重放（base=revision-1 且规范内容一致）不前进；base 不符且非重放 →
//     {applied:false, block:服务端当前块}（逐条冲突判定在调用方，模式同 collaboration-store 的
//     CONFLICT 检查但不整体 409）。
//   softDelete(owner, {id, baseRevision})     deleted_at 置位不物理删；重放/冲突语义同 upsert。
//   list(owner, from, to)                     未删除块，date ∈ [from,to] 含两端，单边可省。
//   changesSince(owner, cursor)               → {changes:[{seq,at,block}], cursor}：每块只出最新状态、
//     seq 升序；cursor=该 owner 可见的最大全局 seq（block_changes.seq，避免 updated_at 撞秒），
//     无新变更原样返回传入 cursor。
import { DatabaseSync } from 'node:sqlite';

const contentFields = ['date', 'start', 'end', 'title', 'kind', 'prio', 'note', 'done', 'source'];

export function blocksError(code, status = 400) { return Object.assign(new Error(code), { code, status }); }
function requireInput(ok, code = 'INVALID_INPUT') { if (!ok) throw blocksError(code); }

// 客户端 revision/deleted_at/updated_at 不上行生效：只取规范内容字段并归一。
function normalizeContent(block) {
  requireInput(block && typeof block === 'object');
  const text = (value, field) => { requireInput(typeof value === 'string', 'BLOCK_' + field.toUpperCase()); return value; };
  const content = {
    date: text(block.date, 'date'),
    start: block.start == null ? null : text(block.start, 'start'),
    end: block.end == null ? null : text(block.end, 'end'),
    title: text(block.title, 'title'),
    kind: text(block.kind, 'kind'),
    prio: block.prio,
    note: block.note == null ? '' : text(block.note, 'note'),
    done: block.done === true,
    source: text(block.source, 'source'),
  };
  requireInput(Number.isInteger(content.prio));
  return content;
}
const contentKey = content => JSON.stringify(contentFields.map(field => content[field]));

export function createBlocksStore({ db, now = () => new Date().toISOString() }) {
  if (!(db instanceof DatabaseSync)) throw blocksError('DB_REQUIRED', 500);
  const loadRow = (owner, id) => db.prepare('SELECT * FROM blocks WHERE owner_id=? AND id=?').get(owner, id);
  const rowToBlock = row => row && {
    id: row.id, revision: row.revision, date: row.date, start: row.start, end: row.end,
    title: row.title, kind: row.kind, prio: row.prio, note: row.note, done: row.done === 1,
    source: row.source, deleted_at: row.deleted_at, updated_at: row.updated_at,
  };
  const rowContent = row => ({ date: row.date, start: row.start, end: row.end, title: row.title, kind: row.kind, prio: row.prio, note: row.note, done: row.done === 1, source: row.source });
  const logChange = (owner, id, at) => db.prepare('INSERT INTO block_changes(owner_id, block_id, at) VALUES (?,?,?)').run(owner, id, at);
  function transaction(fn) { db.exec('BEGIN IMMEDIATE'); try { const result = fn(); db.exec('COMMIT'); return result; } catch (error) { db.exec('ROLLBACK'); throw error; } }

  // 单条 change 的应用判定。deleted=true 表示 softDelete（无 block 内容）。
  // 返回 {applied, block}：applied=false 时 block 为服务端当前块（块不存在则 null），不抛错。
  function applyChange(owner, { id, baseRevision, block }, deleted) {
    requireInput(typeof owner === 'string' && owner);
    requireInput(typeof id === 'string' && id.length <= 200);
    requireInput(Number.isInteger(baseRevision) && baseRevision >= 0);
    const content = deleted ? null : normalizeContent(block);
    const row = loadRow(owner, id);
    if (deleted) {
      if (!row) return { applied: false, block: null };                         // 无可删：交调用方处置
      const isReplay = row.deleted_at != null && baseRevision === row.revision - 1;
      if (isReplay) return { applied: true, block: rowToBlock(row) };           // 同一删除重发：不前进
      if (baseRevision !== row.revision) return { applied: false, block: rowToBlock(row) };
      return transaction(() => {
        const stamp = now();
        db.prepare('UPDATE blocks SET revision=?, deleted_at=?, updated_at=? WHERE owner_id=? AND id=?').run(row.revision + 1, stamp, stamp, owner, id);
        logChange(owner, id, stamp);
        return { applied: true, block: rowToBlock(loadRow(owner, id)) };
      });
    }
    if (!row) {
      if (baseRevision !== 0) return { applied: false, block: null };           // 未知块的过期基准
      return transaction(() => {
        const stamp = now();
        db.prepare('INSERT INTO blocks(owner_id,id,revision,date,start,"end",title,kind,prio,note,done,source,deleted_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,NULL,?)')
          .run(owner, id, 1, content.date, content.start, content.end, content.title, content.kind, content.prio, content.note, content.done ? 1 : 0, content.source, stamp);
        logChange(owner, id, stamp);
        return { applied: true, block: rowToBlock(loadRow(owner, id)) };
      });
    }
    // 重放：base=revision-1 且当前状态就是这次 change 的结果（未删除且规范内容一致）
    const isReplay = row.deleted_at == null && baseRevision === row.revision - 1 && contentKey(content) === contentKey(rowContent(row));
    if (isReplay) return { applied: true, block: rowToBlock(row) };
    if (baseRevision !== row.revision) return { applied: false, block: rowToBlock(row) };
    return transaction(() => {
      const stamp = now();
      db.prepare('UPDATE blocks SET revision=?, date=?, start=?, "end"=?, title=?, kind=?, prio=?, note=?, done=?, source=?, deleted_at=NULL, updated_at=? WHERE owner_id=? AND id=?')
        .run(row.revision + 1, content.date, content.start, content.end, content.title, content.kind, content.prio, content.note, content.done ? 1 : 0, content.source, stamp, owner, id);
      logChange(owner, id, stamp);
      return { applied: true, block: rowToBlock(loadRow(owner, id)) };
    });
  }

  function list(owner, from, to) {
    requireInput(typeof owner === 'string' && owner);
    const where = ['owner_id=?', 'deleted_at IS NULL'];
    const args = [owner];
    if (from != null) { requireInput(/^\d{4}-\d{2}-\d{2}$/.test(from), 'INVALID_FROM'); where.push('date>=?'); args.push(from); }
    if (to != null) { requireInput(/^\d{4}-\d{2}-\d{2}$/.test(to), 'INVALID_TO'); where.push('date<=?'); args.push(to); }
    return db.prepare('SELECT * FROM blocks WHERE ' + where.join(' AND ') + ' ORDER BY date, "start", id').all(...args).map(rowToBlock);
  }

  function changesSince(owner, cursor) {
    requireInput(typeof owner === 'string' && owner);
    requireInput(Number.isInteger(cursor) && cursor >= 0, 'INVALID_CURSOR');
    // 每块只出最新状态：按块取 MAX(seq)，再与 blocks 连接取当前快照；只含本 owner 的行。
    const rows = db.prepare(`
      SELECT c.seq AS seq, c.at AS at, b.*
      FROM block_changes c JOIN blocks b ON b.owner_id = c.owner_id AND b.id = c.block_id
      WHERE c.owner_id = ? AND c.seq > ? AND c.seq = (SELECT MAX(c2.seq) FROM block_changes c2 WHERE c2.owner_id = c.owner_id AND c2.block_id = c.block_id)
      ORDER BY c.seq`).all(owner, cursor);
    return { changes: rows.map(row => ({ seq: row.seq, at: row.at, block: rowToBlock(row) })), cursor: rows.length ? rows[rows.length - 1].seq : cursor };
  }

  return {
    upsert: (owner, change) => applyChange(owner, change, false),
    softDelete: (owner, change) => applyChange(owner, change, true),
    list,
    changesSince,
  };
}
