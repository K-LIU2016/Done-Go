// W7 M6 · tool-registry-core — MCP 工具能力登记与 fail-closed 调用闸（registry.mjs）
//
// 依据：.s2d/plan.md M6；brief 裁决⑤（先登记 capability manifest，再 policyPort.check；
// 工具输入 / 资源 scope / data disclosure / 预算 / Grant 任一不满足即拒）；
// 红线⑤⑥（外部调用全注入、确定性时钟只允许注入 now）。
//
// 跨组约束：G3 不 import G1（runtime/**）/G2（model-router/**）的任何文件
// （plan「无跨组源文件依赖」）；冻结契约校验器 `../contracts.mjs`（W0 骨架，
// 全流共享）是唯一外部源依赖。错误码全部落在冻结 api-error.schema.json 枚举内。
//
// 调用检查顺序（tests/unit/agentic/tool-registry/registry.test.mjs 即规格）：
//   未登记(NOT_FOUND，不触 policyPort) → ctx 形状(CONTRACT_INVALID)
//   → policyPort.check(FORBIDDEN，check 抛错也 fail closed)
//   → 工具 inputSchema(CONTRACT_INVALID) → 资源 scope(FORBIDDEN)
//   → dataDisclosure(FORBIDDEN，secret 永拒，local/cloud 与 processing 必须匹配)
//   → quota.perDay(RATE_LIMITED) → Grant 覆盖(FORBIDDEN) → execute
//   任一命中即拒并记审计（audit 注入器）；外部内容只作数据：
//   结果一律包 { kind:'external-content', data }，检出改指令/越权载荷 →
//   quarantined:true + evidence（哈希+命中清单，不携带原文），绝不改
//   WorkOrder / 合同 / Grant / 登记表。

import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertValid, canonicalJson, loadSchema, validate } from '../contracts.mjs';

// ---------------- 自带最小 fail-closed 错误工厂（对齐冻结 api-error 枚举） ----------------

/** 本模块用到的错误码（冻结 api-error.schema.json 枚举的子集）。 */
const REGISTRY_ERROR_CODES = new Set([
  'FORBIDDEN',
  'NOT_FOUND',
  'CONTRACT_INVALID',
  'CONFLICT',
  'RATE_LIMITED',
  'UPSTREAM_UNAVAILABLE',
]);

/**
 * 构造结构化 fail-closed 错误。未知码是编程错误，立即抛 TypeError，
 * 绝不编造枚举外的码。message 只描述工具/范围/分级等类别信息，
 * 不携带凭据正文，也不携带外部内容原文（那可能是 prompt injection 载荷）。
 */
function fail(code, message, details) {
  if (!REGISTRY_ERROR_CODES.has(code)) {
    throw new TypeError(`invalid tool-registry error code ${String(code)}`);
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

// ---------------- 冻结 schema（只读，懒加载缓存） ----------------

const DEFAULT_SCHEMA_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../../contracts/agentic');

let connectorSchemaCache;

/** 懒加载冻结 connector.schema.json（每进程一次；FROZEN v1 只读）。 */
function connectorSchema(schemaDir) {
  if (connectorSchemaCache === undefined || connectorSchemaCache.dir !== schemaDir) {
    connectorSchemaCache = { dir: schemaDir, schema: loadSchema('connector.schema.json', schemaDir) };
  }
  return connectorSchemaCache.schema;
}

// ---------------- 确定性时钟与审计时间戳（红线⑥） ----------------

/** epoch ms → ISO-8601（审计时间戳一律来自注入时钟或注入 ctx.now，禁止真实 wall clock）。 */
function isoFromEpochMs(epochMs) {
  if (typeof epochMs !== 'number' || !Number.isFinite(epochMs)) {
    throw fail('CONTRACT_INVALID', 'injected clock.now() must return a finite epoch-ms number');
  }
  return new Date(epochMs).toISOString();
}

/** UTC 日键（quota.perDay 的窗口分桶）。 */
function dayKeyOf(epochMs) {
  return isoFromEpochMs(epochMs).slice(0, 10);
}

// ---------------- scope 覆盖（等值或子路径） ----------------

/** grant/read 的 scope 是否覆盖 target：等值，或 target 是 scope 的子路径。 */
function covers(scope, target) {
  return target === scope || target.startsWith(`${scope}/`);
}

// ---------------- 恶意外部内容检测（改指令 / 越权式载荷） ----------------

/** 指令劫持/越权字符串模式（对外部内容做防御性扫描；命中 → 隔离，不是放行也不是执行）。 */
const INJECTION_PATTERNS = [
  { label: 'ignore-previous-instructions', re: /\bignore\s+(?:all\s+|any\s+)?(?:previous|prior|above)\s+instructions?\b/i },
  { label: 'disregard-previous-instructions', re: /\bdisregard\s+(?:all\s+|any\s+)?(?:previous|prior|above)\s+instructions?\b/i },
  { label: 'system-prompt-override', re: /\bsystem[\s_-]*prompt[\s_-]*override\b/i },
  { label: 'unrestricted-persona', re: /\byou\s+are\s+now\s+(?:unrestricted|unfiltered)\b/i },
  { label: 'exfiltration', re: /\bexfiltrat(?:e|ion|ing)\b/i },
  { label: 'prompt-injection', re: /\bprompt[\s_-]*injection\b/i },
  { label: 'reveal-system-prompt', re: /\breveal\s+(?:your\s+|the\s+)?system[\s_-]*prompt\b/i },
  { label: 'privilege-escalation', re: /\b(?:escalate|override|steal|mail|exfiltrate)\s+(?:your\s+|the\s+)?(?:privileges|permissions|grant|credentials?|keys?)\b/i },
];

/**
 * 结构性越权键名（小写比较）：外部内容试图伪装/改写 WorkOrder、合同、Grant、
 * 系统提示或权限表。宁可误隔离（evidence 留痕）也绝不静默当数据用（fail closed 方向）。
 */
const FORBIDDEN_KEYS = new Set([
  'workorder', 'work_order',
  'contract', 'grant',
  'systemprompt', 'systempromptoverride', 'system_prompt_override',
  'autonomy', 'datadisclosure', 'permissions', 'capabilities',
]);

/** 递归扫描对象键（限深防循环/超深嵌套；外部内容不可信，扫描本身要有界）。 */
const SCAN_MAX_DEPTH = 8;
const SCAN_CHAR_LIMIT = 65536;

function scanKeys(value, path, depth, detected) {
  if (depth > SCAN_MAX_DEPTH) return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => scanKeys(item, `${path}[${index}]`, depth + 1, detected));
    return;
  }
  if (!isPlainObject(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.has(key.toLowerCase())) {
      detected.push({ kind: 'key', key, path: path ? `${path}.${key}` : key });
    }
    scanKeys(child, path ? `${path}.${key}` : key, depth + 1, detected);
  }
}

/**
 * 检出"改变指令/越权"式外部载荷。返回 { detected, dataHash, truncated }；
 * detected 为空即干净。evidence 只带哈希与命中清单，不携带外部原文。
 */
function inspectExternalContent(data) {
  let serialized;
  try {
    serialized = canonicalJson(data);
  } catch {
    // BigInt/循环等不可规范化的外部内容本身就不可信 → 按可疑隔离。
    return {
      detected: [{ kind: 'unserializable', path: '$' }],
      dataHash: null,
      truncated: false,
    };
  }
  const truncated = serialized.length > SCAN_CHAR_LIMIT;
  const scanText = truncated ? serialized.slice(0, SCAN_CHAR_LIMIT) : serialized;
  const detected = INJECTION_PATTERNS
    .filter(({ re }) => re.test(scanText))
    .map(({ label }) => ({ kind: 'pattern', label }));
  scanKeys(data, '', 0, detected);
  return {
    detected,
    dataHash: createHash('sha256').update(serialized).digest('hex'),
    truncated,
  };
}

// ---------------- 工厂 ----------------

/**
 * 创建工具登记表（纯内存；持久化审计归 M7 的 w7_tools/w7_tool_calls）。
 *
 * @param {object} deps
 *   - policyPort  必填：{ check(ctx, action) → Promise|{ allow, reason?, need? } }
 *                 （决策归注入端口；W13 用 W4 adapter 接入，本模块不复制判定）
 *   - schemaDir   可选：冻结 schema 目录（默认仓库 contracts/agentic）
 *   - clock       必填：{ now() → epoch ms }（确定性时钟；quota 窗口/审计时间戳只用它）
 *   - audit       可选：audit(entry) 记录器（拒绝与放行都记；尽力而为，
 *                 记录失败不得改变原拒绝错误 —— durable 审计在 M7 落库）
 * @returns {{ register, listTools, call }}
 */
export function createToolRegistry({ policyPort, schemaDir = DEFAULT_SCHEMA_DIR, clock, audit } = {}) {
  if (!isPlainObject(policyPort) || !isFunction(policyPort.check)) {
    // fail closed：没有可用的 policy 端口就不存在"可调用的工具"（brief 裁决②）。
    throw fail(
      'CONTRACT_INVALID',
      `policyPort is required and must be an object carrying check(ctx, action) (got ${policyPort === null ? 'null' : typeof policyPort})`,
    );
  }
  if (!isPlainObject(clock) || !isFunction(clock.now)) {
    throw fail('CONTRACT_INVALID', 'clock must be injected with a now() function returning epoch ms (deterministic time only; real wall clock is forbidden)');
  }
  if (audit !== undefined && !isFunction(audit)) {
    throw fail('CONTRACT_INVALID', 'audit, when provided, must be a function audit(entry)');
  }

  const schema = connectorSchema(schemaDir);

  /** toolName → 注册描述符（含 manifest 引用；登记后只读，绝不回写）。 */
  const toolsByName = new Map();
  /** connectorId → 冻结 schema 校验通过的 manifest（登记时快照，防调用方事后篡改）。 */
  const manifestsById = new Map();
  /** `${connectorId}|${utcDay}` → 当日已用调用数（quota.perDay 桶）。 */
  const quotaUsed = new Map();

  /** 尽力而为的审计：绝不掩盖原始错误，也绝不让审计异常放行/改变判定。 */
  function recordAudit(entry) {
    if (audit === undefined) return;
    try {
      audit(entry);
    } catch {
      // best-effort：M6 的 audit 是进程内记录器；durable 审计归 M7（w7_tool_calls）。
    }
  }

  function rejected(toolName, ctx, code, reason, extra = {}) {
    recordAudit({
      decision: 'rejected',
      tool: toolName,
      ownerId: isPlainObject(ctx) ? ctx.ownerId : undefined,
      actor: isPlainObject(ctx) ? ctx.actor : undefined,
      at: auditTimestamp(ctx),
      code,
      reason,
      ...extra,
    });
    return fail(code, reason, extra.details);
  }

  /** 审计时间戳：优先注入的 ctx.now（ISO），否则注入时钟；两者都确定性。 */
  function auditTimestamp(ctx) {
    const injected = isPlainObject(ctx) ? ctx.now : undefined;
    if (injected !== undefined) {
      const epochMs = Date.parse(injected);
      if (typeof injected !== 'string' || !Number.isFinite(epochMs)) {
        throw fail('CONTRACT_INVALID', 'ctx.now, when provided, must be an ISO-8601 date-time string (deterministic injected time)');
      }
      return new Date(epochMs).toISOString();
    }
    return isoFromEpochMs(clock.now());
  }

  // ---------------- register：能力清单登记 ----------------

  /**
   * 登记一个 connector 的能力清单与工具。
   * manifest 必须通过冻结 connector.schema.json；工具名全局唯一。
   * 原子语义：任一校验失败 → 整批不登记（无半登记状态）。
   */
  function register(manifest, toolList) {
    assertValid(manifest, schema, { schemaDir });
    if (!Array.isArray(toolList) || toolList.length === 0) {
      throw fail('CONTRACT_INVALID', 'tools must be a non-empty array of tool descriptors');
    }
    const descriptors = toolList.map((tool) => {
      if (!isPlainObject(tool)) {
        throw fail('CONTRACT_INVALID', 'each tool must be an object { name, inputSchema, capability, execute }');
      }
      requireNonEmptyString(tool.name, 'tool.name');
      if (!isPlainObject(tool.inputSchema)) {
        throw fail('CONTRACT_INVALID', `tool ${tool.name}: inputSchema must be a JSON schema object`);
      }
      requireNonEmptyString(tool.capability, `tool ${tool.name}: capability`);
      if (!isFunction(tool.execute)) {
        throw fail('CONTRACT_INVALID', `tool ${tool.name}: execute must be an injected function execute(args)`);
      }
      return { name: tool.name, inputSchema: tool.inputSchema, capability: tool.capability, execute: tool.execute };
    });
    const clash = descriptors.find(({ name }) => toolsByName.has(name));
    if (clash) {
      throw fail('CONFLICT', `tool ${clash.name} is already registered (connector ${toolsByName.get(clash.name).connectorId})`);
    }
    if (manifestsById.has(manifest.id)) {
      throw fail('CONFLICT', `connector ${manifest.id} is already registered`);
    }
    // 登记快照：之后调用方改动原对象不影响登记表（外部内容/调用方都不可改登记）。
    const manifestSnapshot = JSON.parse(JSON.stringify(manifest));
    manifestsById.set(manifest.id, manifestSnapshot);
    for (const descriptor of descriptors) {
      toolsByName.set(descriptor.name, { ...descriptor, connectorId: manifest.id });
    }
    return { connectorId: manifest.id, tools: descriptors.map(({ name }) => name) };
  }

  // ---------------- listTools：Grant 覆盖过滤 ----------------

  /** 列出 Grant 能看到的工具（capability 被 grant.capabilities 等值或子路径覆盖）。 */
  function listTools({ grant } = {}) {
    const capabilities = readGrantCapabilities(grant);
    return [...toolsByName.values()]
      .filter(tool => capabilities.some(scope => covers(scope, tool.capability)))
      .map(({ name, capability, connectorId }) => {
        const manifest = manifestsById.get(connectorId);
        return {
          name,
          capability,
          connectorId,
          transport: manifest.transport,
          risk: manifest.risk,
          processing: manifest.processing,
        };
      });
  }

  function readGrantCapabilities(grant) {
    if (!isPlainObject(grant) || !Array.isArray(grant.capabilities)) {
      throw fail('CONTRACT_INVALID', 'grant is required as { grantId, capabilities: string[] } for scope filtering');
    }
    for (const scope of grant.capabilities) {
      if (typeof scope !== 'string' || scope.length === 0) {
        throw fail('CONTRACT_INVALID', 'grant.capabilities entries must be non-empty strings');
      }
    }
    return grant.capabilities;
  }

  // ---------------- call：fail-closed 调用闸 ----------------

  /**
   * 调用已登记的工具。任一闸门不满足即拒并记审计；放行的结果一律包成
   * { kind:'external-content', data }（外部内容只作数据），可疑载荷隔离进 evidence。
   *
   * @param {string} toolName
   * @param {object} args          工具输入（先过 tool.inputSchema；`resource` 字段
   *                               是资源引用，按 manifest.reads[].scope 做 scope 闸）
   * @param {object} ctx           { ownerId, actor, grant, contract, now? }
   */
  async function call(toolName, args, ctx) {
    const tool = toolsByName.get(toolName);
    if (tool === undefined) {
      // 未登记：不触 policyPort（没有可审的动作），但拒绝要记审计。
      throw rejected(toolName, ctx, 'NOT_FOUND', `tool ${toolName} is not registered`);
    }
    const manifest = manifestsById.get(tool.connectorId);
    const at = auditTimestamp(ctx);
    requireNonEmptyString(ctx?.ownerId, 'ctx.ownerId');
    requireNonEmptyString(ctx?.actor, 'ctx.actor');
    const grantCapabilities = readGrantCapabilities(ctx?.grant);
    const contract = ctx?.contract;
    if (!isPlainObject(contract) || !Array.isArray(contract.dataDisclosure)) {
      throw fail('CONTRACT_INVALID', 'ctx.contract is required with a dataDisclosure array (data class gates depend on it)');
    }

    const resource = isPlainObject(args) && typeof args.resource === 'string' ? args.resource : undefined;

    // 闸 1 · policyPort.check（注入端口决策；抛错也 fail closed）。
    let decision;
    try {
      decision = await policyPort.check(
        { ownerId: ctx.ownerId, actor: ctx.actor, grant: ctx.grant, contract },
        { type: 'tool.call', tool: toolName, connector: manifest.id, capability: tool.capability, ...(resource === undefined ? {} : { resource }) },
      );
    } catch (cause) {
      const details = typeof cause?.code === 'string' ? { causeCode: cause.code } : {};
      throw rejected(toolName, ctx, 'FORBIDDEN', 'policy port check threw; failing closed without executing the tool', { details, resource, at });
    }
    if (!isPlainObject(decision) || typeof decision.allow !== 'boolean') {
      throw rejected(toolName, ctx, 'CONTRACT_INVALID', 'policyPort.check must resolve to { allow: boolean, reason?, need? }', { resource, at });
    }
    if (!decision.allow) {
      throw rejected(toolName, ctx, 'FORBIDDEN', decision.reason || 'policy port denied the tool call', { resource, at });
    }

    // 闸 2 · 工具输入必须落在登记的 inputSchema 内。
    if (!isPlainObject(args)) {
      throw rejected(toolName, ctx, 'CONTRACT_INVALID', 'args must be an object validated against the tool inputSchema', { at });
    }
    const inputCheck = validate(args, tool.inputSchema, { schemaDir });
    if (!inputCheck.valid) {
      throw rejected(toolName, ctx, 'CONTRACT_INVALID', `tool ${toolName} input violates its registered inputSchema`, {
        details: { errors: inputCheck.errors.slice(0, 10) },
        at,
      });
    }

    // 闸 3 · 资源 scope：resource 引用必须落在 manifest.reads[].scope 内。
    let matchedRead;
    if (resource !== undefined) {
      matchedRead = (manifest.reads || []).find(read => covers(read.scope, resource));
      if (matchedRead === undefined) {
        throw rejected(toolName, ctx, 'FORBIDDEN', `resource ${resource} is outside every scope the connector manifest declares`, { resource, at });
      }
    }

    // 闸 4 · dataDisclosure：命中的 read.dataClass 必须被合同披露到与
    // manifest.processing 匹配的目的地；secret 永拒（合同写了也不算）。
    if (matchedRead !== undefined) {
      if (matchedRead.dataClass === 'secret') {
        throw rejected(toolName, ctx, 'FORBIDDEN', 'dataClass=secret never enters any tool path regardless of contract dataDisclosure', { resource, at });
      }
      const destinationOk = contract.dataDisclosure.some((entry) => {
        if (entry?.dataClass !== matchedRead.dataClass) return false;
        if (entry.to === `plugin:${manifest.id}`) return true;
        return manifest.processing === 'local' ? entry.to === 'local' : entry.to === 'cloud-model';
      });
      if (!destinationOk) {
        throw rejected(toolName, ctx, 'FORBIDDEN', `dataClass=${matchedRead.dataClass} is not disclosed to ${manifest.processing} by the contract dataDisclosure`, { resource, at });
      }
    }

    // 闸 5 · quota.perDay（注入时钟的 UTC 日窗口；只数放行的调用）。
    const perDay = manifest.quota?.perDay;
    const quotaKey = `${manifest.id}|${dayKeyOf(Date.parse(at))}`;
    if (typeof perDay === 'number') {
      const used = quotaUsed.get(quotaKey) ?? 0;
      if (used >= perDay) {
        throw rejected(toolName, ctx, 'RATE_LIMITED', `connector ${manifest.id} daily quota exhausted (${used}/${perDay} on ${quotaKey.split('|')[1]})`, { resource, at });
      }
    }

    // 闸 6 · Grant 覆盖工具 capability（纵深防御，独立于 policyPort）。
    if (!grantCapabilities.some(scope => covers(scope, tool.capability))) {
      throw rejected(toolName, ctx, 'FORBIDDEN', `grant does not cover capability ${tool.capability} required by tool ${toolName}`, { resource, at });
    }

    // 全闸放行 → 记账并执行（外部内容从这里开始只作数据处理）。
    if (typeof perDay === 'number') {
      quotaUsed.set(quotaKey, (quotaUsed.get(quotaKey) ?? 0) + 1);
    }
    let data;
    try {
      data = await tool.execute(args);
    } catch (cause) {
      const details = typeof cause?.code === 'string' ? { causeCode: cause.code } : {};
      // 不回显 execute 的原始错误文本（不可信内容可能借错误消息注入）。
      throw rejected(toolName, ctx, 'UPSTREAM_UNAVAILABLE', `tool ${toolName} execution failed`, { details, resource, at });
    }

    const inspection = inspectExternalContent(data ?? null);
    const result = { kind: 'external-content', data: data ?? null, tool: toolName, at };
    if (inspection.detected.length > 0) {
      // 隔离：只作数据留痕，绝不改 WorkOrder/合同/Grant/登记表（红线⑤）。
      result.quarantined = true;
      result.evidence = {
        kind: 'quarantine',
        tool: toolName,
        connectorId: manifest.id,
        ownerId: ctx.ownerId,
        actor: ctx.actor,
        at,
        detected: inspection.detected,
        dataHash: inspection.dataHash,
        truncated: inspection.truncated,
        reason: 'external content carries instruction-override or privilege-escalation payload; quarantined as data',
      };
    }
    recordAudit({
      decision: 'allowed',
      tool: toolName,
      connectorId: manifest.id,
      ownerId: ctx.ownerId,
      actor: ctx.actor,
      at,
      ...(resource === undefined ? {} : { resource }),
      ...(result.quarantined === true ? { quarantined: true } : {}),
    });
    return result;
  }

  return { register, listTools, call };
}
