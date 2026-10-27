// W7 M2 · runtime-store — A4 agent runtime 的持久层。
//
// 职责（plan.md M2 / brief 裁决⑥）：
//   * owner 过滤：跨 owner 读写一律 NOT_FOUND/null，不泄露存在性；
//   * 幂等：WorkOrder/WorkResult 按 (owner_id, idempotency_key|order_id) 同载重放、异载 CONFLICT；
//   * 乐观锁：WorkOrder.revision 旧值写入 → CONFLICT；
//   * 检查点：step 同 id + 同 inputHash → 检查点重放（replayed:true）而非重执行；inputHash 变化 → 服务端
//     递增 attempt 记新一次执行；state 跃迁表拒绝非法回退（终态不可再跃迁）；
//   * UNKNOWN 台账：w7_unknown_outcomes 只记账对账，本模块不提供任何重试/出队入口。
//
// step.state 枚举直接取自冻结 step.schema.json（无 unknown；UNKNOWN 是 run 级语义，见 plan.md mismatch #1）。
// 时间戳仅为簿记列：createRuntimeStore({ now }) 可注入，缺省用真实时钟；预算窗口/expiry 判定不在本层
// （归 M3 engine 的注入 clock）。
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertValid, canonicalJson, loadSchema } from '../contracts.mjs';

const DEFAULT_SCHEMA_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../../contracts/agentic');

// 合法跃迁表：非终态允许自跃迁（刷新 checkpoint）与前进；succeeded/failed/skipped 为终态，不可跃迁。
// 覆盖 plan.md 的 pending → running → succeeded|failed（+ paused 检查点）与"暂停/恢复只能从检查点继续"。
const STEP_TRANSITIONS = {
  pending: new Set(['pending', 'running', 'paused', 'skipped']),
  running: new Set(['running', 'succeeded', 'failed', 'paused']),
  paused: new Set(['paused', 'running', 'succeeded', 'failed']),
  succeeded: new Set(),
  failed: new Set(),
  skipped: new Set(),
};

export function createRuntimeStore(options = {}) {
  const { db } = options;
  if (!db || typeof db.prepare !== 'function') {
    throw new Error('runtime-store: an agentic db handle is required (openAgenticDb + migrate)');
  }
  const schemaDir = options.schemaDir || DEFAULT_SCHEMA_DIR;
  const now = typeof options.now === 'function' ? options.now : () => new Date().toISOString();

  const workOrderSchema = loadSchema('work-order.schema.json', schemaDir);
  const workResultSchema = loadSchema('work-result.schema.json', schemaDir);
  const stepSchema = loadSchema('step.schema.json', schemaDir);
  const stepStates = new Set(stepSchema.properties.state.enum);
  for (const from of Object.keys(STEP_TRANSITIONS)) {
    if (!stepStates.has(from)) {
      throw new Error(`runtime-store: transition table drifted from frozen step.schema.json (${from})`);
    }
  }

  function fail(code, message) {
    const error = new Error(message);
    error.code = code;
    throw error;
  }

  function requireString(value, label) {
    if (typeof value !== 'string' || value.length === 0) {
      fail('CONTRACT_INVALID', `${label} must be a non-empty string`);
    }
    return value;
  }

  function payloadHash(value) {
    return createHash('sha256').update(canonicalJson(value)).digest('hex');
  }

  function workOrderEnvelope(row) {
    return {
      ...JSON.parse(row.work_order),
      ownerId: row.owner_id,
      idempotencyKey: row.idempotency_key,
      revision: row.revision,
    };
  }

  // ---------------- work orders ----------------

  function saveWorkOrder({ ownerId, workOrder, idempotencyKey }) {
    requireString(ownerId, 'ownerId');
    requireString(idempotencyKey, 'idempotencyKey');
    assertValid(workOrder, workOrderSchema, { schemaDir });
    const hash = payloadHash(workOrder);

    const byKey = db
      .prepare('SELECT * FROM w7_work_orders WHERE owner_id = ? AND idempotency_key = ?')
      .get(ownerId, idempotencyKey);
    if (byKey) {
      // 幂等指纹绑定在首次创建请求上：同 key 同载重放，同 key 异载拒绝（原行不动）。
      if (byKey.payload_hash === hash) {
        return { record: workOrderEnvelope(byKey), replayed: true };
      }
      fail('CONFLICT', `idempotency key already bound to a different work order payload (${byKey.id})`);
    }
    const byId = db
      .prepare('SELECT id FROM w7_work_orders WHERE owner_id = ? AND id = ?')
      .get(ownerId, workOrder.id);
    if (byId) {
      fail('CONFLICT', `work order id already exists for this owner; use updateWorkOrder (${workOrder.id})`);
    }
    const ts = now();
    db.prepare(
      `INSERT INTO w7_work_orders
         (owner_id, id, idempotency_key, payload_hash, revision, work_order, created_at, updated_at)
       VALUES (?, ?, ?, ?, 1, ?, ?, ?)`,
    ).run(ownerId, workOrder.id, idempotencyKey, hash, JSON.stringify(workOrder), ts, ts);
    return { record: { ...workOrder, ownerId, idempotencyKey, revision: 1 }, replayed: false };
  }

  function getWorkOrder({ ownerId, orderId }) {
    requireString(ownerId, 'ownerId');
    requireString(orderId, 'orderId');
    const row = db
      .prepare('SELECT * FROM w7_work_orders WHERE owner_id = ? AND id = ?')
      .get(ownerId, orderId);
    return row ? workOrderEnvelope(row) : null;
  }

  function updateWorkOrder({ ownerId, orderId, expectedRevision, workOrder }) {
    requireString(ownerId, 'ownerId');
    requireString(orderId, 'orderId');
    assertValid(workOrder, workOrderSchema, { schemaDir });
    if (workOrder.id !== orderId) {
      fail('CONTRACT_INVALID', `workOrder.id (${workOrder.id}) must match orderId (${orderId})`);
    }
    if (!Number.isInteger(expectedRevision) || expectedRevision < 1) {
      fail('CONTRACT_INVALID', 'expectedRevision must be a positive integer');
    }
    const row = db
      .prepare('SELECT * FROM w7_work_orders WHERE owner_id = ? AND id = ?')
      .get(ownerId, orderId);
    if (!row) {
      fail('NOT_FOUND', `work order not found for this owner (${orderId})`);
    }
    if (row.revision !== expectedRevision) {
      fail('CONFLICT', `stale revision for ${orderId}: current ${row.revision}, got ${expectedRevision}`);
    }
    const nextRevision = expectedRevision + 1;
    db.prepare(
      'UPDATE w7_work_orders SET work_order = ?, revision = ?, updated_at = ? WHERE owner_id = ? AND id = ?',
    ).run(JSON.stringify(workOrder), nextRevision, now(), ownerId, orderId);
    return {
      record: { ...workOrder, ownerId, idempotencyKey: row.idempotency_key, revision: nextRevision },
    };
  }

  // ---------------- work results ----------------

  function saveWorkResult({ ownerId, result }) {
    requireString(ownerId, 'ownerId');
    assertValid(result, workResultSchema, { schemaDir });
    const orderId = result.orderId;
    const order = db
      .prepare('SELECT id FROM w7_work_orders WHERE owner_id = ? AND id = ?')
      .get(ownerId, orderId);
    if (!order) {
      fail('NOT_FOUND', `work order not found for this owner (${orderId})`);
    }
    const hash = payloadHash(result);
    const existing = db
      .prepare('SELECT * FROM w7_work_results WHERE owner_id = ? AND order_id = ?')
      .get(ownerId, orderId);
    if (existing) {
      if (existing.payload_hash === hash) {
        return { record: JSON.parse(existing.result), replayed: true };
      }
      fail('CONFLICT', `work result for ${orderId} already exists with a different payload`);
    }
    const ts = now();
    db.prepare(
      `INSERT INTO w7_work_results
         (owner_id, order_id, payload_hash, result, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(ownerId, orderId, hash, JSON.stringify(result), ts, ts);
    return { record: result, replayed: false };
  }

  function getWorkResult({ ownerId, orderId }) {
    requireString(ownerId, 'ownerId');
    requireString(orderId, 'orderId');
    const row = db
      .prepare('SELECT result FROM w7_work_results WHERE owner_id = ? AND order_id = ?')
      .get(ownerId, orderId);
    return row ? JSON.parse(row.result) : null;
  }

  // ---------------- agent steps（pending → running → succeeded|failed，+paused 检查点） ----------------

  function stepRow(ownerId, stepId) {
    return db
      .prepare('SELECT * FROM w7_agent_steps WHERE owner_id = ? AND id = ?')
      .get(ownerId, stepId);
  }

  function recordStep({ ownerId, step }) {
    requireString(ownerId, 'ownerId');
    assertValid(step, stepSchema, { schemaDir });
    const inputHash = step.inputHash ?? null;
    const existing = stepRow(ownerId, step.id);
    if (existing) {
      // 执行身份 = (id, inputHash)：同 inputHash 重放既有检查点；inputHash 变化才是新一次执行（attempt+1，服务端权威）。
      if (existing.input_hash === inputHash) {
        return { record: JSON.parse(existing.payload), replayed: true };
      }
      const next = { ...step, attempt: Number(existing.attempt) + 1 };
      assertValid(next, stepSchema, { schemaDir });
      db.prepare(
        `UPDATE w7_agent_steps
           SET run_id = ?, state = ?, attempt = ?, input_hash = ?, checkpoint = ?, payload = ?, updated_at = ?
         WHERE owner_id = ? AND id = ?`,
      ).run(next.runId, next.state, next.attempt, inputHash, next.checkpoint ?? null, JSON.stringify(next), now(), ownerId, next.id);
      return { record: next, replayed: false };
    }
    const ts = now();
    db.prepare(
      `INSERT INTO w7_agent_steps
         (owner_id, id, run_id, state, attempt, input_hash, checkpoint, payload, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(ownerId, step.id, step.runId, step.state, step.attempt, inputHash, step.checkpoint ?? null, JSON.stringify(step), ts, ts);
    return { record: step, replayed: false };
  }

  function updateStepState({ ownerId, stepId, state, checkpoint, attempt }) {
    requireString(ownerId, 'ownerId');
    requireString(stepId, 'stepId');
    if (!stepStates.has(state)) {
      fail(
        'CONTRACT_INVALID',
        `step state must be one of frozen step.schema.json enum (${[...stepStates].join('/')}); got ${String(state)}`,
      );
    }
    const row = stepRow(ownerId, stepId);
    if (!row) {
      fail('NOT_FOUND', `step not found for this owner (${stepId})`);
    }
    if (!STEP_TRANSITIONS[row.state].has(state)) {
      fail('CONFLICT', `illegal step transition ${row.state} -> ${state} (${stepId})`);
    }
    const next = { ...JSON.parse(row.payload), state };
    if (checkpoint !== undefined) next.checkpoint = checkpoint;
    if (attempt !== undefined) next.attempt = attempt;
    assertValid(next, stepSchema, { schemaDir });
    db.prepare(
      'UPDATE w7_agent_steps SET state = ?, attempt = ?, checkpoint = ?, payload = ?, updated_at = ? WHERE owner_id = ? AND id = ?',
    ).run(next.state, next.attempt, next.checkpoint ?? null, JSON.stringify(next), now(), ownerId, stepId);
    return { record: next };
  }

  function listSteps({ ownerId, runId }) {
    requireString(ownerId, 'ownerId');
    requireString(runId, 'runId');
    return db
      .prepare('SELECT payload FROM w7_agent_steps WHERE owner_id = ? AND run_id = ? ORDER BY created_at, id')
      .all(ownerId, runId)
      .map(row => JSON.parse(row.payload));
  }

  // ---------------- unknown outcomes 台账（只对账、不自动重试） ----------------

  function recordUnknownOutcome({ ownerId, runId, stepId, source, detail }) {
    requireString(ownerId, 'ownerId');
    requireString(runId, 'runId');
    if (stepId !== undefined && stepId !== null) requireString(stepId, 'stepId');
    requireString(source, 'source');
    requireString(detail, 'detail');
    const ts = now();
    const inserted = db
      .prepare(
        `INSERT INTO w7_unknown_outcomes
           (owner_id, run_id, step_id, source, detail, status, recorded_at)
         VALUES (?, ?, ?, ?, ?, 'unknown', ?)`,
      )
      .run(ownerId, runId, stepId ?? null, source, detail, ts);
    return {
      record: {
        id: Number(inserted.lastInsertRowid),
        ownerId,
        runId,
        stepId: stepId ?? null,
        source,
        detail,
        status: 'unknown',
        recordedAt: ts,
      },
    };
  }

  function listUnknownOutcomes({ ownerId }) {
    requireString(ownerId, 'ownerId');
    return db
      .prepare('SELECT * FROM w7_unknown_outcomes WHERE owner_id = ? ORDER BY id')
      .all(ownerId)
      .map(row => ({
        id: row.id,
        ownerId: row.owner_id,
        runId: row.run_id,
        stepId: row.step_id,
        source: row.source,
        detail: row.detail,
        status: row.status,
        recordedAt: row.recorded_at,
      }));
  }

  return {
    saveWorkOrder,
    getWorkOrder,
    updateWorkOrder,
    saveWorkResult,
    getWorkResult,
    recordStep,
    updateStepState,
    listSteps,
    recordUnknownOutcome,
    listUnknownOutcomes,
  };
}
