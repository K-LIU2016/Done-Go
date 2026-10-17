import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const context = vm.createContext({ window: {} });
vm.runInContext(readFileSync(new URL('../../web/agreements.js', import.meta.url), 'utf8'), context);
const A = context.window.TangoAgreements;

const terms = () => ({
  purpose: ' 一起核对论文 ',
  dateRange: { start: '2026-10-16T09:00:00+08:00', end: '2026-10-16T18:00:00+08:00' },
  timezone: 'Asia/Shanghai',
  effortRange: { min: 30, max: 60 },
  deadline: null,
  materials: [{ id: 'paper-1', label: '论文草稿', permission: 'read' }]
});
const now = '2026-10-16T10:00:00+08:00';
const expiry = '2026-10-17T10:00:00+08:00';

function request() {
  return A.createAgreementRequest({ id: 'agree-1', proposerId: 'alice', recipientId: 'bob', terms: terms(), now, expiresAt: expiry });
}

test('canonical terms hash ignores material order', () => {
  const first = A.hashAgreementTerms(terms());
  const reordered = terms();
  reordered.materials = [{ id: 'z-last', label: '附录', permission: 'reference' }, ...reordered.materials];
  assert.equal(first, A.hashAgreementTerms(terms()));
  assert.notEqual(first, A.hashAgreementTerms({ ...terms(), effortRange: { min: 45, max: 60 } }));
});

test('one acceptance does not create an Agreement and executionRefs stay empty', () => {
  const started = request();
  const hash = started.versions[0].termsHash;
  const one = A.respondToAgreementRequest(started, { actorId: 'alice', termsVersion: 1, termsHash: hash, response: 'accepted', now });
  assert.equal(one.status, 'received');
  assert.equal(one.agreement, null);
  const both = A.respondToAgreementRequest(one, { actorId: 'bob', termsVersion: 1, termsHash: hash, response: 'accepted', now });
  assert.equal(both.status, 'agreed');
  assert.equal(Array.isArray(both.agreement.executionRefs), true);
  assert.equal(both.agreement.executionRefs.length, 0);
});

test('counterproposal creates a new version and invalidates prior acceptance', () => {
  const started = request(), hash = started.versions[0].termsHash;
  const one = A.respondToAgreementRequest(started, { actorId: 'alice', termsVersion: 1, termsHash: hash, response: 'accepted', now });
  const revised = A.counterProposeAgreement(one, { actorId: 'bob', terms: { ...terms(), effortRange: { min: 45, max: 90 } }, now });
  assert.equal(revised.currentVersion, 2);
  assert.equal(revised.status, 'received');
  assert.equal(revised.responses.alice.status, 'pending');
  assert.equal(revised.agreement, null);
  assert.throws(() => A.respondToAgreementRequest(revised, { actorId: 'alice', termsVersion: 1, termsHash: hash, response: 'accepted', now }), /stale/);
});

test('stale hash, forged identity and duplicate terminal actions fail closed', () => {
  const started = request(), hash = started.versions[0].termsHash;
  assert.throws(() => A.respondToAgreementRequest(started, { actorId: 'alice', termsVersion: 1, termsHash: 'badbad00', response: 'accepted', now }), /stale/);
  assert.throws(() => A.respondToAgreementRequest(started, { actorId: 'mallory', termsVersion: 1, termsHash: hash, response: 'accepted', now }), /party/);
  const agreed = A.respondToAgreementRequest(A.respondToAgreementRequest(started, { actorId: 'alice', termsVersion: 1, termsHash: hash, response: 'accepted', now }), { actorId: 'bob', termsVersion: 1, termsHash: hash, response: 'accepted', now });
  assert.throws(() => A.respondToAgreementRequest(agreed, { actorId: 'alice', termsVersion: 1, termsHash: hash, response: 'accepted', now }), /terminal/);
});

test('withdraw and expiry are explicit states', () => {
  const started = request();
  assert.equal(A.withdrawAgreementRequest(started, { actorId: 'bob', now }).status, 'withdrawn');
  assert.equal(A.withdrawAgreementRequest(request(), { actorId: 'alice', now: expiry }).status, 'withdrawn');
  assert.equal(A.refreshAgreementExpiry(request(), expiry).status, 'expired');
  assert.equal(A.refreshAgreementExpiry(request(), now).status, 'sent');
});

test('invalid or unsafe terms fail validation', () => {
  assert.throws(() => A.hashAgreementTerms({ ...terms(), purpose: '   ' }), /purpose/);
  assert.throws(() => A.hashAgreementTerms({ ...terms(), effortRange: { min: 70, max: 30 } }), /order/);
  assert.throws(() => A.hashAgreementTerms({ ...terms(), materials: [{ id: '" onclick', label: 'bad', permission: 'read' }] }), /materials/);
});

test('stored requests reject corrupted terms, missing parties and forged agreement state before rendering', () => {
  assert.equal(typeof A.validateStoredRequest, 'function');
  const valid = JSON.parse(JSON.stringify(request()));
  assert.equal(A.validateStoredRequest(valid, ['alice', 'bob']), true);
  for (const invalid of [null, {}, { ...valid, responses: {} }, { ...valid, currentVersion: 99 },
    { ...valid, versions: [{ ...valid.versions[0], termsHash: 'forged' }] },
    { ...valid, status: 'agreed' }, { ...valid, proposerId: 'charlie' },
    { ...valid, expiresAt: 'bad' }, { ...valid, versions: [null] }]) {
    assert.equal(A.validateStoredRequest(invalid, ['alice', 'bob']), false);
  }
  const hash = valid.versions[0].termsHash;
  const accepted = A.respondToAgreementRequest(A.respondToAgreementRequest(valid, { actorId: 'alice', termsVersion: 1, termsHash: hash, response: 'accepted', now }), { actorId: 'bob', termsVersion: 1, termsHash: hash, response: 'accepted', now });
  assert.equal(A.validateStoredRequest(JSON.parse(JSON.stringify(accepted)), ['alice', 'bob']), true);
  assert.equal(A.validateStoredRequest({ ...accepted, agreement: { ...accepted.agreement, executionRefs: ['forged-calendar-grant'] } }, ['alice', 'bob']), false);
});
