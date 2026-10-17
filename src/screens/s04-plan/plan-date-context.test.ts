import assert from "node:assert/strict";
import test from "node:test";
import { createInitialState, FIXTURE_IDS } from "../../domain/index.ts";
import { buildPlanSurfaceModel } from "./planSurfaces.ts";
import { resolveIntentCalendarContext } from "./intent-calendar-context.ts";
import { selectSurfaceDate } from "../s01-now/timeSurfaces.ts";

test("explicit plan uses its own date and timezone rather than global fixture date", () => {
  const state = structuredClone(createInitialState("fixture"));
  const intent = state.intents[FIXTURE_IDS.intent];
  state.intents.ny = { ...intent, id: "ny", parsedFields: { ...intent.parsedFields, date: "2026-09-14", timezone: "America/New_York" } };
  const block = Object.values(state.protectedBlocks)[0];
  state.protectedBlocks.ny = { ...block, id: "ny-block", blockId: "ny-stable", intentId: "ny", range: { start: "2026-09-14T21:00:00-04:00", end: "2026-09-14T22:00:00-04:00", timezone: "America/New_York" } };
  const model = buildPlanSurfaceModel(state, ["ny"]);
  assert.equal(model.ready, true);
  if (!model.ready) return;
  assert.equal(model.capacity.date, "2026-09-14");
  assert.match(model.dateLabel, /America\/New_York/);
  assert.equal(model.chips.find(chip => chip.kind === "protected")?.label, "21:00—22:00 静驻 · America/New_York");
  assert.equal(model.capacity.committedKnownMinutes, 0);
  assert.equal(model.chips.find(chip => chip.kind === "meeting")?.label, "当日没有固定约定");
});

test("explicit plan with unknown date and no linked block fails closed", () => {
  const state = structuredClone(createInitialState("fixture"));
  const intent = state.intents[FIXTURE_IDS.intent];
  state.intents.unknown = { ...intent, id: "unknown", parsedFields: { ...intent.parsedFields, date: null } };
  const model = buildPlanSurfaceModel(state, ["unknown"]);
  assert.equal(model.ready, false);
});

test("default plan still selects the legacy surface date without explicit query", () => {
  const state = structuredClone(createInitialState("fixture"));
  state.intents[FIXTURE_IDS.intent].parsedFields.date = "2026-09-14";
  const model = buildPlanSurfaceModel(state, []);
  assert.equal(model.ready, true);
  if (!model.ready) return;
  assert.equal(model.capacity.date, selectSurfaceDate(state));
  assert.doesNotMatch(model.dateLabel, /Asia\/Shanghai/);
});

test("explicit calendar can derive date and timezone only from its own linked block", () => {
  const state = structuredClone(createInitialState("fixture"));
  const original = state.intents[FIXTURE_IDS.intent];
  state.intents.linked = { ...original, id: "linked", parsedFields: { ...original.parsedFields, date: null, timezone: null } };
  const block = Object.values(state.protectedBlocks)[0];
  state.protectedBlocks.linked = { ...block, id: "linked", blockId: "stable-linked", intentId: "linked", range: { start: "2026-09-14T21:00:00-04:00", end: "2026-09-14T22:00:00-04:00", timezone: "America/New_York" } };
  assert.deepEqual(resolveIntentCalendarContext(state, state.intents.linked), { ok: true, date: "2026-09-14", timezone: "America/New_York" });
  delete state.protectedBlocks.linked;
  assert.equal(resolveIntentCalendarContext(state, state.intents.linked).ok, false);
});

test("invalid date fails closed and unknown timezone is never replaced by fixture timezone", () => {
  const state = structuredClone(createInitialState("fixture"));
  const original = state.intents[FIXTURE_IDS.intent];
  state.intents.other = { ...original, id: "other", parsedFields: { ...original.parsedFields, date: "2026-02-30", timezone: null } };
  assert.equal(buildPlanSurfaceModel(state, ["other"]).ready, false);
  state.intents.other.parsedFields.date = "2026-09-14";
  const model = buildPlanSurfaceModel(state, ["other"]);
  assert.equal(model.ready, true);
  if (model.ready) assert.match(model.dateLabel, /时区未知/);
});
