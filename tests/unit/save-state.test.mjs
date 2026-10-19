import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applySaveSuccess,
  SAVE_MESSAGE_SAVED,
  SAVE_MESSAGE_SAVED_WITH_PENDING_EDITS,
} from "../../src/settings/saveState.ts";

test("successful save clears proof and test result so the saved message cannot coexist with the stale-retest warning", () => {
  const outcome = applySaveSuccess({
    formChangedSinceSubmit: false,
    formApiKey: "sk-tango-donego-fake-unit-key-0001",
  });
  assert.equal(outcome.testResult, null);
  assert.equal(outcome.proof, null);
  assert.equal(outcome.testError, null);
  assert.equal(outcome.saveMessage, "已保存并启用");
  assert.equal(outcome.saveMessage, SAVE_MESSAGE_SAVED);
  assert.equal(outcome.apiKey, "");
});

test("save completing after in-flight edits keeps newer form edits and does not claim them saved", () => {
  const newerKey = "sk-tango-donego-fake-unit-key-0002";
  const outcome = applySaveSuccess({
    formChangedSinceSubmit: true,
    formApiKey: newerKey,
  });
  assert.equal(outcome.apiKey, newerKey);
  assert.equal(outcome.saveMessage, SAVE_MESSAGE_SAVED_WITH_PENDING_EDITS);
  assert.notEqual(outcome.saveMessage, SAVE_MESSAGE_SAVED);
  assert.match(outcome.saveMessage, /未保存的修改/);
  assert.equal(outcome.testResult, null);
  assert.equal(outcome.proof, null);
});
