import assert from "node:assert/strict";
import test from "node:test";
import { createPersistedDomainStore } from "../../data/persistedStore.ts";
import { InMemoryStorage } from "../../data/storage.ts";
import type { StorageLike } from "../../data/storage.ts";
import { planQuietClose } from "./quietSurface.ts";
import { storageKeyFor } from "../../data/persistence.ts";

async function savedKeepStill() {
  const storage = new InMemoryStorage();
  const handle = await createPersistedDomainStore({ dataMode: "fixture", storage });
  assert.equal(handle.status, "ready");
  if (handle.status !== "ready") throw new Error("Fixture persistence unavailable");
  const block = Object.values(handle.store.getState().protectedBlocks)[0];
  assert.ok(block);
  const base = { actor: "user" as const, issuedAt: "2026-09-13T10:00:00Z" };
  const open = await handle.store.execute({ ...base, type: "openQuietSession", commandId: "close-open", entityId: null, expectedRevision: null, blockId: block.blockId, originRoute: "/ledger" });
  assert.ok(open.ok);
  const saved = await handle.store.execute({ ...base, type: "decideQuiet", commandId: "close-keep", entityId: open.data.session.id, expectedRevision: open.data.session.revision, blockId: block.blockId, decision: "keepStill" });
  assert.ok(saved.ok);
  return { handle, storage, session: saved.data.session };
}

test("closing a durably confirmed keepStill preserves its decision and suppression after reopen", async () => {
  const { handle, storage, session } = await savedKeepStill();
  assert.equal(planQuietClose(handle.store.getState(), handle.persistence.getState(), session.id), "preserve");
  const reopened = await createPersistedDomainStore({ dataMode: "fixture", storage });
  assert.equal(reopened.status, "ready");
  if (reopened.status !== "ready") return;
  assert.deepEqual(reopened.store.getState().quietSessions[session.id], session);
  assert.equal(session.decision, "keepStill");
  assert.equal(session.suppressPrompts, true);
});

test("another open store observes durable keepStill in both runtime and persistence without reload", async () => {
  const { handle, storage, session } = await savedKeepStill();
  const other = await createPersistedDomainStore({ dataMode: "fixture", storage });
  assert.equal(other.status, "ready");
  if (other.status !== "ready") return;
  let firstNotifications = 0;
  let secondNotifications = 0;
  const offFirst = other.persistence.subscribeExternal(() => { firstNotifications++; });
  const offSecond = other.persistence.subscribeExternal(() => { secondNotifications++; });
  const result = await handle.store.execute({ type: "decideQuiet", commandId: "external-keep-refresh", actor: "user", issuedAt: "2026-09-13T10:01:00Z", entityId: session.id, expectedRevision: session.revision, blockId: session.blockId, decision: "keepStill" });
  assert.ok(result.ok);
  assert.equal(other.persistence.getState()?.quietSessions[session.id]?.revision, result.data.session.revision);
  assert.equal(planQuietClose(other.store.getState(), other.persistence.readFreshState(), session.id), "preserve");
  assert.equal(firstNotifications, 1);
  assert.equal(secondNotifications, 1);
  offFirst();
  offSecond();
});

test("fresh quiet readback rejects corrupt durable storage despite matching cached keepStill snapshots", async () => {
  const { handle, storage, session } = await savedKeepStill();
  storage.setItem(storageKeyFor("fixture"), "corrupt-test-payload");
  assert.equal(handle.persistence.readFreshState(), null);
  assert.equal(planQuietClose(handle.store.getState(), handle.persistence.readFreshState(), session.id), "unverified");
});

test("unknown, mismatching or unsuppressed keepStill readback cannot silently close as saved", async () => {
  const { handle, session } = await savedKeepStill();
  const state = handle.store.getState();
  assert.equal(planQuietClose(state, null, session.id), "unverified");
  for (const patch of [{ decision: "unchosen" as const }, { suppressPrompts: false }, { revision: session.revision + 1 }]) {
    const persisted = { ...state, quietSessions: { ...state.quietSessions, [session.id]: { ...session, ...patch } } };
    assert.equal(planQuietClose(state, persisted, session.id), "unverified");
  }
});

test("fresh reads never acknowledge an unknown own write; exact command retry confirms once", async () => {
  const backing = new InMemoryStorage();
  let failReadback = false;
  let armNextWrite = false;
  let writes = 0;
  const storage: StorageLike = {
    getItem: key => failReadback ? null : backing.getItem(key),
    setItem: (key, value) => {
      writes++;
      backing.setItem(key, value);
      if (armNextWrite) { armNextWrite = false; failReadback = true; }
    },
    removeItem: key => backing.removeItem(key),
    onExternalChange: listener => backing.onExternalChange(listener),
  };
  const handle = await createPersistedDomainStore({ dataMode: "fixture", storage });
  assert.equal(handle.status, "ready");
  if (handle.status !== "ready") return;
  const block = Object.values(handle.store.getState().protectedBlocks)[0];
  assert.ok(block);
  const base = { actor: "user" as const, issuedAt: "2026-09-13T10:00:00Z" };
  const open = await handle.store.execute({ ...base, type: "openQuietSession", commandId: "unknown-open", entityId: null, expectedRevision: null, blockId: block.blockId, originRoute: "/ledger" });
  assert.ok(open.ok);
  const command = { ...base, type: "decideQuiet" as const, commandId: "unknown-keep-exact", entityId: open.data.session.id, expectedRevision: open.data.session.revision, blockId: block.blockId, decision: "keepStill" as const };
  armNextWrite = true;
  const failed = await handle.store.execute(command);
  assert.equal(failed.ok, false);
  if (!failed.ok) assert.equal(failed.code, "STORAGE_READBACK_UNVERIFIED");
  failReadback = false;
  assert.equal(handle.persistence.readFreshState(), null);
  const writesBeforeRetry = writes;
  const retried = await handle.store.execute(command);
  assert.ok(retried.ok);
  assert.equal(writes, writesBeforeRetry);
  assert.equal(planQuietClose(handle.store.getState(), handle.persistence.readFreshState(), command.entityId), "preserve");
});
