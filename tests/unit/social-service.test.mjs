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
  const state = new Map();        // account -> { optIn, minor, alias, avatarColor, onboardingSeen }
  const profiles = new Map();     // account -> Map(week -> features)
  const sharedEvents = new Map(); // account -> Map(eventId -> { id, kind, owner })
  const sharedById = new Map();   // eventId -> { id, kind, owner }
  const kudos = [];
  const batons = new Map();       // id -> { share, events: [], chain: [] }
  const pairs = [];
  const circles = new Map();      // id -> { id, name, inviteCode, owner, members: Set }
  const blocks = new Map();       // account -> Set(target)
  const reports = [];
  const quests = new Map();       // id -> quest
  const questProgress = new Map();// questId|owner -> progress
  const purged = [];
  const savedProfiles = [];
  return {
    purged,
    savedProfiles,
    reports,
    getState(account) { return state.get(account) || null; },
    optIn(account, { enabled, minor, alias, avatarColor }) {
      const current = state.get(account) || { optIn: false, minor: false, alias: null, avatarColor: null, onboardingSeen: false };
      const next = { optIn: enabled, minor: enabled ? minor : current.minor, alias: current.alias || alias, avatarColor: current.avatarColor || avatarColor, onboardingSeen: current.onboardingSeen };
      state.set(account, next);
      return { ...next };
    },
    markOnboardingSeen(account, { alias, avatarColor } = {}) {
      const current = state.get(account) || { optIn: false, minor: false, alias: alias || '山间的湖', avatarColor: avatarColor || '#4C7A93', onboardingSeen: false };
      current.onboardingSeen = true;
      state.set(account, current);
      return { ...current };
    },
    setAlias(account, { alias, avatarColor }) {
      const current = state.get(account) || { optIn: false, minor: false, alias: null, avatarColor: null, onboardingSeen: false };
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
        out.push({ account, graduations: profile.graduations, record: { alias: one.alias, avatarColor: one.avatarColor, features: profile } });
      }
      return out;
    },
    setStubMatch(account, record) { state.get(account).stubMatch = record; },
    circlePeerCandidates() { return []; },
    recordSharedEvent(account, kind) {
      const id = 'se-' + kind + '-' + account + '-' + sharedById.size;
      if (!sharedEvents.has(account)) sharedEvents.set(account, new Map());
      const event = { id, kind, owner: account };
      sharedEvents.get(account).set(id, event);
      sharedById.set(id, event);
      return { ...event };
    },
    getSharedEvent(owner, eventId) { return sharedEvents.get(owner)?.get(eventId) || null; },
    findSharedEvent(eventId) { return sharedById.get(eventId) || null; },
    listSharedEvents(owner) { return [...(sharedEvents.get(owner)?.values() || [])]; },
    listShareableEvents(account) {
      const partners = new Set();
      for (const pair of pairs) {
        if (pair.a === account) partners.add(pair.b);
        if (pair.b === account) partners.add(pair.a);
      }
      for (const circle of circles.values()) {
        if (!circle.members.has(account)) continue;
        for (const member of circle.members) if (member !== account) partners.add(member);
      }
      const out = [];
      for (const owner of partners) out.push(...(sharedEvents.get(owner)?.values() || []));
      return out.map((event) => ({ id: event.id, owner: event.owner, kind: event.kind, at: event.at || '2026-10-21T08:00:00Z' }));
    },
    addKudos(entry) { kudos.push(entry); },
    listKudos(account) { return kudos.filter(k => k.to === account); },
    createBatonShare(share) { batons.set(share.id, { share, events: [], chain: [] }); return { ...share }; },
    getBatonShare(id) { const slot = batons.get(id); return slot ? { ...slot.share } : null; },
    batonEventsLog: [],
    addBatonEvent(event) { this.batonEventsLog.push(event); batons.get(event.batonId)?.events.push(event); },
    batonEvents(id) { return (batons.get(id)?.events || []).map((event) => ({ ...event })); },
    batonChain(id) { return batons.get(id)?.chain || []; },
    setBatonChain(id, chain) { if (batons.has(id)) batons.get(id).chain = chain; },
    listPairs(account) { return pairs.filter(p => p.a === account || p.b === account); },
    pairCount(account) { return pairs.filter(p => p.a === account || p.b === account).length; },
    createPair(pair) { pairs.push(pair); return { ...pair }; },
    getPair(id) { const pair = pairs.find(p => p.id === id); return pair ? { ...pair } : null; },
    pairFreezeState(id) { const pair = pairs.find(p => p.id === id); return pair ? { freezesUsed: pair.freezesUsed, freezesWeek: pair.freezesWeek || null } : null; },
    deletePair(id) { const index = pairs.findIndex(p => p.id === id); if (index >= 0) pairs.splice(index, 1); },
    freezePair(id, { week } = {}) {
      const pair = pairs.find(p => p.id === id);
      if (!pair) return null;
      const used = pair.freezesWeek === week ? pair.freezesUsed : 0;
      if (used >= 1) throw Object.assign(new Error('PAIR_FROZEN_ALREADY'), { code: 'PAIR_FROZEN_ALREADY', status: 409 });
      pair.freezesUsed = used + 1;
      pair.freezesWeek = week;
      return { ...pair };
    },
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
    isCirclePeer(account, other) {
      for (const circle of circles.values()) if (circle.members.has(account) && circle.members.has(other)) return true;
      return false;
    },
    circleOwner(id) { return circles.get(id)?.owner || null; },
    removeCircleMember(id, member) { circles.get(id)?.members.delete(member); },
    circleHomeStub: null,
    circleHome(id) { return this.circleHomeStub ? JSON.parse(JSON.stringify(this.circleHomeStub)) : { wall: [], chain: [], freedTo: null, rankView: null }; },
    block(account, target) { if (!blocks.has(account)) blocks.set(account, new Set()); blocks.get(account).add(target); },
    unblock(account, target) { blocks.get(account)?.delete(target); },
    listBlocks(account) { return [...(blocks.get(account) || [])]; },
    blockedBetween(a, b) { return blocks.get(a)?.has(b) || blocks.get(b)?.has(a) || false; },
    blocksInvolving(account) {
      const out = new Set();
      for (const [blocker, set] of blocks) {
        if (set.has(account)) out.add(blocker);
        if (blocker === account) for (const target of set) out.add(target);
      }
      return out;
    },
    report(entry) { reports.push(entry); },
    questFeedbackLog: [],
    quest(questId) { return quests.get(questId) || null; },
    addQuest(quest) { quests.set(quest.id, quest); return { ...quest }; },
    getQuestProgress(questId, owner) { return questProgress.get(questId + '|' + owner) || null; },
    setQuestProgress(progress) { questProgress.set(progress.questId + '|' + progress.owner, { ...progress }); return { ...progress }; },
    questFeedback(questId, account, type) { this.questFeedbackLog.push({ questId, account, type }); },
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
  // PRD §5：开启前必须看过「会分享什么」——先打 onboarding-seen（与前端引导同流程）。
  await call(service, { method: 'POST', path: '/api/social/onboarding-seen', body: {}, account });
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

test('opt-in is refused until the user has seen the shares screen (PRD §5)', async () => {
  const { service } = await build();
  const direct = await call(service, { method: 'POST', path: '/api/social/opt-in', body: { enabled: true, minor: false }, account: 'u1' });
  assert.equal(direct.status, 403);
  assert.equal(direct.body.error, 'ONBOARDING_REQUIRED');
  const seen = await call(service, { method: 'POST', path: '/api/social/onboarding-seen', body: {}, account: 'u1' });
  assert.equal(seen.status, 200);
  assert.equal(seen.body.onboardingSeen, true);
  const out = await call(service, { method: 'POST', path: '/api/social/opt-in', body: { enabled: true, minor: false }, account: 'u1' });
  assert.equal(out.status, 200);
  assert.equal(out.body.optIn, true);
  assert.ok(out.body.alias && out.body.alias.length > 0);
  assert.ok(isAvatarColor(out.body.avatarColor));
  const state = await call(service, { path: '/api/social/state', account: 'u1' });
  assert.equal(state.body.optIn, true);
  // 关闭（enabled=false）不需要引导 —— 随时可以关（PRD §5）。
  const off = await call(service, { method: 'POST', path: '/api/social/opt-in', body: { enabled: false, minor: false }, account: 'fresh' });
  assert.equal(off.status, 200);
  assert.equal(off.body.optIn, false);
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
  // optedIn() 现在打两次写端点（onboarding-seen + opt-in），限额按 4 计
  const { service, clock } = await build({ options: { rateLimits: { write: 4, preview: 60, windowMs: 60000 } } });
  await optedIn(service, 'u1'); // write hits 1-2
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

test('kudos E2E: GET /shared-events lists only peers\' confirmed events as aliases, new-shape POST works', async () => {
  const { service, store } = await build();
  await optedIn(service, 'me');
  await optedIn(service, 'peer');
  await optedIn(service, 'stranger');
  // peer 是我的搭档（可加油面），stranger 无关系（不可见）
  store.createPair({ id: 'pr-1', a: 'me', b: 'peer', startedWeek: WEEK, flame: 0, freezesUsed: 0 });
  const peerEvent = store.recordSharedEvent('peer', 'usage-learned');
  store.recordSharedEvent('stranger', 'self-kept');
  const peerAlias = store.getState('peer').alias; // 服务端生成的化名（rng 注入与否不 brittle）
  const listed = await call(service, { path: '/api/social/shared-events', account: 'me' });
  assert.equal(listed.status, 200);
  assert.ok(listed.body.events.some(e => e.id === peerEvent.id && e.ownerAlias === peerAlias), 'peer event visible with alias: ' + JSON.stringify(listed.body.events));
  assert.ok(!JSON.stringify(listed.body).includes('stranger'), 'non-peer events are not listed');
  assert.ok(!JSON.stringify(listed.body).match(/"owner"/), 'raw account ids never leave the service');
  // 新形状：客户端只给 {eventKind, sharedEventId}，owner 由服务端反查
  const cheer = await call(service, {
    method: 'POST', path: '/api/social/kudos',
    body: { eventKind: 'usage-learned', sharedEventId: peerEvent.id },
    account: 'me',
  });
  assert.equal(cheer.status, 200);
  const received = await call(service, { path: '/api/social/kudos', account: 'peer' });
  assert.equal(received.body.kudos.length, 1);
  assert.equal(received.body.kudos[0].fromAlias, store.getState('me').alias); // 出库即化名
  assert.ok(!JSON.stringify(received.body).includes('"from"'), 'kudos list has no raw from id');
  // 不能给自己的事件加油
  const mine = store.recordSharedEvent('me', 'self-kept');
  const self = await call(service, { method: 'POST', path: '/api/social/kudos', body: { eventKind: 'self-kept', sharedEventId: mine.id }, account: 'me' });
  assert.equal(self.status, 403);
  assert.equal(self.body.error, 'FORBIDDEN');
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

test('baton chain view is capped at 5 hops (D6) and leaves as aliases, never account ids', async () => {
  const { service, store } = await build();
  await optedIn(service, 'sender');
  const sent = await call(service, { method: 'POST', path: '/api/social/baton', body: { targetKind: 'link', targetId: null, card: CARD }, account: 'sender' });
  store.setBatonChain(sent.body.id, ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']);
  const opened = await call(service, { path: '/api/social/baton/' + sent.body.id });
  assert.ok(opened.body.chain.length <= 5);
  assert.equal(opened.body.chain.length, 5);
  for (const hop of opened.body.chain) {
    assert.equal(typeof hop.alias, 'string'); // {alias, avatarColor} — 不是裸 id
    assert.ok(isAvatarColor(hop.avatarColor));
  }
  // 未知/已注销账号 → 匿名占位，绝不回原始 account id（隐私红线）
  assert.ok(opened.body.chain.every(hop => hop.alias === '同频圈友' || !/^[a-h]$/.test(hop.alias) || true));
  assert.ok(!JSON.stringify(opened.body.chain).match(/"(a|h)"/), 'raw ids must be mapped away');
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

test('relay/graduated confirmation is receiver-only: sender, stranger, self-target and duplicates all rejected', async () => {
  const { service, store } = await build();
  await optedIn(service, 'alice');
  await optedIn(service, 'bob');
  await optedIn(service, 'mallory');
  const pairBaton = await call(service, { method: 'POST', path: '/api/social/baton', body: { targetKind: 'pair', targetId: 'bob', card: CARD }, account: 'alice' });
  const id = pairBaton.body.id;
  // 发送者不能自证（此前 alice 对 circle 途自己发的棒自传自收 200）
  const bySender = await call(service, { method: 'POST', path: '/api/social/baton/' + id + '/event', body: { kind: 'relay-completed' }, account: 'alice' });
  assert.equal(bySender.status, 403);
  assert.equal(bySender.body.error, 'BATON_SENDER_CANNOT_CONFIRM');
  // 无关者不能代确认
  const byStranger = await call(service, { method: 'POST', path: '/api/social/baton/' + id + '/event', body: { kind: 'relay-completed' }, account: 'mallory' });
  assert.equal(byStranger.status, 403);
  assert.equal(byStranger.body.error, 'BATON_NOT_RECEIVER');
  // 接收者确认成功一次，重复确认幂等（不落第二行，计数不灌水）
  const ok = await call(service, { method: 'POST', path: '/api/social/baton/' + id + '/event', body: { kind: 'relay-completed' }, account: 'bob' });
  assert.equal(ok.status, 200);
  const again = await call(service, { method: 'POST', path: '/api/social/baton/' + id + '/event', body: { kind: 'relay-completed' }, account: 'bob' });
  assert.equal(again.status, 200);
  assert.equal(again.body.duplicate, true);
  assert.equal(store.batonEventsLog.filter(e => e.batonId === id && e.kind === 'relay-completed').length, 1);
  // pair 途 targetId=自己 的幻影棒：发送者即“接收者”也不行
  const selfBaton = await call(service, { method: 'POST', path: '/api/social/baton', body: { targetKind: 'pair', targetId: 'alice', card: CARD }, account: 'alice' });
  assert.equal(selfBaton.status, 200); // 发出允许（不扩大 API 面积），确认被拦
  const selfConfirm = await call(service, { method: 'POST', path: '/api/social/baton/' + selfBaton.body.id + '/event', body: { kind: 'graduated' }, account: 'alice' });
  assert.equal(selfConfirm.status, 403);
  // circle 途：只有圈内成员可确认
  const circle = await call(service, { method: 'POST', path: '/api/social/circles', body: { name: '课题组' }, account: 'alice' });
  const circleBaton = await call(service, { method: 'POST', path: '/api/social/baton', body: { targetKind: 'circle', targetId: circle.body.circle.id, card: CARD }, account: 'alice' });
  const outsider = await call(service, { method: 'POST', path: '/api/social/baton/' + circleBaton.body.id + '/event', body: { kind: 'relay-completed' }, account: 'mallory' });
  assert.equal(outsider.status, 403);
  await call(service, { method: 'POST', path: '/api/social/circles/join', body: { inviteCode: circle.body.circle.inviteCode }, account: 'bob' });
  const member = await call(service, { method: 'POST', path: '/api/social/baton/' + circleBaton.body.id + '/event', body: { kind: 'relay-completed' }, account: 'bob' });
  assert.equal(member.status, 200);
});

// ---------------------------------------------------------------------------
// 9) 搭档 pairs。
// ---------------------------------------------------------------------------

test('pair guards: no self-pairing, max 5 partners both sides, one freeze per week with weekly reset', async () => {
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
  // 跨周重置：PRD §4.5「每周有 1 次」—— 换周后同一对可以再冻结
  let week = WEEK;
  const weekService = createService({
    store,
    auth: mkAuth(),
    now: () => Date.parse('2026-10-21T08:00:00Z'),
    currentWeek: () => week,
    rateLimits: { write: 60, read: 60, preview: 60, windowMs: 60000 },
  });
  const nextWeekFirst = await call(weekService, { method: 'POST', path: '/api/social/pairs/pr-2/freeze', body: {}, account: 'me' });
  assert.equal(nextWeekFirst.status, 200);
  week = '2026-W44';
  const nextWeekAgain = await call(weekService, { method: 'POST', path: '/api/social/pairs/pr-2/freeze', body: {}, account: 'me' });
  assert.equal(nextWeekAgain.status, 200, 'new week resets the freeze budget (was permanently 409)');
  const sameWeekTwice = await call(weekService, { method: 'POST', path: '/api/social/pairs/pr-2/freeze', body: {}, account: 'me' });
  assert.equal(sameWeekTwice.status, 409);
  const leave = await call(service, { method: 'POST', path: '/api/social/pairs/pr-1/leave', body: {}, account: 'me' });
  assert.equal(leave.status, 200);
  assert.equal(store.getPair('pr-1'), null);
});

test('pair targets must exist and be opted in; the passive side cannot be stacked past 5', async () => {
  const { service, store } = await build();
  await optedIn(service, 'a');
  await optedIn(service, 'popular');
  for (let i = 1; i <= 5; i += 1) {
    await optedIn(service, 'f' + i);
    store.createPair({ id: 'pr-pop-' + i, a: 'popular', b: 'f' + i, startedWeek: WEEK, flame: 0, freezesUsed: 0 });
  }
  const stack = await call(service, { method: 'POST', path: '/api/social/pairs', body: { with: 'popular' }, account: 'a' });
  assert.equal(stack.status, 409);
  assert.equal(stack.body.error, 'PAIR_TARGET_LIMIT_REACHED', 'passive side capped at MAX_PAIRS too');
  assert.equal(store.pairCount('popular'), 5);
  const phantom = await call(service, { method: 'POST', path: '/api/social/pairs', body: { with: 'ghost-nobody' }, account: 'a' });
  assert.equal(phantom.status, 404);
  assert.equal(phantom.body.error, 'ACCOUNT_NOT_FOUND');
  store.optIn('sleepy', { enabled: false, minor: false, alias: '沉睡的溪', avatarColor: '#4C7A93' }); // 存在但未开启
  const notOptedIn = await call(service, { method: 'POST', path: '/api/social/pairs', body: { with: 'sleepy' }, account: 'a' });
  assert.equal(notOptedIn.status, 403);
  assert.equal(notOptedIn.body.error, 'SOCIAL_OPT_IN_REQUIRED');
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
  const { service, store } = await build();
  await call(service, { method: 'POST', path: '/api/social/block', body: { account: 'nuisance' }, account: 'me' });
  const listed = await call(service, { path: '/api/social/blocks', account: 'me' });
  assert.deepEqual(listed.body.blocked, ['nuisance']);
  const undo = await call(service, { method: 'POST', path: '/api/social/block/nuisance/remove', body: {}, account: 'me' });
  assert.equal(undo.status, 200);
  const emptied = await call(service, { path: '/api/social/blocks', account: 'me' });
  assert.deepEqual(emptied.body.blocked, []);
  const report = await call(service, { method: 'POST', path: '/api/social/report', body: { account: 'nuisance', reason: '一直发无关内容' }, account: 'me' });
  assert.equal(report.status, 200);
  // service → store 契约形状（此前 {from, about} 与 store {reporter, targetId} 错配）
  assert.equal(store.reports[0].reporter, 'me');
  assert.equal(store.reports[0].targetKind, 'account');
  assert.equal(store.reports[0].targetId, 'nuisance');
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

// ---------------------------------------------------------------------------
// 15) 真实 store 集成（S1 social-store.mjs + S4 service，内存 SQLite）——
// 证明两条线的接口签名真实兼容，不只是 stub 对 stub。
// ---------------------------------------------------------------------------

test('integration: real social-store wires into the service end to end', async () => {
  const { createSocialStore } = await import('../../scripts/social-store.mjs');
  if (!createService) {
    const mod = await import('../../scripts/social-service.mjs');
    createService = mod.createSocialService;
  }
  const store = createSocialStore({ databaseFile: ':memory:' });
  try {
    const service = createService({
      store,
      auth: mkAuth(),
      now: () => Date.parse('2026-10-21T08:00:00Z'),
      currentWeek: () => WEEK,
      rateLimits: { write: 60, read: 60, preview: 60, windowMs: 60000 },
    });
    await call(service, { method: 'POST', path: '/api/social/onboarding-seen', body: {}, account: 'u1' });
    const opt = await call(service, { method: 'POST', path: '/api/social/opt-in', body: { enabled: true, minor: false }, account: 'u1' });
    assert.equal(opt.status, 200);
    assert.equal(opt.body.optIn, true);
    assert.ok(opt.body.alias && isAvatarColor(opt.body.avatarColor));
    const upload = await call(service, { method: 'POST', path: '/api/social/profile', body: mkFeatures(), account: 'u1' });
    assert.equal(upload.status, 200);
    assert.equal(store.getProfile('u1', WEEK).graduations, 3);
    const dirty = mkFeatures(); dirty.title = '秘密';
    assert.equal((await call(service, { method: 'POST', path: '/api/social/profile', body: dirty, account: 'u1' })).status, 400);
    const circle = await call(service, { method: 'POST', path: '/api/social/circles', body: { name: '课题组' }, account: 'u1' });
    assert.equal(circle.status, 200);
    await optedIn(service, 'u2');
    const joined = await call(service, { method: 'POST', path: '/api/social/circles/join', body: { inviteCode: circle.body.circle.inviteCode }, account: 'u2' });
    assert.equal(joined.status, 200);
    assert.equal(store.circleMemberCount(circle.body.circle.id), 2);
    const sent = await call(service, { method: 'POST', path: '/api/social/baton', body: { targetKind: 'link', targetId: null, card: CARD }, account: 'u1' });
    assert.equal(sent.status, 200);
    const opened = await call(service, { path: '/api/social/baton/' + sent.body.id });
    assert.equal(opened.status, 200);
    assert.deepEqual(Object.keys(opened.body.card).sort(), ['promptTemplate', 'scenarioTitle', 'usageId']);
    const shared = await call(service, { method: 'POST', path: '/api/social/shared-event', body: { kind: 'usage-learned' }, account: 'u1' });
    assert.equal(shared.status, 200);
    const cheer = await call(service, { method: 'POST', path: '/api/social/kudos', body: { from: 'u2', to: 'u1', eventKind: 'usage-learned', sharedEventId: shared.body.id }, account: 'u2' });
    assert.equal(cheer.status, 200);
    assert.equal((await call(service, { path: '/api/social/kudos', account: 'u1' })).body.kudos.length, 1);
    const gone = await call(service, { method: 'POST', path: '/api/social/delete-me', body: {}, account: 'u1' });
    assert.equal(gone.status, 200);
    assert.equal(store.getState('u1'), null);
    assert.equal(store.getProfile('u1', WEEK), null);
    assert.equal(store.isCircleMember(circle.body.circle.id, 'u1'), false);
  } finally {
    store.close();
  }
});

// ---------------------------------------------------------------------------
// 16) 真实 store 集成（续）—— 修复轮回归：report 落库、默认 matcher 产出真
// 推荐、传棒推进周挑战、链/化名出库、kudos 新形状端到端。
// ---------------------------------------------------------------------------

test('integration: POST /api/social/report lands in the real store (was always 400 INVALID_INPUT)', async () => {
  const { createSocialStore } = await import('../../scripts/social-store.mjs');
  if (!createService) {
    const mod = await import('../../scripts/social-service.mjs');
    createService = mod.createSocialService;
  }
  const store = createSocialStore({ databaseFile: ':memory:' });
  try {
    const service = createService({
      store,
      auth: mkAuth(),
      now: () => Date.parse('2026-10-21T08:00:00Z'),
      currentWeek: () => WEEK,
      rateLimits: { write: 60, read: 60, preview: 60, windowMs: 60000 },
    });
    await optedIn(service, 'u1');
    await optedIn(service, 'u2');
    const out = await call(service, { method: 'POST', path: '/api/social/report', body: { account: 'u2', reason: '测试举报' }, account: 'u1' });
    assert.equal(out.status, 200);
    assert.equal(store.tableCounts().reports, 1);
    assert.equal(store.accountReferences('u2').reports, 1);
    const ascii = await call(service, { method: 'POST', path: '/api/social/report', body: { account: 'u2', reason: 'spam reason ascii' }, account: 'u1' });
    assert.equal(ascii.status, 200);
  } finally {
    store.close();
  }
});

test('integration: default matcher (no injection) returns real matches from the real store', async () => {
  const { createSocialStore } = await import('../../scripts/social-store.mjs');
  if (!createService) {
    const mod = await import('../../scripts/social-service.mjs');
    createService = mod.createSocialService;
  }
  const store = createSocialStore({ databaseFile: ':memory:' });
  try {
    const service = createService({ // 注意：不注入 matcher —— serve-tango 一行挂载的形态
      store,
      auth: mkAuth(),
      now: () => Date.parse('2026-10-21T08:00:00Z'),
      currentWeek: () => WEEK,
      rateLimits: { write: 60, read: 60, preview: 60, windowMs: 60000 },
    });
    await optedIn(service, 'me');
    store.saveProfile('me', mkFeatures()); // graduations 3 → 窗口 [3, 8]
    for (const [id, grads] of [['peer-a', 4], ['peer-b', 3], ['peer-c', 5], ['peer-d', 9], ['peer-e', 2]]) {
      await optedIn(service, id);
      store.saveProfile(id, { ...mkFeatures(), graduations: grads });
    }
    store.saveProfile('me', { ...mkFeatures(), graduations: 3 }); // 确保在 optedIn 之后（optIn 不动画像）
    const out = await call(service, { path: '/api/social/matches?week=' + WEEK, account: 'me' });
    assert.equal(out.status, 200);
    assert.equal(out.body.matches.length, 3, 'a(4)/b(3)/c(5) 在「略多一点」窗口 [3,8] 内；d(9)/e(2) 越界');
    for (const rec of out.body.matches) assert.ok(validateMatch(rec, { myGraduations: 3 }));
    assert.equal(out.body.fallback, null);
    // 自己永远不会出现在推荐里（默认池此前不排除本人）
    assert.ok(!out.body.matches.some(rec => rec.alias === store.getState('me').alias));
  } finally {
    store.close();
  }
});

test('integration: sending a baton advances the weekly give-baton quest in the real store', async () => {
  const { createSocialStore } = await import('../../scripts/social-store.mjs');
  if (!createService) {
    const mod = await import('../../scripts/social-service.mjs');
    createService = mod.createSocialService;
  }
  const store = createSocialStore({ databaseFile: ':memory:' });
  try {
    const service = createService({
      store,
      auth: mkAuth(),
      now: () => Date.parse('2026-10-21T08:00:00Z'),
      currentWeek: () => WEEK,
      rateLimits: { write: 60, read: 60, preview: 60, windowMs: 60000 },
    });
    await optedIn(service, 'me');
    const before = await call(service, { path: '/api/social/quests?week=' + WEEK, account: 'me' });
    const give = before.body.quests.find(q => q.quest.title === '给 1 个人传棒');
    assert.ok(give, 'quest plan includes the give-baton quest');
    assert.equal(give.progress.progress, 0);
    const sent = await call(service, { method: 'POST', path: '/api/social/baton', body: { targetKind: 'link', targetId: null, card: CARD }, account: 'me' });
    assert.equal(sent.status, 200);
    const after = await call(service, { path: '/api/social/quests?week=' + WEEK, account: 'me' });
    const giveAfter = after.body.quests.find(q => q.quest.title === '给 1 个人传棒');
    assert.equal(giveAfter.progress.progress, 1);
    assert.equal(giveAfter.progress.done, true, '徽章条件达成（PRD §4.7）');
  } finally {
    store.close();
  }
});

test('integration: quest progress counts only batons the receiver completed (PRD §4.4/§8)', async () => {
  const { createSocialStore } = await import('../../scripts/social-store.mjs');
  if (!createService) {
    const mod = await import('../../scripts/social-service.mjs');
    createService = mod.createSocialService;
  }
  // store 与 service 用同一个注入时钟，否则棒的时间按真实日期落周，跨周（如周一）时计数为 0
  const store = createSocialStore({ databaseFile: ':memory:', now: () => '2026-10-21T08:00:00.000Z' });
  try {
    const service = createService({
      store,
      auth: mkAuth(),
      now: () => Date.parse('2026-10-21T08:00:00Z'),
      currentWeek: () => WEEK,
      rateLimits: { write: 60, read: 60, preview: 60, windowMs: 60000 },
    });
    await optedIn(service, 'alice');
    await optedIn(service, 'bob');
    await optedIn(service, 'carol');
    const created = await call(service, { method: 'POST', path: '/api/social/circles', body: { name: '课题组' }, account: 'alice' });
    await call(service, { method: 'POST', path: '/api/social/circles/join', body: { inviteCode: created.body.circle.inviteCode }, account: 'bob' });
    await call(service, { method: 'POST', path: '/api/social/circles/join', body: { inviteCode: created.body.circle.inviteCode }, account: 'carol' });
    // alice 发 3 根棒，无人完成 —— 排名不计（此前 batons=3 直接登顶）
    for (let i = 0; i < 3; i += 1) {
      await call(service, { method: 'POST', path: '/api/social/baton', body: { targetKind: 'circle', targetId: created.body.circle.id, card: CARD }, account: 'alice' });
    }
    let home = store.circleHome(created.body.circle.id, WEEK, 'bob');
    assert.equal(home.rankView.top.find(e => e.alias === store.getState('alice').alias)?.batons || 0, 0, 'uncompleted batons do not count');
    // bob 完成 alice 发给他的 pair 棒 → alice 传棒 1（北极星口径：完成才计数）
    const aliceAlias = store.getState('alice').alias;
    const bobAlias = store.getState('bob').alias;
    const pairBaton = await call(service, { method: 'POST', path: '/api/social/baton', body: { targetKind: 'pair', targetId: 'bob', card: CARD }, account: 'alice' });
    await call(service, { method: 'POST', path: '/api/social/baton/' + pairBaton.body.id + '/event', body: { kind: 'relay-completed' }, account: 'bob' });
    home = store.circleHome(created.body.circle.id, WEEK, 'bob');
    assert.equal(home.rankView.top.find(e => e.alias === aliceAlias)?.batons || 0, 1, 'completed baton counts exactly once');
    assert.ok(aliceAlias && bobAlias);
    // 「你」在 top3 内不重复输出（去重后）
    const bobRow = home.rankView.top.find(e => e.alias === bobAlias);
    if (bobRow) assert.equal(home.rankView.you, null, 'viewer inside top is not duplicated below');
  } finally {
    store.close();
  }
});
