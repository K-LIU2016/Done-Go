import assert from "node:assert/strict";
import test from "node:test";
import { createDomainStore, FIXTURE_IDS } from "../../domain/index.ts";
import { buildPlanSurfaceModel } from "./planSurfaces.ts";

test("S04 labels a linked protected interval with its own timezone without changing intent date or capacity", async () => {
  const store = createDomainStore({ dataMode: "fixture" });
  const intent = store.getState().intents[FIXTURE_IDS.intent];
  const before = buildPlanSurfaceModel(store.getState(), [intent.id]);
  assert.ok(before.ready);
  assert.ok(intent.parsedFields.date);
  const created = await store.execute({
    type: "createProtectedBlock", commandId: "s04-linked-new-york", blockId: "s04-new-york-block",
    entityId: null, expectedRevision: null, actor: "user", issuedAt: "2026-09-13T10:00:00Z",
    intentId: intent.id, date: intent.parsedFields.date, startTime: "00:15", endTime: "01:15",
    timezone: "America/New_York", purpose: null,
  });
  assert.ok(created.ok);
  const after = buildPlanSurfaceModel(store.getState(), [intent.id]);
  assert.ok(after.ready);
  assert.equal(after.chips.find(chip => chip.kind === "protected")?.label, "00:15—01:15 静驻 · America/New_York");
  assert.equal(after.dateLabel, before.dateLabel);
  assert.match(after.dateLabel, /Asia\/Shanghai/);
  assert.deepEqual(after.capacity, before.capacity);
  assert.equal(after.capacityHeadline, before.capacityHeadline);
});
