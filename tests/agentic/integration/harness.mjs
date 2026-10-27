// S2D-W13 · M21 集成 harness（tests/agentic/integration/harness.mjs，plan.md §G4）。
//
// 黄金场景（M22 golden-scenarios.test.mjs）的唯一测试基座，提供：
//   - fixture 登录：x-fixture-token → 冻结 principal（owner/actor/id/device），
//     同步 resolver（W10 兼容），principal 自带 id（W1/W12 路由读 user.id）；
//   - dispatcher 挂载：M14 createAgenticDispatcher + M13 createIntegrationContext
//     （单一 db/确定性 clock/idGen/events/traceSink/policyPort fail-closed）+
//     M17 health；真实 node http.Server 只绑 127.0.0.1，未处理请求落 legacy，
//     legacy 也不处理 → 冻结 404 信封；
//   - 假模型 transport（W7 modelCaller 注入位：脚本化结果/逐 run 成功与重试台账，
//     ok&&model≠null 才算真实成功——resolved_model=NULL 永不变真实成功）；
//   - 假 checker（W9 verify { checkers } 注入位，默认 PASS LOW，可逐项脚本化）；
//   - 假 gateway（W8 上游注入位：零真实网络，send 全记录，脚本化应答）；
//   - W12 vision mock（pipeline.start 形状 { done, attribution }，emit card.created/
//     card.upgraded，done 永不 reject）；
//   - W4 副作用台账（perform/asExecutor 与 SideEffectFence 配对；被拒动作零副作用）；
//   - 临时 SQLite（mkdtemp + openAgenticDb，W0 migrate() 单 `_migrations` 台账，
//     close() 一并清理）；
//   - 端口 17701–17709（pickHarnessPort 只在段内分配；17711–17719 归 release）；
//   - SSE 收集器（逐帧解析、非事件流应答不误报、断开即 client_disconnect
//     outcome=UNKNOWN 事件）与证据落盘（事件序列/HTTP 台账/最终状态）。
//
// 红线（brief §4.1/红线4）：业务时间戳一律注入式确定性时钟（源码禁墙钟读取、
// 禁无参 Date 构造、禁环境变量读取、禁 fetch 外呼）；网络只绑 127.0.0.1；
// 本模块不读任何 key、不发任何外部调用。
//
// 场景扩展位：createGoldenHarness({ handlers, legacy, policyPort, modelTransport,
// checkers, gateway, vision, evidenceDir, port, principals, startIso }) —— M22 把
// brief §5 的场景 handler 注入 handlers（签名 (req,res,pathname,env)=>handled:boolean），
// 用 withJsonBody 为 req.json() 形状的流路由（W3/W9）搭桥。

import http from 'node:http';
import net from 'node:net';
import { renameSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createIntegrationContext } from '../../../scripts/agentic/integration/context.mjs';
import { createAgenticDispatcher } from '../../../scripts/agentic/integration/dispatcher.mjs';
import { createHealthHandler } from '../../../scripts/agentic/integration/health.mjs';
import { adaptW1DtoToBlock } from '../../../scripts/agentic/integration/w1-adapter.mjs';

// ---------------- 端口段 ----------------

/** W13 harness 专用段；17711–17719 归 release 健康检查（plan.md §2 端口台账）。 */
export const HARNESS_PORT_RANGE = Object.freeze({ min: 17701, max: 17709 });

function canBind(port) {
  return new Promise(resolve => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)));
  });
}

/**
 * 在 17701–17709 段内分配一个可绑定端口。
 * preferred 在段内且空闲 → 直接用；被占用 → 段内顺延；段外 → 拒绝（绝不静默离段）。
 * 段耗尽 → 抛错（调用方串行使用，不做段外回退）。
 */
export async function pickHarnessPort(preferred) {
  const { min, max } = HARNESS_PORT_RANGE;
  const candidates = [];
  if (preferred !== undefined) {
    if (!Number.isInteger(preferred) || preferred < min || preferred > max) {
      throw new Error(`pickHarnessPort: preferred port must be an integer inside the harness port range ${min}-${max} (got ${String(preferred)})`);
    }
    candidates.push(preferred);
  }
  for (let port = min; port <= max; port++) if (port !== preferred) candidates.push(port);
  for (const port of candidates) {
    if (await canBind(port)) return port;
  }
  throw new Error(`pickHarnessPort: no free port left in the harness range ${min}-${max}`);
}

// ---------------- fixture 登录 ----------------

/**
 * 冻结 fixture 名册。token 即键名（x-fixture-token: primary）。
 * primary/secondary = 不同 owner（跨 owner 用例）；device-a/device-b = 同 owner
 * 双设备（golden-6 增量同步前提）。id 必带：W1/W12 路由读 principal.id。
 */
export const FIXTURE_PRINCIPALS = Object.freeze({
  primary: Object.freeze({ ownerId: 'owner-a', actor: 'fixture.primary', id: 'owner-a', device: 'fixture-primary' }),
  secondary: Object.freeze({ ownerId: 'owner-b', actor: 'fixture.secondary', id: 'owner-b', device: 'fixture-secondary' }),
  'device-a': Object.freeze({ ownerId: 'owner-a', actor: 'fixture.device-a', id: 'owner-a', device: 'fixture-device-a' }),
  'device-b': Object.freeze({ ownerId: 'owner-a', actor: 'fixture.device-b', id: 'owner-a', device: 'fixture-device-b' }),
});

/** 同步 principal 解析器（M13 组合根要求同步；W10 路由 await 不了异步）。 */
export function createFixtureAuth({ principals = FIXTURE_PRINCIPALS } = {}) {
  for (const [key, principal] of Object.entries(principals)) {
    if (principal === null || typeof principal !== 'object'
      || typeof principal.ownerId !== 'string' || principal.ownerId === ''
      || typeof principal.id !== 'string' || principal.id === '') {
      throw new Error(`createFixtureAuth: fixture principal "${key}" must carry non-empty string ownerId and id (W1/W12 routes read principal.id)`);
    }
  }
  return function fixtureAuth(req) {
    const token = req?.headers?.['x-fixture-token'];
    if (typeof token !== 'string') return null;
    const principal = principals[token];
    if (principal === undefined) return null;
    return { ...principal };
  };
}

// ---------------- 确定性时钟 ----------------

/**
 * 单一时间源：now() ISO / nowMs() epoch / advance(ms) 手动推进。
 * epoch→ISO 的换算用 new Date(epochMs)（确定性换算，非墙钟读取）。
 */
export function createDeterministicClock({ startIso = '2026-10-28T10:00:00.000Z' } = {}) {
  let currentMs = Date.parse(startIso);
  if (!Number.isFinite(currentMs)) {
    throw new Error(`createDeterministicClock: startIso must be a parseable ISO-8601 date-time (got ${JSON.stringify(startIso)})`);
  }
  const iso = () => new Date(currentMs).toISOString();
  return {
    now: iso,
    nowMs: () => currentMs,
    advance(ms) {
      if (typeof ms !== 'number' || !Number.isFinite(ms)) {
        throw new Error(`clock.advance requires a finite number of milliseconds (got ${JSON.stringify(ms)})`);
      }
      currentMs += ms;
      return iso();
    },
  };
}

// ---------------- 假模型 transport（W7 modelCaller 注入位） ----------------

/**
 * 可直接作 W7 modelCaller 注入的假 transport（validateModelCaller 只要求函数）。
 * 每次 call 记台账并返回脚本队列队首（耗尽回退确定性 ok 默认）。
 * successfulResultsFor：ok===true 且 result.model 非空才计——resolved_model=NULL
 * 的 not-ok 结果永不计真实成功（红线 7）。retryCount：attempt>1 的调用数。
 */
export function createFakeModelTransport({ model = 'fake-transport-model', now } = {}) {
  const queue = [];
  const calls = [];
  const transport = async (request) => {
    const runId = request?.runId ?? request?.ctx?.runId ?? null;
    const scripted = queue.length > 0 ? queue.shift() : null;
    const result = scripted ?? {
      ok: true,
      content: 'fake-transport: ok',
      model,
      usage: { inputTokens: 1, outputTokens: 1 },
    };
    const record = {
      runId,
      attempt: Number.isInteger(request?.attempt) ? request.attempt : 1,
      request,
      result,
      ...(typeof now === 'function' ? { at: now() } : {}),
    };
    calls.push(record);
    return result;
  };
  transport.enqueue = result => {
    queue.push(result);
    return transport;
  };
  transport.calls = calls;
  transport.successfulResultsFor = runId => calls
    .filter(call => call.runId === runId && call.result?.ok === true && call.result?.model != null)
    .length;
  transport.retryCount = runId => calls
    .filter(call => call.runId === runId && call.attempt > 1)
    .length;
  transport.reset = () => {
    calls.length = 0;
    queue.length = 0;
  };
  return transport;
}

// ---------------- 假 checker（W9 verify { checkers } 注入位） ----------------

const CHECKER_KINDS = Object.freeze({
  dod: 'dod-item',
  citation: 'citation',
  command: 'command-result',
  injection: 'injection-marker',
});

/**
 * W9 verify(artifact, dod, { checkers }) 的假 checkers：四个具名 checker
 * （dod/citation/command/injection），默认 PASS/LOW，script(name, checkOrFn) 覆盖。
 * 每次调用入 calls 台账；不读文件、不发网络、不碰墙钟。
 */
export function createFakeCheckers() {
  const calls = [];
  const scripted = new Map();
  const make = name => async (artifact, dod, ctx) => {
    calls.push({ name, artifactId: artifact?.id ?? null });
    const override = scripted.get(name);
    const outcome = typeof override === 'function' ? await override(artifact, dod, ctx) : override;
    const base = outcome ?? { status: 'PASS', severity: 'LOW', reason: `fake checker "${name}" scripted pass` };
    return { kind: CHECKER_KINDS[name], ref: `fake:${name}`, ...base };
  };
  const checkers = {
    dod: make('dod'),
    citation: make('citation'),
    command: make('command'),
    injection: make('injection'),
  };
  return {
    checkers,
    calls,
    script(name, checkOrFn) {
      if (!(name in CHECKER_KINDS)) {
        throw new Error(`fake checkers: unknown checker "${name}" (known: ${Object.keys(CHECKER_KINDS).join(', ')})`);
      }
      scripted.set(name, checkOrFn ?? null);
    },
  };
}

// ---------------- 假 gateway（W8 上游注入位；零真实网络） ----------------

/**
 * W8 上游桥的假 gateway：send(payload) 全记录、脚本队列应答、耗尽回退确定性
 * 默认。纯内存对象——构造与调用都不碰 socket/env/key。
 */
export function createFakeGateway() {
  const queue = [];
  const calls = [];
  return {
    calls,
    enqueue(response) {
      queue.push(response);
      return this;
    },
    async send(payload) {
      calls.push({ payload });
      return queue.length > 0
        ? queue.shift()
        : { ok: true, via: 'fake-gateway', method: payload?.method ?? null };
    },
  };
}

// ---------------- W12 vision mock（pipeline.start 注入位） ----------------

/**
 * W12 感知管线的假件，忠实 pipeline.start 契约：
 *   start(job) → { done: Promise<终态>, attribution }
 *   - emit('card.created', card) 后（若终态 upgraded）再 emit('card.upgraded', card)；
 *   - done 永不 reject（真实管线契约），默认终态 { status: 'upgraded', card }；
 *   - enqueueCard(card) 脚本化产物卡；耗尽用 job 素材构造默认卡。
 */
export function createVisionMock({ now } = {}) {
  const calls = [];
  const cardQueue = [];
  let scriptedDone = null;
  let scriptedAttribution = null;
  return {
    calls,
    enqueueCard(card) {
      cardQueue.push(card);
      return this;
    },
    setDone(doneResult) {
      scriptedDone = doneResult;
      return this;
    },
    setAttribution(attribution) {
      scriptedAttribution = attribution;
      return this;
    },
    start(job) {
      calls.push({
        captureId: job?.captureId ?? null,
        ownerId: job?.ownerId ?? null,
        kind: job?.kind ?? null,
        blockCount: Array.isArray(job?.blocks) ? job.blocks.length : 0,
        ...(typeof now === 'function' ? { at: now() } : {}),
      });
      const card = cardQueue.length > 0
        ? cardQueue.shift()
        : {
          captureId: job?.captureId ?? null,
          blockId: job?.blocks?.[0]?.id ?? 'blk-vision-mock',
          title: 'vision mock card',
          sources: 'discussion',
        };
      const done = (async () => {
        try {
          const emit = typeof job?.emit === 'function' ? job.emit : () => {};
          await emit('card.created', card);
          const terminal = scriptedDone ?? { status: 'upgraded', card };
          if (terminal.status === 'upgraded') await emit('card.upgraded', terminal.card ?? card);
          return terminal;
        } catch {
          // done 永不 reject（真实管线契约）：内部异常也结算为失败终态。
          return { status: 'failed', card: null, error: 'vision mock internal error' };
        }
      })();
      return {
        done,
        attribution: scriptedAttribution ?? { status: 'none', reason: 'fake-vision' },
      };
    },
  };
}

// ---------------- W4 副作用台账 ----------------

/**
 * 唯一的“外部副作用”假端口：perform(kind, payload) 记账并返回成功；
 * asExecutor(kind, payload) 产出可直接交给 W4 SideEffectFence.execute 的
 * executor——fence 拒绝（A5/P0/AUTONOMY_TOO_LOW…）时 executor 根本不会运行，
 * 台账保持零条。时间戳只来自注入时钟。
 */
export function createSideEffectLedger({ now, idGen } = {}) {
  const effects = [];
  let sequence = 0;
  const perform = async (kind, payload = null) => {
    const effect = {
      effectId: typeof idGen?.next === 'function' ? idGen.next('effect') : `fx-${String(++sequence).padStart(4, '0')}`,
      kind,
      payload,
      ...(typeof now === 'function' ? { at: now() } : {}),
    };
    effects.push(effect);
    return effect;
  };
  return {
    perform,
    effects: () => effects.slice(),
    count: kind => effects.filter(effect => effect.kind === kind).length,
    asExecutor: (kind, payload) => () => perform(kind, payload),
  };
}

// ---------------- req.json() 桥 ----------------

/**
 * 给 req.json() 形状的流路由（W3/W9）搭桥：复用 dispatcher env.readBody 的
 * 惰性单次读体（同一 promise，坏 JSON 得到统一 400 CONTRACT_INVALID 信封），
 * 不再让流路由自己消费请求流。
 */
export function withJsonBody(handler) {
  if (typeof handler !== 'function') {
    throw new Error('withJsonBody: a handler function is required');
  }
  return async function bridged(req, res, pathname, env) {
    if (typeof req.json !== 'function' && env && typeof env.readBody === 'function') {
      req.json = () => env.readBody();
    }
    return handler(req, res, pathname, env);
  };
}

// ---------------- SSE 收集器 ----------------

/**
 * 客户端侧 SSE 收集器：collect({ baseUrl, path, token }) → session。
 * 事件流在响应头到达即 resolve（帧异步累积）；非事件流应答（如 JSON 401 信封）
 * 在 body 读尽后 resolve，绝不把 JSON 误报成帧。close() 掐断连接 → 服务端
 * dispatcher 记 client_disconnect outcome=UNKNOWN（断开不吞）。
 */
export function createSseCollector() {
  async function collect({ baseUrl, path, token, headers: extraHeaders } = {}) {
    const url = new URL(path, baseUrl);
    const headers = {
      accept: 'text/event-stream',
      'x-tango-client': 'tango-settings/1',
      ...(token === undefined || token === null ? {} : { 'x-fixture-token': token }),
      ...(extraHeaders ?? {}),
    };
    return await new Promise((resolve, reject) => {
      let settledResolve = false;
      const req = http.request(
        {
          hostname: url.hostname,
          port: url.port,
          path: url.pathname + url.search,
          method: 'GET',
          headers,
          agent: false,
        },
        res => {
          const contentType = String(res.headers['content-type'] ?? '');
          const isEventStream = contentType.startsWith('text/event-stream');
          const frames = [];
          const chunks = [];
          let buffer = '';
          let state = isEventStream ? 'open' : 'closed';
          let settle;
          const done = new Promise(resolveDone => { settle = resolveDone; });
          const markClosed = () => {
            if (state !== 'closed') {
              state = 'closed';
              settle();
            }
          };
          const session = {
            status: res.statusCode,
            contentType,
            body: null,
            done,
            frames: () => frames.slice(),
            state: () => state,
            close() {
              req.destroy();
              markClosed();
            },
          };
          const settleOuter = () => {
            if (!settledResolve) {
              settledResolve = true;
              resolve(session);
            }
          };
          res.setEncoding('utf8');
          res.on('data', chunk => {
            chunks.push(chunk);
            if (!isEventStream) return;
            buffer += chunk;
            let boundary = buffer.indexOf('\n\n');
            while (boundary !== -1) {
              const block = buffer.slice(0, boundary);
              buffer = buffer.slice(boundary + 2);
              for (const line of block.split('\n')) {
                if (!line.startsWith('data:')) continue;
                const payload = line.replace(/^data:\s?/, '').trim();
                try {
                  frames.push(JSON.parse(payload));
                } catch {
                  frames.push(payload);
                }
              }
              boundary = buffer.indexOf('\n\n');
            }
          });
          res.on('end', () => {
            if (!isEventStream) {
              const text = chunks.join('');
              try {
                session.body = JSON.parse(text);
              } catch {
                session.body = text;
              }
            }
            markClosed();
            settleOuter();
          });
          res.on('close', () => {
            markClosed();
            settleOuter();
          });
          res.on('error', () => {
            markClosed();
            settleOuter();
          });
          if (isEventStream) settleOuter(); // 事件流：响应头即返回，帧异步累积
        },
      );
      req.on('error', reject);
      req.end();
    });
  }
  return { collect };
}

// ---------------- HTTP 客户端（localhost only） ----------------

const JSON_HEADERS = Object.freeze({
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
});

function requestJson({ baseUrl, method, path, body, headers: extraHeaders }) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const payload = body === undefined || body === null
      ? null
      : Buffer.from(JSON.stringify(body));
    const headers = {
      'x-tango-client': 'tango-settings/1', // W1 块路由的来源检查头（harness 客户端恒带）
      ...(extraHeaders ?? {}),
    };
    if (payload !== null) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = String(payload.length);
    }
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method,
        headers,
        agent: false,
      },
      res => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let parsed = null;
          try {
            parsed = JSON.parse(text);
          } catch {
            parsed = null;
          }
          resolve({
            status: res.statusCode,
            headers: res.headers,
            contentType: String(res.headers['content-type'] ?? ''),
            body: parsed ?? text,
            text,
          });
        });
      },
    );
    req.on('error', reject);
    if (payload !== null) req.write(payload);
    req.end();
  });
}

// ---------------- 组装：golden harness ----------------

/**
 * 组装 M21 基座（M22 黄金场景的直接依赖）。
 *
 * @param {object} options
 * @param {string}  [options.scenario='unspecified'] 场景标识（进事件/证据）。
 * @param {number}  [options.port]      首选端口（必须在 17701–17709；占用即构造失败）。
 * @param {object}  [options.principals] fixture 名册（默认 FIXTURE_PRINCIPALS）。
 * @param {string}  [options.startIso]  确定性时钟起点。
 * @param {Array<Function>} [options.handlers] 场景 handler（(req,res,pathname,env)=>handled）。
 * @param {Function}[options.legacy]    全部未处理时的落回（同形签名）。
 * @param {number}  [options.maxBodyBytes] dispatcher 统一 body 上限。
 * @param {object}  [options.policyPort] 显式策略端口（缺省=M13 deny-all fail-closed；
 *                  场景注入 W4 桥用 context 的 policy 配置或直接给端口）。
 * @param {object}  [options.modelTransport] 假模型 transport（缺省内建）。
 * @param {object}  [options.checkers]   假 checkers（缺省内建）。
 * @param {object}  [options.gateway]    假 gateway（缺省内建）。
 * @param {object}  [options.vision]     W12 vision mock（缺省内建）。
 * @param {string}  [options.evidenceDir] close() 时把证据 JSON 落到该目录。
 * @returns {Promise<object>} harness（见 golden-scenarios.test.mjs 头部契约注释）。
 */
export async function createGoldenHarness(options = {}) {
  const {
    scenario = 'unspecified',
    port,
    principals = FIXTURE_PRINCIPALS,
    startIso = '2026-10-28T10:00:00.000Z',
    handlers = [],
    legacy = null,
    evidenceDir,
  } = options;

  if (port !== undefined && (!Number.isInteger(port) || port < HARNESS_PORT_RANGE.min || port > HARNESS_PORT_RANGE.max)) {
    throw new Error(`createGoldenHarness: port must stay inside the harness range ${HARNESS_PORT_RANGE.min}-${HARNESS_PORT_RANGE.max} (got ${String(port)})`);
  }
  if (!Array.isArray(handlers) || handlers.some(handler => typeof handler !== 'function')) {
    throw new Error('createGoldenHarness: handlers must be an array of (req,res,pathname,env)=>handled functions');
  }
  if (legacy !== null && legacy !== undefined && typeof legacy !== 'function') {
    throw new Error('createGoldenHarness: legacy must be a function or null');
  }

  // —— 单一组合根：同一 db/时钟/idGen/events/traceSink/policyPort（fail-closed）——
  const clock = createDeterministicClock({ startIso });
  const auth = createFixtureAuth({ principals });
  const startedAt = clock.now();
  const tempDirPath = await mkdtemp(join(tmpdir(), `w13-harness-${scenario.replace(/[^a-z0-9-]/gi, '-')}-`));
  const dbFile = join(tempDirPath, 'harness.db');
  const context = createIntegrationContext({
    dbFile,
    now: clock.now,
    auth,
    ...(options.policyPort !== undefined ? { policyPort: options.policyPort } : {}),
  });

  // —— 假件（可注入替换；默认全部内建，零真实外呼）——
  const modelTransport = options.modelTransport ?? createFakeModelTransport({ now: clock.now });
  const checkers = options.checkers ?? createFakeCheckers();
  const gateway = options.gateway ?? createFakeGateway();
  const vision = options.vision ?? createVisionMock({ now: clock.now });
  const sideEffectLedger = createSideEffectLedger({ now: clock.now });

  // —— 执行层闸门：M15 适配器是唯一入口，被拒行留在同步层（UNKNOWN+原因）——
  const executionLayer = new Map();
  const adapt = (dto, ownerKey = 'primary') => {
    const principal = principals[ownerKey];
    if (principal === undefined) {
      throw new Error(`harness.adapt: unknown fixture owner key "${ownerKey}" (known: ${Object.keys(principals).join(', ')})`);
    }
    const result = adaptW1DtoToBlock(dto, { ownerId: principal.ownerId, now: clock.now });
    if (result.ok) {
      executionLayer.set(result.block.id, { ...result.block });
      context.events.emit({
        type: 'block.execution_ready',
        blockId: result.block.id,
        ownerId: principal.ownerId,
        at: clock.now(),
      });
    } else {
      context.events.emit({
        type: 'block.stays_in_sync_layer',
        blockId: typeof dto?.id === 'string' ? dto.id : null,
        ownerId: principal.ownerId,
        outcome: 'UNKNOWN',
        reason: result.reason,
        missing: [...result.missing],
        at: clock.now(),
      });
    }
    return result;
  };

  // —— dispatcher：health 先挂（public），场景 handler 次之，legacy 兜底 ——
  const healthHandler = createHealthHandler(context);
  context.handlers = [
    'GET /api/agentic/health',
    ...handlers.map((handler, index) => `scenario:${handler.name || `handler-${index + 1}`}`),
    ...(legacy ? ['legacy:fallback'] : []),
  ];
  const dispatcherOptions = {
    context,
    handlers: [healthHandler, ...handlers],
  };
  if (legacy) dispatcherOptions.legacy = legacy;
  if (options.maxBodyBytes !== undefined) dispatcherOptions.maxBodyBytes = options.maxBodyBytes;
  const dispatcher = createAgenticDispatcher(dispatcherOptions);

  // —— HTTP 台账（时间戳来自注入时钟，绝不墙钟）——
  const httpJournal = [];

  const server = http.createServer((req, res) => {
    void (async () => {
      const at = clock.now();
      let pathname = '/';
      try {
        pathname = new URL(req.url, 'http://127.0.0.1/').pathname;
      } catch {
        // 保不住解析时按 '/' 处理（构造期已知合法 url 才到这）
      }
      let ownerId = null;
      try {
        ownerId = auth(req)?.ownerId ?? null;
      } catch {
        ownerId = null;
      }
      let handled = false;
      try {
        handled = await dispatcher.handle(req, res, pathname);
      } catch {
        // dispatcher 自身不抛；极端故障也收敛为冻结信封，不让 socket 悬挂。
        handled = true;
        if (!res.headersSent) {
          res.writeHead(500, JSON_HEADERS);
        }
        if (!res.writableEnded) {
          res.end(JSON.stringify({ error: { code: 'INTERNAL_ERROR', message: 'internal error' } }));
        }
      }
      if (!handled && !res.headersSent) {
        res.writeHead(404, JSON_HEADERS);
        res.end(JSON.stringify({
          error: {
            code: 'NOT_FOUND',
            message: `no agentic handler for ${req.method} ${pathname}`,
            requestId: context.idGen.next('req'),
          },
        }));
      }
      httpJournal.push({ at, method: req.method, pathname, ownerId, status: res.statusCode });
    })();
  });

  const chosenPort = port ?? (await pickHarnessPort());
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(chosenPort, '127.0.0.1', () => resolve());
  });
  const baseUrl = `http://127.0.0.1:${chosenPort}`;

  // —— 证据：事件序列 / HTTP 台账 / 最终状态 ——
  const evidence = () => ({
    scenario,
    port: chosenPort,
    baseUrl,
    startedAt,
    clock: clock.now(),
    events: context.events.recorded(),
    http: httpJournal.slice(),
    externalEffects: sideEffectLedger.effects(),
    executionLayerBlocks: [...executionLayer.values()],
    finalState: {
      executionLayerBlockCount: executionLayer.size,
      eventCount: context.events.recorded().length,
      externalEffectCount: sideEffectLedger.effects().length,
      httpExchangeCount: httpJournal.length,
    },
  });

  const persistEvidence = () => {
    const target = join(evidenceDir, `${scenario.replace(/[^a-z0-9-]/gi, '-')}-evidence.json`);
    const staging = `${target}.tmp`;
    writeFileSync(staging, `${JSON.stringify(evidence(), null, 2)}\n`, 'utf8');
    renameSync(staging, target);
    return target;
  };

  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    if (evidenceDir) {
      try {
        persistEvidence();
      } catch {
        // 证据落盘失败不得阻塞拆机（证据仍可经 evidence() 内存快照取得）
      }
    }
    // 先掐空闲/遗留连接（泄漏的 SSE 会话不阻塞拆机），再等 close 回调。
    server.closeIdleConnections?.();
    await new Promise(resolve => {
      server.close(() => resolve());
      server.closeAllConnections?.();
    });
    try {
      context.db.close?.();
    } catch {
      // db 可能已关
    }
    await rm(tempDirPath, { recursive: true, force: true });
  };

  const as = ownerKey => {
    const principal = principals[ownerKey];
    if (principal === undefined) {
      throw new Error(`harness.as: unknown fixture owner key "${ownerKey}" (known: ${Object.keys(principals).join(', ')})`);
    }
    return {
      ownerKey,
      ownerId: principal.ownerId,
      device: principal.device,
      request: (method, path, body) => requestJson({
        baseUrl,
        method,
        path,
        body,
        headers: { 'x-fixture-token': ownerKey },
      }),
      sse: path => createSseCollector().collect({ baseUrl, path, token: ownerKey }),
    };
  };

  return {
    scenario,
    port: chosenPort,
    baseUrl,
    clock,
    tempDir: tempDirPath,
    dbFile,
    db: context.db,
    context,
    dispatcher,
    modelTransport,
    checkers,
    gateway,
    vision,
    sideEffectLedger,
    externalEffects: () => sideEffectLedger.effects(),
    adapt,
    executionLayerBlocks: () => [...executionLayer.values()],
    events: () => context.events.recorded(),
    httpJournal: () => httpJournal.slice(),
    as,
    request: (method, path, body) => requestJson({ baseUrl, method, path, body }),
    evidence,
    close,
  };
}
