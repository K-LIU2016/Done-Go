import assert from "node:assert/strict";
import test from "node:test";
import {
  createDomainStore,
  createInitialState,
  FIXTURE_IDS,
} from "../../domain/index.ts";
import type {
  CommandBase,
  CommandResult,
  CommandType,
  DomainCommand,
} from "../../domain/index.ts";
import {
  describeQuietBlock,
  formatIsoClock,
  planQuietRetry,
  quietCoverageKnown,
  selectLatestQuietSession,
  selectProtectedBlock,
  shouldOpenQuietSession,
  verifyDecisionRecorded,
} from "./quietSurface.ts";

const NOW = "2026-09-12T10:00:00+08:00";
const BLOCK_ID = "protected-2026-09-12-evening";

let commandSeq = 0;
let uuidSeq = 0;

function testUuid(): string {
  uuidSeq += 1;
  return "uuid-" + uuidSeq;
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
    actor: rest.actor ?? "user",
    issuedAt: NOW,
    ...rest,
  } as Extract<DomainCommand, { type: T }>;
}

function expectOk<C extends DomainCommand>(
  result: CommandResult<C>,
): Extract<CommandResult<C>, { ok: true }>["data"] {
  if (!result.ok) {
    throw new Error("expected ok, got " + result.code + ": " + result.reason);
  }
  return result.data;
}

function expectFail<C extends DomainCommand>(
  result: CommandResult<C>,
): Extract<CommandResult<C>, { ok: false }> {
  if (result.ok) throw new Error("expected failure, got ok");
  return result;
}

function newStore() {
  return createDomainStore({ dataMode: "fixture", now: () => NOW, uuid: testUuid });
}

test("default selection picks the real active fixture block without wall-clock claims", () => {
  const state = createInitialState("fixture");
  const selection = selectProtectedBlock(state, null);
  assert.equal(selection.kind, "selected");
  if (selection.kind !== "selected") return;
  assert.equal(selection.block.id, FIXTURE_IDS.protectedBlock);
  assert.equal(selection.block.blockId, BLOCK_ID);
  assert.equal(selection.block.range.timezone, "Asia/Shanghai");
  assert.equal(selection.block.status, "active");
});

test("explicit blockId must match exactly; invalid ids never fall back to another block", () => {
  const state = createInitialState("fixture");
  const explicit = selectProtectedBlock(state, BLOCK_ID);
  assert.equal(explicit.kind, "selected");
  if (explicit.kind === "selected") {
    assert.equal(explicit.block.blockId, BLOCK_ID);
  }
  const unknown = selectProtectedBlock(state, "protected-does-not-exist");
  assert.equal(unknown.kind, "notFound");
  if (unknown.kind === "notFound") {
    assert.equal(unknown.blockId, "protected-does-not-exist");
    assert.match(unknown.reason, /没有匹配/);
  }
});

test("selection is empty and honest when no active block exists", () => {
  const state = { ...createInitialState("fixture"), protectedBlocks: {} };
  assert.equal(selectProtectedBlock(state, null).kind, "empty");
});

test("time formatting uses the block's own written clock or fails explicitly", () => {
  assert.equal(formatIsoClock("2026-09-12T19:00:00+08:00"), "19:00");
  assert.equal(formatIsoClock("2026-09-12T07:05+08:00"), "07:05");
  assert.equal(formatIsoClock("not-a-time"), null);
  const state = createInitialState("fixture");
  const selection = selectProtectedBlock(state, null);
  if (selection.kind !== "selected") throw new Error("expected selected block");
  const surface = describeQuietBlock(selection.block);
  assert.equal(surface.start, "19:00");
  assert.equal(surface.end, "20:00");
  assert.equal(surface.timezone, "Asia/Shanghai");
  assert.equal(surface.purpose, null);
});

test("quiet sessions: open once, reuse decided sessions on reopen", async () => {
  const store = newStore();
  const latestBefore = selectLatestQuietSession(store.getState(), BLOCK_ID);
  assert.equal(latestBefore, null);
  assert.equal(shouldOpenQuietSession(latestBefore), true);

  const opened = expectOk(
    await store.execute(cmd("openQuietSession", { entityId: null, expectedRevision: null, blockId: BLOCK_ID, originRoute: null })),
  );
  assert.equal(opened.session.decision, "unchosen");
  assert.equal(quietCoverageKnown(opened.session), true);

  const latestOpen = selectLatestQuietSession(store.getState(), BLOCK_ID);
  assert.equal(latestOpen?.id, opened.session.id);
  assert.equal(shouldOpenQuietSession(latestOpen), false);

  const stale = expectFail(
    await store.execute(cmd("decideQuiet", { entityId: opened.session.id, expectedRevision: 99, blockId: BLOCK_ID, decision: "keepStill" })),
  );
  assert.equal(stale.code, "REVISION_CONFLICT");
  assert.equal(stale.retryable, true);

  const decided = expectOk(
    await store.execute(cmd("decideQuiet", { entityId: opened.session.id, expectedRevision: 1, blockId: BLOCK_ID, decision: "keepStill" })),
  );
  assert.equal(decided.session.decision, "keepStill");
  assert.equal(decided.session.suppressPrompts, true);

  const latestDecided = selectLatestQuietSession(store.getState(), BLOCK_ID);
  assert.equal(latestDecided?.id, opened.session.id);
  assert.equal(latestDecided?.decision, "keepStill");
  assert.equal(shouldOpenQuietSession(latestDecided), false);
  assert.equal(verifyDecisionRecorded(store.getState(), opened.session.id, "keepStill"), true);
  assert.equal(verifyDecisionRecorded(store.getState(), opened.session.id, "exit"), false);
  assert.equal(verifyDecisionRecorded(store.getState(), "missing-id", "keepStill"), false);

  const naiveReopen = expectOk(
    await store.execute(cmd("openQuietSession", { entityId: null, expectedRevision: null, blockId: BLOCK_ID, originRoute: null })),
  );
  assert.notEqual(naiveReopen.session.id, opened.session.id);
});

test("retry planning: stale revision rederives; write-unknown failures replay exactly", () => {
  assert.equal(planQuietRetry("REVISION_CONFLICT"), "rederiveFromState");
  assert.equal(planQuietRetry("STORAGE_WRITE_FAILED"), "replayExact");
  assert.equal(planQuietRetry("STORAGE_READBACK_UNVERIFIED"), "replayExact");
});
