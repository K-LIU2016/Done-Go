import {
  normalizeAction,
  normalizeActor,
  AUTONOMY_LEVELS,
  isP0Forbidden,
  errorResult,
} from './types.mjs';

const level = (value) => AUTONOMY_LEVELS.indexOf(value);
const withinScope = (allowed, requested) => requested === allowed || requested.startsWith(`${allowed.replace(/\/$/, '')}/`);

export function evaluateAction(input, { now = new Date().toISOString(), phase = 'P0' } = {}) {
  const { mission, contract, grant, action } = input ?? {};
  try { normalizeAction(action); } catch (error) { return errorResult('blocked', error.code); }
  const actor = normalizeActor(action.actor);
  if (actor.status === 'UNKNOWN') return errorResult('UNKNOWN', actor.code);
  if (input.ownerId && input.ownerId !== action.ownerId) return errorResult('blocked', 'OWNER_MISMATCH');
  if (mission?.ownerId !== action.ownerId) return errorResult('blocked', 'OWNER_MISMATCH');
  if (action.capability === 'contract.wont.delete') return errorResult('blocked', 'WONT_IMMUTABLE');
  if (mission?.state !== 'contracted' && mission?.state !== 'prepping' && mission?.state !== 'live') return errorResult('blocked', 'CONTRACT_REQUIRED');
  if (!contract || contract.status !== 'active' || contract.ownerId !== action.ownerId) return errorResult('blocked', 'CONTRACT_INVALID');
  if (!grant) return errorResult('blocked', 'GRANT_REQUIRED');
  if (grant.status !== 'active') return errorResult('blocked', 'GRANT_INACTIVE');
  if (grant.ownerId !== action.ownerId) return errorResult('blocked', 'GRANT_OWNER_MISMATCH');
  if (!grant.expiresAt) return errorResult('blocked', 'GRANT_EXPIRED');
  if (grant.contractHash !== contract.hash) return errorResult('blocked', 'GRANT_CONTRACT_MISMATCH');
  if (Date.parse(grant.expiresAt) <= Date.parse(now)) return errorResult('blocked', 'GRANT_EXPIRED');
  if (level(action.requestedAutonomy) > level(mission.autonomy)) return errorResult('blocked', 'AUTONOMY_TOO_HIGH');
  if (level(mission.autonomy) < 2) return errorResult('blocked', 'AUTONOMY_TOO_LOW');
  const capability = grant.capabilities?.find((item) => item.capability === action.capability && withinScope(item.scope, action.scope));
  if (!capability) return errorResult('blocked', 'SCOPE_DENIED');
  if (action.risk === 'financial' || action.requestedAutonomy === 'A5') return errorResult('blocked', 'A5_NEVER_AUTOMATIC');
  if (isP0Forbidden(action) && phase === 'P0') return errorResult('blocked', 'P0_EXTERNAL_EFFECT_BLOCKED');
  if (action.risk === 'external' || action.requestedAutonomy === 'A4') {
    return { status: 'needs_confirmation', code: 'A4_CONFIRMATION_REQUIRED', requiresConfirmation: true };
  }
  return { status: 'allowed', code: 'ALLOWED', requiresConfirmation: false };
}
