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

const reply = (res, status, value) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(value));
};
const errorBody = (error) => ({ error: { code: error.code, message: error.message || error.code } });
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
      const mission = { ...input, ownerId, revision: 1 };
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
      if (!updated.ok) { reply(res, 409, errorBody(updated.error)); return true; }
      store.appendEvent({ ownerId, missionId: id, eventId: result.event.eventId, revision: result.mission.revision, from: result.event.from, to: result.event.to, type: result.event.type, payload: JSON.stringify(input) });
      if (input.event === 'contract' && mission.contractHash && mission.contractHash !== result.mission.contractHash) {
        store.invalidateGrants(ownerId, mission.contractHash, result.mission.updatedAt);
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
    const result = proposeGrant({ ...input, ownerId });
    if (!result.ok) { reply(res, statusFor(result.error.code), errorBody(result.error)); return true; }
    try {
      store.saveGrant(result.grant);
    } catch (error) {
      if (String(error.message).includes('UNIQUE')) { reply(res, 409, errorBody({ code: 'CONFLICT' })); return true; }
      throw error;
    }
    reply(res, 201, result.grant); return true;
  }
  if (parts.length < 5) { reply(res, 404, errorBody({ code: 'NOT_FOUND' })); return true; }
  const grantId = parts[4];
  const grant = store.getGrant(ownerId, grantId);
  if (!grant) { reply(res, 404, errorBody({ code: 'NOT_FOUND' })); return true; }
  if (req.method === 'GET' && parts.length === 5) { reply(res, 200, grant); return true; }
  if (req.method !== 'POST') { reply(res, 404, errorBody({ code: 'NOT_FOUND' })); return true; }
  const action = parts[5];
  const input = await req.json();
  const prior = rememberPending(store, ownerId, input.commandId);
  if (prior?.duplicate) return replay(res, prior.result);
  const context = { ...input, ownerId, actor: input.actor || grant.actor, contractHash: input.contractHash || grant.contractHash };
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
    if (!updated.ok) { reply(res, 409, errorBody(updated.error)); return true; }
  }
  const response = result.grant;
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
  reply(res, failed ? statusFor(result.error?.code) : 200, failed ? errorBody(result.error) : { ...result, replayed: true });
  return true;
}
