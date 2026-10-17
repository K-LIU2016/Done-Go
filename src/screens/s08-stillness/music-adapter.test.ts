import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { quietMusicController, runQuietMusic, unconfiguredMusicAdapter } from "./music-adapter.ts";
import type { MusicAccess, MusicPlaybackReceipt, QuietMusicAdapter } from "./music-adapter.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(settle => { resolve = settle; });
  return { promise, resolve };
}

function controlledAdapter(overrides: Partial<QuietMusicAdapter> = {}) {
  let resumes = 0;
  let reads = 0;
  const adapter: QuietMusicAdapter = {
    async inspectAccess() { return { connection: "connected", providerId: "unit-test-only", playbackPermission: "granted" }; },
    async resumePrevious({ requestId }) { resumes++; return { status: "playing", providerId: "unit-test-only", requestId, playbackRef: "test-track", confirmedAt: "2026-09-13T14:00:00Z" }; },
    async readPlayback({ requestId }) { reads++; return { status: "playing", providerId: "unit-test-only", requestId, playbackRef: "test-track", confirmedAt: "2026-09-13T14:00:00Z" }; },
    ...overrides,
  };
  return { adapter, counts: () => ({ resumes, reads }) };
}

test("default production adapter is disconnected and cannot call a playback provider", async () => {
  const result = await runQuietMusic(unconfiguredMusicAdapter, "no-provider");
  assert.equal(result.kind, "notConnected");
  assert.equal(result.receipt, undefined);
});

for (const permission of ["denied", "unknown"] as const) test(permission + " permission fails closed before playback", async () => {
  const controlled = controlledAdapter({ async inspectAccess() { return { connection: "connected", providerId: "unit-test-only", playbackPermission: permission }; } });
  assert.equal((await runQuietMusic(controlled.adapter, "permission-test")).kind, "denied");
  assert.deepEqual(controlled.counts(), { resumes: 0, reads: 0 });
});

test("confirmed injected unit-test receipt is accepted only after permission inspection", async () => {
  const controlled = controlledAdapter();
  const result = await runQuietMusic(controlled.adapter, "confirmed-test");
  assert.equal(result.kind, "success");
  assert.equal(result.receipt?.requestId, "confirmed-test");
  assert.deepEqual(controlled.counts(), { resumes: 1, reads: 0 });
});

test("unavailable playback and thrown access checks produce honest failure, not success", async () => {
  const unavailable = controlledAdapter({ async resumePrevious() { return { status: "unavailable", reason: "没有可恢复的上次播放记录" }; } });
  assert.equal((await runQuietMusic(unavailable.adapter, "no-track")).kind, "unavailable");
  const failed = controlledAdapter({ async inspectAccess() { throw new Error("test connection failure"); } });
  assert.equal((await runQuietMusic(failed.adapter, "access-failed")).kind, "unavailable");
  assert.deepEqual(failed.counts(), { resumes: 0, reads: 0 });
});

test("unknown playback is reconciled by readback only with the same request, never a second resume", async () => {
  let resumes = 0;
  const controlled = controlledAdapter({ async resumePrevious() { resumes++; throw new Error("possible postwrite failure"); } });
  assert.equal((await runQuietMusic(controlled.adapter, "exact-music-request")).kind, "unknown");
  const checked = await runQuietMusic(controlled.adapter, "exact-music-request", { readbackOnly: true });
  assert.equal(checked.kind, "success");
  assert.equal(checked.receipt?.requestId, "exact-music-request");
  assert.equal(resumes, 1);
  assert.equal(controlled.counts().reads, 1);
});

test("unmatched receipt and timeout remain unknown without blind replay", async () => {
  const mismatch = controlledAdapter({ async resumePrevious() { return { status: "playing", requestId: "other-request", providerId: "unit-test-only", playbackRef: "test-track", confirmedAt: "2026-09-13T14:00:00Z" }; } });
  assert.equal((await runQuietMusic(mismatch.adapter, "expected-request")).kind, "unknown");
  const timeout = controlledAdapter({ async resumePrevious() { return new Promise(() => {}); } });
  assert.equal((await runQuietMusic(timeout.adapter, "timeout-request", { timeoutMs: 5 })).kind, "unknown");
});

test("lost permission during readback does not erase the unresolved prior playback", async () => {
  const controlled = controlledAdapter({ async inspectAccess() { return { connection: "notConnected", reason: "来源已断开" }; } });
  assert.equal((await runQuietMusic(controlled.adapter, "pending-request", { readbackOnly: true })).kind, "unknown");
  assert.deepEqual(controlled.counts(), { resumes: 0, reads: 0 });
});

test("adapter controller preserves an unknown original request across consumers and unmounts", async () => {
  const resumed: string[] = [];
  const read: string[] = [];
  const controlled = controlledAdapter({
    async resumePrevious({ requestId }) { resumed.push(requestId); throw new Error("possible postwrite"); },
    async readPlayback({ requestId }) {
      read.push(requestId);
      return { status: "playing", providerId: "unit-test-only", requestId, playbackRef: "test-track", confirmedAt: "2026-09-13T14:00:00Z" };
    },
  });
  const firstMount = quietMusicController(controlled.adapter);
  const unsubscribe = firstMount.subscribe(() => {});
  assert.equal((await firstMount.run(() => "original-request"))?.kind, "unknown");
  unsubscribe();
  const secondMount = quietMusicController(controlled.adapter);
  assert.equal(secondMount, firstMount);
  assert.equal(secondMount.getSnapshot().pendingRequestId, "original-request");
  assert.equal(secondMount.getSnapshot().result?.kind, "unknown");
  const checked = await secondMount.run(() => { assert.fail("must not create a new request for readback"); });
  assert.equal(checked?.kind, "success");
  assert.deepEqual(resumed, ["original-request"]);
  assert.deepEqual(read, ["original-request"]);
  assert.equal(secondMount.getSnapshot().pendingRequestId, null);
});

test("shared controller keeps inflight lock after unsubscribe and rejects duplicate resume", async () => {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let resumes = 0;
  let ids = 0;
  const controlled = controlledAdapter({ async resumePrevious() { resumes++; await held; return { status: "unknown", reason: "test-only delayed result" }; } });
  const firstMount = quietMusicController(controlled.adapter);
  const notifications: boolean[] = [];
  const unsubscribe = firstMount.subscribe(() => notifications.push(firstMount.getSnapshot().busy));
  const pending = firstMount.run(() => { ids++; return "one-request"; });
  assert.equal(firstMount.getSnapshot().busy, true);
  unsubscribe();
  const secondMount = quietMusicController(controlled.adapter);
  assert.equal(secondMount.getSnapshot().busy, true);
  assert.equal(await secondMount.run(() => { ids++; return "duplicate-request"; }), null);
  release();
  assert.equal((await pending)?.kind, "unknown");
  assert.equal(resumes, 1);
  assert.equal(ids, 1);
  assert.deepEqual(notifications, [true]);
  assert.equal(secondMount.getSnapshot().busy, false);
  assert.equal(secondMount.getSnapshot().pendingRequestId, "one-request");
});

test("controller isolates adapter identities and keeps unconfigured production disconnected", async () => {
  const first = quietMusicController(controlledAdapter().adapter);
  const second = quietMusicController(controlledAdapter().adapter);
  assert.notEqual(first, second);
  const disconnected = quietMusicController(unconfiguredMusicAdapter);
  assert.equal((await disconnected.run(() => "no-provider-controller"))?.kind, "notConnected");
  assert.equal(disconnected.getSnapshot().pendingRequestId, null);
});

test("late playing after resume timeout cannot publish success or replace the pending original request", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const started = deferred<void>();
  const playback = deferred<MusicPlaybackReceipt>();
  const resumed: string[] = [];
  const read: string[] = [];
  let playbackSignal: AbortSignal | undefined;
  const controlled = controlledAdapter({
    async resumePrevious({ requestId, signal }) {
      resumed.push(requestId);
      playbackSignal = signal;
      started.resolve();
      return playback.promise;
    },
    async readPlayback({ requestId }) {
      read.push(requestId);
      return { status: "playing", providerId: "unit-test-only", requestId, playbackRef: "test-track", confirmedAt: "2026-09-13T14:00:00Z" };
    },
  });
  const controller = quietMusicController(controlled.adapter);
  const published: Array<string | null> = [];
  const unsubscribe = controller.subscribe(() => published.push(controller.getSnapshot().result?.kind ?? null));
  t.after(unsubscribe);
  const attempt = controller.run(() => "late-original-request");
  await started.promise;
  t.mock.timers.tick(8000);
  assert.equal((await attempt)?.kind, "unknown");
  assert.equal(playbackSignal?.aborted, true);
  const timedOutSnapshot = controller.getSnapshot();
  assert.equal(timedOutSnapshot.pendingRequestId, "late-original-request");
  assert.equal(timedOutSnapshot.busy, false);
  playback.resolve({ status: "playing", providerId: "unit-test-only", requestId: "late-original-request", playbackRef: "test-track", confirmedAt: "2026-09-13T14:00:00Z" });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(controller.getSnapshot(), timedOutSnapshot, "late resume must not publish any replacement snapshot");
  assert.deepEqual(published, [null, "unknown"]);
  const checked = await controller.run(() => { assert.fail("pending readback cannot create a request ID"); });
  assert.equal(checked?.kind, "success");
  assert.equal(checked?.requestId, "late-original-request");
  assert.deepEqual(resumed, ["late-original-request"]);
  assert.deepEqual(read, ["late-original-request"]);
});

test("late granted access after inspection timeout never starts resume", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const access = deferred<MusicAccess>();
  let accessSignal: AbortSignal | undefined;
  const controlled = controlledAdapter({ async inspectAccess(signal) { accessSignal = signal; return access.promise; } });
  const controller = quietMusicController(controlled.adapter);
  const attempt = controller.run(() => "late-access-request");
  t.mock.timers.tick(8000);
  assert.equal((await attempt)?.kind, "unavailable");
  assert.equal(accessSignal?.aborted, true);
  const timedOutSnapshot = controller.getSnapshot();
  assert.equal(timedOutSnapshot.pendingRequestId, null);
  access.resolve({ connection: "connected", providerId: "unit-test-only", playbackPermission: "granted" });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.deepEqual(controlled.counts(), { resumes: 0, reads: 0 });
  assert.equal(controller.getSnapshot(), timedOutSnapshot);
  assert.equal(controller.getSnapshot().result?.kind, "unavailable");
});

test("S08 music button runs an injectable adapter, with busy and quiet-session guards", () => {
  const source = readFileSync(new URL("./StillnessScreen.tsx", import.meta.url), "utf8");
  assert.ok(source.includes("musicAdapter = unconfiguredMusicAdapter"), "default must be a disconnected adapter");
  assert.ok(source.includes("onClick={() => void runMusic()}"), "music button must execute adapter");
  assert.ok(source.includes("disabled={musicBusy || musicBlocked}"));
  assert.ok(source.includes('data-music-state={musicResult.kind}'));
  assert.ok(!source.includes("setMusicNoteOpen"), "fixed demo-note handler must be removed");
  assert.ok(source.includes("useSyncExternalStore(musicController.subscribe, musicController.getSnapshot)"));
  assert.ok(!source.includes("const musicPending = useRef"), "pending playback must survive component unmount");
});
