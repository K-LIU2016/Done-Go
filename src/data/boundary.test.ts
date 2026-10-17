/// <reference types="node" />
import assert from "node:assert/strict";
import test from "node:test";
import { DOMAIN_SCHEMA_VERSION, createInitialState } from "../domain/index.ts";
import type { DomainState } from "../domain/index.ts";
import { InMemoryStorage } from "./storage.ts";
import type { StorageLike } from "./storage.ts";
import { openDomainPersistence, storageKeyFor } from "./persistence.ts";
import type { CommitOutcome } from "./persistence.ts";
import { createPersistedDomainStore, resetFixtureDomain } from "./persistedStore.ts";
import type { PersistedDomainHandle } from "./persistedStore.ts";

const KEY = storageKeyFor("fixture");

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

async function opened(dataMode: "fixture" | "live", storage: StorageLike) {
  const { persistence } = await openDomainPersistence({ dataMode, storage });
  return persistence;
}

test("browser storage absence in a non-browser host fails closed: no silent in-memory fallback", async () => {
  const handle = await createPersistedDomainStore({ dataMode: "fixture" });
  assert.equal(handle.status, "unavailable");
  assert.match(handle.reason, /STORAGE_UNAVAILABLE|no persistent browser storage/);
  const reset = await resetFixtureDomain();
  assert.equal(reset.ok, false);
  assert.match(reset.reason ?? "", /STORAGE_UNAVAILABLE|no persistent browser storage/);
});

test("getItem failure at open: typed readFailed handle, raw preserved, no false ready", async () => {
  const backing = new InMemoryStorage();
  const raw = JSON.stringify({
    schemaVersion: DOMAIN_SCHEMA_VERSION,
    dataMode: "fixture",
    savedAt: "2026-09-12T10:00:00+08:00",
    state: createInitialState("fixture"),
  });
  backing.setItem(KEY, raw);
  let failReads = true;
  const storage: StorageLike = {
    getItem: (k) => {
      if (failReads) throw new Error("storage detached");
      return backing.getItem(k);
    },
    setItem: (k, v) => backing.setItem(k, v),
    removeItem: (k) => backing.removeItem(k),
  };
  const handle = await createPersistedDomainStore({ dataMode: "fixture", storage });
  assert.equal(handle.status, "readFailed");
  assert.equal(backing.getItem(KEY), raw);
  const { persistence } = await openDomainPersistence({ dataMode: "fixture", storage });
  assert.equal(persistence.openStatus, "readFailed");
  assert.equal(persistence.getState(), null);
  const outcome = await persistence.commit(1, createInitialState("fixture"));
  expectFail(outcome, "STORAGE_READ_FAILED");
  assert.equal(backing.getItem(KEY), raw);
  failReads = false;
});

test("precommit getItem failure: STORAGE_READ_FAILED, memory, durable bytes and subscribers preserved", async () => {
  const backing = new InMemoryStorage();
  let failReads = false;
  const storage: StorageLike = {
    getItem: (k) => {
      if (failReads) throw new Error("storage read channel failed");
      return backing.getItem(k);
    },
    setItem: (k, v) => backing.setItem(k, v),
    removeItem: (k) => backing.removeItem(k),
    onExternalChange: (l) => backing.onExternalChange(l),
  };
  const persistence = await opened("fixture", storage);
  const base = persistence.getState();
  assert.ok(base);
  expectOk(await persistence.commit(1, bumpRuleset(base, 90)));
  const durableBefore = backing.getItem(KEY);
  assert.ok(durableBefore);
  let notified = 0;
  const off = persistence.subscribeExternal(() => {
    notified += 1;
  });
  failReads = true;
  const failed = await persistence.commit(2, bumpRuleset(persistence.getState() as DomainState, 95));
  expectFail(failed, "STORAGE_READ_FAILED");
  if (failed.ok) throw new Error("unreachable");
  assert.equal(failed.retryable, true);
  assert.equal(notified, 0);
  assert.equal(persistence.getState()?.globalRevision, 2);
  assert.equal(backing.getItem(KEY), durableBefore);
  failReads = false;
  expectOk(await persistence.commit(2, bumpRuleset(persistence.getState() as DomainState, 95)));
  const after = JSON.parse(backing.getItem(KEY) ?? "{}");
  assert.equal(after.state.ruleset.dailyCapacityMinutes, 95);
  assert.equal(after.state.globalRevision, 3);
  off();
});

test("commit setItem failure preserves memory, subscribers, and prior durable bytes", async () => {
  const backing = new InMemoryStorage();
  let failWrites = false;
  const storage: StorageLike = {
    getItem: (k) => backing.getItem(k),
    setItem: (k, v) => {
      if (failWrites && k === KEY) throw new Error("quota exceeded");
      backing.setItem(k, v);
    },
    removeItem: (k) => backing.removeItem(k),
    onExternalChange: (l) => backing.onExternalChange(l),
  };
  const persistence = await opened("fixture", storage);
  const base = persistence.getState();
  assert.ok(base);
  expectOk(await persistence.commit(1, bumpRuleset(base, 90)));
  const durableBefore = backing.getItem(KEY);
  assert.ok(durableBefore);
  let notified = 0;
  const off = persistence.subscribeExternal(() => {
    notified += 1;
  });
  failWrites = true;
  const failed = await persistence.commit(2, bumpRuleset(persistence.getState() as DomainState, 95));
  expectFail(failed, "STORAGE_WRITE_FAILED");
  if (failed.ok) throw new Error("unreachable");
  assert.equal(failed.retryable, true);
  assert.equal(notified, 0);
  assert.equal(persistence.getState()?.globalRevision, 2);
  assert.equal(persistence.getState()?.ruleset.dailyCapacityMinutes, 90);
  assert.equal(backing.getItem(KEY), durableBefore);
  failWrites = false;
  expectOk(await persistence.commit(2, bumpRuleset(persistence.getState() as DomainState, 95)));
  assert.equal(notified, 1);
  assert.equal(JSON.parse(backing.getItem(KEY) ?? "{}").state.ruleset.dailyCapacityMinutes, 95);
  off();
});

test("readback mismatch: outcome explicitly uncertain, nothing acknowledged; retry reads back the same candidate and never rewrites", async () => {
  const backing = new InMemoryStorage();
  let lieAboutReads = false;
  let setItemCount = 0;
  const storage: StorageLike = {
    getItem: (k) => {
      if (lieAboutReads && k === KEY) return null;
      return backing.getItem(k);
    },
    setItem: (k, v) => {
      if (k === KEY) setItemCount += 1;
      backing.setItem(k, v);
    },
    removeItem: (k) => backing.removeItem(k),
  };
  const persistence = await opened("fixture", storage);
  assert.equal(setItemCount, 1, "exactly the seed write before the race");
  const base = persistence.getState();
  assert.ok(base);
  const candidate = bumpRuleset(base, 90);
  lieAboutReads = true;
  const failed = await persistence.commit(1, candidate);
  expectFail(failed, "STORAGE_READBACK_UNVERIFIED");
  if (failed.ok) throw new Error("unreachable");
  assert.equal(failed.retryable, true);
  assert.equal(failed.uncertain, true);
  assert.equal(setItemCount, 2, "seed plus the single uncertain write");
  assert.equal(persistence.getState()?.globalRevision, 1, "failed commit must not advance memory");
  const durableBytes = backing.getItem(KEY);
  assert.ok(durableBytes);
  assert.equal(JSON.parse(durableBytes).state.globalRevision, 2, "the uncertain write really landed");
  lieAboutReads = false;
  const retried = await persistence.commit(1, candidate);
  expectOk(retried);
  assert.equal(setItemCount, 2, "retry must acknowledge the persisted candidate without a second write");
  assert.equal(backing.getItem(KEY), durableBytes, "byte-identical durable payload keeps savedAt and entity IDs");
  assert.equal(persistence.getState()?.globalRevision, 2);
});

test("readback read failure: STORAGE_READBACK_UNVERIFIED with explicit uncertainty and recoverable retry", async () => {
  const backing = new InMemoryStorage();
  let armReadbackFailure = false;
  let readSinceArm = false;
  let setItemCount = 0;
  const storage: StorageLike = {
    getItem: (k) => {
      if (armReadbackFailure) {
        if (readSinceArm) throw new Error("readback channel failed");
        readSinceArm = true;
      }
      return backing.getItem(k);
    },
    setItem: (k, v) => {
      if (k === KEY) setItemCount += 1;
      backing.setItem(k, v);
    },
    removeItem: (k) => backing.removeItem(k),
  };
  const persistence = await opened("fixture", storage);
  const base = persistence.getState();
  assert.ok(base);
  const candidate = bumpRuleset(base, 90);
  armReadbackFailure = true;
  readSinceArm = false;
  const failed = await persistence.commit(1, candidate);
  expectFail(failed, "STORAGE_READBACK_UNVERIFIED");
  if (failed.ok) throw new Error("unreachable");
  assert.equal(failed.uncertain, true);
  assert.equal(persistence.getState()?.globalRevision, 1);
  const durableBytes = backing.getItem(KEY);
  assert.ok(durableBytes);
  assert.equal(JSON.parse(durableBytes).state.ruleset.dailyCapacityMinutes, 90);
  armReadbackFailure = false;
  const retried = await persistence.commit(1, candidate);
  expectOk(retried);
  assert.equal(setItemCount, 2, "no second operation write on acknowledged retry");
  assert.equal(backing.getItem(KEY), durableBytes);
  assert.equal(persistence.getState()?.globalRevision, 2);
});

test("fixture reset replacement failure preserves durable bytes and never removes first", async () => {
  const backing = new InMemoryStorage();
  let failWrites = false;
  const removeCalls: string[] = [];
  const storage: StorageLike = {
    getItem: (k) => backing.getItem(k),
    setItem: (k, v) => {
      if (failWrites && k === KEY) throw new Error("quota exceeded during reset");
      backing.setItem(k, v);
    },
    removeItem: (k) => {
      removeCalls.push(k);
      backing.removeItem(k);
    },
  };
  const persistence = await opened("fixture", storage);
  const base = persistence.getState();
  assert.ok(base);
  expectOk(await persistence.commit(1, bumpRuleset(base, 90)));
  const durableBefore = backing.getItem(KEY);
  assert.ok(durableBefore);
  failWrites = true;
  const failed = await persistence.resetFixtureOnly();
  expectFail(failed, "STORAGE_WRITE_FAILED");
  assert.equal(backing.getItem(KEY), durableBefore);
  assert.deepEqual(removeCalls, []);
  failWrites = false;
  expectOk(await persistence.resetFixtureOnly());
  const after = JSON.parse(backing.getItem(KEY) ?? "{}");
  assert.equal(after.state.globalRevision, 1);
  assert.equal(after.state.ruleset.dailyCapacityMinutes, 120);
});

test("malformed state payload: corrupt open, raw preserved, never ready", async () => {
  const storage = new InMemoryStorage();
  const bad = JSON.stringify({
    schemaVersion: DOMAIN_SCHEMA_VERSION,
    dataMode: "fixture",
    savedAt: "2026-09-12T10:00:00+08:00",
    state: { ...createInitialState("fixture"), commitments: "not-a-record" },
  });
  storage.setItem(KEY, bad);
  const handle: PersistedDomainHandle = await createPersistedDomainStore({ dataMode: "fixture", storage });
  assert.equal(handle.status, "corrupt");
  assert.equal(handle.rawPayload, bad);
  assert.equal(storage.getItem(KEY), bad);
  const persistence = await opened("fixture", storage);
  expectFail(await persistence.commit(1, createInitialState("fixture")), "STORAGE_CORRUPT");
  assert.equal(storage.getItem(KEY), bad);
});

test("entity-level malformed payload: entity without required base fields is corrupt, not ready", async () => {
  const storage = new InMemoryStorage();
  const state = createInitialState("fixture");
  (state.commitments as Record<string, unknown>)["bogus-entity"] = { revision: 1 };
  const bad = JSON.stringify({
    schemaVersion: DOMAIN_SCHEMA_VERSION,
    dataMode: "fixture",
    savedAt: "2026-09-12T10:00:00+08:00",
    state,
  });
  storage.setItem(KEY, bad);
  const handle = await createPersistedDomainStore({ dataMode: "fixture", storage });
  assert.equal(handle.status, "corrupt");
  assert.equal(storage.getItem(KEY), bad);
});

test("external adoption adopts only greater verified revisions, never equal or lower", async () => {
  const storage = new InMemoryStorage();
  const handle = await createPersistedDomainStore({ dataMode: "fixture", storage });
  if (handle.status !== "ready") throw new Error("expected ready handle, got " + handle.status);
  let notified = 0;
  handle.store.subscribe(() => {
    notified += 1;
  });
  const other = await opened("fixture", storage);
  const base = other.getState();
  assert.ok(base);
  expectOk(await other.commit(1, bumpRuleset(base, 90)));
  assert.equal(handle.store.getState().ruleset.dailyCapacityMinutes, 90);
  assert.equal(notified, 1);
  const rawRev2 = storage.getItem(KEY);
  assert.ok(rawRev2);
  const sameRevision = JSON.parse(rawRev2);
  sameRevision.state.ruleset.dailyCapacityMinutes = 111;
  storage.setItem(KEY, JSON.stringify(sameRevision));
  assert.equal(handle.store.getState().ruleset.dailyCapacityMinutes, 90);
  const lowerRevision = JSON.parse(rawRev2);
  lowerRevision.state = createInitialState("fixture");
  storage.setItem(KEY, JSON.stringify(lowerRevision));
  assert.equal(handle.store.getState().ruleset.dailyCapacityMinutes, 90);
  assert.equal(notified, 1);
});

function withBrowserGlobals(localStorageValue: unknown, locks: unknown): () => void {
  const g = globalThis as unknown as Record<string, unknown>;
  const hadLocalStorage = Object.prototype.hasOwnProperty.call(g, "localStorage");
  const prevLocalStorage = g.localStorage;
  const prevNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  g.localStorage = localStorageValue;
  Object.defineProperty(globalThis, "navigator", { value: { locks }, configurable: true, writable: true });
  return () => {
    if (hadLocalStorage) g.localStorage = prevLocalStorage;
    else delete g.localStorage;
    if (prevNavigator) Object.defineProperty(globalThis, "navigator", prevNavigator);
  };
}

test("browser-like cross-tab storage without Web Locks fails closed; injected locks make it ready", async () => {
  const refused = await createPersistedDomainStore({
    dataMode: "fixture",
    storage: new InMemoryStorage(),
    requireCrossTabLock: true,
    locks: null,
  });
  assert.equal(refused.status, "unavailable");
  assert.match(refused.reason, /STORAGE_UNAVAILABLE|Web Locks/);
  const fakeLocks = {
    request: <R,>(_name: string, cb: () => Promise<R>): Promise<R> => cb(),
  };
  const granted = await createPersistedDomainStore({
    dataMode: "fixture",
    storage: new InMemoryStorage(),
    requireCrossTabLock: true,
    locks: fakeLocks,
  });
  assert.equal(granted.status, "ready");
  if (granted.status !== "ready") throw new Error("unreachable");
  const base = granted.persistence.getState();
  assert.ok(base);
  expectOk(await granted.persistence.commit(1, bumpRuleset(base, 90)));
  assert.equal(granted.persistence.getState()?.ruleset.dailyCapacityMinutes, 90);
});

test("factory wires injected locks into persistence: open seed, commit, and reset run under the lock callback", async () => {
  let lockRequests = 0;
  const locks = {
    request: <R,>(_name: string, cb: () => Promise<R>): Promise<R> => {
      lockRequests += 1;
      return cb();
    },
  };
  const handle = await createPersistedDomainStore({
    dataMode: "fixture",
    storage: new InMemoryStorage(),
    locks,
    requireCrossTabLock: true,
  });
  assert.equal(handle.status, "ready");
  if (handle.status !== "ready") throw new Error("unreachable");
  const base = handle.persistence.getState();
  assert.ok(base);
  assert.ok(lockRequests >= 1, "open seed must run under the injected lock");
  expectOk(await handle.persistence.commit(1, bumpRuleset(base, 90)));
  assert.ok(lockRequests >= 2, "commit must run under the injected lock");
  expectOk(await handle.persistence.resetFixtureOnly());
  assert.ok(lockRequests >= 3, "reset must run under the injected lock");
});

test("implicit browser storage requires Web Locks by default; injected unit storage stays lock-free", async () => {
  let restore = withBrowserGlobals(new InMemoryStorage(), undefined);
  try {
    const refused = await createPersistedDomainStore({ dataMode: "fixture" });
    assert.equal(refused.status, "unavailable");
    assert.match(refused.reason, /STORAGE_UNAVAILABLE|Web Locks/);
  } finally {
    restore();
  }
  let lockRequests = 0;
  const locks = {
    request: <R,>(_name: string, cb: () => Promise<R>): Promise<R> => {
      lockRequests += 1;
      return cb();
    },
  };
  restore = withBrowserGlobals(new InMemoryStorage(), locks);
  try {
    const granted = await createPersistedDomainStore({ dataMode: "fixture" });
    assert.equal(granted.status, "ready");
    assert.ok(lockRequests >= 1, "implicit browser open seed must be lock protected");
  } finally {
    restore();
  }
  const injected = await createPersistedDomainStore({ dataMode: "fixture", storage: new InMemoryStorage() });
  assert.equal(injected.status, "ready", "explicit injected unit storage may stay lock-free");
});

test("resetFixtureDomain implicit browser path is lock protected; explicit storage keeps fixture-only semantics", async () => {
  let restore = withBrowserGlobals(new InMemoryStorage(), undefined);
  try {
    const refused = await resetFixtureDomain();
    assert.equal(refused.ok, false);
    assert.match(refused.reason ?? "", /STORAGE_UNAVAILABLE|Web Locks/);
  } finally {
    restore();
  }
  let lockRequests = 0;
  const locks = {
    request: <R,>(_name: string, cb: () => Promise<R>): Promise<R> => {
      lockRequests += 1;
      return cb();
    },
  };
  restore = withBrowserGlobals(new InMemoryStorage(), locks);
  try {
    const reset = await resetFixtureDomain();
    assert.equal(reset.ok, true);
    assert.ok(lockRequests >= 1, "implicit fixture reset must run under Web Locks");
  } finally {
    restore();
  }
  const explicit = await resetFixtureDomain(new InMemoryStorage());
  assert.equal(explicit.ok, true, "explicit fixture reset stays lock-free");
});

test("initial seed write failure: typed seedFailed handle, nothing published in memory or storage", async () => {
  const backing = new InMemoryStorage();
  const storage: StorageLike = {
    getItem: (k) => backing.getItem(k),
    setItem: () => {
      throw new Error("quota exceeded");
    },
    removeItem: (k) => backing.removeItem(k),
  };
  const handle: PersistedDomainHandle = await createPersistedDomainStore({ dataMode: "fixture", storage });
  assert.equal(handle.status, "seedFailed");
  if (handle.status !== "seedFailed") throw new Error("unreachable");
  assert.match(handle.reason, /^STORAGE_WRITE_FAILED: /);
  assert.equal(backing.getItem(KEY), null);
  const recovered = await createPersistedDomainStore({ dataMode: "fixture", storage: new InMemoryStorage() });
  assert.equal(recovered.status, "ready");
  if (recovered.status !== "ready") throw new Error("unreachable");
  assert.equal(recovered.persistence.getState()?.globalRevision, 1);
});

test("initial seed readback mismatch: typed unverified reason, memory not published, durable bytes preserved", async () => {
  const backing = new InMemoryStorage();
  let lieOnNextRead = false;
  const storage: StorageLike = {
    getItem: (k) => {
      if (lieOnNextRead) {
        lieOnNextRead = false;
        return null;
      }
      return backing.getItem(k);
    },
    setItem: (k, v) => {
      backing.setItem(k, v);
      lieOnNextRead = true;
    },
    removeItem: (k) => backing.removeItem(k),
  };
  const handle = await createPersistedDomainStore({ dataMode: "fixture", storage });
  assert.equal(handle.status, "seedFailed");
  if (handle.status !== "seedFailed") throw new Error("unreachable");
  assert.match(handle.reason, /^STORAGE_READBACK_UNVERIFIED: /);
  const durableBytes = backing.getItem(KEY);
  assert.ok(durableBytes, "the seed write landed durably and must be preserved");
  assert.equal(handle.rawPayload, durableBytes, "caller gets the durable bytes for recovery");
  const recovered = await createPersistedDomainStore({ dataMode: "fixture", storage });
  assert.equal(recovered.status, "ready");
  if (recovered.status !== "ready") throw new Error("unreachable");
  assert.equal(recovered.persistence.getState()?.globalRevision, 1, "existing durable payload is adopted on reopen");
  assert.equal(JSON.parse(backing.getItem(KEY) ?? "{}").state.ruleset.dailyCapacityMinutes, 120);
});
