import { counterProposeAgreement, createAgreementRequest, respondToAgreementRequest, withdrawAgreementRequest } from "../agreementModel.ts";
import { fail, ok } from "../store.ts";
import type { Handler } from "../store.ts";
import type { CommandType, CreateAgreementRequestCommand, CounterProposeAgreementCommand, RespondAgreementRequestCommand, WithdrawAgreementRequestCommand } from "../types.ts";
import { finish, requireRevision, requireUser } from "./shared.ts";

function modelFailure(error: unknown) {
  return fail("INVALID_TRANSITION", error instanceof Error ? error.message : String(error), false);
}

function currentRequest(state: Parameters<Handler>[0], entityId: string | null) {
  return entityId ? state.agreementRequests[entityId] : undefined;
}

export const agreementHandlers: Partial<Record<CommandType, Handler>> = {
  createAgreementRequest: (state, command, ctx) => {
    const c = command as CreateAgreementRequestCommand;
    const userFailure = requireUser(c.actor, "createAgreementRequest");
    if (userFailure) return userFailure;
    if (c.entityId !== null || c.expectedRevision !== null || !c.requestId.trim()) return fail("INVALID_INPUT", "Creating an agreement requires a new request ID", false);
    if (state.agreementRequests[c.requestId]) return ok(null, { request: state.agreementRequests[c.requestId] });
    try {
      const request = createAgreementRequest({ id: c.requestId, proposerId: c.proposerId, recipientId: c.recipientId, terms: c.terms, expiresAt: c.expiresAt, now: ctx.now });
      const nextState = finish(state, { agreementRequests: { ...state.agreementRequests, [request.id]: request } }, [{ entityId: request.id, before: 0, after: request.revision }], { eventId: ctx.uuid(), type: "agreement.request.created", commandId: c.commandId, actor: c.actor, at: ctx.now, summary: "agreement request created" });
      return ok(nextState, { request });
    } catch (error) {
      return modelFailure(error);
    }
  },

  respondAgreementRequest: (state, command, ctx) => {
    const c = command as RespondAgreementRequestCommand;
    const userFailure = requireUser(c.actor, "respondAgreementRequest");
    if (userFailure) return userFailure;
    const request = currentRequest(state, c.entityId);
    if (!request) return fail("ENTITY_NOT_FOUND", "agreement request not found: " + String(c.entityId), false);
    const revisionFailure = requireRevision(request.revision, c.expectedRevision);
    if (revisionFailure) return revisionFailure;
    try {
      const updated = respondToAgreementRequest(request, { actorId: c.actorId, termsVersion: c.termsVersion, termsHash: c.termsHash, response: c.response, reasonCode: c.reasonCode, now: ctx.now });
      const nextState = finish(state, { agreementRequests: { ...state.agreementRequests, [updated.id]: updated } }, [{ entityId: updated.id, before: request.revision, after: updated.revision }], { eventId: ctx.uuid(), type: "agreement.request.responded", commandId: c.commandId, actor: c.actor, at: ctx.now, summary: "agreement request response recorded" });
      return ok(nextState, { request: updated, agreementFormed: updated.agreement !== null });
    } catch (error) {
      return modelFailure(error);
    }
  },

  counterProposeAgreement: (state, command, ctx) => {
    const c = command as CounterProposeAgreementCommand;
    const userFailure = requireUser(c.actor, "counterProposeAgreement");
    if (userFailure) return userFailure;
    const request = currentRequest(state, c.entityId);
    if (!request) return fail("ENTITY_NOT_FOUND", "agreement request not found: " + String(c.entityId), false);
    const revisionFailure = requireRevision(request.revision, c.expectedRevision);
    if (revisionFailure) return revisionFailure;
    try {
      const updated = counterProposeAgreement(request, { actorId: c.actorId, terms: c.terms, now: ctx.now });
      const nextState = finish(state, { agreementRequests: { ...state.agreementRequests, [updated.id]: updated } }, [{ entityId: updated.id, before: request.revision, after: updated.revision }], { eventId: ctx.uuid(), type: "agreement.request.countered", commandId: c.commandId, actor: c.actor, at: ctx.now, summary: "agreement request counter-proposed" });
      return ok(nextState, { request: updated });
    } catch (error) {
      return modelFailure(error);
    }
  },

  withdrawAgreementRequest: (state, command, ctx) => {
    const c = command as WithdrawAgreementRequestCommand;
    const userFailure = requireUser(c.actor, "withdrawAgreementRequest");
    if (userFailure) return userFailure;
    const request = currentRequest(state, c.entityId);
    if (!request) return fail("ENTITY_NOT_FOUND", "agreement request not found: " + String(c.entityId), false);
    const revisionFailure = requireRevision(request.revision, c.expectedRevision);
    if (revisionFailure) return revisionFailure;
    try {
      const updated = withdrawAgreementRequest(request, { actorId: c.actorId, now: ctx.now });
      const nextState = finish(state, { agreementRequests: { ...state.agreementRequests, [updated.id]: updated } }, [{ entityId: updated.id, before: request.revision, after: updated.revision }], { eventId: ctx.uuid(), type: "agreement.request.withdrawn", commandId: c.commandId, actor: c.actor, at: ctx.now, summary: "agreement request withdrawn" });
      return ok(nextState, { request: updated });
    } catch (error) {
      return modelFailure(error);
    }
  },
};
