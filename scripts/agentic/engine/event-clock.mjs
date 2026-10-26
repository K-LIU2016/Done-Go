// S2D-W2 event clock: durable, catch-up timers with injectable Asia/Shanghai time.
// 依据：BUILD-PLAN §3 W2-1；PRD §4.1/§4.2（时间对象带 IANA 时区）。
import { randomUUID } from 'node:crypto';

const SHANGHAI_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?\+08:00$/;

function parseIso(value, field) {
  if (typeof value !== 'string' || !SHANGHAI_ISO.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new TypeError(`${field}_MUST_BE_SHANGHAI_ISO`);
  }
  return Date.parse(value);
}

function parseEvent(row) {
  return {
    ...row,
    ownerId: row.owner_id ?? null,
    dedupKey: row.dedup_key ?? null,
    runAt: row.run_at,
    event: JSON.parse(row.event),
    late: Number(row.late),
    lateMs: Number(row.late_ms),
    createdAt: row.created_at,
    firedAt: row.fired_at ?? null,
  };
}

export function shanghaiNow(date = new Date()) {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Shanghai', hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).format(date).replace(' ', 'T') + '+08:00';
}

export function createEventClock({ db, now = shanghaiNow } = {}) {
  if (!db || typeof db.prepare !== 'function') throw new TypeError('EVENT_CLOCK_DB_REQUIRED');
  if (typeof now !== 'function') throw new TypeError('EVENT_CLOCK_NOW_REQUIRED');
  const current = () => { const value = now(); parseIso(value, 'NOW'); return value; };

  const schedule = (at, event, { dedupKey = null, ownerId = null } = {}) => {
    parseIso(at, 'RUN_AT');
    const createdAt = current();
    if (event === undefined) throw new TypeError('EVENT_REQUIRED');
    const eventJson = JSON.stringify(event);
    if (eventJson === undefined) throw new TypeError('EVENT_MUST_BE_JSON');
    if (dedupKey !== null && typeof dedupKey !== 'string') throw new TypeError('DEDUP_KEY_MUST_BE_STRING');
    const id = randomUUID();
    db.prepare(`INSERT OR IGNORE INTO event_timers(id,owner_id,dedup_key,run_at,event,status,late,late_ms,created_at)
      VALUES(?,?,?,?,?,'scheduled',0,0,?)`).run(id, ownerId, dedupKey, at, eventJson, createdAt);
    if (dedupKey !== null) {
      return db.prepare('SELECT id FROM event_timers WHERE dedup_key=?').get(dedupKey).id;
    }
    return id;
  };

  const cancel = (id) => {
    const result = db.prepare("UPDATE event_timers SET status='cancelled' WHERE id=? AND status='scheduled'").run(id);
    return { cancelled: result.changes > 0 };
  };

  const list = ({ from, to, all = false } = {}) => {
    const sql = ['SELECT * FROM event_timers']; const args = []; const where = [];
    if (!all && from !== undefined) { parseIso(from, 'FROM'); where.push('run_at >= ?'); args.push(from); }
    if (!all && to !== undefined) { parseIso(to, 'TO'); where.push('run_at <= ?'); args.push(to); }
    if (where.length) sql.push(`WHERE ${where.join(' AND ')}`);
    sql.push('ORDER BY run_at, id');
    return db.prepare(sql.join(' ')).all(...args).map(parseEvent);
  };

  const tick = () => {
    const currentAt = current(); const currentMs = parseIso(currentAt, 'NOW');
    const due = db.prepare("SELECT * FROM event_timers WHERE status='scheduled' AND run_at <= ? ORDER BY run_at, id").all(currentAt);
    const fired = [];
    for (const row of due) {
      const lateMs = Math.max(0, currentMs - parseIso(row.run_at, 'RUN_AT'));
      const late = lateMs > 0 ? 1 : 0;
      const result = db.prepare("UPDATE event_timers SET status='fired', late=?, late_ms=?, fired_at=? WHERE id=? AND status='scheduled'").run(late, lateMs, currentAt, row.id);
      if (result.changes > 0) fired.push(parseEvent({ ...row, status: 'fired', late, late_ms: lateMs, fired_at: currentAt }));
    }
    return fired;
  };
  return { schedule, cancel, list, tick };
}

// Fixed +08:00 is the Asia/Shanghai civil-time assumption (China has no DST).
