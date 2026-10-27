// W9 M3 inbox-domain · Need 存储与生命周期（plan §G1-M3-2，brief 裁决⑤）。
//
// createNeedStore({ db, clock, idGen, events? }) → { createNeed, get, list, answer, waive }
//   - 状态机 open → answered|defaulted|waived|expired（README §状态机）；本模块产生
//     created/answered/waived 事件，defaulted 由 expiry.sweep 产生（status 迁移权在各自路径）。
//   - answer 幂等键 (owner_id, need_id, revision)（brief 裁决⑤）：已 answered 且重放
//     “被消费的那个 revision” → 原样返回首答（不追加事件）；否则非 open 一律 CONFLICT。
//   - 跨 owner 读取/回答/放弃 → NOT_FOUND（README §owner 隔离，不泄露存在性）。
//   - id/status/revision/ownerId/answer/answeredAt 服务端生成，客户端提交即 CONTRACT_INVALID。
//   - clock/idGen 强制注入（红线6：业务路径禁真实 wall clock）；events 默认 no-op（W10 只经此对接）。
//   - 每次生命周期变化同步 AttentionItem 投影行（attention-projection.mjs）。
import { syncAttentionItem } from './attention-projection.mjs';

export const NEED_TYPES = Object.freeze(['decision', 'data', 'authorization', 'attendance', 'acceptance']);
export const NEED_DEFAULT_ACTIONS = Object.freeze(['continue', 'pause', 'skip', 'deliver_best', 'stop']);
export const NEED_STATUSES = Object.freeze(['open', 'answered', 'defaulted', 'waived', 'expired']);

// 镜像 scripts/agentic/contracts.mjs:5-6 的 date-time 规则（该正则未被导出，故本地复刻）。
const OFFSET = String.raw`(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)`;
const ISO_DATE_TIME = new RegExp(String.raw`^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?${OFFSET}$`);

const CLIENT_ALLOWED_FIELDS = Object.freeze(['missionId', 'type', 'question', 'dueAt', 'defaultAction']);
const SERVER_OWNED_FIELDS = Object.freeze(['id', 'ownerId', 'status', 'revision', 'answer', 'answeredAt']);

const SELECT_NEED = 'SELECT id, owner_id, mission_id, type, question, due_at, default_action, status, answer, answered_at, revision FROM w9_needs WHERE id = ? AND owner_id = ?';
const SELECT_NEEDS_BY_OWNER = 'SELECT id, owner_id, mission_id, type, question, due_at, default_action, status, answer, answered_at, revision FROM w9_needs WHERE owner_id = ? ORDER BY rowid';
const INSERT_NEED = 'INSERT INTO w9_needs (id, owner_id, mission_id, type, question, due_at, default_action, status, answer, answered_at, revision) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';
const UPDATE_ANSWER = 'UPDATE w9_needs SET status = ?, answer = ?, answered_at = ?, revision = ? WHERE id = ? AND owner_id = ? AND revision = ? AND status = ?';
const UPDATE_WAIVE = 'UPDATE w9_needs SET status = ?, revision = ? WHERE id = ? AND owner_id = ? AND revision = ? AND status = ?';
const INSERT_EVENT = 'INSERT INTO w9_need_events (id, owner_id, need_id, type, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?)';

const NOOP_EVENTS = { emit() {} };

function invalid(message, details) {
  const error = new Error(`CONTRACT_INVALID: ${message}`);
  error.code = 'CONTRACT_INVALID';
  if (details !== undefined) error.details = details;
  return error;
}

function conflict(message) {
  const error = new Error(`CONFLICT: ${message}`);
  error.code = 'CONFLICT';
  return error;
}

function notFound(message = 'need not found') {
  const error = new Error(`NOT_FOUND: ${message}`);
  error.code = 'NOT_FOUND';
  return error;
}

export function isIsoDateTime(value) {
  if (typeof value !== 'string' || !ISO_DATE_TIME.test(value)) return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T/.exec(value);
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return date.getUTCFullYear() === Number(match[1])
    && date.getUTCMonth() === Number(match[2]) - 1
    && date.getUTCDate() === Number(match[3])
    && !Number.isNaN(Date.parse(value));
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

/** DB 行（snake_case）→ 内部记录（camelCase）。 */
export function recordFromRow(row) {
  if (row === null || row === undefined) return null;
  return {
    id: row.id,
    ownerId: row.owner_id,
    missionId: row.mission_id,
    type: row.type,
    question: row.question,
    dueAt: row.due_at,
    defaultAction: row.default_action,
    status: row.status,
    answer: row.answer,
    answeredAt: row.answered_at,
    revision: row.revision,
  };
}

/** append-only 生命周期事件（低层助手，expiry.mjs 复用；eventId 由调用方生成）。 */
export function appendNeedEvent(db, eventId, record, type, payload, createdAt) {
  db.prepare(INSERT_EVENT).run(eventId, record.ownerId, record.id, type, JSON.stringify(payload ?? {}), createdAt);
}

/** 单语句序列包成事务：失败回滚，异常原样上抛。 */
function withTransaction(db, fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // 保留原始异常；回滚失败时连接已不可信，由调用方处置。
    }
    throw error;
  }
}

function validateCreateInput(ownerId, payload) {
  if (!nonEmptyString(ownerId)) throw invalid('ownerId must be a non-empty string');
  if (!isPlainObject(payload)) throw invalid('need payload must be an object');
  const forged = SERVER_OWNED_FIELDS.filter((field) => Object.prototype.hasOwnProperty.call(payload, field));
  if (forged.length > 0) {
    throw invalid('need server-owned field(s) submitted by client', { fields: forged });
  }
  const unknown = Object.keys(payload).filter((key) => !CLIENT_ALLOWED_FIELDS.includes(key));
  if (unknown.length > 0) {
    throw invalid('need payload has unknown field(s)', { fields: unknown });
  }
  if (!nonEmptyString(payload.missionId)) throw invalid('missionId must be a non-empty string');
  if (!NEED_TYPES.includes(payload.type)) throw invalid('type must be one of the frozen need types');
  if (!nonEmptyString(payload.question)) throw invalid('question must be a non-empty string');
  if (!isIsoDateTime(payload.dueAt)) throw invalid('dueAt must be an ISO date-time string');
  if (payload.defaultAction !== undefined && payload.defaultAction !== null && !NEED_DEFAULT_ACTIONS.includes(payload.defaultAction)) {
    throw invalid('defaultAction must be one of the frozen default actions or null');
  }
}

export function createNeedStore({ db, clock, idGen, events }) {
  for (const [key, value] of [['db', db], ['clock', clock], ['idGen', idGen]]) {
    if (value === undefined || value === null) {
      throw new Error(`createNeedStore: missing required injectable(s): ${key}`);
    }
  }
  if (typeof clock.now !== 'function') throw new Error('createNeedStore: clock.now must be a function');
  if (typeof idGen !== 'function') throw new Error('createNeedStore: idGen must be a function');
  const sink = events === undefined || events === null ? NOOP_EVENTS : events;
  if (typeof sink.emit !== 'function') throw new Error('createNeedStore: events.emit must be a function when events is provided');

  const emit = (type, record, at, data) => {
    sink.emit({ type, ownerId: record.ownerId, objectType: 'need', objectId: record.id, at, data });
  };

  function fetchRow(ownerId, needId) {
    if (!nonEmptyString(ownerId)) throw invalid('ownerId must be a non-empty string');
    if (!nonEmptyString(needId)) throw invalid('needId must be a non-empty string');
    const row = db.prepare(SELECT_NEED).get(needId, ownerId);
    if (row === null || row === undefined) throw notFound();
    return row;
  }

  function lifecycle(record, type, at, data, eventId) {
    appendNeedEvent(db, eventId, record, type, data, at);
    syncAttentionItem(db, { ...record, updatedAt: at });
    emit(type, record, at, data);
  }

  return {
    async createNeed(ownerId, payload) {
      validateCreateInput(ownerId, payload);
      const id = idGen();
      if (!nonEmptyString(id)) throw invalid('idGen must return a non-empty string');
      const now = clock.now();
      if (!isIsoDateTime(now)) throw invalid('clock.now() must return an ISO date-time string');
      const record = {
        id,
        ownerId,
        missionId: payload.missionId,
        type: payload.type,
        question: payload.question,
        dueAt: payload.dueAt,
        defaultAction: payload.defaultAction ?? null,
        status: 'open',
        answer: null,
        answeredAt: null,
        revision: 1,
      };
      withTransaction(db, () => {
        db.prepare(INSERT_NEED).run(
          record.id, record.ownerId, record.missionId, record.type, record.question,
          record.dueAt, record.defaultAction, record.status, record.answer, record.answeredAt, record.revision,
        );
        lifecycle(record, 'need.created', now, { missionId: record.missionId, type: record.type }, idGen());
      });
      return record;
    },

    async get(ownerId, needId) {
      return recordFromRow(fetchRow(ownerId, needId));
    },

    async list(ownerId) {
      if (!nonEmptyString(ownerId)) throw invalid('ownerId must be a non-empty string');
      return db.prepare(SELECT_NEEDS_BY_OWNER).all(ownerId).map(recordFromRow);
    },

    async answer(ownerId, needId, { answer, revision } = {}) {
      if (!nonEmptyString(answer)) throw invalid('answer must be a non-empty string');
      if (!Number.isInteger(revision) || revision < 1) throw invalid('revision must be an integer >= 1');
      const row = fetchRow(ownerId, needId);

      // 幂等重放（brief 裁决⑤）：该 need 已 answered，且重放的正是被消费的 revision
      // → 原样返回首答，不写库、不追加事件（测试断言事件数不再增长）。
      if (row.status === 'answered' && revision === row.revision - 1) {
        return recordFromRow(row);
      }
      if (row.status !== 'open') {
        throw conflict(`need is ${row.status}, not open to answer`);
      }
      if (revision !== row.revision) {
        throw conflict(`answer revision ${revision} does not match current revision ${row.revision}`);
      }

      const now = clock.now();
      if (!isIsoDateTime(now)) throw invalid('clock.now() must return an ISO date-time string');
      const updated = {
        ...recordFromRow(row),
        status: 'answered',
        answer,
        answeredAt: now,
        revision: row.revision + 1,
      };
      withTransaction(db, () => {
        const result = db.prepare(UPDATE_ANSWER).run(
          updated.status, updated.answer, updated.answeredAt, updated.revision,
          row.id, row.owner_id, row.revision, 'open',
        );
        if (result.changes !== 1) throw conflict('need changed concurrently, retry with the current revision');
        lifecycle(updated, 'need.answered', now, { revision: updated.revision }, idGen());
      });
      return updated;
    },

    async waive(ownerId, needId) {
      const row = fetchRow(ownerId, needId);
      if (row.status !== 'open') {
        throw conflict(`need is ${row.status}, not open to waive`);
      }
      const now = clock.now();
      if (!isIsoDateTime(now)) throw invalid('clock.now() must return an ISO date-time string');
      const updated = { ...recordFromRow(row), status: 'waived', revision: row.revision + 1 };
      withTransaction(db, () => {
        const result = db.prepare(UPDATE_WAIVE).run(updated.status, updated.revision, row.id, row.owner_id, row.revision, 'open');
        if (result.changes !== 1) throw conflict('need changed concurrently');
        lifecycle(updated, 'need.waived', now, { revision: updated.revision }, idGen());
      });
      return updated;
    },
  };
}
