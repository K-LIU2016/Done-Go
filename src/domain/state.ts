import { FIXTURE_IDS } from "./ids.ts";
import { createEmptyContextReviewState } from "./contextReviewModel.ts";
import { createAgreementRequest } from "./agreementModel.ts";
import type {
  AttentionBudget,
  Commitment,
  DataMode,
  DomainEvent,
  DomainState,
  EntityId,
  Intent,
  LedgerEntry,
  ProtectedBlock,
  Request,
  RuleSet,
  Source,
} from "./types.ts";

export const DOMAIN_SCHEMA_VERSION = 1;
export const FIXTURE_DAY = "2026-09-12";
export const FIXTURE_TIMEZONE = "Asia/Shanghai";
/**
 * The fixture namespace is a deterministic walkthrough, so its domain clock
 * stays on the fixture day instead of expiring when the host clock advances.
 */
export const FIXTURE_NOW = "2026-09-12T12:00:00+08:00";
const FIXTURE_CREATED_AT = "2026-09-12T09:00:00+08:00";

export interface InitialStateOptions {
  now?: () => string;
}

function base(id: EntityId, dataMode: DataMode) {
  return {
    id,
    revision: 1,
    createdAt: FIXTURE_CREATED_AT,
    updatedAt: FIXTURE_CREATED_AT,
    dataMode,
    provenance: { origin: "fixture" as const },
  };
}

function fixtureSource(dataMode: DataMode): Source {
  return {
    ...base(FIXTURE_IDS.sourceCalendar, dataMode),
    connectorId: "fixture-calendar",
    externalObjectId: "cal-primary",
    sourceVersion: 1,
    lastSuccessAt: "2026-09-12T08:30:00+08:00",
    coverage: {
      known: true,
      intervals: [
        { start: FIXTURE_DAY + "T17:00:00+08:00", end: FIXTURE_DAY + "T19:00:00+08:00", timezone: FIXTURE_TIMEZONE },
      ],
    },
    status: "connected",
    lastUsableSnapshot: {
      capturedAt: "2026-09-12T08:30:00+08:00",
      sourceVersion: 1,
      intervals: [
        { start: FIXTURE_DAY + "T17:00:00+08:00", end: FIXTURE_DAY + "T19:00:00+08:00", timezone: FIXTURE_TIMEZONE },
      ],
      stale: false,
    },
    lastError: null,
    accessRevokedAt: null,
  };
}

function fixtureIntent(dataMode: DataMode): Intent {
  return {
    ...base(FIXTURE_IDS.intent, dataMode),
    verbatim: "周一晚上7到8点留出整块时间写复盘，不要被打扰",
    channel: "text",
    parsedFields: {
      date: FIXTURE_DAY,
      startTime: "19:00",
      endTime: "20:00",
      timezone: FIXTURE_TIMEZONE,
      topic: "写复盘",
    },
    fieldStatus: { date: "confirmed", startTime: "confirmed", endTime: "confirmed", timezone: "confirmed", topic: "confirmed" },
    constraints: [
      { id: "fx-constraint-01", kind: "protect", expression: "不被打扰", confirmed: true },
    ],
    status: "saved",
    ambiguityNote: null,
    sourceRefs: [],
  };
}

function fixtureProtectedBlock(dataMode: DataMode): ProtectedBlock {
  return {
    ...base(FIXTURE_IDS.protectedBlock, dataMode),
    intentId: FIXTURE_IDS.intent,
    blockId: "protected-2026-09-12-evening",
    purpose: null,
    range: {
      start: FIXTURE_DAY + "T19:00:00+08:00",
      end: FIXTURE_DAY + "T20:00:00+08:00",
      timezone: FIXTURE_TIMEZONE,
    },
    sourceRefs: [FIXTURE_IDS.intent],
    status: "active",
  };
}

function fixtureRequest(dataMode: DataMode): Request {
  return {
    ...base(FIXTURE_IDS.request, dataMode),
    verbatim: "能帮我把这周的复盘报告先整理成草稿吗？明天要交给主管",
    proposer: "同事·陈",
    sourceRef: "im://dm/42",
    status: "candidate",
    acceptedBy: null,
    commitmentId: null,
  };
}

function fixtureAgreementRequest() {
  return createAgreementRequest({
    id: FIXTURE_IDS.agreementRequest,
    proposerId: "user",
    recipientId: "colleague-chen",
    terms: {
      purpose: "整理本周复盘报告草稿",
      dateRange: { start: "2026-09-12T19:00:00+08:00", end: "2026-09-12T20:00:00+08:00" },
      timezone: FIXTURE_TIMEZONE,
      effortRange: { min: 45, max: 60 },
      deadline: "2026-09-13T18:00:00+08:00",
      materials: [],
    },
    expiresAt: "2026-09-13T23:59:00+08:00",
    now: FIXTURE_CREATED_AT,
  });
}

function fixtureCommitments(dataMode: DataMode): Record<string, Commitment> {
  const mk = (
    id: EntityId,
    scope: string,
    minutes: number,
    startMinute: number,
    endMinute: number,
    mobility: "fixed" | "flexible",
    deadline: string | null,
  ): Commitment => ({
    ...base(id, dataMode),
    requestId: null,
    acceptedBy: "user",
    scope,
    scopeStatus: "clarified",
    deadline,
    effortEstimateMinutes: minutes,
    mobility,
    schedule: { date: FIXTURE_DAY, startMinute, endMinute, timezone: FIXTURE_TIMEZONE },
    status: "active",
    pendingDetails: [],
  });
  return {
    [FIXTURE_IDS.commitmentReport]: mk(FIXTURE_IDS.commitmentReport, "撰写季度复盘报告", 60, 1050, 1110, "flexible", FIXTURE_DAY + "T19:00:00+08:00"),
    [FIXTURE_IDS.commitmentMeeting]: mk(FIXTURE_IDS.commitmentMeeting, "参加项目周会", 30, 1020, 1050, "fixed", null),
    [FIXTURE_IDS.commitmentAdmin]: mk(FIXTURE_IDS.commitmentAdmin, "提交报销单", 40, 1110, 1150, "flexible", null),
  };
}

function fixtureRuleset(dataMode: DataMode): RuleSet {
  return {
    ...base(FIXTURE_IDS.ruleset, dataMode),
    grants: {
      readMaterial: true,
      createLocalDraft: true,
      updateEstimate: true,
      internalReschedule: true,
      attentionRemind: true,
      externalCalendarWrite: false,
    },
    paused: false,
    pauseEpoch: 0,
    dailyCapacityMinutes: 120,
    timezone: FIXTURE_TIMEZONE,
    history: [
      {
        revision: 1,
        at: FIXTURE_CREATED_AT,
        actor: "user",
        changes: ["initial fixture ruleset"],
        description: "fixture 初始规则版本",
      },
    ],
  };
}

function fixtureBudget(dataMode: DataMode): AttentionBudget {
  return {
    ...base(FIXTURE_IDS.attentionBudget, dataMode),
    dailyMax: 2,
    used: 1,
    budgetDay: FIXTURE_DAY,
    timezone: FIXTURE_TIMEZONE,
    deliveredIds: ["fx-attention-seed-01"],
    queue: [],
  };
}

function fixtureLedger(dataMode: DataMode): LedgerEntry[] {
  return [
    {
      ...base(FIXTURE_IDS.ledgerProtected, dataMode),
      commitmentId: null,
      blockId: "protected-2026-09-12-evening",
      operationId: null,
      category: "protectedDuration",
      minutes: 60,
      certainty: "estimated",
      effectiveDate: FIXTURE_DAY,
      note: "已确认的保护时段（fixture 初始）",
      supersedesId: null,
    },
  ];
}

export function createInitialState(dataMode: DataMode, options: InitialStateOptions = {}): DomainState {
  void options.now; // fixture timestamps are fixed for reproducibility
  return {
    schemaVersion: DOMAIN_SCHEMA_VERSION,
    dataMode,
    globalRevision: 1,
    sources: { [FIXTURE_IDS.sourceCalendar]: fixtureSource(dataMode) },
    intents: { [FIXTURE_IDS.intent]: fixtureIntent(dataMode) },
    captureDrafts: {},
    protectedBlocks: { [FIXTURE_IDS.protectedBlock]: fixtureProtectedBlock(dataMode) },
    requests: { [FIXTURE_IDS.request]: fixtureRequest(dataMode) },
    agreementRequests: { [FIXTURE_IDS.agreementRequest]: fixtureAgreementRequest() },
    commitments: fixtureCommitments(dataMode),
    plans: {},
    changeSets: {},
    approvals: {},
    operations: {},
    drafts: {},
    checkpoints: {},
    materials: {},
    ruleset: fixtureRuleset(dataMode),
    attention: { budget: fixtureBudget(dataMode), items: {} },
    quietSessions: {},
    ledger: fixtureLedger(dataMode),
    events: [] as DomainEvent[],
    contextReview: createEmptyContextReviewState(),
  };
}

export interface EntityRevisionChange {
  entityId: EntityId;
  before: number;
  after: number;
}

export function withEvent(
  state: DomainState,
  params: {
    eventId: EntityId;
    type: string;
    commandId: string;
    actor: DomainEvent["actor"];
    at: string;
    summary: string;
    changes: EntityRevisionChange[];
  },
): DomainState {
  const event: DomainEvent = {
    id: params.eventId,
    type: params.type,
    commandId: params.commandId,
    actor: params.actor,
    at: params.at,
    summary: params.summary,
    entityRevisions: params.changes,
  };
  return { ...state, globalRevision: state.globalRevision + 1, events: [...state.events, event] };
}
