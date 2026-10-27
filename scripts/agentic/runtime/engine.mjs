// W7 M3 · runtime-engine — A4 agent runtime 的核心执行器（plan.md M3）。
//
// 架构裁决（brief）落点：
//   ② 决策一律经注入 policyPort.check(ctx, action)（W13 接 W4 adapter）；运行时不复制 A0–A5 判定，
//      但保留独立纵深防御：action.autonomy='A5' 永拒、'A4' 必须带一次性确认凭据。
//      policy/Grant/actor/model/contract/owner 任一缺失 → fail closed（构造期或入参期拒绝，零副作用）。
//   ① 输出边界：WorkOrder 入参先过冻结 work-order.schema.json；WorkResult 先过 work-result.schema.json
//      再返回/落库；执行上下文走独立 ctx，不塞进 WorkOrder（additionalProperties:false）。
//   ④ resolvedModel 为空或 transport 结果无模型来源 → run 级 unknown + w7_unknown_outcomes 台账，
//      绝不生成 status=done 的 WorkResult（红线⑦）。
//   ⑥ 检查点：step pending→running→succeeded|failed|paused 每次跃迁落 store；暂停/恢复只能从检查点
//      继续，恢复时重验 contractHash + 重跑 policyPort.check + 用新 now 重验预算窗口。
//
// 时钟（红线⑥）：全部经注入 clock.now()，本文件无 Date.now()。
// 端口：policyPort/modelCaller/toolCaller/spanSink/clock 形状复用 M1 ports.mjs 校验器。
import { createHash } from 'node:crypto';
import { assertValid, canonicalJson, contractHash, loadSchema } from '../contracts.mjs';
import { FAIL_CLOSED_CODES, failClosed, sanitizeMessage } from './errors.mjs';
import {
  readPolicyDecision,
  validateClock,
  validateModelCaller,
  validatePolicyPort,
  validateSpanSink,
  validateToolCaller,
} from './ports.mjs';
import { assertGrantRefsSubset, createBudgetTracker } from './budget.mjs';

const UNKNOWN_MARKER = Symbol('w7.unknownOutcome');
const FROM_MODEL_CALL = Symbol('w7.fromModelCall');

const REQUIRED_STORE_METHODS = [
  'saveWorkOrder',
  'getWorkResult',
  'saveWorkResult',
  'recordStep',
  'updateStepState',
  'recordUnknownOutcome',
];

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sha256Hex(text) {
  return createHash('sha256').update(text).digest('hex');
}

function requireNonEmptyString(value, code, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw failClosed(code, `${label} is required and must be a non-empty string`);
  }
  return value;
}

function notFound(message) {
  const error = new Error(message);
  error.code = 'NOT_FOUND';
  return error;
}

function conflict(message) {
  const error = new Error(message);
  error.code = 'CONFLICT';
  return error;
}

/** 构造期校验 store：必须提供引擎用到的全部方法（缺一即 fail closed）。 */
function validateStore(store) {
  if (!isPlainObject(store)) {
    throw failClosed('CONTRACT_INVALID', `runtime store is required (createRuntimeStore); got ${store === null ? 'null' : typeof store}`);
  }
  const missing = REQUIRED_STORE_METHODS.filter(method => typeof store[method] !== 'function');
  if (missing.length > 0) {
    throw failClosed('CONTRACT_INVALID', `runtime store is missing required methods: ${missing.join(', ')}`);
  }
  return store;
}

export function createAgentRuntime(options = {}) {
  if (!isPlainObject(options)) {
    throw failClosed('CONTRACT_INVALID', 'createAgentRuntime requires an options object');
  }
  const policyPort = validatePolicyPort(options.policyPort);
  const modelCaller = validateModelCaller(options.modelCaller);
  const toolCaller = options.toolCaller === undefined ? undefined : validateToolCaller(options.toolCaller);
  const spanSink = validateSpanSink(options.spanSink);
  const clock = validateClock(options.clock);
  const store = validateStore(options.store);
  if (typeof options.schemaDir !== 'string' || options.schemaDir.length === 0) {
    throw failClosed('CONTRACT_INVALID', 'schemaDir is required (path to the frozen contracts/agentic directory)');
  }
  const schemaDir = options.schemaDir;

  const workOrderSchema = loadSchema('work-order.schema.json', schemaDir);
  const workResultSchema = loadSchema('work-result.schema.json', schemaDir);
  const contractSchema = loadSchema('contract.schema.json', schemaDir);
  const stepSchema = loadSchema('step.schema.json', schemaDir);
  const grantRefSchema = loadSchema('grant-ref.schema.json', schemaDir);
  const stepKinds = new Set(stepSchema.properties.kind.enum);

  const runs = new Map(); // runId → 运行注册表（内存态；SQLite 台账经 store）

  const nowMs = () => clock.now();
  const isoNow = () => new Date(clock.now()).toISOString();

  function recordSpan(span) {
    if (spanSink) spanSink.record({ recordedAt: isoNow(), ...span });
  }

  /**
   * 调注入 policyPort 并 fail closed：check 抛错 → FORBIDDEN（保留 cause 的脱敏 message，不吞错）；
   * 决策形状非法 → CONTRACT_INVALID；allow:false → FORBIDDEN（带 reason）。
   */
  async function checkPolicy(context, action) {
    let decision;
    try {
      decision = await policyPort.check(context, action);
    } catch (cause) {
      const details = typeof cause?.code === 'string' ? { causeCode: cause.code } : {};
      throw failClosed(
        'FORBIDDEN',
        sanitizeMessage(cause?.message, 'policy port check threw; failing closed without executing the action'),
        details,
      );
    }
    const parsed = readPolicyDecision(decision);
    if (!parsed.allow) {
      // 显式拒绝是"决策"：runAgent 收场为 failed outcome；而 check 抛错是基础设施故障，
      // 必须原样上抛（不吞成 allow，也不吞成 outcome）。用标记区分两者。
      const denial = failClosed('FORBIDDEN', sanitizeMessage(parsed.reason, 'policy port denied the action'));
      denial.policyDenial = true;
      throw denial;
    }
    return parsed;
  }

  /** 纵深防御（独立于 policyPort）：A5 永拒；A4 必须带一次性确认凭据，否则 NEED_HUMAN。 */
  function assertActionDefence(action) {
    if (action.autonomy === 'A5') {
      throw failClosed('FORBIDDEN', 'action autonomy A5 is permanently denied (defense in depth, independent of the policy port)');
    }
    if (action.autonomy === 'A4') {
      const token = isPlainObject(action.confirmation) ? action.confirmation.token : undefined;
      if (typeof token !== 'string' || token.length === 0) {
        throw failClosed('NEED_HUMAN', 'A4 action requires a one-time confirmation credential; none was provided');
      }
    }
  }

  function policyContext(run, extra = {}) {
    return {
      actor: run.actor,
      ownerId: run.ownerId,
      orderId: run.orderId,
      runId: run.runId,
      missionId: run.contract.missionId,
      grantRefs: run.grantRefs,
      ...extra,
    };
  }

  // ---------------- 入参校验（Phase A：全部通过前零副作用） ----------------

  function validateRunArgs(args) {
    if (!isPlainObject(args)) {
      throw failClosed('CONTRACT_INVALID', 'runAgent requires an argument object');
    }
    requireNonEmptyString(args.actor, 'FORBIDDEN', 'actor');
    if (!isPlainObject(args.workOrder)) {
      throw failClosed('CONTRACT_INVALID', 'workOrder is required and must pass work-order.schema.json');
    }
    assertValid(args.workOrder, workOrderSchema, { schemaDir });
    assertValid(args.contract, contractSchema, { schemaDir });
    if (!isPlainObject(args.ownerCtx)) {
      throw failClosed('FORBIDDEN', 'ownerCtx (with ownerId) is required');
    }
    requireNonEmptyString(args.ownerCtx.ownerId, 'FORBIDDEN', 'ownerCtx.ownerId');
    if (args.contract.ownerId !== args.ownerCtx.ownerId) {
      throw failClosed('FORBIDDEN', 'contract belongs to a different owner; refusing cross-owner execution');
    }
    if (!Array.isArray(args.grantRefs) || args.grantRefs.length === 0) {
      throw failClosed('FORBIDDEN', 'grantRefs must be a non-empty array of GrantRef');
    }
    for (const [index, ref] of args.grantRefs.entries()) {
      try {
        assertValid(ref, grantRefSchema, { schemaDir });
      } catch (cause) {
        throw failClosed('CONTRACT_INVALID', `grantRefs[${index}] violates grant-ref.schema.json`, {
          errors: cause.errors?.map(item => `${item.path} ${item.message}`),
        });
      }
    }
    if (!Array.isArray(args.steps)) {
      throw failClosed('CONTRACT_INVALID', 'steps must be an array of { id, name, kind, input?, execute }');
    }
    for (const [index, step] of args.steps.entries()) {
      if (!isPlainObject(step)) {
        throw failClosed('CONTRACT_INVALID', `steps[${index}] must be an object`);
      }
      requireNonEmptyString(step.id, 'CONTRACT_INVALID', `steps[${index}].id`);
      requireNonEmptyString(step.name, 'CONTRACT_INVALID', `steps[${index}].name`);
      if (!stepKinds.has(step.kind)) {
        throw failClosed('CONTRACT_INVALID', `steps[${index}].kind must be one of ${[...stepKinds].join('/')}`);
      }
      if (typeof step.execute !== 'function') {
        throw failClosed('CONTRACT_INVALID', `steps[${index}].execute must be a function`);
      }
    }
    if (args.idempotencyKey !== undefined) {
      requireNonEmptyString(args.idempotencyKey, 'CONTRACT_INVALID', 'idempotencyKey');
    }
    return args;
  }

  // ---------------- 模型 / 工具调用端口（先防御、后策略、后预算） ----------------

  function makeStepContext(run, step, tracker) {
    async function modelCall(payload, action = {}) {
      if (!isPlainObject(payload)) {
        throw failClosed('CONTRACT_INVALID', 'modelCall payload must be an object');
      }
      if (!isPlainObject(action)) {
        throw failClosed('CONTRACT_INVALID', 'modelCall action must be an object');
      }
      assertActionDefence(action);
      await checkPolicy(policyContext(run, { stepId: step.id }), {
        type: 'model.call',
        autonomy: action.autonomy,
        capability: action.capability,
        confirmation: action.confirmation,
      });
      tracker.assertWithinWindow(nowMs());
      tracker.assertCanSpend({ calls: 1, tokens: 0 });
      const result = await modelCaller({
        ...payload,
        actor: run.actor,
        ownerId: run.ownerId,
        orderId: run.orderId,
        runId: run.runId,
        stepId: step.id,
      });
      if (!isPlainObject(result) || result.ok !== true) {
        const code = isPlainObject(result?.error) && FAIL_CLOSED_CODES.includes(result.error.code)
          ? result.error.code
          : 'UPSTREAM_UNAVAILABLE';
        throw failClosed(code, sanitizeMessage(result?.error?.message, 'model transport failed'));
      }
      if (typeof result.model !== 'string' || result.model.length === 0) {
        store.recordUnknownOutcome({
          ownerId: run.ownerId,
          runId: run.runId,
          stepId: step.id,
          source: 'model',
          detail: 'model transport returned no model attribution; outcome recorded as UNKNOWN (no auto retry)',
        });
        const unknown = failClosed(
          'UPSTREAM_UNAVAILABLE',
          'model transport result carries no model attribution; run marked UNKNOWN and will not auto-retry',
        );
        unknown[UNKNOWN_MARKER] = true;
        throw unknown;
      }
      tracker.charge({
        calls: result.usage?.calls ?? 1,
        tokens: result.usage?.tokens ?? 0,
      });
      run.resolvedModel = result.model;
      const tagged = { ...result };
      Object.defineProperty(tagged, FROM_MODEL_CALL, { value: true });
      return tagged;
    }

    async function toolCall(tool, args, action = {}) {
      if (toolCaller === undefined) {
        throw failClosed('FORBIDDEN', 'no toolCaller was injected into this runtime; tool calls are unavailable');
      }
      if (typeof tool !== 'string' || tool.length === 0) {
        throw failClosed('CONTRACT_INVALID', 'toolCall requires a non-empty tool name');
      }
      if (!isPlainObject(action)) {
        throw failClosed('CONTRACT_INVALID', 'toolCall action must be an object');
      }
      assertActionDefence(action);
      await checkPolicy(policyContext(run, { stepId: step.id, tool }), {
        type: 'tool.call',
        autonomy: action.autonomy,
        capability: action.capability,
        confirmation: action.confirmation,
      });
      tracker.assertWithinWindow(nowMs());
      return toolCaller(tool, args, policyContext(run, { stepId: step.id, tool }));
    }

    return { modelCall, toolCall, clock, step };
  }

  // ---------------- step 循环（pending → running → succeeded|failed|paused） ----------------

  function stepInputHash(step) {
    return sha256Hex(canonicalJson(step.input ?? null));
  }

  function recordStepTransition(ownerId, step, state, extra = {}) {
    store.updateStepState({
      ownerId,
      stepId: step.id,
      state,
      checkpoint: extra.checkpoint !== undefined ? JSON.stringify(extra.checkpoint) : undefined,
    });
  }

  function classifyFailure(run, error) {
    if (error && error[UNKNOWN_MARKER]) return 'unknown';
    if (error?.code === 'NEED_HUMAN') return 'needs_human';
    return run.completedStepIds.length > 0 ? 'partial' : 'failed';
  }

  function failStep(run, step, error) {
    const checkpoint = { errorCode: error?.code ?? 'INTERNAL_ERROR' };
    try {
      recordStepTransition(run.ownerId, step, 'failed', { checkpoint });
    } catch (cause) {
      // 落库失败不掩盖原始错误；补抛为 INTERNAL（fail closed，不吞）。
      throw failClosed('CONTRACT_INVALID', `failed to persist step failure: ${sanitizeMessage(cause?.message, 'store error')}`);
    }
  }

  /**
   * 执行 steps（可从检查点续跑）。返回终态分类：
   * done / unknown / needs_human / partial / failed / paused。
   */
  async function executeSteps(run, tracker, { startIndex = 0, seedDoneIds = [] } = {}) {
    const doneIds = new Set([...run.completedStepIds, ...seedDoneIds]);
    const executed = new Set(); // 本轮已执行的 (id, inputHash)，重复出现即检查点重放
    run.state = 'running';

    for (let index = startIndex; index < run.steps.length; index += 1) {
      const step = run.steps[index];
      if (doneIds.has(step.id)) continue;
      const dedupeKey = `${step.id}\n${stepInputHash(step)}`;
      if (executed.has(dedupeKey)) continue; // 重复 step（同 id+inputHash）→ 重放，不二次执行

      tracker.assertWithinWindow(nowMs());
      const inputHash = stepInputHash(step);
      store.recordStep({
        ownerId: run.ownerId,
        step: {
          id: step.id,
          runId: run.runId,
          name: step.name,
          kind: step.kind,
          state: 'pending',
          attempt: 0,
          inputHash,
          startedAt: isoNow(),
        },
      });
      recordStepTransition(run.ownerId, step, 'running');

      let outcome;
      try {
        outcome = await step.execute(makeStepContext(run, step, tracker));
      } catch (error) {
        failStep(run, step, error);
        return classifyFailure(run, error);
      }

      if (!isPlainObject(outcome)) {
        const error = failClosed('CONTRACT_INVALID', `step ${step.id} must return { ok } | { pause, checkpoint }`);
        failStep(run, step, error);
        return classifyFailure(run, error);
      }
      if (outcome.pause === true) {
        const checkpoint = isPlainObject(outcome.checkpoint) ? outcome.checkpoint : {};
        recordStepTransition(run.ownerId, step, 'paused', { checkpoint });
        run.checkpoint = checkpoint;
        run.snapshot = tracker.snapshot();
        run.state = 'paused';
        return 'paused';
      }
      if (outcome.ok === true) {
        if (!outcome[FROM_MODEL_CALL] && isPlainObject(outcome.usage)) {
          tracker.charge({
            calls: outcome.usage.calls ?? 0,
            tokens: outcome.usage.tokens ?? 0,
          });
        }
        if (typeof outcome.model === 'string' && outcome.model.length > 0) {
          run.resolvedModel = outcome.model;
        }
        recordStepTransition(run.ownerId, step, 'succeeded');
        executed.add(dedupeKey);
        doneIds.add(step.id);
        run.completedStepIds.push(step.id);
        continue;
      }
      const error = isPlainObject(outcome.error)
        ? failClosed(FAIL_CLOSED_CODES.includes(outcome.error.code) ? outcome.error.code : 'UPSTREAM_UNAVAILABLE',
          sanitizeMessage(outcome.error.message, `step ${step.id} failed`))
        : failClosed('UPSTREAM_UNAVAILABLE', `step ${step.id} returned ok:false without an error object`);
      failStep(run, step, error);
      return classifyFailure(run, error);
    }

    if (typeof run.resolvedModel !== 'string' || run.resolvedModel.length === 0) {
      store.recordUnknownOutcome({
        ownerId: run.ownerId,
        runId: run.runId,
        stepId: null,
        source: 'engine',
        detail: 'run finished without any model attribution (resolved_model=NULL); marked UNKNOWN, not treated as done',
      });
      return 'unknown';
    }
    return 'done';
  }

  // ---------------- WorkResult（唯一输出边界，先过冻结 schema） ----------------

  function buildWorkResult(run, status, tracker, notes) {
    const spent = tracker.snapshot();
    const result = {
      orderId: run.orderId,
      status,
      artifacts: [],
      evidence: [{
        type: 'transcript',
        title: `agent run ${run.runId}`,
        detail: notes,
        uri: null,
        verified: false,
      }],
      spent: { calls: spent.calls, tokens: spent.tokens },
      notes,
    };
    assertValid(result, workResultSchema, { schemaDir });
    store.saveWorkResult({ ownerId: run.ownerId, result });
    return result;
  }

  function finalize(run, status, tracker) {
    run.state = status;
    recordSpan({ type: 'run.finished', runId: run.runId, status });
    if (status === 'paused' || status === 'unknown') {
      // paused 无产出；unknown 无合法 status 值（work-result 枚举无 unknown）→ 都不生成 WorkResult。
      return { runId: run.runId, status };
    }
    const notes = `run ${status}: ${run.completedStepIds.length}/${run.steps.length} step(s) settled`
      + (run.resolvedModel ? `, resolvedModel=${run.resolvedModel}` : '');
    const workResult = buildWorkResult(run, status, tracker, notes);
    return { runId: run.runId, status, workResult };
  }

  // ---------------- runAgent / resumeAgent ----------------

  async function runAgent(args) {
    validateRunArgs(args);
    const { actor, workOrder, contract, grantRefs, ownerCtx, steps } = args;
    const ownerId = ownerCtx.ownerId;
    const idempotencyKey = args.idempotencyKey ?? `auto:${sha256Hex(canonicalJson(workOrder))}`;
    const runId = `run-${sha256Hex(`${ownerId}\n${idempotencyKey}`).slice(0, 24)}`;

    const saved = store.saveWorkOrder({ ownerId, workOrder, idempotencyKey });
    if (saved.replayed) {
      const existingResult = store.getWorkResult({ ownerId, orderId: workOrder.id });
      if (existingResult) {
        return { runId, status: existingResult.status, workResult: existingResult, replayed: true };
      }
      const prior = runs.get(runId);
      if (prior) {
        return { runId, status: prior.state, replayed: true };
      }
      // 既无结果也无内存运行（如进程重启后重放）→ 按新执行继续（store 台账保证幂等）。
    }

    const run = {
      runId,
      ownerId,
      orderId: workOrder.id,
      actor,
      workOrder,
      contract,
      contractHash: await contractHash(contract),
      grantRefs,
      ownerCtx,
      steps,
      state: 'running',
      checkpoint: null,
      snapshot: { calls: 0, tokens: 0, now: nowMs() },
      resolvedModel: null,
      completedStepIds: [],
    };
    runs.set(runId, run);
    recordSpan({ type: 'run.started', runId, actor });

    // 前置策略：port 抛错（基础设施故障）→ 原样上抛；显式拒绝 → failed outcome 收场。
    try {
      await checkPolicy(policyContext(run), { type: 'run.start' });
    } catch (error) {
      if (!error?.policyDenial) throw error;
      return finalize(run, classifyFailure(run, error), createBudgetTracker({ contract, workOrder, now: nowMs }));
    }

    // 前置 Grant 子集 + 预算窗口（注入 now）：任一不满足 → failed outcome，零模型调用。
    let tracker;
    try {
      if (isPlainObject(ownerCtx.parentGrants) || Array.isArray(ownerCtx.parentGrants)) {
        assertGrantRefsSubset(grantRefs, ownerCtx.parentGrants);
      }
      tracker = createBudgetTracker({ contract, workOrder, now: nowMs });
      tracker.assertWithinWindow(nowMs());
    } catch (error) {
      return finalize(run, classifyFailure(run, error), createBudgetTracker({ contract, workOrder, now: nowMs }));
    }

    const status = await executeSteps(run, tracker);
    return finalize(run, status, tracker);
  }

  async function resumeAgent(args = {}) {
    requireNonEmptyString(args.runId, 'CONTRACT_INVALID', 'resumeAgent requires runId');
    if (!isPlainObject(args.ownerCtx)) {
      throw failClosed('FORBIDDEN', 'ownerCtx (with ownerId) is required to resume');
    }
    requireNonEmptyString(args.ownerCtx.ownerId, 'FORBIDDEN', 'ownerCtx.ownerId');
    const run = runs.get(args.runId);
    if (!run || run.ownerId !== args.ownerCtx.ownerId) {
      throw notFound(`run not found for this owner (${args.runId})`);
    }
    if (run.state !== 'paused') {
      throw conflict(`run ${args.runId} is ${run.state}, not paused; resume is only allowed from a checkpoint`);
    }
    requireNonEmptyString(args.actor, 'FORBIDDEN', 'actor');
    if (args.actor !== run.actor) {
      throw failClosed('FORBIDDEN', 'resume actor differs from the actor that started the run');
    }

    const effectiveContract = args.contract === undefined ? run.contract : args.contract;
    const resumeHash = await contractHash(effectiveContract);
    if (resumeHash !== run.contractHash) {
      throw failClosed('CONFLICT', 'contract hash changed since the checkpoint; the checkpoint is invalidated');
    }
    await checkPolicy(policyContext(run), { type: 'run.resume' });

    const tracker = createBudgetTracker({ contract: effectiveContract, workOrder: run.workOrder, now: nowMs });
    tracker.charge({ calls: run.snapshot?.calls ?? 0, tokens: run.snapshot?.tokens ?? 0 });
    tracker.assertWithinWindow(nowMs()); // 用新 now 重验窗口（红线⑥）
    if (isPlainObject(run.ownerCtx.parentGrants) || Array.isArray(run.ownerCtx.parentGrants)) {
      assertGrantRefsSubset(run.grantRefs, run.ownerCtx.parentGrants);
    }

    const checkpoint = isPlainObject(run.checkpoint) ? run.checkpoint : {};
    let startIndex = 0;
    const seedDoneIds = Array.isArray(checkpoint.doneSteps) ? [...checkpoint.doneSteps] : [];
    if (typeof checkpoint.next === 'string' && checkpoint.next.length > 0) {
      const index = run.steps.findIndex(step => step.id === checkpoint.next);
      if (index < 0) {
        throw failClosed('CONTRACT_INVALID', `checkpoint.next (${checkpoint.next}) does not match any step of run ${run.runId}`);
      }
      startIndex = index;
    }
    recordSpan({ type: 'run.resumed', runId: run.runId });

    const status = await executeSteps(run, tracker, { startIndex, seedDoneIds });
    return finalize(run, status, tracker);
  }

  return { runAgent, resumeAgent };
}
