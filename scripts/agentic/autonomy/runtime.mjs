import { ConfirmationStore } from './confirmation.mjs';
import { evaluateAction } from './policy.mjs';
import { normalizeActor, errorResult } from './types.mjs';

export class AutonomyRuntime {
  constructor({ audit, phase = 'P0', confirmations = new ConfirmationStore() } = {}) {
    this.audit = audit;
    this.phase = phase;
    this.confirmations = confirmations;
    this.results = new Map();
  }

  async confirm(input) {
    const decision = evaluateAction(input, { phase: this.phase });
    if (decision.status !== 'needs_confirmation') {
      const error = new Error('CONFIRMATION_NOT_REQUIRED');
      error.code = 'CONFIRMATION_NOT_REQUIRED';
      throw error;
    }
    const actor = normalizeActor(input.action.actor);
    const confirmation = this.confirmations.issue({
      actionId: input.action.id,
      actor,
      contractHash: input.contract.hash,
      actionHash: input.action.hash ?? input.action.id,
    });
    try {
      await this.audit.confirmationIssued({
        actionId: input.action.id,
        ownerId: input.action.ownerId,
        actor,
        contractHash: input.contract.hash,
      });
    } catch (error) {
      return errorResult('blocked', error.code);
    }
    return confirmation;
  }

  async perform(input, executor) {
    const key = input.idempotencyKey ?? input.action.id;
    if (this.results.has(key) && this.results.get(key).status !== 'needs_confirmation') return this.results.get(key);
    let decision = evaluateAction(input, { phase: this.phase });
    if (decision.status === 'needs_confirmation') {
      if (!input.confirmationToken) return this.record(key, decision, input);
      const confirmation = this.confirmations.consume(input.confirmationToken, {
        actionId: input.action.id,
        actor: normalizeActor(input.action.actor),
        contractHash: input.contract.hash,
        actionHash: input.action.hash ?? input.action.id,
      });
      if (confirmation.status !== 'confirmed') return this.record(key, confirmation, input);
      decision = { status: 'allowed', code: 'ALLOWED', requiresConfirmation: false };
    }
    if (decision.status !== 'allowed') return this.record(key, decision, input);
    try { await this.audit.append({ type: 'autonomy.action.allowed', actionId: input.action.id, actor: input.action.actor }); }
    catch (error) { return this.record(key, errorResult('blocked', error.code), input); }
    try {
      const output = await executor();
      const result = { status: 'succeeded', code: 'SUCCEEDED', output };
      return this.record(key, result, input);
    } catch (error) {
      const result = error.unknown ? errorResult('UNKNOWN', 'EXTERNAL_RESULT_UNKNOWN') : errorResult('blocked', 'EXECUTION_FAILED');
      try { await this.audit.append({ type: 'autonomy.action.result', actionId: input.action.id, result: result.status }); } catch { /* preserve original fail-closed result */ }
      return this.record(key, result, input);
    }
  }

  record(key, result, input) {
    this.results.set(key, result);
    this.audit.append({ type: 'autonomy.decision', actionId: input.action.id, result: result.status, code: result.code }).catch(() => {});
    return result;
  }

  async recover(key, executor) {
    const prior = this.results.get(key);
    if (prior?.status === 'UNKNOWN') return prior;
    if (prior) return prior;
    return this.perform({ idempotencyKey: key, ...executor.input }, executor);
  }
}

export function createAutonomyRoutes({ runtime }) {
  return async function route({ method, pathname, body }) {
    if (method !== 'POST' || pathname !== '/api/autonomy/decide') return { status: 404, body: { code: 'NOT_FOUND' } };
    const result = await runtime.perform(body, async () => ({ dryRun: true }));
    return { status: 200, body: result };
  };
}
