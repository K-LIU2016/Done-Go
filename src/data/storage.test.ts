/// <reference types="node" />
import assert from "node:assert/strict";
import test from "node:test";
import { DOMAIN_SCHEMA_VERSION, FIXTURE_IDS, createInitialState } from "../domain/index.ts";
import type { DomainState } from "../domain/index.ts";
import { InMemoryStorage } from "./storage.ts";
import type { StorageLike } from "./storage.ts";
import { openDomainPersistence, readPersistedState, storageKeyFor } from "./persistence.ts";
import type { CommitOutcome } from "./persistence.ts";
import { createPersistedDomainStore, resetFixtureDomain } from "./persistedStore.ts";
import type { PersistedDomainHandle } from "./persistedStore.ts";

type ReadyHandle = Extract<PersistedDomainHandle, { status: "ready" }>;
type FailedHandle = Extract<
  PersistedDomainHandle,
  { status: "corrupt" | "migrationFailed" | "namespaceMismatch" | "readFailed" | "seedFailed" | "unavailable" }
>;

function bumpRuleset(state: DomainState, capacity: number): DomainState {
  return {
    ...state,
    globalRevision: state.globalRevision + 1,
    ruleset: { ...state.ruleset, revision: state.ruleset.revision + 1, dailyCapacityMinutes: capacity },
  };
}

function expectOk(outcome: CommitOutcome): void {
  if (!outcome.ok) throw new Error("expected ok commit, got " + outcome.code + ": " + outcome.reason);
}

function expectFail(outcome: CommitOutcome, code: string): void {
  if (outcome.ok) throw new Error("expected failed commit, got ok");
  assert.equal(outcome.code, code);
}

function expectReady(handle: PersistedDomainHandle): ReadyHandle {
  if (handle.status !== "ready") throw new Error("expected ready handle, got " + handle.status + ": " + handle.reason);
  return handle;
}

function expectFailedHandle(handle: PersistedDomainHandle): FailedHandle {
  if (handle.status === "ready") throw new Error("expected failure handle, got ready");
  return handle;
}

async function opened(dataMode: "fixture" | "live", storage: StorageLike) {
  const { persistence } = await openDomainPersistence({ dataMode, storage });
  return persistence;
}

test("owner namespaces preserve exact anonymous keys and separate users", () => {
  for (const dataMode of ["fixture", "live"] as const) {
    const anonymous = "tango-donego:domain:v1:" + dataMode;
    assert.equal(storageKeyFor(dataMode), anonymous);
    assert.equal(storageKeyFor(dataMode, ""), anonymous);
    assert.equal(storageKeyFor(dataMode, "user-1"), "tango-donego:domain:v1:u:user-1:" + dataMode);
    assert.notEqual(storageKeyFor(dataMode, "user-1"), anonymous);
    assert.notEqual(storageKeyFor(dataMode, "user-1"), storageKeyFor(dataMode, "user-2"));
  }
});

test("owner stores persist independently without adopting anonymous data", async () => {
  const storage = new InMemoryStorage();
  const anonymous = expectReady(await createPersistedDomainStore({ dataMode: "live", storage }));
  const base = anonymous.store.getState();
  expectOk(await anonymous.persistence.commit(base.globalRevision, bumpRuleset(base, 47)));
  const anonymousBytes = storage.getItem(storageKeyFor("live"));
  const first = expectReady(await createPersistedDomainStore({ dataMode: "live", owner: "user-1", storage }));
  const second = expectReady(await createPersistedDomainStore({ dataMode: "live", owner: "user-2", storage }));
  assert.notEqual(first.store.getState().ruleset.dailyCapacityMinutes, 47);
  const firstBase = first.store.getState();
  expectOk(await first.persistence.commit(firstBase.globalRevision, bumpRuleset(firstBase, 91)));
  assert.equal(storage.getItem(storageKeyFor("live")), anonymousBytes);
  assert.notEqual(second.store.getState().ruleset.dailyCapacityMinutes, 91);
  const restored = expectReady(await createPersistedDomainStore({ dataMode: "live", owner: "user-1", storage }));
  assert.equal(restored.store.getState().ruleset.dailyCapacityMinutes, 91);
  const parsed = readPersistedState(storage, "live", "user-1");
  assert.equal(parsed.kind, "ok");
  if (parsed.kind === "ok") assert.equal(parsed.envelope.state.ruleset.dailyCapacityMinutes, 91);
});

test("owner locks and external changes isolate users while same-owner handles synchronize", async () => {
  const storage = new InMemoryStorage();
  const lockNames: string[] = [];
  const locks = { request: async <R>(name: string, action: () => Promise<R>): Promise<R> => {
    lockNames.push(name);
    return action();
  } };
  const anonymous = expectReady(await createPersistedDomainStore({ dataMode: "fixture", storage, locks }));
  const first = expectReady(await createPersistedDomainStore({ dataMode: "fixture", owner: "user-1", storage, locks }));
  const sameOwner = expectReady(await createPersistedDomainStore({ dataMode: "fixture", owner: "user-1", storage, locks }));
  const other = expectReady(await createPersistedDomainStore({ dataMode: "fixture", owner: "user-2", storage, locks }));
  assert.deepEqual(lockNames, [
    "tango-donego:domain-lock:v1:fixture",
    "tango-donego:domain-lock:v1:u:user-1:fixture",
    "tango-donego:domain-lock:v1:u:user-1:fixture",
    "tango-donego:domain-lock:v1:u:user-2:fixture",
  ]);
  const changes = { anonymous: 0, sameOwner: 0, other: 0 };
  anonymous.persistence.subscribeExternal(() => { changes.anonymous += 1; });
  sameOwner.persistence.subscribeExternal(() => { changes.sameOwner += 1; });
  other.persistence.subscribeExternal(() => { changes.other += 1; });
  const base = first.store.getState();
  expectOk(await first.persistence.commit(base.globalRevision, bumpRuleset(base, 91)));
  assert.deepEqual(changes, { anonymous: 0, sameOwner: 1, other: 0 });
  assert.equal(sameOwner.store.getState().ruleset.dailyCapacityMinutes, 91);
  assert.equal(lockNames.at(-1), "tango-donego:domain-lock:v1:u:user-1:fixture");
});

test("resetting an owner fixture leaves other owner and anonymous data untouched", async () => {
  const storage = new InMemoryStorage();
  for (const owner of [undefined, "user-1", "user-2"]) {
    const handle = expectReady(await createPersistedDomainStore({ dataMode: "fixture", owner, storage }));
    const base = handle.store.getState();
    expectOk(await handle.persistence.commit(base.globalRevision, bumpRuleset(base, 91)));
  }
  const anonymousBytes = storage.getItem(storageKeyFor("fixture"));
  const otherBytes = storage.getItem(storageKeyFor("fixture", "user-2"));
  assert.equal((await resetFixtureDomain(storage, "user-1")).ok, true);
  assert.equal(storage.getItem(storageKeyFor("fixture")), anonymousBytes);
  assert.equal(storage.getItem(storageKeyFor("fixture", "user-2")), otherBytes);
  const restored = expectReady(await createPersistedDomainStore({ dataMode: "fixture", owner: "user-1", storage }));
  assert.notEqual(restored.store.getState().ruleset.dailyCapacityMinutes, 91);
});

test("seed: first open persists fixture state and never touches live namespace", async () => {
  const storage = new InMemoryStorage();
  const persistence = await opened("fixture", storage);
  assert.equal(persistence.openStatus, "ready");
  const state = persistence.getState();
  assert.ok(state);
  assert.equal(state.globalRevision, 1);
  const raw = JSON.parse(storage.getItem(storageKeyFor("fixture")) ?? "null");
  assert.equal(raw.schemaVersion, DOMAIN_SCHEMA_VERSION);
  assert.equal(raw.state.dataMode, "fixture");
  assert.equal(raw.state.commitments[FIXTURE_IDS.commitmentReport].effortEstimateMinutes, 60);
  assert.equal(storage.getItem(storageKeyFor("live")), null);
});

test("legacy keepBlank quiet decisions upgrade to keepStill on read", () => {
  const storage = new InMemoryStorage();
  const rawState = JSON.parse(JSON.stringify(createInitialState("fixture"))) as DomainState;
  rawState.quietSessions["legacy-quiet"] = {
    id: "legacy-quiet",
    dataMode: "fixture",
    provenance: { source: "fixture" },
    revision: 1,
    createdAt: "2026-09-13T10:00:00.000Z",
    updatedAt: "2026-09-13T10:01:00.000Z",
    blockId: "legacy-block",
    originRoute: "/stillness",
    decision: "keepBlank",
    dismissedAt: null,
    suppressPrompts: true,
    coverageSnapshot: { known: true, intervals: [] },
  } as unknown as DomainState["quietSessions"][string];
  storage.setItem(storageKeyFor("fixture"), JSON.stringify({
    schemaVersion: DOMAIN_SCHEMA_VERSION,
    dataMode: "fixture",
    savedAt: "2026-09-13T10:01:00.000Z",
    state: rawState,
  }));
  const parsed = readPersistedState(storage, "fixture");
  assert.equal(parsed.kind, "ok");
  if (parsed.kind !== "ok") throw new Error("unreachable");
  assert.equal(parsed.envelope.state.quietSessions["legacy-quiet"].decision, "keepStill");
  assert.equal(parsed.envelope.state.quietSessions["legacy-quiet"].suppressPrompts, true);
});

test("durability: a fresh handle reads what a previous handle wrote", async () => {
  const storage = new InMemoryStorage();
  const first = await opened("fixture", storage);
  const current = first.getState();
  assert.ok(current);
  expectOk(await first.commit(1, bumpRuleset(current, 90)));
  const second = await opened("fixture", storage);
  assert.equal(second.getState()?.ruleset.dailyCapacityMinutes, 90);
  assert.equal(second.getState()?.globalRevision, 2);
});

test("CAS: a stale handle cannot overwrite newer stored state", async () => {
  const storage = new InMemoryStorage();
  const a = await opened("fixture", storage);
  const b = await opened("fixture", storage);
  const aState = a.getState();
  const bState = b.getState();
  assert.ok(aState);
  assert.ok(bState);
  expectOk(await a.commit(1, bumpRuleset(aState, 90)));
  const stale = await b.commit(1, bumpRuleset(bState, 95));
  expectFail(stale, "REVISION_CONFLICT");
  if (stale.ok) throw new Error("unreachable");
  assert.equal(stale.retryable, true);
  assert.equal(stale.storedGlobalRevision, 2);
  const reread = await opened("fixture", storage);
  assert.equal(reread.getState()?.ruleset.dailyCapacityMinutes, 90);
});

test("racing commits from one handle are serialized: exactly one wins", async () => {
  const storage = new InMemoryStorage();
  const persistence = await opened("fixture", storage);
  const base = persistence.getState();
  assert.ok(base);
  const results = await Promise.all([
    persistence.commit(1, bumpRuleset(base, 90)),
    persistence.commit(1, bumpRuleset(base, 95)),
  ]);
  assert.equal(results.filter((r) => r.ok).length, 1);
  assert.equal(results.filter((r) => !r.ok).length, 1);
  expectOk(await persistence.commit(2, bumpRuleset(base, 77)));
  const reread = await opened("fixture", storage);
  assert.equal(reread.getState()?.ruleset.dailyCapacityMinutes, 77);
});

test("write failure is honest: state not advanced, retry succeeds after recovery", async () => {
  const backing = new InMemoryStorage();
  let failWrites = false;
  const storage: StorageLike = {
    getItem: (k) => backing.getItem(k),
    setItem: (k, v) => {
      if (failWrites && k === storageKeyFor("fixture")) throw new Error("quota exceeded");
      backing.setItem(k, v);
    },
    removeItem: (k) => backing.removeItem(k),
  };
  const persistence = await opened("fixture", storage);
  assert.equal(persistence.openStatus, "ready");
  const durableBefore = backing.getItem(storageKeyFor("fixture"));
  assert.ok(durableBefore);
  const current = persistence.getState();
  assert.ok(current);
  assert.equal(current.ruleset.dailyCapacityMinutes, 120);
  failWrites = true;
  const failed = await persistence.commit(1, bumpRuleset(current, 90));
  expectFail(failed, "STORAGE_WRITE_FAILED");
  if (failed.ok) throw new Error("unreachable");
  assert.equal(failed.retryable, true);
  assert.equal(backing.getItem(storageKeyFor("fixture")), durableBefore);
  assert.equal(persistence.getState()?.ruleset.dailyCapacityMinutes, 120);
  failWrites = false;
  expectOk(await persistence.commit(1, bumpRuleset(current, 90)));
  const reread = JSON.parse(backing.getItem(storageKeyFor("fixture")) ?? "{}");
  assert.equal(reread.state.ruleset.dailyCapacityMinutes, 90);
  assert.equal(reread.state.globalRevision, 2);
});

test("corrupt payload: open reports corrupt, raw preserved, commits rejected", async () => {
  const storage = new InMemoryStorage();
  storage.setItem(storageKeyFor("fixture"), "{broken json");
  const persistence = await opened("fixture", storage);
  assert.equal(persistence.openStatus, "corrupt");
  assert.equal(persistence.rawPayload, "{broken json");
  assert.equal(persistence.getState(), null);
  assert.equal(storage.getItem(storageKeyFor("fixture")), "{broken json");
  expectFail(await persistence.commit(1, createInitialState("fixture")), "STORAGE_CORRUPT");
  assert.equal(storage.getItem(storageKeyFor("fixture")), "{broken json");
});

test("newer schema: migrationFailed preserves raw payload, nothing cleared", async () => {
  const storage = new InMemoryStorage();
  const future = JSON.stringify({
    schemaVersion: DOMAIN_SCHEMA_VERSION + 9,
    dataMode: "fixture",
    savedAt: "2026-09-12T10:00:00+08:00",
    state: createInitialState("fixture"),
  });
  storage.setItem(storageKeyFor("fixture"), future);
  const persistence = await opened("fixture", storage);
  assert.equal(persistence.openStatus, "migrationFailed");
  assert.equal(storage.getItem(storageKeyFor("fixture")), future);
  expectFail(await persistence.commit(1, createInitialState("fixture")), "MIGRATION_FAILED");
  assert.equal(storage.getItem(storageKeyFor("fixture")), future);
});

test("namespace mismatch: fixture key holding a live payload is not loaded or overwritten", async () => {
  const storage = new InMemoryStorage();
  const livePayload = JSON.stringify({
    schemaVersion: DOMAIN_SCHEMA_VERSION,
    dataMode: "live",
    savedAt: "2026-09-12T10:00:00+08:00",
    state: createInitialState("live"),
  });
  storage.setItem(storageKeyFor("fixture"), livePayload);
  const persistence = await opened("fixture", storage);
  assert.equal(persistence.openStatus, "namespaceMismatch");
  assert.equal(storage.getItem(storageKeyFor("fixture")), livePayload);
  expectFail(await persistence.commit(1, createInitialState("fixture")), "STORAGE_CORRUPT");
});

test("fixture and live namespaces are isolated", async () => {
  const storage = new InMemoryStorage();
  const f = await opened("fixture", storage);
  const l = await opened("live", storage);
  const fState = f.getState();
  const lState = l.getState();
  assert.ok(fState);
  assert.ok(lState);
  expectOk(await f.commit(1, bumpRuleset(fState, 66)));
  assert.equal(l.getState()?.ruleset.dailyCapacityMinutes, 120);
  expectOk(await l.commit(1, bumpRuleset(lState, 88)));
  const f2 = await opened("fixture", storage);
  const l2 = await opened("live", storage);
  assert.equal(f2.getState()?.ruleset.dailyCapacityMinutes, 66);
  assert.equal(l2.getState()?.ruleset.dailyCapacityMinutes, 88);
});

test("resetFixtureOnly resets fixture data only and refuses live", async () => {
  const storage = new InMemoryStorage();
  const f = await opened("fixture", storage);
  const l = await opened("live", storage);
  const fState = f.getState();
  const lState = l.getState();
  assert.ok(fState);
  assert.ok(lState);
  expectOk(await f.commit(1, bumpRuleset(fState, 66)));
  expectOk(await l.commit(1, bumpRuleset(lState, 88)));
  expectOk(await f.resetFixtureOnly());
  assert.equal(f.getState()?.ruleset.dailyCapacityMinutes, 120);
  assert.equal(f.getState()?.globalRevision, 1);
  expectFail(await l.resetFixtureOnly(), "STORAGE_WRITE_FAILED");
  assert.equal(l.getState()?.ruleset.dailyCapacityMinutes, 88);
  assert.ok((await resetFixtureDomain(storage)).ok);
});

test("external writes notify subscribers and are adopted by a persisted store", async () => {
  const storage = new InMemoryStorage();
  const handle = expectReady(await createPersistedDomainStore({ dataMode: "fixture", storage }));
  let notified = 0;
  const unsubscribe = handle.store.subscribe(() => {
    notified += 1;
  });
  const other = await opened("fixture", storage);
  const otherState = other.getState();
  assert.ok(otherState);
  expectOk(await other.commit(1, bumpRuleset(otherState, 90)));
  assert.ok(notified >= 1);
  assert.equal(handle.store.getState().ruleset.dailyCapacityMinutes, 90);
  unsubscribe();
});

test("persisted store reports corrupt storage without clearing user data", async () => {
  const storage = new InMemoryStorage();
  storage.setItem(storageKeyFor("fixture"), "not-recoverable");
  const handle = expectFailedHandle(await createPersistedDomainStore({ dataMode: "fixture", storage }));
  assert.equal(handle.status, "corrupt");
  assert.equal(handle.rawPayload, "not-recoverable");
  assert.equal(storage.getItem(storageKeyFor("fixture")), "not-recoverable");
});

test("unverified own-write echo cannot publish a pending candidate before commit acknowledgement", async () => {
  const backing = new InMemoryStorage();
  let readbackLieArmed = false;
  let armOnNextWrite = false;
  const storage: StorageLike = {
    getItem: (k) => {
      if (readbackLieArmed) return null;
      return backing.getItem(k);
    },
    setItem: (k, v) => {
      backing.setItem(k, v);
      if (armOnNextWrite) {
        armOnNextWrite = false;
        readbackLieArmed = true;
      }
    },
    removeItem: (k) => backing.removeItem(k),
    onExternalChange: (l) => backing.onExternalChange(l),
  };
  const handle = expectReady(await createPersistedDomainStore({ dataMode: "fixture", storage }));
  let storeNotifications = 0;
  const unsubscribe = handle.store.subscribe(() => {
    storeNotifications += 1;
  });
  let subscriberCalls = 0;
  const offExternal = handle.persistence.subscribeExternal(() => {
    subscriberCalls += 1;
  });
  const base = handle.persistence.getState();
  assert.ok(base);
  const candidate = bumpRuleset(base, 90);
  armOnNextWrite = true;
  const failed = await handle.persistence.commit(1, candidate);
  expectFail(failed, "STORAGE_READBACK_UNVERIFIED");
  if (failed.ok) throw new Error("unreachable");
  assert.equal(failed.uncertain, true);
  assert.equal(handle.store.getState().globalRevision, 1, "store must not adopt the unverified own-write echo");
  assert.equal(storeNotifications, 0, "store must not be notified from the unverified echo");
  assert.equal(subscriberCalls, 0, "persistence must not forward its own unverified echo");
  assert.equal(handle.persistence.getState()?.globalRevision, 1);
  readbackLieArmed = false;
  const durableBytes = backing.getItem(storageKeyFor("fixture"));
  assert.ok(durableBytes);
  const retried = await handle.persistence.commit(1, candidate);
  expectOk(retried);
  assert.equal(backing.getItem(storageKeyFor("fixture")), durableBytes, "exact-candidate retry acknowledges without rewriting");
  assert.equal(handle.persistence.getState()?.globalRevision, 2);
  unsubscribe();
  offExternal();
});

test("open seed does not silently overwrite a concurrent winner", async () => {
  const storage = new InMemoryStorage();
  const winnerEnvelope = JSON.stringify({
    schemaVersion: DOMAIN_SCHEMA_VERSION,
    dataMode: "fixture",
    savedAt: "2026-09-12T10:00:00+08:00",
    state: bumpRuleset(createInitialState("fixture"), 77),
  });
  let reads = 0;
  const racing: StorageLike = {
    getItem: (k) => {
      reads += 1;
      if (reads === 2) {
        storage.setItem(storageKeyFor("fixture"), winnerEnvelope);
      }
      return storage.getItem(k);
    },
    setItem: (k, v) => storage.setItem(k, v),
    removeItem: (k) => storage.removeItem(k),
  };
  const locks = {
    request: <R,>(_name: string, cb: () => Promise<R>): Promise<R> => cb(),
  };
  const { persistence } = await openDomainPersistence({
    dataMode: "fixture",
    storage: racing,
    locks,
  });
  assert.equal(persistence.openStatus, "seedFailed");
  assert.match(persistence.openReason ?? "", /^STORAGE_READBACK_UNVERIFIED: /);
  assert.equal(storage.getItem(storageKeyFor("fixture")), winnerEnvelope, "durable bytes stay the winner payload");
  const durable = JSON.parse(winnerEnvelope);
  assert.equal(durable.state.ruleset.dailyCapacityMinutes, 77, "winner payload must not be overwritten");
  assert.equal(persistence.getState(), null, "the unverified seed must not be published");
  const reopened = await opened("fixture", storage);
  assert.equal(reopened.getState()?.ruleset.dailyCapacityMinutes, 77, "reopen adopts the durable winner");
});
