// S2D-W13 · M17 集成健康检查（scripts/agentic/integration/health.mjs）。
//
// 依据：brief §3 允许域「集成健康检查」、§5.8/M26（发布候选启动后
// /api/agentic/health 可读）；plan.md §G2 M17——db+`_migrations` 台账、
// 路由注册表、上游配置在位性（不回显 secret）、容器自检。
//
// 职责（handler 形状与 M14 dispatcher 挂载约定同构：
//   (req, res, pathname, env) => handled:boolean；非 GET/非本路径 → false，
//   不触碰响应，落回 dispatcher 后续 handler/legacy）：
//   - GET /api/agentic/health → 200 application/json（no-store）：
//       status:'ok'、generatedAt（组合根确定性时钟单次取值——无隐藏墙钟）、
//       db:{ ok, migrations }（W0 单台账 _migrations 活探针，非构造期快照）、
//       routes（context.handlers 注册表投影）、
//       upstreams（在位性投影：只报 configured/endpoint，绝不回显 secret）、
//       container:{ ok, checks }（clock/auth/idGen/events/traceSink/policyPort
//       六端口逐项自检——M13 组合根缺一不可）。
//   - 任一子系统不健康（db 不可读 / 容器端口缺失）→ 503 + 冻结错误信封
//     UPSTREAM_UNAVAILABLE（dispatcher ERROR_STATUS 同源枚举），details.subsystems
//     只点名失败子系统——不回显原始异常文本（防内部路径/栈泄露）。
//   - 免鉴权（M14 dispatcher PUBLIC_PATHS 已放行 /api/agentic/health；
//     本 handler 自身不校验 principal——release 探活路径 auth()===null 也可读）。
//
// 红线（红线 4 自守，同 M13 context-seams 源码审计规则）：本模块无
// Date.now/new Date/环境变量读取/fetch/网络或子进程 import——健康报告里的
// 时间一律来自注入时钟；不读 key；无外部调用。
//
// 不回显 secret 的三道防线：
//   1. 上游投影白名单字段（configured/endpoint），对象其余字段一律丢弃；
//   2. endpoint 剥离 query（?token=… 兜底），再匹配 sk- 形状则整值不报；
//   3. 不读环境变量、不 dump 配置对象——canary 探针（W13_HEALTH_CANARY）
//      从构造到响应全程不可见（测试锁定）。

import { ERROR_STATUS } from './dispatcher.mjs';

const HEALTH_PATH = '/api/agentic/health';

const JSON_HEADERS = Object.freeze({
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
});

/** key material 形状兜底（与测试断言 /sk-[A-Za-z0-9]{8,}/ 同源）。 */
const SECRET_SHAPE = /sk-[A-Za-z0-9]{8,}/;

function healthError(code, message, details) {
  const error = new Error(message);
  error.name = 'IntegrationHealthError';
  error.code = code;
  if (details !== undefined) error.details = details;
  return error;
}

// ---------------- 注册表 / 上游投影（纯函数，白名单出参） ----------------

/**
 * 路由注册表投影：context.handlers（挂载方传入的有序注册表）只保留可展示
 * 标签——字符串（prefix）原样、对象取 prefix/name 字符串字段、函数形态无
 * 稳定标签不入表（挂载方应显式传 prefix 标签）。
 */
function projectRouteRegistry(handlers) {
  if (!Array.isArray(handlers)) return [];
  const routes = [];
  for (const entry of handlers) {
    if (typeof entry === 'string') {
      if (entry !== '') routes.push(entry);
      continue;
    }
    if (entry !== null && typeof entry === 'object') {
      const label = typeof entry.prefix === 'string' && entry.prefix !== '' ? entry.prefix
        : typeof entry.name === 'string' && entry.name !== '' ? entry.name
        : null;
      if (label !== null) routes.push(label);
    }
  }
  return routes;
}

/**
 * 上游配置在位性投影：每个上游只报 { configured, endpoint? }——
 * configured 严格 ===true；endpoint 仅接受字符串，剥 query 后仍带 key
 * material 形状则整值丢弃。非对象/数组/null 的 upstreams 输入 → {}。
 */
function projectUpstreams(upstreams) {
  const projected = {};
  if (upstreams === null || upstreams === undefined) return projected;
  if (typeof upstreams !== 'object' || Array.isArray(upstreams)) return projected;
  for (const [name, config] of Object.entries(upstreams)) {
    const entry = { configured: false };
    if (config !== null && typeof config === 'object') {
      entry.configured = config.configured === true;
      if (typeof config.endpoint === 'string' && config.endpoint !== '') {
        const bare = config.endpoint.split('?')[0];
        if (!SECRET_SHAPE.test(bare)) entry.endpoint = bare;
      }
    }
    projected[name] = entry;
  }
  return projected;
}

// ---------------- 子系统探针 ----------------

/** db+`_migrations` 活探针：读单台账已应用迁移名（W0 migrate 的唯一台账）。 */
function probeMigrationLedger(db) {
  const rows = db.prepare('SELECT name FROM _migrations ORDER BY name').all();
  const migrations = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    if (typeof row?.name === 'string' && row.name !== '') migrations.push(row.name);
  }
  return migrations;
}

/**
 * 容器自检：M13 组合根六端口逐项点名。clock.now() 恰好调用一次并捕获返回值
 * （generatedAt 唯一来源——健康报告不引入第二个时间源）；返回非空字符串才过，
 * 抛错/非字符串一律 fail（fail-closed：无法证明健康就是不健康）。
 */
function selfCheckContainer(context) {
  const checks = [];
  let generatedAt = null;
  let clockOk = false;
  try {
    const value = context.clock.now();
    if (typeof value === 'string' && value !== '') {
      generatedAt = value;
      clockOk = true;
    }
  } catch {
    clockOk = false; // 时钟源故障按不健康处理，不吞
  }
  checks.push({ name: 'clock', ok: clockOk });

  checks.push({ name: 'auth', ok: typeof context.auth === 'function' });

  const portHas = (port, method) => port !== null && typeof port === 'object'
    && typeof port[method] === 'function';
  // idGen 两形状（M13）：{ next } 或裸函数。
  checks.push({
    name: 'idGen',
    ok: typeof context.idGen === 'function' || portHas(context.idGen, 'next'),
  });
  checks.push({ name: 'events', ok: portHas(context.events, 'emit') });
  checks.push({ name: 'traceSink', ok: portHas(context.traceSink, 'record') });
  checks.push({ name: 'policyPort', ok: portHas(context.policyPort, 'check') });
  checks.push({ name: 'db', ok: portHas(context.db, 'prepare') });

  return { ok: checks.every(check => check.ok), checks, generatedAt };
}

// ---------------- 健康检查 handler ----------------

/**
 * 创建 `/api/agentic/health` handler（M14 dispatcher 挂载形状）。
 *
 * 构造期（接线错误，非运行时健康裁决）要求 context 提供 M13 组合根的
 * 必需端口——auth 函数、clock.now 函数、db.prepare 函数；缺任一即抛
 * IntegrationHealthError（与 createIntegrationContext 的构造哲学一致：
 * 挂载前就该炸，不等到第一个请求）。其余端口（idGen/events/traceSink/
 * policyPort）归运行时容器自检（fail-closed → 503，可被健康报告点名）。
 *
 * @param {object} context M13 组合根（db/clock/auth/idGen/events/traceSink/
 *                         policyPort）；可选 handlers（路由注册表：字符串
 *                         prefix 或 { prefix|name }）与 upstreams（上游在位
 *                         性配置映射）。
 * @returns {(req, res, pathname, env) => Promise<boolean>} handled:boolean
 */
export function createHealthHandler(context) {
  if (context === null || typeof context !== 'object') {
    throw healthError(
      'INTEGRATION_HEALTH_CONTEXT_INVALID',
      'createHealthHandler: the M13 integration context object is required (db/clock/auth/...)',
    );
  }
  if (typeof context.auth !== 'function') {
    throw healthError(
      'INTEGRATION_HEALTH_CONTEXT_INVALID',
      'createHealthHandler: context.auth must be a function (single principal resolver)',
    );
  }
  if (context.clock === null || typeof context.clock !== 'object' || typeof context.clock.now !== 'function') {
    throw healthError(
      'INTEGRATION_HEALTH_CONTEXT_INVALID',
      'createHealthHandler: context.clock.now() is required — health timestamps come from the injected deterministic clock only',
    );
  }
  if (context.db === null || typeof context.db !== 'object' || typeof context.db.prepare !== 'function') {
    throw healthError(
      'INTEGRATION_HEALTH_CONTEXT_INVALID',
      'createHealthHandler: context.db with prepare() is required (single W0-migrated db)',
    );
  }

  return async function healthHandler(req, res, pathname) {
    if (req?.method !== 'GET' || pathname !== HEALTH_PATH) return false;

    // —— 子系统探针：容器端口 + db 活探针（各自 fail-closed，异常不外溢文本）。
    const container = selfCheckContainer(context);
    let migrations = null;
    let dbOk = true;
    try {
      migrations = probeMigrationLedger(context.db);
    } catch {
      dbOk = false; // sqlite 故障（含 prepare 抛错）→ 不健康；原始 message 不回显
    }

    if (!container.ok || !dbOk) {
      const failed = new Set(container.checks.filter(check => !check.ok).map(check => check.name));
      if (!dbOk) failed.add('db');
      const subsystems = [...failed];
      res.writeHead(ERROR_STATUS.UPSTREAM_UNAVAILABLE, JSON_HEADERS);
      res.end(JSON.stringify({
        error: {
          code: 'UPSTREAM_UNAVAILABLE',
          message: `agentic health check failed: ${subsystems.join(', ')} not healthy`,
          details: { subsystems },
        },
      }));
      return true;
    }

    res.writeHead(200, JSON_HEADERS);
    res.end(JSON.stringify({
      status: 'ok',
      generatedAt: container.generatedAt,
      db: { ok: true, migrations },
      routes: projectRouteRegistry(context.handlers),
      upstreams: projectUpstreams(context.upstreams),
      container: { ok: true, checks: container.checks },
    }));
    return true;
  };
}
