import assert from 'node:assert/strict';
import { test } from 'node:test';

// SO·契约 line: web/social/contracts.js is the single source of truth for the
// 同频（social）data shapes (PRD design/social-sync/PRD.md §3). Every later
// social line (store / service / features / lab / web UI) imports these names
// instead of redefining them.
//
// Hard gates proven here:
// - D2 upload whitelist: unknown fields are REJECTED, never stripped, and
//   事项标题 / 材料 / AI 结果 / 具体时间 / 地点 style fields can never pass.
// - D5 circle ranking carries only batons + graduations — never work hours.
// - D6 the baton usage card carries exactly {usageId, scenarioTitle,
//   promptTemplate}; the relay chain view is capped at 5 hops.

import {
  SOCIAL_CONTRACTS_VERSION,
  PRIORITIES, PRIORITY_MIN, PRIORITY_MAX, isPriority,
  FEATURES_UPLOAD_FIELDS, KIND_MIX_KEYS, RHYTHM_KEYS, FREED_TO_KEYS, RATINGS,
  FEATURES_USAGES_MAX, FREED_MINUTES_MAX, FORBIDDEN_UPLOAD_FIELDS,
  validateFeaturesUpload, sanitizeFeaturesUpload,
  STYLES, STYLE_IDS, STYLE_EVIDENCE_MAX, validateStyleCard,
  MATCH_WEIGHTS, MATCHES_PER_WEEK, MATCH_REASON_MAX, MATCH_RECENT_USAGES_MAX,
  ALIAS_MAX, validateAlias, isAvatarColor,
  isSlightlyAhead, validateMatch,
  KUDOS_EVENT_KINDS, validateKudos,
  BATON_CARD_FIELDS, SCENARIO_TITLE_MAX, PROMPT_TEMPLATE_MAX, validateBatonCard,
  BATON_EVENTS, BATON_EVENT_LABELS, BATON_TARGET_KINDS,
  validateBatonEvent, validateBatonShare,
  BATON_CHAIN_MAX_HOPS, clipBatonChain,
  MAX_PAIRS, PAIR_FREEZES_PER_WEEK, validatePair,
  CIRCLE_MIN_MEMBERS, CIRCLE_MAX_MEMBERS, CIRCLE_RANK_METRICS, CIRCLE_RANK_SHOWN,
  MIN_AGE_PUBLIC_POOL, validateCircle, validateCircleRankView, validateFreedToSummary,
  QUESTS_PER_WEEK, QUEST_SCOPES, QUEST_FEEDBACK_TYPES,
  validateQuest, validateQuestProgress,
} from '../../web/social/contracts.js';

const WEEK = '2026-W43';

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

function mkCard() {
  return {
    usageId: 'meeting-notes',
    scenarioTitle: '整理会议纪要',
    promptTemplate: '请把下面的会议内容整理成三部分：重点、待办、没说清的地方。\n会议内容：{{material}}',
  };
}

test('constants pin the PRD §3 enums, weights and caps', () => {
  assert.equal(SOCIAL_CONTRACTS_VERSION, 1);
  assert.deepEqual(FEATURES_UPLOAD_FIELDS, [
    'week', 'kindMix', 'rhythm', 'usages', 'relays', 'graduations',
    'rating', 'freedTo', 'freedMinutesConfirmed',
  ]);
  assert.deepEqual(KIND_MIX_KEYS, ['necessary', 'create', 'connect', 'explore', 'restore', 'stillness']);
  assert.deepEqual(RHYTHM_KEYS, ['dawn', 'morning', 'afternoon', 'evening', 'night']);
  assert.deepEqual(FREED_TO_KEYS, ['family', 'exercise', 'study', 'rest', 'hobby', 'other']);
  assert.deepEqual(RATINGS, ['much', 'little', 'none']);
  assert.equal(FEATURES_USAGES_MAX, 200);
  assert.equal(FREED_MINUTES_MAX, 10080); // 一周总分钟数，物理上限
  assert.equal(STYLE_EVIDENCE_MAX, 3);    // D3: 流派卡三条证据
  assert.deepEqual(MATCH_WEIGHTS, { kindMix: 0.3, rhythm: 0.2, usages: 0.3, freedTo: 0.2 });
  assert.equal(MATCHES_PER_WEEK, 3);
  assert.equal(MATCH_REASON_MAX, 2);
  assert.equal(MATCH_RECENT_USAGES_MAX, 2);
  assert.equal(BATON_CHAIN_MAX_HOPS, 5);  // D6: 传递链最多展示 5 跳
  assert.equal(MAX_PAIRS, 5);             // PRD §4.5 最多 5 位搭档
  assert.equal(PAIR_FREEZES_PER_WEEK, 1);
  assert.equal(CIRCLE_MIN_MEMBERS, 3);
  assert.equal(CIRCLE_MAX_MEMBERS, 50);
  assert.equal(CIRCLE_RANK_SHOWN, 3);     // D5: 前 3 名 + 你
  assert.deepEqual(CIRCLE_RANK_METRICS, ['batons', 'graduations']); // D5: 只按传棒与毕业
  assert.equal(MIN_AGE_PUBLIC_POOL, 18);  // PRD §5: 未满 18 不进公开同频池
  assert.equal(QUESTS_PER_WEEK, 3);
  assert.deepEqual(QUEST_SCOPES, ['personal', 'circle']);
  assert.deepEqual(QUEST_FEEDBACK_TYPES, ['too-much']); // PRD §8 "太多了"
  assert.deepEqual(PRIORITIES, [1, 2, 3, 4, 5]);
  assert.equal(PRIORITY_MIN, 1);
  assert.equal(PRIORITY_MAX, 5);
});

test('features upload round-trips exactly the PRD §3.1 whitelist', () => {
  const result = validateFeaturesUpload(mkFeatures());
  assert.equal(result.ok, true);
  assert.deepEqual(Object.keys(result.value).sort(), [...FEATURES_UPLOAD_FIELDS].sort());
  assert.deepEqual(Object.keys(result.value.kindMix).sort(), [...KIND_MIX_KEYS].sort());
  assert.deepEqual(result.value.usages, ['meeting-notes', 'paper-5points']);
  assert.equal(result.value.freedMinutesConfirmed, 180);
  const clean = sanitizeFeaturesUpload(mkFeatures());
  assert.deepEqual(clean, result.value);
});

test('D2: whitelist rejects every forbidden field — titles, materials, times, places', () => {
  assert.ok(FORBIDDEN_UPLOAD_FIELDS.length >= 10);
  for (const field of FORBIDDEN_UPLOAD_FIELDS) {
    assert.ok(!FEATURES_UPLOAD_FIELDS.includes(field), field + ' must never be whitelisted');
    const tainted = Object.assign(mkFeatures(), { [field]: '绝不该上传的内容' });
    const result = validateFeaturesUpload(tainted);
    assert.equal(result.ok, false, field);
    assert.ok(result.errors.some((e) => e.path === 'payload.' + field), field);
    assert.equal(sanitizeFeaturesUpload(tainted), null, field);
  }
  // nested whitelists reject unknown keys too — an item title smuggled into
  // kindMix is still an item title.
  const nestedTitle = mkFeatures();
  nestedTitle.kindMix = Object.assign({}, nestedTitle.kindMix, { title: '组会前夜整理文献' });
  assert.equal(validateFeaturesUpload(nestedTitle).ok, false);
  const nestedTime = mkFeatures();
  nestedTime.rhythm = Object.assign({}, nestedTime.rhythm, { startTime: '22:30' });
  assert.equal(validateFeaturesUpload(nestedTime).ok, false);
  const nestedMinutes = mkFeatures();
  nestedMinutes.freedTo = Object.assign({}, nestedMinutes.freedTo, { minutes: 45 });
  assert.equal(validateFeaturesUpload(nestedMinutes).ok, false);
});

test('features upload rejects bad shapes, weeks, ratios, counts and usage ids', () => {
  assert.equal(validateFeaturesUpload(null).ok, false);
  assert.equal(validateFeaturesUpload('features').ok, false);
  assert.equal(validateFeaturesUpload([]).ok, false);
  assert.equal(sanitizeFeaturesUpload(null), null);
  const missing = mkFeatures();
  delete missing.freedTo;
  assert.equal(validateFeaturesUpload(missing).ok, false);
  for (const week of ['2026-w43', '2026-W00', '2026-W54', '26-W43', '2026-43']) {
    assert.equal(validateFeaturesUpload(Object.assign(mkFeatures(), { week })).ok, false, week);
  }
  const notSumming = mkFeatures();
  notSumming.kindMix.create = 0.15; // sum 0.9
  assert.equal(validateFeaturesUpload(notSumming).ok, false);
  const overRange = mkFeatures();
  overRange.rhythm.night = 1.15;
  assert.equal(validateFeaturesUpload(overRange).ok, false);
  const stringRatio = mkFeatures();
  stringRatio.freedTo.family = '0.3';
  assert.equal(validateFeaturesUpload(stringRatio).ok, false);
  for (const bad of [{ relays: -1 }, { relays: 1.5 }, { graduations: 100001 },
    { freedMinutesConfirmed: 10081 }, { usages: ['Meeting Notes'] },
    { usages: ['meeting-notes', 'meeting-notes'] },
    { usages: Array.from({ length: FEATURES_USAGES_MAX + 1 }, (_, i) => 'usage-' + i) },
    { rating: { much: 1, little: 0, none: -1 } }]) {
    assert.equal(validateFeaturesUpload(Object.assign(mkFeatures(), bad)).ok, false, JSON.stringify(bad));
  }
});

test('styles pin the six PRD §3.2 schools with colors', () => {
  assert.equal(STYLES.length, 6);
  assert.deepEqual(STYLE_IDS, STYLES.map((s) => s.id));
  assert.equal(new Set(STYLE_IDS).size, 6);
  assert.deepEqual(Object.fromEntries(STYLES.map((s) => [s.id, s.color])), {
    'morning-sorter': '#E8B04B', 'night-creator': '#4C7A93', 'relay-ace': '#E95432',
    'slow-liver': '#3E7B5B', 'academic-climber': '#615CED', 'parallel-runner': '#C7701F',
  });
  assert.deepEqual(STYLES.map((s) => s.label),
    ['晨光整理派', '深夜创作派', '接力达人派', '生活慢行派', '学术攀登派', '多线并行派']);
  STYLES.forEach((s) => {
    assert.deepEqual(Object.keys(s).sort(), ['color', 'id', 'label', 'motto']);
    assert.ok(s.motto.length >= 4);
  });
  const card = validateStyleCard({
    style: 'night-creator', week: WEEK,
    evidence: ['晚上 10 点后创作 4 次', 'create 类占比 62%', '本周 9 次接力'],
  });
  assert.deepEqual(card, {
    style: 'night-creator', week: WEEK,
    evidence: ['晚上 10 点后创作 4 次', 'create 类占比 62%', '本周 9 次接力'],
  });
  assert.equal(validateStyleCard({ style: 'night-creator', week: WEEK, evidence: ['a', 'b', 'c', 'd'] }), null);
  assert.equal(validateStyleCard({ style: 'night-creator', week: WEEK, evidence: [] }), null);
  assert.equal(validateStyleCard({ style: '夜间派', week: WEEK, evidence: ['a'] }), null);
  assert.equal(validateStyleCard({ style: 'night-creator', week: '第43周', evidence: ['a'] }), null);
  assert.equal(validateStyleCard({ style: 'night-creator', week: WEEK, evidence: ['a'], motto: 'x' }), null);
  assert.equal(validateStyleCard({ style: 'night-creator', week: WEEK, evidence: ['x'.repeat(81)] }), null);
});

test('matching: alias/avatar shape and the slightly-ahead band (PRD §3.3)', () => {
  assert.equal(validateAlias(' 安静的湖 '), '安静的湖');
  assert.equal(validateAlias(''), null);
  assert.equal(validateAlias('x'.repeat(ALIAS_MAX + 1)), null);
  assert.equal(isAvatarColor('#4C7A93'), true);
  assert.equal(isAvatarColor('#4c7a93'), true);
  assert.equal(isAvatarColor('var(--a-night)'), false);
  assert.equal(isAvatarColor('blue'), false);
  // 略多一点：对方 graduations ≥ 你，且 ≤ 你的 2 倍 + 2。
  assert.equal(isSlightlyAhead(3, 3), true);
  assert.equal(isSlightlyAhead(3, 8), true);
  assert.equal(isSlightlyAhead(3, 9), false);
  assert.equal(isSlightlyAhead(3, 2), false);
  assert.equal(isSlightlyAhead(0, 2), true);
  assert.equal(isSlightlyAhead(0, 3), false);
  assert.equal(isSlightlyAhead(-1, 0), false);
  assert.equal(isSlightlyAhead(2, 2.5), false);
  const mkMatch = () => ({
    alias: '安静的湖', avatarColor: '#4C7A93', style: 'night-creator', similarity: 0.86,
    theirGraduations: 4,
    reasons: ['你们都在晚上做创作类的事', '你们都把空出来的时间给了运动'],
    recentUsages: ['meeting-notes', 'weekly-report'],
  });
  assert.ok(validateMatch(mkMatch()));
  assert.deepEqual(validateMatch(mkMatch()), mkMatch());
  assert.ok(validateMatch(mkMatch(), { myGraduations: 3 }));
  assert.equal(validateMatch(mkMatch(), { myGraduations: 10 }), null); // 对方不能落后于你
  assert.equal(validateMatch(Object.assign(mkMatch(), { theirGraduations: 9 }), { myGraduations: 3 }), null);
  for (const bad of [{ similarity: 1.4 }, { similarity: '86%' }, { similarity: -0.1 },
    { reasons: ['a', 'b', 'c'] }, { reasons: [''] }, { recentUsages: ['a', 'b', 'c'] },
    { recentUsages: ['Meeting Notes'] }, { style: '夜间派' }, { alias: '  ' },
    { avatarColor: 'blue' }, { email: 'a@b.c' }, { theirGraduations: -1 }]) {
    assert.equal(validateMatch(Object.assign(mkMatch(), bad)), null, JSON.stringify(bad));
  }
});

test('kudos: three shareable event kinds (PRD §4.3)', () => {
  assert.deepEqual(KUDOS_EVENT_KINDS, ['usage-learned', 'self-kept', 'time-given']);
  const mkKudos = () => ({ from: 'acc-1', to: 'acc-2', eventKind: 'usage-learned', sharedEventId: 'share-9' });
  assert.deepEqual(validateKudos(mkKudos()), mkKudos());
  for (const bad of [{ eventKind: 'clicked' }, { eventKind: '' },
    { from: '' }, { to: ' ' }, { sharedEventId: '' }, { note: '加油！' }]) {
    assert.equal(validateKudos(Object.assign(mkKudos(), bad)), null, JSON.stringify(bad));
  }
});

test('D6: baton usage card carries exactly usageId + scenarioTitle + promptTemplate', () => {
  assert.deepEqual(BATON_CARD_FIELDS, ['usageId', 'scenarioTitle', 'promptTemplate']);
  const card = validateBatonCard(mkCard());
  assert.deepEqual(card, mkCard());
  assert.deepEqual(Object.keys(card).sort(), [...BATON_CARD_FIELDS].sort());
  // 任何个人内容字段都进不来
  for (const extra of [{ material: '组会录音转写…' }, { note: '给妈妈的说明' }, { title: 'x' },
    { senderName: '安静的湖' }, { event: '整理周报' }]) {
    assert.equal(validateBatonCard(Object.assign(mkCard(), extra)), null, JSON.stringify(extra));
  }
  assert.equal(validateBatonCard(Object.assign(mkCard(), { scenarioTitle: '字'.repeat(SCENARIO_TITLE_MAX + 1) })), null);
  assert.equal(validateBatonCard(Object.assign(mkCard(), { promptTemplate: '字'.repeat(PROMPT_TEMPLATE_MAX + 1) })), null);
  assert.equal(validateBatonCard(Object.assign(mkCard(), { promptTemplate: '   ' })), null);
  assert.equal(validateBatonCard({ usageId: 'Meeting Notes', scenarioTitle: 't', promptTemplate: 'p' }), null);
});

test('baton events pin the D6 lifecycle and shares target kinds', () => {
  assert.deepEqual(BATON_EVENTS, ['sent', 'opened', 'relay-completed', 'graduated']);
  assert.deepEqual(BATON_EVENT_LABELS, { sent: '发出', opened: '打开', 'relay-completed': '完成接力', graduated: '毕业' });
  BATON_EVENTS.forEach((kind) => {
    const evt = { id: 'evt-1', batonId: 'baton-7', kind, at: '2026-10-25T01:00:00.000Z', byAccount: 'acc-1' };
    assert.deepEqual(validateBatonEvent(evt), evt, kind);
  });
  for (const bad of [{ kind: 'clicked' }, { at: '昨天' }, { at: null },
    { byAccount: '' }, { extra: 1 }]) {
    assert.equal(validateBatonEvent(Object.assign({ id: 'evt-1', batonId: 'baton-7', kind: 'sent', at: '2026-10-25T01:00:00.000Z', byAccount: 'acc-1' }, bad)), null, JSON.stringify(bad));
  }
  assert.deepEqual(BATON_TARGET_KINDS, ['pair', 'circle', 'link']);
  const share = { id: 'baton-7', usageId: 'meeting-notes', fromAccount: 'acc-1', targetKind: 'pair', targetId: 'pair-3', card: mkCard() };
  assert.ok(validateBatonShare(share));
  assert.ok(validateBatonShare(Object.assign(share, { targetKind: 'link', targetId: null })));
  assert.equal(validateBatonShare(Object.assign(share, { targetKind: 'circle', targetId: null })), null);
  assert.equal(validateBatonShare(Object.assign(share, { targetKind: 'dm' })), null);
  assert.equal(validateBatonShare(Object.assign(share, { card: Object.assign(mkCard(), { material: 'x' }) })), null);
});

test('D6: the chain view never shows more than 5 hops', () => {
  const chain = ['晨', '湖', '松', '鹿', '妈', '组', '你'];
  assert.deepEqual(clipBatonChain(chain), ['松', '鹿', '妈', '组', '你']);
  assert.deepEqual(clipBatonChain(['晨', '湖']), ['晨', '湖']);
  assert.deepEqual(clipBatonChain([]), []);
  assert.deepEqual(clipBatonChain(null), []);
  assert.deepEqual(clipBatonChain('晨→湖'), []);
  assert.deepEqual(clipBatonChain(['晨', 42, null, '湖']), ['晨', '湖']);
  assert.equal(clipBatonChain(chain).length, BATON_CHAIN_MAX_HOPS);
});

test('pairs: two distinct accounts, one freeze a week (PRD §4.5)', () => {
  const mkPair = () => ({ id: 'pair-3', a: 'acc-1', b: 'acc-2', startedWeek: WEEK, flame: 12, freezesUsed: 0 });
  assert.deepEqual(validatePair(mkPair()), mkPair());
  for (const bad of [{ b: 'acc-1' }, { freezesUsed: PAIR_FREEZES_PER_WEEK + 1 },
    { startedWeek: '2026-43' }, { flame: -1 }, { flame: 2.5 }, { penalty: true }]) {
    assert.equal(validatePair(Object.assign(mkPair(), bad)), null, JSON.stringify(bad));
  }
});

test('D5: circles rank by batons and graduations only — never work hours', () => {
  const mkCircle = () => ({ id: 'circle-1', name: '课题组', inviteCode: 'TANGO7' });
  assert.deepEqual(validateCircle(mkCircle()), mkCircle());
  assert.equal(validateCircle(Object.assign(mkCircle(), { inviteCode: 'tango7' })), null);
  assert.equal(validateCircle(Object.assign(mkCircle(), { inviteCode: 'AB1' })), null);
  assert.equal(validateCircle(Object.assign(mkCircle(), { name: '字'.repeat(31) })), null);
  const entry = (rank, alias) => ({ rank, alias, avatarColor: '#E8B04B', batons: 7 - rank, graduations: 3 });
  const view = { top: [entry(1, '远山的松'), entry(2, '晨跑的鹿'), entry(3, '安静的湖')], you: { ...entry(6, '你'), alias: '你' } };
  assert.ok(validateCircleRankView(view));
  assert.equal(validateCircleRankView(Object.assign({}, view, { top: [...view.top, entry(4, 'x')] })), null);
  assert.equal(validateCircleRankView({ top: [Object.assign(entry(1, 'x'), { minutes: 320 })], you: null }), null);
  assert.equal(validateCircleRankView({ top: [Object.assign(entry(1, 'x'), { hours: 5 })], you: null }), null);
  assert.equal(validateCircleRankView({ top: [entry(1, 'x')], you: null, school: '某大学' }), null);
  // 圈内"空出来的时间"汇总只允许占比，不允许分钟数
  const summary = { family: 0.4, exercise: 0.3, study: 0.1, rest: 0.1, hobby: 0.06, other: 0.04 };
  assert.deepEqual(validateFreedToSummary(summary), summary);
  assert.equal(validateFreedToSummary(Object.assign({}, summary, { minutes: 45 })), null);
  assert.equal(validateFreedToSummary(Object.assign({}, summary, { family: 0.3 })), null); // sum 0.9
  assert.equal(validateFreedToSummary({ family: 0.5 }), null); // 缺键
});

test('quests: three a week, personal or circle, with a too-much escape hatch', () => {
  const mkQuest = () => ({ id: 'quest-give', week: WEEK, scope: 'personal', title: '给 1 个人传棒', target: 1, unit: '次' });
  assert.deepEqual(validateQuest(mkQuest()), mkQuest());
  for (const bad of [{ scope: 'team' }, { scope: '' }, { target: 0 }, { target: 1.5 },
    { title: '字'.repeat(61) }, { unit: '' }, { week: '第43周' }, { badge: 'x' }]) {
    assert.equal(validateQuest(Object.assign(mkQuest(), bad)), null, JSON.stringify(bad));
  }
  const mkProgress = () => ({ questId: 'quest-give', scope: 'personal', owner: 'acc-1', progress: 1, done: true });
  assert.deepEqual(validateQuestProgress(mkProgress()), mkProgress());
  for (const bad of [{ done: 'yes' }, { progress: -1 }, { owner: '' }, { note: 'x' }]) {
    assert.equal(validateQuestProgress(Object.assign(mkProgress(), bad)), null, JSON.stringify(bad));
  }
});

test('priorities keep the app-wide 1–5 enum (1 highest)', () => {
  assert.equal(isPriority(1), true);
  assert.equal(isPriority(5), true);
  assert.equal(isPriority(0), false);
  assert.equal(isPriority(6), false);
  assert.equal(isPriority(2.5), false);
  assert.equal(isPriority('3'), false);
});
