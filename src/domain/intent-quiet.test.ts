/// <reference types="node" />
import assert from "node:assert/strict";
import test from "node:test";
import {
  FIXTURE_DAY,
  FIXTURE_IDS,
  createDomainStore,
  isProtectedSuppressed,
  selectCapacitySummary,
} from "./index.ts";
import type {
  CommandBase,
  CommandDataOf,
  CommandResult,
  CommandType,
  DomainCommand,
  FailureCode,
} from "./index.ts";
import { InMemoryStorage } from "../data/storage.ts";
import { createPersistedDomainStore } from "../data/persistedStore.ts";
import type { PersistedDomainHandle } from "../data/persistedStore.ts";

const NOW = "2026-09-12T10:00:00+08:00";
let commandSeq = 0;
let uuidSeq = 0;

function testUuid(): string {
  uuidSeq += 1;
  return "uuid-" + uuidSeq;
}

function newStore() {
  return createDomainStore({ dataMode: "fixture", now: () => NOW, uuid: testUuid });
}

function cmd<T extends CommandType>(
  type: T,
  rest: Omit<Extract<DomainCommand, { type: T }>, "type" | "commandId" | "actor" | "issuedAt"> &
    Partial<Pick<CommandBase, "actor" | "commandId">>,
): Extract<DomainCommand, { type: T }> {
  commandSeq += 1;
  return {
    type,
    commandId: rest.commandId ?? "cmd-" + commandSeq,
    actor: "user",
    issuedAt: NOW,
    ...rest,
  } as Extract<DomainCommand, { type: T }>;
}

function asOk<T extends DomainCommand>(result: CommandResult<T>): CommandDataOf<T> {
  if (!result.ok) throw new Error("expected ok, got " + result.code + ": " + result.reason);
  return result.data;
}

function asFailure(result: CommandResult<DomainCommand>): { code: FailureCode; reason: string } {
  if (result.ok) throw new Error("expected failure, got ok");
  return result;
}

function expectReady(handle: PersistedDomainHandle) {
  if (handle.status !== "ready") throw new Error("expected ready, got " + handle.status);
  return handle;
}

function range(start: string, end: string) {
  return { start, end, timezone: "Asia/Shanghai" };
}

test("saveCaptureDraft persists raw input with channel and keeps it open", async () => {
  const store = newStore();
  const data = asOk(
    await store.execute(
      cmd("saveCaptureDraft", { entityId: null, expectedRevision: null, channel: "text", raw: "周五下午腾两小时对齐方案" }),
    ),
  );
  assert.equal(data.captureDraft.raw, "周五下午腾两小时对齐方案");
  assert.equal(data.captureDraft.channel, "text");
  assert.equal(data.captureDraft.status, "open");
  assert.ok(store.getState().captureDrafts[data.captureDraft.id]);
});

test("capture draft survives a full persisted reload", async () => {
  const storage = new InMemoryStorage();
  const first = expectReady(await createPersistedDomainStore({ dataMode: "fixture", storage }));
  const saved = asOk(
    await first.store.execute(
      cmd("saveCaptureDraft", { entityId: null, expectedRevision: null, channel: "voice", raw: "语音转写:下周三之前交初稿" }),
    ),
  );
  const second = expectReady(await createPersistedDomainStore({ dataMode: "fixture", storage }));
  const reloaded = second.store.getState().captureDrafts[saved.captureDraft.id];
  assert.ok(reloaded);
  assert.equal(reloaded.raw, "语音转写:下周三之前交初稿");
  assert.equal(reloaded.status, "open");
});

test("discardCaptureDraft marks the draft discarded", async () => {
  const store = newStore();
  const saved = asOk(
    await store.execute(cmd("saveCaptureDraft", { entityId: null, expectedRevision: null, channel: "text", raw: "临时想法" })),
  );
  const data = asOk(
    await store.execute(cmd("discardCaptureDraft", { entityId: saved.captureDraft.id, expectedRevision: 1 })),
  );
  assert.equal(data.captureDraft.status, "discarded");
});

test("saveIntent rejects empty verbatim and invalid intervals", async () => {
  const store = newStore();
  const empty = asFailure(
    await store.execute(cmd("saveIntent", { entityId: null, expectedRevision: null, raw: "   ", channel: "text" })),
  );
  assert.equal(empty.code, "INVALID_INPUT");
  const inverted = asFailure(
    await store.execute(
      cmd("saveIntent", {
        entityId: null,
        expectedRevision: null,
        raw: "晚上开会",
        channel: "text",
        parsedFields: { date: FIXTURE_DAY, startTime: "21:00", endTime: "19:00", timezone: "Asia/Shanghai" },
      }),
    ),
  );
  assert.equal(inverted.code, "INVALID_INPUT");
  assert.equal(Object.keys(store.getState().intents).length, 1);
});

test("saveIntent stores verbatim with editable parsed fields as saved", async () => {
  const store = newStore();
  const data = asOk(
    await store.execute(
      cmd("saveIntent", {
        entityId: null,
        expectedRevision: null,
        raw: "周四上午写评审意见",
        channel: "shortcut",
        parsedFields: { date: "2026-09-17", startTime: "09:00", endTime: "11:00", timezone: "Asia/Shanghai", topic: "评审意见" },
      }),
    ),
  );
  assert.equal(data.intent.verbatim, "周四上午写评审意见");
  assert.equal(data.intent.status, "saved");
  assert.equal(data.intent.parsedFields.topic, "评审意见");
  assert.equal(data.intent.channel, "shortcut");
});

test("saveIntent without parsed fields records ambiguity and executes nothing", async () => {
  const store = newStore();
  const before = store.getState();
  const data = asOk(
    await store.execute(cmd("saveIntent", { entityId: null, expectedRevision: null, raw: "找时间处理合作方反馈", channel: "share" })),
  );
  assert.equal(data.intent.status, "ambiguous");
  assert.ok(data.intent.ambiguityNote);
  const after = store.getState();
  assert.equal(Object.keys(after.commitments).length, Object.keys(before.commitments).length);
  assert.equal(Object.keys(after.plans).length, 0);
});

test("checkConflict reports overlap with a scheduled commitment", async () => {
  const store = newStore();
  const data = asOk(
    await store.execute(
      cmd("checkConflict", { entityId: null, expectedRevision: null, range: range(FIXTURE_DAY + "T17:05:00+08:00", FIXTURE_DAY + "T17:25:00+08:00") }),
    ),
  );
  assert.equal(data.outcome.outcome, "conflict");
  if (data.outcome.outcome !== "conflict") throw new Error("unreachable");
  assert.equal(data.outcome.coverage, "known");
  assert.ok(data.outcome.conflictIds.includes(FIXTURE_IDS.commitmentMeeting));
});

test("checkConflict reports protected-block overlap as a conflict", async () => {
  const store = newStore();
  const data = asOk(
    await store.execute(
      cmd("checkConflict", { entityId: null, expectedRevision: null, range: range(FIXTURE_DAY + "T19:15:00+08:00", FIXTURE_DAY + "T19:45:00+08:00") }),
    ),
  );
  assert.equal(data.outcome.outcome, "conflict");
  if (data.outcome.outcome !== "conflict") throw new Error("unreachable");
  assert.ok(data.outcome.conflictIds.includes(FIXTURE_IDS.protectedBlock));
});

test("checkConflict returns unknown outside known coverage and does not mutate state", async () => {
  const store = newStore();
  const revisionBefore = store.getState().globalRevision;
  const data = asOk(
    await store.execute(
      cmd("checkConflict", { entityId: null, expectedRevision: null, range: range(FIXTURE_DAY + "T22:00:00+08:00", FIXTURE_DAY + "T23:00:00+08:00") }),
    ),
  );
  assert.equal(data.outcome.outcome, "unknown");
  if (data.outcome.outcome !== "unknown") throw new Error("unreachable");
  assert.equal(data.outcome.coverage, "unknown");
  assert.ok(data.outcome.note.length > 0);
  assert.equal(store.getState().globalRevision, revisionBefore);
});

test("acceptRequest creates exactly one commitment with unknowns preserved; repeat is idempotent", async () => {
  const store = newStore();
  const first = asOk(await store.execute(cmd("acceptRequest", { entityId: FIXTURE_IDS.request, expectedRevision: 1 })));
  assert.equal(first.alreadyAccepted, false);
  assert.equal(first.request.status, "accepted");
  assert.equal(first.commitment.requestId, FIXTURE_IDS.request);
  assert.equal(first.commitment.acceptedBy, "user");
  assert.equal(first.commitment.scope, null);
  assert.equal(first.commitment.deadline, null);
  assert.equal(first.commitment.effortEstimateMinutes, null);
  assert.equal(first.commitment.scopeStatus, "pendingDetails");
  const repeat = asOk(await store.execute(cmd("acceptRequest", { entityId: FIXTURE_IDS.request, expectedRevision: 2 })));
  assert.equal(repeat.alreadyAccepted, true);
  assert.equal(repeat.commitment.id, first.commitment.id);
  assert.equal(Object.keys(store.getState().commitments).length, 4);
});

test("acceptRequest rejects model actor and stale revisions", async () => {
  const store = newStore();
  const byModel = asFailure(
    await store.execute(cmd("acceptRequest", { entityId: FIXTURE_IDS.request, expectedRevision: 1, actor: "model" })),
  );
  assert.equal(byModel.code, "USER_ONLY");
  const stale = asFailure(await store.execute(cmd("acceptRequest", { entityId: FIXTURE_IDS.request, expectedRevision: 99 })));
  assert.equal(stale.code, "REVISION_CONFLICT");
  assert.equal(store.getState().requests[FIXTURE_IDS.request].status, "candidate");
});

test("archiveRequest records keepIdea and exclude without touching capacity", async () => {
  const store = newStore();
  const kept = asOk(await store.execute(cmd("archiveRequest", { entityId: FIXTURE_IDS.request, expectedRevision: 1, decision: "keepIdea" })));
  assert.equal(kept.request.status, "archived");
  const capacity = selectCapacitySummary(store.getState(), FIXTURE_DAY);
  assert.equal(capacity.committedKnownMinutes, 130);
});

test("updateCommitment: unknown effort stays incomplete until a real estimate exists; zero is rejected", async () => {
  const store = newStore();
  const accepted = asOk(await store.execute(cmd("acceptRequest", { entityId: FIXTURE_IDS.request, expectedRevision: 1 })));
  const commitmentId = accepted.commitment.id;
  await store.execute(cmd("updateCommitment", { entityId: commitmentId, expectedRevision: 1, schedule: { date: FIXTURE_DAY, startMinute: 900, endMinute: 945, timezone: "Asia/Shanghai" } }));
  const incomplete = selectCapacitySummary(store.getState(), FIXTURE_DAY);
  assert.equal(incomplete.incomplete, true);
  assert.equal(incomplete.gapMinutes, null);
  const zero = asFailure(await store.execute(cmd("updateCommitment", { entityId: commitmentId, expectedRevision: 2, effortEstimateMinutes: 0 })));
  assert.equal(zero.code, "INVALID_INPUT");
  const updated = asOk(await store.execute(cmd("updateCommitment", { entityId: commitmentId, expectedRevision: 2, effortEstimateMinutes: 45, scope: "合作方反馈回复", deadline: "2026-09-15T18:00:00+08:00" })));
  assert.equal(updated.commitment.effortEstimateMinutes, 45);
  assert.equal(updated.commitment.scopeStatus, "clarified");
  const summary = selectCapacitySummary(store.getState(), FIXTURE_DAY);
  assert.equal(summary.committedKnownMinutes, 175);
  assert.equal(summary.gapMinutes, 55);
});

test("openQuietSession creates an unchosen session and never charges attention budget", async () => {
  const store = newStore();
  const data = asOk(
    await store.execute(cmd("openQuietSession", { entityId: null, expectedRevision: null, blockId: "protected-2026-09-12-evening", originRoute: "/now" })),
  );
  assert.equal(data.session.decision, "unchosen");
  assert.equal(data.session.suppressPrompts, false);
  assert.equal(store.getState().attention.budget.used, 1);
  const repeat = asOk(
    await store.execute(cmd("openQuietSession", { entityId: null, expectedRevision: null, blockId: "protected-2026-09-12-evening", originRoute: "/now" })),
  );
  assert.equal(repeat.session.id, data.session.id);
});

test("keepStill decision suppresses prompts for the block and persists across reload", async () => {
  const storage = new InMemoryStorage();
  const first = expectReady(await createPersistedDomainStore({ dataMode: "fixture", storage }));
  const opened = asOk(
    await first.store.execute(cmd("openQuietSession", { entityId: null, expectedRevision: null, blockId: "protected-2026-09-12-evening", originRoute: "/now" })),
  );
  const decided = asOk(
    await first.store.execute(cmd("decideQuiet", { entityId: opened.session.id, expectedRevision: 1, blockId: "protected-2026-09-12-evening", decision: "keepStill" })),
  );
  assert.equal(decided.session.decision, "keepStill");
  assert.equal(decided.session.suppressPrompts, true);
  assert.equal(isProtectedSuppressed(first.store.getState(), "protected-2026-09-12-evening"), true);
  const second = expectReady(await createPersistedDomainStore({ dataMode: "fixture", storage }));
  assert.equal(isProtectedSuppressed(second.store.getState(), "protected-2026-09-12-evening"), true);
});

test("exit decision persists without creating leftover tasks", async () => {
  const store = newStore();
  const opened = asOk(
    await store.execute(cmd("openQuietSession", { entityId: null, expectedRevision: null, blockId: "protected-2026-09-12-evening", originRoute: "/now" })),
  );
  const decided = asOk(
    await store.execute(cmd("decideQuiet", { entityId: opened.session.id, expectedRevision: 1, blockId: "protected-2026-09-12-evening", decision: "exit" })),
  );
  assert.equal(decided.session.decision, "exit");
  assert.equal(decided.session.suppressPrompts, true);
  assert.ok(decided.session.dismissedAt);
  assert.equal(Object.keys(store.getState().commitments).length, 3);
});

test("assignToProtectedBlock is user-only and records the explicit change", async () => {
  const store = newStore();
  const byAutomation = asFailure(
    await store.execute(cmd("assignToProtectedBlock", { entityId: null, expectedRevision: null, blockId: "protected-2026-09-12-evening", assignment: "加急会议", actor: "automation" })),
  );
  assert.equal(byAutomation.code, "USER_ONLY");
  const byModel = asFailure(
    await store.execute(cmd("assignToProtectedBlock", { entityId: null, expectedRevision: null, blockId: "protected-2026-09-12-evening", assignment: "AI 建议", actor: "model" })),
  );
  assert.equal(byModel.code, "USER_ONLY");
  const byUser = asOk(
    await store.execute(cmd("assignToProtectedBlock", { entityId: null, expectedRevision: null, blockId: "protected-2026-09-12-evening", assignment: "本人决定改为写周报" })),
  );
  assert.equal(byUser.block.purpose, "本人决定改为写周报");
  assert.equal(byUser.block.revision, 2);
});
