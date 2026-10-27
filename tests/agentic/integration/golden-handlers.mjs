// S2D-W13 · M22 黄金场景 handler（brief §5 场景 1–7，node 侧；plan.md §G5）。
//
// 定位：把 brief §5 的场景端点（golden-scenarios.test.mjs 的冻结路径）接到
// **真实流模块**——W1 block-store 路由/store、W3 mission 状态机/store、
// W4 evaluateAction/SideEffectFence/ConfirmationStore/AuditLog、W6 preview
// store/routes/patch-apply、W7 createAgentRuntime/createRuntimeStore、
// W9 artifact-store/acceptance/verifier(saveVerdict+verify)/need-store、
// W10 observability store/spans、W12 perception store + harness vision mock——
// 全部经 M13 组合根的同一 db/确定性 clock/idGen/events/traceSink/policyPort
// 接线。本模块不实现任何流域语义的替代品；场景特有的编排（端点形状、家庭
// 版本链、设备 ack 台账、crash 注入）在头注逐条声明。
//
// 场景端点 → 真实模块映射（golden-scenarios.json 为验收规格）：
//  §5.1/§5.6 blocks：GET /api/blocks[?from&to]、POST /api/blocks/sync = W1
//    createBlockRoutes 原样挂载（含 x-tango-client/origin 护栏、逐条冲突、
//    幂等重放、原子批）。**设备 ack 台账**（场景层增量同步编排）：服务端按
//    principal.device 记录每台设备最后确认的 cursor；PUSH 批的 baseRevision
//    落后该设备 ack 时，非重放形状的 change 降级为 conflict（不覆盖先写），
//    纯重放（base=prior.revision-1 且九字段内容一致，镜像 store contentFields）
//    原样放行——断线重放保持幂等。放行/降级判定后把（可能裁剪的）批经 shim
//    req/res 喂给 W1 真路由，merge 冲突后一次写回真实响应。
//  §5.2 captures：POST /api/captures {fixture} = W12 createPerceptionStore
//    .insertCapture + harness vision mock（pipeline.start 契约）→ 扫描卡经
//    W6 createPreviewStore.put 落为场景任务（默认 m-g2）的 Preview v1；
//    GET /api/captures/:id/scan 回读（owner 隔离）。preview/discuss/timeline
//    = W6 createPreviewRoutes 原样挂载；parsePatch 注入场景确定性规则表
//    （W6 工厂的显式扩展位），「时长 N 秒/旁白去掉第一句」→ boundary.wont.add
//    （apply.mjs 词表内唯一可忠实表达的表示；秒不在 LENGTH_UNIT_RENDERERS，
//    不做单位换算编造）。
//  §5.3 contracts/actions：POST /api/contracts/:id/sign 落 contract.schema
//    合同 + W3 mission（state=contracted）+ 内存 grant（active、TTL、actor/
//    resolvedModel 绑定）。POST /api/actions/:confirmationId/confirm：先 W4
//    evaluateAction（grant 过期 → GRANT_EXPIRED 拒绝；跨 owner → 无合同 →
//    404 NOT_FOUND 不泄露存在性）→ needs_confirmation 后经 W4
//    ConfirmationStore（issue/consume 一次性令牌，重复 = CONFIRMATION_REPLAY）
//    + SideEffectFence(phase=execution) 审计确认轨迹，确认后经 harness 副作用
//    台账执行恰好一次。POST /api/actions/:id/execute A5 → SideEffectFence
//    phase=P0 → A5_NEVER_AUTOMATIC，零副作用。
//  §5.4 missions/runs：POST /api/missions 落 W3 store（mission.schema）；
//    POST /api/missions/:id/state 把场景状态 admitted/planning/ready 映射为
//    W3 冻结状态机的 scan/preview/contract 事件（真实 transitionMission +
//    updateMission + appendEvent；场景事件 mission.state 另行入 events）。
//    POST /api/missions/:id/runs、POST /api/runs/:id/resume = W7
//    createAgentRuntime（policyPort=M13 createW4PolicyPort 桥 + W7 动作形状
//    适配（run.start/run.resume/model.call → risk:observe+A3），clock=
//    adaptClockForRuntime，spanSink=traceSink.forOwner → W10 obs_spans，
//    store=createRuntimeStore，modelCaller=harness 假 transport）。crashAtStep
//    = 场景注入：该步外部动作落账后 {pause,checkpoint}；恢复重跑该步时外部
//    动作按 (runId,stepId) 幂等去重（outbox 语义）。exhaustAfter = 预算演示：
//    workOrder.budget.calls=exhaustAfter，步内循环 modelCall 直至
//    BUDGET_EXCEEDED 抛出 → 读回 store 步检查点 → 409 BUDGET_EXCEEDED 信封。
//    model:null = transport 返回无模型归属 → 引擎记 UNKNOWN（无 WorkResult、
//    不自动重试——resolved_model=NULL 永不变真实成功，红线 7）。
//  §5.5 artifacts：POST /api/artifacts {version,content} = W9
//    artifact-store.put（首个或家庭链关闭时新工件；链开放时续版本）。
//    verify = W9 verifier verify()（注入确定性 checkers）+ saveVerdict 落
//    w9_verdicts/checks。accept/revise = W9 createAcceptance.record（真实
//    状态机：ready 才可验收、accepted/rejected 关链、revision_requested 开链
//    且场景随后 put 修订草稿（generating）——「修订请求必须先产出新版本」的
//    场景具体化，同时把修订请求投影为 W9 need（createNeed）。版本链端点返回
//    场景**家庭链**（同一 owner 场景工件族的全部真实版本，按落账序）；
//    benefit = 显式查 w9_acceptances + w9_verdicts/checks → M16
//    projectAcceptedBenefit（owner/actor=user:owner/decision/verdict 门禁，
//    revision_requested、UNKNOWN/HIGH 未决、跨 owner 均不计）。跨 owner 读经
//    真实 store.get → 404。
//  §5.7 runs trace：POST /api/runs/:id/trace = W10 store.upsertRun +
//    traceSink 落 model.resolved span（真实 obs_spans，attributes 带 actor/
//    resolvedModel/modelSource/stale/conflicting/status）+ 逐 actor 经 M16
//    projectModelProvenance（NULL→UNKNOWN、stale/conflict→至多 PROVISIONAL、
//    绝不升级）；GET /api/runs/:id/matrix 从 obs_spans 显式查询回放行。
//    run/actor/model/gate/latency/cost 六类指标事件入组合根 events。
//
// 红线自守（与 harness 相同标准）：无 Date.now/无参 new Date()/无 process.env/
// 无 fetch/无子进程；时间戳一律 context.clock（Date 构造只用于 epoch→对象换算
// 供 W4 AuditLog/ConfirmationStore 的 Date 形状时钟）；网络零外呼；所有 owner
// 取自 dispatcher env.principal（服务端会话），绝不读 body 内 owner 字段。

import { createHash } from 'node:crypto';
import { contractHash } from '../../../scripts/agentic/contracts.mjs';
import { ERROR_STATUS } from '../../../scripts/agentic/integration/dispatcher.mjs';
import {
  adaptClockForRuntime,
  adaptPolicyPortForRuntime,
  createW4PolicyPort,
} from '../../../scripts/agentic/integration/context.mjs';
import { projectAcceptedBenefit, projectModelProvenance } from '../../../scripts/agentic/integration/projection.mjs';
import { createBlockRoutes, createBlocksStore } from '../../../scripts/agentic/block-store/index.mjs';
import { createMissionStore } from '../../../scripts/agentic/mission/store.mjs';
import { transitionMission } from '../../../scripts/agentic/mission/state-machine.mjs';
import { evaluateAction } from '../../../scripts/agentic/autonomy/policy.mjs';
import { SideEffectFence } from '../../../scripts/agentic/autonomy/side-effect-fence.mjs';
import { ConfirmationStore } from '../../../scripts/agentic/autonomy/confirmation.mjs';
import { AuditLog, createDatabaseAuditWriter } from '../../../scripts/agentic/autonomy/audit.mjs';
import { createPreviewRoutes } from '../../../scripts/agentic/preview/routes.mjs';
import { createPreviewStore } from '../../../scripts/agentic/preview/store.mjs';
import { createPerceptionStore } from '../../../scripts/agentic/perception/store.mjs';
import { createAgentRuntime } from '../../../scripts/agentic/runtime/engine.mjs';
import { createRuntimeStore } from '../../../scripts/agentic/runtime/store.mjs';
import { createArtifactStore, } from '../../../scripts/agentic/delivery/artifact-store.mjs';
import { createAcceptance } from '../../../scripts/agentic/delivery/acceptance.mjs';
import { verify as verifyArtifact } from '../../../scripts/agentic/verifier/engine.mjs';
import { saveVerdict } from '../../../scripts/agentic/verifier/verdict.mjs';
import { createNeedStore } from '../../../scripts/agentic/inbox/need-store.mjs';
import { createObservabilityStore } from '../../../scripts/agentic/observability/store.mjs';
import { fileURLToPath } from 'node:url';

const SCHEMA_DIR = fileURLToPath(new URL('../../../contracts/agentic/', import.meta.url));
const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };

// ---------------- 冻结信封 helpers（M14 ERROR_STATUS 唯一来源） ----------------

function send(res, status, body) {
  if (!res.headersSent) res.writeHead(status, JSON_HEADERS);
  if (!res.writableEnded) res.end(JSON.stringify(body));
}

function apiError(res, code, message, details) {
  const known = code in ERROR_STATUS;
  const finalCode = known ? code : 'INTERNAL_ERROR';
  const envelope = { error: { code: finalCode, message: known && message ? message : (finalCode === 'INTERNAL_ERROR' ? 'internal error' : finalCode) } };
  if (details !== undefined) envelope.error.details = details;
  send(res, ERROR_STATUS[finalCode], envelope);
}

function ok(res, body) {
  send(res, 200, body);
}

// ---------------- §5.1 / §5.6 blocks（W1 真路由 + 设备 ack 台账） ----------------

// 镜像 block-store/store.mjs contentFields 的九个规范内容字段（重放判定的
// 内容一致性；不复制实现，只复制字段表）。
const BLOCK_CONTENT_FIELDS = ['date', 'start', 'end', 'title', 'kind', 'prio', 'note', 'done', 'source'];

function blockContentEquals(block, prior) {
  if (block === null || typeof block !== 'object' || prior === null || typeof prior !== 'object') return false;
  return BLOCK_CONTENT_FIELDS.every(field => {
    const left = field === 'done' ? block[field] === true : block[field];
    const right = field === 'done' ? prior[field] === true : prior[field];
    return left === right || (left == null && right == null);
  });
}

/** 纯重放形状：base = 服务端 revision-1 且九字段内容一致（W1 store 重放语义）。 */
function isReplayShape(change, prior) {
  if (!prior) return false;
  if (change.deleted === true) return prior.deleted_at != null && change.baseRevision === prior.revision - 1;
  return change.baseRevision === prior.revision - 1 && blockContentEquals(change.block, prior);
}

/** 捕获 W1 路由写出的响应（writeHead().end() 链式 + 裸 end 两种路径）。 */
function captureResponse() {
  const state = { status: 0, headers: {}, body: '', ended: false };
  const res = {
    get headersSent() { return state.status !== 0; },
    get writableEnded() { return state.ended; },
    get destroyed() { return false; },
    writeHead(status, headers) {
      state.status = status;
      state.headers = { ...(headers ?? {}) };
      return { end: payload => { state.ended = true; state.body = String(payload ?? ''); } };
    },
    end(payload) {
      state.ended = true;
      if (payload !== undefined) state.body = String(payload);
    },
  };
  return { res, state };
}

function createBlocksHandler({ context, requestAllowed }) {
  const store = createBlocksStore({ db: context.db, now: context.clock.now });
  const blockRoutes = createBlockRoutes({
    store,
    authenticate: req => context.auth(req),
    requestAllowed,
    now: context.clock.now,
  });
  const ackByDevice = new Map(); // device → 该设备最后确认的 cursor

  return async function blocksHandler(req, res, pathname, env) {
    const path = pathname.split('?')[0];
    if (path !== '/api/blocks' && !path.startsWith('/api/blocks/')) return false;
    if (req.method !== 'POST' || path !== '/api/blocks/sync') {
      return blockRoutes(req, res, pathname); // GET 与未知子路径：W1 原样（未读体原样可用）
    }
    // POST /api/blocks/sync：设备 ack 门 → 裁剪 → W1 真路由（shim req/res）
    let body;
    try {
      body = await env.readBody();
    } catch (error) {
      apiError(res, error?.code ?? 'CONTRACT_INVALID', error?.message ?? 'invalid body', error?.details);
      return true;
    }
    if (body === null || typeof body !== 'object' || !Number.isInteger(body.baseRevision) || !Array.isArray(body.changes)) {
      apiError(res, 'CONTRACT_INVALID', 'sync body must be { baseRevision, changes[] }');
      return true;
    }
    const ownerId = env.principal.id ?? env.principal.ownerId;
    const device = typeof env.principal.device === 'string' && env.principal.device !== ''
      ? env.principal.device
      : ownerId;
    const ack = ackByDevice.get(device) ?? null;
    const current = new Map(store.changesSince(ownerId, 0).changes.map(entry => [entry.block.id, entry.block]));
    const kept = [];
    const staleConflicts = [];
    if (ack !== null && body.baseRevision < ack) {
      context.events.emit({
        type: 'sync.stale_base_observed',
        ownerId,
        device,
        declaredBase: body.baseRevision,
        acknowledgedCursor: ack,
        at: context.clock.now(),
      });
      for (const change of body.changes) {
        if (isReplayShape(change, current.get(change.id))) kept.push(change);
        else staleConflicts.push({ id: change.id, block: current.get(change.id) ?? null });
      }
    } else {
      kept.push(...body.changes);
    }
    const payload = JSON.stringify({ baseRevision: body.baseRevision, changes: kept });
    const fakeReq = {
      method: 'POST',
      headers: { ...req.headers, 'content-length': String(Buffer.byteLength(payload)) },
      url: req.url,
      async *[Symbol.asyncIterator]() { yield Buffer.from(payload); },
    };
    const { res: shim, state } = captureResponse();
    await blockRoutes(fakeReq, shim, pathname);
    let parsed = null;
    try { parsed = JSON.parse(state.body); } catch { parsed = null; }
    if (parsed === null || typeof parsed !== 'object' || !('applied' in parsed)) {
      // W1 路由的原始（错误）响应：逐字节回放，不改语义。
      if (!res.headersSent) res.writeHead(state.status || 500, state.headers);
      if (!res.writableEnded) res.end(state.body);
      return true;
    }
    if (staleConflicts.length > 0) {
      const ids = new Set(parsed.conflicts.map(conflict => conflict.id));
      for (const conflict of staleConflicts) if (!ids.has(conflict.id)) parsed.conflicts.push(conflict);
    }
    if (state.status === 200 && Number.isFinite(parsed.cursor)) {
      ackByDevice.set(device, parsed.cursor);
    }
    send(res, state.status, parsed);
    return true;
  };
}

// ---------------- §5.2 perception→preview（W12 store + vision mock + W6 真路由） ----------------

/** 场景确定性 parsePatch（W6 工厂显式注入位；无 LLM、无 IO）。 */
export function createScenarioParsePatch() {
  return function scenarioParsePatch(utterance) {
    if (typeof utterance !== 'string' || utterance.length === 0) return { patch: null, origin: 'none' };
    const wont = [];
    const duration = utterance.match(/时长[^，,。]*?(\d+(?:\.\d+)?)\s*秒/);
    if (duration) wont.push(`时长超过 ${duration[1]} 秒`);
    if (/旁白[^，,。]*去掉[^，,。]*第一句/.test(utterance)) wont.push('旁白第一句');
    if (wont.length === 0) return { patch: null, origin: 'none' };
    return { patch: { boundary: { wont: { add: wont } } }, origin: 'rules' };
  };
}

/** 从扫描卡构造 schema-valid 最小 Preview（preview.schema.json 全必填字段）。 */
function previewFromScanCard({ missionId, card }) {
  return {
    missionId,
    version: 1,
    confidence: 0.8,
    shape: { kind: 'capture-scan', title: typeof card?.title === 'string' && card.title !== '' ? card.title : '现场扫描', blocks: [{ type: 'card' }] },
    storyboard: [],
    narration: '',
    boundary: { will: [], wont: [], needs: [], budget: 'scan-preview' },
    samples: [],
    reel: { composition: `scan:${card?.captureId ?? 'capture'}`, durationSec: 1, narrationAudio: 'none', mp4: null },
    scene: { status: 'off', model: 'wan2.7-t2v', url: null },
  };
}

function createPerceptionPreviewHandler({ context, vision, scanMissionId }) {
  const perceptionStore = createPerceptionStore({ db: context.db, now: context.clock.now });
  const previewStore = createPreviewStore(context.db, { now: context.clock.now });
  const scanCards = new Map(); // captureId → { status, card, attribution }（vision done 终态快照）

  return [
    async function capturesHandler(req, res, pathname, env) {
      const path = pathname.split('?')[0];
      if (path === '/api/captures' && req.method === 'POST') {
        const body = await env.readBody();
        const fixture = body?.fixture;
        if (typeof fixture !== 'string' || fixture === '') {
          apiError(res, 'CONTRACT_INVALID', 'fixture (non-empty string) required');
          return true;
        }
        const ownerId = env.principal.id ?? env.principal.ownerId;
        const now = context.clock.now();
        const capture = perceptionStore.insertCapture({
          ownerId, kind: 'image', capturedAt: now, uploadedAt: now,
          storedPath: fixture, keepOriginal: false, exifStripped: true, status: 'processing',
        });
        const job = {
          captureId: capture.id, ownerId, kind: 'photo', path: fixture,
          mimeType: 'image/png', capturedAt: now, uploadedAt: now, blocks: [],
          emit: (type, card) => {
            context.events.emit({ type: `vision.${type}`, captureId: capture.id, ownerId, card: card ?? null, at: context.clock.now() });
          },
        };
        const started = vision.start(job);
        const done = await started.done;
        scanCards.set(capture.id, { status: done?.status ?? 'unknown', card: done?.card ?? null, attribution: started.attribution ?? null });
        const previewRow = await previewStore.put({
          ownerId, missionId: scanMissionId, preview: previewFromScanCard({ missionId: scanMissionId, card: done?.card ?? null }),
        });
        context.events.emit({
          type: 'scan.preview_persisted', ownerId, captureId: capture.id,
          missionId: scanMissionId, previewVersion: previewRow.version, at: context.clock.now(),
        });
        ok(res, { captureId: capture.id, status: done?.status ?? 'unknown', scanUrl: `/api/captures/${capture.id}/scan`, preview: { missionId: scanMissionId, version: previewRow.version } });
        return true;
      }
      const scanMatch = req.method === 'GET' ? /^\/api\/captures\/([^/]+)\/scan$/.exec(path) : null;
      if (scanMatch) {
        const capture = perceptionStore.getCapture(env.principal.id ?? env.principal.ownerId, decodeURIComponent(scanMatch[1]));
        if (!capture) { apiError(res, 'NOT_FOUND', 'capture not found'); return true; }
        ok(res, { capture, vision: scanCards.get(capture.id) ?? { status: 'pending', card: null } });
        return true;
      }
      return false;
    },
    async function previewHandler(req, res, pathname) {
      // W6 真路由原样（auth 经组合根 forPreview 形状；now 注入确定性时钟）。
      const routes = createPreviewRoutes({
        db: context.db,
        auth: reqArg => context.auth(reqArg),
        parsePatch: createScenarioParsePatch(),
        now: context.clock.now,
      });
      return routes(req, res, pathname);
    },
  ];
}

// ---------------- 共享：contract/grant/workOrder 构造（schema-valid） ----------------

function hoursFromNow(now, hours) {
  return new Date(Date.parse(now()) + hours * 3600 * 1000).toISOString();
}

async function buildScenarioContract({ id, missionId, ownerId, goal, now, capabilities }) {
  const stamp = now();
  const contract = {
    id, ownerId, revision: 1, schemaVersion: 1,
    createdAt: stamp, updatedAt: stamp, deletedAt: null, source: 'real',
    missionId, version: 1, hash: 'pending',
    goal,
    deliverables: [{ type: 'report', shape: {}, location: { uri: `/evidence/${id}` } }],
    definitionOfDone: ['交付物可读且无未决核验'],
    autonomy: 'A3',
    will: ['整理并交付'],
    wont: ['读取邮箱'],
    needs: [],
    capabilities,
    dataDisclosure: [],
    budget: { modelCalls: 1000, tokens: 1_000_000, costCap: null, localSlots: 0 },
    window: { prepStart: stamp, start: stamp, end: hoursFromNow(now, 24), overrun: 'deliver_best' },
    interruption: 'needs_only',
  };
  contract.hash = await contractHash(contract);
  return contract;
}

// ---------------- §5.3 autonomy fence（W4 真模块） ----------------

const W4_BLOCKED_HTTP = Object.freeze({
  GRANT_EXPIRED: 403, GRANT_INACTIVE: 403, GRANT_ACTOR_MISMATCH: 403,
  GRANT_ACTOR_MODEL_MISMATCH: 403, GRANT_CONTRACT_MISMATCH: 403,
  A5_NEVER_AUTOMATIC: 403, AUTONOMY_TOO_HIGH: 403, AUTONOMY_TOO_LOW: 403,
  SCOPE_DENIED: 403, WINDOW_OUTSIDE: 403, BUDGET_EXCEEDED: 409, OWNER_MISMATCH: 403,
  CONTRACT_REQUIRED: 403, CONTEXT_INVALID: 400, AUTONOMY_ACTION_INVALID: 400,
  ACTOR_MODEL_UNKNOWN: 403,
});

function createContractsHandler({ context, sideEffectLedger, grantTtlSeconds }) {
  const missionStore = createMissionStore(context.db);
  const audit = new AuditLog({
    writer: createDatabaseAuditWriter(context.db),
    clock: () => new Date(context.clock.nowMs()),
  });
  const fenceExecution = new SideEffectFence({ audit, phase: 'execution', clock: () => new Date(context.clock.nowMs()) });
  const fenceP0 = new SideEffectFence({ audit, phase: 'P0', clock: () => new Date(context.clock.nowMs()) });
  const confirmations = new ConfirmationStore({ clock: () => new Date(context.clock.nowMs()) });
  const tokensByConfirmation = new Map();
  // ownerId → { contract, grant, mission }（服务端会话派生，绝不读 body owner）
  const signedByOwner = new Map();
  const ACTOR = Object.freeze({ actorId: 'w13·golden-a4', resolvedModel: 'golden-a4-model' });

  async function sign(req, res, pathname, env) {
    const match = /^\/api\/contracts\/([^/]+)\/sign$/.exec(pathname.split('?')[0]);
    if (!match || req.method !== 'POST') return false;
    const body = await env.readBody();
    if (typeof body?.goal !== 'string' || body.goal === '') {
      apiError(res, 'CONTRACT_INVALID', 'goal (non-empty string) required');
      return true;
    }
    const ownerId = env.principal.ownerId;
    const contractId = decodeURIComponent(match[1]);
    const missionId = `m-${contractId}`;
    const mission = {
      id: missionId, ownerId, revision: 1, schemaVersion: 1, blockId: `blk-${contractId}`,
      goal: body.goal, state: 'contracted', autonomy: 'A3',
      scanId: null, previewId: null, contractId: null, contractHash: null,
      blockedReason: null, resumeState: null, confirmedContractHash: null,
      createdAt: context.clock.now(), updatedAt: context.clock.now(), deletedAt: null,
    };
    const contract = await buildScenarioContract({
      id: contractId, missionId, ownerId, goal: body.goal, now: context.clock.now,
      capabilities: [{ capability: 'email.send', scope: 'mission' }],
    });
    const grant = {
      ownerId, status: 'active', actor: ACTOR.actorId, resolvedModel: ACTOR.resolvedModel,
      expiresAt: hoursFromNow(context.clock.now, grantTtlSeconds / 3600),
      contractHash: contract.hash, capabilities: ['email.send'],
    };
    missionStore.saveMission(mission);
    signedByOwner.set(ownerId, { contract, grant, mission });
    audit.grantIssued({ actorId: ACTOR.actorId, resolvedModel: ACTOR.resolvedModel, grantId: `grant-${contractId}`, contractHash: contract.hash });
    context.events.emit({ type: 'contract.signed', ownerId, contractId, missionId, expiresAt: grant.expiresAt, at: context.clock.now() });
    ok(res, { contractId, missionId, hash: contract.hash, expiresAt: grant.expiresAt, grant: { status: grant.status, actor: grant.actor, capabilities: grant.capabilities } });
    return true;
  }

  async function confirm(req, res, pathname, env) {
    const match = /^\/api\/actions\/([^/]+)\/confirm$/.exec(pathname.split('?')[0]);
    if (!match || req.method !== 'POST') return false;
    const confirmationId = decodeURIComponent(match[1]);
    const body = await env.readBody();
    const actionName = typeof body?.action === 'string' && body.action !== '' ? body.action : null;
    const requestedAutonomy = body?.kind === 'A5' ? 'A5' : 'A4';
    if (actionName === null || !['A4', 'A5'].includes(body?.kind)) {
      apiError(res, 'CONTRACT_INVALID', 'body must be { kind: A4|A5, action, ... }');
      return true;
    }
    const ownerId = env.principal.ownerId;
    const signed = signedByOwner.get(ownerId);
    if (!signed) { apiError(res, 'NOT_FOUND', 'no contract signed for this owner'); return true; }
    const w4Action = {
      type: actionName, risk: 'external', requestedAutonomy,
      capability: actionName, scope: `mission/${signed.mission.id}`,
      ownerId, actor: ACTOR,
    };
    // ① W4 policy：grant 有效性（过期/失效/越权）在任何确认之前裁决。
    //    AUTONOMY_TOO_HIGH 对 A4 请求不是硬拒：mission 的自主上限（schema 枚举
    //    A1–A3）从不包含 A4——A4 天然超出自主授权，唯一通路就是人工逐次确认
    //    （SideEffectFence 的 needs_human，即 needs_confirmation 语义）。其余
    //    blocked 码（GRANT_EXPIRED/GRANT_INACTIVE/SCOPE_DENIED/…）硬拒。
    const policyDecision = evaluateAction(
      { mission: signed.mission, contract: signed.contract, grant: signed.grant, ownerId, action: w4Action },
      { now: context.clock.now() },
    );
    const a4NeedsHuman = requestedAutonomy === 'A4' && policyDecision.status === 'blocked' && policyDecision.code === 'AUTONOMY_TOO_HIGH';
    if (policyDecision.status !== 'needs_confirmation' && !a4NeedsHuman) {
      const status = W4_BLOCKED_HTTP[policyDecision.code] ?? 403;
      const code = status === 409 ? 'BUDGET_EXCEEDED' : 'FORBIDDEN';
      audit.policyDenied({ actorId: ACTOR.actorId, code: policyDecision.code, ownerId });
      context.events.emit({ type: 'action.rejected', ownerId, confirmationId, code: policyDecision.code, at: context.clock.now() });
      apiError(res, code, policyDecision.code === 'BUDGET_EXCEEDED' ? 'budget exceeded' : 'action denied by policy', { internalCode: policyDecision.code });
      return true;
    }
    // ② W4 fence（execution 相位）：A4 external → needs_human（真实判定 + 审计）。
    const fenceDecision = await fenceExecution.check({ id: confirmationId, risk: 'external', requestedAutonomy, actor: ACTOR });
    if (fenceDecision.status !== 'needs_human') {
      context.events.emit({ type: 'action.rejected', ownerId, confirmationId, code: fenceDecision.code, at: context.clock.now() });
      apiError(res, 'FORBIDDEN', 'fence denied the action', { internalCode: fenceDecision.code });
      return true;
    }
    // ③ 一次性确认令牌：首次签发并即刻消费；重复 = CONFIRMATION_REPLAY。
    let token = tokensByConfirmation.get(confirmationId);
    if (token === undefined) {
      const issued = confirmations.issue({
        actionId: confirmationId, actor: ACTOR, contractHash: signed.contract.hash,
        action: w4Action, now: context.clock.now(), ttlMs: 300_000,
      });
      token = issued.token;
      tokensByConfirmation.set(confirmationId, token);
      audit.confirmationIssued({ actorId: ACTOR.actorId, actionId: confirmationId, resolvedModel: ACTOR.resolvedModel });
    }
    const consumed = confirmations.consume(token, {
      actionId: confirmationId, actor: ACTOR, contractHash: signed.contract.hash,
      action: w4Action, now: context.clock.now(),
    });
    if (consumed.status !== 'confirmed') {
      audit.confirmationRejected({ actorId: ACTOR.actorId, actionId: confirmationId, code: consumed.code });
      context.events.emit({ type: 'action.rejected', ownerId, confirmationId, code: consumed.code, at: context.clock.now() });
      apiError(res, 'CONFLICT', 'confirmation already consumed or bound to another action', { internalCode: consumed.code });
      return true;
    }
    audit.confirmationConsumed({ actorId: ACTOR.actorId, actionId: confirmationId, resolvedModel: ACTOR.resolvedModel });
    // ④ 人工确认后的 A4 执行：经 harness 副作用台账（唯一外部效果端口）恰好一次。
    const effect = await sideEffectLedger.perform(actionName, { confirmationId, contractId: signed.contract.id, goal: signed.contract.goal });
    context.events.emit({ type: 'action.executed', ownerId, confirmationId, kind: actionName, effectId: effect.effectId, at: context.clock.now() });
    ok(res, { confirmed: true, confirmationId, effect: { effectId: effect.effectId, kind: effect.kind, at: effect.at } });
    return true;
  }

  async function autoExecute(req, res, pathname, env) {
    const match = /^\/api\/actions\/([^/]+)\/execute$/.exec(pathname.split('?')[0]);
    if (!match || req.method !== 'POST') return false;
    const body = await env.readBody();
    const actionName = typeof body?.action === 'string' && body.action !== '' ? body.action : null;
    if (actionName === null || body?.kind !== 'A5') {
      apiError(res, 'CONTRACT_INVALID', 'body must be { kind: A5, action, ... }');
      return true;
    }
    const actor = { actorId: 'w13·golden-a5', resolvedModel: 'golden-a5-model' };
    const decision = await fenceP0.check({ id: decodeURIComponent(match[1]), risk: 'financial', requestedAutonomy: 'A5', actor });
    context.events.emit({ type: 'action.rejected', ownerId: env.principal.ownerId, confirmationId: decodeURIComponent(match[1]), code: decision.code, at: context.clock.now() });
    apiError(res, 'FORBIDDEN', 'A5 is never automatic', { internalCode: decision.code });
    return true;
  }

  return async function contractsHandler(req, res, pathname, env) {
    if (await sign(req, res, pathname, env)) return true;
    if (await confirm(req, res, pathname, env)) return true;
    if (await autoExecute(req, res, pathname, env)) return true;
    return false;
  };
}

// ---------------- §5.4 mission lifecycle + W7 runtime（crash/预算/NULL 模型） ----------------

const RUNTIME_ACTOR = 'w13·golden-runtime';
const SCENARIO_TO_W3_EVENT = Object.freeze({
  admitted: { event: 'scan', contextKey: 'scanId', idPrefix: 'scan' },
  planning: { event: 'preview', contextKey: 'previewId', idPrefix: 'preview' },
  ready: { event: 'contract', contextKey: 'contractId', idPrefix: 'contract' },
});

function createMissionsRuntimeHandler({ context, modelTransport, sideEffectLedger }) {
  const missionStore = createMissionStore(context.db);
  const runtimeStore = createRuntimeStore({ db: context.db, now: context.clock.now });
  const contractByMission = new Map(); // missionId → { contract, grant }

  function runtimeFor(ownerId, missionBundle) {
    // W7 引擎把 run 注册表放在实例闭包内：同一 mission 的 run/resume 必须落到
    // 同一实例（跨请求复用；SQLite 台账在 store，内存 run 态在此）。
    if (missionBundle.runtime) return missionBundle.runtime;
    const policyPort = createW4PolicyPort({
      phase: 'P0',
      clock: context.clock,
      // M13 桥的契约：resolvePolicyInput 只供 mission/contract/grant 上下文，
      // action 一律取调用方原值（桥内 {...resolved, action}）。W7 的 runtime 动作
      // 形状（{type, autonomy}，无 risk/requestedAutonomy）在进桥之前先适配成
      // W4 evaluateAction 形状——适配在外层 check 里做，不进 resolvePolicyInput。
      resolvePolicyInput: () => ({
        mission: missionBundle.mission,
        contract: missionBundle.contract,
        grant: missionBundle.grant,
      }),
    });
    const rawBridgeCheck = policyPort.check.bind(policyPort);
    policyPort.check = (ctx, action) => {
      const type = typeof action?.type === 'string' && action.type !== '' ? action.type : 'run.start';
      const adapted = {
        type, risk: 'observe',
        requestedAutonomy: typeof action?.autonomy === 'string' ? action.autonomy : 'A3',
        capability: type, scope: `mission/${missionBundle.mission.id}`,
        ownerId: typeof ctx?.ownerId === 'string' ? ctx.ownerId : ownerId,
        actor: { actorId: RUNTIME_ACTOR, resolvedModel: missionBundle.grant.resolvedModel },
      };
      const result = rawBridgeCheck(ctx, adapted);
      // W7 引擎把显式拒绝收敛为 failed outcome（原因留在 policyDenial.error）；
      // 场景证据轨迹要求拒绝可见：补一条 policy.denied 事件（不改变裁决）。
      if (result && result.allowed !== true) {
        context.events.emit({
          type: 'policy.denied', runId: ctx?.runId ?? null, ownerId,
          actionType: type, reason: result.reason ?? 'POLICY_UNKNOWN_OUTCOME',
          at: context.clock.now(),
        });
      }
      return result;
    };
    const runtime = createAgentRuntime({
      policyPort: adaptPolicyPortForRuntime(policyPort),
      modelCaller: modelTransport,
      spanSink: context.traceSink.forOwner(ownerId),
      clock: adaptClockForRuntime(context.clock),
      store: runtimeStore,
      schemaDir: SCHEMA_DIR,
    });
    missionBundle.runtime = runtime;
    return runtime;
  }

  /** 场景 steps：modelCall（模型归属）+ external.send（幂等台账）+ crash/预算注入。
   *  step id 带 orderId 前缀：W7 store 的步台账按 id 键控，跨 run 的同名步会
   *  撞行（illegal transition）；同一 owner 多个 run 必须步 id 唯一。
   *  crash 注入只触发一次：恢复重跑该步视为进程已从检查点续起，正常完成。 */
  function buildSteps({ orderId, count, crashAtStep, budgetLoop, maxAttempts }) {
    const sentSteps = new Set();
    const pausedOnce = new Set();
    const steps = [];
    for (let index = 1; index <= count; index += 1) {
      const id = `${orderId}-s${index}`;
      steps.push({
        id, name: `golden step ${index}`, kind: 'execute', input: { step: index },
        execute: async stepCtx => {
          if (budgetLoop) {
            for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
              await stepCtx.modelCall({ prompt: `budget attempt ${attempt}` }, { autonomy: 'A3', capability: 'model.call' });
            }
            return { ok: true };
          }
          const call = await stepCtx.modelCall({ prompt: `step ${index}` }, { autonomy: 'A3', capability: 'model.call' });
          if (!sentSteps.has(id)) {
            sentSteps.add(id);
            await sideEffectLedger.perform('external.send', { orderId, stepId: id, model: call?.model ?? null });
          }
          if (index === crashAtStep && !pausedOnce.has(id)) {
            pausedOnce.add(id);
            return { pause: true, checkpoint: { next: id, doneSteps: steps.slice(0, index - 1).map(step => step.id), reason: 'crash-injection' } };
          }
          return { ok: true };
        },
      });
    }
    return steps;
  }

  async function createMission(req, res, pathname, env) {
    if (req.method !== 'POST' || pathname.split('?')[0] !== '/api/missions') return false;
    const body = await env.readBody();
    if (typeof body?.goal !== 'string' || body.goal === '') {
      apiError(res, 'CONTRACT_INVALID', 'goal (non-empty string) required');
      return true;
    }
    const ownerId = env.principal.ownerId;
    const now = context.clock.now();
    const mission = {
      id: context.idGen.next('mission'), ownerId, revision: 1, schemaVersion: 1,
      blockId: context.idGen.next('blk'), goal: body.goal, state: 'draft', autonomy: 'A3',
      scanId: null, previewId: null, contractId: null, contractHash: null,
      blockedReason: null, resumeState: null, confirmedContractHash: null,
      createdAt: now, updatedAt: now, deletedAt: null,
    };
    const result = missionStore.saveMission(mission);
    if (!result.ok) { apiError(res, 'CONTRACT_INVALID', result.error?.message ?? 'mission rejected'); return true; }
    context.events.emit({ type: 'mission.created', ownerId, missionId: mission.id, at: context.clock.now() });
    ok(res, { id: mission.id, mission });
    return true;
  }

  async function transitionState(req, res, pathname, env) {
    const match = /^\/api\/missions\/([^/]+)\/state$/.exec(pathname.split('?')[0]);
    if (!match || req.method !== 'POST') return false;
    const body = await env.readBody();
    const scenarioState = body?.to;
    const mapping = SCENARIO_TO_W3_EVENT[scenarioState];
    if (!mapping) { apiError(res, 'CONTRACT_INVALID', 'to must be one of admitted|planning|ready'); return true; }
    const ownerId = env.principal.ownerId;
    const missionId = decodeURIComponent(match[1]);
    const mission = missionStore.getMission(ownerId, missionId);
    if (!mission) { apiError(res, 'NOT_FOUND', 'mission not found'); return true; }
    const artifactId = `${mapping.idPrefix}-${missionId}`;
    const transitionContext = { now: context.clock.now(), [mapping.contextKey]: artifactId };
    if (mapping.event === 'contract') {
      const contract = await buildScenarioContract({
        id: artifactId, missionId, ownerId, goal: mission.goal, now: context.clock.now,
        capabilities: [
          { capability: 'run.start', scope: 'mission' },
          { capability: 'run.resume', scope: 'mission' },
          { capability: 'model.call', scope: 'mission' },
        ],
      });
      const grant = {
        ownerId, status: 'active', actor: RUNTIME_ACTOR,
        resolvedModel: 'fake-transport-model',
        expiresAt: hoursFromNow(context.clock.now, 24),
        contractHash: contract.hash, capabilities: ['run.start', 'run.resume', 'model.call'],
      };
      contractByMission.set(missionId, {
        contract, grant,
        mission: null, // 下方 transition 后回填终态 mission
      });
      transitionContext.contractHash = contract.hash;
      transitionContext.autonomy = 'A3';
      transitionContext.confirmed = true;
    }
    const result = transitionMission(mission, mapping.event, transitionContext);
    if (!result.ok) {
      const code = result.error?.code === 'INVALID_TRANSITION' || result.error?.code === 'INVALID_COMMAND' ? 'CONFLICT' : 'CONTRACT_INVALID';
      apiError(res, code, result.error?.message ?? result.error?.code, { internalCode: result.error?.code });
      return true;
    }
    const updated = missionStore.updateMission(result.mission, { ownerId, expectedRevision: mission.revision });
    if (!updated.ok) { apiError(res, 'CONFLICT', 'mission revision moved'); return true; }
    missionStore.appendEvent({
      ownerId, missionId, eventId: result.event.eventId, revision: result.mission.revision,
      from: result.event.from, to: result.event.to, type: result.event.type, payload: JSON.stringify(result.event),
    });
    const bundle = contractByMission.get(missionId);
    if (bundle) bundle.mission = result.mission;
    context.events.emit({ type: 'mission.state', state: scenarioState, w3State: result.mission.state, missionId, ownerId, at: context.clock.now() });
    ok(res, { mission: result.mission, state: scenarioState });
    return true;
  }

  async function startRun(req, res, pathname, env) {
    const match = /^\/api\/missions\/([^/]+)\/runs$/.exec(pathname.split('?')[0]);
    if (!match || req.method !== 'POST') return false;
    const body = await env.readBody();
    const ownerId = env.principal.ownerId;
    const missionId = decodeURIComponent(match[1]);
    const mission = missionStore.getMission(ownerId, missionId);
    if (!mission) { apiError(res, 'NOT_FOUND', 'mission not found'); return true; }
    const bundle = contractByMission.get(missionId);
    if (!bundle || mission.state !== 'contracted') {
      apiError(res, 'CONFLICT', 'mission must be ready (contracted) before runs', { internalCode: 'CONTRACT_REQUIRED' });
      return true;
    }
    const steps = Math.max(1, Number(body?.steps ?? 1));
    const crashAtStep = Number.isInteger(body?.crashAtStep) ? body.crashAtStep : null;
    const budgetRun = body?.budget !== undefined && Number.isInteger(body?.exhaustAfter);
    const exhaustAfter = budgetRun ? body.exhaustAfter : null;
    const nullModel = body?.model === null;
    if (nullModel) {
      modelTransport.enqueue({ ok: true, content: 'no model attribution', model: null, usage: { calls: 1, tokens: 1 } });
    }
    const orderId = context.idGen.next('order');
    const workOrder = {
      id: orderId, parentStepId: `parent-${orderId}`, role: 'writer',
      objective: mission.goal, inputs: [], acceptance: ['完成周报'],
      constraints: { mustNot: [] },
      budget: {
        calls: budgetRun ? exhaustAfter : steps * 2 + 1,
        tokens: 1_000_000,
        deadline: hoursFromNow(context.clock.now, 1),
      },
      grants: [{ grantId: bundle.grant.contractHash ? `grant-${missionId}` : 'grant' }],
      output: { schema: {} },
    };
    const runtime = runtimeFor(ownerId, bundle); // bundle.mission = ready 后的终态 mission
    const runSteps = buildSteps({ orderId, count: steps, crashAtStep, budgetLoop: budgetRun, maxAttempts: exhaustAfter + 3 });
    let outcome;
    try {
      outcome = await runtime.runAgent({
        actor: RUNTIME_ACTOR, workOrder, contract: bundle.contract,
        grantRefs: [{ grantId: `grant-${missionId}` }],
        ownerCtx: { ownerId }, steps: runSteps,
      });
    } catch (error) {
      context.events.emit({ type: 'run.completed', runId: null, outcome: 'failed', code: error?.code ?? 'INTERNAL_ERROR', at: context.clock.now() });
      apiError(res, 'CONTRACT_INVALID', error?.message ?? 'run rejected', { internalCode: error?.code });
      return true;
    }
    context.events.emit({ type: 'run.completed', runId: outcome.runId, outcome: outcome.status, missionId, ownerId, at: context.clock.now() });
    if (budgetRun && outcome.status !== 'done') {
      // 预算耗尽：读回真实步检查点中的 fail-closed 错误码（store 台账为证）。
      const rows = runtimeStore.listSteps({ ownerId, runId: outcome.runId });
      const checkpoint = rows.map(row => row.checkpoint).filter(Boolean).map(text => { try { return JSON.parse(text); } catch { return null; } });
      if (checkpoint.some(entry => entry?.errorCode === 'BUDGET_EXCEEDED')) {
        apiError(res, 'BUDGET_EXCEEDED', 'model call budget exceeded', { runId: outcome.runId });
        return true;
      }
    }
    ok(res, { id: outcome.runId, status: outcome.status, workResult: outcome.workResult ?? null });
    return true;
  }

  async function resumeRun(req, res, pathname, env) {
    const match = /^\/api\/runs\/([^/]+)\/resume$/.exec(pathname.split('?')[0]);
    if (!match || req.method !== 'POST') return false;
    const ownerId = env.principal.ownerId;
    const runId = decodeURIComponent(match[1]);
    const mission = [...contractByMission.entries()].find(([, bundle]) => bundle.mission?.ownerId === ownerId);
    if (!mission) { apiError(res, 'NOT_FOUND', 'no runnable mission for this owner'); return true; }
    const [missionId, bundle] = mission;
    const runtime = runtimeFor(ownerId, bundle);
    let outcome;
    try {
      outcome = await runtime.resumeAgent({ runId, actor: RUNTIME_ACTOR, ownerCtx: { ownerId } });
    } catch (error) {
      const code = error?.code === 'NOT_FOUND' ? 'NOT_FOUND' : error?.code === 'CONFLICT' ? 'CONFLICT' : 'CONTRACT_INVALID';
      apiError(res, code, error?.message ?? 'resume rejected', { internalCode: error?.code });
      return true;
    }
    context.events.emit({ type: 'run.completed', runId: outcome.runId, outcome: outcome.status, missionId, ownerId, resumed: true, at: context.clock.now() });
    ok(res, { id: outcome.runId, status: outcome.status, workResult: outcome.workResult ?? null });
    return true;
  }

  return async function missionsHandler(req, res, pathname, env) {
    if (await createMission(req, res, pathname, env)) return true;
    if (await transitionState(req, res, pathname, env)) return true;
    if (await startRun(req, res, pathname, env)) return true;
    if (await resumeRun(req, res, pathname, env)) return true;
    return false;
  };
}

// ---------------- §5.5 delivery/verifier/inbox（W9 真模块 + M16 投影） ----------------

const GOLDEN_MISSION = 'm-g5';

function createDeliveryHandler({ context }) {
  const artifactStore = createArtifactStore({ db: context.db, clock: context.clock, idGen: () => context.idGen.next('artifact'), events: context.events });
  const acceptance = createAcceptance({ db: context.db, clock: context.clock, idGen: () => context.idGen.next('acceptance'), events: context.events });
  const needStore = createNeedStore({ db: context.db, clock: { now: context.clock.now }, idGen: () => context.idGen.next('need'), events: context.events });
  // ownerId → 家庭台账：{ entries: [{artifactId, realVersion, familyVersion, note}] }。
  // 家庭链 = 同一 owner 场景工件族的全部真实版本（跨工件的版本演进族）。
  const familyByOwner = new Map();

  function familyOf(ownerId) {
    if (!familyByOwner.has(ownerId)) familyByOwner.set(ownerId, { entries: [] });
    return familyByOwner.get(ownerId);
  }

  async function latestFamilyArtifact(ownerId) {
    const family = familyOf(ownerId);
    for (let index = family.entries.length - 1; index >= 0; index -= 1) {
      const artifactId = family.entries[index].artifactId;
      const row = context.db.prepare('SELECT status FROM w9_artifacts WHERE id = ? AND owner_id = ? AND deleted_at IS NULL').get(artifactId, ownerId);
      if (row && !['accepted', 'rejected'].includes(row.status)) return artifactId;
    }
    return null;
  }

  async function putArtifact(req, res, pathname, env) {
    if (req.method !== 'POST' || pathname.split('?')[0] !== '/api/artifacts') return false;
    const body = await env.readBody();
    if (!Number.isInteger(body?.version) || body.version < 1 || typeof body?.content !== 'string' || body.content === '') {
      apiError(res, 'CONTRACT_INVALID', 'body must be { version: integer>=1, content: non-empty string }');
      return true;
    }
    const ownerId = env.principal.ownerId;
    const openArtifactId = await latestFamilyArtifact(ownerId);
    const payload = {
      missionId: GOLDEN_MISSION, type: 'report', title: body.content,
      location: `/evidence/${context.idGen.next('ev')}`, status: 'ready',
      ...(openArtifactId !== null ? { artifactId: openArtifactId } : {}),
    };
    const wire = await artifactStore.put(ownerId, payload);
    familyOf(ownerId).entries.push({ artifactId: wire.id, realVersion: wire.version, familyVersion: body.version, note: 'submission' });
    context.events.emit({ type: 'artifact.submitted', ownerId, artifactId: wire.id, version: wire.version, familyVersion: body.version, at: context.clock.now() });
    ok(res, { id: wire.id, version: wire.version, familyVersion: body.version, status: wire.status });
    return true;
  }

  async function verify(req, res, pathname, env) {
    const match = /^\/api\/artifacts\/([^/]+)\/verify$/.exec(pathname.split('?')[0]);
    if (!match || req.method !== 'POST') return false;
    const body = await env.readBody();
    const ownerId = env.principal.ownerId;
    const artifactId = decodeURIComponent(match[1]);
    const artifact = await artifactStore.get(ownerId, artifactId).catch(() => null);
    if (!artifact) { apiError(res, 'NOT_FOUND', 'artifact not found'); return true; }
    const severity = body?.check?.severity === 'HIGH' || body?.check?.severity === 'MEDIUM' || body?.check?.severity === 'LOW' ? body.check.severity : 'LOW';
    // 核验证据从 body.check.status 派生（PASS/UNKNOWN/FAIL），verdict 是调用方的
    // 声明——引擎真实裁决与声明不符时以引擎为准拒绝（不编造核验结果）。
    const checkStatus = ['PASS', 'UNKNOWN', 'FAIL'].includes(body?.check?.status) ? body.check.status : 'PASS';
    const scriptedCheck = { status: checkStatus, severity, reason: `scenario scripted ${checkStatus} evidence` };
    // verify() 的 coerceChecks 要求 checker 返回数组；check 形状镜像内置 checker。
    const checkers = {
      dod: async () => [{ kind: 'dod-item', ref: 'scenario:dod', ...scriptedCheck }],
      citation: async () => [{ kind: 'citation', ref: 'scenario:citation', status: 'PASS', severity: 'LOW', reason: 'no citations required' }],
      command: async () => [{ kind: 'command-result', ref: 'scenario:command', status: 'PASS', severity: 'LOW', reason: 'no commands to run' }],
      injection: async () => [{ kind: 'injection-marker', ref: 'scenario:injection', status: 'PASS', severity: 'LOW', reason: 'no injection patterns' }],
    };
    const verdict = await verifyArtifact(artifact, ['内容完整且可读'], { checkers, clock: { now: context.clock.now } });
    if (verdict.overall !== body?.verdict) {
      // 引擎真实裁决与场景声明不符：以引擎为准拒绝（不编造核验结果）。
      apiError(res, 'CONTRACT_INVALID', `verify engine produced ${verdict.overall}, scenario declared ${body?.verdict}`);
      return true;
    }
    saveVerdict(context.db, ownerId, verdict, { idGen: () => context.idGen.next('verdict'), events: context.events });
    context.events.emit({ type: 'verdict.recorded', ownerId, artifactId, version: verdict.version, overall: verdict.overall, at: context.clock.now() });
    ok(res, { verdict });
    return true;
  }

  async function decide(req, res, pathname, env) {
    const match = /^\/api\/artifacts\/([^/]+)\/(accept|revise|reject)$/.exec(pathname.split('?')[0]);
    if (!match || req.method !== 'POST') return false;
    const ownerId = env.principal.ownerId;
    const artifactId = decodeURIComponent(match[1]);
    const verb = match[2];
    const body = await env.readBody().catch(() => ({}));
    const options = { actor: `user:${ownerId}`, decision: verb };
    if (typeof body?.comment === 'string' && body.comment !== '') options.comment = body.comment;
    else if (verb === 'revise') options.comment = 'revision requested via golden scenario';
    let record;
    try {
      record = await acceptance.record(ownerId, artifactId, options);
    } catch (error) {
      const code = ['NOT_FOUND', 'CONFLICT', 'FORBIDDEN', 'CONTRACT_INVALID'].includes(error?.code) ? error.code : 'INTERNAL_ERROR';
      apiError(res, code, error?.message ?? 'acceptance rejected');
      return true;
    }
    if (verb === 'revise') {
      // 修订请求 → 场景具体化「必须先产出新版本」：put 修订草稿（generating）。
      const openArtifactId = await latestFamilyArtifact(ownerId);
      if (openArtifactId === artifactId) {
        const draft = await artifactStore.put(ownerId, {
          missionId: GOLDEN_MISSION, type: 'report',
          title: `${record.id}-revision-draft`, location: `/evidence/${context.idGen.next('ev')}`,
          status: 'generating', artifactId,
        });
        familyOf(ownerId).entries.push({ artifactId: draft.id, realVersion: draft.version, familyVersion: null, note: 'revision-draft' });
      }
      await needStore.createNeed(ownerId, {
        missionId: GOLDEN_MISSION, type: 'acceptance',
        question: `修订请求：artifact ${artifactId}（验收 ${record.id}）需要新版本`,
        dueAt: hoursFromNow(context.clock.now, 24), defaultAction: 'continue',
      });
    }
    context.events.emit({ type: `acceptance.${record.decision}`, ownerId, artifactId, acceptanceId: record.id, at: context.clock.now() });
    ok(res, { acceptance: record });
    return true;
  }

  async function readArtifacts(req, res, pathname, env) {
    const path = pathname.split('?')[0];
    if (req.method !== 'GET') return false;
    if (path === '/api/artifacts') {
      const artifacts = await artifactStore.list(env.principal.ownerId);
      ok(res, { artifacts });
      return true;
    }
    if (path === '/api/artifacts/benefit') {
      const ownerId = env.principal.ownerId;
      const acceptanceRows = context.db.prepare(
        'SELECT artifact_id, artifact_version, actor, decision FROM w9_acceptances WHERE owner_id = ? ORDER BY created_at, id',
      ).all(ownerId);
      const latestVerdict = context.db.prepare(
        'SELECT id, overall FROM w9_verdicts WHERE owner_id = ? AND artifact_id = ? AND artifact_version = ? ORDER BY ran_at DESC, rowid DESC LIMIT 1',
      );
      const checksOf = context.db.prepare('SELECT status, severity FROM w9_verdict_checks WHERE verdict_id = ?');
      const entries = acceptanceRows.map(row => {
        const verdictRow = latestVerdict.get(ownerId, row.artifact_id, row.artifact_version);
        const verdict = verdictRow
          ? { overall: verdictRow.overall, checks: checksOf.all(verdictRow.id) }
          : null;
        return {
          owner: ownerId,
          acceptance: { actor: row.actor, decision: row.decision, artifactVersion: row.artifact_version },
          verdict,
        };
      });
      const projection = projectAcceptedBenefit(entries, ownerId);
      context.events.emit({ type: 'benefit.projected', ownerId, count: projection.count, excluded: projection.excluded.length, at: context.clock.now() });
      ok(res, { count: projection.count, versions: projection.included.map(entry => entry.artifactVersion), excluded: projection.excluded });
      return true;
    }
    const versionsMatch = /^\/api\/artifacts\/([^/]+)\/versions$/.exec(path);
    if (versionsMatch) {
      const ownerId = env.principal.ownerId;
      const artifactId = decodeURIComponent(versionsMatch[1]);
      const family = familyOf(ownerId);
      const familyIds = new Set(family.entries.map(entry => entry.artifactId));
      if (familyIds.has(artifactId)) {
        const versions = family.entries
          .filter(entry => entry.artifactId === artifactId || familyIds.size > 1)
          .map((entry, index) => ({
            artifactId: entry.artifactId, version: index + 1,
            realVersion: entry.realVersion, familyVersion: entry.familyVersion, note: entry.note,
          }));
        ok(res, { versions });
        return true;
      }
      const rows = await artifactStore.versions(ownerId, artifactId);
      ok(res, { versions: rows });
      return true;
    }
    const single = /^\/api\/artifacts\/([^/]+)$/.exec(path);
    if (single) {
      try {
        const artifact = await artifactStore.get(env.principal.ownerId, decodeURIComponent(single[1]));
        ok(res, artifact);
      } catch (error) {
        const code = error?.code === 'NOT_FOUND' ? 'NOT_FOUND' : error?.code === 'CONTRACT_INVALID' ? 'CONTRACT_INVALID' : 'INTERNAL_ERROR';
        apiError(res, code, error?.message ?? 'artifact not found');
      }
      return true;
    }
    return false;
  }

  async function inbox(req, res, pathname, env) {
    if (req.method !== 'GET' || pathname.split('?')[0] !== '/api/inbox') return false;
    const records = await needStore.list(env.principal.ownerId);
    // AttentionItem 投影的 W13 扩展（attention-projection.mjs 头注预留）：kind='need'。
    ok(res, { items: records.map(record => ({ ...record, kind: 'need' })) });
    return true;
  }

  return async function deliveryHandler(req, res, pathname, env) {
    if (await putArtifact(req, res, pathname, env)) return true;
    if (await verify(req, res, pathname, env)) return true;
    if (await decide(req, res, pathname, env)) return true;
    if (await readArtifacts(req, res, pathname, env)) return true;
    if (await inbox(req, res, pathname, env)) return true;
    return false;
  };
}

// ---------------- §5.7 observability provenance（W10 store + M16 投影） ----------------

function createRunsTraceHandler({ context }) {
  const obsStore = createObservabilityStore({ db: context.db });
  const rowsByRun = new Map(); // runId → 矩阵行（POST 时经 M16 投影确定；GET 从 obs_spans 回放）

  function spanFor({ ownerId, runId, actor, resolvedModel, modelSource, status, stale, conflicting, reasons }) {
    return {
      id: context.idGen.next('span'),
      name: 'model.resolved',
      kind: 'invoke_agent',
      startedAt: context.clock.now(),
      ...(status === 'VERIFIED' ? { endedAt: context.clock.now(), status: 'ok' } : { status: 'running' }),
      attributes: { actor, resolvedModel, modelSource, stale: stale === true, conflicting: conflicting === true, status, reasons },
    };
  }

  async function trace(req, res, pathname, env) {
    const match = /^\/api\/runs\/([^/]+)\/trace$/.exec(pathname.split('?')[0]);
    if (!match || req.method !== 'POST') return false;
    const body = await env.readBody();
    const ownerId = env.principal.ownerId;
    const runId = decodeURIComponent(match[1]);
    const actors = Array.isArray(body?.actors) ? body.actors : [];
    const conflictingEvidence = body?.conflictingEvidence && typeof body.conflictingEvidence === 'object' ? body.conflictingEvidence : null;
    obsStore.upsertRun({
      id: runId, missionId: 'm-g7', contractHash: createHash('sha256').update(runId).digest('hex'),
      state: 'running', startedAt: context.clock.now(), updatedAt: context.clock.now(),
    }, { ownerId });
    const rows = [];
    for (const declared of actors) {
      const row = projectModelProvenance({
        actor: declared?.actor ?? null,
        resolvedModel: declared?.resolvedModel ?? null,
        modelSource: declared?.modelSource ?? 'unknown',
        stale: declared?.stale === true,
      });
      rows.push({ actor: row.actor, resolvedModel: row.resolvedModel, modelSource: row.modelSource, status: row.status, stale: declared?.stale === true, conflicting: false, reasons: row.reasons });
      context.traceSink.record(spanFor({ ownerId, runId, actor: row.actor, resolvedModel: row.resolvedModel, modelSource: row.modelSource, status: row.status, stale: declared?.stale === true, conflicting: false, reasons: row.reasons }), { ownerId, runId });
    }
    if (conflictingEvidence && Array.isArray(conflictingEvidence.models) && conflictingEvidence.models.length > 0) {
      const row = projectModelProvenance({
        actor: conflictingEvidence.actor ?? null,
        resolvedModel: conflictingEvidence.models[0],
        modelSource: 'gateway',
        evidence: conflictingEvidence.models.map(model => ({ model })),
      });
      rows.push({ actor: row.actor, resolvedModel: row.resolvedModel, modelSource: row.modelSource, status: row.status, stale: false, conflicting: true, reasons: row.reasons });
      context.traceSink.record(spanFor({ ownerId, runId, actor: row.actor, resolvedModel: row.resolvedModel, modelSource: row.modelSource, status: row.status, stale: false, conflicting: true, reasons: row.reasons }), { ownerId, runId });
    }
    rowsByRun.set(`${ownerId}\n${runId}`, rows);
    for (const [kind, payload] of [
      ['run.registered', { runId, ownerId }],
      ['actor.bound', { runId, actors: actors.length }],
      ['model.resolved', { runId, resolved: actors.filter(entry => entry?.resolvedModel).length, unknown: actors.filter(entry => !entry?.resolvedModel).length }],
      ['gate.evaluated', { runId, gates: rows.length }],
      ['latency.sampled', { runId, ms: 0 }],
      ['cost.recorded', { runId, tokens: 0 }],
    ]) {
      context.events.emit({ type: kind, runId, ownerId, ...payload, at: context.clock.now() });
    }
    ok(res, {
      run: { id: runId, state: 'running' },
      metrics: { run: 1, actor: actors.length, model: rows.length, gate: rows.length, latency: 0, cost: 0 },
      matrix: { rows },
    });
    return true;
  }

  async function matrix(req, res, pathname, env) {
    const match = /^\/api\/runs\/([^/]+)\/matrix$/.exec(pathname.split('?')[0]);
    if (!match || req.method !== 'GET') return false;
    const ownerId = env.principal.ownerId;
    const runId = decodeURIComponent(match[1]);
    const cached = rowsByRun.get(`${ownerId}\n${runId}`);
    if (cached) { ok(res, { rows: cached }); return true; }
    // 显式查询回放：obs_spans 的 model.resolved 行（attributes 携带矩阵字段）。
    const spanRows = obsStore.listRunSpans(ownerId, runId)
      .filter(row => row.name === 'model.resolved')
      .map(row => {
        let attributes = {};
        try { attributes = JSON.parse(row.attributes_json ?? '{}'); } catch { attributes = {}; }
        return {
          actor: attributes.actor ?? null,
          resolvedModel: attributes.resolvedModel ?? null,
          modelSource: attributes.modelSource ?? 'unknown',
          status: attributes.status ?? 'UNKNOWN',
          stale: attributes.stale === true,
          conflicting: attributes.conflicting === true,
          reasons: Array.isArray(attributes.reasons) ? attributes.reasons : [],
        };
      });
    ok(res, { rows: spanRows });
    return true;
  }

  return async function runsTraceHandler(req, res, pathname, env) {
    if (await trace(req, res, pathname, env)) return true;
    if (await matrix(req, res, pathname, env)) return true;
    return false;
  };
}

// ---------------- 组装 ----------------

/**
 * 构造 golden 场景 handler 集（按声明顺序挂载；全部经同一组合根）。
 *
 * @param {object} deps
 * @param {object} deps.context          M13 组合根（必需）。
 * @param {object} deps.modelTransport   假模型 transport（W7 注入位）。
 * @param {object} deps.sideEffectLedger 副作用台账（唯一外部效果端口）。
 * @param {object} deps.vision           W12 vision mock（pipeline.start 形状）。
 * @param {string} [deps.scanMissionId='m-g2'] 扫描结果落入的 W6 任务 id。
 * @param {number} [deps.grantTtlSeconds=3600] §5.3 grant TTL。
 * @param {Function} [deps.requestAllowed] W1 origin 检查（缺省同源/无 origin 放行）。
 */
export function createGoldenScenarioHandlers({
  context,
  modelTransport,
  sideEffectLedger,
  vision,
  scanMissionId = 'm-g2',
  grantTtlSeconds = 3600,
  requestAllowed = req => {
    const origin = req?.headers?.origin;
    return origin === undefined || origin === null || origin === '' || /^http:\/\/127\.0\.0\.1(:\d+)?\/?$/.test(origin);
  },
} = {}) {
  if (!context || typeof context !== 'object') throw new Error('createGoldenScenarioHandlers: an M13 integration context is required');
  if (typeof context.auth !== 'function' || !context.db || !context.clock) {
    throw new Error('createGoldenScenarioHandlers: the context must be a composed M13 root (db/auth/clock)');
  }
  const [capturesHandler, previewHandler] = createPerceptionPreviewHandler({ context, vision, scanMissionId });
  return [
    createBlocksHandler({ context, requestAllowed }),
    previewHandler,
    createMissionsRuntimeHandler({ context, modelTransport, sideEffectLedger }),
    createContractsHandler({ context, sideEffectLedger, grantTtlSeconds }),
    capturesHandler,
    createDeliveryHandler({ context }),
    createRunsTraceHandler({ context }),
  ];
}
