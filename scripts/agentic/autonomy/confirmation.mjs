import { randomBytes } from 'node:crypto';

import { normalizeActor, fail } from './types.mjs';

const validText = (value) => typeof value === 'string' && value.length > 0;
const timestamp = (value) => {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) fail('CONFIRMATION_INPUT_INVALID');
  return parsed;
};

export class ConfirmationStore {
  #items = new Map();

  issue({ actionId, actor, contractHash, actionHash, now = new Date().toISOString(), ttlMs = 60_000 } = {}) {
    if (!validText(actionId) || !validText(contractHash)) fail('CONFIRMATION_INPUT_INVALID');
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) fail('CONFIRMATION_TTL_INVALID');
    const normalizedActor = normalizeActor(actor);
    if (normalizedActor.status === 'UNKNOWN') fail('ACTOR_MODEL_UNKNOWN');
    const issuedAt = timestamp(now);
    const expiresAt = issuedAt + ttlMs;
    const token = randomBytes(18).toString('hex');
    this.#items.set(token, {
      actionId,
      actionHash: actionHash ?? null,
      actorId: normalizedActor.actorId,
      resolvedModel: normalizedActor.resolvedModel,
      contractHash,
      expiresAt,
    });
    return { token, actionId, expiresAt: new Date(expiresAt).toISOString() };
  }

  consume(token, { actionId, actor, contractHash, actionHash, now = new Date().toISOString() } = {}) {
    const item = this.#items.get(token);
    if (!item) return { status: 'blocked', code: 'CONFIRMATION_REPLAY' };
    let currentActor;
    try {
      currentActor = normalizeActor(actor);
      timestamp(now);
    } catch {
      return { status: 'blocked', code: 'CONFIRMATION_BINDING_MISMATCH' };
    }
    if (item.actionId !== actionId
      || (item.actionHash ?? null) !== (actionHash ?? null)
      || item.actorId !== currentActor.actorId
      || item.resolvedModel !== currentActor.resolvedModel
      || item.contractHash !== contractHash) {
      return { status: 'blocked', code: 'CONFIRMATION_BINDING_MISMATCH' };
    }
    if (timestamp(now) >= item.expiresAt) {
      this.#items.delete(token);
      return { status: 'blocked', code: 'CONFIRMATION_EXPIRED' };
    }
    this.#items.delete(token);
    return { status: 'confirmed', code: 'CONFIRMED' };
  }
}
