import {
  normalizeAction,
  normalizeActor,
  AUTONOMY_LEVELS,
  isP0Forbidden,
  errorResult,
} from './types.mjs';

const level = (value) => AUTONOMY_LEVELS.indexOf(value);
const withinScope = (allowed, requested) => typeof allowed === 'string'
  && typeof requested === 'string'
  && (requested === allowed || requested.startsWith(`${allowed.replace(/\/$/, '')}/`));
const finiteNonNegative = (value) => Number.isFinite(value) && value >= 0;
const sum = (a, b) => (Number(a) || 0) + (Number(b) || 0);

function disclosureAllows(contract, action) {
  if (action.dataClass == null && action.dataDestination == null && action.dataFields == null) return true;
  if (!Array.isArray(contract.dataDisclosure)) return false;
  const fields = action.dataFields ?? [];
  return contract.dataDisclosure.some((entry) => {
    if (entry.dataClass !== action.dataClass || entry.to !== action.dataDestination) return false;
    return fields.every((field) => entry.fields?.includes(field));
  });
}

function budgetAllows(contract, input, action) {
  const budget = contract.budget;
  if (!budget) return true;
  const estimate = action.estimate ?? {};
  const spent = input.spent ?? {};
  const values = ['modelCalls', 'tokens', 'cost', 'localSlots'];
  if (values.some((key) => estimate[key] != null && !finiteNonNegative(estimate[key]))) return 'BUDGET_INVALID';
  if (values.some((key) => spent[key] != null && !finiteNonNegative(spent[key]))) return 'BUDGET_INVALID';
  const requested = {
    modelCalls: sum(spent.modelCalls, estimate.modelCalls),
    tokens: sum(spent.tokens, estimate.tokens),
    cost: sum(spent.cost, estimate.cost),
    localSlots: sum(spent.localSlots, estimate.localSlots),
  };
  const caps = { modelCalls: budget.modelCalls, tokens: budget.tokens, cost: budget.costCap, localSlots: budget.localSlots };
  if (Object.entries(caps).some(([key, cap]) => cap != null && requested[key] > cap)) return 'BUDGET_EXCEEDED';
  return true;
}

function windowAllows(contract, now) {
  const window = contract.window;
  if (!window) return true;
  const current = Date.parse(now);
  const prepStart = Date.parse(window.prepStart);
  const end = Date.parse(window.end);
  if (![current, prepStart, end].every(Number.isFinite) || prepStart > end) return false;
  return current >= prepStart && current < end;
}

export function evaluateAction(input, { now = new Date().toISOString(), phase = 'P0' } = {}) {
  const { mission, contract, grant, action } = input ?? {};
  if (!action || !mission || !contract) return errorResult('blocked', 'CONTEXT_INVALID');
  let normalizedAction;
  try { normalizedAction = normalizeAction(action); } catch (error) { return errorResult('blocked', error.code); }
  let actor;
  try { actor = normalizeActor(action.actor); } catch (error) { return errorResult('blocked', error.code); }
  if (actor.status === 'UNKNOWN') return errorResult('UNKNOWN', actor.code);

  const ownerIds = [input.ownerId, mission.ownerId, contract.ownerId, ...(grant ? [grant.ownerId] : []), action.ownerId];
  if (ownerIds.some((ownerId) => typeof ownerId !== 'string' || ownerId.length === 0)
    || ownerIds.some((ownerId) => ownerId !== action.ownerId)) return errorResult('blocked', 'OWNER_MISMATCH');
  if (!grant) return errorResult('blocked', 'GRANT_REQUIRED');
  if (action.capability === 'contract.wont.delete') return errorResult('blocked', 'WONT_IMMUTABLE');
  if (!['contracted', 'prepping', 'live'].includes(mission.state)) return errorResult('blocked', 'CONTRACT_REQUIRED');
  if (typeof contract.hash !== 'string' || contract.hash.length === 0) return errorResult('blocked', 'CONTRACT_INVALID');
  if (typeof contract.missionId !== 'string' || contract.missionId !== mission.id) return errorResult('blocked', 'CONTRACT_MISSION_MISMATCH');
  if (action.contractHash != null && action.contractHash !== contract.hash) return errorResult('blocked', 'CONTRACT_HASH_MISMATCH');
  if (grant.status !== 'active') return errorResult('blocked', 'GRANT_INACTIVE');
  if (grant.actor != null && grant.actor !== actor.actorId) return errorResult('blocked', 'GRANT_ACTOR_MISMATCH');
  const grantModel = grant.resolvedModel ?? grant.model;
  if (grantModel != null && grantModel !== actor.resolvedModel) return errorResult('blocked', 'GRANT_ACTOR_MODEL_MISMATCH');
  if (!grant.expiresAt) return errorResult('blocked', 'GRANT_EXPIRED');
  if (grant.contractHash !== contract.hash) return errorResult('blocked', 'GRANT_CONTRACT_MISMATCH');
  if (Date.parse(grant.expiresAt) <= Date.parse(now)) return errorResult('blocked', 'GRANT_EXPIRED');
  if (level(normalizedAction.requestedAutonomy) > level(mission.autonomy)) return errorResult('blocked', 'AUTONOMY_TOO_HIGH');
  if (level(mission.autonomy) < 2) return errorResult('blocked', 'AUTONOMY_TOO_LOW');
  const contractCapability = contract.capabilities == null
    ? true
    : contract.capabilities.find((item) => item.capability === action.capability && withinScope(item.scope, action.scope));
  if (!contractCapability) return errorResult('blocked', 'SCOPE_DENIED');
  const capability = Array.isArray(grant.capabilities)
    ? grant.capabilities.find((item) => typeof item === 'string'
      ? item === action.capability
      : item?.capability === action.capability && withinScope(item.scope, action.scope))
    : null;
  if (!capability) return errorResult('blocked', 'SCOPE_DENIED');
  if (!disclosureAllows(contract, action)) return errorResult('blocked', 'DATA_DISCLOSURE_DENIED');
  if (!windowAllows(contract, now)) return errorResult('blocked', 'WINDOW_OUTSIDE');
  const budget = budgetAllows(contract, input, action);
  if (budget !== true) return errorResult('blocked', budget);
  if (action.risk === 'financial' || action.requestedAutonomy === 'A5') return errorResult('blocked', 'A5_NEVER_AUTOMATIC');
  if (isP0Forbidden(action) && phase === 'P0') return errorResult('blocked', 'P0_EXTERNAL_EFFECT_BLOCKED');
  if (action.risk === 'external' || action.requestedAutonomy === 'A4') {
    return { status: 'needs_confirmation', code: 'A4_CONFIRMATION_REQUIRED', requiresConfirmation: true };
  }
  return { status: 'allowed', code: 'ALLOWED', requiresConfirmation: false };
}
