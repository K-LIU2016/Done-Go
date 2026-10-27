// W7 M3 · budget — 确定性预算 / 窗口 / Grant 子集校验（plan.md M3 第 4 条）。
//
// 红线⑥：预算窗口与 deadline 判定只吃注入时间（epoch ms 数字或 now() 函数），
// 本文件不出现 Date.now()/new Date()，测试可完全确定性回放。
//
//   createBudgetTracker({ contract, workOrder, now })
//     → { assertWithinWindow(nowMs), assertCanSpend({calls,tokens}), charge({calls,tokens}), snapshot() }
//       * 窗口语义：早于 contract.window.prepStart → FORBIDDEN（窗口未开）；
//         晚于 min(contract.window.end, workOrder.budget.deadline) → BUDGET_EXCEEDED（超窗/超 deadline）。
//       * 花费语义：spent + 请求 ≤ workOrder.budget 上限（calls/tokens 双轴）。
//   assertChildBudgetsWithinParent(children, parent)  // PRD §6.4 子预算之和 ≤ 父剩余
//   assertGrantRefsSubset(grantRefs, parentGrants)    // GrantRef scope ⊆ 父 Grant
import { failClosed } from './errors.mjs';

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonNegativeInteger(value, label) {
  if (!Number.isInteger(value) || value < 0) {
    throw failClosed('CONTRACT_INVALID', `${label} must be a non-negative integer`);
  }
  return value;
}

/** 注入时间统一化：epoch ms 数字或 () => epoch ms 函数；缺失即 fail closed（禁止真实 wall clock）。 */
function toNowProvider(now, label) {
  if (typeof now === 'function') return now;
  if (typeof now === 'number' && Number.isFinite(now)) return () => now;
  throw failClosed(
    'CONTRACT_INVALID',
    `${label} requires an injected deterministic time (epoch ms number or now() function); real wall clock is forbidden`,
  );
}

function parseEpochMs(iso, label) {
  if (typeof iso !== 'string') {
    throw failClosed('CONTRACT_INVALID', `${label} must be an ISO-8601 date-time string`);
  }
  const epochMs = Date.parse(iso);
  if (!Number.isFinite(epochMs)) {
    throw failClosed('CONTRACT_INVALID', `${label} must be an ISO-8601 date-time string (${iso} is not parseable)`);
  }
  return epochMs;
}

/** 把 {calls?, tokens?} 规整成非负整数对（缺省 0），形状不对 → CONTRACT_INVALID。 */
function normalizeSpend(spend, label) {
  if (!isPlainObject(spend)) {
    throw failClosed('CONTRACT_INVALID', `${label} must be an object like { calls?, tokens? }`);
  }
  return {
    calls: spend.calls === undefined ? 0 : nonNegativeInteger(spend.calls, `${label}.calls`),
    tokens: spend.tokens === undefined ? 0 : nonNegativeInteger(spend.tokens, `${label}.tokens`),
  };
}

export function createBudgetTracker({ contract, workOrder, now } = {}) {
  if (!isPlainObject(contract) || !isPlainObject(contract.window)) {
    throw failClosed('CONTRACT_INVALID', 'budget tracker requires contract.window (prepStart/start/end) for window enforcement');
  }
  if (!isPlainObject(workOrder) || !isPlainObject(workOrder.budget)) {
    throw failClosed('CONTRACT_INVALID', 'budget tracker requires workOrder.budget (calls/tokens/deadline)');
  }
  const nowFn = toNowProvider(now, 'createBudgetTracker(now)');

  const prepStartMs = parseEpochMs(contract.window.prepStart, 'contract.window.prepStart');
  const windowEndMs = parseEpochMs(contract.window.end, 'contract.window.end');
  const deadlineMs = parseEpochMs(workOrder.budget.deadline, 'workOrder.budget.deadline');
  const capCalls = nonNegativeInteger(workOrder.budget.calls, 'workOrder.budget.calls');
  const capTokens = nonNegativeInteger(workOrder.budget.tokens, 'workOrder.budget.tokens');

  let spent = { calls: 0, tokens: 0 };

  return {
    /** 窗口校验（独立可注入 nowMs，供恢复时用新 now 重验）。早 → FORBIDDEN，晚 → BUDGET_EXCEEDED。 */
    assertWithinWindow(nowMs) {
      if (typeof nowMs !== 'number' || !Number.isFinite(nowMs)) {
        throw failClosed('CONTRACT_INVALID', 'assertWithinWindow requires an injected epoch-ms number');
      }
      if (nowMs < prepStartMs) {
        throw failClosed('FORBIDDEN', 'outside contract window: earlier than window.prepStart');
      }
      if (nowMs > deadlineMs) {
        throw failClosed('BUDGET_EXCEEDED', 'beyond workOrder.budget.deadline');
      }
      if (nowMs > windowEndMs) {
        throw failClosed('BUDGET_EXCEEDED', 'beyond contract.window.end');
      }
      return true;
    },
    /** 剩余预算校验：spent + 请求必须同时满足 calls/tokens 双轴上限。 */
    assertCanSpend(request) {
      const { calls, tokens } = normalizeSpend(request, 'assertCanSpend(request)');
      if (spent.calls + calls > capCalls) {
        throw failClosed('BUDGET_EXCEEDED', `model call budget exceeded: spent ${spent.calls} + requested ${calls} > cap ${capCalls}`);
      }
      if (spent.tokens + tokens > capTokens) {
        throw failClosed('BUDGET_EXCEEDED', `token budget exceeded: spent ${spent.tokens} + requested ${tokens} > cap ${capTokens}`);
      }
      return true;
    },
    /** 记账（只加不判；判在 assertCanSpend）。 */
    charge(consumption) {
      const { calls, tokens } = normalizeSpend(consumption, 'charge(consumption)');
      spent = { calls: spent.calls + calls, tokens: spent.tokens + tokens };
      return { ...spent };
    },
    snapshot() {
      return { calls: spent.calls, tokens: spent.tokens, now: nowFn() };
    },
  };
}

/** PRD §6.4：子预算之和 ≤ 父剩余（parent.calls/tokens 减去可选 callsSpent/tokensSpent）。 */
export function assertChildBudgetsWithinParent(children, parent) {
  if (!Array.isArray(children)) {
    throw failClosed('CONTRACT_INVALID', 'assertChildBudgetsWithinParent requires children to be an array');
  }
  if (!isPlainObject(parent)) {
    throw failClosed('CONTRACT_INVALID', 'assertChildBudgetsWithinParent requires parent to be an object');
  }
  const sums = { calls: 0, tokens: 0 };
  children.forEach((child, index) => {
    const normalized = normalizeSpend(child, `children[${index}]`);
    sums.calls += normalized.calls;
    sums.tokens += normalized.tokens;
  });
  for (const axis of ['calls', 'tokens']) {
    const cap = parent[axis];
    if (cap === undefined) continue; // 父级未设该轴上限 → 该轴不约束
    nonNegativeInteger(cap, `parent.${axis}`);
    const alreadySpent = parent[`${axis}Spent`] === undefined ? 0 : nonNegativeInteger(parent[`${axis}Spent`], `parent.${axis}Spent`);
    if (sums[axis] + alreadySpent > cap) {
      throw failClosed(
        'BUDGET_EXCEEDED',
        `child ${axis} budgets (${sums[axis]}) plus parent already spent (${alreadySpent}) exceed parent cap (${cap})`,
      );
    }
  }
  return true;
}

/**
 * GrantRef scope ⊆ 父 Grant：每个 grantId 必须命中父 Grant；
 * 带 scope 时必须等于某父 scope，或同 capability 下是其资源路径的子路径（'/' 边界）。
 */
function scopeWithinParent(childScope, parentScopes) {
  for (const parentScope of parentScopes) {
    if (parentScope === childScope) return true;
    const separator = parentScope.indexOf(':');
    if (separator < 0) continue;
    const parentCapability = parentScope.slice(0, separator);
    const parentPath = parentScope.slice(separator + 1);
    const childSeparator = childScope.indexOf(':');
    if (childSeparator < 0 || childScope.slice(0, childSeparator) !== parentCapability) continue;
    const childPath = childScope.slice(childSeparator + 1);
    const boundary = parentPath.endsWith('/') ? parentPath : `${parentPath}/`;
    if (childPath === parentPath || childPath.startsWith(boundary)) return true;
  }
  return false;
}

export function assertGrantRefsSubset(grantRefs, parentGrants) {
  if (!Array.isArray(grantRefs) || grantRefs.length === 0) {
    throw failClosed('FORBIDDEN', 'grantRefs must be a non-empty array of GrantRef');
  }
  if (!Array.isArray(parentGrants)) {
    throw failClosed('CONTRACT_INVALID', 'parentGrants must be an array of { grantId, scopes[] }');
  }
  const parents = new Map();
  for (const parent of parentGrants) {
    if (!isPlainObject(parent) || typeof parent.grantId !== 'string' || !Array.isArray(parent.scopes)) {
      throw failClosed('CONTRACT_INVALID', 'parentGrants entries must be { grantId: string, scopes: string[] }');
    }
    parents.set(parent.grantId, parent.scopes);
  }
  for (const ref of grantRefs) {
    if (!isPlainObject(ref) || typeof ref.grantId !== 'string' || ref.grantId === '') {
      throw failClosed('CONTRACT_INVALID', 'each grantRef must carry a non-empty grantId');
    }
    const scopes = parents.get(ref.grantId);
    if (scopes === undefined) {
      throw failClosed('FORBIDDEN', `grant ${ref.grantId} is not among the parent grants`);
    }
    if (ref.scope !== undefined) {
      if (typeof ref.scope !== 'string' || ref.scope === '') {
        throw failClosed('CONTRACT_INVALID', 'grantRef.scope must be a non-empty string when present');
      }
      if (!scopeWithinParent(ref.scope, scopes)) {
        throw failClosed('FORBIDDEN', `grantRef scope ${ref.scope} exceeds the scopes of parent grant ${ref.grantId}`);
      }
    }
  }
  return true;
}
