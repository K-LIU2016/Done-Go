// S2D-W2 run engine: durable checkpoints, bounded retry, pause/resume/cancel.
// Contract: BUILD-PLAN §3 W2-2; PRD §6.3 and §11.5; all external work is outbox-backed.
import { randomUUID } from 'node:crypto';
import { stepInputHash } from './hash.mjs';

const TERMINAL = new Set(['succeeded', 'partial', 'failed', 'unknown', 'cancelled']);
const json = (value, fallback = {}) => JSON.stringify(value ?? fallback);
const parse = (value, fallback = {}) => { try { return value == null ? fallback : JSON.parse(value); } catch { return fallback; } };
const nowValue = (now) => (typeof now === 'function' ? now() : new Date().toISOString());

export function overrunToOutcome(policy) {
  if (policy === 'deliver_best') return { status: 'partial', need: null };
  if (policy === 'ask_extend') return { status: 'paused', need: 'EXTEND_WINDOW' };
  if (policy === 'stop') return { status: 'cancelled', need: null };
  throw new Error(`INVALID_OVERRUN_POLICY:${policy}`);
}

export function createRunEngine({ db, policy = null, outbox = null, now = () => new Date().toISOString(), sleep = async () => {}, retryBaseMs = 100 } = {}) {
  if (!db) throw new TypeError('RUN_DB_REQUIRED');
  const get = (id) => db.prepare('SELECT * FROM runs WHERE id = ?').get(id);
  const touch = (id, status) => db.prepare('UPDATE runs SET status = ?, updated_at = ? WHERE id = ?').run(status, nowValue(now), id);
  const sumSpent = (runId) => {
    const rows = db.prepare("SELECT spent FROM run_steps WHERE run_id = ? AND status = 'done'").all(runId);
    const total = {};
    for (const row of rows) for (const [key, value] of Object.entries(parse(row.spent))) total[key] = (total[key] || 0) + (Number(value) || 0);
    return total;
  };
  const budgetExceeded = (run, extra = {}) => {
    const budget = parse(run.budget_snapshot);
    const spent = sumSpent(run.id);
    return Object.entries(extra).some(([key, value]) => Number(spent[key] || 0) + Number(value || 0) > Number(budget[key])) ||
      Object.entries(spent).some(([key, value]) => budget[key] != null && Number(value) > Number(budget[key]));
  };
  const markRunOutboxCancelled = (runId) => {
    if (outbox?.cancelRegistered) outbox.cancelRegistered(runId);
    else db.prepare("UPDATE outbox SET status='cancelled', updated_at=? WHERE run_id=? AND status='registered'").run(nowValue(now), runId);
  };
  const handle = (id) => {
    const status = () => get(id);
    const assertActive = () => {
      const row = get(id);
      if (row.status === 'cancelled') return 'RUN_CANCELLED';
      if (row.status === 'paused_pending_confirm') return 'RUN_PAUSED_PENDING_CONFIRM';
      if (row.status === 'paused') return 'RUN_PAUSED';
      if (TERMINAL.has(row.status)) return `RUN_${row.status.toUpperCase()}`;
      return null;
    };
    const step = async (name, input, fn) => {
      const blocked = assertActive();
      if (blocked) return { skipped: true, reason: blocked };
      const run = get(id);
      const inputHash = stepInputHash(input);
      let row = db.prepare('SELECT * FROM run_steps WHERE run_id = ? AND name = ?').get(id, name);
      if (row?.status === 'done' && row.input_hash === inputHash) return { skipped: true, result: parse(row.result), attempt: row.attempt };
      if (Object.entries(sumSpent(id)).some(([key, value]) => run.budget_snapshot && parse(run.budget_snapshot)[key] != null && Number(value) >= Number(parse(run.budget_snapshot)[key]))) {
        touch(id, 'paused');
        return { skipped: true, reason: 'BUDGET_EXHAUSTED' };
      }
      const seq = row?.seq ?? ((db.prepare('SELECT COALESCE(MAX(seq), 0) AS n FROM run_steps WHERE run_id = ?').get(id).n) + 1);
      const stepId = row?.id ?? randomUUID();
      db.prepare(`INSERT INTO run_steps(id, run_id, name, seq, input_hash, status, attempt, max_attempt, spent, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'running', 0, 3, '{}', ?, ?)
        ON CONFLICT(run_id, name) DO UPDATE SET input_hash=excluded.input_hash, status='running', result=NULL, error=NULL, spent='{}', updated_at=excluded.updated_at`).run(stepId, id, name, seq, inputHash, nowValue(now), nowValue(now));
      let attempt = 0;
      let lastError;
      const spent = {};
      const ctx = {
        db, runId: id, stepName: name,
        spend(cost = {}) { for (const [key, value] of Object.entries(cost)) spent[key] = (spent[key] || 0) + (Number(value) || 0); },
        registerAction(action) {
          if (!outbox) throw new Error('OUTBOX_REQUIRED');
          return outbox.register({ runId: id, stepId, ...action });
        },
      };
      while (attempt < 3) {
        attempt += 1;
        db.prepare('UPDATE run_steps SET attempt=?, updated_at=? WHERE id=?').run(attempt, nowValue(now), stepId);
        try {
          const result = await fn(ctx);
          if (budgetExceeded(run, spent)) {
            db.prepare("UPDATE run_steps SET status='failed', attempt=?, spent=?, error=?, updated_at=? WHERE id=?").run(attempt, json(spent), 'BUDGET_EXHAUSTED', nowValue(now), stepId);
            touch(id, 'paused');
            return { failed: true, reason: 'BUDGET_EXHAUSTED', attempt };
          }
          db.prepare("UPDATE run_steps SET status='done', result=?, attempt=?, spent=?, updated_at=? WHERE id=?").run(json(result, null), attempt, json(spent), nowValue(now), stepId);
          db.prepare("UPDATE runs SET status='running', spent=?, updated_at=? WHERE id=?").run(json(sumSpent(id)), nowValue(now), id);
          return { skipped: false, result, attempt };
        } catch (error) {
          lastError = error;
          if (attempt < 3) await sleep(retryBaseMs * (2 ** (attempt - 1)));
        }
      }
      const message = String(lastError?.stack || lastError?.message || lastError);
      db.prepare("UPDATE run_steps SET status='failed', error=?, attempt=?, spent=?, updated_at=? WHERE id=?").run(message, attempt, json(spent), nowValue(now), stepId);
      if (outbox) db.prepare("UPDATE outbox SET status='failed', updated_at=? WHERE run_id=? AND step_id=? AND status='registered'").run(nowValue(now), id, stepId);
      const hasDone = Boolean(db.prepare("SELECT 1 FROM run_steps WHERE run_id=? AND status='done' LIMIT 1").get(id));
      touch(id, hasDone ? 'partial' : 'failed');
      return { failed: true, attempt, error: message };
    };
    const pause = (reason = 'user') => { if (!TERMINAL.has(get(id).status)) { db.prepare("UPDATE runs SET status='paused', updated_at=? WHERE id=?").run(nowValue(now), id); return { paused: true, reason }; } return { paused: false }; };
    const resume = async ({ revalidate } = {}) => {
      const row = get(id);
      if (row.status === 'cancelled' || TERMINAL.has(row.status)) return { resumed: false, reason: 'RUN_TERMINAL' };
      if (!['paused', 'paused_pending_confirm'].includes(row.status)) return { resumed: false, reason: 'RUN_NOT_PAUSED' };
      const current = await (revalidate ? revalidate() : row.contract_hash);
      if (current !== row.contract_hash) { touch(id, 'paused_pending_confirm'); return { resumed: false, reason: 'CONTRACT_CHANGED' }; }
      touch(id, 'running');
      return { resumed: true };
    };
    const cancel = (reason = 'cancelled') => { if (!TERMINAL.has(get(id).status)) { touch(id, 'cancelled'); markRunOutboxCancelled(id); return { cancelled: true, reason }; } return { cancelled: false }; };
    const finish = async ({ dodMet }) => { const row = get(id); if (!TERMINAL.has(row.status)) touch(id, dodMet ? 'succeeded' : 'partial'); return { status: get(id).status }; };
    return { id, step, pause, resume, cancel, finish, status };
  };
  const startRun = ({ missionId, ownerId = null, contractHash, dod = [], budget = {} }) => {
    const id = randomUUID(); const timestamp = nowValue(now);
    db.prepare(`INSERT INTO runs(id, mission_id, owner_id, status, contract_hash, dod, budget_snapshot, spent, created_at, updated_at)
      VALUES (?, ?, ?, 'queued', ?, ?, ?, '{}', ?, ?)`).run(id, missionId, ownerId, contractHash, json(dod, []), json(budget), timestamp, timestamp);
    return handle(id);
  };
  return { startRun, attach: (id) => { if (!get(id)) throw new Error('RUN_NOT_FOUND'); return handle(id); }, getRun: get };
}
