const STATES = new Set(['draft', 'scanned', 'previewed', 'discussing', 'contracted', 'prepping', 'live', 'reviewing', 'delivered', 'blocked', 'paused', 'cancelled', 'failed', 'expired']);
const TERMINAL = new Set(['delivered', 'cancelled', 'failed', 'expired']);
const EDGES = {
  draft: { scan: 'scanned', cancel: 'cancelled' },
  scanned: { preview: 'previewed', cancel: 'cancelled' },
  previewed: { discuss: 'discussing', contract: 'contracted', cancel: 'cancelled', expire: 'expired' },
  discussing: { preview: 'previewed', contract: 'contracted', cancel: 'cancelled', expire: 'expired' },
  contracted: { prepare: 'prepping', pause: 'paused', block: 'blocked', cancel: 'cancelled' },
  prepping: { start: 'live', pause: 'paused', block: 'blocked', fail: 'failed', cancel: 'cancelled' },
  live: { review: 'reviewing', pause: 'paused', block: 'blocked', fail: 'failed', cancel: 'cancelled' },
  reviewing: { deliver: 'delivered', prepare: 'prepping', pause: 'paused', fail: 'failed', cancel: 'cancelled' },
  blocked: { resume: null, cancel: 'cancelled', fail: 'failed' },
  paused: { resume: null, cancel: 'cancelled', fail: 'failed' },
};

const error = (code, message = code) => ({ ok: false, error: { code, message } });
export function missionStateForCommand(command) {
  return Object.prototype.hasOwnProperty.call(Object.values(EDGES).flatMap(edges => Object.keys(edges)).reduce((out, key) => ({ ...out, [key]: true }), {}), command) ? command : null;
}
function targetFor(mission, event, context) {
  if (event === 'resume') return context.resumeState || mission.resumeState || 'prepping';
  return EDGES[mission.state]?.[event];
}
function prerequisite(mission, event, context) {
  if (!STATES.has(mission.state)) return error('INVALID_STATE');
  if (context.ownerId !== undefined && context.ownerId !== mission.ownerId) return error('NOT_FOUND', 'Mission is not owned by caller');
  if (context.expectedRevision !== undefined && context.expectedRevision !== mission.revision) return error('CONFLICT', 'Stale mission revision');
  if (TERMINAL.has(mission.state)) return error('TERMINAL_STATE', 'Terminal mission cannot transition');
  if (event === 'scan' && context.scanId === undefined) return error('PRECONDITION_FAILED', 'scanId required');
  if (event === 'preview' && mission.state === 'draft') return error('PRECONDITION_FAILED', 'scan required');
  if (event === 'prepare' && mission.state === 'previewed') return error('PRECONDITION_FAILED', 'contract required');
  if (event === 'preview' && !mission.scanId && !context.scanId) return error('PRECONDITION_FAILED', 'scan required');
  if (event === 'contract') {
    if (!mission.previewId && !context.previewId) return error('PRECONDITION_FAILED', 'preview required');
    if (!context.contractId || !/^[a-f0-9]{64}$/.test(context.contractHash || '')) return error('PRECONDITION_FAILED', 'contract id and hash required');
    if (context.autonomy === 'A4') return error('AUTONOMY_REQUIRES_CONFIRMATION');
    if (context.autonomy === 'A5') return error('AUTONOMY_FORBIDDEN');
    if (!['A1', 'A2', 'A3'].includes(context.autonomy)) return error('AUTONOMY_INVALID');
  }
  if (event === 'expire') {
    if (mission.contractId) return error('PRECONDITION_FAILED', 'contracted mission cannot expire');
    if (context.windowStart && (!context.now || Date.parse(context.now) < Date.parse(context.windowStart))) return error('WINDOW_NOT_OPEN');
  }
  if (event === 'block' && !context.reason) return error('NEED_HUMAN', 'blocked transition needs a reason');
  if (event === 'resume' && context.contractHash !== mission.contractHash) return error('CONTRACT_MISMATCH', 'Contract must be revalidated');
  if (event === 'start' && mission.state !== 'prepping') return error('INVALID_TRANSITION');
  return null;
}

export function transitionMission(mission, event, context = {}) {
  const known = missionStateForCommand(event);
  if (!known) return error('INVALID_COMMAND');
  const failure = prerequisite(mission, event, context);
  if (failure) return failure;
  const to = targetFor(mission, event, context);
  if (!to || !STATES.has(to)) return error('INVALID_TRANSITION', `Cannot ${event} from ${mission.state}`);
  const now = context.now || new Date().toISOString();
  const next = { ...mission, state: to, revision: mission.revision + 1, updatedAt: now };
  if (event === 'scan') next.scanId = context.scanId;
  if (event === 'preview') next.previewId = context.previewId || mission.previewId;
  if (event === 'contract') {
    next.contractId = context.contractId;
    next.contractHash = context.contractHash;
    next.autonomy = context.autonomy;
  }
  if (event === 'block') { next.blockedReason = context.reason; next.resumeState = mission.state; }
  if (event === 'pause') { next.resumeState = mission.state; }
  if (event === 'resume') { next.blockedReason = null; next.resumeState = null; }
  return {
    ok: true,
    mission: next,
    event: {
      eventId: context.eventId || `evt_${next.revision}`,
      type: event,
      from: mission.state,
      to,
      revision: next.revision,
      ...(context.scanId ? { scanId: context.scanId } : {}),
      ...(context.previewId ? { previewId: context.previewId } : {}),
      ...(context.contractId ? { contractId: context.contractId } : {}),
      ...(context.contractHash ? { contractHash: context.contractHash } : {}),
      ...(context.autonomy ? { autonomy: context.autonomy } : {}),
      ...(context.reason ? { reason: context.reason } : {}),
    },
  };
}

export function replayMission(initial, events) {
  let current = initial;
  for (const event of events) {
    if (event.from !== current.state || event.revision !== current.revision + 1) return error('EVENT_TAMPERED', 'Event stream does not match mission revision');
    const replayContext = { ...event, eventId: event.eventId };
    if (event.type === 'scan') replayContext.scanId = event.scanId || current.scanId || 'replayed-scan';
    if (event.type === 'preview') replayContext.previewId = event.previewId || current.previewId || 'replayed-preview';
    if (event.type === 'contract') {
      replayContext.contractId = event.contractId || current.contractId;
      replayContext.contractHash = event.contractHash || current.contractHash;
      replayContext.autonomy = event.autonomy || current.autonomy;
    }
    const result = transitionMission(current, event.type, replayContext);
    if (!result.ok || result.mission.state !== event.to) return error('EVENT_TAMPERED', 'Event cannot be reproduced');
    current = result.mission;
  }
  return { ok: true, mission: current };
}
