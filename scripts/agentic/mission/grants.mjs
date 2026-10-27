const terminalErrors = {
  consumed: 'GRANT_NOT_ACTIVE', revoked: 'GRANT_REVOKED', expired: 'GRANT_EXPIRED', invalidated: 'GRANT_INVALIDATED',
};
const fail = (code, message = code) => ({ ok: false, error: { code, message } });
const iso = value => Date.parse(value);
function owned(grant, context) {
  if (grant.ownerId !== context.ownerId || grant.actor !== context.actor) return fail('FORBIDDEN');
  if (!context.actor) return fail('ACTOR_REQUIRED');
  if (context.resolvedModel == null) return fail('MODEL_UNKNOWN');
  if (context.contractHash !== grant.contractHash) return fail('CONTRACT_MISMATCH');
  return null;
}
export function proposeGrant(grant) {
  if (!grant?.ownerId || !grant.actor) return fail('ACTOR_REQUIRED');
  if (grant.status !== 'proposed') return fail('GRANT_NOT_PROPOSED');
  if (!Array.isArray(grant.capabilities) || grant.capabilities.length === 0) return fail('CAPABILITY_REQUIRED');
  return { ok: true, grant: { ...grant, status: 'proposed' } };
}
export function activateGrant(grant, context) {
  if (grant.status !== 'proposed') return fail('GRANT_NOT_PROPOSED');
  if (!grant.actor || !context.actor) return fail('ACTOR_REQUIRED');
  if (context.resolvedModel == null) return fail('MODEL_UNKNOWN');
  if (context.actionAutonomy === 'A5') return fail('AUTONOMY_FORBIDDEN');
  if (context.actionAutonomy === 'A4') return fail('CONFIRMATION_REQUIRED');
  if (grant.ownerId !== context.ownerId || grant.actor !== context.actor) return fail('FORBIDDEN');
  if (grant.expiresAt && iso(grant.expiresAt) <= iso(context.now)) return fail('GRANT_EXPIRED');
  return { ok: true, grant: { ...grant, status: 'active', revision: (grant.revision || 0) + 1 } };
}
export function checkGrant(grant, context) {
  if (grant.status !== 'active') return fail(terminalErrors[grant.status] || 'GRANT_NOT_ACTIVE');
  const identity = owned(grant, context); if (identity) return identity;
  if (iso(context.now) >= iso(grant.expiresAt)) return fail('GRANT_EXPIRED');
  if (context.windowStart && iso(context.now) < iso(context.windowStart)) return fail('WINDOW_CLOSED');
  if (context.windowEnd && iso(context.now) > iso(context.windowEnd)) return fail('WINDOW_CLOSED');
  if (!grant.capabilities.includes(context.capability)) return fail('CAPABILITY_DENIED');
  if (context.allowedResources && !context.allowedResources.some(scope => context.resource === scope || context.resource?.startsWith(`${scope}/`))) return fail('SCOPE_DENIED');
  if (context.dataClass && !grant.dataDisclosure.includes(context.dataClass)) return fail('DISCLOSURE_DENIED');
  if (context.allowedDataClasses && context.dataClass && !context.allowedDataClasses.includes(context.dataClass)) return fail('DISCLOSURE_DENIED');
  if ((context.spent || 0) + (context.estimate || 0) > (context.budget ?? Number.POSITIVE_INFINITY)) return fail('BUDGET_EXCEEDED');
  if (context.actionAutonomy === 'A5') return fail('AUTONOMY_FORBIDDEN');
  if (context.actionAutonomy === 'A4') return fail('CONFIRMATION_REQUIRED');
  return { ok: true, grant };
}
export function consumeGrant(grant, context) {
  const checked = checkGrant(grant, context); if (!checked.ok) return checked;
  return { ok: true, grant: { ...grant, status: 'consumed', consumedAt: context.now, revision: grant.revision + 1 } };
}
function transition(grant, status, context) {
  if (!grant?.id || !context?.ownerId || grant.ownerId !== context.ownerId) return fail('FORBIDDEN');
  if (grant.status !== 'active') return fail('GRANT_NOT_ACTIVE');
  return { ok: true, grant: { ...grant, status, revision: grant.revision + 1 } };
}
export const revokeGrant = (grant, context) => transition(grant, 'revoked', context);
export function expireGrant(grant, context) {
  if (iso(context.now) < iso(grant.expiresAt)) return fail('NOT_EXPIRED');
  if (!grant?.id || !context?.ownerId || grant.ownerId !== context.ownerId) return fail('FORBIDDEN');
  if (!['proposed', 'active'].includes(grant.status)) return fail('GRANT_NOT_ACTIVE');
  return { ok: true, grant: { ...grant, status: 'expired', revision: grant.revision + 1 } };
}
export function invalidateGrant(grant, context) {
  if (!context.newContractHash || context.newContractHash === grant.contractHash) return fail('CONTRACT_UNCHANGED');
  return transition(grant, 'invalidated', context);
}
