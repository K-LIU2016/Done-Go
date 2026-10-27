// S2D-W2 M5 outbox: durable external actions are registered before dispatch.
// V3-20 stable IDs, V3-21 read-back verification, V3-22 unknown reconciliation.
import { randomUUID } from 'node:crypto';

const json = (value) => JSON.stringify(value === undefined ? null : value);
const parse = (value, fallback = null) => {
  if (value === null || value === undefined) return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
};

function shanghaiNow() {
  const shifted = new Date(Date.now() + 8 * 3600_000);
  return `${shifted.toISOString().slice(0, 19)}+08:00`;
}

export function createOutbox(options = {}) {
  const db = options?.db ?? options;
  if (!db?.prepare) throw new TypeError('OUTBOX_DB_REQUIRED');
  const now = options?.now ?? shanghaiNow;
  const getRaw = (id) => db.prepare('SELECT * FROM outbox WHERE id=?').get(id);
  const get = (id) => getRaw(id);
  const decode = (row) => row ? { ...row, payload: parse(row.payload, {}), receipt: parse(row.receipt) } : null;
  const save = (id, status, fields = {}) => {
    const sets = ['status=?', 'updated_at=?'];
    const values = [status, now()];
    for (const [key, value] of Object.entries(fields)) { sets.push(`${key}=?`); values.push(value); }
    values.push(id);
    db.prepare(`UPDATE outbox SET ${sets.join(', ')} WHERE id=?`).run(...values);
    return getRaw(id);
  };
  const isCancelledRun = (runId) => runId && db.prepare('SELECT status FROM runs WHERE id=?').get(runId)?.status === 'cancelled';

  const register = ({ runId = null, stepId = null, actionKey, payload }) => {
    if (!actionKey || typeof actionKey !== 'string') throw new TypeError('ACTION_KEY_REQUIRED');
    const existing = db.prepare('SELECT * FROM outbox WHERE action_key=?').get(actionKey);
    if (existing) return existing;
    const id = randomUUID();
    db.prepare(`INSERT INTO outbox(id,run_id,step_id,action_key,payload,status,external_id,attempts,manual,updated_at)
      VALUES(?,?,?,?,?,'registered',?,0,0,?)`)
      .run(id, runId, stepId, actionKey, json(payload), actionKey, now());
    return getRaw(id);
  };

  const listByStatus = (status) => db.prepare('SELECT * FROM outbox WHERE status=? ORDER BY updated_at,id').all(status);

  const dispatch = async (entry, { send, verify } = {}) => {
    let current = getRaw(entry?.id ?? entry?.id);
    if (!current) return { dispatched: false, reason: 'NOT_FOUND', status: null };
    if (isCancelledRun(current.run_id)) {
      current = save(current.id, 'cancelled');
      return { dispatched: false, reason: 'RUN_CANCELLED', status: current.status };
    }
    if (current.status !== 'registered' && current.status !== 'failed') {
      return { dispatched: false, reason: 'NOT_REGISTERED', status: current.status };
    }
    if (typeof send !== 'function') throw new TypeError('OUTBOX_SEND_REQUIRED');
    current = save(current.id, 'dispatched', { attempts: current.attempts + 1 });
    let sent;
    try {
      sent = await send(parse(current.payload, {}));
    } catch (error) {
      if (error?.preSend === true) {
        const failed = save(current.id, 'failed', { receipt: null });
        return { dispatched: false, status: failed.status, attempts: failed.attempts, error };
      }
      const unknown = save(current.id, 'unknown');
      return { dispatched: true, status: unknown.status, attempts: unknown.attempts, externalId: unknown.external_id, error };
    }
    const externalId = sent?.externalId ?? current.external_id;
    const sentReceipt = sent?.receipt === undefined ? null : json(sent.receipt);
    const fields = { external_id: externalId, receipt: sentReceipt };
    save(current.id, 'dispatched', fields);
    if (typeof verify !== 'function') {
      const unknown = save(current.id, 'unknown');
      return { dispatched: true, status: unknown.status, attempts: unknown.attempts };
    }
    try {
      const checked = await verify({ externalId, payload: parse(current.payload, {}), sendResult: sent, receipt: sent?.receipt ?? null });
      if (checked?.ok === true) {
        const verified = save(current.id, 'verified', { receipt: json(checked.receipt ?? checked.fields ?? sent?.receipt ?? null) });
        return { dispatched: true, status: verified.status, attempts: verified.attempts, receipt: parse(verified.receipt) };
      }
    } catch (error) {
      const unknown = save(current.id, 'unknown', fields);
      return { dispatched: true, status: unknown.status, attempts: unknown.attempts, error };
    }
    const unknown = save(current.id, 'unknown', fields);
    return { dispatched: true, status: unknown.status, attempts: unknown.attempts };
  };

  const reconcile = async (entry, { probe } = {}) => {
    const current = getRaw(entry?.id) ?? entry;
    if (!current) return { status: 'unknown', reason: 'NOT_FOUND' };
    if (!['unknown', 'dispatched'].includes(current.status)) return current;
    if (typeof probe !== 'function') throw new TypeError('OUTBOX_PROBE_REQUIRED');
    let result;
    try {
      result = await probe({ externalId: current.external_id, actionKey: current.action_key, payload: parse(current.payload, {}) });
    } catch { result = { status: 'unknown' }; }
    if (result?.status === 'verified') return save(current.id, 'verified', { receipt: result.receipt ? json(result.receipt) : null, manual: 0 });
    if (result?.status === 'failed') return save(current.id, 'failed', { receipt: result.receipt ? json(result.receipt) : null, manual: 0 });
    return save(current.id, 'unknown', { manual: 1 });
  };

  const recover = async ({ send, verify, probe } = {}) => {
    const stats = { dispatched: 0, verified: 0, reconciled: 0 };
    for (const entry of listByStatus('registered')) {
      const result = await dispatch(entry, { send, verify });
      if (result.dispatched) stats.dispatched += 1;
      if (result.status === 'verified') stats.verified += 1;
    }
    for (const entry of listByStatus('dispatched')) {
      const current = getRaw(entry.id);
      if (typeof verify !== 'function') continue;
      try {
        const result = await verify({ externalId: current.external_id, payload: parse(current.payload, {}), receipt: parse(current.receipt) });
        if (result?.ok === true) {
          save(current.id, 'verified', { receipt: json(result.receipt ?? result.fields ?? parse(current.receipt)) });
          stats.verified += 1;
        } else save(current.id, 'unknown');
      } catch { save(current.id, 'unknown'); }
    }
    for (const entry of listByStatus('unknown')) {
      const result = await reconcile(entry, { probe });
      if (result.status !== 'unknown') stats.reconciled += 1;
      if (result.status === 'verified') stats.verified += 1;
    }
    return stats;
  };

  const cancelRegistered = (runId) => db.prepare("UPDATE outbox SET status='cancelled', updated_at=? WHERE run_id=? AND status='registered'").run(now(), runId);
  return { register, dispatch, reconcile, recover, get, listByStatus, cancelRegistered };
}
