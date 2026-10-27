import { randomBytes } from 'node:crypto';

export class ConfirmationStore {
  #items = new Map();

  issue({ actionId, actor, contractHash, now = new Date().toISOString(), ttlMs = 60_000 }) {
    const token = randomBytes(18).toString('hex');
    this.#items.set(token, { actionId, actorId: actor.actorId, resolvedModel: actor.resolvedModel, contractHash, expiresAt: Date.parse(now) + ttlMs });
    return { token, actionId, expiresAt: new Date(Date.parse(now) + ttlMs).toISOString() };
  }

  consume(token, { actionId, actor, contractHash, now = new Date().toISOString() }) {
    const item = this.#items.get(token);
    if (!item) return { status: 'blocked', code: 'CONFIRMATION_REPLAY' };
    if (item.actionId !== actionId || item.actorId !== actor.actorId || item.resolvedModel !== actor.resolvedModel || item.contractHash !== contractHash) {
      return { status: 'blocked', code: 'CONFIRMATION_BINDING_MISMATCH' };
    }
    if (Date.parse(now) >= item.expiresAt) { this.#items.delete(token); return { status: 'blocked', code: 'CONFIRMATION_EXPIRED' }; }
    this.#items.delete(token);
    return { status: 'confirmed', code: 'CONFIRMED' };
  }
}
