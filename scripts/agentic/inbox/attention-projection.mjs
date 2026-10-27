// W9 M3 inbox-domain · Need → AttentionItem 投影 + 冻结 Need 物化（plan §G1-M3-4）。
//
// 三个导出：
//   toAttentionItem(record)  内部 need 记录 → 投影行对象（不落库）。
//   syncAttentionItem(db, record) upsert（need_id+owner_id 唯一），返回写入后的行（带 changed 标记）。
//   needView(record)         物化冻结 need.schema.json 对象（只保留 schema 字段）。
//
// 契约张力③（plan）：defaultAction 为 NULL 的 need 不物化冻结 Need 对象（schema 要求
// defaultAction 枚举非空），对外走 AttentionItem 投影（unknownFlag=1 继续等待）。
// 本模块不读 wall clock（updated_at 取自记录自带的时间字段），不发任何通知（红线3）。
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSchema, validate } from '../contracts.mjs';

/** 冻结契约目录（contracts/agentic），由本模块位置推导，不从环境读取。 */
export const CONTRACT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'contracts', 'agentic');

const NEED_SCHEMA = loadSchema('need.schema.json', CONTRACT_DIR);

function contractInvalid(message) {
  const error = new Error(`CONTRACT_INVALID: ${message}`);
  error.code = 'CONTRACT_INVALID';
  return error;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

/** 内部 need 记录的最小形状守护（id/ownerId/type/status/question 必有，defaultAction 可空）。 */
function assertRecord(record) {
  if (!isPlainObject(record)) throw contractInvalid('need record must be an object');
  for (const field of ['id', 'ownerId', 'type', 'question', 'status', 'dueAt']) {
    if (!nonEmptyString(record[field])) throw contractInvalid(`need record.${field} must be a non-empty string`);
  }
  if (record.defaultAction !== null && record.defaultAction !== undefined && !nonEmptyString(record.defaultAction)) {
    throw contractInvalid('need record.defaultAction must be a non-empty string or null');
  }
}

/** Need 记录 → AttentionItem 投影行对象（不落库）。kind=type，state=status（W13 可再扩展）。 */
export function toAttentionItem(record) {
  assertRecord(record);
  return {
    needId: record.id,
    ownerId: record.ownerId,
    kind: record.type,
    payload: { question: record.question },
    state: record.status,
    unknownFlag: record.defaultAction === null || record.defaultAction === undefined ? 1 : 0,
  };
}

const SELECT_ATTENTION = 'SELECT need_id, owner_id, kind, payload, state, unknown_flag, updated_at FROM w9_attention_items WHERE need_id = ? AND owner_id = ?';
const UPSERT_ATTENTION = `
  INSERT INTO w9_attention_items (need_id, owner_id, kind, payload, state, unknown_flag, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT (need_id, owner_id) DO UPDATE SET
    kind = excluded.kind,
    payload = excluded.payload,
    state = excluded.state,
    unknown_flag = excluded.unknown_flag,
    updated_at = excluded.updated_at
`;

/**
 * upsert 一行 AttentionItem（need_id+owner_id 唯一）。
 * updated_at 取 record.updatedAt ?? record.answeredAt ?? record.dueAt（确定性，不读 wall clock）。
 * 返回写入后的行对象，附带 changed 布尔（内容是否发生变化——expiry 用它做幂等）。
 */
export function syncAttentionItem(db, record) {
  if (!db || typeof db.prepare !== 'function') throw contractInvalid('db must be an open agentic database');
  assertRecord(record);
  const item = toAttentionItem(record);
  const updatedAt = record.updatedAt ?? record.answeredAt ?? record.dueAt;
  if (!nonEmptyString(updatedAt)) throw contractInvalid('attention updated_at must be a non-empty string');

  const previous = db.prepare(SELECT_ATTENTION).get(item.needId, item.ownerId);
  const payloadJson = JSON.stringify(item.payload);
  db.prepare(UPSERT_ATTENTION).run(
    item.needId, item.ownerId, item.kind, payloadJson, item.state, item.unknownFlag, updatedAt,
  );
  const changed = previous === undefined
    || previous.kind !== item.kind
    || previous.payload !== payloadJson
    || previous.state !== item.state
    || previous.unknown_flag !== item.unknownFlag;
  return { ...item, updatedAt, changed };
}

/**
 * 物化冻结 need.schema.json 对象：只保留 schema 字段（id/missionId/type/question/dueAt/
 * defaultAction/status + 可选 answer/answeredAt）。内部字段（ownerId/revision）不外泄。
 * defaultAction 为 NULL → CONTRACT_INVALID（契约张力③：无默认的 need 不物化，走 AttentionItem）。
 */
export function needView(record) {
  assertRecord(record);
  if (!nonEmptyString(record.missionId)) throw contractInvalid('need record.missionId must be a non-empty string');
  if (record.defaultAction === null || record.defaultAction === undefined) {
    throw contractInvalid('need without defaultAction cannot materialize a frozen Need object (attention projection only)');
  }
  const view = {
    id: record.id,
    missionId: record.missionId,
    type: record.type,
    question: record.question,
    dueAt: record.dueAt,
    defaultAction: record.defaultAction,
    status: record.status,
  };
  if (record.answer !== null && record.answer !== undefined) view.answer = record.answer;
  if (record.answeredAt !== null && record.answeredAt !== undefined) view.answeredAt = record.answeredAt;
  const result = validate(view, NEED_SCHEMA, { schemaDir: CONTRACT_DIR });
  if (!result.valid) {
    const failure = new Error(`CONTRACT_INVALID: ${result.errors.map((item) => `${item.path} ${item.message}`).join('; ')}`);
    failure.code = 'CONTRACT_INVALID';
    failure.errors = result.errors;
    throw failure;
  }
  return view;
}
