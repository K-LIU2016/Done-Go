// M8 本机桥运行时：编排 Mission、Codex 能力、worktree 与上行事件。
// 运行时只持久化 thread/worktree/合同摘要等会话元数据，不记录任何上游密钥。
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

// 同一进程内多个 runtime 实例共享最后一次检查点；磁盘文件仍是跨进程恢复的权威来源。
const MEMORY_STATE = new Map();

function canonical(value) {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'undefined') return 'null';
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}

/** W0 §合同规范化：剔除顶层 self-hash 后稳定排序 JSON，再 SHA-256。 */
export function hashContract(contract) {
  const payload = contract && typeof contract === 'object' && !Array.isArray(contract)
    ? Object.fromEntries(Object.entries(contract).filter(([key]) => key !== 'hash'))
    : contract;
  return createHash('sha256').update(canonical(payload)).digest('hex');
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function readState(stateFile, repoKey) {
  try {
    if (stateFile && existsSync(stateFile)) {
      const parsed = JSON.parse(readFileSync(stateFile, 'utf8'));
      if (parsed && typeof parsed === 'object') return parsed;
    }
  } catch {
    // 损坏检查点不应阻止桥启动；后续操作会重新建立检查点。
  }
  return clone(MEMORY_STATE.get(repoKey)) ?? { version: 1, missions: {} };
}

function saveState(stateFile, repoKey, state) {
  const payload = JSON.stringify(state, null, 2);
  if (stateFile) {
    mkdirSync(dirname(stateFile), { recursive: true });
    const temporary = `${stateFile}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(temporary, `${payload}\n`, { mode: 0o600 });
    renameSync(temporary, stateFile);
  }
  MEMORY_STATE.set(repoKey, clone(state));
}

function requiredId(value) {
  if (typeof value !== 'string' || !value) throw new Error('MISSION_ID_REQUIRED');
  return value;
}

function missionFrom(state, missionId) {
  const mission = state.missions?.[missionId];
  if (!mission) throw new Error(`MISSION_NOT_FOUND: ${missionId}`);
  return mission;
}

function safeEvent(sendEvent, event, log) {
  try { sendEvent(event); } catch (error) { log('runtime event callback failed', error); }
}

/**
 * @param {object} options
 * @param {(hooks: object) => object} options.makeAdapter
 * @param {{create: Function, cleanup?: Function}} options.worktrees
 * @param {string} options.repoRoot
 * @param {Function} options.chooseModel
 * @param {Function} [options.chooseReviewModel]
 * @param {(event: object) => void} [options.sendEvent]
 * @param {string} [options.stateFile]
 * @param {() => number} [options.now]
 */
export function createBridgeRuntime({
  makeAdapter,
  worktrees,
  repoRoot = '',
  chooseModel,
  chooseReviewModel,
  sendEvent = () => {},
  stateFile,
  now = Date.now,
  log = () => {},
} = {}) {
  if (typeof makeAdapter !== 'function') throw new TypeError('makeAdapter is required');
  if (!worktrees || typeof worktrees.create !== 'function') throw new TypeError('worktrees.create is required');
  if (typeof chooseModel !== 'function') throw new TypeError('chooseModel is required');

  const repoKey = repoRoot || stateFile || 'default';
  const state = readState(stateFile, repoKey);
  if (!state.missions || typeof state.missions !== 'object') state.missions = {};
  let connected = true;
  let started = false;
  const adapter = makeAdapter({
    onNeed: need => safeEvent(sendEvent, { type: 'need', ...need }, log),
  });
  if (!adapter || typeof adapter.plan !== 'function') throw new TypeError('makeAdapter must return a Codex adapter');

  const emit = event => safeEvent(sendEvent, { at: now(), ...event }, log);
  const persist = () => saveState(stateFile, repoKey, state);

  async function ensureStarted() {
    if (!started && typeof adapter.start === 'function') {
      await adapter.start();
      started = true;
    }
  }

  async function adopt(mission) {
    if (mission.threadId && typeof adapter.adoptThread === 'function') {
      adapter.adoptThread(mission.missionId, mission.threadId);
    }
  }

  function offline() {
    const event = { type: 'blocked', need: '打开本机桥', reason: 'BRIDGE_OFFLINE' };
    emit(event);
    return { blocked: true, ...event };
  }

  async function createPlan(command) {
    const input = command.mission;
    const missionId = requiredId(input?.missionId);
    if (!input?.contract || typeof input.contract !== 'object') throw new Error('CONTRACT_REQUIRED');
    if (!connected) return offline();
    await ensureStarted();

    let stored = state.missions[missionId];
    let worktree = stored?.worktree;
    let branch = stored?.branch;
    if (!worktree) {
      const created = await worktrees.create(missionId, { base: input.base, repoRoot });
      worktree = created?.path ?? created?.worktree;
      branch = created?.branch;
      if (typeof worktree !== 'string' || !worktree) throw new Error('WORKTREE_PATH_MISSING');
    }
    const contract = clone(input.contract);
    const mission = {
      ...clone(input),
      missionId,
      worktree,
      worktreeRoot: worktree,
      branch,
      contract,
    };
    const result = await adapter.plan(mission);
    const threadId = result?.threadId;
    if (typeof threadId !== 'string' || !threadId) throw new Error('THREAD_ID_MISSING');
    stored = {
      ...stored,
      missionId,
      worktree,
      branch,
      contract,
      contractHash: hashContract(contract),
      threadId,
      // Keep the adapter's structured plan object for the same-process trace; the
      // checkpoint writer serializes it without changing its wire shape.
      plan: result.plan,
      status: 'planned',
      plannedAt: now(),
    };
    state.missions[missionId] = stored;
    persist();
    emit({ type: 'mission.planned', missionId, threadId, worktree, plan: result.plan });
    return result;
  }

  async function execute(command) {
    const missionId = requiredId(command.missionId);
    if (!connected) return offline();
    await ensureStarted();
    const mission = missionFrom(state, missionId);
    await adopt(mission);
    const limits = typeof adapter.rateLimits === 'function' ? await adapter.rateLimits() : {};
    const choice = chooseModel(mission.plan ?? {}, limits ?? {}, mission.history ?? {});
    emit({ type: 'mission.model.selected', missionId, model: choice?.model, effort: choice?.effort, reason: choice?.reason, quotaSnapshot: choice?.quotaSnapshot });
    if (choice?.pause) {
      mission.status = 'paused';
      persist();
      emit({ type: 'mission.paused', missionId, reason: choice.reason, quotaSnapshot: choice.quotaSnapshot });
      return choice;
    }
    if (choice?.defer) {
      mission.status = 'deferred';
      persist();
      emit({ type: 'mission.deferred', missionId, reason: choice.reason, quotaSnapshot: choice.quotaSnapshot });
      return choice;
    }
    if (choice?.need) {
      const need = {
        type: 'quota-approval',
        missionId,
        reason: choice.reason ?? 'MODEL_CHOICE_NEEDS_APPROVAL',
        choice: clone(choice),
      };
      mission.status = 'blocked';
      mission.blockedReason = need.reason;
      persist();
      emit({ type: 'need', ...need });
      return { ...choice, blocked: true, need };
    }
    const result = await adapter.execute(missionId, choice);
    mission.choice = clone(choice);
    mission.status = 'executed';
    mission.executedAt = now();
    persist();
    emit({ type: 'mission.executed', missionId, choice, output: result?.output ?? result });
    return result;
  }

  async function withMission(command, operation, eventType) {
    const missionId = requiredId(command.missionId);
    if (!connected) return offline();
    await ensureStarted();
    const mission = missionFrom(state, missionId);
    await adopt(mission);
    const result = await operation(mission, missionId);
    if (eventType) emit({ type: eventType, missionId, result, ...(result && typeof result === 'object' ? result : {}) });
    return result;
  }

  async function resume(command) {
    const missionId = requiredId(command.missionId);
    if (!connected) return offline();
    await ensureStarted();
    const mission = missionFrom(state, missionId);
    const contract = command.contract;
    if (!contract || hashContract(contract) !== mission.contractHash) {
      throw new Error('CONTRACT_HASH_MISMATCH');
    }
    await adopt(mission);
    if (typeof adapter.resume !== 'function') throw new Error('RESUME_UNSUPPORTED');
    const result = await adapter.resume(missionId);
    mission.status = 'resumed';
    persist();
    emit({ type: 'mission.resumed', missionId, result });
    return result;
  }

  async function status(command) {
    if (command.missionId) return clone(missionFrom(state, command.missionId));
    return clone(state.missions);
  }

  async function handleCommand(command = {}) {
    const type = command.type;
    switch (type) {
      case 'mission.plan': return createPlan(command);
      case 'mission.execute': return execute(command);
      case 'mission.steer': return withMission(command, (mission, id) => adapter.steer(id, command.text ?? command.instruction ?? ''), 'mission.steered');
      case 'mission.interrupt': return withMission(command, async (mission, id) => {
        const result = await adapter.interrupt(id);
        mission.status = 'interrupted';
        persist();
        return result;
      }, 'mission.interrupted');
      case 'mission.resume': return resume(command);
      case 'mission.fork': return withMission(command, async (mission, id) => {
        const result = await adapter.fork(id);
        mission.forkThreadId = result?.threadId;
        persist();
        return result;
      }, 'mission.forked');
      case 'mission.revert': return withMission(command, (mission, id) => adapter.revert(id, command.ref ?? command.checkpoint), 'mission.reverted');
      case 'mission.review': return withMission(command, async (mission, id) => {
        const choice = mission.choice;
        const reviewChoice = typeof chooseReviewModel === 'function' ? chooseReviewModel(choice) : undefined;
        const result = await adapter.review(id, command.diff ?? '', reviewChoice);
        mission.review = { choice: reviewChoice, result: clone(result), reviewedAt: now() };
        persist();
        return result;
      }, 'mission.reviewed');
      case 'status': return status(command);
      default: throw new Error(`UNKNOWN_BRIDGE_COMMAND: ${String(type)}`);
    }
  }

  return Object.freeze({
    handleCommand,
    setConnectionState(value) {
      connected = value !== false;
      if (!connected) emit({ type: 'blocked', need: '打开本机桥', reason: 'BRIDGE_OFFLINE' });
      else emit({ type: 'bridge.connected' });
      return connected;
    },
    isConnected: () => connected,
    getState: () => clone(state),
    close: () => adapter.close?.(),
  });
}
