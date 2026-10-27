export const AUTONOMY_LEVELS = Object.freeze(['A0', 'A1', 'A2', 'A3', 'A4', 'A5']);
export const ACTION_RISKS = Object.freeze(['observe', 'suggest', 'prepare', 'reversible', 'external', 'financial']);

const fail = (code, message = code) => {
  const error = new Error(message);
  error.code = code;
  throw error;
};

export function normalizeActor(actor = {}) {
  if (typeof actor.actorId !== 'string' || !actor.actorId) fail('ACTOR_INVALID');
  if (actor.resolvedModel == null || actor.resolvedModel === '') {
    return { actorId: actor.actorId, resolvedModel: null, modelProvider: actor.modelProvider ?? null, status: 'UNKNOWN', code: 'ACTOR_MODEL_UNKNOWN' };
  }
  if (typeof actor.resolvedModel !== 'string') fail('ACTOR_MODEL_INVALID');
  return { actorId: actor.actorId, resolvedModel: actor.resolvedModel, modelProvider: actor.modelProvider ?? null, status: 'RESOLVED', code: 'ACTOR_MODEL_RESOLVED' };
}

export function normalizeAction(action = {}) {
  if (!ACTION_RISKS.includes(action.risk)) fail('AUTONOMY_ACTION_INVALID');
  if (!AUTONOMY_LEVELS.includes(action.requestedAutonomy)) fail('AUTONOMY_LEVEL_INVALID');
  return { risk: action.risk, requestedAutonomy: action.requestedAutonomy };
}

export function errorResult(status, code, extra = {}) {
  return { status, code, requiresConfirmation: false, ...extra };
}
