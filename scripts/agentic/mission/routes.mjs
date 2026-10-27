import { transitionMission } from './state-machine.mjs';

const reply = (res, status, value) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
const errorBody = (error) => ({ error: { code: error.code, message: error.message || error.code } });

export function createMissionRoutes({ auth, store }) {
  return async (req, res, pathname = req.url?.split('?')[0]) => {
    if (!pathname.startsWith('/api/missions')) return false;
    const ownerId = auth.ownerId(req);
    if (!ownerId) { reply(res, 401, errorBody({ code: 'AUTH_REQUIRED' })); return true; }
    const parts = pathname.split('/').filter(Boolean);
    if (req.method === 'POST' && parts.length === 2) {
      const input = await req.json();
      const mission = { ...input, ownerId, revision: 1 };
      const result = store.saveMission(mission);
      reply(res, result.ok ? 201 : 409, result.ok ? mission : errorBody(result.error));
      return true;
    }
    if (parts.length < 3) { reply(res, 404, errorBody({ code: 'NOT_FOUND' })); return true; }
    const id = parts[2];
    const mission = store.getMission(ownerId, id);
    if (!mission) { reply(res, 404, errorBody({ code: 'NOT_FOUND' })); return true; }
    if (req.method === 'GET' && parts.length === 3) { reply(res, 200, mission); return true; }
    if (req.method === 'POST' && parts[3] === 'transition') {
      const input = await req.json();
      const prior = input.commandId ? store.rememberCommand(ownerId, input.commandId, { pending: true }) : { duplicate: false };
      if (prior.duplicate) { reply(res, 200, { ...prior.result, replayed: true }); return true; }
      const result = transitionMission(mission, input.event, { ...input, ownerId });
      if (!result.ok) { if (input.commandId) store.rememberCommand(ownerId, input.commandId, result); reply(res, result.error.code === 'CONFLICT' ? 409 : 400, errorBody(result.error)); return true; }
      const updated = store.updateMission(result.mission, { ownerId, expectedRevision: mission.revision });
      if (!updated.ok) { reply(res, 409, errorBody(updated.error)); return true; }
      store.appendEvent({ ownerId, missionId: id, eventId: result.event.eventId, revision: result.mission.revision, from: result.event.from, to: result.event.to, type: result.event.type, payload: JSON.stringify(input) });
      const response = { mission: result.mission, event: result.event };
      if (input.commandId) {
        dbSafeRemember(store, ownerId, input.commandId, response);
      }
      reply(res, 200, response); return true;
    }
    reply(res, 404, errorBody({ code: 'NOT_FOUND' })); return true;
  };
}
function dbSafeRemember(store, ownerId, commandId, response) {
  const existing = store.rememberCommand(ownerId, commandId, response);
  if (existing.duplicate) return existing.result;
  return response;
}
