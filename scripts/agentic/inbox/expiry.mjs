// W9 M3 inbox-domain · 逾期默认 sweep（plan §G1-M3-3，brief 裁决⑤）。
//
// createExpiry({ db, events? }) → { sweep(now) }
//   - now 为注入的 ISO 时刻（确定性时钟；实现与测试都不读真实 wall clock，红线6）。
//   - 只处理 status='open' 且 due_at <= now 的 need（时刻比较用 Date.parse，
//     对 +08:00 等偏移写法也正确；字符串字典序对混合偏移不可靠）：
//       default_action 显式存在 → 'defaulted'，answered_at=now（首次 sweep 的时间为准）；
//       default_action 为 NULL   → 保持 'open'，attention 行 unknown_flag=1（继续等待，
//                                 绝不 defaulted/expired——无默认不给任何默认动作）。
//   - 返回 { defaulted, waiting }，只此两个键；幂等：无变化不迁移、不追加事件。
//   - 不发邮件/不推送/不改日历，无任何外部副作用（红线3）。
import { randomUUID } from 'node:crypto';
import { isIsoDateTime, appendNeedEvent, recordFromRow } from './need-store.mjs';
import { syncAttentionItem } from './attention-projection.mjs';

const SELECT_OPEN = 'SELECT id, owner_id, mission_id, type, question, due_at, default_action, status, answer, answered_at, revision FROM w9_needs WHERE status = ?';
const UPDATE_DEFAULTED = "UPDATE w9_needs SET status = 'defaulted', answered_at = ? WHERE id = ? AND owner_id = ? AND status = 'open'";

const NOOP_EVENTS = { emit() {} };

function invalid(message) {
  const error = new Error(`CONTRACT_INVALID: ${message}`);
  error.code = 'CONTRACT_INVALID';
  return error;
}

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

export function createExpiry({ db, events } = {}) {
  if (!db || typeof db.prepare !== 'function') throw invalid('db must be an open agentic database');
  const sink = events === undefined || events === null ? NOOP_EVENTS : events;
  if (typeof sink.emit !== 'function') throw invalid('events.emit must be a function when events is provided');

  return {
    async sweep(now) {
      if (!isIsoDateTime(now)) throw invalid('sweep(now) requires an ISO date-time string');
      const sweepAt = Date.parse(now);

      let defaulted = 0;
      let waiting = 0;
      const open = db.prepare(SELECT_OPEN).all('open');
      for (const row of open) {
        if (!(Date.parse(row.due_at) <= sweepAt)) continue; // due_at <= now 才算逾期（含相等边界）
        const record = recordFromRow(row);

        if (record.defaultAction !== null) {
          const migrated = withTransaction(db, () => {
            const result = db.prepare(UPDATE_DEFAULTED).run(now, record.id, record.ownerId);
            if (result.changes !== 1) return false; // 并发下已迁移：不计入本次
            const defaultedRecord = { ...record, status: 'defaulted', answeredAt: now };
            appendNeedEvent(db, randomUUID(), defaultedRecord, 'need.defaulted', { defaultAction: record.defaultAction, at: now }, now);
            syncAttentionItem(db, { ...defaultedRecord, updatedAt: now });
            sink.emit({
              type: 'need.defaulted',
              ownerId: record.ownerId,
              objectType: 'need',
              objectId: record.id,
              at: now,
              data: { defaultAction: record.defaultAction },
            });
            return true;
          });
          if (migrated) defaulted += 1;
        } else {
          // 无默认：保持 open、attention unknown_flag=1 继续等待；行未变化则完全无副作用（幂等）。
          const synced = syncAttentionItem(db, { ...record, updatedAt: now });
          if (synced.changed) {
            appendNeedEvent(db, randomUUID(), record, 'need.overdue_waiting', { reason: 'no default action', at: now }, now);
            sink.emit({
              type: 'need.overdue_waiting',
              ownerId: record.ownerId,
              objectType: 'need',
              objectId: record.id,
              at: now,
              data: { reason: 'no default action' },
            });
          }
          waiting += 1;
        }
      }
      return { defaulted, waiting };
    },
  };
}
