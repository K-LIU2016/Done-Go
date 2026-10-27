import { ConfirmationStore } from './confirmation.mjs';
import { AuditLog } from './audit.mjs';
import { evaluateAction } from './policy.mjs';
import { normalizeActor, errorResult } from './types.mjs';
import { requestIdentity } from './identity.mjs';

export class AutonomyRuntime {
  constructor({ audit, phase = 'P0', confirmations, clock = () => new Date() } = {}) {
    this.audit = audit ?? new AuditLog({ clock });
    this.audit.clock = clock;
    this.phase = phase;
    this.clock = clock;
    this.confirmations = confirmations ?? new ConfirmationStore({ clock });
    this.confirmations.clock = clock;
    this.results = new Map();
    this.inFlight = new Map();
    this.inFlightFingerprints = new Map();
  }

  decide(input) {
    return evaluateAction(input, { phase: this.phase, clock: this.clock });
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
      action: input.action,
      contractHash: input.contract.hash,
      actionHash: input.action.hash ?? input.action.id,
      now: this.clock(),
    });
  }

  async #performUnlocked(input, executor = async () => ({ dryRun: true })) {
    const key = input?.idempotencyKey ?? input?.action?.id;
    if (!key) return this.record(key ?? '__invalid__', errorResult('blocked', 'CONTEXT_INVALID'), input ?? {});
    const fingerprint = requestIdentity(input);
    const prior = this.results.get(key);
    if (prior && prior.fingerprint !== fingerprint) {
      try {
        await this.audit.append({ type: 'autonomy.policy.denied', actionId: input.action?.id, ownerId: input.action?.ownerId, actor: input.action?.actor, status: 'blocked', code: 'IDEMPOTENCY_KEY_CONFLICT' });
      } catch (error) {
        return errorResult('blocked', error.code ?? 'AUDIT_WRITE_FAILED');
      }
      return errorResult('blocked', 'IDEMPOTENCY_KEY_CONFLICT');
    }
    if (prior && prior.result.status !== 'needs_confirmation') return prior.result;
    let decision = this.decide(input);
    if (decision.status === 'needs_confirmation') {
      if (!input.confirmationToken) return this.record(key, decision, input, 'policy', fingerprint);
      const confirmation = this.confirmations.consume(input.confirmationToken, {
        actionId: input.action.id,
        actor: normalizeActor(input.action.actor),
        action: input.action,
        contractHash: input.contract.hash,
        actionHash: input.action.hash ?? input.action.id,
        now: this.clock(),
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
        return this.store(key, errorResult('blocked', error.code), fingerprint);
      }
      if (confirmation.status !== 'confirmed') return this.record(key, confirmation, input, 'policy', fingerprint);
      decision = { status: 'allowed', code: 'ALLOWED', requiresConfirmation: false };
    }
    if (decision.status !== 'allowed') return this.record(key, decision, input, decision.status === 'UNKNOWN' ? 'unknown' : 'policy', fingerprint);
    try {
      await this.audit.append({
        type: 'autonomy.action.allowed', actionId: input.action.id, ownerId: input.action.ownerId,
        actor: input.action.actor, status: 'allowed', code: decision.code,
      });
    } catch (error) { return this.store(key, errorResult('blocked', error.code), fingerprint); }
    try {
      const output = await executor();
      const result = { status: 'succeeded', code: 'SUCCEEDED', output };
      try {
        await this.audit.append({
          type: 'autonomy.action.result', actionId: input.action.id, ownerId: input.action.ownerId,
          actor: input.action.actor, status: result.status, code: result.code,
        });
      } catch (error) {
        return this.store(key, errorResult('UNKNOWN', error.code ?? 'AUDIT_WRITE_FAILED'), fingerprint);
      }
      return this.store(key, result, fingerprint);
    } catch (error) {
      const result = error.unknown ? errorResult('UNKNOWN', 'EXTERNAL_RESULT_UNKNOWN') : errorResult('blocked', 'EXECUTION_FAILED');
      try {
        await this.audit.append({
          type: error.unknown ? 'autonomy.action.unknown' : 'autonomy.action.result',
          actionId: input.action.id, ownerId: input.action.ownerId, actor: input.action.actor,
          status: result.status, code: result.code,
        });
      } catch (auditError) {
        return this.store(key, errorResult('UNKNOWN', auditError.code ?? 'AUDIT_WRITE_FAILED'), fingerprint);
      }
      return this.store(key, result, fingerprint);
    }
  }

  async perform(input, executor = async () => ({ dryRun: true })) {
    const key = input?.idempotencyKey ?? input?.action?.id;
    if (!key) return this.#performUnlocked(input, executor);
    const fingerprint = requestIdentity(input);
    const inFlight = this.inFlight.get(key);
    if (inFlight) {
      return this.inFlightFingerprints.get(key) === fingerprint
        ? inFlight
        : errorResult('blocked', 'IDEMPOTENCY_KEY_CONFLICT');
    }
    const work = this.#performUnlocked(input, executor);
    this.inFlightFingerprints.set(key, fingerprint);
    this.inFlight.set(key, work);
    try {
      return await work;
    } finally {
      this.inFlight.delete(key);
      this.inFlightFingerprints.delete(key);
    }
  }

  async record(key, result, input, kind = 'decision', fingerprint = requestIdentity(input)) {
    try {
      const type = kind === 'unknown' ? 'autonomy.action.unknown' : 'autonomy.policy.denied';
      await this.audit.append({
        type, actionId: input.action?.id, ownerId: input.action?.ownerId,
        actor: input.action?.actor, status: result.status, code: result.code,
      });
    } catch (error) {
      result = errorResult('blocked', error.code);
    }
    return this.store(key, result, fingerprint);
  }

  store(key, result, fingerprint = null) {
    this.results.set(key, { fingerprint, result });
    return result;
  }

  async recover(input, executor = async () => ({ dryRun: true })) {
    const request = typeof input === 'string' ? { idempotencyKey: input } : input;
    const key = request?.idempotencyKey;
    if (!key) return errorResult('blocked', 'CONTEXT_INVALID');
    const prior = this.results.get(key);
    const requestFingerprint = requestIdentity(request);
    if (this.inFlight.get(key)) {
      return this.inFlightFingerprints.get(key) === requestFingerprint
        ? this.inFlight.get(key)
        : errorResult('blocked', 'IDEMPOTENCY_KEY_CONFLICT');
    }
    if (prior && typeof input !== 'string' && prior.fingerprint !== requestFingerprint) return errorResult('blocked', 'IDEMPOTENCY_KEY_CONFLICT');
    if (prior?.result?.status === 'UNKNOWN') {
      try {
        await this.audit.recovery({ actionId: request.action?.id, ownerId: request.action?.ownerId, decision: 'not_retried', status: 'UNKNOWN' });
      } catch (error) {
        return this.store(key, errorResult('UNKNOWN', error.code ?? 'AUDIT_WRITE_FAILED'), prior.fingerprint);
      }
      return prior.result;
    }
    if (prior) return prior.result;
    return this.perform(request, executor);
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
            ? await runtime.recover(body, executor)
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
