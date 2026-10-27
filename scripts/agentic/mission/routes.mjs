import { transitionMission } from './state-machine.mjs';
import {
  proposeGrant,
  activateGrant,
  checkGrant,
  consumeGrant,
  revokeGrant,
  expireGrant,
  invalidateGrant,
} from './grants.mjs';
import { createMissionStore } from './store.mjs';
import { loadSchema, validate } from '../contracts.mjs';
import { fileURLToPath } from 'node:url';

const contractDir = fileURLToPath(new URL('../../../contracts/agentic/', import.meta.url));
const missionSchema = loadSchema('mission.schema.json', contractDir);
const grantSchema = loadSchema('grant.schema.json', contractDir);
const MISSION_INPUT_KEYS = new Set([
  'id', 'ownerId', 'revision', 'schemaVersion', 'blockId', 'parentMissionId', 'goal', 'deliveryClass',
  'state', 'blockedReason', 'autonomy', 'scanId', 'previewId', 'contractId', 'contractHash', 'subMissionIds',
  'resumeState', 'confirmedContractHash', 'createdAt', 'updatedAt', 'deletedAt',
]);
const FROZEN_ERRORS = new Set(['AUTH_REQUIRED', 'FORBIDDEN', 'NOT_FOUND', 'CONTRACT_INVALID', 'CONFLICT', 'RATE_LIMITED', 'BUDGET_EXCEEDED', 'NEED_HUMAN', 'UPSTREAM_UNAVAILABLE', 'INTERNAL_ERROR']);
const errorCode = code => FROZEN_ERRORS.has(code) ? code : ({ INVALID_INPUT: 'CONTRACT_INVALID', PRECONDITION_FAILED: 'CONTRACT_INVALID', INVALID_STATE: 'CONTRACT_INVALID', INVALID_TRANSITION: 'CONTRACT_INVALID', TERMINAL_STATE: 'CONFLICT', WINDOW_NOT_OPEN: 'CONFLICT', MODEL_UNKNOWN: 'FORBIDDEN', CONTRACT_MISMATCH: 'FORBIDDEN', CAPABILITY_DENIED: 'FORBIDDEN', SCOPE_DENIED: 'FORBIDDEN', DISCLOSURE_DENIED: 'FORBIDDEN', GRANT_INVALID: 'CONTRACT_INVALID', GRANT_NOT_ACTIVE: 'FORBIDDEN', GRANT_NOT_PROPOSED: 'FORBIDDEN', GRANT_EXPIRED: 'FORBIDDEN', GRANT_REVOKED: 'FORBIDDEN', GRANT_INVALIDATED: 'FORBIDDEN', ACTOR_REQUIRED: 'FORBIDDEN', AUTONOMY_FORBIDDEN: 'NEED_HUMAN', AUTONOMY_REQUIRES_CONFIRMATION: 'NEED_HUMAN', CONFIRMATION_REQUIRED: 'NEED_HUMAN' }[code] || 'INTERNAL_ERROR');
const reply = (res, status, value) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(value));
};
const errorBody = error => {
  const publicCode = errorCode(error.code);
  const details = {
    ...(error.details || {}),
    ...(publicCode === error.code ? {} : { internalCode: error.code }),
  };
  return { error: { code: publicCode, message: error.message || error.code, ...(Object.keys(details).length ? { details } : {}) } };
};
const internalErrorBody = errorBody;
const statusFor = code => ({
  AUTH_REQUIRED: 401,
  FORBIDDEN: 403,
  MODEL_UNKNOWN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  NEED_HUMAN: 409,
  BUDGET_EXCEEDED: 409,
  GRANT_EXPIRED: 409,
  GRANT_REVOKED: 409,
  GRANT_INVALIDATED: 409,
  GRANT_NOT_ACTIVE: 409,
  GRANT_INVALID: 400,
  ACTOR_REQUIRED: 403,
  CONTRACT_MISMATCH: 403,
  CAPABILITY_DENIED: 403,
  SCOPE_DENIED: 403,
  DISCLOSURE_DENIED: 403,
  WINDOW_CLOSED: 409,
  DEFAULT: 400,
}[code] || 400);

export function createMissionRoutes({ db, auth, store = createMissionStore(db) }) {
  return async (req, res, pathname = req.url?.split('?')[0]) => {
    if (pathname !== '/api/missions' && !pathname.startsWith('/api/missions/')) return false;
    const ownerId = auth.ownerId(req);
    if (!ownerId) { reply(res, 401, errorBody({ code: 'AUTH_REQUIRED' })); return true; }
    const parts = pathname.split('/').filter(Boolean);
    if (req.method === 'POST' && parts.length === 2) {
    const input = await req.json();
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !MISSION_INPUT_KEYS.has(key))) { reply(res, 400, errorBody({ code: 'INVALID_INPUT' })); return true; }
    if (input.state !== undefined && input.state !== 'draft') { reply(res, 400, errorBody({ code: 'INVALID_INPUT' })); return true; }
    if (input.autonomy !== undefined && !['A1', 'A2', 'A3'].includes(input.autonomy)) { reply(res, 400, errorBody({ code: 'INVALID_INPUT' })); return true; }
    const mission = {
      id: input.id, ownerId, revision: 1, schemaVersion: input.schemaVersion, blockId: input.blockId, goal: input.goal,
      state: 'draft', autonomy: input.autonomy || 'A1', scanId: null, previewId: null, contractId: null,
      createdAt: input.createdAt, updatedAt: input.updatedAt, deletedAt: null,
      ...(input.parentMissionId !== undefined ? { parentMissionId: input.parentMissionId } : {}),
      ...(input.deliveryClass !== undefined ? { deliveryClass: input.deliveryClass } : {}),
      ...(input.subMissionIds !== undefined ? { subMissionIds: input.subMissionIds } : {}),
    };
    const resultCheck = validate(mission, missionSchema);
    if (!resultCheck.valid) { reply(res, 400, errorBody({ code: 'INVALID_INPUT', message: 'Mission does not satisfy contract', details: { errors: resultCheck.errors } })); return true; }

      const result = store.saveMission(mission);
      reply(res, result.ok ? 201 : statusFor(result.error?.code), result.ok ? mission : errorBody(result.error));
      return true;
    }
    if (parts.length < 3) { reply(res, 404, errorBody({ code: 'NOT_FOUND' })); return true; }
    const id = parts[2];
    const mission = store.getMission(ownerId, id);
    if (!mission) { reply(res, 404, errorBody({ code: 'NOT_FOUND' })); return true; }
    if (req.method === 'GET' && parts.length === 3) { reply(res, 200, mission); return true; }
    if (parts[3] === 'grants') return grantRoute(req, res, parts, ownerId, id, store);
    if (req.method === 'POST' && parts[3] === 'transition') {
      const input = await req.json();
      const prior = rememberPending(store, ownerId, input.commandId);
      if (prior?.duplicate) return replay(res, prior.result);
      const result = transitionMission(mission, input.event, { ...input, ownerId });
      if (!result.ok) {
        rememberResult(store, ownerId, input.commandId, result);
        reply(res, statusFor(result.error.code), errorBody(result.error));
        return true;
      }
      const updated = store.updateMission(result.mission, { ownerId, expectedRevision: mission.revision });
      if (!updated.ok) { rememberResult(store, ownerId, input.commandId, { ok: false, error: updated.error }); reply(res, 409, errorBody(updated.error)); return true; }
      const appended = store.appendEvent({ ownerId, missionId: id, eventId: result.event.eventId, revision: result.mission.revision, from: result.event.from, to: result.event.to, type: result.event.type, payload: JSON.stringify(result.event) });
      if (!appended.ok || appended.duplicate) { const failure = { code: 'CONFLICT', message: 'Event already exists' }; rememberResult(store, ownerId, input.commandId, { ok: false, error: failure }); reply(res, 409, errorBody(failure)); return true; }
      if (input.event === 'contract' && mission.contractHash && mission.contractHash !== result.mission.contractHash) {
        store.invalidateGrants(ownerId, id, mission.contractHash, result.mission.updatedAt);
      }
      const response = { mission: result.mission, event: result.event };
      rememberResult(store, ownerId, input.commandId, response);
      reply(res, 200, response); return true;
    }
    reply(res, 404, errorBody({ code: 'NOT_FOUND' })); return true;
  };
}

async function grantRoute(req, res, parts, ownerId, missionId, store) {
  if (parts.length === 4 && req.method === 'POST') {
    const input = await req.json();
    const timestamp = input.createdAt || new Date().toISOString();
    const grantInput = {
      id: input.id, ownerId, revision: input.revision || 1, schemaVersion: input.schemaVersion || 1,
      contractHash: input.contractHash, actor: input.actor, capabilities: input.capabilities,
      dataDisclosure: input.dataDisclosure, expiresAt: input.expiresAt, status: input.status,
      ...(input.consumedAt !== undefined ? { consumedAt: input.consumedAt } : {}),
      createdAt: timestamp, updatedAt: input.updatedAt || timestamp, deletedAt: input.deletedAt ?? null, source: 'real',
    };
    const result = proposeGrant(grantInput);
    if (!result.ok || !validate(result.grant, grantSchema).valid) { reply(res, 400, errorBody({ code: 'GRANT_INVALID', message: result.error?.message || 'Grant does not satisfy contract' })); return true; }
    try {
      store.saveGrant(result.grant);
      store.saveGrantProvenance({ ownerId, grantId: result.grant.id, missionId, revision: result.grant.revision, resolvedModel: input.resolvedModel || 'pending', modelSource: input.modelSource || 'route', scope: input.scope || [], createdAt: timestamp, updatedAt: result.grant.updatedAt });
      store.audit({ ownerId, missionId, grantId: result.grant.id, action: 'propose', revision: result.grant.revision, payload: { status: result.grant.status } });
    } catch (error) {
      if (String(error.message).includes('UNIQUE')) { reply(res, 409, errorBody({ code: 'CONFLICT' })); return true; }
      throw error;
    }
    reply(res, 201, result.grant); return true;
  }
  if (parts.length < 5) { reply(res, 404, errorBody({ code: 'NOT_FOUND' })); return true; }
  const grantId = parts[4];
  const grant = store.getGrant(ownerId, grantId);
  const provenance = grant && store.getGrantProvenance(ownerId, grantId, missionId);
  if (!grant) { reply(res, 404, errorBody({ code: 'NOT_FOUND' })); return true; }
  if (!provenance || provenance.missionId !== missionId) { reply(res, 403, errorBody({ code: 'CONTRACT_MISMATCH' })); return true; }
  if (req.method === 'GET' && parts.length === 5) { reply(res, 200, grant); return true; }
  if (req.method !== 'POST') { reply(res, 404, errorBody({ code: 'NOT_FOUND' })); return true; }
  const action = parts[5];
  const input = await req.json();
  const prior = rememberPending(store, ownerId, input.commandId);
  if (prior?.duplicate) return replay(res, prior.result);
  const currentMission = store.getMission(ownerId, missionId);
  const lifecycleAction = ['activate', 'check', 'consume', 'revoke', 'expire', 'invalidate'].includes(action);
  if (!currentMission || (lifecycleAction && (currentMission.state !== 'contracted' || currentMission.contractHash !== grant.contractHash)) || (action === 'activate' && (!provenance.resolvedModel || provenance.resolvedModel === 'pending'))) {
    const failure = { ok: false, error: { code: currentMission?.state === 'contracted' && currentMission.contractHash !== grant.contractHash ? 'CONTRACT_MISMATCH' : 'FORBIDDEN', message: 'Grant requires contracted mission and matching resolved model' } };
    rememberResult(store, ownerId, input.commandId, failure);
    reply(res, 403, errorBody(failure.error));
    return true;
  }
  const context = { ...input, ownerId, actor: input.actor || grant.actor, contractHash: input.contractHash, scope: provenance.scope, resolvedModel: input.resolvedModel || provenance.resolvedModel };
  const result = action === 'activate' ? activateGrant(grant, context)
    : action === 'check' ? checkGrant(grant, context)
      : action === 'consume' ? consumeGrant(grant, context)
        : action === 'revoke' ? revokeGrant(grant, context)
          : action === 'expire' ? expireGrant(grant, context)
            : action === 'invalidate' ? invalidateGrant(grant, context) : null;
  if (!result) { reply(res, 404, errorBody({ code: 'NOT_FOUND' })); return true; }
  if (!result.ok) {
    rememberResult(store, ownerId, input.commandId, result);
    reply(res, statusFor(result.error.code), errorBody(result.error)); return true;
  }
  if (action !== 'check') {
    const updated = store.updateGrant(result.grant, { ownerId, expectedRevision: grant.revision });
    if (!updated.ok) { rememberResult(store, ownerId, input.commandId, { ok: false, error: updated.error }); reply(res, 409, errorBody(updated.error)); return true; }
  }
    const response = result.grant;
    if (action !== 'check') store.audit({ ownerId, missionId, grantId, action, revision: response.revision, payload: { status: response.status } });
  rememberResult(store, ownerId, input.commandId, response);
  reply(res, 200, response); return true;
}

function rememberPending(store, ownerId, commandId) {
  if (!commandId) return null;
  return store.rememberCommand(ownerId, commandId, { pending: true });
}
function rememberResult(store, ownerId, commandId, result) {
  if (commandId) store.rememberCommand(ownerId, commandId, result);
}
function replay(res, result) {
  const failed = result?.ok === false;
  reply(res, failed ? statusFor(result.error?.code) : 200, failed ? errorBody(result.error, true) : { ...result, replayed: true });
  return true;
}
