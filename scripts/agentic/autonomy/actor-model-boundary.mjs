import { normalizeActor } from './types.mjs';

export const ACTOR_MODEL_STATES = Object.freeze(['RESOLVED', 'UNKNOWN']);
export const COMPLETION_EVENT_TYPES = Object.freeze([
  'autonomy.action.result',
  'autonomy.action.completed',
  'autonomy.run.completed',
]);

const fail = (code) => {
  const error = new Error(code);
  error.code = code;
  return error;
};

function normalizedActor(input = {}) {
  let actor;
  try {
    actor = normalizeActor(input);
  } catch (error) {
    throw error;
  }
  if (input.requestedModel != null && typeof input.requestedModel !== 'string') throw fail('ACTOR_REQUESTED_MODEL_INVALID');
  return {
    actorId: actor.actorId,
    modelProvider: actor.modelProvider,
    requestedModel: input.requestedModel ?? null,
    resolvedModel: actor.resolvedModel,
    status: actor.status,
    code: actor.code,
  };
}

export function normalizeActorProvenance(actor = {}) {
  return normalizedActor(actor);
}

export function validateActorModel(actor = {}) {
  return normalizedActor(actor);
}

export function completionVerdict(actor = {}, { output } = {}) {
  let normalized;
  try {
    normalized = normalizedActor(actor);
  } catch (error) {
    return { status: 'blocked', code: error.code ?? 'ACTOR_INVALID', canComplete: false };
  }
  if (normalized.status !== 'RESOLVED') {
    return { status: 'UNKNOWN', code: 'ACTOR_MODEL_UNKNOWN', canComplete: false };
  }
  return { status: 'succeeded', code: 'SUCCEEDED', canComplete: true, output };
}

function eventType(input) {
  const type = input.type ?? input.eventType;
  if (typeof type !== 'string' || type.length === 0) throw fail('AUTONOMY_EVENT_INVALID');
  return type;
}

export function isCompletionEvent(type) {
  return COMPLETION_EVENT_TYPES.includes(type);
}

export function normalizeAutonomyEvent(input = {}) {
  const type = eventType(input);
  if (typeof input.eventId !== 'string' || !input.eventId
    || typeof input.ownerId !== 'string' || !input.ownerId
    || typeof input.occurredAt !== 'string' || !Number.isFinite(Date.parse(input.occurredAt))) {
    throw fail('AUTONOMY_EVENT_INVALID');
  }
  let actor;
  try {
    actor = normalizedActor(input.actor);
  } catch (error) {
    throw error.code === 'ACTOR_INVALID' ? error : fail(error.code ?? 'ACTOR_INVALID');
  }
  const unknown = actor.status !== 'RESOLVED';
  return {
    eventId: input.eventId,
    type,
    ownerId: input.ownerId,
    actorId: actor.actorId,
    modelProvider: actor.modelProvider,
    requestedModel: actor.requestedModel,
    resolvedModel: actor.resolvedModel,
    actorStatus: actor.status,
    status: unknown && isCompletionEvent(type) ? 'UNKNOWN' : (input.status ?? null),
    code: unknown && isCompletionEvent(type) ? 'ACTOR_MODEL_UNKNOWN' : (input.code ?? null),
    occurredAt: input.occurredAt,
    payload: input.payload ?? {},
  };
}
