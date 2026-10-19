import assert from "node:assert/strict";
import { test } from "node:test";
import { createDomainStore } from "./store.ts";
import { createInitialState } from "./state.ts";

function command<T extends Parameters<ReturnType<typeof createDomainStore>["execute"]>[0]>(value: T): T {
  return value;
}

test("P1 agreement commands persist versioned acceptance and form an agreement only after both parties accept", async () => {
  const store = createDomainStore({ dataMode: "fixture", initialState: createInitialState("fixture"), now: () => "2026-09-12T10:00:00+08:00", uuid: (() => { let n = 0; return () => "agreement-event-" + String(++n); })() });
  const before = store.getState().agreementRequests["fx-agreement-01"];
  const version = before.versions[0];

  const first = await store.execute(command({
    type: "respondAgreementRequest",
    commandId: "agreement-accept-user",
    entityId: before.id,
    expectedRevision: before.revision,
    actor: "user",
    actorId: "user",
    termsVersion: version.version,
    termsHash: version.termsHash,
    response: "accepted",
    issuedAt: "2026-09-12T10:00:00+08:00",
  }));
  assert.equal(first.ok, true);
  const waiting = store.getState().agreementRequests[before.id];
  assert.equal(waiting.status, "received");
  assert.equal(waiting.agreement, null);

  const second = await store.execute(command({
    type: "respondAgreementRequest",
    commandId: "agreement-accept-colleague",
    entityId: before.id,
    expectedRevision: waiting.revision,
    actor: "user",
    actorId: "colleague-chen",
    termsVersion: version.version,
    termsHash: version.termsHash,
    response: "accepted",
    issuedAt: "2026-09-12T10:01:00+08:00",
  }));
  assert.equal(second.ok, true);
  const agreed = store.getState().agreementRequests[before.id];
  assert.equal(agreed.status, "agreed");
  assert.equal(agreed.agreement?.termsHash, version.termsHash);
  assert.deepEqual(agreed.agreement?.executionRefs, []);
});

test("P1 counter proposal invalidates old acceptance and stale hashes fail closed", async () => {
  const store = createDomainStore({ dataMode: "fixture", initialState: createInitialState("fixture"), now: () => "2026-09-12T10:00:00+08:00" });
  const before = store.getState().agreementRequests["fx-agreement-01"];
  const version = before.versions[0];
  const counter = await store.execute(command({
    type: "counterProposeAgreement",
    commandId: "agreement-counter",
    entityId: before.id,
    expectedRevision: before.revision,
    actor: "user",
    actorId: "colleague-chen",
    terms: { ...version.terms, effortRange: { min: 60, max: 90 } },
    issuedAt: "2026-09-12T10:00:00+08:00",
  }));
  assert.equal(counter.ok, true);
  const next = store.getState().agreementRequests[before.id];
  assert.equal(next.currentVersion, 2);
  const stale = await store.execute(command({
    type: "respondAgreementRequest",
    commandId: "agreement-stale",
    entityId: before.id,
    expectedRevision: next.revision,
    actor: "user",
    actorId: "user",
    termsVersion: version.version,
    termsHash: version.termsHash,
    response: "accepted",
    issuedAt: "2026-09-12T10:01:00+08:00",
  }));
  assert.equal(stale.ok, false);
  if (!stale.ok) assert.equal(stale.code, "INVALID_TRANSITION");
});
