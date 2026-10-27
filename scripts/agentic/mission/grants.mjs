const terminalErrors = {
  consumed: 'GRANT_NOT_ACTIVE', revoked: 'GRANT_REVOKED', expired: 'GRANT_EXPIRED', invalidated: 'GRANT_INVALIDATED',
};
const fail = (code, message = code) => ({ ok: false, error: { code, message } });
const iso = value => {
  const parsed = Date.parse(value ?? '');
  return Number.isFinite(parsed) ? parsed : null;
};
function validTime(value) { return iso(value) !== null; }
function validHash(value) { return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value); }
function validCapabilities(value) { return Array.isArray(value) && value.length > 0 && value.every(item => typeof item === 'string' && item.length > 0); }
const GRANT_KEYS = new Set(['id', 'ownerId', 'revision', 'schemaVersion', 'createdAt', 'updatedAt', 'deletedAt', 'source', 'contractHash', 'actor', 'capabilities', 'dataDisclosure', 'expiresAt', 'status', 'consumedAt']);
function normalizedGrant(grant) {
  const timestamp = grant?.createdAt || new Date().toISOString();
  return grant && { schemaVersion: 1, revision: 1, createdAt: timestamp, updatedAt: timestamp, deletedAt: null, source: 'real', ...grant };
}
function validGrantShape(grant) {
  if (!grant || Object.keys(grant).some(key => !GRANT_KEYS.has(key)) || !grant.id || !grant.ownerId || !Number.isInteger(grant.revision) || grant.revision < 1
    || !Number.isInteger(grant.schemaVersion) || grant.schemaVersion < 1
    || !validTime(grant.createdAt) || !validTime(grant.updatedAt)
    || !(grant.deletedAt === null || validTime(grant.deletedAt))
    || !['real', 'demo', 'imported'].includes(grant.source)
    || !grant.actor || !validHash(grant.contractHash)
    || !validCapabilities(grant.capabilities) || !Array.isArray(grant.dataDisclosure)
    || !grant.dataDisclosure.every(item => typeof item === 'string' && item.length > 0)
    || !validTime(grant.expiresAt)
    || (Object.prototype.hasOwnProperty.call(grant, 'consumedAt') && !validTime(grant.consumedAt))
    || !['proposed', 'active', 'consumed', 'revoked', 'expired', 'invalidated'].includes(grant.status)) return fail('GRANT_INVALID');
  return null;
}
function owned(grant, context) {
  if (grant.ownerId !== context.ownerId || grant.actor !== context.actor) return fail('FORBIDDEN');
  if (!context.actor) return fail('ACTOR_REQUIRED');
  if (context.resolvedModel == null || context.resolvedModel === '') return fail('MODEL_UNKNOWN');
  if (context.contractHash !== grant.contractHash) return fail('CONTRACT_MISMATCH');
  return null;
}
export function proposeGrant(grant) {
  const candidate = normalizedGrant(grant);
  const malformed = validGrantShape(candidate); if (malformed) return malformed;
  if (candidate.status !== 'proposed') return fail('GRANT_NOT_PROPOSED');
  return { ok: true, grant: { ...candidate, status: 'proposed' } };
}
export function activateGrant(grant, context) {
  grant = normalizedGrant(grant);
  const malformed = validGrantShape(grant); if (malformed || !context || !validTime(context.now)) return malformed || fail('GRANT_INVALID');
  if (grant.status !== 'proposed') return fail('GRANT_NOT_PROPOSED');
  if (!grant.actor || !context.actor) return fail('ACTOR_REQUIRED');
  if (context.resolvedModel == null || context.resolvedModel === '') return fail('MODEL_UNKNOWN');
  if (context.actionAutonomy === 'A5') return fail('AUTONOMY_FORBIDDEN');
  if (context.actionAutonomy === 'A4') return fail('CONFIRMATION_REQUIRED');
  if (grant.ownerId !== context.ownerId || grant.actor !== context.actor) return fail('FORBIDDEN');
  if (context.contractHash !== grant.contractHash) return fail('CONTRACT_MISMATCH');
  if (grant.expiresAt && iso(grant.expiresAt) <= iso(context.now)) return fail('GRANT_EXPIRED');
  return { ok: true, grant: { ...grant, status: 'active', revision: (grant.revision || 0) + 1 } };
}
export function checkGrant(grant, context) {
  grant = normalizedGrant(grant);
  const malformed = validGrantShape(grant); if (malformed || !context || !validTime(context.now)
    || (context.windowStart && !validTime(context.windowStart))
    || (context.windowEnd && !validTime(context.windowEnd))) return malformed || fail('GRANT_INVALID');
  if (grant.status !== 'active') return fail(terminalErrors[grant.status] || 'GRANT_NOT_ACTIVE');
  const identity = owned(grant, context); if (identity) return identity;
  if (iso(context.now) >= iso(grant.expiresAt)) return fail('GRANT_EXPIRED');
  if (context.windowStart && iso(context.now) < iso(context.windowStart)) return fail('WINDOW_CLOSED');
  if (context.windowEnd && iso(context.now) > iso(context.windowEnd)) return fail('WINDOW_CLOSED');
  if (!grant.capabilities.includes(context.capability)) return fail('CAPABILITY_DENIED');
  const scopes = context.allowedResources ?? context.scope;
  if (!Array.isArray(scopes) || !scopes.some(scope => context.resource === scope || context.resource?.startsWith(`${scope}/`))) return fail('SCOPE_DENIED');
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
  grant = normalizedGrant(grant);
  const malformed = validGrantShape(grant); if (malformed || !context?.ownerId) return malformed || fail('FORBIDDEN');
  const allowed = status === 'invalidated' ? ['proposed', 'active'] : ['active'];
  if (!allowed.includes(grant.status)) return fail('GRANT_NOT_ACTIVE');
  return { ok: true, grant: { ...grant, status, revision: grant.revision + 1 } };
}
export const revokeGrant = (grant, context) => transition(grant, 'revoked', context);
export function expireGrant(grant, context) {
  grant = normalizedGrant(grant);
  const malformed = validGrantShape(grant); if (malformed || !context || !validTime(context.now)) return malformed || fail('GRANT_INVALID');
  if (iso(context.now) < iso(grant.expiresAt)) return fail('NOT_EXPIRED');
  if (!grant?.id || !context?.ownerId || grant.ownerId !== context.ownerId) return fail('FORBIDDEN');
  if (!['proposed', 'active'].includes(grant.status)) return fail('GRANT_NOT_ACTIVE');
  return { ok: true, grant: { ...grant, status: 'expired', revision: grant.revision + 1 } };
}
export function invalidateGrant(grant, context) {
  grant = normalizedGrant(grant);
  const malformed = validGrantShape(grant); if (malformed || !context) return malformed || fail('GRANT_INVALID');
  if (!context.newContractHash || context.newContractHash === grant.contractHash) return fail('CONTRACT_UNCHANGED');
  if (!grant.id || !context.ownerId || grant.ownerId !== context.ownerId) return fail('FORBIDDEN');
  if (!['proposed', 'active'].includes(grant.status)) return fail('GRANT_NOT_ACTIVE');
  return { ok: true, grant: { ...grant, status: 'invalidated', revision: grant.revision + 1 } };
}
