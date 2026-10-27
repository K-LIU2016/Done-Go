// W12 现场感知 · 持久层（PRD §6.8）：node:sqlite DatabaseSync 上的三张表——
// captures（捕获 + 归属）、perception_cards（快慢双路同一张卡）、perception_events
// （append-only 台账，SSE 可重放）。DDL 唯一来源是 db/migrations/perception-*.sql；
// W0 迁移运行器交付前由本模块在传入的库上直接执行自己的 SQL（BUILD-PLAN §2.1 L48）。
// 安全基线：所有语句参数化（? 占位），owner 强制过滤（每条读写都带 owner_id），
// 布尔入库转 0/1（node:sqlite 不接受 boolean 绑定）。
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations');
const MIGRATION_NAME = /^perception-\d+-.*\.sql$/;

/** 按文件名排序执行 perception-*.sql（与 W0 迁移运行器同序）；DDL 幂等可重放。 */
export function applyPerceptionMigrations(db, dir = MIGRATIONS_DIR) {
  const files = readdirSync(dir).filter(f => MIGRATION_NAME.test(f)).sort();
  for (const name of files) db.exec(readFileSync(join(dir, name), 'utf8'));
  return files;
}

const hexId = prefix => prefix + randomBytes(8).toString('hex');
const asBool = v => (v === undefined ? 0 : v ? 1 : 0); // node:sqlite 不能绑 boolean
const fromJson = (text, fallback) => (text === null || text === undefined ? fallback : JSON.parse(text));
const toJson = value => (value === undefined || value === null ? null : JSON.stringify(value));

export function createPerceptionStore({
  db,                                   // node:sqlite DatabaseSync（内存库或 W0 打开的文件库）
  migrationsDir = MIGRATIONS_DIR,
  now = () => new Date().toISOString(),
  newId = hexId,
} = {}) {
  if (!db) throw new Error('DB_REQUIRED');
  applyPerceptionMigrations(db, migrationsDir);
  db.exec('PRAGMA foreign_keys = ON'); // 卡与事件必须挂在真实捕获下，不落孤儿行

  // ---- 行映射（snake_case 存储 → camelCase 契约） ----
  const mapCapture = r => r && {
    id: r.id,
    ownerId: r.owner_id,
    kind: r.kind,
    capturedAt: r.captured_at,
    uploadedAt: r.uploaded_at,
    storedPath: r.stored_path,
    keepOriginal: !!r.keep_original,
    exifStripped: !!r.exif_stripped,
    status: r.status,
    blockId: r.block_id ?? null,
    confidence: r.confidence ?? null,
    candidates: fromJson(r.candidates, null),
  };
  const mapCard = r => r && {
    id: r.id,
    captureId: r.capture_id,
    ownerId: r.owner_id,
    level: r.level,
    model: r.model,
    ms: r.ms,
    seen: r.seen ?? null,
    change: r.change ?? null,
    risk: r.risk ?? null,
    suggestion: r.suggestion ?? null,
    actions: fromJson(r.actions, []),
    state: r.state,
    updatedAt: r.updated_at,
  };
  const mapEvent = r => r && {
    seq: r.seq,
    captureId: r.capture_id,
    ownerId: r.owner_id,
    type: r.type,
    payload: fromJson(r.payload, {}),
    createdAt: r.created_at,
  };

  const prepared = new Map(); // 库实例固定于本 store，语句按 SQL 缓存
  const stmt = sql => {
    let s = prepared.get(sql);
    if (!s) prepared.set(sql, (s = db.prepare(sql)));
    return s;
  };

  function insertCapture(capture) {
    const id = capture.id ?? newId('cap_');
    stmt(`INSERT INTO captures
            (id, owner_id, kind, captured_at, uploaded_at, stored_path, keep_original, exif_stripped, status)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      id, capture.ownerId, capture.kind, capture.capturedAt, capture.uploadedAt,
      capture.storedPath, asBool(capture.keepOriginal), asBool(capture.exifStripped),
      capture.status ?? 'pending',
    );
    return getCapture(capture.ownerId, id);
  }

  function getCapture(ownerId, id) {
    return mapCapture(stmt('SELECT * FROM captures WHERE owner_id = ? AND id = ?').get(ownerId, id));
  }

  function listCaptures(ownerId) {
    return stmt('SELECT * FROM captures WHERE owner_id = ? ORDER BY uploaded_at DESC, rowid DESC')
      .all(ownerId).map(mapCapture);
  }

  function updateAttribution(ownerId, id, { blockId, confidence, candidates } = {}) {
    const r = stmt(`UPDATE captures SET block_id = ?, confidence = ?, candidates = ?
                    WHERE owner_id = ? AND id = ?`).run(
      blockId ?? null, confidence ?? null, toJson(candidates), ownerId, id,
    );
    return r.changes > 0;
  }

  /** 歧义归属的用户裁决：拍板即确定（confidence=1），候选清空。 */
  function resolveCapture(ownerId, id, blockId) {
    const r = stmt(`UPDATE captures SET block_id = ?, confidence = 1, candidates = NULL
                    WHERE owner_id = ? AND id = ?`).run(blockId, ownerId, id);
    return r.changes > 0 ? getCapture(ownerId, id) : undefined;
  }

  function setStatus(ownerId, id, status) {
    const r = stmt('UPDATE captures SET status = ? WHERE owner_id = ? AND id = ?').run(status, ownerId, id);
    return r.changes > 0;
  }

  function insertCard(card) {
    const id = card.id ?? newId('card_');
    stmt(`INSERT INTO perception_cards
            (id, capture_id, owner_id, level, model, ms, seen, change, risk, suggestion, actions, state, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      id, card.captureId, card.ownerId, card.level, card.model, card.ms,
      card.seen ?? null, card.change ?? null, card.risk ?? null, card.suggestion ?? null,
      toJson(card.actions ?? []), card.state, now(),
    );
    return getCard(card.ownerId, card.captureId);
  }

  function getCard(ownerId, captureId) {
    return mapCard(stmt('SELECT * FROM perception_cards WHERE owner_id = ? AND capture_id = ?').get(ownerId, captureId));
  }

  function getCards(ownerId, captureId) {
    return stmt('SELECT * FROM perception_cards WHERE owner_id = ? AND capture_id = ? ORDER BY rowid')
      .all(ownerId, captureId).map(mapCard);
  }

  /** 深感知结果原地升级同一张卡（UNIQUE(capture_id) 保证只有一张），不新增行。 */
  function upgradeCard(ownerId, captureId, patch = {}) {
    const r = stmt(`UPDATE perception_cards SET
                      level = ?, model = ?, ms = ?, seen = ?, change = ?, risk = ?,
                      suggestion = ?, actions = ?, state = ?, updated_at = ?
                    WHERE owner_id = ? AND capture_id = ?`).run(
      patch.level, patch.model, patch.ms, patch.seen ?? null, patch.change ?? null,
      patch.risk ?? null, patch.suggestion ?? null, toJson(patch.actions ?? []),
      patch.state, now(), ownerId, captureId,
    );
    return r.changes > 0 ? getCard(ownerId, captureId) : undefined;
  }

  function appendEvent({ captureId, ownerId, type, payload }) {
    const createdAt = now();
    const r = stmt(`INSERT INTO perception_events (capture_id, owner_id, type, payload, created_at)
                    VALUES (?, ?, ?, ?, ?)`).run(captureId, ownerId, type, toJson(payload ?? {}), createdAt);
    return { seq: r.lastInsertRowid, captureId, ownerId, type, payload: payload ?? {}, createdAt };
  }

  function listEvents(ownerId, captureId) {
    return stmt(`SELECT * FROM perception_events WHERE owner_id = ? AND capture_id = ? ORDER BY seq`)
      .all(ownerId, captureId).map(mapEvent);
  }

  return {
    insertCapture, getCapture, listCaptures,
    updateAttribution, resolveCapture, setStatus,
    insertCard, getCard, getCards, upgradeCard,
    appendEvent, listEvents,
  };
}
