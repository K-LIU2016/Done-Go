import assert from "node:assert/strict";
import test from "node:test";
import {
  counterProposeAgreement,
  createAgreementRequest,
  hashAgreementTerms,
  refreshAgreementExpiry,
  respondToAgreementRequest,
  withdrawAgreementRequest,
  type AgreementTerms,
} from "./agreementModel.ts";

const terms: AgreementTerms = {
  purpose: "共同确定论文讨论时间",
  dateRange: { start: "2026-10-20T09:00:00+08:00", end: "2026-10-20T10:00:00+08:00" },
  timezone: "Asia/Shanghai",
  effortRange: { min: 30, max: 60 },
  deadline: "2026-10-19T18:00:00+08:00",
  materials: [{ id: "agenda", label: "讨论提纲", permission: "reference" }],
};

const create = () => createAgreementRequest({ id: "req-1", proposerId: "alice", recipientId: "bob", terms, expiresAt: "2026-10-21T00:00:00+08:00", now: "2026-10-16T10:00:00+08:00" });

test("one person's acceptance is not an agreement; same-version acceptance forms one", () => {
  const first = create();
  const hash = hashAgreementTerms(terms);
  const alice = respondToAgreementRequest(first, { actorId: "alice", termsVersion: 1, termsHash: hash, response: "accepted", now: "2026-10-16T10:01:00+08:00" });
  assert.equal(alice.status, "received");
  assert.equal(alice.agreement, null);
  const both = respondToAgreementRequest(alice, { actorId: "bob", termsVersion: 1, termsHash: hash, response: "accepted", now: "2026-10-16T10:02:00+08:00" });
  assert.equal(both.status, "agreed");
  assert.deepEqual(both.agreement?.executionRefs, []);
});

test("a counterproposal creates a new version and invalidates prior acceptance", () => {
  const hash = hashAgreementTerms(terms);
  const accepted = respondToAgreementRequest(create(), { actorId: "alice", termsVersion: 1, termsHash: hash, response: "accepted", now: "2026-10-16T10:01:00+08:00" });
  const revisedTerms = { ...terms, effortRange: { min: 45, max: 90 } };
  const revised = counterProposeAgreement(accepted, { actorId: "bob", terms: revisedTerms, now: "2026-10-16T10:03:00+08:00" });
  assert.equal(revised.currentVersion, 2);
  assert.equal(revised.responses.alice.status, "pending");
  assert.throws(() => respondToAgreementRequest(revised, { actorId: "alice", termsVersion: 1, termsHash: hash, response: "accepted", now: "2026-10-16T10:04:00+08:00" }), /stale/);
  const revisedHash = hashAgreementTerms(revisedTerms);
  const aliceV2 = respondToAgreementRequest(revised, { actorId: "alice", termsVersion: 2, termsHash: revisedHash, response: "accepted", now: "2026-10-16T10:05:00+08:00" });
  const bothV2 = respondToAgreementRequest(aliceV2, { actorId: "bob", termsVersion: 2, termsHash: revisedHash, response: "accepted", now: "2026-10-16T10:06:00+08:00" });
  assert.equal(bothV2.status, "agreed");
  assert.equal(bothV2.agreement?.termsVersion, 2);
});

test("rejection, expiry, withdrawal, and actor binding fail closed", () => {
  const hash = hashAgreementTerms(terms);
  assert.throws(() => respondToAgreementRequest(create(), { actorId: "mallory", termsVersion: 1, termsHash: hash, response: "accepted", now: "2026-10-16T10:01:00+08:00" }), /not a party/);
  const rejected = respondToAgreementRequest(create(), { actorId: "bob", termsVersion: 1, termsHash: hash, response: "rejected", now: "2026-10-16T10:01:00+08:00", reasonCode: "not_available" });
  assert.equal(rejected.status, "rejected");
  assert.equal(rejected.agreement, null);
  const expired = refreshAgreementExpiry(create(), "2026-10-21T00:00:00+08:00");
  assert.equal(expired.status, "expired");
  const withdrawn = withdrawAgreementRequest(create(), { actorId: "alice", now: "2026-10-16T10:02:00+08:00" });
  assert.equal(withdrawn.status, "withdrawn");
});

test("tampered terms hashes and responses do not create agreement", () => {
  assert.throws(() => respondToAgreementRequest(create(), { actorId: "alice", termsVersion: 1, termsHash: "tampered", response: "accepted", now: "2026-10-16T10:01:00+08:00" }), /stale/);
});
