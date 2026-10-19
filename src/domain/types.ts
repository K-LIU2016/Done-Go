import type { ContextReviewAction, ContextReviewState } from "./contextReviewModel.ts";
import type { CheckpointNote } from "./checkpointNoteModel.ts";
import type { CheckpointRulesSnapshot } from "./checkpointRulesModel.ts";
import type { SourceRevocationCommand, SourceRevocationData, SourceRevocationReceipt } from "./handlers/sourceRevocation.ts";
import type { AgreementRequest, AgreementTerms } from "./agreementModel.ts";

export type DataMode = "fixture" | "live";
export type Actor = "user" | "automation" | "model";
export type EntityId = string;

export interface Provenance {
  origin: "fixture" | "user" | "derived" | "system" | "model";
  note?: string;
}

export interface EntityBase {
  id: EntityId;
  revision: number;
  createdAt: string;
  updatedAt: string;
  dataMode: DataMode;
  provenance: Provenance;
}

export interface TimeRange {
  start: string;
  end: string;
  timezone: string;
}

export type SourceStatus = "connected" | "stale" | "error" | "revoked" | "unconnected";

export interface SourceCoverage {
  known: boolean;
  intervals: TimeRange[];
}

export interface SourceSnapshot {
  capturedAt: string;
  sourceVersion: number;
  intervals: TimeRange[];
  stale: boolean;
}

export interface Source extends EntityBase {
  revocation?: SourceRevocationReceipt;
  connectorId: string;
  externalObjectId: string | null;
  sourceVersion: number;
  lastSuccessAt: string | null;
  coverage: SourceCoverage;
  status: SourceStatus;
  lastUsableSnapshot: SourceSnapshot | null;
  lastError: string | null;
  accessRevokedAt: string | null;
}

export type ProviderOutcome<T> =
  | { ok: true; value: T }
  | { ok: false; reason: string; mayHaveSideEffects?: boolean };

export interface SourceSnapshotData {
  intervals: TimeRange[];
  version: number;
}

export interface SourceProvider {
  readSnapshot(): Promise<ProviderOutcome<SourceSnapshotData>>;
  sync(): Promise<ProviderOutcome<SourceSnapshotData>>;
  executeAllowedAction(
    actionId: EntityId,
    params: Record<string, unknown>,
  ): Promise<ProviderOutcome<Record<string, unknown>>>;
  readback(objectRef: string): Promise<ProviderOutcome<Record<string, unknown>>>;
  revokeAccess(): Promise<ProviderOutcome<{ revoked: boolean }>>;
}

export type CaptureChannel = "text" | "voice" | "share" | "shortcut" | "manual";

export interface ParsedFields {
  date: string | null;
  startTime: string | null;
  endTime: string | null;
  timezone: string | null;
  topic: string | null;
}

export type FieldConfirmation = "confirmed" | "pendingUserConfirmation" | "corrected";

export interface Constraint {
  id: EntityId;
  kind: string;
  expression: string;
  confirmed: boolean;
}

export type IntentStatus = "saved" | "ambiguous" | "paused" | "deleted" | "discarded";

export interface Intent extends EntityBase {
  verbatim: string;
  channel: CaptureChannel;
  parsedFields: ParsedFields;
  fieldStatus: Record<string, FieldConfirmation>;
  constraints: Constraint[];
  status: IntentStatus;
  ambiguityNote: string | null;
  sourceRefs: EntityId[];
  pausedAt?: string | null;
  deletedAt?: string | null;
}

export type CaptureDraftStatus = "open" | "savedAsIntent" | "discarded";

export interface CaptureDraft extends EntityBase {
  channel: CaptureChannel;
  raw: string;
  parsedFields: ParsedFields;
  ambiguityNote: string | null;
  constraints?: Array<{ kind: string; expression: string; confirmed: boolean }>;
  intentId?: EntityId | null;
  status: CaptureDraftStatus;
}

export interface ProtectedBlock extends EntityBase {
  intentId: EntityId | null;
  blockId: string;
  purpose: string | null; // empty purpose is valid
  range: TimeRange;
  sourceRefs: EntityId[];
  status: "active" | "released";
}

export type RequestStatus = "candidate" | "accepted" | "archived" | "excluded";

export interface Request extends EntityBase {
  verbatim: string;
  proposer: string | null;
  sourceRef: string | null;
  status: RequestStatus;
  acceptedBy: string | null;
  commitmentId: EntityId | null;
}

export interface CommitmentSchedule {
  date: string;
  startMinute: number | null;
  endMinute: number | null;
  timezone: string;
}

export type CommitmentStatus = "active" | "deferred" | "done" | "cancelled";

export interface Commitment extends EntityBase {
  requestId: EntityId | null;
  acceptedBy: string | null;
  scope: string | null;
  scopeStatus: "pendingDetails" | "clarified";
  deadline: string | null;
  effortEstimateMinutes: number | null; // null means unknown, never zero-by-default
  mobility: "fixed" | "flexible";
  schedule: CommitmentSchedule | null;
  status: CommitmentStatus;
  pendingDetails: string[];
}

export type PlanKind = "A" | "B";
export type PlanStatus = "candidate" | "selected" | "pendingApproval" | "invalid";

export interface PlanSummary {
  before: string;
  after: string;
  futureDebt: string | null;
  netSavingClaim: "none" | "estimatedOnly";
}

export interface Plan extends EntityBase {
  intentId: EntityId | null;
  commitmentId: EntityId;
  kind: PlanKind;
  constraintRefs: EntityId[];
  sourceVersionSet: Record<EntityId, number>;
  ruleRevision: number;
  estimateMinutes: number;
  futureDebtMinutes: number;
  capacityBeforeMinutes: number;
  capacityAfterMinutes: number;
  status: PlanStatus;
  invalidReason: string | null;
  summary: PlanSummary;
}

export interface ObjectDiff {
  objectId: EntityId;
  displayName: string;
  field: string;
  before: unknown;
  after: unknown;
  sourceRefs: EntityId[];
}

export type GrantKey =
  | "readMaterial"
  | "createLocalDraft"
  | "updateEstimate"
  | "internalReschedule"
  | "attentionRemind"
  | "externalCalendarWrite";

export type ActionKind = "readMaterial" | "createDraft" | "updateEstimate" | "deferCommitment";

export interface PlanAction {
  id: EntityId;
  kind: ActionKind;
  dependsOn: EntityId[];
  requiredGrant: GrantKey;
  targetId: EntityId | null;
  params: Record<string, unknown>;
  diffs: ObjectDiff[];
  exclusions: string[];
}

export interface ChangeSet extends EntityBase {
  planId: EntityId;
  planRevision: number;
  parentChangeSetId: EntityId | null;
  label: string;
  actions: PlanAction[];
  objectDiffs: ObjectDiff[];
  requiredGrants: GrantKey[];
  exclusions: string[];
  targetRevisions: Record<EntityId, number>;
  sourceVersionSet: Record<EntityId, number>;
  ruleRevision: number;
  hash: string;
}

export type ApprovalStatus = "pending" | "valid" | "invalid" | "consumed";

export interface Approval extends EntityBase {
  changeSetId: EntityId;
  changeSetHash: string;
  planId: EntityId;
  planRevision: number;
  sourceVersionSet: Record<EntityId, number>;
  ruleRevision: number;
  grantedActions: GrantKey[];
  status: ApprovalStatus;
  invalidReason: string | null;
  consumedByOperationId: EntityId | null;
  actor: Actor;
}

export type OperationStatus = "executing" | "verifying" | "verified" | "failed" | "unknown";

export interface StepReceipt {
  stepId: EntityId;
  actionKind: ActionKind;
  status: "completed" | "failed" | "unknown" | "skipped";
  at: string;
  targetId: EntityId | null;
  resultRef: string | null;
  detail: string;
}

export interface ReadbackItem {
  objectId: EntityId;
  revision: number;
  field: string;
  value: unknown;
  matchesExpected: boolean | null; // null = unknown
}

export interface ReadbackRecord {
  at: string;
  items: ReadbackItem[];
  resultRefs: EntityId[];
}

export interface Operation extends EntityBase {
  approvalId: EntityId;
  changeSetId: EntityId;
  changeSetHash: string;
  idempotencyKey: string; // approvalId + ":" + changeSetHash
  stepReceipts: StepReceipt[];
  status: OperationStatus;
  lastError: string | null;
  readback: ReadbackRecord | null;
  resultRefs: EntityId[];
}

export interface DraftSection {
  id: EntityId;
  title: string;
  content: string;
  contentVersion: number;
  sourceRefs: EntityId[];
  sourceVersions: Record<EntityId, number>;
  reviewStatus: "pendingReview" | "confirmed";
  confirmedBy: string | null;
  confirmedAt: string | null;
  openIssues: string[];
  confirmationInvalidReason: string | null;
}

export type DraftStatus = "generating" | "pendingReview" | "partiallyConfirmed" | "confirmed" | "sent" | "withdrawn";

export interface DraftWithdrawal {
  withdrawnAt: string;
  reason: string | null;
}

export interface Draft extends EntityBase {
  operationId: EntityId;
  commitmentId: EntityId;
  sources: EntityId[];
  version: number;
  sections: DraftSection[];
  openQuestions: string[];
  sentAt: string | null;
  status: DraftStatus;
  withdrawal?: DraftWithdrawal;
}

export interface CheckpointMaterial {
  id: EntityId;
  name: string;
  version: number;
  accessRef: string | null;
  sectionIds?: EntityId[];
}

export interface ResumeValidation {
  at: string;
  staleSourceIds: EntityId[];
  requiresReview: boolean;
  notes: string[];
}

export interface Checkpoint extends EntityBase {
  notes?: readonly CheckpointNote[];
  rulesSnapshot?: CheckpointRulesSnapshot;
  draftId: EntityId | null;
  draftVersion: number | null;
  draftRevision?: number | null;
  sourceVersionSet: Record<EntityId, number>;
  confirmedDecisions: Array<{ sectionId: EntityId; contentVersion: number; note: string }>;
  openQuestions: string[];
  sectionIssues?: Array<{ sectionId: EntityId; issue: string }>;
  materials: CheckpointMaterial[];
  nextStep: string | null;
  savedAt: string;
  resumeValidation: ResumeValidation | null;
}

export type MaterialReadPermission = "granted" | "denied";

export interface Material extends EntityBase {
  name: string;
  accessRef: string | null;
  version: number;
  verified: boolean;
  draftId?: EntityId;
  sectionIds?: EntityId[];
  readPermission?: MaterialReadPermission;
  content?: string | null;
}

export interface RuleSet extends EntityBase {
  grants: Record<GrantKey, boolean>;
  paused: boolean;
  pauseEpoch: number;
  dailyCapacityMinutes: number;
  timezone: string;
  history: Array<{
    revision: number;
    at: string;
    actor: Actor;
    changes: string[];
    description: string;
  }>;
}

export type AttentionSource = "internal" | "external" | "ai" | "payment" | "risk";

export interface RiskBasis {
  deadline: string;
  consequence: string;
  credibleSource: boolean;
}

export type AttentionStatus = "pending" | "delivered" | "queued" | "merged" | "dismissed" | "deferred";

export interface AttentionDraftRef {
  draftId: EntityId;
  sectionId?: EntityId;
}

export interface AttentionItem extends EntityBase {
  draftRef?: AttentionDraftRef;
  deliveryId: string;
  mergeKey: string;
  title: string;
  body: string;
  source: AttentionSource;
  urgency: "normal" | "urgentClaim" | "risk";
  riskBasis: RiskBasis | null;
  status: AttentionStatus;
  deliveredAt: string | null;
  budgetCharged: boolean;
}

export interface QueueEntry {
  id: EntityId;
  deliveryId: string;
  mergeKey: string;
  title: string;
  reason: string;
  queuedAt: string;
  dueAt: string | null;
}

export interface AttentionBudget extends EntityBase {
  dailyMax: number;
  used: number;
  budgetDay: string; // YYYY-MM-DD in budget timezone
  timezone: string;
  deliveredIds: string[];
  queue: QueueEntry[];
}

export type QuietDecision = "unchosen" | "keepStill" | "music" | "explore" | "exit";

export interface QuietSession extends EntityBase {
  blockId: string;
  originRoute: string | null;
  decision: QuietDecision;
  dismissedAt: string | null;
  suppressPrompts: boolean;
  coverageSnapshot: { known: boolean; intervals: TimeRange[] };
}

export type LedgerCategory =
  | "protectedDuration"
  | "estimatedHumanReduction"
  | "futureDebt"
  | "supervisionCost"
  | "measuredNetSaving";

export interface LedgerEntry extends EntityBase {
  commitmentId: EntityId | null;
  blockId: string | null;
  operationId: EntityId | null;
  category: LedgerCategory;
  minutes: number | null;
  certainty: "estimated" | "measured" | "unknown";
  effectiveDate: string;
  note: string;
  supersedesId: EntityId | null;
}

export interface DomainEvent {
  id: EntityId;
  type: string;
  commandId: string;
  actor: Actor;
  at: string;
  summary: string;
  entityRevisions: Array<{ entityId: EntityId; before: number; after: number }>;
}

export interface DomainState {
  schemaVersion: number;
  dataMode: DataMode;
  globalRevision: number;
  sources: Record<EntityId, Source>;
  intents: Record<EntityId, Intent>;
  captureDrafts: Record<EntityId, CaptureDraft>;
  protectedBlocks: Record<EntityId, ProtectedBlock>;
  requests: Record<EntityId, Request>;
  agreementRequests: Record<EntityId, AgreementRequest>;
  commitments: Record<EntityId, Commitment>;
  plans: Record<EntityId, Plan>;
  changeSets: Record<EntityId, ChangeSet>;
  approvals: Record<EntityId, Approval>;
  operations: Record<EntityId, Operation>;
  drafts: Record<EntityId, Draft>;
  checkpoints: Record<EntityId, Checkpoint>;
  materials: Record<EntityId, Material>;
  ruleset: RuleSet;
  attention: { budget: AttentionBudget; items: Record<EntityId, AttentionItem> };
  quietSessions: Record<EntityId, QuietSession>;
  ledger: LedgerEntry[];
  events: DomainEvent[];
  contextReview: ContextReviewState;
}

export interface CommandBase {
  commandId: string;
  entityId: EntityId | null;
  expectedRevision: number | null;
  actor: Actor;
  issuedAt: string;
}

export interface SaveCaptureDraftCommand extends CommandBase {
  type: "saveCaptureDraft";
  channel: CaptureChannel;
  raw: string;
  parsedFields?: Partial<ParsedFields>;
  ambiguityNote?: string | null;
  constraints?: Array<{ kind: string; expression: string; confirmed: boolean }>;
}

export interface CreateProtectedBlockCommand extends CommandBase {
  type: "createProtectedBlock";
  blockId: string;
  intentId: EntityId | null;
  date: string;
  startTime: string;
  endTime: string;
  timezone: string;
  purpose: string | null;
}

export interface SaveIntentCommand extends CommandBase {
  type: "saveIntent";
  raw: string;
  channel: CaptureChannel;
  parsedFields?: Partial<ParsedFields>;
  constraints?: Array<{ kind: string; expression: string; confirmed: boolean }>;
  ambiguityNote?: string | null;
}

export interface DiscardCaptureDraftCommand extends CommandBase {
  type: "discardCaptureDraft";
}

export interface CheckConflictCommand extends CommandBase {
  type: "checkConflict";
  range: TimeRange;
}

export interface AcceptRequestCommand extends CommandBase {
  type: "acceptRequest";
}

export interface ArchiveRequestCommand extends CommandBase {
  type: "archiveRequest";
  decision: "keepIdea" | "exclude";
}

export interface CreateAgreementRequestCommand extends CommandBase {
  type: "createAgreementRequest";
  requestId: EntityId;
  proposerId: string;
  recipientId: string;
  terms: AgreementTerms;
  expiresAt: string;
}

export interface RespondAgreementRequestCommand extends CommandBase {
  type: "respondAgreementRequest";
  actorId: string;
  termsVersion: number;
  termsHash: string;
  response: "accepted" | "rejected";
  reasonCode?: string | null;
}

export interface CounterProposeAgreementCommand extends CommandBase {
  type: "counterProposeAgreement";
  actorId: string;
  terms: AgreementTerms;
}

export interface WithdrawAgreementRequestCommand extends CommandBase {
  type: "withdrawAgreementRequest";
  actorId: string;
}

export interface UpdateCommitmentCommand extends CommandBase {
  type: "updateCommitment";
  scope?: string | null;
  deadline?: string | null;
  effortEstimateMinutes?: number | null;
  schedule?: CommitmentSchedule | null;
  mobility?: "fixed" | "flexible";
}

export interface SelectPlanCommand extends CommandBase {
  type: "selectPlan";
  kind: PlanKind;
}

export interface GrantApprovalCommand extends CommandBase {
  type: "grantApproval";
  changeSetId: EntityId;
  grants: GrantKey[];
}

export interface StartOperationCommand extends CommandBase {
  type: "startOperation";
  approvalId: EntityId;
}

export interface ReadbackOperationCommand extends CommandBase {
  type: "readbackOperation";
  report?: { stepId: EntityId; status: "completed" | "unknown" | "failed"; detail?: string } | null;
}

export interface ConfirmSectionsCommand extends CommandBase {
  type: "confirmSections";
  sections: Array<{ sectionId: EntityId; expectedContentVersion: number }>;
}

export interface EditDraftSectionCommand extends CommandBase {
  type: "editDraftSection";
  sectionId: EntityId;
  expectedContentVersion: number;
  content: string;
}

export interface FlagSectionIssueCommand extends CommandBase {
  type: "flagSectionIssue";
  sectionId: EntityId;
  issue: string;
}

export interface SaveCheckpointCommand extends CommandBase {
  type: "saveCheckpoint";
  draftId?: EntityId | null;
  nextStep?: string | null;
}

export interface ResumeCheckpointCommand extends CommandBase {
  type: "resumeCheckpoint";
}

export interface AppendCheckpointNoteCommand extends CommandBase {
  readonly type: "appendCheckpointNote";
  readonly verbatim: string;
  readonly channel: "text" | "voice";
}

export interface UpdateRulesCommand extends CommandBase {
  type: "updateRules";
  grants?: Partial<Record<GrantKey, boolean>>;
  dailyCapacityMinutes?: number;
  dailyReminderMax?: number;
  timezone?: string;
  summary: string;
}

export interface SubmitRuleCandidateCommand extends CommandBase {
  type: "submitRuleCandidate";
  proposedChanges: string;
  rationale: string;
}

export interface PauseAutomationCommand extends CommandBase {
  type: "pauseAutomation";
}

export interface ResumeAutomationCommand extends CommandBase {
  type: "resumeAutomation";
}

export interface DeliverAttentionCommand extends CommandBase {
  type: "deliverAttention";
  draftRef?: AttentionDraftRef;
  deliveryId: string;
  title: string;
  body?: string;
  source: AttentionSource;
  urgency: "normal" | "urgentClaim" | "risk";
  mergeKey?: string;
  riskBasis?: RiskBasis | null;
}

export interface DeferAttentionCommand extends CommandBase {
  type: "deferAttention";
  dueAt: string | null;
}

export interface ResurfaceAttentionCommand extends CommandBase {
  type: "resurfaceAttention";
}

export interface DismissAttentionCommand extends CommandBase {
  type: "dismissAttention";
}

export interface OpenQuietSessionCommand extends CommandBase {
  type: "openQuietSession";
  blockId: string;
  originRoute: string | null;
}

export interface DecideQuietCommand extends CommandBase {
  type: "decideQuiet";
  blockId: string;
  decision: Exclude<QuietDecision, "unchosen">;
}

export interface AssignToProtectedBlockCommand extends CommandBase {
  type: "assignToProtectedBlock";
  blockId: string;
  assignment: string;
}

export interface SyncSourceCommand extends CommandBase {
  type: "syncSource";
  provider: SourceProvider;
}

export interface RecheckCapacityCommand extends CommandBase {
  type: "recheckCapacity";
  actualMinutes: number;
}

export interface RegisterMaterialCommand extends CommandBase {
  type: "registerMaterial";
  entityId: EntityId;
  expectedRevision: number;
  actor: "user";
  name: string;
  version: number;
  content?: string;
  accessRef?: string;
  readPermission: MaterialReadPermission;
  sectionIds: EntityId[];
}

export interface WithdrawDraftCommand extends CommandBase {
  type: "withdrawDraft";
  entityId: EntityId;
  expectedRevision: number;
  actor: "user";
  reason?: string;
}

export type CommandType = DomainCommand["type"];

export interface EditIntentCommand extends CommandBase {
  type: "editIntent";
  verbatim: string;
  parsedFields: ParsedFields;
  constraints: Constraint[];
}

export interface PauseIntentCommand extends CommandBase { type: "pauseIntent" }
export interface ResumeIntentCommand extends CommandBase { type: "resumeIntent" }
export interface DeleteIntentCommand extends CommandBase { type: "deleteIntent" }

export type IntentLifecycleCommand = EditIntentCommand | PauseIntentCommand | ResumeIntentCommand | DeleteIntentCommand;

export interface ContextReviewCommand extends CommandBase {
  type: "contextReviewAction";
  action: ContextReviewAction;
}

export type DomainCommand =
  | CreateProtectedBlockCommand
  | SourceRevocationCommand
  | IntentLifecycleCommand
  | ContextReviewCommand
  | SaveCaptureDraftCommand
  | SaveIntentCommand
  | DiscardCaptureDraftCommand
  | CheckConflictCommand
  | AcceptRequestCommand
  | ArchiveRequestCommand
  | CreateAgreementRequestCommand
  | RespondAgreementRequestCommand
  | CounterProposeAgreementCommand
  | WithdrawAgreementRequestCommand
  | UpdateCommitmentCommand
  | SelectPlanCommand
  | GrantApprovalCommand
  | StartOperationCommand
  | ReadbackOperationCommand
  | ConfirmSectionsCommand
  | EditDraftSectionCommand
  | FlagSectionIssueCommand
  | SaveCheckpointCommand
  | ResumeCheckpointCommand
  | AppendCheckpointNoteCommand
  | UpdateRulesCommand
  | SubmitRuleCandidateCommand
  | PauseAutomationCommand
  | ResumeAutomationCommand
  | DeliverAttentionCommand
  | DeferAttentionCommand
  | ResurfaceAttentionCommand
  | DismissAttentionCommand
  | OpenQuietSessionCommand
  | DecideQuietCommand
  | AssignToProtectedBlockCommand
  | SyncSourceCommand
  | RecheckCapacityCommand
  | RegisterMaterialCommand
  | WithdrawDraftCommand;

export type FailureCode =
  | "NOT_IMPLEMENTED"
  | "INVALID_INPUT"
  | "ENTITY_NOT_FOUND"
  | "REVISION_CONFLICT"
  | "STORAGE_WRITE_FAILED"
  | "STORAGE_UNAVAILABLE"
  | "STORAGE_READ_FAILED"
  | "STORAGE_READBACK_UNVERIFIED"
  | "STORAGE_CORRUPT"
  | "MIGRATION_FAILED"
  | "CHANGE_SET_STALE"
  | "INVALID_GRANT"
  | "NO_EXECUTABLE_ACTIONS"
  | "APPROVAL_INVALID"
  | "AUTOMATION_PAUSED"
  | "USER_ONLY"
  | "DEPENDENCY_MISSING"
  | "INVALID_TRANSITION"
  | "CONFLICT";

export interface CommandFailure {
  ok: false;
  commandId: string;
  code: FailureCode;
  reason: string;
  retryable: boolean;
  details?: Record<string, unknown>;
}

export type ConflictOutcome =
  | { outcome: "none"; coverage: "known"; conflictIds: EntityId[] }
  | { outcome: "conflict"; coverage: "known"; conflictIds: EntityId[] }
  | { outcome: "unknown"; coverage: "unknown"; conflictIds: EntityId[]; note: string };

export interface AttentionDeliveryOutcome {
  delivered: boolean;
  duplicate: boolean;
  queued: boolean;
  merged: boolean;
  budgetCharged: boolean;
  budgetUsed: number;
  budgetMax: number;
  reason: string;
}

export type CommandDataOf<C extends DomainCommand> =
  C extends CreateProtectedBlockCommand ? { protectedBlock: ProtectedBlock; coverage: "unknown"; externalWrite: "none" }
  : C extends SourceRevocationCommand ? SourceRevocationData
  : C extends IntentLifecycleCommand ? { intent: Intent; invalidatedPlanIds: EntityId[]; invalidatedApprovalIds: EntityId[] }
  : C extends ContextReviewCommand ? { contextReview: ContextReviewState }
  : C extends SaveIntentCommand ? { intent: Intent; captureDraft?: CaptureDraft }
  : C extends SaveCaptureDraftCommand ? { captureDraft: CaptureDraft }
  : C extends DiscardCaptureDraftCommand ? { captureDraft: CaptureDraft }
  : C extends CheckConflictCommand ? { outcome: ConflictOutcome }
  : C extends AcceptRequestCommand ? { request: Request; commitment: Commitment; alreadyAccepted: boolean }
  : C extends ArchiveRequestCommand ? { request: Request }
  : C extends CreateAgreementRequestCommand ? { request: AgreementRequest }
  : C extends RespondAgreementRequestCommand ? { request: AgreementRequest; agreementFormed: boolean }
  : C extends CounterProposeAgreementCommand ? { request: AgreementRequest }
  : C extends WithdrawAgreementRequestCommand ? { request: AgreementRequest }
  : C extends UpdateCommitmentCommand ? { commitment: Commitment }
  : C extends SelectPlanCommand ? { plan: Plan; changeSet: ChangeSet }
  : C extends GrantApprovalCommand
    ? { approval: Approval; changeSet: ChangeSet; missingDependencies: string[]; reduced: boolean }
  : C extends StartOperationCommand ? { operation: Operation; alreadyExisted: boolean }
  : C extends ReadbackOperationCommand ? { operation: Operation }
  : C extends ConfirmSectionsCommand ? { draft: Draft; rejected: Array<{ sectionId: EntityId; reason: string }> }
  : C extends EditDraftSectionCommand ? { draft: Draft }
  : C extends FlagSectionIssueCommand ? { draft: Draft }
  : C extends SaveCheckpointCommand ? { checkpoint: Checkpoint }
  : C extends AppendCheckpointNoteCommand ? { checkpoint: Checkpoint }
  : C extends ResumeCheckpointCommand ? { checkpoint: Checkpoint; validation: ResumeValidation }
  : C extends UpdateRulesCommand ? { ruleset: RuleSet; invalidatedApprovalIds: EntityId[] }
  : C extends SubmitRuleCandidateCommand ? { attentionItem: AttentionItem }
  : C extends PauseAutomationCommand ? { ruleset: RuleSet }
  : C extends ResumeAutomationCommand ? { ruleset: RuleSet; invalidatedApprovalIds: EntityId[] }
  : C extends DeliverAttentionCommand ? { outcome: AttentionDeliveryOutcome; item: AttentionItem }
  : C extends DeferAttentionCommand ? { item: AttentionItem }
  : C extends ResurfaceAttentionCommand ? { item: AttentionItem; resurfaced: boolean; reason: string }
  : C extends DismissAttentionCommand ? { item: AttentionItem }
  : C extends OpenQuietSessionCommand ? { session: QuietSession }
  : C extends DecideQuietCommand ? { session: QuietSession }
  : C extends AssignToProtectedBlockCommand ? { block: ProtectedBlock }
  : C extends SyncSourceCommand ? { source: Source; syncResult: "success" | "failed" }
  : C extends RecheckCapacityCommand ? { conflictRecorded: boolean; affectedPlanIds: EntityId[] }
  : C extends RegisterMaterialCommand ? { material: Material; draft: Draft }
  : C extends WithdrawDraftCommand ? { draft: Draft }
  : { done: true };

export type CommandResult<C extends DomainCommand = DomainCommand> =
  | { ok: true; commandId: string; data: CommandDataOf<C> }
  | CommandFailure;
