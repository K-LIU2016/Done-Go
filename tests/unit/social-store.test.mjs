import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

// SO·S3存储 line: scripts/social-store.mjs — social.sqlite (node:sqlite, 照
// collaboration-store 写法, 权限 600) carries every 同频 table from PRD §7
// plus the account/shared-event/quest-feedback tables the privacy rules
// (PRD §4.3 §5 §8) require. Hard gates proven here:
// - D2 白名单在存储边界仍然生效: saveProfile 只落 sanitizeFeaturesUpload 的
//   9 个字段; FORBIDDEN_UPLOAD_FIELDS 逐个被拒, 嵌套未知字段同样被拒。
// - D2 删除我的数据级联彻底: purgeAccount 后逐表断言清零
//   (accountReferences), 他人的数据完好。
// - D6 baton_events 四种事件全部落库; 传递链存储可长, 视图由契约
//   clipBatonChain 封顶 5 跳。
// - D5 circleHome 的 rankView/freedTo 出库即过契约校验, 不含任何工时字段。
// - 方法名/形状与 S4 服务线测试中声明的 store 契约一致
//   (tests/unit/social-service.test.mjs mkStore)。

import {
  FORBIDDEN_UPLOAD_FIELDS,
  BATON_EVENTS, BATON_CHAIN_MAX_HOPS, clipBatonChain,
  CIRCLE_MAX_MEMBERS,
  validateCircleRankView, validateFreedToSummary,
  sanitizeFeaturesUpload,
} from '../../web/social/contracts.js';
import { createSocialStore, socialError } from '../../scripts/social-store.mjs';

const WEEK = '2026-W43';
const NEXT_WEEK = '2026-W44';

function mkFeatures(over = {}) {
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
    ...over,
  };
}

const CARD = {
  usageId: 'meeting-notes',
  scenarioTitle: '会议材料 → 重点和待办',
  promptTemplate: '请把下面的会议内容整理成三部分：重点、待办、没说清的地方。\n会议内容：{{material}}',
};

const NOW = () => '2026-10-21T08:00:00Z'; // 2026-W43
function mkStore() { return createSocialStore({ databaseFile: ':memory:', now: NOW }); }

const TABLES = [
  'social_accounts', 'profiles_weekly', 'shared_events', 'pairs', 'kudos',
  'baton_shares', 'baton_events', 'circles', 'circle_members', 'quests',
  'quest_progress', 'quest_feedback', 'blocks', 'reports', 'social_meta',
];

// ---------------------------------------------------------------------------
// 表与迁移。
// ---------------------------------------------------------------------------
test('S3: store creates every PRD §7 table plus the privacy tables (tableCounts)', () => {
  const store = mkStore();
  const counts = store.tableCounts();
  assert.deepEqual(Object.keys(counts).sort(), TABLES.sort(), 'all tables exist');
  assert.equal(store.schemaVersion(), 1, 'social_meta stamped at v1');
  store.close();
});

test('S3: file store is 0600 (social.sqlite, WAL sidecars too) and survives reopen', () => {
  const dir = mkdtempSync(join(tmpdir(), 'social-store-'));
  const file = join(dir, 'social.sqlite');
  const first = createSocialStore({ databaseFile: file, now: NOW });
  first.optIn('u1', { enabled: true, minor: false, alias: '安静的湖', avatarColor: '#4C7A93' });
  first.saveProfile('u1', mkFeatures());
  // WAL 边车在连接打开期间存在（close 时 SQLite 会 checkpoint 并删除），此刻断言权限
  assert.equal(statSync(file + '-wal').mode & 0o777, 0o600, 'WAL sidecar stays 0600 while open');
  first.close();
  assert.equal(statSync(file).mode & 0o777, 0o600, 'social.sqlite is 0600');
  const second = createSocialStore({ databaseFile: file, now: NOW });
  assert.equal(second.schemaVersion(), 1, 'reopen does not re-migrate');
  assert.equal(second.getProfile('u1', WEEK).graduations, 3, 'data survives reopen');
  second.close();
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// D2 — 上传白名单在存储边界。
// ---------------------------------------------------------------------------
test('D2: saveProfile stores exactly the 9 whitelisted fields, byte-for-byte the sanitized value', () => {
  const store = mkStore();
  store.optIn('u1', { enabled: true, minor: false, alias: '安静的湖', avatarColor: '#4C7A93' });
  store.saveProfile('u1', mkFeatures());
  const stored = store.getProfile('u1', WEEK);
  assert.deepEqual(stored, sanitizeFeaturesUpload(mkFeatures()));
  assert.deepEqual(Object.keys(stored).sort(), [
    'freedMinutesConfirmed', 'freedTo', 'graduations', 'kindMix', 'rating', 'relays', 'rhythm', 'usages', 'week',
  ]);
  store.close();
});

test('D2: every FORBIDDEN_UPLOAD_FIELDS field is rejected by the store itself (标题/材料/时间)', () => {
  const store = mkStore();
  store.optIn('u1', { enabled: true, minor: false, alias: '安静的湖', avatarColor: '#4C7A93' });
  for (const field of FORBIDDEN_UPLOAD_FIELDS) {
    const payload = mkFeatures();
    payload[field] = '我的秘密标题/材料/2026-10-25T02:00';
    assert.throws(() => store.saveProfile('u1', payload), (e) => e.code === 'INVALID_INPUT', field + ' must be rejected');
  }
  assert.equal(store.tableCounts().profiles_weekly, 0, 'nothing was stored');
  store.close();
});

test('D2: nested unknown fields (kindMix.guesses, rating.extra) are rejected too', () => {
  const store = mkStore();
  store.optIn('u1', { enabled: true, minor: false, alias: '安静的湖', avatarColor: '#4C7A93' });
  const nested = mkFeatures(); nested.kindMix.guesses = 0.2;
  assert.throws(() => store.saveProfile('u1', nested), (e) => e.code === 'INVALID_INPUT');
  const nested2 = mkFeatures(); nested2.rating.extra = 3;
  assert.throws(() => store.saveProfile('u1', nested2), (e) => e.code === 'INVALID_INPUT');
  assert.equal(store.tableCounts().profiles_weekly, 0);
  store.close();
});

// ---------------------------------------------------------------------------
// 账号状态（opt-in / 化名 / 未成年）— S4 store 契约形状。
// ---------------------------------------------------------------------------
test('S3: getState/optIn/setAlias match the S4 store contract semantics', () => {
  const store = mkStore();
  assert.equal(store.getState('u1'), null);
  store.optIn('u1', { enabled: true, minor: false, alias: '安静的湖', avatarColor: '#4C7A93' });
  assert.deepEqual(store.getState('u1'), { optIn: true, minor: false, alias: '安静的湖', avatarColor: '#4C7A93' });
  // 关闭同频：optIn=false 但保留化名与未成年标记（PRD §5 可再开启）
  store.optIn('u1', { enabled: false });
  assert.deepEqual(store.getState('u1'), { optIn: false, minor: false, alias: '安静的湖', avatarColor: '#4C7A93' });
  store.setAlias('u1', { alias: '晚风的溪', avatarColor: '#3E7B5B' });
  assert.equal(store.getState('u1').alias, '晚风的溪');
  assert.throws(() => store.setAlias('u1', { alias: 'x'.repeat(40) }), (e) => e.code === 'INVALID_INPUT');
  store.close();
});

test('S3: poolCandidates honours opt-in and the minor flag; circle peers exclude nobody in-circle', () => {
  const store = mkStore();
  store.optIn('adult', { enabled: true, minor: false, alias: '远山的松', avatarColor: '#615CED' });
  store.saveProfile('adult', mkFeatures({ graduations: 4 }));
  store.optIn('shy', { enabled: false, minor: false, alias: '沉默的岩', avatarColor: '#E8B04B' });
  store.saveProfile('shy', mkFeatures());
  store.optIn('kid', { enabled: true, minor: true, alias: '晨跑的鹿', avatarColor: '#E95432' });
  store.saveProfile('kid', mkFeatures());
  const pool = store.poolCandidates(WEEK);
  assert.deepEqual(pool.map((c) => c.account), ['adult'], 'opt-out and minors stay out of the public pool');
  assert.equal(pool[0].graduations, 4);
  assert.deepEqual(pool.map((c) => c.account), store.poolCandidates(WEEK, { allowMinors: false }).map((c) => c.account));
  const withMinors = store.poolCandidates(WEEK, { allowMinors: true });
  assert.deepEqual(withMinors.map((c) => c.account).sort(), ['adult', 'kid']);
  store.close();
});

// ---------------------------------------------------------------------------
// 分享事件 + kudos。
// ---------------------------------------------------------------------------
test('S3: shared events are recorded per owner; kudos are idempotent per (from, sharedEventId)', () => {
  const store = mkStore();
  const shared = store.recordSharedEvent('sharer', 'usage-learned');
  assert.deepEqual(store.getSharedEvent('sharer', shared.id), { id: shared.id, kind: 'usage-learned', owner: 'sharer' });
  assert.equal(store.getSharedEvent('sharer', 'se-made-up'), null);
  const first = store.addKudos({ from: 'fan', to: 'sharer', eventKind: 'usage-learned', sharedEventId: shared.id });
  assert.equal(first.duplicate, false);
  const second = store.addKudos({ from: 'fan', to: 'sharer', eventKind: 'usage-learned', sharedEventId: shared.id });
  assert.equal(second.duplicate, true, 'one kudos per person per event');
  assert.equal(store.tableCounts().kudos, 1);
  assert.deepEqual(store.listKudos('sharer').map((k) => k.from), ['fan']);
  assert.throws(() => store.addKudos({ from: 'fan', to: 'sharer', eventKind: 'hug', sharedEventId: shared.id }), (e) => e.code === 'INVALID_INPUT');
  store.close();
});

// ---------------------------------------------------------------------------
// D6 — 传棒：卡三字段、事件四类、链存储可长视图封顶。
// ---------------------------------------------------------------------------
test('D6: baton share card stores exactly 3 fields; a 4th field is rejected', () => {
  const store = mkStore();
  const share = store.createBatonShare({ id: 'b1', usageId: CARD.usageId, fromAccount: 'sender', targetKind: 'link', targetId: null, card: CARD });
  assert.deepEqual(Object.keys(share.card).sort(), ['promptTemplate', 'scenarioTitle', 'usageId']);
  assert.equal(store.getBatonShare('b1').fromAccount, 'sender');
  const dirty = { ...CARD, senderNote: '给你看看我的纪要' };
  assert.throws(() => store.createBatonShare({ id: 'b2', usageId: CARD.usageId, fromAccount: 'sender', targetKind: 'link', targetId: null, card: dirty }), (e) => e.code === 'INVALID_INPUT');
  assert.equal(store.tableCounts().baton_shares, 1);
  store.close();
});

test('D6: all four baton event kinds land in baton_events; unknown kind/baton rejected', () => {
  const store = mkStore();
  store.createBatonShare({ id: 'b1', usageId: CARD.usageId, fromAccount: 'sender', targetKind: 'pair', targetId: 'learner', card: CARD });
  for (const kind of BATON_EVENTS) store.addBatonEvent({ batonId: 'b1', kind, byAccount: 'learner' });
  const events = store.batonEvents('b1');
  assert.deepEqual(events.map((e) => e.kind), BATON_EVENTS, 'chronological, all four kinds');
  assert.ok(events.every((e) => e.id && e.at && e.byAccount === 'learner'));
  assert.throws(() => store.addBatonEvent({ batonId: 'b1', kind: 'teleported', byAccount: 'learner' }), (e) => e.code === 'INVALID_INPUT');
  assert.throws(() => store.addBatonEvent({ batonId: 'nope', kind: 'opened', byAccount: 'learner' }), (e) => e.code === 'NOT_FOUND' && e.status === 404);
  store.close();
});

test('D6: batonChain keeps the full lineage in storage; the contract caps the view at 5 hops', () => {
  const store = mkStore();
  // u1 → u2 → … → u7: 7 reshares, each linked to its parent.
  const people = ['u1', 'u2', 'u3', 'u4', 'u5', 'u6', 'u7'];
  let parentId = null;
  const ids = [];
  for (const who of people) {
    const share = store.createBatonShare(
      { id: 'share-' + who, usageId: CARD.usageId, fromAccount: who, targetKind: 'link', targetId: null, card: CARD },
      { parentShareId: parentId },
    );
    ids.push(share.id);
    parentId = share.id;
  }
  store.addBatonEvent({ batonId: ids.at(-1), kind: 'relay-completed', byAccount: 'u8' });
  const chain = store.batonChain(ids.at(-1));
  assert.ok(chain.length >= 7, 'storage keeps the whole lineage (存储可长): ' + chain.join(','));
  assert.equal(new Set(chain).size, chain.length, 'chain entries are unique people');
  assert.deepEqual(store.batonChain(ids.at(-1)).slice(0, 7), people);
  assert.equal(clipBatonChain(chain).length, BATON_CHAIN_MAX_HOPS, 'view is capped by the contract (视图封顶)');
  assert.deepEqual(clipBatonChain(chain), chain.slice(-BATON_CHAIN_MAX_HOPS));
  assert.deepEqual(store.batonChain('missing'), []);
  store.close();
});

// ---------------------------------------------------------------------------
// 搭档 pairs。
// ---------------------------------------------------------------------------
test('S3: pairs canonicalize order, reject self-pairing, freeze once per week with weekly reset', () => {
  const store = mkStore();
  const pair = store.createPair({ id: 'pr-1', a: 'p1', b: 'me', startedWeek: WEEK, flame: 0, freezesUsed: 0 });
  assert.deepEqual([pair.a, pair.b], ['me', 'p1'], 'members stored in canonical order');
  assert.deepEqual(Object.keys(pair).sort(), ['a', 'b', 'flame', 'freezesUsed', 'id', 'startedWeek'], 'contract shape only');
  assert.throws(() => store.createPair({ id: 'pr-x', a: 'me', b: 'me', startedWeek: WEEK, flame: 0, freezesUsed: 0 }), (e) => e.code === 'INVALID_INPUT');
  assert.equal(store.pairCount('me'), 1);
  assert.equal(store.listPairs('me')[0].id, 'pr-1');
  // upsert by id: flame updates go through createPair
  store.createPair({ id: 'pr-1', a: 'p1', b: 'me', startedWeek: WEEK, flame: 12, freezesUsed: 0 });
  assert.equal(store.getPair('pr-1').flame, 12);
  assert.equal(store.tableCounts().pairs, 1, 'upsert does not duplicate');
  // freeze: once per week, resets when the week moves on
  const frozen = store.freezePair('pr-1'); // now() = 2026-10-21 → 2026-W43
  assert.equal(frozen.freezesUsed, 1);
  assert.throws(() => store.freezePair('pr-1'), (e) => e.code === 'PAIR_FROZEN_ALREADY' && e.status === 409);
  const nextWeek = store.freezePair('pr-1', { week: NEXT_WEEK });
  assert.equal(nextWeek.freezesUsed, 1, 'new week resets the freeze budget');
  store.deletePair('pr-1');
  assert.equal(store.getPair('pr-1'), null);
  store.close();
});

// ---------------------------------------------------------------------------
// 圈 circles。
// ---------------------------------------------------------------------------
function seedCircle(store, { id = 'c1', owner = 'founder', code = 'TANGO01' } = {}) {
  return store.createCircle({ id, name: '王老师课题组', inviteCode: code, owner });
}

test('S3: circles — invite lookup, 50-member cap, duplicate code rejected', () => {
  const store = mkStore();
  const circle = seedCircle(store);
  assert.deepEqual(store.findCircleByInvite('TANGO01').members, ['founder']);
  assert.equal(store.isCircleMember('c1', 'founder'), true);
  assert.equal(store.circleOwner('c1'), 'founder');
  store.joinCircle('c1', 'mate');
  assert.equal(store.circleMemberCount('c1'), 2);
  assert.throws(() => seedCircle(store, { id: 'c2', code: 'TANGO01' }), (e) => e.code === 'CIRCLE_CODE_TAKEN');
  for (let i = 0; i < CIRCLE_MAX_MEMBERS - 2; i += 1) store.joinCircle('c1', 'm' + i);
  assert.equal(store.circleMemberCount('c1'), CIRCLE_MAX_MEMBERS);
  assert.throws(() => store.joinCircle('c1', 'one-too-many'), (e) => e.code === 'CIRCLE_FULL' && e.status === 409);
  store.close();
});

test('S3: owner leaving promotes the earliest member; the last member out deletes the circle cascade', () => {
  const store = mkStore();
  seedCircle(store);
  store.joinCircle('c1', 'early');
  store.joinCircle('c1', 'late');
  store.leaveCircle('c1', 'founder');
  assert.equal(store.circleOwner('c1'), 'early', 'earliest-joined member takes over');
  assert.equal(store.circleMemberCount('c1'), 2);
  // 独守的圈：离开即整圈级联删除（quest、进度、指向圈的传棒一起清）
  seedCircle(store, { id: 'cb', owner: 'solo', code: 'SOLO001' });
  const quest = store.addQuest({ id: 'q-solo', week: WEEK, scope: 'circle', title: '给 1 个人传棒', target: 1, unit: '次' }, { circleId: 'cb' });
  store.setQuestProgress({ questId: quest.id, scope: 'circle', owner: 'cb', progress: 1, done: true });
  store.createBatonShare({ id: 'b-cb', usageId: CARD.usageId, fromAccount: 'other', targetKind: 'circle', targetId: 'cb', card: CARD });
  store.leaveCircle('cb', 'solo');
  assert.equal(store.getCircle('cb'), null);
  assert.equal(store.quest('q-solo'), null);
  assert.equal(store.getQuestProgress('q-solo', 'cb'), null);
  assert.equal(store.getBatonShare('b-cb'), null);
  store.close();
});

test('S3: removeCircleMember removes; circleHome aggregates wall/freedTo/rankView passing D5 validators', () => {
  const store = mkStore();
  seedCircle(store);
  store.optIn('founder', { enabled: true, minor: false, alias: '远山的松', avatarColor: '#615CED' });
  store.optIn('mate', { enabled: true, minor: false, alias: '晨跑的鹿', avatarColor: '#E8B04B' });
  store.optIn('mate2', { enabled: true, minor: false, alias: '安静的湖', avatarColor: '#4C7A93' });
  store.joinCircle('c1', 'mate');
  store.joinCircle('c1', 'mate2');
  store.saveProfile('founder', mkFeatures({ graduations: 2, usages: ['meeting-notes', 'paper-5points'] }));
  store.saveProfile('mate', mkFeatures({ graduations: 1, usages: ['meeting-notes'] }));
  store.saveProfile('mate2', mkFeatures({ graduations: 5, usages: ['meeting-notes'] }));
  store.createBatonShare({ id: 'b-f1', usageId: CARD.usageId, fromAccount: 'founder', targetKind: 'circle', targetId: 'c1', card: CARD });
  store.createBatonShare({ id: 'b-f2', usageId: 'paper-5points', fromAccount: 'founder', targetKind: 'circle', targetId: 'c1', card: { ...CARD, usageId: 'paper-5points', scenarioTitle: '长文 → 5 个要点' } });
  store.createBatonShare({ id: 'b-m1', usageId: CARD.usageId, fromAccount: 'mate', targetKind: 'circle', targetId: 'c1', card: CARD });

  const home = store.circleHome('c1', WEEK, 'mate2');
  // 用法墙：三个成员本周用过 meeting-notes，两个用过 paper-5points
  assert.deepEqual(home.wall, [{ usageId: 'meeting-notes', count: 3 }, { usageId: 'paper-5points', count: 1 }]);
  // 传棒链：圈内传棒经过的人（≤5 跳，D6 视图封顶在聚合层生效）
  assert.ok(home.chain.length <= BATON_CHAIN_MAX_HOPS);
  assert.deepEqual([...home.chain].sort(), ['founder', 'mate']);
  // 空出来的时间：只显示占比
  assert.ok(validateFreedToSummary(home.freedTo), 'freedTo summary passes the D5 validator');
  // 圈内排名：只按传棒与毕业，前 3 + 你，无任何工时字段
  assert.ok(validateCircleRankView(home.rankView), 'rank view passes the D5 validator');
  assert.equal(home.rankView.top[0].alias, '远山的松', 'most batons ranks first');
  assert.equal(home.rankView.you.alias, '安静的湖');
  const rankText = JSON.stringify(home.rankView);
  for (const banned of ['hours', 'minutes', 'workHours', 'duration']) assert.ok(!rankText.includes(banned), 'no work-time metric in the rank view: ' + banned);

  store.removeCircleMember('c1', 'mate2');
  assert.equal(store.isCircleMember('c1', 'mate2'), false);
  store.close();
});

// ---------------------------------------------------------------------------
// 周挑战 quests。
// ---------------------------------------------------------------------------
test('S3: quests validate via contracts; circle quests anchor to their circle; progress upserts', () => {
  const store = mkStore();
  const personal = store.addQuest({ id: 'q1', week: WEEK, scope: 'personal', title: '用 AI 完成 3 件生活小事', target: 3, unit: '件' });
  assert.deepEqual(Object.keys(personal).sort(), ['id', 'scope', 'target', 'title', 'unit', 'week']);
  assert.throws(() => store.addQuest({ id: 'q2', week: WEEK, scope: 'wild', title: 'x', target: 1, unit: '次' }), (e) => e.code === 'INVALID_INPUT');
  seedCircle(store);
  const circleQuest = store.addQuest({ id: 'q3', week: WEEK, scope: 'circle', title: '圈内传棒 10 次', target: 10, unit: '次' }, { circleId: 'c1' });
  assert.equal(store.questsForCircle('c1', WEEK).map((q) => q.id).includes('q3'), true);
  assert.equal(store.quests(WEEK).length, 2);
  assert.throws(() => store.addQuest({ id: 'q4', week: WEEK, scope: 'circle', title: '无圈', target: 1, unit: '次' }), (e) => e.code === 'INVALID_INPUT', 'circle scope requires an existing circle');
  store.setQuestProgress({ questId: 'q1', scope: 'personal', owner: 'me', progress: 1, done: false });
  store.setQuestProgress({ questId: 'q1', scope: 'personal', owner: 'me', progress: 3, done: true });
  assert.equal(store.tableCounts().quest_progress, 1, 'progress upserts by (quest, owner)');
  assert.deepEqual(store.getQuestProgress('q1', 'me'), { questId: 'q1', scope: 'personal', owner: 'me', progress: 3, done: true });
  // 保护指标：\"太多了\" 反馈通道（PRD §8）
  assert.deepEqual(store.questFeedback('q1', 'me', 'too-much'), { recorded: true });
  assert.throws(() => store.questFeedback('q1', 'me', 'way-too-easy'), (e) => e.code === 'INVALID_INPUT');
  store.close();
});

// ---------------------------------------------------------------------------
// 屏蔽与举报。
// ---------------------------------------------------------------------------
test('S3: blocks work in both directions; self-block rejected; reports need a reason', () => {
  const store = mkStore();
  store.block('me', 'nuisance');
  assert.equal(store.blockedBetween('me', 'nuisance'), true);
  assert.equal(store.blockedBetween('nuisance', 'me'), true, 'either direction hides both sides');
  assert.deepEqual(store.listBlocks('me'), ['nuisance']);
  assert.equal(store.blockedBetween('me', 'friend'), false);
  assert.throws(() => store.block('me', 'me'), (e) => e.code === 'INVALID_INPUT');
  store.block('me', 'nuisance'); // idempotent
  assert.equal(store.tableCounts().blocks, 1);
  store.unblock('me', 'nuisance');
  assert.equal(store.blockedBetween('me', 'nuisance'), false);
  const report = store.report({ reporter: 'me', account: 'nuisance', reason: '一直发无关内容' });
  assert.deepEqual(Object.keys(report).sort(), ['at', 'id', 'reason', 'reporter', 'targetId', 'targetKind']);
  assert.equal(report.targetKind, 'account');
  assert.throws(() => store.report({ reporter: 'me', account: 'nuisance' }), (e) => e.code === 'INVALID_INPUT', 'reason is required');
  store.close();
});

// ---------------------------------------------------------------------------
// D2 — 删除我的数据：级联彻底，逐表断言清零。
// ---------------------------------------------------------------------------
test('D2: purgeAccount cascades across every table; other people’s data survives', () => {
  const store = mkStore();
  // u1 在每张表里都有痕迹
  store.optIn('u1', { enabled: true, minor: false, alias: '要走的松', avatarColor: '#C7701F' });
  store.saveProfile('u1', mkFeatures({ graduations: 3 }));
  const shared = store.recordSharedEvent('u1', 'time-given');
  const sharedU2 = store.recordSharedEvent('u2', 'self-kept');
  store.addKudos({ from: 'u1', to: 'u2', eventKind: 'self-kept', sharedEventId: 'se-u2' });
  store.addKudos({ from: 'u2', to: 'u1', eventKind: 'time-given', sharedEventId: shared.id });
  store.addKudos({ from: 'u3', to: 'u2', eventKind: 'self-kept', sharedEventId: 'se-u2' }); // 与 u1 无关，必须活下来
  store.createPair({ id: 'pr-12', a: 'u1', b: 'u2', startedWeek: WEEK, flame: 7, freezesUsed: 0 });
  store.createPair({ id: 'pr-23', a: 'u2', b: 'u3', startedWeek: WEEK, flame: 1, freezesUsed: 0 }); // 必须活下来
  const shareFromU1 = store.createBatonShare({ id: 'b-u1', usageId: CARD.usageId, fromAccount: 'u1', targetKind: 'link', targetId: null, card: CARD });
  const shareToPair = store.createBatonShare({ id: 'b-pair', usageId: CARD.usageId, fromAccount: 'u2', targetKind: 'pair', targetId: 'pr-12', card: CARD });
  store.addBatonEvent({ batonId: 'b-u1', kind: 'sent', byAccount: 'u1' });
  store.addBatonEvent({ batonId: 'b-pair', kind: 'relay-completed', byAccount: 'u1' });
  // 圈 A：u1 是圈主，还有别人 → 所有权交接，圈存活
  store.createCircle({ id: 'ca', name: '课题组', inviteCode: 'CREW001', owner: 'u1' });
  store.joinCircle('ca', 'u2'); store.joinCircle('ca', 'u3');
  // 圈 B：u1 独守 → 整圈级联删除
  store.createCircle({ id: 'cb', name: '空圈', inviteCode: 'SOLO001', owner: 'u1' });
  const qb = store.addQuest({ id: 'q-cb', week: WEEK, scope: 'circle', title: '圈内挑战', target: 2, unit: '次' }, { circleId: 'cb' });
  store.setQuestProgress({ questId: 'q-cb', scope: 'circle', owner: 'cb', progress: 1, done: false });
  const qp = store.addQuest({ id: 'q-p', week: WEEK, scope: 'personal', title: '个人挑战', target: 1, unit: '次' });
  store.setQuestProgress({ questId: 'q-p', scope: 'personal', owner: 'u1', progress: 1, done: true });
  store.questFeedback('q-p', 'u1', 'too-much');
  store.block('u1', 'u2');
  store.block('u2', 'u1');
  store.report({ reporter: 'u1', account: 'u2', reason: '垃圾内容' });
  store.report({ reporter: 'u2', account: 'u1', reason: '测试举报' });

  const before = store.accountReferences('u1');
  assert.ok(Object.values(before).reduce((a, b) => a + b, 0) > 0, 'u1 had references in the store');

  const result = store.purgeAccount('u1');
  assert.equal(result.deleted.profiles_weekly, 1);
  assert.equal(result.deleted.pairs, 1, 'the pair containing u1 is deleted');
  assert.equal(result.deleted.baton_events >= 2, true);

  // 逐表断言清零 —— 级联彻底
  const after = store.accountReferences('u1');
  for (const [table, count] of Object.entries(after)) assert.equal(count, 0, table + ' must be clean: ' + count);
  assert.equal(store.getState('u1'), null);
  assert.equal(store.getProfile('u1', WEEK), null);
  assert.equal(store.getPair('pr-12'), null);
  assert.equal(store.getBatonShare('b-u1'), null);
  assert.equal(store.getBatonShare('b-pair'), null, 'shares targeting the deleted pair go too');
  assert.equal(store.quest('q-cb'), null);
  assert.equal(store.getCircle('cb'), null);

  // 他人数据完好
  assert.equal(store.getSharedEvent('u2', sharedU2.id) !== null, true, 'u2 的分享事件不受影响');
  assert.equal(store.getPair('pr-23').id, 'pr-23');
  assert.equal(store.listKudos('u2').length, 1, 'u3→u2 kudos survives');
  assert.equal(store.getCircle('ca') !== null, true);
  assert.equal(store.circleOwner('ca'), 'u2', 'circle A survives with a promoted owner');
  assert.equal(store.quest('q-p') !== null, true, 'global personal quest template survives');
  assert.equal(store.tableCounts().quest_progress, 0, 'both progress rows (u1 personal + cb circle) are gone');

  // 幂等：再删一次不炸
  const again = store.purgeAccount('u1');
  assert.equal(Object.values(again.deleted).reduce((a, b) => a + b, 0), 0);
  store.close();
});

// ---------------------------------------------------------------------------
// 红线自证 — 源码不打印任何内容（D2: 日志里不得出现标题/材料/时间）。
// ---------------------------------------------------------------------------
test('D2: social-store.mjs never logs and takes every shape from the contracts module', () => {
  const source = readFileSync(new URL('../../scripts/social-store.mjs', import.meta.url), 'utf8');
  assert.equal(/console\./.test(source), false, 'no console output anywhere in the store');
  assert.ok(source.includes('../web/social/contracts.js'), 'contracts.js is the single source of shapes');
});

test('S3: socialError carries code + status for the service layer', () => {
  const err = socialError('INVALID_INPUT');
  assert.equal(err.code, 'INVALID_INPUT');
  assert.equal(err.status, 400);
  assert.equal(socialError('NOT_FOUND', 404).status, 404);
});
