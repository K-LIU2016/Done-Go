// W7 M7 · tool-registry-mcp — MCP 客户端薄封装 + 调用全链路审计（mcp.mjs）
//
// 依据：.s2d/plan.md M7；brief 裁决⑤（MCP 工具先登记 capability manifest 再
// policyPort.check；工具输入 / 资源 scope / data disclosure / 预算 / Grant 任一
// 不满足即拒；外部内容当数据处理，不得改变 WorkOrder/合同/权限）+ 裁决⑥
// （UNKNOWN 台账只对账、不自动重试）。
//
// 组合方式（tests/unit/agentic/tool-registry/mcp.test.mjs 即规格）：
//   * createMcpClient({ transport, timeoutMs })：JSON-RPC 2.0 形状的 MCP 客户端；
//     transport 是注入的 { send(request) → response }（HTTP/stdio 接线归 W13，
//     测试全 mock，不引 MCP SDK、不联网、不新增依赖——PRD §10.1 A6 建议引 SDK，
//     但 BUILD-PLAN §2.3 与 brief 红线⑤禁新增依赖，故自写最小封装）。
//     超时/断连/JSON-RPC error/非结构化响应 → UPSTREAM_UNAVAILABLE（结构化上抛，
//     message 不携带上游正文/凭据，保留上游 error code 供对账）。
//   * createToolAuditStore({ db, now? })：w7_tools / w7_tool_calls 台账
//     （迁移 w7-3-tool-registry.sql）。owner 过滤；(owner, idempotency_key) 幂等：
//     同 key 同 payload_hash → replay，异载 → CONFLICT。status='unknown' 行
//     没有任何出队/重试入口（UNKNOWN 只对账，brief 裁决⑥）。
//   * invokeTool({ registry, client, audit, toolName, args, ctx, idempotencyKey })：
//     全链路 = 参数/Grant 状态 fail-closed 检查（独立纵深防御：grant.status !== 'active'
//     即拒，不依赖 M6/policyPort 是否记得查）→ 幂等重放（重放只对账，绝不重新 invoke）
//     → registry.call（M6：未登记/policy/inputSchema/scope/disclosure/quota/Grant 闸）
//     → client.callTool（真实 MCP 调用，注入 transport）→ 外部内容扫描隔离
//     → 审计落账。transport 超时/断连 → 台账 status='unknown'（外副作不可知）。
//
// 跨组约束：G3 不 import G1（runtime/**）/G2（model-router/**）文件；冻结契约
// 校验器 `../contracts.mjs`（W0 骨架，全流共享）与同组 `./registry.mjs` 形状
// （鸭子类型，不直接 import——invokeTool 接受任何满足 { call, listTools } 的注入）
// 是仅有的外部形状。错误码全部落在冻结 api-error.schema.json 枚举内。
//
// 时钟（红线⑥）：quota/expiry 判定不在本层（M6 用注入 clock）；本层时间戳
// 优先用 registry 返回的 `.at`（M6 注入时钟派生）或注入的 invokeTool clock，
// store 直用时可选注入 now（缺省真实时钟，仅簿记列——同 M2/M5 约定）。

import { createHash } from 'node:crypto';
import { canonicalJson } from '../contracts.mjs';

// ---------------- 自带最小 fail-closed 错误工厂（对齐冻结 api-error 枚举） ----------------

const MCP_ERROR_CODES = new Set([
  'FORBIDDEN',
  'CONTRACT_INVALID',
  'CONFLICT',
  'UPSTREAM_UNAVAILABLE',
]);

const REDACTIONS = [
  [/\bbearer\s+\S+/gi, 'bearer [REDACTED]'],
  [/(authorization)(\s*[:=]\s*)(bearer\s+)?\S+/gi, '$1$2$3[REDACTED]'],
  [/\bsk-[A-Za-z0-9_-]{4,}/g, 'sk-[REDACTED]'],
  [/\b(cookie)(\s*[:=]\s*)\S+/gi, '$1$2[REDACTED]'],
  [/((?:x-)?api[_-]?key|token)(\s*[:=]\s*)\S+/gi, '$1$2[REDACTED]'],
];

/** 脱敏 message（不携带 key/Authorization/cookie/上游正文），且永不返回空串。 */
function sanitizeMessage(message, fallback) {
  let text = typeof message === 'string' ? message : '';
  for (const [pattern, replacement] of REDACTIONS) {
    text = text.replaceAll(pattern, replacement);
  }
  text = text.trim();
  return text === '' ? fallback : text;
}

function fail(code, message, details) {
  if (!MCP_ERROR_CODES.has(code)) {
    throw new TypeError(`invalid tool-registry-mcp error code ${String(code)}`);
  }
  const error = new Error(message);
  error.code = code;
  if (details !== undefined) error.details = details;
  return error;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isFunction(value) {
  return typeof value === 'function';
}

function requireNonEmptyString(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw fail('CONTRACT_INVALID', `${label} must be a non-empty string (got ${value === null ? 'null' : typeof value})`);
  }
  return value;
}

function sha256Hex(text) {
  return createHash('sha256').update(text).digest('hex');
}

// ---------------- MCP 客户端（transport 全注入） ----------------

/**
 * createMcpClient({ transport, timeoutMs, clientInfo? }) → { initialize, listTools, callTool }
 *
 * - transport：注入的 { send(request) → Promise<response> }；JSON-RPC 2.0 信封
 *   由本封装构造（id 单调递增，从 1 开始），响应只需 { result } 或 { error }。
 * - timeoutMs：每次请求的超时（毫秒）；超时 → UPSTREAM_UNAVAILABLE。
 * - 响应带 { error: { code } } → UPSTREAM_UNAVAILABLE，message 保留上游 code
 *   （如 "-32000"）供对账，但不回显上游 message 正文（可能是注入载荷）。
 */
export function createMcpClient({ transport, timeoutMs, clientInfo } = {}) {
  if (!isPlainObject(transport) || !isFunction(transport.send)) {
    throw fail(
      'CONTRACT_INVALID',
      `transport must be injected as { send(request) → response } (got ${transport === null ? 'null' : typeof transport}); this client never wires a real connection itself`,
    );
  }
  if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw fail('CONTRACT_INVALID', 'timeoutMs must be a positive finite number of milliseconds');
  }
  const client = isPlainObject(clientInfo) ? clientInfo : { name: 'w7-tool-registry', version: '0.0.0' };

  let nextId = 1;

  function timeoutError(method) {
    return fail('UPSTREAM_UNAVAILABLE', `MCP ${method} request timed out after ${timeoutMs}ms (injected transport)`);
  }

  async function rpc(method, params) {
    const request = {
      jsonrpc: '2.0',
      id: nextId,
      method,
      ...(params === undefined ? {} : { params }),
    };
    nextId += 1;
    let response;
    try {
      const timer = new Promise((_, reject) => {
        setTimeout(() => reject(timeoutError(method)), timeoutMs);
      });
      response = await Promise.race([transport.send(request), timer]);
    } catch (cause) {
      if (cause?.code === 'UPSTREAM_UNAVAILABLE') throw cause;
      // 断连/注入 transport 自身故障：不回显 cause 文本（可能带 URL/凭据片段）。
      throw fail(
        'UPSTREAM_UNAVAILABLE',
        `MCP ${method} transport failed (${cause?.name ?? 'unknown'}); no connection or response`,
      );
    }
    if (!isPlainObject(response)) {
      throw fail('UPSTREAM_UNAVAILABLE', `MCP ${method} returned a non-object response`);
    }
    if (response.error !== undefined) {
      const upstreamCode = isPlainObject(response.error) ? response.error.code : undefined;
      const shown = typeof upstreamCode === 'number' || typeof upstreamCode === 'string' ? String(upstreamCode) : 'unknown';
      throw fail('UPSTREAM_UNAVAILABLE', `MCP ${method} responded with error ${shown}`, { upstreamCode });
    }
    if (!Object.prototype.hasOwnProperty.call(response, 'result')) {
      throw fail('UPSTREAM_UNAVAILABLE', `MCP ${method} response carries neither result nor error`);
    }
    return response.result;
  }

  /** MCP initialize 握手；结果必须是带 serverInfo 的对象。 */
  async function initialize() {
    const result = await rpc('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: client,
    });
    if (!isPlainObject(result) || !isPlainObject(result.serverInfo)) {
      throw fail('UPSTREAM_UNAVAILABLE', 'MCP initialize result must be an object carrying serverInfo');
    }
    return result;
  }

  /** MCP tools/list；结果必须是 { tools: [...] }。 */
  async function listTools() {
    const result = await rpc('tools/list', {});
    if (!isPlainObject(result) || !Array.isArray(result.tools)) {
      throw fail('UPSTREAM_UNAVAILABLE', 'MCP tools/list result must be an object with a tools array');
    }
    return result;
  }

  /** MCP tools/call；结果必须是对象（内容形状由 invokeTool 扫描判定，本层不猜）。 */
  async function callTool(name, args = {}) {
    requireNonEmptyString(name, 'tool name');
    if (!isPlainObject(args)) {
      throw fail('CONTRACT_INVALID', `tools/call arguments must be an object (got ${Array.isArray(args) ? 'array' : typeof args})`);
    }
    const result = await rpc('tools/call', { name, arguments: args });
    if (!isPlainObject(result)) {
      throw fail('UPSTREAM_UNAVAILABLE', 'MCP tools/call result must be an object (structured content required)');
    }
    return result;
  }

  return { initialize, listTools, callTool };
}

// ---------------- 审计台账（w7_tools / w7_tool_calls） ----------------

const CALL_STATUSES = new Set(['succeeded', 'failed', 'unknown', 'rejected']);

function callRow(record) {
  return {
    id: record.id,
    ownerId: record.owner_id,
    connectorId: record.connector_id,
    toolName: record.tool_name,
    grantId: record.grant_id,
    policyDecision: record.policy_decision,
    resultSummary: record.result_summary,
    status: record.status,
    idempotencyKey: record.idempotency_key,
    payloadHash: record.payload_hash,
    externalId: record.external_id,
    resultPayload: record.result_payload,
    errorCode: record.error_code,
    calledAt: record.called_at,
  };
}

function connectorRow(record) {
  return {
    id: record.id,
    ownerId: record.owner_id,
    connectorId: record.connector_id,
    name: record.name,
    transport: record.transport,
    manifestHash: record.manifest_hash,
    manifest: JSON.parse(record.manifest),
    tools: record.tools === null ? null : JSON.parse(record.tools),
    registeredAt: record.registered_at,
  };
}

/**
 * createToolAuditStore({ db, now? }) →
 *   { recordToolCall, findToolCall, listToolCalls, recordConnector, listConnectors }
 *
 * - db：openAgenticDb + migrate 后的句柄（表见 w7-3-tool-registry.sql）。
 * - now：可选 () → ISO 字符串，直用本台账时的簿记时钟；服务层（invokeTool）
 *   会显式传入 clock 派生的时间，确定性场景不依赖缺省值。
 * - recordToolCall：(owner_id, idempotency_key) 幂等——同 key 同 payload_hash
 *   返回 { record, replayed:true }（不落新行）；异 payload_hash → CONFLICT。
 * - 台账没有任何 retry/requeue 入口：status='unknown' 行只能人工对账（裁决⑥）。
 */
export function createToolAuditStore({ db, now } = {}) {
  if (!isPlainObject(db) || !isFunction(db.prepare)) {
    throw new Error('tool-registry audit store: an agentic db handle is required (openAgenticDb + migrate)');
  }
  const nowIso = isFunction(now) ? now : () => new Date().toISOString();

  function recordToolCall(entry) {
    if (!isPlainObject(entry)) {
      throw fail('CONTRACT_INVALID', `audit.recordToolCall requires an entry object (got ${Array.isArray(entry) ? 'array' : typeof entry})`);
    }
    const ownerId = requireNonEmptyString(entry.ownerId, 'entry.ownerId');
    const toolName = requireNonEmptyString(entry.toolName, 'entry.toolName');
    const idempotencyKey = requireNonEmptyString(entry.idempotencyKey, 'entry.idempotencyKey');
    const payloadHash = requireNonEmptyString(entry.payloadHash, 'entry.payloadHash');
    if (!CALL_STATUSES.has(entry.status)) {
      throw fail('CONTRACT_INVALID', `entry.status must be one of ${[...CALL_STATUSES].join('/')}; got ${String(entry.status)}`);
    }
    const optional = (value, label) => {
      if (value === undefined || value === null) return null;
      if (typeof value !== 'string' || value.length === 0) {
        throw fail('CONTRACT_INVALID', `${label} must be a non-empty string or null when present`);
      }
      return value;
    };
    const connectorId = optional(entry.connectorId, 'entry.connectorId');
    const grantId = optional(entry.grantId, 'entry.grantId');
    const policyDecision = optional(entry.policyDecision, 'entry.policyDecision');
    const resultSummary = optional(entry.resultSummary, 'entry.resultSummary');
    const externalId = optional(entry.externalId, 'entry.externalId');
    const errorCode = optional(entry.errorCode, 'entry.errorCode');
    if (entry.resultPayload !== undefined && entry.resultPayload !== null && !isPlainObject(entry.resultPayload)) {
      throw fail('CONTRACT_INVALID', 'entry.resultPayload must be a plain object or null when present');
    }
    const resultPayload = entry.resultPayload === undefined || entry.resultPayload === null
      ? null
      : JSON.stringify(entry.resultPayload);
    const calledAt = typeof entry.calledAt === 'string' && entry.calledAt.length > 0 ? entry.calledAt : nowIso();

    const existing = db
      .prepare('SELECT * FROM w7_tool_calls WHERE owner_id = ? AND idempotency_key = ?')
      .get(ownerId, idempotencyKey);
    if (existing) {
      if (existing.payload_hash !== payloadHash) {
        throw fail('CONFLICT', `idempotency key ${idempotencyKey} already recorded with a different payload for owner ${ownerId}`);
      }
      return { record: callRow(existing), replayed: true };
    }
    const inserted = db
      .prepare(
        `INSERT INTO w7_tool_calls
           (owner_id, connector_id, tool_name, grant_id, policy_decision, result_summary,
            status, idempotency_key, payload_hash, external_id, result_payload, error_code, called_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        ownerId, connectorId, toolName, grantId, policyDecision, resultSummary,
        entry.status, idempotencyKey, payloadHash, externalId, resultPayload, errorCode, calledAt,
      );
    const record = db.prepare('SELECT * FROM w7_tool_calls WHERE id = ?').get(Number(inserted.lastInsertRowid));
    return { record: callRow(record), replayed: false };
  }

  function findToolCall({ ownerId, idempotencyKey } = {}) {
    requireNonEmptyString(ownerId, 'ownerId');
    requireNonEmptyString(idempotencyKey, 'idempotencyKey');
    const record = db
      .prepare('SELECT * FROM w7_tool_calls WHERE owner_id = ? AND idempotency_key = ?')
      .get(ownerId, idempotencyKey);
    return record ? callRow(record) : null;
  }

  function listToolCalls({ ownerId } = {}) {
    requireNonEmptyString(ownerId, 'ownerId');
    return db
      .prepare('SELECT * FROM w7_tool_calls WHERE owner_id = ? ORDER BY id')
      .all(ownerId)
      .map(callRow);
  }

  /**
   * 登记清单快照（w7_tools）：(owner, connector) 幂等——同 manifest_hash 重登记
   * 是 replay；异 manifest_hash → CONFLICT。manifest 校验归 M6 registry
   * （冻结 connector.schema.json），本表只做形状最小校验 + 持久化。
   */
  function recordConnector(entry) {
    if (!isPlainObject(entry)) {
      throw fail('CONTRACT_INVALID', 'audit.recordConnector requires an entry object');
    }
    const ownerId = requireNonEmptyString(entry.ownerId, 'entry.ownerId');
    const manifest = entry.manifest;
    if (!isPlainObject(manifest)) {
      throw fail('CONTRACT_INVALID', 'entry.manifest must be the connector manifest object (validated by the registry)');
    }
    requireNonEmptyString(manifest.id, 'entry.manifest.id');
    requireNonEmptyString(manifest.name, 'entry.manifest.name');
    requireNonEmptyString(manifest.transport, 'entry.manifest.transport');
    if (entry.tools !== undefined && entry.tools !== null && !Array.isArray(entry.tools)) {
      throw fail('CONTRACT_INVALID', 'entry.tools must be an array of tool descriptors or null when present');
    }
    const manifestHash = sha256Hex(canonicalJson(manifest));
    const registeredAt = typeof entry.registeredAt === 'string' && entry.registeredAt.length > 0
      ? entry.registeredAt
      : nowIso();
    const toolsJson = entry.tools === undefined || entry.tools === null ? null : JSON.stringify(entry.tools);

    const existing = db
      .prepare('SELECT * FROM w7_tools WHERE owner_id = ? AND connector_id = ?')
      .get(ownerId, manifest.id);
    if (existing) {
      if (existing.manifest_hash !== manifestHash) {
        throw fail('CONFLICT', `connector ${manifest.id} already registered with a different manifest for owner ${ownerId}`);
      }
      return { record: connectorRow(existing), replayed: true };
    }
    db.prepare(
      `INSERT INTO w7_tools
         (owner_id, connector_id, name, transport, manifest_hash, manifest, tools, registered_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(ownerId, manifest.id, manifest.name, manifest.transport, manifestHash, JSON.stringify(manifest), toolsJson, registeredAt);
    const record = db
      .prepare('SELECT * FROM w7_tools WHERE owner_id = ? AND connector_id = ?')
      .get(ownerId, manifest.id);
    return { record: connectorRow(record), replayed: false };
  }

  function listConnectors({ ownerId } = {}) {
    requireNonEmptyString(ownerId, 'ownerId');
    return db
      .prepare('SELECT * FROM w7_tools WHERE owner_id = ? ORDER BY id')
      .all(ownerId)
      .map(connectorRow);
  }

  return { recordToolCall, findToolCall, listToolCalls, recordConnector, listConnectors };
}

// ---------------- 外部内容扫描（与 M6 同风格：只作数据，可疑即隔离） ----------------

/** 指令劫持/越权模式（与 registry.mjs 的 INJECTION_PATTERNS 保持同清单语义）。 */
const INJECTION_PATTERNS = [
  { label: 'ignore-previous-instructions', re: /\bignore\s+(?:all\s+|any\s+)?(?:previous|prior|above)\s+instructions?\b/i },
  { label: 'disregard-previous-instructions', re: /\bdisregard\s+(?:all\s+|any\s+)?(?:previous|prior|above)\s+instructions?\b/i },
  { label: 'system-prompt-override', re: /\bsystem[\s_-]*prompt[\s_-]*override\b/i },
  { label: 'unrestricted-persona', re: /\byou\s+are\s+now\s+(?:unrestricted|unfiltered)\b/i },
  { label: 'exfiltration', re: /\bexfiltrat(?:e|ion|ing)\b/i },
  { label: 'prompt-injection', re: /\bprompt[\s_-]*injection\b/i },
  { label: 'reveal-system-prompt', re: /\breveal\s+(?:your\s+|the\s+)?system[\s_-]*prompt\b/i },
  { label: 'privilege-escalation', re: /\b(?:escalate|override|steal|mail|exfiltrate)\s+(?:your\s+|the\s+)?(?:privileges|permissions|grant|credentials?|keys?)\b/i },
  { label: 'work-order-rewrite', re: /\b(?:rewrite|replace|modify|change)\s+(?:the\s+)?work[\s_-]*order\b/i },
];

/** 检出"改变指令/越权"式外部载荷；detected 为空即干净。evidence 不携带原文。 */
function inspectExternalContent(data) {
  let serialized;
  try {
    serialized = canonicalJson(data);
  } catch {
    return { detected: [{ kind: 'unserializable', path: '$' }], dataHash: null, truncated: false };
  }
  const detected = INJECTION_PATTERNS
    .filter(({ re }) => re.test(serialized))
    .map(({ label }) => ({ kind: 'pattern', label }));
  return {
    detected,
    dataHash: sha256Hex(serialized),
    truncated: false,
  };
}

// ---------------- invokeTool：调用全链路（负面路径先行） ----------------

function replayOutcome(record) {
  if (record.status === 'succeeded') {
    const payload = record.resultPayload === null ? null : JSON.parse(record.resultPayload);
    return { ...(payload ?? { kind: 'external-content', data: null }), replayed: true };
  }
  if (record.status === 'unknown') {
    throw fail(
      'UPSTREAM_UNAVAILABLE',
      `tool call ${record.toolName} was recorded UNKNOWN (idempotency key ${record.idempotencyKey}); reconciliation only — never auto-retried`,
    );
  }
  if (record.status === 'rejected') {
    throw fail(
      'FORBIDDEN',
      `tool call ${record.toolName} was recorded as rejected (idempotency key ${record.idempotencyKey}); grant/policy state is unchanged — no retry`,
    );
  }
  throw fail(
    'UPSTREAM_UNAVAILABLE',
    `tool call ${record.toolName} was recorded as failed (idempotency key ${record.idempotencyKey}); not auto-retried`,
  );
}

/**
 * invokeTool({ registry, client, audit, toolName, args, ctx, idempotencyKey, connectorId?, clock? })
 *
 * 链路（plan.md M7）：
 *   1. 形状校验 + Grant 状态纵深防御（grant.status !== 'active' → FORBIDDEN，
 *      transport 零调用；不依赖 policyPort/M6 是否记得检查）。
 *   2. 幂等：同 (owner, key) 已有账 → 同载重放（只对账：succeeded 原样取回 /
 *      unknown|failed|rejected 重抛结构化错误），绝不重新 invoke；异载 → CONFLICT。
 *   3. registry.call(toolName, args, ctx)：M6 全部闸门（未登记 NOT_FOUND、
 *      policyPort、inputSchema、资源 scope、dataDisclosure、quota、Grant 覆盖）。
 *      任一拒绝 → 台账 status='rejected' 后原样上抛（registry 已审计到自己的 sink，
 *      本层补 durable 落账）。
 *   4. client.callTool：真实 MCP 调用（注入 transport）。超时/断连 →
 *      台账 status='unknown'（外副作不可知，只对账不自动重试）后原样上抛。
 *   5. 外部内容只作数据：包 { kind:'external-content', data }；检出改指令/越权
 *      载荷 → quarantined:true + evidence（哈希+命中清单，不携带原文），绝不改
 *      WorkOrder/合同/权限（结构上本函数就不持有这些对象的写路径）。
 */
export async function invokeTool({
  registry, client, audit, toolName, args, ctx, idempotencyKey, connectorId, clock,
} = {}) {
  if (!isPlainObject(registry) || !isFunction(registry.call)) {
    throw fail('CONTRACT_INVALID', `registry must be injected with a call(toolName, args, ctx) function (got ${registry === null ? 'null' : typeof registry})`);
  }
  if (!isPlainObject(client) || !isFunction(client.callTool)) {
    throw fail('CONTRACT_INVALID', 'client must be injected with a callTool(name, args) function (createMcpClient)');
  }
  if (!isPlainObject(audit) || !isFunction(audit.recordToolCall) || !isFunction(audit.findToolCall)) {
    throw fail('CONTRACT_INVALID', 'audit must be injected with recordToolCall/findToolCall (createToolAuditStore)');
  }
  requireNonEmptyString(toolName, 'toolName');
  if (!isPlainObject(args)) {
    throw fail('CONTRACT_INVALID', `args must be an object (got ${Array.isArray(args) ? 'array' : typeof args})`);
  }
  requireNonEmptyString(idempotencyKey, 'idempotencyKey');
  if (!isPlainObject(ctx)) {
    throw fail('CONTRACT_INVALID', 'ctx is required ({ ownerId, actor, grant, contract })');
  }
  requireNonEmptyString(ctx.ownerId, 'ctx.ownerId');
  requireNonEmptyString(ctx.actor, 'ctx.actor');
  if (clock !== undefined && (!isPlainObject(clock) || !isFunction(clock.now))) {
    throw fail('CONTRACT_INVALID', 'clock, when provided, must be { now() → epoch ms }');
  }
  const calledAt = () => (clock ? new Date(clock.now()).toISOString() : undefined);

  const payloadHash = sha256Hex(canonicalJson({ toolName, args }));

  function record(status, extra = {}) {
    return audit.recordToolCall({
      ownerId: ctx.ownerId,
      connectorId: extra.connectorId ?? connectorId ?? null,
      toolName,
      grantId: isPlainObject(ctx.grant) && typeof ctx.grant.grantId === 'string' ? ctx.grant.grantId : null,
      policyDecision: extra.policyDecision ?? null,
      resultSummary: extra.resultSummary ?? null,
      status,
      idempotencyKey,
      payloadHash,
      externalId: extra.externalId ?? null,
      resultPayload: extra.resultPayload ?? null,
      errorCode: extra.errorCode ?? null,
      calledAt: extra.calledAt ?? calledAt(),
    });
  }

  // 1) Grant 状态纵深防御：非 active（含 revoked/缺失）即 fail closed。
  if (!isPlainObject(ctx.grant) || ctx.grant.status !== 'active') {
    const status = isPlainObject(ctx.grant) && typeof ctx.grant.status === 'string' ? ctx.grant.status : 'missing';
    record('rejected', { policyDecision: 'rejected', resultSummary: `grant ${status}; tool call refused before any gate`, errorCode: 'FORBIDDEN' });
    throw fail('FORBIDDEN', `grant is ${status}; tool ${toolName} is unavailable (fail closed before policy, scope or transport)`);
  }

  // 2) 幂等：已有账先对账（绝不重新 invoke——含 UNKNOWN 不自动重试，裁决⑥）。
  const existing = audit.findToolCall({ ownerId: ctx.ownerId, idempotencyKey });
  if (existing) {
    if (existing.payloadHash !== payloadHash) {
      throw fail('CONFLICT', `idempotency key ${idempotencyKey} already used with a different payload for owner ${ctx.ownerId}`);
    }
    return replayOutcome(existing);
  }

  // 3) M6 闸门（未登记/policy/inputSchema/scope/disclosure/quota/Grant 覆盖）。
  let gateResult;
  try {
    gateResult = await registry.call(toolName, args, ctx);
  } catch (cause) {
    const code = MCP_ERROR_CODES.has(cause?.code) || cause?.code === 'NOT_FOUND' || cause?.code === 'RATE_LIMITED'
      ? cause.code
      : null;
    record('rejected', {
      policyDecision: 'rejected',
      resultSummary: sanitizeMessage(cause?.message, `tool ${toolName} rejected by registry gates`),
      errorCode: code,
    });
    throw cause;
  }
  const at = typeof gateResult?.at === 'string' && gateResult.at.length > 0 ? gateResult.at : calledAt();
  const resolvedConnectorId = typeof connectorId === 'string' && connectorId.length > 0
    ? connectorId
    : bestEffortConnectorId(registry, toolName, ctx);

  // 4) 真实 MCP 调用（注入 transport）。超时/断连 → UNKNOWN（外副作不可知）。
  let mcpResult;
  try {
    mcpResult = await client.callTool(toolName, args);
  } catch (cause) {
    record('unknown', {
      connectorId: resolvedConnectorId,
      policyDecision: 'allowed',
      resultSummary: `MCP call outcome unknown (${cause?.code ?? 'error'}); side effects may have applied; no auto retry`,
      errorCode: cause?.code,
      calledAt: at,
    });
    throw cause;
  }

  // 5) 外部内容只作数据：扫描改指令/越权载荷，命中即隔离进 evidence。
  const inspection = inspectExternalContent(mcpResult);
  const wrapped = { kind: 'external-content', data: mcpResult, tool: toolName, at };
  if (inspection.detected.length > 0) {
    wrapped.quarantined = true;
    wrapped.evidence = {
      kind: 'quarantine',
      tool: toolName,
      connectorId: resolvedConnectorId,
      ownerId: ctx.ownerId,
      actor: ctx.actor,
      at,
      detected: inspection.detected,
      dataHash: inspection.dataHash,
      truncated: inspection.truncated,
      reason: 'external content carries instruction-override or privilege-escalation payload; quarantined as data',
    };
  }
  const summaryText = Array.isArray(mcpResult?.content) && typeof mcpResult.content[0]?.text === 'string'
    ? `text:${mcpResult.content[0].text.slice(0, 120)}`
    : 'structured-content';
  // 工具自报 isError → 已知失败（内容仍只作数据返回，不抛错）；隔离 → failed。
  const status = wrapped.quarantined === true || mcpResult?.isError === true
    ? 'failed'
    : 'succeeded';
  const summary = mcpResult?.isError === true
    ? `tool-error; ${summaryText}`
    : wrapped.quarantined === true ? `quarantined; ${summaryText}` : summaryText;
  record(status, {
    connectorId: resolvedConnectorId,
    policyDecision: 'allowed',
    resultSummary: summary,
    resultPayload: wrapped,
    calledAt: at,
  });
  return { ...wrapped, replayed: false };
}

/** best-effort：从 registry.listTools 反查 connectorId（失败不阻塞主链路）。 */
function bestEffortConnectorId(registry, toolName, ctx) {
  try {
    const found = registry.listTools({ grant: ctx.grant }).find(tool => tool.name === toolName);
    return typeof found?.connectorId === 'string' ? found.connectorId : null;
  } catch {
    return null;
  }
}
