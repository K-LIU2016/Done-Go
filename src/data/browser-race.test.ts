/// <reference types="node" />
import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "playwright";

const APP_URL = process.env.TANGO_RACE_APP_URL ?? "http://127.0.0.1:5199";
const KEY = "tango-donego:domain:v1:fixture";
const LIVE_KEY = "tango-donego:domain:v1:live";
const ROUNDS = 5;
// Computed so tsc never treats the dynamic import inside page.evaluate as a
// literal module specifier that must be resolved at build time.
const MODULE_URL = ["/src", "data", "persistedStore.ts"].join("/");

interface RaceOutcome {
  ok: boolean;
  code: string | null;
  capacity: number;
}

interface Observation {
  round: number;
  baseRevision: number;
  outcomes: Array<RaceOutcome & { page: "A" | "B" }>;
  durable?: { globalRevision: number; dailyCapacityMinutes: number };
}

test("two real Chromium pages contend on the same expected revision: exactly one durable winner per round", { timeout: 240000 }, async () => {
  const browser = await chromium.launch();
  const observations: Observation[] = [];
  try {
    const context = await browser.newContext();
    const pageA = await context.newPage();
    const pageB = await context.newPage();
    for (const page of [pageA, pageB]) {
      await page.goto(APP_URL, { waitUntil: "load" });
    }
    for (const page of [pageA, pageB]) {
      await page.evaluate(async ([key, moduleUrl]) => {
        const w = window as unknown as Record<string, unknown>;
        const mod = (await import(moduleUrl)) as {
          createPersistedDomainStore: (o: { dataMode: "fixture" }) => Promise<unknown>;
        };
        const handle = (await mod.createPersistedDomainStore({ dataMode: "fixture" })) as {
          status: string;
          reason?: string;
          persistence: {
            commit: (expected: number, next: unknown) => Promise<{ ok: boolean; code?: string }>;
          };
        };
        if (handle.status !== "ready") {
          throw new Error("handle not ready: " + handle.status + ": " + (handle.reason ?? ""));
        }
        w.__locksAvailable = Boolean((navigator as unknown as { locks?: unknown }).locks);
        w.__handle = handle;
        const proto = Storage.prototype as unknown as Record<string, unknown>;
        if (!proto.__tangoRacePatched) {
          proto.__tangoRacePatched = true;
          const original = (proto.setItem as (k: string, v: string) => void).bind(window.localStorage);
          proto.setItem = function (this: Storage, k: string, v: string) {
            if (w.__stallOnce === true && k === key) {
              w.__stallOnce = false;
              const t0 = performance.now();
              while (performance.now() - t0 < 60) {
                // deterministic overlap window inside one renderer; the other page runs in its own process
              }
            }
            return original(k, v);
          };
        }
        w.__raceCommit = async (expected: number, capacity: number): Promise<RaceOutcome> => {
          const raw = window.localStorage.getItem(key);
          if (!raw) throw new Error("no durable fixture state before the race round");
          const durable = JSON.parse(raw).state;
          const next = {
            ...durable,
            globalRevision: expected + 1,
            ruleset: {
              ...durable.ruleset,
              revision: durable.ruleset.revision + 1,
              dailyCapacityMinutes: capacity,
            },
          };
          w.__stallOnce = true;
          const outcome = await handle.persistence.commit(expected, next);
          return { ok: outcome.ok === true, code: outcome.ok ? null : (outcome.code ?? null), capacity };
        };
        w.__readDurable = () => {
          const raw = window.localStorage.getItem(key);
          return raw ? JSON.parse(raw).state : null;
        };
      }, [KEY, MODULE_URL]);
    }
    const locksA = await pageA.evaluate(() => (window as unknown as { __locksAvailable: boolean }).__locksAvailable);
    const locksB = await pageB.evaluate(() => (window as unknown as { __locksAvailable: boolean }).__locksAvailable);
    assert.equal(locksA, true, "navigator.locks must exist in the test browser");
    assert.equal(locksB, true, "navigator.locks must exist in the test browser");
    for (let round = 1; round <= ROUNDS; round++) {
      const baseRevision = await pageA.evaluate(() => {
        const s = (window as unknown as { __readDurable: () => { globalRevision: number } | null }).__readDurable();
        if (!s) throw new Error("durable fixture state disappeared");
        return s.globalRevision;
      });
      const [resA, resB] = await Promise.all([
        pageA.evaluate((expected) => (window as unknown as { __raceCommit: (e: number, c: number) => Promise<RaceOutcome> }).__raceCommit(expected, expected + 100), baseRevision),
        pageB.evaluate((expected) => (window as unknown as { __raceCommit: (e: number, c: number) => Promise<RaceOutcome> }).__raceCommit(expected, expected + 200), baseRevision),
      ]);
      const observation: Observation = {
        round,
        baseRevision,
        outcomes: [
          { page: "A", ...resA },
          { page: "B", ...resB },
        ],
      };
      const winners = observation.outcomes.filter((o) => o.ok);
      assert.equal(winners.length, 1, "round " + round + ": expected exactly one durable winner, got " + JSON.stringify(observation.outcomes));
      for (const loser of observation.outcomes.filter((o) => !o.ok)) {
        assert.equal(loser.code, "REVISION_CONFLICT", "round " + round + ": loser must report REVISION_CONFLICT, got " + loser.code);
      }
      const durable = await pageA.evaluate(() => {
        const s = (window as unknown as { __readDurable: () => { globalRevision: number; ruleset: { dailyCapacityMinutes: number } } | null }).__readDurable();
        if (!s) throw new Error("durable fixture state disappeared after the race round");
        return { globalRevision: s.globalRevision, dailyCapacityMinutes: s.ruleset.dailyCapacityMinutes };
      });
      observation.durable = durable;
      observations.push(observation);
      assert.equal(durable.globalRevision, baseRevision + 1, "round " + round + ": durable revision must advance exactly once");
      assert.equal(durable.dailyCapacityMinutes, winners[0].capacity, "round " + round + ": durable payload must equal the winner's candidate (no lost update)");
    }
      await pageA.evaluate(async (moduleUrl) => {
      const mod = (await import(moduleUrl)) as {
        resetFixtureDomain: () => Promise<{ ok: boolean; reason?: string }>;
      };
      const r = await mod.resetFixtureDomain();
      if (!r.ok) throw new Error("fixture reset failed: " + (r.reason ?? ""));
    }, MODULE_URL);
    const liveRaw = await pageA.evaluate((k) => window.localStorage.getItem(k), LIVE_KEY);
    assert.equal(liveRaw, null, "race scenario must never touch the live namespace");
    console.log("RACE_OBSERVATIONS " + JSON.stringify(observations, null, 1));
  } finally {
    if (observations.length > 0) {
      console.log("RACE_OBSERVATIONS_SO_FAR " + JSON.stringify(observations));
    }
    await browser.close();
  }
});
