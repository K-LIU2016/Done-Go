import { createDomainStore } from "../domain/store.ts";
import type { DomainStore, StoreCommitOutcome } from "../domain/store.ts";
import type { DataMode, DomainState } from "../domain/types.ts";
import { getBrowserLocalStorage, getBrowserWebLocks } from "./storage.ts";
import type { LockManagerLike, StorageLike } from "./storage.ts";
import { openDomainPersistence } from "./persistence.ts";
import type { DomainPersistence } from "./persistence.ts";

export type PersistedDomainHandle =
  | {
      status: "ready";
      dataMode: DataMode;
      store: DomainStore;
      persistence: DomainPersistence;
    }
  | {
      status: "migrationFailed" | "corrupt" | "namespaceMismatch" | "readFailed" | "seedFailed" | "unavailable";
      dataMode: DataMode;
      reason: string;
      rawPayload: string | null;
    };

export interface CreatePersistedDomainStoreOptions {
  dataMode: DataMode;
  owner?: string;
  storage?: StorageLike;
  locks?: LockManagerLike | null;
  requireCrossTabLock?: boolean;
  now?: () => string;
  uuid?: () => string;
}

const NO_BROWSER_STORAGE = "STORAGE_UNAVAILABLE: no persistent browser storage";

export async function createPersistedDomainStore(
  options: CreatePersistedDomainStoreOptions,
): Promise<PersistedDomainHandle> {
  const storageIsImplicit = options.storage === undefined;
  const storage = options.storage ?? getBrowserLocalStorage();
  if (!storage) {
    return { status: "unavailable", dataMode: options.dataMode, reason: NO_BROWSER_STORAGE, rawPayload: null };
  }
  const locks = options.locks === undefined ? getBrowserWebLocks() : options.locks;
  if (!locks && (options.requireCrossTabLock || storageIsImplicit)) {
    return {
      status: "unavailable",
      dataMode: options.dataMode,
      reason: "STORAGE_UNAVAILABLE: cross-tab Web Locks unavailable",
      rawPayload: null,
    };
  }
  const { persistence } = await openDomainPersistence({ dataMode: options.dataMode, owner: options.owner, storage, locks });
  if (persistence.openStatus !== "ready") {
    // Data is preserved on disk; callers get the raw payload for recovery. Nothing is cleared.
    return {
      status: persistence.openStatus,
      dataMode: options.dataMode,
      reason: persistence.openReason ?? "unreadable storage",
      rawPayload: persistence.rawPayload,
    };
  }
  const commit = async (expected: number, next: DomainState): Promise<StoreCommitOutcome> => {
    const r = await persistence.commit(expected, next);
    return r.ok ? { ok: true } : { ok: false, code: r.code, reason: r.reason, retryable: r.retryable };
  };
  const store = createDomainStore({
    dataMode: options.dataMode,
    initialState: persistence.getState() as DomainState,
    now: options.now,
    uuid: options.uuid,
    commit,
  });
  persistence.subscribeExternal(() => {
    const verified = persistence.getState();
    if (verified !== null) store.adoptExternalState(verified);
  });
  return { status: "ready", dataMode: options.dataMode, store, persistence };
}

/** Reset is fixture-only by construction; live data is never cleared. */
export async function resetFixtureDomain(storage?: StorageLike, owner?: string): Promise<{ ok: boolean; reason?: string }> {
  const storageIsImplicit = storage === undefined;
  const s = storage ?? getBrowserLocalStorage();
  if (!s) return { ok: false, reason: NO_BROWSER_STORAGE };
  const locks = storageIsImplicit ? getBrowserWebLocks() : undefined;
  if (storageIsImplicit && !locks) {
    return { ok: false, reason: "STORAGE_UNAVAILABLE: cross-tab Web Locks unavailable" };
  }
  const { persistence } = await openDomainPersistence({ dataMode: "fixture", owner, storage: s, locks });
  const r = await persistence.resetFixtureOnly();
  return r.ok ? { ok: true } : { ok: false, reason: r.code + ": " + r.reason };
}
