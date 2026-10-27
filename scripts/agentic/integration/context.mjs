// S2D-W13 · M13 组合根（composition context）——brief §4.1「统一依赖容器」。
//
// 单一注入容器：同一 db（W0 openAgenticDb + migrate() 单 `_migrations` 台账）、
// 同一确定性 clock（注入覆盖 W6/W8 的缺省墙钟）、idGen、events sink、
// traceSink→W10 store、policyPort→W4 evaluateAction（fail-closed）、auth 适配层
// （单一 principal 解析 → 四种冻结 auth 形状，W10 同步兼容）。
//
// 红线 4（集成路径禁隐藏墙钟、第二 auth/db、读 key、外部调用）以代码级自守：
//   - 本模块不读 Date.now / 不构造墙钟 / 不读环境变量 / 不发任何网络或子进程调用
//     （tests/unit/agentic/integration/context-seams.test.mjs 源码自审固化）；
//   - db 只接受注入或 dbFile 显式打开（openAgenticDb），绝无隐式第二实例；
//   - migration 只走 W0 migrate() 单台账（R-9：不跑 W2 `_engine_migrations` 旁路）；
//   - principal 解析器必须同步（W10 路由 await 不了 auth），异步即拒绝构造；
//   - policy 决策 fail-closed：解析失败/评估抛错/UNKNOWN 一律不允许执行。

import { fileURLToPath } from 'node:url';

import { migrate, openAgenticDb } from '../db/index.mjs';
import { evaluateAction } from '../autonomy/policy.mjs';
import { createObservabilityStore } from '../observability/store.mjs';
import { createSpanRecorder } from '../observability/spans.mjs';

const MIGRATIONS_DIR = fileURLToPath(new URL('../db/migrations/', import.meta.url));

function integrationError(code, message, details) {
  const error = new Error(message);
  error.name = 'IntegrationContextError';
  error.code = code;
  if (details !== undefined) error.details = details;
  return error;
}

function isThenable(value) {
  return value !== null && typeof value === 'object' && typeof value.then === 'function';
}

function parseIsoOrThrow(value, label) {
  const epochMs = Date.parse(value);
  if (!Number.isFinite(epochMs)) {
    throw integrationError(
      'INTEGRATION_CLOCK_INVALID',
      `${label}: the injected clock (now) must return an ISO-8601 date-time string so every consumer shares one deterministic time source; got ${JSON.stringify(value)}`,
    );
  }
  return epochMs;
}

// ---------------- 时钟 ----------------

/**
 * Wrap one injected `now()` ISO source as the context clock.
 * `nowMs()` derives epoch ms via Date.parse of the same source — one source of
 * truth for every flow shape (W6/W9/W12/W4 want ISO, W7/W8 want epoch ms).
 */
function contextClock(nowFn) {
  return {
    now: () => nowFn(),
    nowMs: () => parseIsoOrThrow(nowFn(), 'createIntegrationContext'),
  };
}

/** W7/W8 runtime shape: `{ now() -> epoch ms }`, still fed by the same clock. */
export function adaptClockForRuntime(clock) {
  if (!clock || typeof clock !== 'object' || typeof clock.now !== 'function') {
    throw integrationError(
      'INTEGRATION_ADAPTER_INVALID',
      'adaptClockForRuntime: a context clock object with now() is required (deterministic time only)',
    );
  }
  return { now: () => parseIsoOrThrow(clock.now(), 'adaptClockForRuntime') };
}

// ---------------- policy：W4 桥（fail-closed） ----------------

const DEFAULT_DENY_ALL_POLICY_PORT = Object.freeze({
  check: () => ({ allowed: false, reason: 'POLICY_PORT_UNBOUND', need: 'POLICY_PORT_UNBOUND' }),
});

/**
 * Bridge the frozen W4 `evaluateAction` into the integration policy port.
 *
 * Decision mapping (never allows on doubt):
 *   allowed            → { allowed: true }
 *   needs_confirmation → { allowed: false, need/reason: A4_CONFIRMATION_REQUIRED } — A4 stays an explicit per-action gate
 *   blocked            → { allowed: false, reason: <W4 code> }
 *   UNKNOWN            → { allowed: false, reason: <W4 code>, unknown: true } — surfaced, never swallowed
 *   resolver/eval 错误  → { allowed: false, reason: POLICY_INPUT_RESOLVER_FAILED|POLICY_EVALUATION_FAILED }
 *
 * M22 起导出：黄金场景（golden-handlers）把 W7 runtime 的 policy 动作适配成
 * W4 evaluateAction 形状后经同一桥接裁决；组合根本身行为不变。
 */
export function createW4PolicyPort({ resolvePolicyInput, phase = 'P0', clock }) {
  if (typeof resolvePolicyInput !== 'function') {
    throw integrationError(
      'INTEGRATION_POLICY_CONFIG_INVALID',
      'createIntegrationContext: policy.resolvePolicyInput(ctx, action) must be a function returning { mission, contract, grant? } for the W4 policy bridge',
    );
  }
  return {
    check(ctx, action) {
      let resolved = null;
      try {
        resolved = resolvePolicyInput(ctx, action);
      } catch {
        return { allowed: false, reason: 'POLICY_INPUT_RESOLVER_FAILED' };
      }
      if (resolved === null || typeof resolved !== 'object' || !resolved.mission || !resolved.contract) {
        // 与 W4 自己的缺上下文判决同码：不伪造 GRANT/SCOPE 细因。
        return { allowed: false, reason: 'CONTEXT_INVALID' };
      }
      const input = { ...resolved, action };
      if (typeof ctx?.ownerId === 'string' && ctx.ownerId !== '') input.ownerId = ctx.ownerId;

      let result;
      try {
        result = evaluateAction(input, { now: clock.now(), phase });
      } catch {
        return { allowed: false, reason: 'POLICY_EVALUATION_FAILED' };
      }
      if (result?.status === 'allowed') return { allowed: true };
      if (result?.status === 'needs_confirmation') {
        return { allowed: false, need: result.code ?? 'A4_CONFIRMATION_REQUIRED', reason: result.code ?? 'A4_CONFIRMATION_REQUIRED' };
      }
      return {
        allowed: false,
        reason: result?.code ?? 'POLICY_UNKNOWN_OUTCOME',
        ...(result?.status === 'UNKNOWN' ? { unknown: true } : {}),
      };
    },
  };
}

/** Adapt the integration port (`allowed`) to the W7 runtime port shape (`{ allow, reason?, need? }`). */
export function adaptPolicyPortForRuntime(port) {
  if (!port || typeof port !== 'object' || typeof port.check !== 'function') {
    throw integrationError(
      'INTEGRATION_ADAPTER_INVALID',
      'adaptPolicyPortForRuntime: a policy port object with check(ctx, action) is required',
    );
  }
  return {
    check: async (ctx, action) => {
      let decision;
      try {
        decision = port.check(ctx, action);
        if (isThenable(decision)) decision = await decision;
      } catch (cause) {
        // 抛错上抛：W7 policyCheck 把抛错归为基础设施故障并 fail closed，不吞。
        throw cause;
      }
      const allowed = decision?.allowed === true;
      const mapped = { allow: allowed };
      if (decision?.reason !== undefined) mapped.reason = String(decision.reason);
      if (!allowed && decision?.need !== undefined) mapped.need = String(decision.need);
      return mapped;
    },
  };
}

// ---------------- traceSink → W10 store ----------------

function isContractShapedSpan(span) {
  return typeof span?.id === 'string' && span.id !== ''
    && typeof span?.name === 'string' && span.name !== '';
}

/**
 * Map a W7 engine event span (`{ type, runId, actor, recordedAt, ... }`) onto
 * the frozen span.schema.json shape without inventing success:
 *
 *   - run.started / run.resumed → status 'running' (non-terminal);
 *   - run.finished succeeded    → 'ok' + endedAt;
 *   - run.finished failed       → 'error' + endedAt;
 *   - run.finished paused/unknown → 'running'（保持未终态，W10 分类永不计成功，
 *     原始 outcome 保留在 attributes.runOutcome —— UNKNOWN 不吞、不升级）。
 */
function mapEngineEventSpan(span, { idGen, clock }) {
  if (span === null || typeof span !== 'object' || typeof span.type !== 'string' || span.type === '') {
    throw integrationError(
      'INTEGRATION_TRACE_SPAN_INVALID',
      'traceSink.record: engine event spans require a non-empty string type (or pass a contract-shaped span)',
    );
  }
  const startedAt = typeof span.recordedAt === 'string' && span.recordedAt !== ''
    ? span.recordedAt
    : clock.now();
  const attributes = { ...span };
  let status = 'running';
  let endedAt;
  if (span.type === 'run.finished') {
    const outcome = span.status ?? 'unknown';
    attributes.runOutcome = outcome;
    if (outcome === 'succeeded') {
      status = 'ok';
      endedAt = startedAt;
    } else if (outcome === 'failed') {
      status = 'error';
      endedAt = startedAt;
    }
    // paused / unknown / 其它：保持 running 非终态 —— 绝不记成成功。
  } else if (span.status === 'ok' || span.status === 'error') {
    status = span.status;
    endedAt = typeof span.endedAt === 'string' && span.endedAt !== '' ? span.endedAt : startedAt;
  } else if (span.status === 'running') {
    status = 'running';
  }
  const mapped = {
    id: idGen.next('span'),
    name: span.type,
    kind: span.kind ?? 'invoke_agent',
    startedAt,
    status,
    attributes,
  };
  if (endedAt !== undefined) mapped.endedAt = endedAt;
  if (typeof span.parentId === 'string' && span.parentId !== '') mapped.parentId = span.parentId;
  return mapped;
}

// ---------------- events sink ----------------

function createDefaultEventSink() {
  const log = [];
  return {
    emit(event) {
      if (event === null || typeof event !== 'object' || Array.isArray(event)
        || typeof event.type !== 'string' || event.type === '') {
        throw integrationError(
          'INTEGRATION_EVENT_INVALID',
          'events.emit requires an object with a non-empty string type (evidence trail stays trustworthy)',
        );
      }
      log.push(Object.freeze({ ...event }));
      return event;
    },
    recorded: () => log.slice(),
  };
}

// ---------------- 组合根 ----------------

/**
 * Build the one integration composition context (brief §4.1).
 *
 * Required injectables (no defaults, no hidden fallbacks):
 *   - db (instance) 或 dbFile (path)：db 注入则 verbatim 复用（不另开第二实例），
 *     dbFile 则由本组合根 openAgenticDb 打开；两者都给或都不给 → 拒绝构造。
 *     无论哪种，migration 只走 W0 migrate() 单 `_migrations` 台账（R-9）。
 *   - now：() => ISO-8601 字符串的确定性时钟源；构造时探测校验。W6/W8 的
 *     缺省墙钟由此注入覆盖（R-8）。
 *   - auth：同步 principal 解析器 (req) => { ownerId, actor?, id? } | null。
 *     异步函数在构造期即被拒绝（W10 路由同步取 principal）。
 *
 * Optional injectables:
 *   - idGen：{ next(prefix?) } 或裸函数（归一为 { next }）；缺省用时钟+序号的确定性生成器。
 *   - events：{ emit(event) }（verbatim）；缺省内置有序台账（emit/recorded）。
 *   - policyPort：verbatim 优先。
 *   - policy：{ resolvePolicyInput(ctx, action), phase? } → W4 evaluateAction 桥（fail-closed）。
 *     两者皆缺省 → deny-all 端口（check 永不 allowed）。
 *   - ownerOfSpan：(span) => ownerId，供 W7 形状 spanSink.record(span)（无显式 owner 时）解析归属。
 *
 * Principal 约定：resolver 返回的对象原样透传给各流 auth 形状；服务 W12 感知路由
 * 直接挂载时 principal 需自带 `id` 字段（其路由读 user.id），W1 块同步同理。
 */
export function createIntegrationContext(options = {}) {
  const {
    db,
    dbFile,
    migrationsDir,
    auth,
    idGen,
    events,
    policyPort,
    policy,
    ownerOfSpan,
  } = options;
  const nowOption = options.now;

  // --- clock：注入必需，禁止任何缺省墙钟 ---
  if (typeof nowOption !== 'function') {
    throw integrationError(
      'INTEGRATION_CLOCK_REQUIRED',
      'createIntegrationContext: a deterministic clock injection (now: () => ISO string) is required — hidden wall clocks are forbidden on the integration path',
    );
  }
  const clock = contextClock(nowOption);
  parseIsoOrThrow(nowOption(), 'createIntegrationContext'); // 构造期探测：源必须是可解析 ISO。

  // --- auth：同步 principal 解析器（W10 兼容）---
  if (typeof auth !== 'function') {
    throw integrationError(
      'INTEGRATION_AUTH_REQUIRED',
      'createIntegrationContext: an auth principal resolver function (req) => { ownerId, ... } | null is required — no hidden second auth source',
    );
  }
  if (Object.prototype.toString.call(auth) === '[object AsyncFunction]') {
    throw integrationError(
      'INTEGRATION_AUTH_ASYNC',
      'createIntegrationContext: the auth principal resolver must be synchronous — the W10 observability adapter cannot await a promise (got an AsyncFunction)',
    );
  }
  const principalOf = (req) => {
    let principal = null;
    try {
      principal = auth(req);
    } catch {
      return null; // 解析器抛错按未认证处理（各流 401 语义由挂载层负责）。
    }
    if (principal === null || principal === undefined) return null;
    if (isThenable(principal)) {
      throw integrationError(
        'INTEGRATION_AUTH_ASYNC',
        'createIntegrationContext: the auth principal resolver returned a promise; the integration auth adapters must stay synchronous (W10)',
      );
    }
    if (typeof principal !== 'object' || typeof principal.ownerId !== 'string' || principal.ownerId === '') return null;
    return principal;
  };

  // --- db：注入 verbatim 或显式打开；单 W0 migrate 台账 ---
  let database = db;
  if (db !== undefined && dbFile !== undefined) {
    throw integrationError(
      'INTEGRATION_DB_AMBIGUOUS',
      'createIntegrationContext: pass either an injected db instance or dbFile, not both — the composition root owns exactly one db',
    );
  }
  if (db === undefined) {
    if (typeof dbFile !== 'string' || dbFile === '') {
      throw integrationError(
        'INTEGRATION_DB_REQUIRED',
        'createIntegrationContext: a db instance or a dbFile path is required — the integration path may not conjure a hidden database',
      );
    }
    database = openAgenticDb(dbFile);
  } else if (database === null || typeof database !== 'object') {
    throw integrationError('INTEGRATION_DB_INVALID', 'createIntegrationContext: the injected db must be an object');
  }
  const appliedMigrations = migrate(database, migrationsDir || MIGRATIONS_DIR);

  // --- idGen ---
  let idGenPort;
  if (idGen === undefined || idGen === null) {
    let sequence = 0;
    idGenPort = { next: (prefix = 'w13') => `${prefix}-${clock.nowMs()}-${(sequence++).toString(36)}` };
  } else if (typeof idGen === 'function') {
    idGenPort = { next: idGen };
  } else if (typeof idGen === 'object' && typeof idGen.next === 'function') {
    idGenPort = idGen;
  } else {
    throw integrationError(
      'INTEGRATION_IDGEN_INVALID',
      'createIntegrationContext: idGen must be a function or { next() }',
    );
  }

  // --- events sink ---
  let eventSink;
  if (events === undefined || events === null) {
    eventSink = createDefaultEventSink();
  } else if (typeof events === 'object' && typeof events.emit === 'function') {
    eventSink = events;
  } else {
    throw integrationError(
      'INTEGRATION_EVENTS_INVALID',
      'createIntegrationContext: events must be a sink object with emit(event)',
    );
  }

  // --- traceSink → W10 store（惰性建 recorder；同一 db 投影，绝不第二实例） ---
  let spanRecorder = null;
  const recorder = () => {
    if (spanRecorder === null) {
      spanRecorder = createSpanRecorder({ store: createObservabilityStore({ db: database }) });
    }
    return spanRecorder;
  };
  const traceSink = {
    record(span, recordOptions) {
      const opts = recordOptions === null || typeof recordOptions !== 'object' ? {} : recordOptions;
      let ownerId = opts.ownerId ?? span?.ownerId;
      if ((ownerId === undefined || ownerId === null) && typeof ownerOfSpan === 'function') {
        ownerId = ownerOfSpan(span);
      }
      if (typeof ownerId !== 'string' || ownerId === '') {
        throw integrationError(
          'INTEGRATION_TRACE_OWNER_REQUIRED',
          'traceSink.record: an explicit ownerId is required (opts.ownerId, span.ownerId or the ownerOfSpan resolver) — spans may not be recorded without ownership',
        );
      }
      const prepared = isContractShapedSpan(span)
        ? span
        : mapEngineEventSpan(span, { idGen: idGenPort, clock });
      return recorder().record(prepared, { ownerId, runId: opts.runId ?? span?.runId });
    },
    /** W7 spanSink 形状绑定：{ record(span) } 固定 owner/run。 */
    forOwner(ownerId, runId) {
      if (typeof ownerId !== 'string' || ownerId === '') {
        throw integrationError('INTEGRATION_TRACE_OWNER_REQUIRED', 'traceSink.forOwner: a non-empty ownerId is required');
      }
      return { record: (span) => traceSink.record(span, { ownerId, runId }) };
    },
  };

  // --- policyPort：verbatim > W4 桥 > deny-all（全部 fail-closed） ---
  let port;
  if (policyPort !== undefined && policyPort !== null) {
    if (typeof policyPort !== 'object' || typeof policyPort.check !== 'function') {
      throw integrationError(
        'INTEGRATION_POLICY_CONFIG_INVALID',
        'createIntegrationContext: an injected policyPort must be an object with check(ctx, action)',
      );
    }
    port = policyPort;
  } else if (policy !== undefined && policy !== null) {
    port = createW4PolicyPort({ phase: 'P0', ...policy, clock });
  } else {
    port = DEFAULT_DENY_ALL_POLICY_PORT;
  }

  // --- auth 适配层：单一 principal → 四种冻结形状 ---
  // 本体是可调用函数（M14 dispatcher 要求 typeof context.auth === 'function'，
  // 每请求恰好一次 context.auth(req) 取 principal），并携带各流命名的形状适配。
  const passthrough = (req) => principalOf(req);
  const authAdapter = (req) => principalOf(req);
  /** W1 blocks：authenticate(req) → principal | null（principal 需带 id）。 */
  authAdapter.forBlocks = passthrough;
  /** W12 perception：auth.authenticate(req) → principal | null（principal 需带 id）。 */
  authAdapter.forPerception = passthrough;
  /** W3 mission：auth.ownerId(req) → ownerId | undefined。 */
  authAdapter.forMission = (req) => principalOf(req)?.ownerId;
  /** W6 preview：auth(req) → principal | null（{ ownerId, actor? }）。 */
  authAdapter.forPreview = passthrough;
  /** W8 bridge：auth(req) → identity { ownerId } | null。 */
  authAdapter.forBridge = passthrough;
  /** W9 delivery：auth(req) → { ownerId } | null。 */
  authAdapter.forDelivery = passthrough;
  /** W9 inbox：auth(req) → { ownerId } | null。 */
  authAdapter.forInbox = passthrough;
  /** W10 observability：auth(req) 同步 → { ownerId } | null。 */
  authAdapter.forObservability = passthrough;

  return {
    db: database,
    appliedMigrations,
    clock,
    idGen: idGenPort,
    events: eventSink,
    traceSink,
    policyPort: port,
    auth: authAdapter,
  };
}
