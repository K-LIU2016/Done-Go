import assert from "node:assert/strict";
import test from "node:test";
import { createPersistedDomainStore } from "./persistedStore.ts";
import { storageKeyFor } from "./persistence.ts";
import { InMemoryStorage } from "./storage.ts";

test("explicit guest preserves legacy default keys and existing data without a migration", async () => {
  for (const dataMode of ["fixture", "live"] as const) {
    assert.equal(storageKeyFor(dataMode, "guest"), "tango-donego:domain:v1:" + dataMode);
    assert.equal(storageKeyFor(dataMode, "guest"), storageKeyFor(dataMode));
    const storage = new InMemoryStorage();
    const previous = await createPersistedDomainStore({ dataMode, storage });
    assert.equal(previous.status, "ready");
    if (previous.status !== "ready") return;
    const base = previous.store.getState();
    const result = await previous.persistence.commit(base.globalRevision, { ...base, globalRevision: base.globalRevision + 1, ruleset: { ...base.ruleset, revision: base.ruleset.revision + 1, dailyCapacityMinutes: 77 } });
    assert.equal(result.ok, true);
    const originalBytes = storage.getItem(storageKeyFor(dataMode));
    const guest = await createPersistedDomainStore({ dataMode, owner: "guest", storage });
    assert.equal(guest.status, "ready");
    if (guest.status !== "ready") return;
    assert.equal(guest.store.getState().ruleset.dailyCapacityMinutes, 77);
    assert.equal(storage.getItem(storageKeyFor(dataMode)), originalBytes);
  }
});

test("two accounts and guest have separate keys, locks and visible persisted changes", async () => {
  const storage = new InMemoryStorage();
  const lockNames: string[] = [];
  const locks = { request: async <R>(name: string, action: () => Promise<R>) => { lockNames.push(name); return action(); } };
  const owners = ["guest", "account-a", "account-b"];
  assert.equal(new Set(owners.map((owner) => storageKeyFor("live", owner))).size, 3);
  for (const [index, owner] of owners.entries()) {
    const handle = await createPersistedDomainStore({ dataMode: "live", owner, storage, locks });
    assert.equal(handle.status, "ready");
    if (handle.status !== "ready") return;
    const base = handle.store.getState();
    assert.notEqual(base.ruleset.dailyCapacityMinutes, 101);
    assert.notEqual(base.ruleset.dailyCapacityMinutes, 102);
    assert.equal((await handle.persistence.commit(base.globalRevision, { ...base, globalRevision: base.globalRevision + 1, ruleset: { ...base.ruleset, revision: base.ruleset.revision + 1, dailyCapacityMinutes: 101 + index } })).ok, true);
  }
  for (const [index, owner] of owners.entries()) {
    const reopened = await createPersistedDomainStore({ dataMode: "live", owner, storage, locks });
    assert.equal(reopened.status, "ready");
    if (reopened.status === "ready") assert.equal(reopened.store.getState().ruleset.dailyCapacityMinutes, 101 + index);
  }
  assert.deepEqual([...new Set(lockNames)], ["tango-donego:domain-lock:v1:live", "tango-donego:domain-lock:v1:u:account-a:live", "tango-donego:domain-lock:v1:u:account-b:live"]);
});
