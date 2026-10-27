import { AuditLog } from './audit.mjs';
import {
  AUTONOMY_LEVELS,
  isP0Forbidden,
  normalizeAction,
  normalizeActor,
} from './types.mjs';

const level = (value) => AUTONOMY_LEVELS.indexOf(value);
const humanResult = () => ({ status: 'needs_human', code: 'NEED_HUMAN', requiresHuman: true });
const blockedResult = (code, status = 'blocked') => ({ status, code, requiresHuman: false });
const actorFor = (action) => action?.actor === undefined ? undefined : normalizeActor(action.actor);

export function evaluateSideEffect({ risk, requestedAutonomy, actor } = {}, { phase = 'P0' } = {}) {
  try {
    if (actor !== undefined) {
      const normalizedActor = normalizeActor(actor);
      if (normalizedActor.status === 'UNKNOWN') return blockedResult(normalizedActor.code, 'UNKNOWN');
    }
    normalizeAction({ risk, requestedAutonomy });
  } catch (error) {
    return blockedResult(error.code ?? 'AUTONOMY_ACTION_INVALID');
  }

  if (requestedAutonomy === 'A5' || risk === 'financial') return blockedResult('A5_NEVER_AUTOMATIC');
  if (level(requestedAutonomy) < 2 && !['observe', 'suggest'].includes(risk)) {
    return blockedResult('AUTONOMY_TOO_LOW');
  }
  if (phase === 'P0' && isP0Forbidden({ risk, requestedAutonomy })) {
    return blockedResult('P0_EXTERNAL_EFFECT_BLOCKED');
  }
  if (risk === 'external' || requestedAutonomy === 'A4') return humanResult();
  if (level(requestedAutonomy) < 0) return blockedResult('AUTONOMY_LEVEL_INVALID');
  return { status: 'allowed', code: 'ALLOWED', requiresHuman: false };
}

export class SideEffectFence {
  constructor({ audit, phase = 'P0', clock = () => new Date() } = {}) {
    this.clock = clock;
    this.audit = audit ?? new AuditLog({ clock });
    this.audit.clock = clock;
    this.phase = phase;
  }

  async check(input) {
    const action = input?.action ?? input ?? {};
    let actor;
    try {
      if (action.actor === undefined) return this.#record(action, blockedResult('ACTOR_INVALID'), null);
      actor = normalizeActor(action.actor);
    } catch (error) {
      return this.#record(action, blockedResult(error.code ?? 'ACTOR_INVALID'), null);
    }
    const result = evaluateSideEffect(action, { phase: this.phase });
    return this.#record(action, result, actor);
  }

  async execute(input, executor) {
    const decision = await this.check(input);
    if (decision.status !== 'allowed') return decision;
    const action = input.action ?? input;
    let actor;
    try { actor = normalizeActor(action.actor); } catch (error) { return blockedResult(error.code ?? 'ACTOR_INVALID'); }
    try {
      const output = await executor();
      const result = { status: 'succeeded', code: 'SUCCEEDED', requiresHuman: false, output };
      const recorded = await this.#record(action, result, actor);
      if (recorded.code === 'AUDIT_WRITE_FAILED') return recorded;
      return result;
    } catch (error) {
      const result = error?.unknown
        ? blockedResult('EXTERNAL_RESULT_UNKNOWN', 'UNKNOWN')
        : blockedResult('EXECUTION_FAILED');
      const recorded = await this.#record(action, result, actor);
      return recorded.code === 'AUDIT_WRITE_FAILED' ? recorded : result;
    }
  }

  async #record(action, result, actor) {
    try {
      await this.audit.append({
        type: 'autonomy.side_effect_fence',
        actionId: action?.id ?? null,
        decision: result.status,
        code: result.code,
        actorId: actor?.actorId ?? null,
        resolvedModel: actor?.resolvedModel ?? null,
      });
      return result;
    } catch (error) {
      return { status: 'blocked', code: error.code ?? 'AUDIT_WRITE_FAILED', requiresHuman: false };
    }
  }
}
