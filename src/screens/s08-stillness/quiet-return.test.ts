import assert from "node:assert/strict";
import test from "node:test";
import {
  describeQuietExecuteFailure,
  selectQuietEntryOrigin,
  selectQuietExitTarget,
  validateQuietReturnTo,
} from "./quietSurface.ts";

function rejectionOf(raw: string | null | undefined): string {
  const check = validateQuietReturnTo(raw);
  if (check.ok) {
    throw new Error("expected rejection for " + String(raw));
  }
  return check.reason;
}

test("validateQuietReturnTo accepts internal paths and preserves query verbatim", () => {
  assert.deepEqual(validateQuietReturnTo("/ledger"), {
    ok: true,
    path: "/ledger",
  });
  assert.deepEqual(validateQuietReturnTo("/ledger?blockId=protected-1"), {
    ok: true,
    path: "/ledger?blockId=protected-1",
  });
  assert.deepEqual(validateQuietReturnTo("/m/plan?x=1#sec"), {
    ok: true,
    path: "/m/plan?x=1#sec",
  });
});

test("validateQuietReturnTo rejects external, protocol-relative, and non-path input", () => {
  assert.equal(rejectionOf(null), "missing");
  assert.equal(rejectionOf(undefined), "missing");
  assert.equal(rejectionOf(""), "missing");
  assert.equal(
    rejectionOf("https://evil.example/ledger"),
    "notInternal",
  );
  assert.equal(rejectionOf("javascript:alert(1)"), "notInternal");
  assert.equal(rejectionOf("ledger"), "notInternal");
  assert.equal(rejectionOf("//evil.example/ledger"), "external");
  assert.equal(rejectionOf("/\\evil.example"), "external");
  assert.equal(rejectionOf("/ledger next"), "notInternal");
});

test("validateQuietReturnTo rejects quiet recursive destinations", () => {
  assert.equal(rejectionOf("/stillness"), "quietLoop");
  assert.equal(rejectionOf("/m/stillness"), "quietLoop");
  assert.equal(rejectionOf("/stillness/"), "quietLoop");
  assert.equal(rejectionOf("/m/stillness?blockId=x"), "quietLoop");
});

test("selectQuietEntryOrigin persists validated returnTo else fallback", () => {
  assert.equal(
    selectQuietEntryOrigin("/ledger?blockId=b1", "/"),
    "/ledger?blockId=b1",
  );
  assert.equal(selectQuietEntryOrigin("/stillness", "/"), "/");
  assert.equal(selectQuietEntryOrigin(null, "/"), "/");
  assert.equal(selectQuietEntryOrigin(undefined, "/m/now"), "/m/now");
});

test("selectQuietExitTarget prefers query, then valid session origin, then fallback", () => {
  assert.equal(
    selectQuietExitTarget({
      queryReturnTo: "/ledger?blockId=b1",
      sessionOriginRoute: "/workspace",
      fallback: "/",
    }),
    "/ledger?blockId=b1",
  );
  assert.equal(
    selectQuietExitTarget({
      queryReturnTo: null,
      sessionOriginRoute: "/workspace",
      fallback: "/",
    }),
    "/workspace",
  );
  assert.equal(
    selectQuietExitTarget({
      queryReturnTo: null,
      sessionOriginRoute: "/stillness",
      fallback: "/",
    }),
    "/",
  );
  assert.equal(
    selectQuietExitTarget({
      queryReturnTo: "/m/stillness",
      sessionOriginRoute: "/m/plan",
      fallback: "/m/now",
    }),
    "/m/plan",
  );
  assert.equal(
    selectQuietExitTarget({
      queryReturnTo: null,
      sessionOriginRoute: null,
      fallback: "/m/now",
    }),
    "/m/now",
  );
  assert.equal(
    selectQuietExitTarget({
      queryReturnTo: "https://evil.example",
      sessionOriginRoute: "//evil.example",
      fallback: "/",
    }),
    "/",
  );
});

test("describeQuietExecuteFailure stays readable without throwing", () => {
  assert.match(describeQuietExecuteFailure(new Error("boom")), /boom/);
  assert.ok(describeQuietExecuteFailure("weird").length > 0);
  assert.ok(describeQuietExecuteFailure(null).length > 0);
});
