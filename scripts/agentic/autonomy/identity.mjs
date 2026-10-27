import { createHash } from 'node:crypto';

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

export function stableFingerprint(value) {
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

export function actionIdentity(action = {}) {
  return stableFingerprint({
    id: action.id ?? null,
    hash: action.hash ?? null,
    ownerId: action.ownerId ?? null,
    capability: action.capability ?? null,
    scope: action.scope ?? null,
    risk: action.risk ?? null,
    requestedAutonomy: action.requestedAutonomy ?? null,
    actor: action.actor ?? null,
    ...action,
  });
}

export function requestIdentity(input = {}) {
  return stableFingerprint({
    ownerId: input.ownerId ?? null,
    mission: input.mission ?? null,
    contract: input.contract ?? null,
    grant: input.grant ?? null,
    action: input.action ?? null,
    spent: input.spent ?? null,
  });
}
