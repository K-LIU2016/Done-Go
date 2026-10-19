import { computeChangeSetHash } from "../hash.ts";
import { executableActionIds } from "../approvalScope.ts";
import { FIXTURE_IDS } from "../ids.ts";
import { fail, ok } from "../store.ts";
import type { Handler, HandlerCtx, HandlerSuccess } from "../store.ts";
import type {
  Approval,
  ChangeSet,
  CommandType,
  Commitment,
  DomainState,
  Draft,
  DraftSection,
  EntityId,
  LedgerEntry,
  ObjectDiff,
  Operation,
  Plan,
  PlanAction,
  PlanKind,
  ReadbackItem,
  Source,
  SourceProvider,
  SourceSnapshot,
  StepReceipt,
  TimeRange,
} from "../types.ts";
import { bump, finish, lookupEntity, requireRevision, requireUser } from "./shared.ts";

function derivedBase(state: DomainState, ctx: HandlerCtx) {
  return {
    id: ctx.uuid(),
    revision: 1,
    createdAt: ctx.now,
    updatedAt: ctx.now,
    dataMode: state.dataMode,
    provenance: { origin: "derived" as const },
  };
}

function activeFlexibleCommitments(commitments: Commitment[]): Commitment[] {
  return commitments
    .filter((c) => c.status === "active" && c.mobility === "flexible" && c.effortEstimateMinutes !== null)
    .sort((a, b) => (b.effortEstimateMinutes ?? 0) - (a.effortEstimateMinutes ?? 0));
}

function activePlannedMinutes(state: DomainState): number {
  return Object.values(state.commitments).filter((commitment) => commitment.status === "active")
    .reduce((sum, commitment) => sum + (commitment.effortEstimateMinutes ?? 0), 0);
}

function minuteOfClock(value: string | null): number | null {
  if (!value || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) return null;
  return Number(value.slice(0, 2)) * 60 + Number(value.slice(3, 5));
}

function localIntervalMatches(range: TimeRange, target: Commitment, date: string, match: "contains" | "overlaps"): boolean {
  const schedule = target.schedule;
  if (!schedule || schedule.startMinute === null || schedule.endMinute === null) return false;
  const formatter = new Intl.DateTimeFormat("en-CA", { timeZone: schedule.timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const localKey = (stamp: string) => {
    if (!Number.isFinite(Date.parse(stamp))) return null;
    const parts = formatter.formatToParts(new Date(stamp));
    const part = (type: string) => parts.find((entry) => entry.type === type)?.value ?? "";
    return part("year") + "-" + part("month") + "-" + part("day") + "T" + part("hour") + ":" + part("minute");
  };
  const key = (minute: number) => date + "T" + String(Math.floor(minute / 60)).padStart(2, "0") + ":" + String(minute % 60).padStart(2, "0");
  const start = localKey(range.start);
  const end = localKey(range.end);
  return start !== null && end !== null && (match === "contains"
    ? start <= key(schedule.startMinute) && end >= key(schedule.endMinute)
    : start < key(schedule.endMinute) && end > key(schedule.startMinute));
}

function localRescheduleFailure(state: DomainState, target: Commitment, date: string): string | null {
  if (Object.values(state.protectedBlocks).some((block) => block.status === "active" && localIntervalMatches(block.range, target, date, "overlaps"))) {
    return "延期目标与本地保护时段冲突；不能自动占用静驻。";
  }
  const localOnly = state.contextReview.localOnly;
  if (!localOnly?.enabled) return null;
  const known = state.ruleset.grants.readMaterial && Object.values(state.sources).some((source) =>
    source.status === "connected" && source.accessRevokedAt === null && source.coverage.known &&
    source.lastUsableSnapshot !== null && !source.lastUsableSnapshot.stale &&
    source.lastSuccessAt !== null && Date.parse(source.lastSuccessAt) >= Date.parse(localOnly.changedAt) &&
    source.coverage.intervals.some((range) => localIntervalMatches(range, target, date, "contains")));
  return known ? null : "仅本地模式：延期目标时段的外部覆盖未知；请先重新检查来源，不能自动分配该时段。";
}

function addDaysIso(date: string, days: number): string {
  const d = new Date(date + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function connectedSourceVersions(state: DomainState): Record<EntityId, number> {
  const out: Record<EntityId, number> = {};
  for (const s of Object.values(state.sources)) {
    if (s.status === "connected" && s.lastUsableSnapshot) out[s.id] = s.sourceVersion;
  }
  return out;
}

function buildPlanActions(
  kind: PlanKind,
  target: Commitment,
  deferToDate: string | null,
  sourceId: EntityId,
): { actions: PlanAction[]; diffs: ObjectDiff[]; futureDebtMinutes: number; reducedEstimateTo: number | null } {
  if (kind === "A") {
    const from = target.effortEstimateMinutes ?? 0;
    const to = 40;
    const readMaterial: PlanAction = {
      id: "act-" + target.id + "-read",
      kind: "readMaterial",
      dependsOn: [],
      requiredGrant: "readMaterial",
      targetId: null,
      params: { sourceId },
      diffs: [],
      exclusions: [],
    };
    const createDraft: PlanAction = {
      id: "act-" + target.id + "-draft",
      kind: "createDraft",
      dependsOn: [readMaterial.id],
      requiredGrant: "createLocalDraft",
      targetId: null,
      params: { commitmentId: target.id },
      diffs: [],
      exclusions: [],
    };
    const updateEstimate: PlanAction = {
      id: "act-" + target.id + "-estimate",
      kind: "updateEstimate",
      dependsOn: [],
      requiredGrant: "updateEstimate",
      targetId: target.id,
      params: { from, to },
      diffs: [],
      exclusions: [],
    };
    return {
      actions: [readMaterial, createDraft, updateEstimate],
      diffs: [
        {
          objectId: target.id,
          displayName: target.scope ?? "commitment " + target.id,
          field: "effortEstimateMinutes",
          before: from,
          after: to,
          sourceRefs: [sourceId],
        },
      ],
      futureDebtMinutes: 0,
      reducedEstimateTo: to,
    };
  }
  const deferCommitment: PlanAction = {
    id: "act-" + target.id + "-defer",
    kind: "deferCommitment",
    dependsOn: [],
    requiredGrant: "internalReschedule",
    targetId: target.id,
    params: { fromDate: target.schedule?.date ?? null, toDate: deferToDate, minutes: target.effortEstimateMinutes },
    diffs: [],
    exclusions: [],
  };
  return {
    actions: [deferCommitment],
      diffs: [
        {
          objectId: target.id,
          displayName: target.scope ?? "commitment " + target.id,
        field: "schedule.date",
        before: target.schedule?.date ?? null,
        after: deferToDate,
        sourceRefs: [sourceId],
      },
    ],
    futureDebtMinutes: target.effortEstimateMinutes ?? 0,
    reducedEstimateTo: null,
  };
}

export const planHandlers: Partial<Record<CommandType, Handler>> = {
  selectPlan: (state, command, ctx) => {
    const c = command as Extract<Parameters<Handler>[1], { type: "selectPlan" }>;
    const userFail = requireUser(c.actor, "selectPlan");
    if (userFail) return userFail;
    if (c.entityId === null) {
      return fail("INVALID_INPUT", "selectPlan requires entityId of a saved intent", false);
    }
    if (c.expectedRevision === null) {
      return fail("INVALID_INPUT", "selectPlan requires expectedRevision of the intent", false);
    }
    const intentLookup = lookupEntity(state.intents, c.entityId, "intent");
    if (intentLookup.failure) return intentLookup.failure;
    const intentRevisionFail = requireRevision(intentLookup.entity.revision, c.expectedRevision);
    if (intentRevisionFail) return intentRevisionFail;
    if (intentLookup.entity.status !== "saved") {
      return fail("INVALID_TRANSITION", "selectPlan requires a saved intent, current status is " + intentLookup.entity.status, false);
    }
    const intent = intentLookup.entity;
    const { date, timezone, startTime, endTime } = intent.parsedFields;
    const startMinute = minuteOfClock(startTime);
    const endMinute = minuteOfClock(endTime);
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date + "T00:00:00Z")) ||
        new Date(date + "T00:00:00Z").toISOString().slice(0, 10) !== date || !timezone ||
        startMinute === null || endMinute === null || endMinute <= startMinute) {
      return fail("INVALID_INPUT", "请先确认意图的有效日期、时区与起止时间，再准备方案。", false);
    }
    try { new Intl.DateTimeFormat("en", { timeZone: timezone }); }
    catch { return fail("INVALID_INPUT", "意图时区无效，请先修正后再准备方案。", false); }
    if (intent.constraints.some((constraint) => !constraint.confirmed || !["protect", "quiet"].includes(constraint.kind))) {
      return fail("INVALID_INPUT", "意图包含尚未确认或无法自动执行的约束，请先明确约束后再准备方案。", false);
    }
    const applicable = Object.values(state.commitments).filter((commitment) => commitment.status === "active" &&
      commitment.schedule?.date === date && commitment.schedule.timezone === timezone &&
      (commitment.schedule.startMinute === null || commitment.schedule.startMinute < endMinute));
    if (applicable.some((commitment) => commitment.effortEstimateMinutes === null || !Number.isFinite(commitment.effortEstimateMinutes))) {
      return fail("INVALID_INPUT", "当前意图范围内存在未知预计投入，请先补充估计后再准备方案。", false);
    }
    const flexible = activeFlexibleCommitments(applicable).filter((commitment) =>
      c.kind === "A" ? (commitment.effortEstimateMinutes ?? 0) >= 40 : (commitment.effortEstimateMinutes ?? 0) > 0);
    if (flexible.length === 0) {
      return fail("INVALID_INPUT", "当前意图的日期与时间范围内，没有适用于此方案的可变责任。", false);
    }
    const sourceId = FIXTURE_IDS.sourceCalendar;
    const sourceVersionSet = connectedSourceVersions(state);
    const plannedTotal = applicable.reduce((sum, commitment) => sum + (commitment.effortEstimateMinutes ?? 0), 0);
    const target = c.kind === "A" ? flexible[0] : flexible[flexible.length - 1];
    const deferToDate = c.kind === "B" ? addDaysIso(target.schedule?.date ?? ctx.now.slice(0, 10), 2) : null;
    if (deferToDate) {
      const localFailure = localRescheduleFailure(state, target, deferToDate);
      if (localFailure) return fail("INVALID_INPUT", localFailure, false);
    }
    const { actions, diffs, futureDebtMinutes, reducedEstimateTo } = buildPlanActions(
      c.kind,
      target,
      deferToDate,
      sourceId,
    );
    const capacityAfter = plannedTotal - (reducedEstimateTo === null ? (target.effortEstimateMinutes ?? 0) : (target.effortEstimateMinutes ?? 0) - reducedEstimateTo);
    const plan: Plan = {
      ...derivedBase(state, ctx),
      id: ctx.uuid(),
      intentId: intent.id,
      commitmentId: target.id,
      kind: c.kind,
      constraintRefs: intent.constraints.map((constraint) => constraint.id),
      sourceVersionSet,
      ruleRevision: state.ruleset.revision,
      estimateMinutes: capacityAfter,
      futureDebtMinutes,
      capacityBeforeMinutes: plannedTotal,
      capacityAfterMinutes: capacityAfter,
      status: "pendingApproval",
      invalidReason: null,
      summary: {
        before: plannedTotal + " minutes planned on " + date + " before " + endTime + " (" + timezone + ")",
        after: capacityAfter + " minutes planned",
        futureDebt:
          futureDebtMinutes > 0 ? futureDebtMinutes + " minutes deferred to " + deferToDate : null,
        netSavingClaim: "none",
      },
    };
    const changeSet: ChangeSet = {
      ...derivedBase(state, ctx),
      id: ctx.uuid(),
      planId: plan.id,
      planRevision: plan.revision,
      parentChangeSetId: null,
      label:
        c.kind === "A"
          ? "Plan A: reduce effort of " + (target.scope ?? target.id)
          : "Plan B: defer " + (target.scope ?? target.id),
      actions,
      objectDiffs: diffs,
      requiredGrants: [...new Set(actions.map((a) => a.requiredGrant))],
      exclusions: ["externalCalendarWrite is not granted; no external calendar writes will be performed"],
      targetRevisions: { [intent.id]: intent.revision, [target.id]: target.revision },
      sourceVersionSet,
      ruleRevision: state.ruleset.revision,
      hash: "",
    };
    changeSet.hash = computeChangeSetHash(changeSet);
    const nextState = finish(
      state,
      {
        plans: { ...state.plans, [plan.id]: plan },
        changeSets: { ...state.changeSets, [changeSet.id]: changeSet },
      },
      [
        { entityId: plan.id, before: 0, after: 1 },
        { entityId: changeSet.id, before: 0, after: 1 },
      ],
      {
        eventId: ctx.uuid(),
        type: "plan.selected",
        commandId: c.commandId,
        actor: c.actor,
        at: ctx.now,
        summary: "plan " + c.kind + " selected: " + plan.summary.after,
      },
    );
    return ok(nextState, { plan, changeSet });
  },

  grantApproval: (state, command, ctx) => {
    const c = command as Extract<Parameters<Handler>[1], { type: "grantApproval" }>;
    const userFail = requireUser(c.actor, "grantApproval");
    if (userFail) return userFail;
    const csLookup = lookupEntity(state.changeSets, c.changeSetId, "change set");
    if (csLookup.failure) return csLookup.failure;
    const cs = csLookup.entity;
    const stale = changeSetStaleReason(state, cs);
    if (stale) return fail("CHANGE_SET_STALE", stale, false);
    const plan = state.plans[cs.planId];
    if (!plan) return fail("ENTITY_NOT_FOUND", "plan not found: " + cs.planId, false);
    if (plan.status === "invalid") {
      return fail("APPROVAL_INVALID", "plan is invalid: " + (plan.invalidReason ?? "unknown reason"), false);
    }
    const executable = executableActionIds(cs.actions, c.grants);
    if (executable.size === 0) {
      return fail("NO_EXECUTABLE_ACTIONS", "no change set action is covered by grants " + JSON.stringify(c.grants), false);
    }
    const reduced = executable.size < cs.actions.length;
    let approved = cs;
    if (reduced) {
      const keptActions = cs.actions.filter((a) => executable.has(a.id));
      const keptTargets = new Set(keptActions.map((a) => a.targetId).filter((t): t is EntityId => t !== null));
      approved = {
        ...derivedBase(state, ctx),
        id: ctx.uuid(),
        planId: cs.planId,
        planRevision: cs.planRevision,
        parentChangeSetId: cs.id,
        label: cs.label + " (reduced)",
        actions: keptActions,
        objectDiffs: cs.objectDiffs.filter((d) => keptTargets.has(d.objectId)),
        requiredGrants: [...new Set(keptActions.map((a) => a.requiredGrant))],
        exclusions: [
          ...cs.exclusions,
          "excluded by partial grant: " + cs.actions.filter((a) => !executable.has(a.id)).map((a) => a.kind).join(", "),
        ],
        targetRevisions: Object.fromEntries(Object.entries(cs.targetRevisions).filter(([tid]) => keptTargets.has(tid))),
        sourceVersionSet: cs.sourceVersionSet,
        ruleRevision: cs.ruleRevision,
        hash: "",
      };
      approved.hash = computeChangeSetHash(approved);
    }
    const missingDependencies: string[] = [];
    for (const a of cs.actions) {
      if (executable.has(a.id)) continue;
      if (!c.grants.includes(a.requiredGrant)) {
        missingDependencies.push(a.kind + " requires grant " + a.requiredGrant);
      }
      const missingDeps = a.dependsOn.filter((d) => !executable.has(d));
      if (missingDeps.length > 0) {
        missingDependencies.push(a.kind + " depends on excluded steps: " + missingDeps.join(", "));
      }
    }
    const approvals = { ...state.approvals };
    for (const prev of Object.values(approvals)) {
      if (prev.changeSetId === cs.id && prev.status === "valid") {
        approvals[prev.id] = { ...bump(prev, ctx.now), status: "invalid", invalidReason: "superseded by a newer grant" };
      }
    }
    const approval: Approval = {
      ...derivedBase(state, ctx),
      id: ctx.uuid(),
      changeSetId: approved.id,
      changeSetHash: approved.hash,
      planId: cs.planId,
      planRevision: cs.planRevision,
      sourceVersionSet: approved.sourceVersionSet,
      ruleRevision: approved.ruleRevision,
      grantedActions: [...c.grants],
      status: "valid",
      invalidReason: null,
      consumedByOperationId: null,
      actor: c.actor,
    };
    approvals[approval.id] = approval;
    const patch: Partial<DomainState> = { approvals };
    const changes = [{ entityId: approval.id, before: 0, after: 1 }];
    if (reduced) {
      patch.changeSets = { ...state.changeSets, [approved.id]: approved };
      changes.push({ entityId: approved.id, before: 0, after: 1 });
    }
    const nextState = finish(state, patch, changes, {
      eventId: ctx.uuid(),
      type: "approval.granted",
      commandId: c.commandId,
      actor: c.actor,
      at: ctx.now,
      summary: "approval granted for " + approved.label + (reduced ? " (reduced scope)" : ""),
    });
    return ok(nextState, { approval, changeSet: approved, missingDependencies, reduced });
  },

  startOperation: (state, command, ctx) => {
    const c = command as Extract<Parameters<Handler>[1], { type: "startOperation" }>;
    if (c.actor === "automation" && state.ruleset.paused) {
      return fail("AUTOMATION_PAUSED", "automation is paused; new automatic steps are blocked", false);
    }
    const approvalLookup = lookupEntity(state.approvals, c.approvalId, "approval");
    if (approvalLookup.failure) return approvalLookup.failure;
    const approval = approvalLookup.entity;
    const idempotencyKey = approval.id + ":" + approval.changeSetHash;
    const existing = Object.values(state.operations).find((op) => op.idempotencyKey === idempotencyKey);
    if (existing) return ok(null, { operation: existing, alreadyExisted: true });
    if (approval.status !== "valid") {
      const reason =
        approval.status === "consumed"
          ? "approval already consumed by operation " + approval.consumedByOperationId
          : "approval invalid: " + (approval.invalidReason ?? "unknown reason");
      return fail("APPROVAL_INVALID", reason, false);
    }
    const cs = state.changeSets[approval.changeSetId];
    if (!cs) return fail("ENTITY_NOT_FOUND", "change set not found: " + approval.changeSetId, false);
    const stale = changeSetStaleReason(state, cs);
    if (stale || approval.changeSetHash !== cs.hash) {
      return fail("APPROVAL_INVALID", stale ?? "change set hash no longer matches", false);
    }
    const op: Operation = {
      ...derivedBase(state, ctx),
      id: ctx.uuid(),
      approvalId: approval.id,
      changeSetId: cs.id,
      changeSetHash: approval.changeSetHash,
      idempotencyKey,
      stepReceipts: [],
      status: "executing",
      lastError: null,
      readback: null,
      resultRefs: [],
    };
    const env: ExecEnv = {
      state,
      ctx,
      changeSet: cs,
      operationId: op.id,
      commitments: { ...state.commitments },
      drafts: { ...state.drafts },
      newLedger: [],
      readbackItems: [],
    };
    const receipts = executeChangeSet(cs, env);
    const allCompleted = receipts.every((r) => r.status === "completed");
    const readbackMismatch = env.readbackItems.some((i) => i.matchesExpected === false);
    const firstFailure = receipts.find((r) => r.status === "failed");
    op.stepReceipts = receipts;
    const resultRefs = receipts
      .filter((r) => r.status === "completed" && r.resultRef !== null && env.drafts[r.resultRef] !== undefined)
      .map((r) => r.resultRef as EntityId);
    op.resultRefs = resultRefs;
    op.readback = { at: ctx.now, items: env.readbackItems, resultRefs };
    if (!allCompleted) {
      op.status = "failed";
      op.lastError = firstFailure?.detail ?? "one or more steps did not complete";
    } else if (readbackMismatch) {
      op.status = "failed";
      op.lastError = "readback mismatch against persisted state";
    } else {
      op.status = "verified";
    }
    const operations = { ...state.operations, [op.id]: op };
    const approvals = {
      ...state.approvals,
      [approval.id]: { ...bump(approval, ctx.now), status: "consumed" as const, consumedByOperationId: op.id },
    };
    const changes = [{ entityId: op.id, before: 0, after: 1 }, { entityId: approval.id, before: approval.revision, after: approval.revision + 1 }];
    for (const commitment of Object.values(env.commitments)) {
      const before = state.commitments[commitment.id];
      if (before && before.revision !== commitment.revision) {
        changes.push({ entityId: commitment.id, before: before.revision, after: commitment.revision });
      }
    }
    for (const draft of Object.values(env.drafts)) changes.push({ entityId: draft.id, before: 0, after: 1 });
    const nextState = finish(
      state,
      { operations, approvals, commitments: env.commitments, drafts: env.drafts, ledger: [...state.ledger, ...env.newLedger] },
      changes,
      {
        eventId: ctx.uuid(),
        type: "operation.executed",
        commandId: c.commandId,
        actor: c.actor,
        at: ctx.now,
        summary: "operation " + op.status + ": " + receipts.length + " steps executed for " + cs.label,
      },
    );
    op.revision = 1;
    return ok(nextState, { operation: op, alreadyExisted: false });
  },

  readbackOperation: (state, command, ctx) => {
    const c = command as Extract<Parameters<Handler>[1], { type: "readbackOperation" }>;
    const opLookup = lookupEntity(state.operations, c.entityId, "operation");
    if (opLookup.failure) return opLookup.failure;
    const op = opLookup.entity;
    const revisionFail = requireRevision(op.revision, c.expectedRevision);
    if (revisionFail) return revisionFail;
    if (c.report === undefined || c.report === null) {
      return ok(null, { operation: op });
    }
    const receipt = op.stepReceipts.find((r) => r.stepId === c.report?.stepId);
    const item: ReadbackItem = {
      objectId: receipt?.targetId ?? c.report.stepId,
      revision: op.revision,
      field: "externalReport",
      value: c.report.status,
      matchesExpected: c.report.status === "completed" ? true : null,
    };
    const updated: Operation = {
      ...bump(op, ctx.now),
      readback: {
        at: ctx.now,
        items: [...(op.readback?.items ?? []), item],
        resultRefs: op.readback?.resultRefs ?? [],
      },
    };
    if (c.report.status === "unknown") {
      updated.status = "unknown";
      updated.lastError = "external readback reported unknown; side effects must not be retried blindly";
    } else if (c.report.status === "failed") {
      updated.status = "failed";
      updated.lastError = c.report.detail ?? "external readback reported failure";
    } else {
      updated.status = "verified";
      updated.lastError = null;
    }
    const nextState = finish(
      state,
      { operations: { ...state.operations, [updated.id]: updated } },
      [{ entityId: updated.id, before: op.revision, after: updated.revision }],
      {
        eventId: ctx.uuid(),
        type: "operation.readback",
        commandId: c.commandId,
        actor: c.actor,
        at: ctx.now,
        summary: "operation readback: " + updated.status,
      },
    );
    return ok(nextState, { operation: updated });
  },

  syncSource: async (state, command, ctx) => {
    const c = command as Extract<Parameters<Handler>[1], { type: "syncSource" }>;
    const sourceLookup = lookupEntity(state.sources, c.entityId, "source");
    if (sourceLookup.failure) return sourceLookup.failure;
    const source = sourceLookup.entity;
    if (c.expectedRevision === null) {
      return fail("INVALID_INPUT", "syncSource requires the current expectedRevision of the source", false);
    }
    const revisionFail = requireRevision(source.revision, c.expectedRevision);
    if (revisionFail) return revisionFail;
    if (!state.ruleset.grants.readMaterial) {
      return fail("INVALID_GRANT", "syncSource requires the readMaterial grant", false);
    }
    if (source.status === "revoked" || source.accessRevokedAt !== null) {
      return fail("INVALID_GRANT", "source access is revoked; sync and material reads are not permitted", false);
    }
    if (state.ruleset.paused && c.actor !== "user") {
      return fail("AUTOMATION_PAUSED", "automation is paused; only an explicit user sync is permitted", false);
    }
    const provider = extractSyncProvider(c);
    if (!provider) {
      return persistSyncFailure(
        state,
        c,
        ctx,
        source,
        "source provider for connector " + source.connectorId + " is unavailable; sync was not attempted",
      );
    }
    let result: unknown;
    try {
      result = await provider.sync();
    } catch {
      return persistSyncFailure(state, c, ctx, source, "source provider sync threw an error; no result was returned");
    }
    const evaluated = evaluateProviderResult(result);
    if (evaluated.ok) {
      const snapshot: SourceSnapshot = {
        capturedAt: ctx.now,
        sourceVersion: evaluated.version,
        intervals: evaluated.intervals,
        stale: false,
      };
      const updated = {
        ...bump(source, ctx.now),
        sourceVersion: evaluated.version,
        intervals: evaluated.intervals,
        lastSuccessAt: ctx.now,
        status: "connected" as const,
        lastUsableSnapshot: snapshot,
        coverage: { known: true, intervals: evaluated.intervals },
        lastError: null,
      };
      const sources = { ...state.sources, [updated.id]: updated };
      const approvals = { ...state.approvals };
      for (const ap of Object.values(approvals)) {
        if (ap.status !== "valid") continue;
        for (const [sid, boundVersion] of Object.entries(ap.sourceVersionSet)) {
          const current = sources[sid];
          if (current && current.sourceVersion !== boundVersion) {
            approvals[ap.id] = {
              ...bump(ap, ctx.now),
              status: "invalid",
              invalidReason: "source " + sid + " moved from version " + boundVersion + " to " + current.sourceVersion,
            };
          }
        }
      }
      const nextState = finish(
        state,
        { sources, approvals },
        [{ entityId: updated.id, before: source.revision, after: updated.revision }],
        {
          eventId: ctx.uuid(),
          type: "source.synced",
          commandId: c.commandId,
          actor: c.actor,
          at: ctx.now,
          summary: "source synced to version " + evaluated.version,
        },
      );
      return ok(nextState, { source: updated, syncResult: "success" });
    }
    return persistSyncFailure(state, c, ctx, source, evaluated.lastError, evaluated.summaryReason);
  },

  recheckCapacity: (state, command, ctx) => {
    const c = command as Extract<Parameters<Handler>[1], { type: "recheckCapacity" }>;
    const userFail = requireUser(c.actor, "recheckCapacity");
    if (userFail) return userFail;
    if (!Number.isFinite(c.actualMinutes) || c.actualMinutes <= 0 || !Number.isInteger(c.actualMinutes)) {
      return fail("INVALID_INPUT", "actualMinutes must be a positive whole number", false);
    }
    const plannedTotal = activePlannedMinutes(state);
    const conflictRecorded = c.actualMinutes > plannedTotal;
    const plans = { ...state.plans };
    const affectedPlanIds: EntityId[] = [];
    for (const plan of Object.values(plans)) {
      if (plan.status !== "candidate" && plan.status !== "selected" && plan.status !== "pendingApproval") continue;
      if (plan.estimateMinutes >= c.actualMinutes) continue;
      plans[plan.id] = {
        ...bump(plan, ctx.now),
        status: "invalid",
        invalidReason: "actual " + c.actualMinutes + " minutes exceed the plan estimate of " + plan.estimateMinutes + " minutes",
      };
      affectedPlanIds.push(plan.id);
    }
    const changes = affectedPlanIds.map((id) => ({
      entityId: id,
      before: state.plans[id].revision,
      after: plans[id].revision,
    }));
    const nextState = finish(state, { plans }, changes, {
      eventId: ctx.uuid(),
      type: "capacity.rechecked",
      commandId: c.commandId,
      actor: c.actor,
      at: ctx.now,
      summary: conflictRecorded
        ? "capacity conflict recorded: actual " + c.actualMinutes + " > planned " + plannedTotal
        : "capacity recheck within plan: actual " + c.actualMinutes + " <= planned " + plannedTotal,
    });
    return ok(nextState, { conflictRecorded, affectedPlanIds });
  },
};

function extractSyncProvider(command: { provider?: unknown }): SourceProvider | null {
  try {
    const raw = command.provider;
    if (raw !== null && typeof raw === "object" && typeof (raw as { sync?: unknown }).sync === "function") {
      return raw as SourceProvider;
    }
  } catch {
    return null;
  }
  return null;
}

type EvaluatedProviderResult =
  | { ok: true; version: number; intervals: TimeRange[] }
  | { ok: false; lastError: string; summaryReason: string };

function evaluateProviderResult(result: unknown): EvaluatedProviderResult {
  if (result === null || typeof result !== "object") {
    return { ok: false, lastError: "provider returned a malformed sync result", summaryReason: "malformed sync result" };
  }
  const envelope = result as { ok?: unknown; reason?: unknown; mayHaveSideEffects?: unknown; value?: unknown };
  if (envelope.ok === false) {
    const reason =
      typeof envelope.reason === "string" && envelope.reason.length > 0
        ? envelope.reason
        : "provider reported sync failure without a reason";
    const sideEffectNote =
      envelope.mayHaveSideEffects === true
        ? " (provider may have applied side effects; recovery requires explicit user action)"
        : "";
    return { ok: false, lastError: reason + sideEffectNote, summaryReason: reason };
  }
  if (envelope.ok !== true) {
    return { ok: false, lastError: "provider returned a malformed sync result", summaryReason: "malformed sync result" };
  }
  const validated = validateSnapshotValue(envelope.value);
  if (typeof validated === "string") {
    return {
      ok: false,
      lastError: "provider returned an invalid success payload: " + validated,
      summaryReason: "invalid success payload",
    };
  }
  return validated;
}

function validateSnapshotValue(value: unknown): { ok: true; version: number; intervals: TimeRange[] } | string {
  if (value === null || typeof value !== "object") {
    return "success value must be an object";
  }
  const candidate = value as { version?: unknown; intervals?: unknown };
  if (typeof candidate.version !== "number" || !Number.isSafeInteger(candidate.version) || candidate.version < 0) {
    return "version must be a nonnegative safe integer";
  }
  if (!Array.isArray(candidate.intervals)) {
    return "intervals must be an array";
  }
  const intervals: TimeRange[] = [];
  for (const item of candidate.intervals) {
    const interval = asValidatedInterval(item);
    if (typeof interval === "string") return interval;
    intervals.push(interval);
  }
  return { ok: true, version: candidate.version, intervals };
}

function asValidatedInterval(item: unknown): TimeRange | string {
  if (item === null || typeof item !== "object") {
    return "each interval must be an object";
  }
  const range = item as { start?: unknown; end?: unknown; timezone?: unknown };
  const start = typeof range.start === "string" ? range.start : null;
  const end = typeof range.end === "string" ? range.end : null;
  if (start === null || explicitIsoInstantMs(start) === null) {
    return "interval start must be an explicit ISO instant";
  }
  if (end === null || explicitIsoInstantMs(end) === null) {
    return "interval end must be an explicit ISO instant";
  }
  const startMs = explicitIsoInstantMs(start);
  const endMs = explicitIsoInstantMs(end);
  if (startMs === null || endMs === null || endMs <= startMs) {
    return "interval end must be after its start";
  }
  if (typeof range.timezone !== "string" || !isValidTimezone(range.timezone)) {
    return "interval timezone is not a valid IANA timezone";
  }
  return { start, end, timezone: range.timezone };
}

function explicitIsoInstantMs(raw: string): number | null {
  if (!/(?:Z|[+-]\d{2}:\d{2})$/.test(raw)) return null;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : null;
}

function isValidTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

function persistSyncFailure(
  state: DomainState,
  command: Extract<Parameters<Handler>[1], { type: "syncSource" }>,
  ctx: HandlerCtx,
  source: Source,
  lastError: string,
  summaryReason: string = lastError,
): HandlerSuccess {
  const updated = {
    ...bump(source, ctx.now),
    status: "stale" as const,
    lastError,
    coverage: { known: false, intervals: [] },
    lastUsableSnapshot: source.lastUsableSnapshot ? { ...source.lastUsableSnapshot, stale: true } : null,
  };
  const nextState = finish(
    state,
    { sources: { ...state.sources, [updated.id]: updated } },
    [{ entityId: updated.id, before: source.revision, after: updated.revision }],
    {
      eventId: ctx.uuid(),
      type: "source.syncFailed",
      commandId: command.commandId,
      actor: command.actor,
      at: ctx.now,
      summary: "source sync failed: " + summaryReason,
    },
  );
  return ok(nextState, { source: updated, syncResult: "failed" });
}

interface ExecEnv {
  state: DomainState;
  ctx: HandlerCtx;
  changeSet: ChangeSet;
  operationId: EntityId;
  commitments: Record<EntityId, Commitment>;
  drafts: Record<EntityId, Draft>;
  newLedger: LedgerEntry[];
  readbackItems: ReadbackItem[];
}

export function changeSetStaleReason(state: DomainState, cs: ChangeSet): string | null {
  for (const action of cs.actions) {
    if (action.kind !== "deferCommitment") continue;
    const target = action.targetId ? state.commitments[action.targetId] : null;
    if (!target || typeof action.params.toDate !== "string") return "延期目标或日期不可用。";
    const localFailure = localRescheduleFailure(state, target, action.params.toDate);
    if (localFailure) return localFailure;
  }
  if (computeChangeSetHash(cs) !== cs.hash) return "change set hash no longer matches its content";
  if (cs.ruleRevision !== state.ruleset.revision) {
    return "ruleset moved from revision " + cs.ruleRevision + " to " + state.ruleset.revision;
  }
  for (const [sid, boundVersion] of Object.entries(cs.sourceVersionSet)) {
    const source = state.sources[sid];
    if (!source) return "bound source " + sid + " no longer exists";
    if (source.sourceVersion !== boundVersion) {
      return "source " + sid + " moved from version " + boundVersion + " to " + source.sourceVersion;
    }
  }
  for (const [tid, boundRevision] of Object.entries(cs.targetRevisions)) {
    const target = state.commitments[tid] ?? state.intents[tid];
    if (!target) return "bound target " + tid + " no longer exists";
    if (target.revision !== boundRevision) {
      return "target " + tid + " moved from revision " + boundRevision + " to " + target.revision;
    }
  }
  return null;
}

function executeChangeSet(cs: ChangeSet, env: ExecEnv): StepReceipt[] {
  const receipts: StepReceipt[] = [];
  const completedIds = new Set<EntityId>();
  const pending = [...cs.actions];
  let progressed = true;
  while (pending.length > 0 && progressed) {
    progressed = false;
    for (let i = 0; i < pending.length; i++) {
      const action = pending[i];
      if (!action.dependsOn.every((dep) => completedIds.has(dep))) continue;
      pending.splice(i, 1);
      i -= 1;
      progressed = true;
      const receipt = executeAction(action, env);
      receipts.push(receipt);
      if (receipt.status === "completed") completedIds.add(action.id);
    }
  }
  for (const skipped of pending) {
    receipts.push({
      stepId: env.ctx.uuid(),
      actionKind: skipped.kind,
      status: "skipped",
      at: env.ctx.now,
      targetId: skipped.targetId,
      resultRef: null,
      detail: "dependency failed or was not executable",
    });
  }
  return receipts;
}

function executeAction(action: PlanAction, env: ExecEnv): StepReceipt {
  const { state, ctx } = env;
  const base = { stepId: ctx.uuid(), actionKind: action.kind, at: ctx.now };
  if (action.kind === "readMaterial") {
    const sourceId = String(action.params.sourceId);
    const source = state.sources[sourceId];
    const snapshot = source?.lastUsableSnapshot;
    if (!snapshot || snapshot.stale) {
      return { ...base, status: "failed", targetId: sourceId, resultRef: null, detail: "no usable source snapshot for " + sourceId };
    }
    env.readbackItems.push({
      objectId: sourceId,
      revision: source.revision,
      field: "lastUsableSnapshot.sourceVersion",
      value: snapshot.sourceVersion,
      matchesExpected: snapshot.sourceVersion === (env.changeSet.sourceVersionSet[sourceId] ?? null),
    });
    return {
      ...base,
      status: "completed",
      targetId: sourceId,
      resultRef: sourceId + "@v" + snapshot.sourceVersion,
      detail: "read source snapshot captured at " + snapshot.capturedAt,
    };
  }
  if (action.kind === "createDraft") {
    const sourceId = Object.keys(env.changeSet.sourceVersionSet)[0];
    const source = state.sources[sourceId];
    const snapshot = source?.lastUsableSnapshot;
    if (!snapshot || snapshot.stale) {
      return { ...base, status: "failed", targetId: null, resultRef: null, detail: "cannot draft without a usable source snapshot" };
    }
    const commitmentId = String(action.params.commitmentId);
    const snapshotLines = snapshot.intervals
      .map((r) => r.start.slice(0, 16).replace("T", " ") + " - " + r.end.slice(11, 16) + " (" + r.timezone + ")");
    const activeBlock = Object.values(state.protectedBlocks).find((b) => b.status === "active");
    const protectedLines = activeBlock
      ? [
          "保护时段: " +
            activeBlock.range.start.slice(0, 16).replace("T", " ") +
            " - " +
            activeBlock.range.end.slice(11, 16) +
            " (" +
            activeBlock.range.timezone +
            ")",
        ]
      : [];
    const comparisonSection: DraftSection = {
      id: ctx.uuid(),
      title: "日程对比草稿",
      content: [...snapshotLines, ...protectedLines].join("\n"),
      contentVersion: 1,
      sourceRefs: [sourceId],
      sourceVersions: { [sourceId]: snapshot.sourceVersion },
      reviewStatus: "pendingReview",
      confirmedBy: null,
      confirmedAt: null,
      openIssues: [],
      confirmationInvalidReason: null,
    };
    const costSection: DraftSection = {
      id: ctx.uuid(),
      title: "成本评估（未决）",
      content: "现有数据只有来源时间快照，缺少这项承诺的实际用时记录，不能给出成本结论。",
      contentVersion: 1,
      sourceRefs: [sourceId],
      sourceVersions: { [sourceId]: snapshot.sourceVersion },
      reviewStatus: "pendingReview",
      confirmedBy: null,
      confirmedAt: null,
      openIssues: ["缺少实际用时记录：成本结论未决"],
      confirmationInvalidReason: null,
    };
    const draft: Draft = {
      ...derivedBase(state, ctx),
      id: ctx.uuid(),
      operationId: env.operationId,
      commitmentId,
      sources: [sourceId],
      version: 1,
      sections: [comparisonSection, costSection],
      openQuestions: [],
      sentAt: null,
      status: "pendingReview",
    };
    env.drafts[draft.id] = draft;
    env.readbackItems.push({ objectId: draft.id, revision: 1, field: "status", value: "pendingReview", matchesExpected: true });
    return { ...base, status: "completed", targetId: draft.id, resultRef: draft.id, detail: "draft generated from source snapshot" };
  }
  if (action.kind === "updateEstimate") {
    const targetId = action.targetId;
    if (!targetId) return { ...base, status: "failed", targetId: null, resultRef: null, detail: "updateEstimate has no target" };
    const current = env.commitments[targetId];
    if (!current) return { ...base, status: "failed", targetId, resultRef: null, detail: "target commitment missing" };
    const bound = env.changeSet.targetRevisions[targetId];
    if (bound !== undefined && current.revision !== bound) {
      return { ...base, status: "failed", targetId, resultRef: null, detail: "target revision moved from " + bound };
    }
    const to = Number(action.params.to);
    const updated = { ...bump(current, ctx.now), effortEstimateMinutes: to };
    env.commitments[targetId] = updated;
    env.readbackItems.push({
      objectId: targetId,
      revision: updated.revision,
      field: "effortEstimateMinutes",
      value: to,
      matchesExpected: updated.effortEstimateMinutes === to,
    });
    const from = Number(action.params.from);
    if (Number.isFinite(from) && from - to > 0) {
      env.newLedger.push({
        ...derivedBase(state, ctx),
        id: ctx.uuid(),
        commitmentId: targetId,
        blockId: null,
        operationId: env.operationId,
        category: "estimatedHumanReduction",
        minutes: from - to,
        certainty: "estimated",
        effectiveDate: updated.schedule?.date ?? state.attention.budget.budgetDay,
        note: "estimate reduced " + from + " -> " + to + " minutes (estimated, not measured)",
        supersedesId: null,
      });
    }
    return { ...base, status: "completed", targetId, resultRef: targetId + "@v" + updated.revision, detail: "estimate " + from + " -> " + to };
  }
  const targetId = action.targetId;
  if (!targetId) return { ...base, status: "failed", targetId: null, resultRef: null, detail: "deferCommitment has no target" };
  const current = env.commitments[targetId];
  if (!current) return { ...base, status: "failed", targetId, resultRef: null, detail: "target commitment missing" };
  const bound = env.changeSet.targetRevisions[targetId];
  if (bound !== undefined && current.revision !== bound) {
    return { ...base, status: "failed", targetId, resultRef: null, detail: "target revision moved from " + bound };
  }
  if (!current.schedule) {
    return { ...base, status: "failed", targetId, resultRef: null, detail: "commitment has no schedule to defer" };
  }
  const toDate = String(action.params.toDate);
  const updated = { ...bump(current, ctx.now), schedule: { ...current.schedule, date: toDate } };
  env.commitments[targetId] = updated;
  env.readbackItems.push({
    objectId: targetId,
    revision: updated.revision,
    field: "schedule.date",
    value: toDate,
    matchesExpected: updated.schedule.date === toDate,
  });
  const debtMinutes = updated.effortEstimateMinutes ?? Number(action.params.minutes ?? 0);
  env.newLedger.push({
    ...derivedBase(state, ctx),
    id: ctx.uuid(),
    commitmentId: targetId,
    blockId: null,
    operationId: env.operationId,
    category: "futureDebt",
    minutes: debtMinutes,
    certainty: "estimated",
    effectiveDate: toDate,
    note: "deferred to " + toDate + "; future debt is never a net saving",
    supersedesId: null,
  });
  return { ...base, status: "completed", targetId, resultRef: targetId + "@v" + updated.revision, detail: "deferred to " + toDate };
}
