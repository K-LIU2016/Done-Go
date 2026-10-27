// W8 Codex App Server 适配器：把 Mission 能力映射为 stdio JSON-RPC 方法。
// 会话、选模、审批均通过依赖注入，单测使用录制夹具，不启动真实 Codex。
import { createThreadRegistry } from './threads.mjs';

function contractPlan(output, missionId) {
  const value = output && typeof output === 'object' ? output : {};
  return {
    missionId,
    model: 'gpt-6-luna',
    effort: 'low',
    files: Array.isArray(value.files) ? value.files : [],
    steps: Array.isArray(value.steps) && value.steps.length > 0
      ? value.steps
      : [String(value.summary ?? 'Produce the approved change plan.')],
    risks: Array.isArray(value.risks) ? value.risks : (Array.isArray(value.riskFlags) ? value.riskFlags : []),
    tests: Array.isArray(value.tests) ? value.tests : [],
    ...(Number.isInteger(value.diffLines)
      ? { diffLines: value.diffLines }
      : Number.isFinite(value.estimatedDiffLines) ? { diffLines: Math.max(0, Math.round(value.estimatedDiffLines)) } : {}),
  };
}

const PLAN_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['files', 'summary', 'riskFlags', 'tests', 'estimatedDiffLines'],
  properties: {
    files: { type: 'array', items: { type: 'string' } },
    summary: { type: 'string' },
    riskFlags: { type: 'array', items: { type: 'string' } },
    tests: { type: 'array', items: { type: 'string' } },
    estimatedDiffLines: { type: 'number' },
  },
};

const DEFAULT_APPROVAL_POLICY = 'on-request';
const READ_ONLY_SANDBOX = 'read-only';
const WORKSPACE_SANDBOX = writableRoot => ({
  type: 'workspaceWrite',
  writableRoots: [writableRoot],
  networkAccess: false,
  excludeTmpdirEnvVar: false,
  excludeSlashTmp: false,
});

function required(value, name) {
  if (typeof value !== 'string' || !value) throw new Error(`${name.toUpperCase()}_REQUIRED`);
  return value;
}

function threadIdFrom(result) {
  const id = result?.threadId ?? result?.thread?.id;
  if (typeof id !== 'string' || !id) throw new Error('THREAD_ID_MISSING');
  return id;
}

function outputFrom(result) {
  if (!result || !Object.prototype.hasOwnProperty.call(result, 'output')) {
    throw new Error('CODEX_OUTPUT_MISSING');
  }
  return result.output;
}

function notificationText(item) {
  if (!item || typeof item !== 'object') return '';
  return item.text ?? item.content ?? item.output_text ?? '';
}

function parseCompletedOutput(text, structured) {
  if (!structured) return { status: 'completed', text };
  const value = String(text ?? '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try { return JSON.parse(value); } catch { return value; }
}

function approvalResult(decision) {
  if (decision === 'approve') return { result: { decision: 'approved' } };
  if (decision === 'reject') return { result: { decision: 'denied' } };
  return null;
}

/**
 * @param {object} options
 * @param {(hooks: object) => object} options.sessionFactory
 * @param {(plan: object, limits?: object, history?: object) => object} [options.chooseModel]
 * @param {(choice: object) => object} [options.chooseReviewModel]
 * @param {(request: object, contract: object, ctx: object) => object} [options.decideApproval]
 * @param {(need: object) => void} [options.onNeed]
 */
export function createCodexAdapter({
  sessionFactory,
  chooseModel,
  chooseReviewModel,
  decideApproval,
  onNeed,
  now = Date.now,
  log = () => {},
} = {}) {
  if (typeof sessionFactory !== 'function') throw new TypeError('sessionFactory is required');

  let session = null;
  let started = false;
  const threads = createThreadRegistry();
  const missions = new Map();
  const pendingNeeds = new Map();
  const completedTurns = new Map();
  const turnWaiters = new Map();

  function activeSession() {
    if (!session) throw new Error('CODEX_SESSION_NOT_STARTED');
    return session;
  }

  function contextFor(missionId) {
    const entry = threads.require(missionId);
    return { entry, mission: missions.get(missionId) };
  }

  function serverRequestHandler(request, reply) {
    const threadId = request?.threadId ?? request?.params?.threadId;
    const mission = threadId
      ? [...missions.values()].find(item => item.threadId === threadId)
      : missions.size === 1 ? [...missions.values()][0] : null;
    if (!mission) {
      reply({ result: { decision: 'denied', reason: 'UNKNOWN_THREAD' } });
      return;
    }
    const contract = mission.contract ?? {};
    let decision;
    try {
      decision = typeof decideApproval === 'function'
        ? decideApproval(request, contract, { now, log, mission })
        : { decision: 'need', reason: 'NO_APPROVAL_POLICY' };
    } catch (error) {
      decision = { decision: 'need', reason: error?.message || 'APPROVAL_POLICY_ERROR' };
    }
    const immediate = approvalResult(decision?.decision);
    if (immediate) {
      reply(immediate);
      return;
    }
    const need = {
      ...decision?.need,
      type: decision?.need?.type ?? 'approval',
      method: request.method,
      requestId: request.id,
      request,
      reason: decision?.reason ?? 'APPROVAL_REQUIRED',
      missionId: mission?.missionId,
    };
    pendingNeeds.set(request.id, { reply, missionId: mission.missionId, request });
    try { onNeed?.({ ...need, reply: decisionReply => resolveNeed(request.id, decisionReply) }); } catch (error) { log('approval need callback failed', error); }
  }

  function resolveNeed(requestId, decision) {
    const pending = pendingNeeds.get(requestId);
    if (!pending) return false;
    const immediate = approvalResult(decision?.decision ?? decision);
    if (!immediate) return false;
    pendingNeeds.delete(requestId);
    return pending.reply(immediate);
  }

  function onNotify(method, params) {
    log('codex.notify', { method, params });
    const turnId = params?.turnId ?? params?.turn?.id;
    if (method === 'item/completed' && turnId) {
      const items = completedTurns.get(turnId)?.items ?? [];
      items.push(params.item);
      completedTurns.set(turnId, { ...(completedTurns.get(turnId) ?? {}), items });
    }
    if (method === 'turn/completed' && turnId) {
      const result = {
        turn: params.turn,
        text: (completedTurns.get(turnId)?.items ?? []).map(notificationText).join(''),
      };
      completedTurns.set(turnId, result);
      const waiter = turnWaiters.get(turnId);
      if (waiter) { turnWaiters.delete(turnId); waiter(result); }
    }
  }

  async function completedTurn(turnId) {
    const existing = completedTurns.get(turnId);
    if (existing?.turn) return existing;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { turnWaiters.delete(turnId); reject(new Error(`CODEX_TURN_TIMEOUT: ${turnId}`)); }, 30_000);
      turnWaiters.set(turnId, result => { clearTimeout(timer); resolve(result); });
    });
  }

  async function requestTurn(current, params) {
    const result = await current.request('turn/start', params);
    const turnId = result?.turn?.id ?? result?.turnId;
    if (!turnId) {
      // Fixture sessions return the completed turn directly; real App Server sessions
      // must expose the asynchronous turn id and completion notification.
      return result;
    }
    const completed = await completedTurn(turnId);
    return { output: params.outputSchema ? parseCompletedOutput(completed.text, true) : parseCompletedOutput(completed.text, false), turn: completed.turn };
  }

  async function start() {
    if (started) return { session };
    session = sessionFactory({ onNotify, onServerRequest: serverRequestHandler });
    if (!session || typeof session.request !== 'function' || typeof session.notify !== 'function') {
      throw new TypeError('sessionFactory must return a JSON-RPC session');
    }
    await session.request('initialize', { clientInfo: { name: 'donego-bridge', version: '0.0.0' } });
    session.notify('initialized', {});
    started = true;
    return { session };
  }

  async function plan(mission) {
    required(mission?.worktree, 'worktree');
    if (!mission?.contract || typeof mission.contract !== 'object') throw new Error('CONTRACT_REQUIRED');
    const missionId = required(mission.missionId, 'missionId');
    const current = activeSession();
    const thread = await current.request('thread/start', {
      cwd: mission.worktree,
      sandbox: READ_ONLY_SANDBOX,
      approvalPolicy: DEFAULT_APPROVAL_POLICY,
      developerInstructions: mission.contract.summary,
    });
    const threadId = threadIdFrom(thread);
    missions.set(missionId, { ...mission, threadId, plannedAt: now() });
    threads.set(missionId, { threadId, worktree: mission.worktree });
    const goal = mission.contract.definitionOfDone;
    await current.request('thread/goal/set', {
      threadId,
      objective: Array.isArray(goal) ? goal.join('\n') : goal,
      goal,
    });
    const result = await requestTurn(current, {
      threadId,
      input: [{ type: 'text', text: mission.contract.summary || mission.contract.goal || 'Produce a structured change plan.' }],
      model: 'gpt-6-luna',
      effort: 'low',
      sandboxPolicy: { type: 'readOnly', networkAccess: false },
      sandbox: { mode: READ_ONLY_SANDBOX },
      outputSchema: PLAN_OUTPUT_SCHEMA,
    });
    const plan = outputFrom(result);
    return { threadId, plan, codexPlan: contractPlan(plan, missionId) };
  }

  async function execute(missionId, choice) {
    if (choice?.pause) return { paused: true, reason: choice.reason };
    if (choice?.defer) return { deferred: true, reason: choice.reason };
    const { entry } = contextFor(missionId);
    const mission = missions.get(missionId);
    const result = await requestTurn(activeSession(), {
      threadId: entry.threadId,
      input: [{ type: 'text', text: mission?.contract?.summary || mission?.contract?.goal || 'Execute the approved mission.' }],
      model: required(choice?.model, 'model'),
      effort: required(choice?.effort, 'effort'),
      sandboxPolicy: WORKSPACE_SANDBOX(entry.worktree),
      sandbox: { mode: 'workspace-write', writableRoots: [entry.worktree] },
    });
    const output = outputFrom(result);
    return { output: output?.output ?? output };
  }

  async function steer(missionId, instruction) {
    const { entry } = contextFor(missionId);
    return activeSession().request('turn/steer', {
      threadId: entry.threadId,
      input: [{ type: 'text', text: instruction }],
      instruction,
      expectedTurnId: entry.turnId || '',
    });
  }

  async function interrupt(missionId) {
    const { entry } = contextFor(missionId);
    return activeSession().request('turn/interrupt', { threadId: entry.threadId, turnId: entry.turnId || '' });
  }

  async function fork(missionId) {
    const { entry } = contextFor(missionId);
    const result = await activeSession().request('thread/fork', { threadId: entry.threadId });
    const threadId = threadIdFrom(result);
    // The fork is a separate thread; keep the original mission binding active
    // until a caller explicitly adopts the returned thread for a new mission.
    return { ...result, threadId };
  }

  function adoptThread(missionId, threadId) {
    const mission = missions.get(missionId) ?? { missionId };
    missions.set(missionId, { ...mission, threadId });
    threads.set(missionId, { threadId, worktree: mission.worktree });
  }

  async function resume(missionId) {
    const { entry } = contextFor(missionId);
    const result = await activeSession().request('thread/resume', { threadId: entry.threadId });
    return result;
  }

  async function revert(missionId, checkpoint) {
    const { entry } = contextFor(missionId);
    return activeSession().request('thread/revert', { threadId: entry.threadId, beforeTurnId: checkpoint, checkpoint });
  }

  async function review(missionId, diff, executionChoice) {
    const { entry } = contextFor(missionId);
    if (typeof chooseReviewModel !== 'function') throw new TypeError('chooseReviewModel is required');
    const reviewChoice = chooseReviewModel(executionChoice);
    return activeSession().request('review/start', {
      threadId: entry.threadId,
      target: { type: 'custom', instructions: diff },
      model: required(reviewChoice?.model, 'review model'),
      effort: required(reviewChoice?.effort, 'review effort'),
      diff,
    });
  }

  function close() {
    session?.close?.();
    session = null;
    started = false;
  }

  return Object.freeze({
    start, plan, execute, steer, interrupt, fork, revert, review, resume, adoptThread, resolveNeed, close,
    rateLimits: () => activeSession().request('account/rateLimits/read', {}),
    listModels: () => activeSession().request('model/list', {}),
    listLoadedThreads: () => activeSession().request('thread/loaded/list', {}),
    chooseModel,
    missions,
  });
}

export { PLAN_OUTPUT_SCHEMA };
