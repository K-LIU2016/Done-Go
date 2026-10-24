import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Readable } from 'node:stream';

// SO·S4服务 line: scripts/social-service.mjs serves every /api/social/*
// route (PRD design/social-sync/PRD.md §7). Hard gates proven here:
// - 鉴权: guests may ONLY call preview (and open a baton link — PRD §4.8);
//   everything else answers 401.
// - 限流: in-memory per-account write buckets + per-IP preview buckets.
// - D2 白名单: uploads run through web/social/contracts.js validators;
//   unknown fields are REJECTED (never stripped), 事项标题/材料/时间 fields
//   can never reach the store, and rejected values never echo back.
// - 未成年人: self-reported minors never query the public match pool and can
//   only join circles via invite code (PRD §5).
// - D4: even a matcher that returns out-of-range candidates gets them
//   filtered by the 「略多一点」 gate; cold start never fabricates people.
// - D5/D6: circle rank views / freedTo summaries / baton cards and chains
//   are re-validated on the way out.

import {
  FORBIDDEN_UPLOAD_FIELDS,
  validateMatch, validateQuest, validateCircleRankView, validateFreedToSummary,
  STYLES, MATCHES_PER_WEEK, isAvatarColor,
} from '../../web/social/contracts.js';

// ---------------------------------------------------------------------------
// Test doubles. The service takes its store, auth, matcher, clock and rng via
// options — production wires scripts/social-store.mjs in; tests stay in
// memory (夜窗纪律: no heavy runs).
// ---------------------------------------------------------------------------

function mkAuth() {
  return {
    authenticate(req) {
      const id = req.headers['x-test-account'];
      if (!id) throw Object.assign(new Error('no session'), { status: 401, code: 'AUTH_REQUIRED' });
      return { id, emailVerified: true };
    },
  };
}

// In-memory store implementing exactly the interface social-service.mjs
// documents (the contract it needs from the S1 store line).
function mkStore() {
  const state = new Map();        // account -> { optIn, minor, alias, avatarColor }
  const profiles = new Map();     // account -> Map(week -> features)
  const sharedEvents = new Map(); // account -> Map(eventId -> { id, kind, owner })
  const kudos = [];
  const batons = new Map();       // id -> { share, events: [], chain: [] }
  const pairs = [];
  const circles = new Map();      // id -> { id, name, inviteCode, owner, members: Set }
  const blocks = new Map();       // account -> Set(target)
  const reports = [];
  const purged = [];
  const savedProfiles = [];
  return {
    purged,
    savedProfiles,
    getState(account) { return state.get(account) || null; },
    optIn(account, { enabled, minor, alias, avatarColor }) {
      const current = state.get(account) || { optIn: false, minor: false, alias: null, avatarColor: null };
      const next = { optIn: enabled, minor: enabled ? minor : current.minor, alias: current.alias || alias, avatarColor: current.avatarColor || avatarColor };
      state.set(account, next);
      return { ...next };
    },
    setAlias(account, { alias, avatarColor }) {
      const current = state.get(account) || { optIn: false, minor: false, alias: null, avatarColor: null };
      const next = { ...current, alias, avatarColor: avatarColor || current.avatarColor };
      state.set(account, next);
      return { ...next };
    },
    saveProfile(account, features) {
      savedProfiles.push({ account, features: JSON.parse(JSON.stringify(features)) });
      if (!profiles.has(account)) profiles.set(account, new Map());
      profiles.get(account).set(features.week, features);
    },
    getProfile(account, week) { return profiles.get(account)?.get(week) || null; },
    poolCandidates(week, { allowMinors = false } = {}) {
      const out = [];
      for (const [account, one] of state) {
        if (!one.optIn) continue;
        if (one.minor && !allowMinors) continue;
        const profile = profiles.get(account)?.get(week);
        if (!profile) continue;
        out.push({ account, graduations: profile.graduations, record: one.stubMatch });
      }
      return out;
    },
    setStubMatch(account, record) { state.get(account).stubMatch = record; },
    circlePeerCandidates() { return []; },
    recordSharedEvent(account, kind) {
      const id = 'se-' + kind + '-' + account;
      if (!sharedEvents.has(account)) sharedEvents.set(account, new Map());
      sharedEvents.get(account).set(id, { id, kind, owner: account });
      return { id, kind, owner: account };
    },
    getSharedEvent(owner, eventId) { return sharedEvents.get(owner)?.get(eventId) || null; },
    addKudos(entry) { kudos.push(entry); },
    listKudos(account) { return kudos.filter(k => k.to === account); },
    createBatonShare(share) { batons.set(share.id, { share, events: [], chain: [] }); return { ...share }; },
    getBatonShare(id) { const slot = batons.get(id); return slot ? { ...slot.share } : null; },
    batonEventsLog: [],
    addBatonEvent(event) { this.batonEventsLog.push(event); batons.get(event.batonId)?.events.push(event); },
    batonChain(id) { return batons.get(id)?.chain || []; },
    setBatonChain(id, chain) { if (batons.has(id)) batons.get(id).chain = chain; },
    listPairs(account) { return pairs.filter(p => p.a === account || p.b === account); },
    pairCount(account) { return pairs.filter(p => p.a === account || p.b === account).length; },
    createPair(pair) { pairs.push(pair); return { ...pair }; },
    getPair(id) { const pair = pairs.find(p => p.id === id); return pair ? { ...pair } : null; },
    deletePair(id) { const index = pairs.findIndex(p => p.id === id); if (index >= 0) pairs.splice(index, 1); },
    freezePair(id) { const pair = pairs.find(p => p.id === id); if (pair) pair.freezesUsed += 1; },
    listCircles(account) { return [...circles.values()].filter(c => c.members.has(account)).map(c => ({ ...c, members: [...c.members] })); },
    createCircle({ id, name, inviteCode, owner }) {
      const circle = { id, name, inviteCode, owner, members: new Set([owner]) };
      circles.set(id, circle);
      return { id, name, inviteCode, owner, members: [owner] };
    },
    findCircleByInvite(code) { const circle = [...circles.values()].find(c => c.inviteCode === code); return circle ? { ...circle, members: [...circle.members] } : null; },
    getCircle(id) { const circle = circles.get(id); return circle ? { ...circle, members: [...circle.members] } : null; },
    circleMemberCount(id) { return circles.get(id)?.members.size || 0; },
    joinCircle(id, account) { circles.get(id)?.members.add(account); },
    leaveCircle(id, account) { circles.get(id)?.members.delete(account); },
    isCircleMember(id, account) { return circles.get(id)?.members.has(account) || false; },
    circleOwner(id) { return circles.get(id)?.owner || null; },
    removeCircleMember(id, member) { circles.get(id)?.members.delete(member); },
    circleHomeStub: null,
    circleHome(id) { return this.circleHomeStub ? JSON.parse(JSON.stringify(this.circleHomeStub)) : { wall: [], chain: [], freedTo: null, rankView: null }; },
    block(account, target) { if (!blocks.has(account)) blocks.set(account, new Set()); blocks.get(account).add(target); },
    unblock(account, target) { blocks.get(account)?.delete(target); },
    listBlocks(account) { return [...(blocks.get(account) || [])]; },
    blockedBetween(a, b) { return blocks.get(a)?.has(b) || blocks.get(b)?.has(a) || false; },
    report(entry) { reports.push(entry); },
    questFeedbackLog: [],
    getQuestProgress() { return null; },
    recordQuestFeedback(entry) { this.questFeedbackLog.push(entry); },
    purgeAccount(account) {
      purged.push(account);
      state.delete(account);
      profiles.delete(account);
      sharedEvents.delete(account);
      blocks.delete(account);
      for (const pair of [...pairs]) if (pair.a === account || pair.b === account) pairs.splice(pairs.indexOf(pair), 1);
      for (const circle of circles.values()) circle.members.delete(account);
    },
  };
}

const WEEK = '2026-W43';
const SEED_MATCH = {
  alias: '安静的湖', avatarColor: '#4C7A93', style: 'night-creator',
  similarity: 0.86, theirGraduations: 5, reasons: ['你们都在晚上做创作类的事'], recentUsages: ['meeting-notes'],
};

async function call(service, { method = 'GET', path, body, account, ip = '127.0.0.1', contentType = 'application/json', rawBody } = {}) {
  const chunks = rawBody !== undefined ? [rawBody] : body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
  const req = Readable.from(chunks);
  req.method = method;
  req.headers = { 'content-type': contentType, ...(account ? { 'x-test-account': account } : {}) };
  req.socket = { remoteAddress: ip };
  const res = {
    status: 0, payload: null, destroyed: false,
    writeHead(status, headers) { this.status = status; this.headers = headers; return this; },
    end(value) { if (value !== undefined) { this.raw = value; try { this.payload = JSON.parse(value); } catch { this.payload = value; } } return this; },
  };
  const handled = await service.handle(req, res, path);
  return { handled, status: res.status, body: res.payload, raw: res.raw };
}

let createService;
test('social service suite loads the module under test', async t => {
  const mod = await import('../../scripts/social-service.mjs');
  createService = mod.createSocialService;
  assert.equal(typeof createService, 'function');
});

// The module-level import above runs before tests; use a lazy loader for the
// service in every test to keep the RED failure readable (module not found).
async function build(overrides = {}) {
  if (!createService) {
    const mod = await import('../../scripts/social-service.mjs');
    createService = mod.createSocialService;
  }
  const store = overrides.store || mkStore();
  const clock = { now: Date.parse('2026-10-21T08:00:00Z') };
  const matcherLog = [];
  const matcher = overrides.matcher || (async ctx => {
    matcherLog.push({ allowPublicPool: ctx.allowPublicPool, account: ctx.account, week: ctx.week });
    return overrides.matcherResult || [];
  });
  const service = createService({
    store,
    auth: overrides.auth || mkAuth(),
    matcher,
    now: () => clock.now,
    currentWeek: () => WEEK,
    rateLimits: { write: 60, preview: 60, windowMs: 60000 },
    ...overrides.options,
  });
  return { service, store, clock, matcherLog };
}

async function optedIn(service, account, { minor = false } = {}) {
  await call(service, { method: 'POST', path: '/api/social/opt-in', body: { enabled: true, minor }, account });
}

// ---------------------------------------------------------------------------
// 1) 鉴权 — guests only get preview (+ baton link, §4.8).
// ---------------------------------------------------------------------------

test('non-social paths are not handled', async () => {
  const { service } = await build();
  const req = Readable.from([]); req.method = 'GET'; req.headers = {}; req.socket = { remoteAddress: '127.0.0.1' };
  const res = { writeHead() { return this; }, end() { return this; } };
  assert.equal(await service.handle(req, res, '/api/collaboration/groups'), false);
});

test('guest can call preview; it shows the 6 styles and no account data', async () => {
  const { service } = await build();
  const out = await call(service, { path: '/api/social/preview' });
  assert.equal(out.status, 200);
  assert.equal(out.body.blurred, true);
  assert.equal(out.body.styles.length, 6);
  assert.deepEqual(out.body.styles.map(s => s.id), STYLES.map(s => s.id));
  assert.ok(typeof out.body.inviteText === 'string' && out.body.inviteText.length > 0);
  assert.ok(!JSON.stringify(out.body).match(/account|alias/));
});

test('every non-preview route rejects guests with 401', async () => {
  const { service } = await build();
  const guestCalls = [
    ['/api/social/state', 'GET'],
    ['/api/social/opt-in', 'POST'],
    ['/api/social/profile', 'POST'],
    ['/api/social/matches', 'GET'],
    ['/api/social/kudos', 'POST'],
    ['/api/social/baton', 'POST'],
    ['/api/social/pairs', 'POST'],
    ['/api/social/circles', 'POST'],
    ['/api/social/quests', 'GET'],
    ['/api/social/block', 'POST'],
    ['/api/social/report', 'POST'],
    ['/api/social/delete-me', 'POST'],
  ];
  for (const [path, method] of guestCalls) {
    const out = await call(service, { method, path, body: {} });
    assert.equal(out.status, 401, path + ' should require login');
    assert.equal(out.body.error, 'AUTH_REQUIRED', path);
  }
});

// ---------------------------------------------------------------------------
// 2) opt-in 与化名（服务端生成）。
// ---------------------------------------------------------------------------

test('opt-in body is exact-key: unknown fields rejected', async () => {
  const { service } = await build();
  const out = await call(service, { method: 'POST', path: '/api/social/opt-in', body: { enabled: true, surprise: 1 }, account: 'u1' });
  assert.equal(out.status, 400);
  assert.equal(out.body.error, 'INVALID_INPUT');
});

test('opt-in enables the feed and the server generates alias + avatar color', async () => {
  const { service } = await build();
  const out = await call(service, { method: 'POST', path: '/api/social/opt-in', body: { enabled: true, minor: false }, account: 'u1' });
  assert.equal(out.status, 200);
  assert.equal(out.body.optIn, true);
  assert.ok(out.body.alias && out.body.alias.length > 0);
  assert.ok(isAvatarColor(out.body.avatarColor));
  const state = await call(service, { path: '/api/social/state', account: 'u1' });
  assert.equal(state.body.optIn, true);
});

test('state for a logged-in user without opt-in reports optIn false', async () => {
  const { service } = await build();
  const out = await call(service, { path: '/api/social/state', account: 'u1' });
  assert.equal(out.status, 200);
  assert.equal(out.body.optIn, false);
});

test('alias endpoint validates shape and persists', async () => {
  const { service } = await build();
  await optedIn(service, 'u1');
  const bad = await call(service, { method: 'POST', path: '/api/social/alias', body: { alias: 'x'.repeat(40), avatarColor: '#4C7A93' }, account: 'u1' });
  assert.equal(bad.status, 400);
  const good = await call(service, { method: 'POST', path: '/api/social/alias', body: { alias: '晚风的溪', avatarColor: '#3E7B5B' }, account: 'u1' });
  assert.equal(good.status, 200);
  assert.equal(good.body.alias, '晚风的溪');
});

// ---------------------------------------------------------------------------
// 3) D2 白名单 — uploads reject unknown fields; nothing private is stored.
// ---------------------------------------------------------------------------

function mkFeatures() {
  return {
    week: WEEK,
    kindMix: { necessary: 0.3, create: 0.25, connect: 0.1, explore: 0.15, restore: 0.1, stillness: 0.1 },
    rhythm: { dawn: 0.1, morning: 0.3, afternoon: 0.25, evening: 0.2, night: 0.15 },
    usages: ['meeting-notes', 'paper-5points'],
    relays: 9,
    graduations: 3,
    rating: { much: 4, little: 2, none: 1 },
    freedTo: { family: 0.3, exercise: 0.25, study: 0.2, rest: 0.15, hobby: 0.08, other: 0.02 },
    freedMinutesConfirmed: 180,
  };
}

test('upload-profile requires opt-in first (403 SOCIAL_OPT_IN_REQUIRED)', async () => {
  const { service } = await build();
  const out = await call(service, { method: 'POST', path: '/api/social/profile', body: mkFeatures(), account: 'u1' });
  assert.equal(out.status, 403);
  assert.equal(out.body.error, 'SOCIAL_OPT_IN_REQUIRED');
});

test('a valid features payload passes and only the whitelisted 9 fields land in the store', async () => {
  const { service, store } = await build();
  await optedIn(service, 'u1');
  const out = await call(service, { method: 'POST', path: '/api/social/profile', body: mkFeatures(), account: 'u1' });
  assert.equal(out.status, 200);
  assert.equal(store.savedProfiles.length, 1);
  const stored = store.savedProfiles[0].features;
  assert.deepEqual(Object.keys(stored).sort(), [
    'freedMinutesConfirmed', 'freedTo', 'graduations', 'kindMix', 'rating', 'relays', 'rhythm', 'usages', 'week',
  ]);
  const text = JSON.stringify(stored);
  for (const forbidden of ['title', 'material', 'time', 'note', 'location', 'aiResult']) {
    assert.ok(!text.includes('"' + forbidden), 'stored payload must not contain ' + forbidden);
  }
});

test('D2: every FORBIDDEN_UPLOAD_FIELDS field is rejected and never stored (标题/材料/时间)', async () => {
  const { service, store } = await build();
  await optedIn(service, 'u1');
  assert.ok(FORBIDDEN_UPLOAD_FIELDS.length >= 20);
  for (const field of FORBIDDEN_UPLOAD_FIELDS) {
    const payload = mkFeatures();
    payload[field] = '我的秘密标题/材料/2026-10-25T02:00';
    const out = await call(service, { method: 'POST', path: '/api/social/profile', body: payload, account: 'u1' });
    assert.equal(out.status, 400, field + ' must be rejected');
    assert.equal(out.body.error, 'UPLOAD_FIELDS_REJECTED', field);
    // the rejected value must not echo back in the error body either
    assert.ok(!JSON.stringify(out.body).includes('我的秘密标题'), field + ' leaked in error body');
  }
  assert.equal(store.savedProfiles.length, 0, 'no rejected payload may reach the store');
});

test('D2: nested unknown fields (kindMix.guesses, rating.extra) are rejected too', async () => {
  const { service, store } = await build();
  await optedIn(service, 'u1');
  const nested = mkFeatures();
  nested.kindMix.guesses = 0.2;
  let out = await call(service, { method: 'POST', path: '/api/social/profile', body: nested, account: 'u1' });
  assert.equal(out.status, 400);
  assert.equal(out.body.error, 'UPLOAD_FIELDS_REJECTED');
  const nested2 = mkFeatures();
  nested2.rating.extra = 3;
  out = await call(service, { method: 'POST', path: '/api/social/profile', body: nested2, account: 'u1' });
  assert.equal(out.status, 400);
  assert.equal(store.savedProfiles.length, 0);
});

// ---------------------------------------------------------------------------
// 4) 限流。
// ---------------------------------------------------------------------------

test('write rate limit answers 429 and resets after the window', async () => {
  const { service, clock } = await build({ options: { rateLimits: { write: 3, preview: 60, windowMs: 60000 } } });
  await optedIn(service, 'u1'); // write hit 1
  const first = await call(service, { method: 'POST', path: '/api/social/alias', body: { alias: '晚风的溪', avatarColor: '#3E7B5B' }, account: 'u1' });
  const second = await call(service, { method: 'POST', path: '/api/social/alias', body: { alias: '晚风的溪', avatarColor: '#3E7B5B' }, account: 'u1' });
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  const third = await call(service, { method: 'POST', path: '/api/social/alias', body: { alias: '晚风的溪', avatarColor: '#3E7B5B' }, account: 'u1' });
  assert.equal(third.status, 429);
  assert.equal(third.body.error, 'RATE_LIMITED');
  clock.now += 61000;
  const fourth = await call(service, { method: 'POST', path: '/api/social/alias', body: { alias: '晚风的溪', avatarColor: '#3E7B5B' }, account: 'u1' });
  assert.equal(fourth.status, 200);
});

test('preview rate limit is per IP; another IP is unaffected', async () => {
  const { service } = await build({ options: { rateLimits: { write: 60, preview: 3, windowMs: 60000 } } });
  for (let i = 0; i < 3; i += 1) assert.equal((await call(service, { path: '/api/social/preview', ip: '10.0.0.1' })).status, 200);
  const limited = await call(service, { path: '/api/social/preview', ip: '10.0.0.1' });
  assert.equal(limited.status, 429);
  assert.equal((await call(service, { path: '/api/social/preview', ip: '10.0.0.2' })).status, 200);
});

// ---------------------------------------------------------------------------
// 5) 未成年人（自报）分支。
// ---------------------------------------------------------------------------

test('a self-reported minor never queries the public match pool', async () => {
  const { service, matcherLog } = await build({ matcherResult: [SEED_MATCH] });
  await optedIn(service, 'adult');
  await optedIn(service, 'kid', { minor: true });
  await call(service, { path: '/api/social/matches?week=' + WEEK, account: 'adult' });
  await call(service, { path: '/api/social/matches?week=' + WEEK, account: 'kid' });
  assert.equal(matcherLog.length, 2);
  assert.equal(matcherLog[0].allowPublicPool, true);
  assert.equal(matcherLog[1].allowPublicPool, false);
});

test('minors can only join circles via invite code (403 without one)', async () => {
  const { service, store } = await build();
  await optedIn(service, 'founder');
  await optedIn(service, 'kid', { minor: true });
  const created = await call(service, { method: 'POST', path: '/api/social/circles', body: { name: '王老师课题组' }, account: 'founder' });
  assert.equal(created.status, 200);
  const noCode = await call(service, { method: 'POST', path: '/api/social/circles/join', body: { circleId: created.body.circle.id }, account: 'kid' });
  assert.equal(noCode.status, 403);
  assert.equal(noCode.body.error, 'MINOR_INVITE_CODE_REQUIRED');
  const withCode = await call(service, { method: 'POST', path: '/api/social/circles/join', body: { inviteCode: created.body.circle.inviteCode }, account: 'kid' });
  assert.equal(withCode.status, 200);
  assert.equal(store.isCircleMember(created.body.circle.id, 'kid'), true);
});

test('adults may join via circle link (no code) — the minor-only gate stays narrow', async () => {
  const { service } = await build();
  await optedIn(service, 'founder');
  await optedIn(service, 'adult');
  const created = await call(service, { method: 'POST', path: '/api/social/circles', body: { name: '教研组' }, account: 'founder' });
  const out = await call(service, { method: 'POST', path: '/api/social/circles/join', body: { circleId: created.body.circle.id }, account: 'adult' });
  assert.equal(out.status, 200);
});

// ---------------------------------------------------------------------------
// 6) 匹配 D4 — 略多一点 + 冷启动不造假。
// ---------------------------------------------------------------------------

test('out-of-range candidates are filtered by the slightly-ahead gate', async () => {
  const myGraduations = 3; // range: >=3 and <= 3*2+2 = 8
  const matcherResult = [
    { ...SEED_MATCH, theirGraduations: 3 },
    { ...SEED_MATCH, alias: '落后的鹿', theirGraduations: 1 },               // less than me
    { ...SEED_MATCH, alias: '超前的鹰', theirGraduations: 9 },               // beyond 2x+2
    { ...SEED_MATCH, alias: '边缘的松', theirGraduations: 8 },               // exactly 2x+2 — keep
  ];
  const { service, store } = await build({ matcherResult });
  await optedIn(service, 'me');
  store.saveProfile('me', { ...mkFeatures(), graduations: myGraduations });
  const out = await call(service, { path: '/api/social/matches?week=' + WEEK, account: 'me' });
  assert.equal(out.status, 200);
  const aliases = out.body.matches.map(m => m.alias);
  assert.deepEqual(aliases.sort(), ['安静的湖', '边缘的松']);
  for (const rec of out.body.matches) assert.ok(validateMatch(rec, { myGraduations }));
});

test('matches are capped at MATCHES_PER_WEEK and validated on the way out', async () => {
  const five = Array.from({ length: 5 }, (_, i) => ({ ...SEED_MATCH, alias: '候选' + i, theirGraduations: 4 }));
  const { service, store } = await build({ matcherResult: five });
  await optedIn(service, 'me');
  store.saveProfile('me', { ...mkFeatures(), graduations: 4 });
  const out = await call(service, { path: '/api/social/matches?week=' + WEEK, account: 'me' });
  assert.equal(out.body.matches.length, MATCHES_PER_WEEK);
  for (const rec of out.body.matches) assert.ok(validateMatch(rec, { myGraduations: 4 }));
});

test('cold start with an empty pool returns fallback invite — no fabricated people', async () => {
  const { service } = await build({ matcherResult: [] });
  await optedIn(service, 'me');
  const out = await call(service, { path: '/api/social/matches?week=' + WEEK, account: 'me' });
  assert.equal(out.status, 200);
  assert.deepEqual(out.body.matches, []);
  assert.equal(out.body.fallback, 'invite');
});

test('matches require opt-in', async () => {
  const { service } = await build();
  const out = await call(service, { path: '/api/social/matches', account: 'me' });
  assert.equal(out.status, 403);
  assert.equal(out.body.error, 'SOCIAL_OPT_IN_REQUIRED');
});

// ---------------------------------------------------------------------------
// 7) 加油 kudos — 只能对本人确认分享后的事件加油。
// ---------------------------------------------------------------------------

test('kudos works only on events the owner confirmed as shared', async () => {
  const { service, store } = await build();
  await optedIn(service, 'sharer');
  await optedIn(service, 'fan');
  const shared = await call(service, { method: 'POST', path: '/api/social/shared-event', body: { kind: 'usage-learned' }, account: 'sharer' });
  assert.equal(shared.status, 200);
  const ok = await call(service, {
    method: 'POST', path: '/api/social/kudos',
    body: { from: 'fan', to: 'sharer', eventKind: 'usage-learned', sharedEventId: shared.body.id },
    account: 'fan',
  });
  assert.equal(ok.status, 200);
  const unshared = await call(service, {
    method: 'POST', path: '/api/social/kudos',
    body: { from: 'fan', to: 'sharer', eventKind: 'self-kept', sharedEventId: 'se-made-up' },
    account: 'fan',
  });
  assert.equal(unshared.status, 403);
  assert.equal(unshared.body.error, 'KUDOS_EVENT_NOT_SHARED');
  const listed = await call(service, { path: '/api/social/kudos', account: 'sharer' });
  assert.equal(listed.body.kudos.length, 1);
});

test('kudos payload rejects unknown kinds and from must be the caller', async () => {
  const { service } = await build();
  await optedIn(service, 'a');
  const badKind = await call(service, { method: 'POST', path: '/api/social/kudos', body: { from: 'a', to: 'b', eventKind: 'hug', sharedEventId: 'se-1' }, account: 'a' });
  assert.equal(badKind.status, 400);
  const spoof = await call(service, { method: 'POST', path: '/api/social/kudos', body: { from: 'someone-else', to: 'b', eventKind: 'self-kept', sharedEventId: 'se-1' }, account: 'a' });
  assert.equal(spoof.status, 403);
  assert.equal(spoof.body.error, 'FORBIDDEN');
});

test('blocked accounts cannot send kudos (BLOCKED)', async () => {
  const { service, store } = await build();
  await optedIn(service, 'sharer');
  await optedIn(service, 'fan');
  const shared = store.recordSharedEvent('sharer', 'self-kept');
  store.block('sharer', 'fan');
  const out = await call(service, {
    method: 'POST', path: '/api/social/kudos',
    body: { from: 'fan', to: 'sharer', eventKind: 'self-kept', sharedEventId: shared.id },
    account: 'fan',
  });
  assert.equal(out.status, 403);
  assert.equal(out.body.error, 'BLOCKED');
});

// ---------------------------------------------------------------------------
// 8) 传棒 baton（D6）— 卡只含三个字段，链封顶 5 跳，链接访客可开。
// ---------------------------------------------------------------------------

const CARD = {
  usageId: 'meeting-notes',
  scenarioTitle: '会议材料 → 重点和待办',
  promptTemplate: '请把下面的会议内容整理成三部分：重点、待办、没说清的地方。\n会议内容：{{material}}',
};

test('baton card with a 4th field is rejected and never created', async () => {
  const { service, store } = await build();
  await optedIn(service, 'sender');
  const card = { ...CARD, senderNote: '给你看看我的纪要' };
  const out = await call(service, { method: 'POST', path: '/api/social/baton', body: { targetKind: 'link', targetId: null, card }, account: 'sender' });
  assert.equal(out.status, 400);
  assert.equal(out.body.error, 'BATON_CARD_REJECTED');
});

test('sending a baton returns an id and records the sent event', async () => {
  const { service, store } = await build();
  await optedIn(service, 'sender');
  const out = await call(service, { method: 'POST', path: '/api/social/baton', body: { targetKind: 'link', targetId: null, card: CARD }, account: 'sender' });
  assert.equal(out.status, 200);
  assert.ok(out.body.id);
  assert.deepEqual(Object.keys(out.body.card).sort(), ['promptTemplate', 'scenarioTitle', 'usageId']);
  assert.equal(store.getBatonShare(out.body.id).fromAccount, 'sender');
});

test('a guest can open a baton link (PRD §4.8) and sees exactly the card', async () => {
  const { service, store } = await build();
  await optedIn(service, 'sender');
  const sent = await call(service, { method: 'POST', path: '/api/social/baton', body: { targetKind: 'link', targetId: null, card: CARD }, account: 'sender' });
  const opened = await call(service, { path: '/api/social/baton/' + sent.body.id });
  assert.equal(opened.status, 200);
  assert.deepEqual(Object.keys(opened.body.card).sort(), ['promptTemplate', 'scenarioTitle', 'usageId']);
  assert.equal(opened.body.card.scenarioTitle, CARD.scenarioTitle);
});

test('baton chain view is capped at 5 hops (D6)', async () => {
  const { service, store } = await build();
  await optedIn(service, 'sender');
  const sent = await call(service, { method: 'POST', path: '/api/social/baton', body: { targetKind: 'link', targetId: null, card: CARD }, account: 'sender' });
  store.setBatonChain(sent.body.id, ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']);
  const opened = await call(service, { path: '/api/social/baton/' + sent.body.id });
  assert.ok(opened.body.chain.length <= 5);
  assert.deepEqual(opened.body.chain, ['d', 'e', 'f', 'g', 'h']);
});

test('relay completion is a logged event; unknown kinds and ids fail', async () => {
  const { service, store } = await build();
  await optedIn(service, 'sender');
  await optedIn(service, 'learner');
  const sent = await call(service, { method: 'POST', path: '/api/social/baton', body: { targetKind: 'pair', targetId: 'learner', card: CARD }, account: 'sender' });
  const done = await call(service, { method: 'POST', path: '/api/social/baton/' + sent.body.id + '/event', body: { kind: 'relay-completed' }, account: 'learner' });
  assert.equal(done.status, 200);
  const events = store.batonEventsLog.filter(e => e.batonId === sent.body.id && e.kind === 'relay-completed');
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'relay-completed');
  assert.equal(events[0].byAccount, 'learner');
  const badKind = await call(service, { method: 'POST', path: '/api/social/baton/' + sent.body.id + '/event', body: { kind: 'teleported' }, account: 'learner' });
  assert.equal(badKind.status, 400);
  const missing = await call(service, { method: 'POST', path: '/api/social/baton/nope/event', body: { kind: 'opened' }, account: 'learner' });
  assert.equal(missing.status, 404);
});

// ---------------------------------------------------------------------------
// 9) 搭档 pairs。
// ---------------------------------------------------------------------------

test('pair guards: no self-pairing, max 5 partners, one freeze per week', async () => {
  const { service, store } = await build();
  await optedIn(service, 'me');
  for (let i = 1; i <= 5; i += 1) {
    await optedIn(service, 'p' + i);
    store.createPair({ id: 'pr-' + i, a: 'me', b: 'p' + i, startedWeek: WEEK, flame: 0, freezesUsed: 0 });
  }
  await optedIn(service, 'p6');
  const self = await call(service, { method: 'POST', path: '/api/social/pairs', body: { with: 'me' }, account: 'me' });
  assert.equal(self.status, 400);
  assert.equal(self.body.error, 'PAIR_SELF_FORBIDDEN');
  const sixth = await call(service, { method: 'POST', path: '/api/social/pairs', body: { with: 'p6' }, account: 'me' });
  assert.equal(sixth.status, 409);
  assert.equal(sixth.body.error, 'PAIR_LIMIT_REACHED');
  const freeze1 = await call(service, { method: 'POST', path: '/api/social/pairs/pr-1/freeze', body: {}, account: 'me' });
  assert.equal(freeze1.status, 200);
  const freeze2 = await call(service, { method: 'POST', path: '/api/social/pairs/pr-1/freeze', body: {}, account: 'me' });
  assert.equal(freeze2.status, 409);
  assert.equal(freeze2.body.error, 'PAIR_FROZEN_ALREADY');
  const leave = await call(service, { method: 'POST', path: '/api/social/pairs/pr-1/leave', body: {}, account: 'me' });
  assert.equal(leave.status, 200);
  assert.equal(store.getPair('pr-1'), null);
});

test('blocked accounts cannot pair up (BLOCKED)', async () => {
  const { service, store } = await build();
  await optedIn(service, 'a');
  await optedIn(service, 'b');
  store.block('b', 'a');
  const out = await call(service, { method: 'POST', path: '/api/social/pairs', body: { with: 'b' }, account: 'a' });
  assert.equal(out.status, 403);
  assert.equal(out.body.error, 'BLOCKED');
});

// ---------------------------------------------------------------------------
// 10) 圈 circles（D5 排名只按传棒/毕业）。
// ---------------------------------------------------------------------------

async function mkCircle(service, owner = 'founder', name = '王老师课题组') {
  await optedIn(service, owner);
  return call(service, { method: 'POST', path: '/api/social/circles', body: { name }, account: owner });
}

test('create circle returns a 6–12 A-Z0-9 invite code; long names rejected', async () => {
  const { service } = await build();
  const created = await mkCircle(service);
  assert.equal(created.status, 200);
  assert.match(created.body.circle.inviteCode, /^[A-Z0-9]{6,12}$/);
  const bad = await call(service, { method: 'POST', path: '/api/social/circles', body: { name: '超'.repeat(31) }, account: 'founder' });
  assert.equal(bad.status, 400);
});

test('join with a wrong invite code is 404; full circle is 409', async () => {
  const { service, store } = await build();
  const created = await mkCircle(service);
  await optedIn(service, 'someone');
  const wrong = await call(service, { method: 'POST', path: '/api/social/circles/join', body: { inviteCode: 'ZZZZZZ9' }, account: 'someone' });
  assert.equal(wrong.status, 404);
  assert.equal(wrong.body.error, 'CIRCLE_INVITE_CODE_INVALID');
  // fill to 50 (owner + 49 direct members)
  await optedIn(service, 'filler');
  for (let i = 0; i < 49; i += 1) store.joinCircle(created.body.circle.id, 'm' + i);
  const full = await call(service, { method: 'POST', path: '/api/social/circles/join', body: { inviteCode: created.body.circle.inviteCode }, account: 'filler' });
  assert.equal(full.status, 409);
  assert.equal(full.body.error, 'CIRCLE_FULL');
});

test('circle home requires membership; only the owner can remove members', async () => {
  const { service } = await build();
  const created = await mkCircle(service);
  const id = created.body.circle.id;
  await optedIn(service, 'outsider');
  await optedIn(service, 'mate');
  await call(service, { method: 'POST', path: '/api/social/circles/join', body: { inviteCode: created.body.circle.inviteCode }, account: 'mate' });
  const outsider = await call(service, { path: '/api/social/circles/' + id, account: 'outsider' });
  assert.equal(outsider.status, 403);
  assert.equal(outsider.body.error, 'NOT_CIRCLE_MEMBER');
  const notOwner = await call(service, { method: 'POST', path: '/api/social/circles/' + id + '/remove', body: { member: 'founder' }, account: 'mate' });
  assert.equal(notOwner.status, 403);
  assert.equal(notOwner.body.error, 'NOT_CIRCLE_OWNER');
  const owner = await call(service, { method: 'POST', path: '/api/social/circles/' + id + '/remove', body: { member: 'mate' }, account: 'founder' });
  assert.equal(owner.status, 200);
});

test('circle home rank and freedTo pass the D5 validators; contaminated views are refused', async () => {
  const { service, store } = await build();
  const created = await mkCircle(service);
  const id = created.body.circle.id;
  const goodHome = {
    wall: [{ usageId: 'paper-5points', count: 6 }],
    chain: ['founder'],
    freedTo: { family: 0.2, exercise: 0.4, study: 0.2, rest: 0.1, hobby: 0.05, other: 0.05 },
    rankView: {
      top: [
        { rank: 1, alias: '远山的松', avatarColor: '#615CED', batons: 7, graduations: 2 },
        { rank: 2, alias: '晨跑的鹿', avatarColor: '#E8B04B', batons: 5, graduations: 1 },
      ],
      you: { rank: 6, alias: '你', avatarColor: '#E95432', batons: 2, graduations: 0 },
    },
  };
  store.circleHomeStub = goodHome;
  const home = await call(service, { path: '/api/social/circles/' + id, account: 'founder' });
  assert.equal(home.status, 200);
  assert.ok(validateCircleRankView(home.body.rank));
  assert.ok(validateFreedToSummary(home.body.freedTo));
  store.circleHomeStub = { ...goodHome, rankView: { top: [{ rank: 1, alias: '远山的松', avatarColor: '#615CED', batons: 7, graduations: 2, workHours: 30 }], you: null } };
  const dirty = await call(service, { path: '/api/social/circles/' + id, account: 'founder' });
  assert.equal(dirty.status, 500);
  assert.equal(dirty.body.error, 'SOCIAL_DATA_INVALID');
});

// ---------------------------------------------------------------------------
// 11) 周挑战 quests。
// ---------------------------------------------------------------------------

test('quests: exactly 3 per week, valid shapes, too-much feedback accepted', async () => {
  const { service } = await build();
  await optedIn(service, 'me');
  const out = await call(service, { path: '/api/social/quests?week=' + WEEK, account: 'me' });
  assert.equal(out.status, 200);
  assert.equal(out.body.quests.length, 3);
  for (const entry of out.body.quests) assert.ok(validateQuest(entry.quest));
  assert.ok(out.body.quests.some(q => q.quest.scope === 'circle'));
  assert.ok(out.body.quests.some(q => q.quest.scope === 'personal'));
  const questId = out.body.quests[0].quest.id;
  const feedback = await call(service, { method: 'POST', path: '/api/social/quests/' + questId + '/feedback', body: { type: 'too-much' }, account: 'me' });
  assert.equal(feedback.status, 200);
  const badType = await call(service, { method: 'POST', path: '/api/social/quests/' + questId + '/feedback', body: { type: 'way-too-easy' }, account: 'me' });
  assert.equal(badType.status, 400);
});

test('the same week always yields the same 3 quests (deterministic, no AI)', async () => {
  const { service } = await build();
  await optedIn(service, 'me');
  const a = await call(service, { path: '/api/social/quests?week=' + WEEK, account: 'me' });
  const b = await call(service, { path: '/api/social/quests?week=' + WEEK, account: 'me' });
  assert.deepEqual(a.body.quests.map(q => q.quest.id), b.body.quests.map(q => q.quest.id));
});

// ---------------------------------------------------------------------------
// 12) 屏蔽与举报。
// ---------------------------------------------------------------------------

test('block lists persist and can be undone; report requires a reason', async () => {
  const { service } = await build();
  await call(service, { method: 'POST', path: '/api/social/block', body: { account: 'nuisance' }, account: 'me' });
  const listed = await call(service, { path: '/api/social/blocks', account: 'me' });
  assert.deepEqual(listed.body.blocked, ['nuisance']);
  const undo = await call(service, { method: 'POST', path: '/api/social/block/nuisance/remove', body: {}, account: 'me' });
  assert.equal(undo.status, 200);
  const emptied = await call(service, { path: '/api/social/blocks', account: 'me' });
  assert.deepEqual(emptied.body.blocked, []);
  const report = await call(service, { method: 'POST', path: '/api/social/report', body: { account: 'nuisance', reason: '一直发无关内容' }, account: 'me' });
  assert.equal(report.status, 200);
  const noReason = await call(service, { method: 'POST', path: '/api/social/report', body: { account: 'nuisance' }, account: 'me' });
  assert.equal(noReason.status, 400);
});

// ---------------------------------------------------------------------------
// 13) delete-me — 级联彻底删除（D2）。
// ---------------------------------------------------------------------------

test('delete-me purges the account from the store and turns opt-in off', async () => {
  const { service, store } = await build();
  await optedIn(service, 'me');
  const out = await call(service, { method: 'POST', path: '/api/social/delete-me', body: {}, account: 'me' });
  assert.equal(out.status, 200);
  assert.equal(out.body.deleted, true);
  assert.deepEqual(store.purged, ['me']);
  const state = await call(service, { path: '/api/social/state', account: 'me' });
  assert.equal(state.body.optIn, false);
});

// ---------------------------------------------------------------------------
// 14) 错误码齐全（404/405/415/400/413）。
// ---------------------------------------------------------------------------

test('unknown social route -> 404; wrong method -> 405', async () => {
  const { service } = await build();
  const unknown = await call(service, { path: '/api/social/definitely-not-here', account: 'me' });
  assert.equal(unknown.status, 404);
  assert.equal(unknown.body.error, 'NOT_FOUND');
  const wrongMethod = await call(service, { method: 'POST', path: '/api/social/state', body: {}, account: 'me' });
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.body.error, 'METHOD_NOT_ALLOWED');
});

test('non-JSON content type -> 415; broken JSON -> 400; oversized body -> 413', async () => {
  const { service } = await build();
  await optedIn(service, 'me');
  const wrongType = await call(service, { method: 'POST', path: '/api/social/opt-in', body: { enabled: true }, account: 'me', contentType: 'text/plain' });
  assert.equal(wrongType.status, 415);
  assert.equal(wrongType.body.error, 'JSON_REQUIRED');
  const broken = await call(service, { method: 'POST', path: '/api/social/opt-in', rawBody: Buffer.from('{nope'), account: 'me' });
  assert.equal(broken.status, 400);
  assert.equal(broken.body.error, 'INVALID_JSON');
  const big = await call(service, { method: 'POST', path: '/api/social/opt-in', rawBody: Buffer.from('x'.repeat(129 * 1024)), account: 'me' });
  assert.equal(big.status, 413);
  assert.equal(big.body.error, 'BODY_TOO_LARGE');
});
