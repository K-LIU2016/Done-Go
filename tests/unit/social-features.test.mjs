import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// S2·流派相似度 line (PRD design/social-sync/PRD.md §3.2/§3.3, D3):
// pure functions + configurable thresholds in scripts/social-features.mjs.
// Every shape gates on web/social/contracts.js — style cards must pass
// validateStyleCard, match records must pass validateMatch. 6 styles each get
// a typical case plus threshold boundary cases; the 略多一点 filter must be
// equivalent to contracts.isSlightlyAhead at default config (PRD §3.3 hard
// boundary) while staying configurable; 10k-profile matching must stay <300ms.

import {
  STYLE_IDS, STYLES,
  MATCH_WEIGHTS, MATCHES_PER_WEEK, MATCH_REASON_TEXT_MAX, STYLE_EVIDENCE_MAX,
  validateStyleCard, validateMatch, isSlightlyAhead,
} from '../../web/social/contracts.js';

import {
  USAGE_CATEGORIES, STYLE_THRESHOLD_DEFAULTS, resolveStyleConfig,
  normalizedKindEntropy, usageCategoryCounts,
  determineStyle, buildStyleCard,
  cosine, jaccard, similarity, compileProfile, similarityCompiled,
  AHEAD_DEFAULTS, isAhead, matchReasons, findMatches,
} from '../../scripts/social-features.mjs';

const WEEK = '2026-W43';

// ---------------------------------------------------------------------------
// fixtures — base profile is deliberately mid-signal: NO style fires strongly
// (day .40 <.5, late .35 <.45, create .2 <.3, relays 3 <8, life .59 <.6,
// read share .2 <.5, entropy ~.802 <.85), so every typical case overrides
// only what its style needs and boundary misses are attributable.
// ---------------------------------------------------------------------------
function mk(over = {}) {
  const base = {
    week: WEEK,
    kindMix: { necessary: 0.5, create: 0.2, connect: 0.08, explore: 0.1, restore: 0.07, stillness: 0.05 },
    rhythm: { dawn: 0.1, morning: 0.3, afternoon: 0.25, evening: 0.2, night: 0.15 },
    usages: ['meeting-notes', 'paper-read', 'weekly-report', 'homework-plan', 'recipe-plan'],
    relays: 3,
    graduations: 1,
    rating: { much: 4, little: 2, none: 1 },
    freedTo: { family: 0.25, exercise: 0.14, study: 0.2, rest: 0.2, hobby: 0.11, other: 0.1 },
    freedMinutesConfirmed: 180,
  };
  return { ...structuredClone(base), ...structuredClone(over) };
}

const READ_USAGES = ['paper-read', 'survey-read', 'doc-read', 'code-debug', 'policy-read'];
const ORGANIZE_USAGES = ['meeting-notes', 'notes-condense', 'wrong-questions', 'refs-format'];

function morningTypical() {
  return mk({
    rhythm: { dawn: 0.12, morning: 0.42, afternoon: 0.2, evening: 0.16, night: 0.1 },
    usages: ['meeting-notes', 'notes-condense', 'wrong-questions', 'paper-read'],
    relays: 2,
  });
}
function nightTypical() {
  return mk({
    kindMix: { necessary: 0.15, create: 0.4, connect: 0.05, explore: 0.2, restore: 0.1, stillness: 0.1 },
    rhythm: { dawn: 0.02, morning: 0.05, afternoon: 0.13, evening: 0.3, night: 0.5 },
    usages: ['presentation-prep', 'memoir-write', 'report-page', 'old-photo'],
    relays: 2,
  });
}
function slowTypical() {
  return mk({
    freedTo: { family: 0.35, exercise: 0.15, study: 0.1, rest: 0.15, hobby: 0.15, other: 0.1 },
  });
}
function academicTypical() {
  return mk({ usages: READ_USAGES });
}
function parallelTypical() {
  return mk({
    kindMix: { necessary: 0.18, create: 0.17, connect: 0.16, explore: 0.17, restore: 0.16, stillness: 0.16 },
    usages: ['meeting-notes', 'paper-read', 'weekly-report', 'homework-plan', 'recipe-plan', 'trip-plan'],
  });
}

// ---------------------------------------------------------------------------
// 1. usage category snapshot must track the relay scene library exactly.
// ---------------------------------------------------------------------------
test('usage category snapshot matches the relay scene library (drift gate)', () => {
  const libPath = resolve(dirname(fileURLToPath(import.meta.url)), '../../web/relay/scenes.zh.json');
  const lib = JSON.parse(readFileSync(libPath, 'utf8'));
  assert.equal(lib.version, 1);
  assert.ok(Array.isArray(lib.usages) && lib.usages.length >= 50);
  const libIds = new Set();
  for (const usage of lib.usages) {
    libIds.add(usage.id);
    assert.equal(
      USAGE_CATEGORIES[usage.id], usage.category,
      `usage ${usage.id} categorized ${USAGE_CATEGORIES[usage.id]} but library says ${usage.category}`,
    );
  }
  const snapIds = new Set(Object.keys(USAGE_CATEGORIES));
  assert.deepEqual([...snapIds].sort(), [...libIds].sort(), 'snapshot ids must equal library ids exactly');
});

test('usageCategoryCounts counts by library category and ignores unknown ids', () => {
  const counts = usageCategoryCounts(['meeting-notes', 'notes-condense', 'paper-read', 'paper-5points']);
  assert.equal(counts['整理'], 2);
  assert.equal(counts['读'], 1);
  assert.equal(counts['写'], 0);
  // paper-5points is not in the library → uncategorized, never crashes.
  assert.equal(counts.__total__, 4);
});

// ---------------------------------------------------------------------------
// 2. entropy math.
// ---------------------------------------------------------------------------
test('normalizedKindEntropy: uniform→1, single kind→0, half-half→1/log2(6)', () => {
  const uniform = { necessary: 1 / 6, create: 1 / 6, connect: 1 / 6, explore: 1 / 6, restore: 1 / 6, stillness: 1 / 6 };
  assert.ok(Math.abs(normalizedKindEntropy(uniform) - 1) < 1e-12);
  assert.equal(normalizedKindEntropy({ necessary: 1, create: 0, connect: 0, explore: 0, restore: 0, stillness: 0 }), 0);
  const half = { necessary: 0.5, create: 0.5, connect: 0, explore: 0, restore: 0, stillness: 0 };
  assert.ok(Math.abs(normalizedKindEntropy(half) - 1 / Math.log2(6)) < 1e-12);
});

// ---------------------------------------------------------------------------
// 3. six typical cases — strong classification + 3 evidence lines + valid card.
// ---------------------------------------------------------------------------
test('typical: morning-sorter', () => {
  const r = determineStyle(morningTypical());
  assert.equal(r.style, 'morning-sorter');
  assert.equal(r.strong, true);
  assert.equal(r.evidence.length, 3);
  assert.equal(r.evidence[0], '早晨+上午开始的事占了54%');
  assert.equal(r.evidence[1], '整理类用法用了3个');
  const card = buildStyleCard(morningTypical());
  assert.ok(card);
  assert.deepEqual(card, validateStyleCard(card));
  assert.equal(card.week, WEEK);
});

test('typical: night-creator', () => {
  const r = determineStyle(nightTypical());
  assert.equal(r.style, 'night-creator');
  assert.equal(r.strong, true);
  assert.equal(r.evidence.length, 3);
  assert.equal(r.evidence[0], '晚上+夜里开始的事占了80%');
  assert.equal(r.evidence[1], '创作类的事占了40%');
  assert.ok(buildStyleCard(nightTypical()));
});

test('typical: relay-ace', () => {
  const r = determineStyle(mk({ relays: 9, graduations: 3 }));
  assert.equal(r.style, 'relay-ace');
  assert.equal(r.strong, true);
  assert.deepEqual(r.evidence, ['本周接力9次', '毕业3次', '本周共用了5种AI用法']);
  assert.ok(buildStyleCard(mk({ relays: 9, graduations: 3 })));
});

test('typical: slow-liver', () => {
  const r = determineStyle(slowTypical());
  assert.equal(r.style, 'slow-liver');
  assert.equal(r.strong, true);
  assert.equal(r.evidence.length, 3);
  assert.equal(r.evidence[0], '空出来的时间65%给了家人、休息或运动');
  assert.equal(r.evidence[1], '其中给家人最多，占35%');
  assert.equal(r.evidence[2], '本人确认的空出时间3小时');
  assert.ok(buildStyleCard(slowTypical()));
});

test('typical: academic-climber', () => {
  const r = determineStyle(academicTypical());
  assert.equal(r.style, 'academic-climber');
  assert.equal(r.strong, true);
  assert.equal(r.evidence.length, 3);
  // READ_USAGES 的 5 个用法全部属于用法库「读」类。
  assert.equal(r.evidence[0], '读论文、文献类用法占了100%');
  assert.equal(r.evidence[1], '这周用了5个读类用法');
  assert.ok(buildStyleCard(academicTypical()));
});

test('typical: parallel-runner', () => {
  const r = determineStyle(parallelTypical());
  assert.equal(r.style, 'parallel-runner');
  assert.equal(r.strong, true);
  assert.equal(r.evidence.length, 3);
  assert.equal(r.evidence[1], '本周用了6种不同的AI用法');
  // min share 0.16 → at least 16% in the smallest kind.
  assert.equal(r.evidence[2], '最少的一类也占了16%');
  assert.ok(buildStyleCard(parallelTypical()));
});

// ---------------------------------------------------------------------------
// 4. boundary cases (defaults from STYLE_THRESHOLD_DEFAULTS / PRD §3.2).
// ---------------------------------------------------------------------------
test('boundary: morning day share — 0.50 strong, 0.49 not', () => {
  const at = mk({
    rhythm: { dawn: 0.1, morning: 0.4, afternoon: 0.25, evening: 0.15, night: 0.1 },
    usages: ['meeting-notes', 'notes-condense', 'wrong-questions', 'paper-read'],
  });
  assert.equal(determineStyle(at).strong && determineStyle(at).style, 'morning-sorter');

  const under = mk({
    rhythm: { dawn: 0.09, morning: 0.4, afternoon: 0.26, evening: 0.15, night: 0.1 },
    usages: ['meeting-notes', 'notes-condense', 'wrong-questions', 'paper-read'],
  });
  const r = determineStyle(under);
  assert.equal(r.strong, false, '0.49 day share must miss the strong rule');
  assert.notEqual(r.style, 'morning-sorter');
});

test('boundary: morning needs ≥2 organize usages', () => {
  const oneOrganize = mk({
    rhythm: { dawn: 0.12, morning: 0.42, afternoon: 0.2, evening: 0.16, night: 0.1 },
    usages: ['meeting-notes', 'paper-read', 'weekly-report', 'homework-plan'], // only 1 整理
    relays: 2,
  });
  assert.equal(determineStyle(oneOrganize).strong, false);
});

test('boundary: night late share — 0.45 strong, 0.44 not; create 0.30 strong, 0.29 not', () => {
  // 4 usages (<5) keeps parallel-runner's entropy gate out of these fixtures
  // (the create-heavy kindMix here has entropy ≈0.88 ≥0.85).
  const four = ['presentation-prep', 'memoir-write', 'report-page', 'old-photo'];
  const late45 = mk({
    kindMix: { necessary: 0.15, create: 0.4, connect: 0.05, explore: 0.2, restore: 0.1, stillness: 0.1 },
    rhythm: { dawn: 0.05, morning: 0.1, afternoon: 0.4, evening: 0.25, night: 0.2 },
    usages: four,
  });
  assert.equal(determineStyle(late45).strong && determineStyle(late45).style, 'night-creator');

  const late44 = mk({
    kindMix: { necessary: 0.15, create: 0.4, connect: 0.05, explore: 0.2, restore: 0.1, stillness: 0.1 },
    rhythm: { dawn: 0.05, morning: 0.11, afternoon: 0.4, evening: 0.24, night: 0.2 },
    usages: four,
  });
  assert.equal(determineStyle(late44).strong, false);

  const create29 = mk({
    kindMix: { necessary: 0.16, create: 0.29, connect: 0.05, explore: 0.2, restore: 0.1, stillness: 0.1 },
    rhythm: { dawn: 0.02, morning: 0.05, afternoon: 0.13, evening: 0.3, night: 0.5 },
    usages: four,
  });
  assert.equal(determineStyle(create29).strong, false);

  const create30 = mk({
    kindMix: { necessary: 0.15, create: 0.3, connect: 0.05, explore: 0.2, restore: 0.1, stillness: 0.1 },
    rhythm: { dawn: 0.02, morning: 0.05, afternoon: 0.13, evening: 0.3, night: 0.5 },
    usages: four,
  });
  assert.equal(determineStyle(create30).strong && determineStyle(create30).style, 'night-creator');
});

test('boundary: relay-ace — 8/2 strong, 8/1 and 7/5 not', () => {
  assert.equal(determineStyle(mk({ relays: 8, graduations: 2 })).style, 'relay-ace');
  assert.equal(determineStyle(mk({ relays: 8, graduations: 2 })).strong, true);
  assert.equal(determineStyle(mk({ relays: 8, graduations: 1 })).strong, false);
  assert.equal(determineStyle(mk({ relays: 7, graduations: 5 })).strong, false);
});

test('boundary: slow-liver — 0.60 strong, 0.59 not', () => {
  const at = mk({ freedTo: { family: 0.3, exercise: 0.15, study: 0.15, rest: 0.15, hobby: 0.15, other: 0.1 } });
  assert.equal(determineStyle(at).strong && determineStyle(at).style, 'slow-liver');
  const under = mk(); // base life share = 0.59
  assert.equal(determineStyle(under).strong, false);
});

test('boundary: academic — read share 0.50 with 2 reads strong, 1/3 not', () => {
  const half = mk({ usages: ['paper-read', 'survey-read', 'meeting-notes', 'weekly-report'] });
  assert.equal(determineStyle(half).strong && determineStyle(half).style, 'academic-climber');
  const third = mk({ usages: ['paper-read', 'meeting-notes', 'weekly-report'] });
  assert.equal(determineStyle(third).strong, false);
});

test('boundary: parallel — entropy gate and min usages 5', () => {
  const fourUsages = mk({
    kindMix: { necessary: 0.18, create: 0.17, connect: 0.16, explore: 0.17, restore: 0.16, stillness: 0.16 },
    usages: ['meeting-notes', 'paper-read', 'weekly-report', 'homework-plan'],
  });
  assert.equal(determineStyle(fourUsages).strong, false, '4 usages < 5');

  const flatEntropy = mk(); // base entropy ~0.802 < 0.85
  assert.equal(determineStyle(flatEntropy).strong, false);

  // exact-threshold entropy via override: strong at H, not at H+ε.
  const baseEntropy = normalizedKindEntropy(mk().kindMix);
  const atThreshold = determineStyle(mk(), { parallelRunner: { minEntropy: baseEntropy } });
  assert.equal(atThreshold.style, 'parallel-runner');
  assert.equal(atThreshold.strong, true);
  const above = determineStyle(mk(), { parallelRunner: { minEntropy: baseEntropy + 1e-6 } });
  assert.equal(above.strong, false);
});

// ---------------------------------------------------------------------------
// 5. precedence + fallback.
// ---------------------------------------------------------------------------
test('multiple strong matches resolve in STYLE_IDS (PRD table) order', () => {
  const both = mk({
    rhythm: { dawn: 0.12, morning: 0.42, afternoon: 0.2, evening: 0.16, night: 0.1 },
    usages: ['meeting-notes', 'notes-condense', 'wrong-questions', 'paper-read'],
    relays: 10,
    graduations: 3,
  });
  assert.equal(determineStyle(both).style, 'morning-sorter');

  const nightAndRelay = nightTypical();
  nightAndRelay.relays = 9;
  nightAndRelay.graduations = 3;
  assert.equal(determineStyle(nightAndRelay).style, 'night-creator');
});

test('fallback: no strong signal → closest style, honest marker line, valid card', () => {
  const r = determineStyle(mk());
  assert.equal(r.strong, false);
  assert.equal(r.evidence.length, 3);
  assert.equal(r.evidence[0], '本周流派特征还不明显，最接近这一派');
  const card = buildStyleCard(mk());
  assert.ok(card);
  assert.deepEqual(card, validateStyleCard(card));
  assert.ok(STYLE_IDS.includes(card.style));
});

test('fallback ties break by STYLE_IDS order (deterministic)', () => {
  // day share .35 == late share .35, everything else below both.
  const tie = mk({ rhythm: { dawn: 0.05, morning: 0.3, afternoon: 0.3, evening: 0.2, night: 0.15 } });
  const r1 = determineStyle(tie);
  const r2 = determineStyle(tie);
  assert.deepEqual(r1, r2);
  // metrics: morning .35 vs night .35 vs slow .59 vs parallel ~.802 → parallel-runner.
  assert.equal(r1.style, 'parallel-runner');
});

// ---------------------------------------------------------------------------
// 6. style config resolution.
// ---------------------------------------------------------------------------
test('resolveStyleConfig merges partial overrides and freezes', () => {
  const cfg = resolveStyleConfig({ relayAce: { minRelays: 5 } });
  assert.equal(cfg.relayAce.minRelays, 5);
  assert.equal(cfg.relayAce.minGraduations, STYLE_THRESHOLD_DEFAULTS.relayAce.minGraduations);
  assert.equal(cfg.nightCreator.minLateShare, STYLE_THRESHOLD_DEFAULTS.nightCreator.minLateShare);
  assert.ok(Object.isFrozen(cfg));

  // retuned threshold actually flips a boundary case (relays 6).
  const six = mk({ relays: 6, graduations: 2 });
  assert.equal(determineStyle(six).strong, false);
  assert.equal(determineStyle(six, cfg).style, 'relay-ace');
  assert.equal(determineStyle(six, cfg).strong, true);
});

test('resolveStyleConfig rejects unknown keys and bad values', () => {
  assert.throws(() => resolveStyleConfig({ nope: { x: 1 } }), TypeError);
  assert.throws(() => resolveStyleConfig({ relayAce: { minRelays: 'nine' } }), TypeError);
  assert.throws(() => resolveStyleConfig({ nightCreator: { minLateShare: 1.5 } }), TypeError);
  assert.throws(() => resolveStyleConfig({ morningSorter: { minOrganizeUsages: -1 } }), TypeError);
  assert.throws(() => resolveStyleConfig({ parallelRunner: { minUsages: 2.5 } }), TypeError);
});

test('buildStyleCard returns null for malformed features', () => {
  assert.equal(buildStyleCard({ week: WEEK }), null);
  assert.equal(buildStyleCard(null), null);
  assert.equal(buildStyleCard({ ...mk(), week: '2026-43' }), null);
});

// ---------------------------------------------------------------------------
// 7. similarity math (weighted cosine + Jaccard, MATCH_WEIGHTS from contracts).
// ---------------------------------------------------------------------------
test('cosine + jaccard primitives', () => {
  assert.equal(cosine([1, 0], [1, 0]), 1);
  assert.equal(cosine([1, 0], [0, 1]), 0);
  assert.ok(Math.abs(cosine([0.6, 0.8], [0.8, 0.6]) - 0.96) < 1e-12);
  assert.equal(cosine([0, 0], [1, 1]), 0); // zero-vector guard
  assert.equal(jaccard(['a', 'b'], ['a', 'b']), 1);
  assert.equal(jaccard(['a', 'b'], ['b', 'c']), 1 / 3);
  assert.equal(jaccard(['a'], ['b']), 0);
  assert.equal(jaccard([], []), 0); // no signal, defined as 0
});

test('similarity: identical → 1, disjoint → 0, hand-computed mixed case', () => {
  const identical = similarity(mk(), mk());
  assert.ok(Math.abs(identical - 1) < 1e-9);

  const me = mk({
    kindMix: { necessary: 0, create: 1, connect: 0, explore: 0, restore: 0, stillness: 0 },
    rhythm: { dawn: 0, morning: 0, afternoon: 0, evening: 0, night: 1 },
    usages: ['alpha', 'beta'],
    freedTo: { family: 0, exercise: 0, study: 0, rest: 1, hobby: 0, other: 0 },
  });
  const other = mk({
    kindMix: { necessary: 0, create: 1, connect: 0, explore: 0, restore: 0, stillness: 0 },
    rhythm: { dawn: 0, morning: 0, afternoon: 0, evening: 0.5, night: 0.5 },
    usages: ['beta', 'gamma'],
    freedTo: { family: 0, exercise: 0, study: 0, rest: 1, hobby: 0, other: 0 },
  });
  // kind cos 1 · rhythm cos = .5/√.5 = √.5 · jaccard 1/3 · freed cos 1
  const expected = 0.3 * 1 + 0.2 * Math.SQRT1_2 + 0.3 * (1 / 3) + 0.2 * 1;
  assert.ok(Math.abs(similarity(me, other) - expected) < 1e-9);

  const disjoint = similarity(
    mk({
      kindMix: { necessary: 1, create: 0, connect: 0, explore: 0, restore: 0, stillness: 0 },
      rhythm: { dawn: 1, morning: 0, afternoon: 0, evening: 0, night: 0 },
      usages: ['alpha'],
      freedTo: { family: 1, exercise: 0, study: 0, rest: 0, hobby: 0, other: 0 },
    }),
    mk({
      kindMix: { necessary: 0, create: 1, connect: 0, explore: 0, restore: 0, stillness: 0 },
      rhythm: { dawn: 0, morning: 0, afternoon: 0, evening: 0, night: 1 },
      usages: ['beta'],
      freedTo: { family: 0, exercise: 0, study: 0, rest: 1, hobby: 0, other: 0 },
    }),
  );
  assert.equal(disjoint, 0);
});

test('similarity stays within [0,1] and honors validated weight overrides', () => {
  const a = mk({ usages: ['alpha', 'beta', 'gamma'] });
  const b = mk({ usages: ['beta', 'gamma', 'delta'], relays: 4, graduations: 2 });
  for (let i = 0; i < 20; i += 1) {
    const s = similarity(a, b);
    assert.ok(s >= 0 && s <= 1, `similarity out of range: ${s}`);
  }
  // kindMix-only weighting → pure kind cosine (identical kindMix → 1).
  const kindOnly = similarity(a, b, { kindMix: 1, rhythm: 0, usages: 0, freedTo: 0 });
  assert.ok(Math.abs(kindOnly - 1) < 1e-9);
  assert.throws(() => similarity(a, b, { kindMix: 0.5, rhythm: 0.2, usages: 0.1, freedTo: 0.1 }), TypeError); // sum ≠ 1
  assert.throws(() => similarity(a, b, { kindMix: -0.3, rhythm: 0.5, usages: 0.6, freedTo: 0.2 }), TypeError); // negative
  assert.deepEqual(MATCH_WEIGHTS, { kindMix: 0.3, rhythm: 0.2, usages: 0.3, freedTo: 0.2 });
});

test('compileProfile/similarityCompiled agree with similarity and reject garbage', () => {
  const a = mk();
  const b = mk({ usages: ['beta', 'gamma', 'delta'] });
  const ca = compileProfile(a);
  const cb = compileProfile(b);
  assert.ok(Math.abs(similarityCompiled(ca, cb) - similarity(a, b)) < 1e-12);
  assert.throws(() => compileProfile({ ...mk(), kindMix: { necessary: 'x' } }), TypeError);
  assert.throws(() => compileProfile({ ...mk(), rhythm: null }), TypeError);
  assert.throws(() => compileProfile(null), TypeError);
});

// ---------------------------------------------------------------------------
// 8. 略多一点 filter — default equivalent to contracts.isSlightlyAhead.
// ---------------------------------------------------------------------------
test('isAhead default is exactly contracts.isSlightlyAhead (grid)', () => {
  assert.deepEqual(AHEAD_DEFAULTS, { factor: 2, offset: 2 });
  for (const mine of [0, 1, 2, 3, 5, 8, 13, 100]) {
    for (let theirs = 0; theirs <= mine * 2 + 4; theirs += 1) {
      assert.equal(
        isAhead(mine, theirs), isSlightlyAhead(mine, theirs),
        `mismatch at mine=${mine} theirs=${theirs}`,
      );
    }
  }
  assert.equal(isAhead(3, 2), false); // behind
  assert.equal(isAhead(3, 8), true);  // 2x+2 boundary
  assert.equal(isAhead(3, 9), false); // too far ahead
  assert.equal(isAhead(-1, 0), false);
  assert.equal(isAhead(1.5, 2), false);
});

test('isAhead honors configurable factor/offset', () => {
  const cfg = { factor: 3, offset: 0 };
  assert.equal(isAhead(2, 6, cfg), true);
  assert.equal(isAhead(2, 7, cfg), false);
  assert.equal(isAhead(2, 1, cfg), false);
  assert.throws(() => isAhead(2, 6, { factor: -1, offset: 0 }), TypeError);
});

// ---------------------------------------------------------------------------
// 9. matcher.
// ---------------------------------------------------------------------------
function cand(alias, features, extra = {}) {
  return { account: 'acc-' + alias, alias, avatarColor: '#4C7A93', features, ...extra };
}

test('findMatches: ahead filter, top-3 by similarity, contract-valid records', () => {
  const me = mk({ graduations: 3 }); // ahead range [3, 8]
  const near = mk({ usages: ['meeting-notes', 'paper-read', 'weekly-report', 'homework-plan', 'recipe-plan'], graduations: 5 });
  const candidates = [
    cand('ahead-too-far', mk({ graduations: 9 })),
    cand('behind', mk({ graduations: 2 })),
    cand('near', near),
    cand('mid', mk({ graduations: 4, usages: ['meeting-notes', 'paper-read', 'homework-plan', 'recipe-plan', 'trip-plan'] })),
    cand('far', mk({ graduations: 8, usages: ['quiz-10', 'lesson-plan', 'med-schedule'] })),
  ];
  const matches = findMatches(me, candidates);
  assert.equal(matches.length, 3);
  const aliases = matches.map((m) => m.alias);
  assert.ok(!aliases.includes('ahead-too-far'));
  assert.ok(!aliases.includes('behind'));
  // similarity desc
  assert.ok(matches[0].similarity >= matches[1].similarity);
  assert.ok(matches[1].similarity >= matches[2].similarity);
  // 'near' shares all 5 usages + all vectors → top similarity 1
  assert.equal(matches[0].alias, 'near');
  assert.equal(matches[0].similarity, 1);
  for (const rec of matches) {
    assert.notEqual(validateMatch(rec, { myGraduations: me.graduations }), null, JSON.stringify(rec));
    assert.ok(rec.reasons.length >= 1 && rec.reasons.length <= 2);
    for (const reason of rec.reasons) assert.ok(reason.length <= MATCH_REASON_TEXT_MAX);
    assert.ok(rec.recentUsages.length <= 2);
  }
});

test('findMatches: tie-break by alias is deterministic', () => {
  const me = mk({ graduations: 1 }); // ahead range [1, 4]
  const a = cand('bb', mk({ graduations: 2 }));
  const b = cand('aa', mk({ graduations: 3 }));
  const r1 = findMatches(me, [a, b]);
  const r2 = findMatches(me, [b, a]);
  assert.deepEqual(r1.map((m) => m.alias), r2.map((m) => m.alias));
  assert.equal(r1[0].alias, 'aa'); // identical similarity → alias asc
});

test('findMatches: self excluded, limit and minSimilarity options, empty pool', () => {
  const me = mk();
  const self = cand('me-me', mk({ graduations: 4 }));
  const one = cand('ok', mk({ graduations: 4 }));
  assert.deepEqual(findMatches(me, [self, one], { myAccount: 'acc-me-me' }).map((m) => m.alias), ['ok']);

  const many = [cand('a', mk({ graduations: 3 })), cand('b', mk({ graduations: 3 }))];
  assert.equal(findMatches(mk(), many, { limit: 1 }).length, 1);

  const loose = findMatches(me, many, { minSimilarity: 0.999999 });
  assert.ok(loose.every((m) => m.similarity >= 0.999999));

  assert.deepEqual(findMatches(me, []), []);
  assert.deepEqual(findMatches(mk({ graduations: 50 }), [cand('x', mk({ graduations: 3 }))]), []);
});

test('findMatches: custom ahead config validated without contract hard-boundary context', () => {
  const me = mk({ graduations: 2 });
  const six = cand('six', mk({ graduations: 6 }));
  const seven = cand('seven', mk({ graduations: 7 }));
  const matches = findMatches(me, [six, seven], { ahead: { factor: 3, offset: 0 } });
  assert.deepEqual(matches.map((m) => m.alias), ['six']); // 7 > 2*3+0
  assert.notEqual(validateMatch(matches[0]), null); // validates without context
});

test('findMatches: recentUsages honored and clipped; falls back to weekly usages head', () => {
  const me = mk();
  const withRecent = cand('r', mk({ graduations: 4 }), { recentUsages: ['alpha', 'beta', 'gamma'] });
  const [rec] = findMatches(me, [withRecent]);
  assert.deepEqual(rec.recentUsages, ['alpha', 'beta']);

  const noRecent = cand('n', mk({ graduations: 4 }));
  const [rec2] = findMatches(me, [noRecent]);
  assert.deepEqual(rec2.recentUsages, ['meeting-notes', 'paper-read']);
});

test('findMatches throws on internally malformed candidate shape (fail loud, no silent drop)', () => {
  const me = mk();
  const bad = { account: 'acc-bad', alias: 'bad', avatarColor: 'not-a-color', features: mk({ graduations: 4 }) };
  assert.throws(() => findMatches(me, [bad]), /SOCIAL_MATCH_SHAPE/);
});

// ---------------------------------------------------------------------------
// 10. 同频理由 — coarse, real-feature-driven, ≤2 lines (PRD §3.3).
// ---------------------------------------------------------------------------
test('matchReasons: night+create combo and freed bucket reasons from real features', () => {
  const me = mk({
    kindMix: { necessary: 0.15, create: 0.35, connect: 0.05, explore: 0.25, restore: 0.1, stillness: 0.1 },
    rhythm: { dawn: 0.02, morning: 0.05, afternoon: 0.13, evening: 0.3, night: 0.5 },
    freedTo: { family: 0.1, exercise: 0.4, study: 0.2, rest: 0.1, hobby: 0.1, other: 0.1 },
  });
  const other = mk({
    kindMix: { necessary: 0.2, create: 0.3, connect: 0.05, explore: 0.2, restore: 0.15, stillness: 0.1 },
    rhythm: { dawn: 0.05, morning: 0.05, afternoon: 0.1, evening: 0.25, night: 0.55 },
    freedTo: { family: 0.05, exercise: 0.45, study: 0.2, rest: 0.15, hobby: 0.1, other: 0.05 },
  });
  const reasons = matchReasons(me, other);
  assert.equal(reasons.length, 2);
  assert.equal(reasons[0], '你们都在夜里做创作类的事');
  assert.equal(reasons[1], '你们都把空出来的时间给了运动');
});

test('matchReasons: same strong style reason; usage overlap reason; always ≥1 line', () => {
  // relay-ace pair: no shared coarse slot / bucket / usage → the same-style
  // reason is the strongest signal (night pairs always fire the stronger
  // 夜里+创作 combo first, so they cannot isolate this rule).
  const me = mk({ relays: 9, graduations: 3 });
  const other = mk({
    relays: 10,
    graduations: 4,
    rhythm: { dawn: 0.05, morning: 0.05, afternoon: 0.45, evening: 0.25, night: 0.2 },
    freedTo: { family: 0.05, exercise: 0.1, study: 0.3, rest: 0.25, hobby: 0.15, other: 0.15 },
    usages: ['quiz-10', 'lesson-plan', 'med-schedule', 'ask-doctor', 'phone-usage'],
  });
  const reasons = matchReasons(me, other);
  assert.equal(reasons[0], '你们都是「接力达人派」');
  assert.ok(reasons.length <= 2);
  assert.ok(reasons.every((r) => r.length <= MATCH_REASON_TEXT_MAX));

  // weak pair → still at least one truthful coarse line, never empty.
  const weak = matchReasons(
    mk({ usages: ['alpha'] }),
    mk({ usages: ['beta'], graduations: 4, kindMix: { necessary: 0.7, create: 0.05, connect: 0.05, explore: 0.05, restore: 0.1, stillness: 0.05 } }),
  );
  assert.ok(weak.length >= 1 && weak.length <= 2);
  assert.ok(weak.every((r) => typeof r === 'string' && r.length > 0));

  // zero-usage edge never crashes and stays truthful.
  const empty = matchReasons(mk({ usages: [] }), mk({ usages: [] }));
  assert.ok(empty.length >= 1);
});

test('matchReasons: shared usage count phrasing fires on ≥2 shared usages', () => {
  // 2 shared of 8+8 → jaccard 2/14 < 0.25, so the count phrasing (not the
  // 常用用法很像 jaccard phrasing) must fire.
  const me = mk({ usages: ['meeting-notes', 'weekly-report', 'paper-read', 'trip-plan', 'memoir-write', 'quiz-10', 'lab-report', 'resume-edit'] });
  const other = mk({ usages: ['meeting-notes', 'weekly-report', 'homework-plan', 'med-schedule', 'ask-doctor', 'phone-usage', 'scam-check', 'recipe-plan'], graduations: 4 });
  const reasons = matchReasons(me, other);
  assert.ok(reasons.includes('你们有2个都在用的AI用法'), reasons.join(' | '));
});

// ---------------------------------------------------------------------------
// 11. performance — 10,000 candidate profiles must match in < 300ms (D/S2 gate).
// Synthetic profiles live in THIS TEST ONLY (mulberry32 PRNG); the production
// module never generates fake users.
// ---------------------------------------------------------------------------
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const LIB_IDS = Object.keys(USAGE_CATEGORIES);

function synthFeatures(rand, graduations) {
  const dice = (keys) => {
    const raw = keys.map(() => 0.05 + rand());
    const sum = raw.reduce((x, y) => x + y, 0);
    const out = {};
    keys.forEach((k, i) => { out[k] = raw[i] / sum; });
    out[keys[keys.length - 1]] += 1 - keys.reduce((acc, k) => acc + out[k], 0);
    return out;
  };
  const usageCount = 4 + Math.floor(rand() * 24);
  const pool = LIB_IDS.slice();
  for (let i = pool.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return {
    week: WEEK,
    kindMix: dice(['necessary', 'create', 'connect', 'explore', 'restore', 'stillness']),
    rhythm: dice(['dawn', 'morning', 'afternoon', 'evening', 'night']),
    usages: pool.slice(0, usageCount),
    relays: Math.floor(rand() * 12),
    graduations: graduations ?? Math.floor(rand() * 6),
    rating: { much: Math.floor(rand() * 6), little: Math.floor(rand() * 4), none: Math.floor(rand() * 3) },
    freedTo: dice(['family', 'exercise', 'study', 'rest', 'hobby', 'other']),
    freedMinutesConfirmed: Math.floor(rand() * 600),
  };
}

test('perf: 10,000 candidate profiles match in < 300ms', () => {
  const rand = mulberry32(0x5eed42);
  const COLORS = ['#E8B04B', '#4C7A93', '#E95432', '#3E7B5B', '#615CED', '#C7701F', '#335D4B', '#252722'];
  const me = synthFeatures(rand, 3); // ahead range [3, 8]
  const candidates = [];
  for (let i = 0; i < 10000; i += 1) {
    candidates.push({
      account: 'perf-' + i,
      alias: '同频' + i,
      avatarColor: COLORS[i % COLORS.length],
      features: synthFeatures(rand),
    });
  }
  // warm-up (JIT) on a 1k slice
  findMatches(me, candidates.slice(0, 1000));

  const durations = [];
  let matches;
  for (let run = 0; run < 3; run += 1) {
    const t0 = process.hrtime.bigint();
    matches = findMatches(me, candidates);
    durations.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  const best = Math.min(...durations);
  console.log('perf: 10k-profile findMatches durations (ms):', durations.map((d) => d.toFixed(1)).join(', '));
  assert.ok(best < 300, `best run ${best.toFixed(1)}ms must be < 300ms`);
  assert.equal(matches.length, MATCHES_PER_WEEK);
  for (const rec of matches) {
    assert.notEqual(validateMatch(rec, { myGraduations: me.graduations }), null);
  }
});
