import assert from "node:assert/strict";
import test from "node:test";
import { createPersistedDomainStore } from "../../data/persistedStore.ts";
import { InMemoryStorage } from "../../data/storage.ts";
import { createInitialState } from "../../domain/state.ts";
import { makeQuietIdeaCommand, saveQuietIdea, selectRecentQuietText } from "./quietIdeas.ts";

test("empty ideas are not commands and original text is preserved", () => {
  assert.equal(makeQuietIdeaCommand(" \n ", "empty", "2026-09-13T10:00:00Z"), null);
  const command = makeQuietIdeaCommand("  只想慢慢走一会。\n", "idea", "2026-09-13T10:00:00Z");
  assert.equal(command?.raw, "  只想慢慢走一会。\n");
  assert.equal(command?.type, "saveCaptureDraft");
});

test("saved idea survives reopening without creating intent, responsibility, or changing quiet choice", async () => {
  const storage = new InMemoryStorage();
  const handle = await createPersistedDomainStore({ dataMode: "fixture", storage });
  assert.equal(handle.status, "ready");
  if (handle.status !== "ready") return;
  const before = handle.store.getState();
  const command = makeQuietIdeaCommand("今晚的光很好。", "quiet-save", "2026-09-13T10:00:00Z")!;
  assert.deepEqual(await saveQuietIdea(handle.store, handle.persistence.getState, command), { ok: true });
  assert.deepEqual(await saveQuietIdea(handle.store, handle.persistence.getState, command), { ok: true });
  assert.deepEqual(handle.store.getState().intents, before.intents);
  assert.deepEqual(handle.store.getState().commitments, before.commitments);
  assert.deepEqual(handle.store.getState().protectedBlocks, before.protectedBlocks);
  assert.deepEqual(handle.store.getState().quietSessions, before.quietSessions);
  const restored = await createPersistedDomainStore({ dataMode: "fixture", storage });
  assert.equal(restored.status, "ready");
  if (restored.status !== "ready") return;
  assert.equal(selectRecentQuietText(restored.store.getState()).filter((draft) => draft.raw === command.raw).length, 1);
});

test("unconfirmed durable readback is not shown as success and exact retry creates no duplicate", async () => {
  const handle = await createPersistedDomainStore({ dataMode: "fixture", storage: new InMemoryStorage() });
  if (handle.status !== "ready") throw new Error(handle.status);
  const command = makeQuietIdeaCommand("留在这里的一句话", "readback-save", "2026-09-13T10:00:00Z")!;
  const result = await saveQuietIdea(handle.store, () => null, command);
  assert.equal(result.ok, false);
  assert.deepEqual(await saveQuietIdea(handle.store, handle.persistence.getState, command), { ok: true });
  assert.equal(selectRecentQuietText(handle.store.getState()).filter((draft) => draft.raw === command.raw).length, 1);
});

test("recent text excludes discarded and converted drafts and blank text", () => {
  const state = createInitialState("fixture");
  const base = { id: "a", revision: 1, createdAt: "2026-09-13T10:00:00Z", updatedAt: "2026-09-13T10:00:00Z", dataMode: "fixture" as const, provenance: { origin: "user" as const }, channel: "text" as const, raw: "一段话", parsedFields: { date: null, startTime: null, endTime: null, timezone: null, topic: null }, ambiguityNote: null, constraints: [], status: "open" as const };
  state.captureDrafts = { a: base, b: { ...base, id: "b", status: "discarded" }, c: { ...base, id: "c", status: "savedAsIntent" }, d: { ...base, id: "d", raw: " " }, e: { ...base, id: "e", updatedAt: "2026-09-13T11:00:00Z" } };
  assert.deepEqual(selectRecentQuietText(state).map((draft) => draft.id), ["e", "a"]);
});
