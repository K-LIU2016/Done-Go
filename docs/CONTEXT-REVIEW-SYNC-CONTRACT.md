# S11–S13 shared-state completion contract

> **历史资料边界（2026-10-16）**：本文保留旧 React/服务端共享状态合同，供追溯与后续研究使用。它不定义当前产品入口、当前实现或上线标准。当前唯一产品基准是 http://localhost:5207/#today，主架构以 DONEGO-CANONICAL-ARCHITECTURE-2026-10-16.md 为准。

Status: implementation contract with partial runtime acceptance. The original inspection on 2026-09-13 found missing entities/commands; the later shared-model integration and bounded browser results are recorded below. This preserves original DELIVERY-MATRIX requirements and does not introduce a second storage system.

## Evidence and chosen boundary

Historical RED: DomainState initially lacked manageable inference and week-specific feedback/confirmation entities. S11 rejected and S12 feeling were React-only state; S13 retry was a fixed timer and local fallback was a boolean.

Current VERIFIED increment: DomainState.contextReview, the contextReviewAction handler and legacy-safe validation now persist these entities in the existing store. Root in-app browser actions confirmed rejected-inference, skipped-feedback and local-only refresh durability, local-only rejection of unknown future scheduling, and explicit recheck before returning connected. See `.omo/evidence/root-iab-closeout-20260913.md`. This does not close every lifecycle, export or provider scenario below.

Ledger has category/certainty/effectiveDate/refs and supports exact read-only accounting; estimated protected duration must not become observed retained time. Generic events are audit receipts, not a replacement for editable domain records.

Choose additive typed entities/commands in the existing DomainState, the same command serialization/optimistic concurrency/readback and the same persistence namespace. Reject page-local storage or using arbitrary event.summary as an untyped database. New domain feature types may live in an independent context-review model module; common type/registry/state integration is owned by the existing domain owner. Data envelope validation must accept missing new collections in legacy records as unknown/empty and validate their structure when present, never reset old data. No schema migration may manufacture historical confirmations.

## S11 intents, evidence and inferences

- The intent tab reads actual Intent records; facts/source tab reads actual authorized source snapshots and their coverage/status/time. Source absence is unknown, not free time.
- Intent editing captures id/revision and explicit fields. Pause affects future use/suggestions; it does not erase already approved responsibilities or silently cancel protected time. Deletion needs explicit confirmation, removes the current user-facing content and prevents future plan use, while preserving minimal historical operation references. Invalidated plans/approvals must not continue against the previous revision. Exact content-retention/deletion scope must be shown in UI; do not promise erasure of external copies.
- A typed Inference record retains id/revision, statement, evidence references/summary, origin, created/review-due time, and status pending/acknowledged/rejected/deleted. Acknowledged means the user says it broadly fits, not that it became a fact or permanent preference. Only user commands can acknowledge/reject/delete. Rejected/deleted items are excluded from future use; expired items need review and are not silently renewed. Deletion clears current inference text/evidence text while retaining a minimal tombstone for no-reapplication semantics.
- Empty inference collection shows an honest empty state. A fixture inference must be explicitly labeled as a design fixture, with fixture evidence, never fake claims about the real user's recent behavior.
- Manage sources links to the existing /boundaries or /sync owner surfaces. Export uses an explicit allowlisted versioned DTO and a real downloadable file. Export includes user-selected record categories and provenance/status; excluded by default: LLM configuration/key/proof/fingerprint, connector credentials, arbitrary provider params, material bodies/references. Material-content export requires separate explicit local export choice and cannot bypass current effective read permission. Never dump all localStorage or the raw entire DomainState.

## S12 observed review and feedback

- Review periods are explicit weekStart + timezone. Ledger selectors group actual entries, respecting effectiveDate, category, certainty and supersedesId; estimated reduction, future debt and measured supervision cost stay separate. No total net-saving number without measured evidence.
- Typed weekly feedback stores period, selected value more-control/same/harder/skipped, user/time/revision. Skip is a durable normal outcome, not a missing survey to prompt again. Editing feedback is an explicit new user revision, not automatic overwrite.
- A retained-time observation binds blockId + blockRevision + date and user-confirmed observed minutes/outcome, separately from intended duration. User confirmation cannot relabel seed estimated entries as measured or invent missing days. Unobserved periods stay unknown. A not-retained outcome remains visible; correction supersedes the previous observation rather than double counting it.
- Each retained/future-debt/supervision row opens real ledger/observation details with source refs, uncertainty and unresolved responsibility. Week confirmation captures the exact record versions reviewed; later changes make the confirmation stale.

## S13 sources and local fallback

- Render each real Source's connector identity, status, lastSuccessAt, coverage, lastUsableSnapshot and failure receipt. No hardcoded four connected sources or fabricated sync time.
- Retry goes through the existing SourceProvider interface and syncSource command with source revision. Missing adapter is a typed unavailable outcome, not a delayed fake failure. Fixture adapters expose deterministic success/failure/timeout for local acceptance and are visibly labeled fixture; they cannot count as an external account connection.
- Before any provider access, domain enforcement checks effective source permission, revoked state and automation pause as applicable. Failure preserves the previous usable snapshot marked stale; unknown coverage is not assignable capacity.
- Source access revocation records an explicit outcome and blocks future access. It cannot promise to recall external copies. Original-calendar handoff is enabled only for a validated actual object URL supplied by the source; otherwise the button gives a clear unavailable reason and makes no invented navigation.
- Local-only mode is a typed persisted safety preference, not a page boolean. It retains local protected rules, prevents allocating unknown external intervals, and never changes external protection into verified. Returning to connected mode requires a successful explicit recheck.

## Required evidence

Failing-first current UI checks (refresh loses rejection/feedback/fallback or actions inert), focused typed command tests, compatibility/optimistic-conflict tests, real browser actions on allowed Ego/built-in surfaces, actual local export artifact inspection, source fixture success/failure plus no-provider behavior. Real account and microphone/external-provider regimes remain separately labeled and cannot be inferred from fixture tests. Final C1–C5 require these rows, not just this document.
