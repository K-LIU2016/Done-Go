import { ConfirmationStore } from './confirmation.mjs';
import { AuditLog } from './audit.mjs';
import { evaluateAction } from './policy.mjs';
import { normalizeActor, errorResult } from './types.mjs';

export class AutonomyRuntime {
  constructor({ audit = new AuditLog(), phase = 'P0', confirmations = new ConfirmationStore() } = {}) {
    this.audit = audit;
    this.phase = phase;
    this.confirmations = confirmations;
    this.results = new Map();
  }

  decide(input) {
    return evaluateAction(input, { phase: this.phase });
  }

  confirm(input) {
    const decision = this.decide(input);
    if (decision.status !== 'needs_confirmation') {
      const error = new Error('CONFIRMATION_NOT_REQUIRED');
      error.code = 'CONFIRMATION_NOT_REQUIRED';
      throw error;
    }
    const actor = normalizeActor(input.action.actor);
    return this.confirmations.issue({
      actionId: input.action.id,
      actor,
      contractHash: input.contract.hash,
      actionHash: input.action.hash ?? input.action.id,
    });
  }

  async perform(input, executor = async () => ({ dryRun: true })) {
    const key = input?.idempotencyKey ?? input?.action?.id;
    if (!key) return this.record(key ?? '__invalid__', errorResult('blocked', 'CONTEXT_INVALID'), input ?? {});
    if (this.results.has(key) && this.results.get(key).status !== 'needs_confirmation') return this.results.get(key);
    let decision = this.decide(input);
    if (decision.status === 'needs_confirmation') {
      if (!input.confirmationToken) return this.record(key, decision, input, 'policy');
      const confirmation = this.confirmations.consume(input.confirmationToken, {
        actionId: input.action.id,
        actor: normalizeActor(input.action.actor),
        contractHash: input.contract.hash,
        actionHash: input.action.hash ?? input.action.id,
      });
      try {
        await this.audit.append({
          type: confirmation.status === 'confirmed'
            ? 'autonomy.confirmation.consumed'
            : 'autonomy.confirmation.rejected',
          actionId: input.action.id,
          ownerId: input.action.ownerId,
          actor: input.action.actor,
          code: confirmation.code,
          status: confirmation.status,
        });
      } catch (error) {
        return this.store(key, errorResult('blocked', error.code));
      }
      if (confirmation.status !== 'confirmed') return this.record(key, confirmation, input, 'policy');
      decision = { status: 'allowed', code: 'ALLOWED', requiresConfirmation: false };
    }
    if (decision.status !== 'allowed') return this.record(key, decision, input, decision.status === 'UNKNOWN' ? 'unknown' : 'policy');
    try {
      await this.audit.append({
        type: 'autonomy.action.allowed', actionId: input.action.id, ownerId: input.action.ownerId,
        actor: input.action.actor, status: 'allowed', code: decision.code,
      });
    } catch (error) { return this.store(key, errorResult('blocked', error.code)); }
    try {
      const output = await executor();
      const result = { status: 'succeeded', code: 'SUCCEEDED', output };
      try {
        await this.audit.append({
          type: 'autonomy.action.result', actionId: input.action.id, ownerId: input.action.ownerId,
          actor: input.action.actor, status: result.status, code: result.code,
        });
      } catch (error) {
        return this.store(key, errorResult('UNKNOWN', 'AUDIT_WRITE_FAILED'));
      }
      return this.store(key, result);
    } catch (error) {
      const result = error.unknown ? errorResult('UNKNOWN', 'EXTERNAL_RESULT_UNKNOWN') : errorResult('blocked', 'EXECUTION_FAILED');
      try {
        await this.audit.append({
          type: error.unknown ? 'autonomy.action.unknown' : 'autonomy.action.result',
          actionId: input.action.id, ownerId: input.action.ownerId, actor: input.action.actor,
          status: result.status, code: result.code,
        });
      } catch { /* preserve the original fail-closed result */ }
      return this.store(key, result);
    }
  }

  async record(key, result, input, kind = 'decision') {
    try {
      const type = kind === 'unknown' ? 'autonomy.action.unknown' : 'autonomy.policy.denied';
      await this.audit.append({
        type, actionId: input.action?.id, ownerId: input.action?.ownerId,
        actor: input.action?.actor, status: result.status, code: result.code,
      });
    } catch (error) {
      result = errorResult('blocked', error.code);
    }
    return this.store(key, result);
  }

  store(key, result) {
    this.results.set(key, result);
    return result;
  }

  async recover(key, executor) {
    const prior = this.results.get(key);
    if (prior?.status === 'UNKNOWN') {
      try { await this.audit.recovery({ actionId: executor.input?.action?.id, decision: 'not_retried', status: 'UNKNOWN' }); } catch { /* fail closed */ }
      return prior;
    }
    if (prior) return prior;
    return this.perform({ idempotencyKey: key, ...executor.input }, executor);
  }
}

export function createAutonomyRoutes({ runtime = new AutonomyRuntime(), executor = async () => ({ dryRun: true }) } = {}) {
  return async function route({ method, pathname, body } = {}) {
    const routes = {
      '/api/autonomy/decide': 'decide',
      '/api/autonomy/confirm': 'confirm',
      '/api/autonomy/execute': 'perform',
      '/api/autonomy/recover': 'recover',
    };
    if (method !== 'POST' || !routes[pathname]) return { status: 404, body: { code: 'NOT_FOUND' } };
    try {
      const operation = routes[pathname];
      const result = operation === 'decide'
        ? runtime.decide(body)
        : operation === 'confirm'
          ? runtime.confirm(body)
          : operation === 'recover'
            ? await runtime.recover(body.idempotencyKey, Object.assign(executor, { input: body }))
            : await runtime.perform(body, executor);
      if (operation === 'confirm') {
        await runtime.audit.append({
          type: 'autonomy.confirmation.issued',
          actionId: body.action.id,
          ownerId: body.action.ownerId,
          actor: body.action.actor,
          contractHash: body.contract.hash,
          status: 'issued',
        });
      }
      return { status: result.code === 'CONTEXT_INVALID' ? 400 : 200, body: result };
    } catch (error) {
      const code = error.code ?? 'AUTONOMY_ROUTE_FAILED';
      return { status: 400, body: errorResult('blocked', code) };
    }
  };
}
