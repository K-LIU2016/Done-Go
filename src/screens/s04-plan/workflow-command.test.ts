import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createDomainStore, FIXTURE_IDS } from "../../domain/index.ts";
import type { DomainCommand, DomainStore, GrantKey } from "../../domain/index.ts";
import { preparePlan } from "./planPreparation.ts";
import { assertWorkflowResumeTarget, workflowAttemptKey, workflowCommands } from "./workflow-command.ts";

for (const stage of ["grantApproval", "startOperation", "readbackOperation"]) {
  test("desktop " + stage + " uses shared immutable workflow command execution", () => {
    const source = readFileSync(new URL("../s05-preview/S05Preview.tsx", import.meta.url), "utf8").replaceAll("\r\n", "\n");
    assert.ok(source.includes("workflow.run(workflowKey, {\n            type: \"" + stage + "\"") || source.includes("workflow.run(workflowKey, {\n          type: \"" + stage + "\""), stage + " must not reconstruct an uncached command at retry");
  });
}

for (const stage of ["grantApproval", "startOperation", "readbackOperation"] as const) {
  test(stage + " unknown acknowledgement reuses the exact snapshot after controller reacquisition and consumes once", async () => {
    let armed = false;
    let commits = 0;
    const sent: DomainCommand[] = [];
    const base = createDomainStore({ dataMode: "fixture", commit: async () => {
      commits++;
      if (armed) { armed = false; return { ok: false, code: "STORAGE_READBACK_UNVERIFIED", reason: "unknown durable readback", retryable: true }; }
      return { ok: true };
    } });
    const store: DomainStore = { ...base, execute: async command => {
      sent.push(structuredClone(command));
      if (stage === "readbackOperation" && armed && command.type === "readbackOperation") {
        armed = false;
        await base.execute(command);
        return { ok: false, commandId: command.commandId, code: "STORAGE_READBACK_UNVERIFIED", reason: "readback acknowledgement unknown", retryable: true };
      }
      return base.execute(command);
    } };
    const proposal = await preparePlan(store, FIXTURE_IDS.intent, "A");
    const key = workflowAttemptKey(FIXTURE_IDS.intent, "A");
    const workflow = workflowCommands(store);
    const grants: GrantKey[] = ["readMaterial", "createLocalDraft"];
    const common = { actor: "user" as const, issuedAt: "2026-09-13T01:00:00Z" };
    const grantCommand = { ...common, type: "grantApproval" as const, commandId: "test-grant", entityId: proposal.plan.id, expectedRevision: proposal.plan.revision, changeSetId: proposal.changeSet.id, grants };
    let command: DomainCommand = grantCommand;
    if (stage !== "grantApproval") {
      const approval = await workflow.run(key, grantCommand, grants);
      assert.equal(approval.ok, true);
      if (!approval.ok) return;
      const start = { ...common, type: "startOperation" as const, commandId: "test-start", entityId: approval.data.approval.id, expectedRevision: approval.data.approval.revision, approvalId: approval.data.approval.id };
      command = start;
      if (stage === "readbackOperation") {
        const operation = await workflow.run(key, start, grants);
        assert.equal(operation.ok, true);
        if (!operation.ok) return;
        command = { ...common, type: "readbackOperation", commandId: "test-readback", entityId: operation.data.operation.id, expectedRevision: operation.data.operation.revision };
      }
    }
    armed = true;
    const failed = await workflow.run(key, command, grants);
    assert.equal(failed.ok, false);
    const original = structuredClone(sent.at(-1));
    assert.ok(workflow.getSnapshot().pending);
    const pending = workflow.getSnapshot().pending;
    const reentered = workflowCommands(store);
    assert.equal(reentered, workflow);
    const writesBeforeWrongScope = commits;
    await assert.rejects(reentered.run(key, command, [...grants, "updateEstimate"]), /未决操作/);
    await assert.rejects(reentered.run(workflowAttemptKey("other", "A"), command, grants), /未决操作/);
    assert.equal(commits, writesBeforeWrongScope);
    const retry = await reentered.run(key, { ...command, issuedAt: "2026-09-13T04:00:00Z" }, grants);
    assert.equal(retry.ok, true);
    assertWorkflowResumeTarget(store.getState(), pending, proposal.plan.id);
    assert.throws(() => assertWorkflowResumeTarget(store.getState(), pending, "new-latest-plan"), /不会批准另一方案/);
    assert.deepEqual(sent.at(-1), original);
    assert.equal(reentered.getSnapshot().pending, null);
    const settledWrites = commits;
    const repeated = await reentered.run(key, { ...command, issuedAt: "2026-09-13T06:00:00Z" }, grants);
    assert.equal(repeated.ok, true);
    assert.equal(commits, settledWrites);
    const savedApproval = Object.values(store.getState().approvals)[0];
    if (Object.values(store.getState().operations).length === 0) {
      const started = await reentered.run(key, { ...common, type: "startOperation", commandId: "finish-start", entityId: savedApproval.id, expectedRevision: savedApproval.revision, approvalId: savedApproval.id }, grants);
      assert.equal(started.ok, true);
    }
    const savedOperation = Object.values(store.getState().operations)[0];
    const final = await reentered.run(key, { ...common, type: "readbackOperation", commandId: "finish-readback", entityId: savedOperation.id, expectedRevision: savedOperation.revision }, grants);
    assert.equal(final.ok, true);
    assert.equal(Object.values(store.getState().approvals).length, 1);
    assert.equal(Object.values(store.getState().approvals)[0].status, "consumed");
    assert.equal(Object.values(store.getState().operations).length, 1);
    assert.equal(Object.values(store.getState().drafts).length, 1);
  });
}

test("mobile restores pending grants on remount and disables scope changes", () => {
  const source = readFileSync(new URL("../s17-m-auth/S17MAuth.tsx", import.meta.url), "utf8");
  assert.match(source, /pending\.grants\.includes\("readMaterial"\)/);
  assert.match(source, /disabled=\{phase === "running" \|\| used \|\| workflowSnapshot\.pending !== null\}/);
  assert.doesNotMatch(source, /attemptIssuedAtRef/);
});

test("definitive prewrite revision conflict releases pending and allows explicit re-preview with original grants", async () => {
  let rejectCommit = false;
  const store = createDomainStore({ dataMode: "fixture", commit: async () => {
    if (rejectCommit) { rejectCommit = false; return { ok: false, code: "REVISION_CONFLICT", reason: "another revision won before write", retryable: true }; }
    return { ok: true };
  } });
  const proposal = await preparePlan(store, FIXTURE_IDS.intent, "A");
  const workflow = workflowCommands(store);
  const key = workflowAttemptKey(FIXTURE_IDS.intent, "A");
  const grants: GrantKey[] = ["readMaterial", "createLocalDraft"];
  const stale = { type: "grantApproval" as const, commandId: "stale-preview", entityId: proposal.plan.id, expectedRevision: proposal.plan.revision, actor: "user" as const, issuedAt: "2026-09-13T01:00:00Z", changeSetId: proposal.changeSet.id, grants };
  rejectCommit = true;
  const rejected = await workflow.run(key, stale, grants);
  assert.equal(rejected.ok, false);
  if (!rejected.ok) assert.equal(rejected.code, "REVISION_CONFLICT");
  assert.equal(workflow.getSnapshot().pending, null);
  assert.deepEqual(grants, ["readMaterial", "createLocalDraft"]);
  assert.equal(Object.values(store.getState().approvals).length, 0);
  const fresh = await preparePlan(store, FIXTURE_IDS.intent, "A");
  const approved = await workflow.run(key, { ...stale, commandId: "explicit-new-preview", entityId: fresh.plan.id, expectedRevision: fresh.plan.revision, changeSetId: fresh.changeSet.id }, grants);
  assert.equal(approved.ok, true);
  assert.equal(Object.values(store.getState().approvals).length, 1);
  assert.equal(Object.values(store.getState().operations).length, 0);
});

test("commit success followed by external adoption is postwrite conflict and retains exact uncertain command", async () => {
  let adoptAfterWrite = false;
  let store: DomainStore;
  store = createDomainStore({ dataMode: "fixture", commit: async (_expected, next) => {
    if (adoptAfterWrite) {
      adoptAfterWrite = false;
      const external = structuredClone(next);
      external.globalRevision++;
      store.adoptExternalState(external);
    }
    return { ok: true };
  } });
  const proposal = await preparePlan(store, FIXTURE_IDS.intent, "A");
  const workflow = workflowCommands(store);
  const key = workflowAttemptKey(FIXTURE_IDS.intent, "A");
  const grants: GrantKey[] = ["readMaterial", "createLocalDraft"];
  const command = { type: "grantApproval" as const, commandId: "postwrite-conflict", entityId: proposal.plan.id, expectedRevision: proposal.plan.revision, actor: "user" as const, issuedAt: "2026-09-13T01:00:00Z", changeSetId: proposal.changeSet.id, grants };
  adoptAfterWrite = true;
  const result = await workflow.run(key, command, grants);
  assert.equal(result.ok, false);
  if (!result.ok) { assert.equal(result.code, "REVISION_CONFLICT"); assert.equal(result.details?.stage, "postwrite"); }
  assert.equal(workflow.getSnapshot().pending?.uncertain, true);
  assert.deepEqual(workflow.getSnapshot().pending?.command, command);
  await assert.rejects(workflow.run(key, command, ["updateEstimate"]), /未决操作/);
  const retry = await workflow.run(key, { ...command, issuedAt: "2026-09-13T02:00:00Z" }, grants);
  assert.equal(retry.ok, false);
  assert.deepEqual(workflow.getSnapshot().pending?.command, command);
  assert.equal(workflow.getSnapshot().pending?.uncertain, true);
});
