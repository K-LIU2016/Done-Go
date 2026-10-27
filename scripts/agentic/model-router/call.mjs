// W7 M5 · model-router-call — 选型台账 + completion 服务（call.mjs）
//
// 依据：.s2d/plan.md M5；brief 裁决④。
//   * complete(taskClass, messages, { dataClass, actor, ownerId, budget, localAvailable })
//     = router 选择（注入的 select port，鸭子类型同 M4 selectModel：
//       complete 把 opts.localAvailable 原样透传，并由注入 clock 派生 now
//       （ISO-8601）一并传给 select——M4 selectModel 要求这两项必填，
//       因此 `select: selectModel` 可直接接线，无需适配层）
//     → 记账（w7_model_selections）→ transport 调用（注入，绝不联网）。
//   * 结果必须带模型来源：resolvedModel = response.model || selection.model；
//     双方都无 → 只能 UNKNOWN（{ ok:false, reason:'no-model-source' }，
//     台账 model=NULL status='unknown'），绝不生成成功结果（brief 红线⑦：
//     actor 显式绑定模型，无 resolved model ≠ 完成）。
//   * timeout → UPSTREAM_UNAVAILABLE、403 → FORBIDDEN：transport 结构化上抛，
//     服务先记台账（status='failed'，保留尝试过的 model 供审计）再原样上抛，不吞。
//   * secret dataClass：纵深防御（独立于 M4 router 的规则表）——选型与 transport
//     之前直接拒（FORBIDDEN，台账 status='rejected'，transport 零调用）。
//   * 预算：budget.calls<=0（或 tokens<=0）→ BUDGET_EXCEEDED，不选型不调用。
//   * 时钟（红线⑥）：clock 必须注入（now() → epoch ms），台账 recorded_at 由
//     注入时钟派生；ledger 直用时可选注入 now（缺省真实时钟，仅簿记列，
//     同 M2 store 约定——预算/expiry 判定不在本层）。
//
// 错误码全部落在冻结 api-error.schema.json 的 error.code 枚举内；message
// 不携带 key/Authorization/cookie/响应正文。本模块属 G2，不 import G1/G3 文件。

const LEDGER_STATUSES = new Set(['selected', 'unknown', 'failed', 'rejected']);
const SERVICE_CODES = new Set(['FORBIDDEN', 'BUDGET_EXCEEDED', 'CONTRACT_INVALID']);

function fail(code, message, extra) {
  if (!SERVICE_CODES.has(code)) {
    throw new TypeError(`invalid call.mjs error code ${String(code)}`);
  }
  const error = new Error(message);
  error.code = code;
  if (extra !== undefined) Object.assign(error, extra);
  return error;
}

function isFunction(value) {
  return typeof value === 'function';
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireNonEmptyString(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw fail('CONTRACT_INVALID', `${label} must be a non-empty string (got ${value === null ? 'null' : typeof value})`);
  }
  return value;
}

// ---------------- 台账（w7_model_selections） ----------------

/**
 * createSelectionLedger({ db, now? }) → { record(entry), list({ ownerId }) }
 *
 * owner 过滤：list 只返回该 owner 的行（跨 owner 行不可见，不泄露存在性）。
 * record：model 接受非空字符串或 null（'' 归一为 null = UNKNOWN）；
 * provenance 接受对象或 null，落库为 JSON；status 枚举见迁移文件头注。
 */
export function createSelectionLedger(options = {}) {
  const { db } = options ?? {};
  if (!db || !isFunction(db.prepare)) {
    throw new Error('model-router ledger: an agentic db handle is required (openAgenticDb + migrate)');
  }
  // 仅簿记列的时间来源；确定性场景由 service 传入 recordedAt（注入时钟派生）。
  const now = isFunction(options.now) ? options.now : () => new Date().toISOString();

  function record(entry) {
    if (!isPlainObject(entry)) {
      throw fail('CONTRACT_INVALID', `ledger.record requires an entry object (got ${Array.isArray(entry) ? 'array' : typeof entry})`);
    }
    const ownerId = requireNonEmptyString(entry.ownerId, 'entry.ownerId');
    const actor = requireNonEmptyString(entry.actor, 'entry.actor');
    const taskClass = requireNonEmptyString(entry.taskClass, 'entry.taskClass');
    const dataClass = requireNonEmptyString(entry.dataClass, 'entry.dataClass');
    if (!LEDGER_STATUSES.has(entry.status)) {
      throw fail(
        'CONTRACT_INVALID',
        `entry.status must be one of ${[...LEDGER_STATUSES].join('/')}; got ${String(entry.status)}`,
      );
    }
    let model = entry.model ?? null;
    if (model !== null) {
      if (typeof model !== 'string') {
        throw fail('CONTRACT_INVALID', `entry.model must be a string or null (got ${typeof model})`);
      }
      model = model.length > 0 ? model : null; // '' = 无模型来源 = UNKNOWN
    }
    const provenance = entry.provenance ?? null;
    if (provenance !== null && !isPlainObject(provenance)) {
      throw fail('CONTRACT_INVALID', 'entry.provenance must be an object or null');
    }
    const recordedAt = typeof entry.recordedAt === 'string' && entry.recordedAt.length > 0
      ? entry.recordedAt
      : now();
    const inserted = db
      .prepare(
        `INSERT INTO w7_model_selections
           (owner_id, actor, task_class, data_class, model, provenance, status, recorded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(ownerId, actor, taskClass, dataClass, model, provenance === null ? null : JSON.stringify(provenance), entry.status, recordedAt);
    return {
      record: {
        id: Number(inserted.lastInsertRowid),
        ownerId, actor, taskClass, dataClass, model, provenance, status: entry.status, recordedAt,
      },
    };
  }

  function list({ ownerId }) {
    requireNonEmptyString(ownerId, 'ownerId');
    return db
      .prepare('SELECT * FROM w7_model_selections WHERE owner_id = ? ORDER BY id')
      .all(ownerId)
      .map(row => ({
        id: row.id,
        ownerId: row.owner_id,
        actor: row.actor,
        taskClass: row.task_class,
        dataClass: row.data_class,
        model: row.model,
        provenance: row.provenance === null ? null : JSON.parse(row.provenance),
        status: row.status,
        recordedAt: row.recorded_at,
      }));
  }

  return { record, list };
}

// ---------------- completion 服务 ----------------

function firstNonEmptyModel(...candidates) {
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.length > 0) return candidate;
  }
  return null;
}

/**
 * createCompletionService({ select, transport, ledger, clock })
 *
 * - select：注入的选型 port（M4 selectModel 的鸭子类型，可直接 `select: selectModel`）：
 *     (taskClass, dataClass, { actor, ownerId, budget, localAvailable, now })
 *     → { status:'selected'|'unknown', model?, provider?, locality?, provenance, reason }
 *     complete 把 opts.localAvailable 原样透传（缺失/非 boolean 由 select 端 fail-closed
 *     拒绝——本地可用性不允许猜测），now 由注入 clock 派生（new Date(clock.now()).toISOString()）。
 * - transport：createChatTransport 产物（{ chat(payload) }）；key 已封在 transport 内。
 * - ledger：createSelectionLedger 产物。
 * - clock：{ now() → epoch ms }，必注入（红线⑥）。
 */
export function createCompletionService(options = {}) {
  const { select, transport, ledger, clock } = options ?? {};
  if (!isFunction(select)) {
    throw fail('CONTRACT_INVALID', `select must be an injected model-selection port function (got ${select === null ? 'null' : typeof select})`);
  }
  if (!isPlainObject(transport) || !isFunction(transport.chat)) {
    throw fail('CONTRACT_INVALID', 'transport must be an injected object with a chat(payload) function (createChatTransport)');
  }
  if (!isPlainObject(ledger) || !isFunction(ledger.record)) {
    throw fail('CONTRACT_INVALID', 'ledger must be an injected object with a record(entry) function (createSelectionLedger)');
  }
  if (!isPlainObject(clock) || !isFunction(clock.now)) {
    throw fail('CONTRACT_INVALID', 'clock must be injected with a now() function returning epoch ms (deterministic time only)');
  }

  async function complete(taskClass, messages, opts = {}) {
    requireNonEmptyString(taskClass, 'taskClass');
    if (!Array.isArray(messages) || messages.length === 0) {
      throw fail('CONTRACT_INVALID', `messages must be a non-empty array (got ${Array.isArray(messages) ? 'empty' : typeof messages})`);
    }
    if (!isPlainObject(opts)) {
      throw fail('CONTRACT_INVALID', `options must be an object (got ${Array.isArray(opts) ? 'array' : typeof opts})`);
    }
    const actor = requireNonEmptyString(opts.actor, 'opts.actor');
    const ownerId = requireNonEmptyString(opts.ownerId, 'opts.ownerId');
    const dataClass = requireNonEmptyString(opts.dataClass, 'opts.dataClass');
    const budget = opts.budget;
    // 本地可用性只透传不猜测（M4 selectModel 要求显式 boolean；缺失由 select 端
    // fail-closed 拒绝并记 rejected 台账）。
    const localAvailable = opts.localAvailable;
    const recordedAt = new Date(clock.now()).toISOString();

    // 1) 预算先行：无调用额度即无选择、无调用（brief：预算耗尽不选型不调用）。
    const calls = budget?.calls;
    if (typeof calls !== 'number' || !Number.isFinite(calls) || calls <= 0) {
      throw fail('BUDGET_EXCEEDED', 'model call budget exhausted or missing (calls allowance must be a positive number)');
    }
    const tokens = budget?.tokens;
    if (tokens !== undefined && (typeof tokens !== 'number' || !Number.isFinite(tokens) || tokens <= 0)) {
      throw fail('BUDGET_EXCEEDED', 'model call budget exhausted (tokens allowance must be positive when present)');
    }

    // 2) secret 纵深防御：永不进任何模型（M4 router 同规则；此处独立再拒，
    //    不依赖 router 实现）。transport 与 select 均零调用。
    if (dataClass === 'secret') {
      ledger.record({ ownerId, actor, taskClass, dataClass, model: null, provenance: null, status: 'rejected', recordedAt });
      throw fail('FORBIDDEN', 'secret dataClass must never be sent to any model');
    }

    // 3) 选型（注入 port；抛错 = 结构化拒绝 → 记 rejected 后原样上抛）。
    //    鸭子类型对齐 M4 selectModel：透传 localAvailable，now 由注入 clock 派生。
    let decision;
    try {
      decision = await select(taskClass, dataClass, { actor, ownerId, budget, localAvailable, now: recordedAt });
    } catch (cause) {
      ledger.record({ ownerId, actor, taskClass, dataClass, model: null, provenance: null, status: 'rejected', recordedAt });
      throw cause;
    }
    if (!isPlainObject(decision) || typeof decision.status !== 'string') {
      ledger.record({ ownerId, actor, taskClass, dataClass, model: null, provenance: null, status: 'rejected', recordedAt });
      throw fail('CONTRACT_INVALID', 'select port must resolve to { status: "selected"|"unknown", model?, provenance, ... }');
    }
    const provenance = isPlainObject(decision.provenance) ? decision.provenance : null;

    // 4) 无规则命中（unknown）：绝不猜默认模型，transport 零调用，台账 UNKNOWN。
    if (decision.status === 'unknown') {
      ledger.record({ ownerId, actor, taskClass, dataClass, model: null, provenance, status: 'unknown', recordedAt });
      return { ok: false, reason: 'no-model-source', provenance };
    }
    if (decision.status !== 'selected') {
      ledger.record({ ownerId, actor, taskClass, dataClass, model: null, provenance, status: 'rejected', recordedAt });
      throw fail('CONTRACT_INVALID', `select port status must be "selected" or "unknown"; got ${decision.status}`);
    }

    // 5) transport 调用（key 封在注入 transport 内）。payload 只带 messages 与
    //    已解析 model；失败先记 failed（保留尝试过的 model 供审计）再原样上抛。
    const selectionModel = firstNonEmptyModel(decision.model);
    const payload = { messages };
    if (selectionModel !== null) payload.model = selectionModel;
    let body;
    try {
      body = await transport.chat(payload);
    } catch (cause) {
      ledger.record({ ownerId, actor, taskClass, dataClass, model: selectionModel, provenance, status: 'failed', recordedAt });
      throw cause;
    }

    // 6) 模型来源仲裁：response.model / selection.model 任一存在即可；
    //    双方都无 → 只能 UNKNOWN，绝不生成成功结果。
    const resolvedModel = firstNonEmptyModel(body?.model, selectionModel);
    const content = body?.choices?.[0]?.message?.content;
    const usage = isPlainObject(body?.usage) ? body.usage : undefined;
    if (resolvedModel === null) {
      ledger.record({ ownerId, actor, taskClass, dataClass, model: null, provenance, status: 'unknown', recordedAt });
      return { ok: false, reason: 'no-model-source', provenance };
    }
    ledger.record({ ownerId, actor, taskClass, dataClass, model: resolvedModel, provenance, status: 'selected', recordedAt });
    return { ok: true, content, model: resolvedModel, usage, provenance };
  }

  return { complete };
}
