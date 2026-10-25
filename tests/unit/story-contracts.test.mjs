import assert from 'node:assert/strict';
import { test } from 'node:test';

// ST contract line: web/story/contracts.js is the single source of truth for
// the story-recap data shapes (SPEC design/story-recap/SPEC.md §2–§6; the
// sonification demo at the top of design/story-recap/prototype.html is the
// reference implementation behind the song constants below). Every later
// story line (stats, definitions, narrative, soundtrack, player, pages/*,
// poster, shelf, scheduler, lab) imports these names instead of redefining
// them, exactly like the relay v2 precedent in web/relay/contracts.js.
//
// Pinned contract decisions (documented in contracts.js):
// - SPEC §6 storage type stays week|month|year; the data-insufficient 短章
//   is variant:'short' (SHORT_CHAPTER_MIN_EVENTS = 5, SPEC §2).
// - 短章 3 页 = cover → numbers → poster (SPEC §2 fixes the count only).
// - 年书 page count is NOT pinned: SPEC §2 says 18 页 but 月章 10 页型 +
//   6 年度专属 = 16. Year validation pins cover-first/poster-last + the six
//   year types. 待 CTO 裁决 the remaining 2 pages.
// - `no` (章号) is stored so the 120-chapter cap cannot renumber history.

import {
  STORY_STORE_KEY, STORY_STORE_VERSION, MAX_CHAPTERS,
  SHORT_CHAPTER_MIN_EVENTS, CHAPTER_TYPES, CHAPTER_VARIANTS,
  KINDS, KIND_TIMBRE,
  PAGE_TYPES, WEEK_PAGE_ORDER, SHORT_PAGE_ORDER, YEAR_PAGE_TYPES, pageOrderFor,
  WISH_CATEGORIES, WISH_TEXT_MAX, CAPTION_MAX, isQuantifiableWish,
  SONG, MODES, NOTE_VOICES,
  validatePeriod, sanitizeLedgerEntry, validateStatsInput, validateStats,
  validatePage, validatePages, validateWish, sanitizeCaptions,
  validateChapter, createChapter, sanitizeStoreText,
  songSeedFromId, normalizeSongSeed, createRng,
  tempoBpm, modeFor, timbreFor, scaleFor, chordDegreesFor,
  pageSegmentIndex, isOutroSegment,
  validateNoteSequence, melodyPitches, songInputFor,
} from '../../web/story/contracts.js';

// ---------------------------------------------------------------------------
// Fixtures — the numbers deliberately mirror the October prototype chapter.
// ---------------------------------------------------------------------------

const STATS = {
  totals: { events: 86, aiRelays: 23, prevEvents: 77, delta: 9 },
  kindMinutes: [
    { kind: 'create', minutes: 4464, share: 0.31 },
    { kind: 'necessary', minutes: 3168, share: 0.22 },
    { kind: 'connect', minutes: 2592, share: 0.18 },
    { kind: 'explore', minutes: 1872, share: 0.13 },
    { kind: 'restore', minutes: 1584, share: 0.11 },
    { kind: 'stillness', minutes: 720, share: 0.05 },
  ],
  topDay: {
    date: '2026-10-18', events: 9,
    timeline: [
      { time: '08:30', title: '读懂一篇论文', ai: true },
      { time: '10:00', title: '组会', ai: false },
      { time: '22:10', title: '给妈妈打电话', ai: false },
    ],
    warmIndex: 2,
  },
  lessons: {
    learned: [
      { usageId: 'paper-to-points', title: '论文 → 5 个要点', count: 7 },
      { usageId: 'meeting-notes', title: '会议 → 重点和待办', count: 5 },
    ],
    firstGraduation: { date: '2026-10-12', time: '23:00', app: 'deepseek' },
  },
  savedTime: {
    confirmedMinutes: 360,
    allocations: [
      { use: 'restore', minutes: 150 },
      { use: 'connect', minutes: 108 },
      { use: 'explore', minutes: 60 },
      { use: 'stillness', minutes: 42 },
    ],
  },
  rhythm: {
    hourly: Array.from({ length: 24 }, (_, h) => (h >= 21 ? 3 : 1)),
    goldenHour: 22,
    genre: { id: 'night-creator', title: '深夜创作派', tagline: '灯熄了，你的想法才刚开始。' },
  },
  panels: [
    { label: '第 1 周', caption: '开学第一周，论文还没头绪' },
    { label: '第 2 周', caption: '第一次自己用 AI 读完论文' },
    { label: '第 3 周', caption: '最忙的一周，也最常打电话回家' },
    { label: '第 4 周', caption: '开始晨跑，省下的时间有去处了' },
  ],
  keywords: [
    { word: '论文', weight: 9 }, { word: '组会', weight: 7 }, { word: '跑步', weight: 6 },
    { word: '妈妈', weight: 5 }, { word: '实验', weight: 4 }, { word: '火锅', weight: 3 },
  ],
  wishEcho: {
    text: '希望十月能早点睡。',
    reply: '十月你有 11 天在 12 点前结束了最后一件事。',
    matched: true,
    facts: [{ label: '早睡天数', value: '11 天' }],
  },
  song: {
    busyness: 0.62, mood: 0.7, dominantKind: 'create',
    weeklyCounts: [14, 22, 28, 22], graduations: [0, 1, 2, 1],
  },
  year: null, // 年度扩展块（contracts.sanitizeYearStats）：周/月章为 null
};

const RELAY_RECORD = {
  id: '00000001-1111-4111-8111-111111111111',
  at: '2026-10-12T15:00:00.000Z',
  event: '读懂一篇论文',
  usageId: 'paper-to-points',
  result: '五个要点……',
  rating: 'much',
  graduated: true,
  graduatedApp: 'deepseek',
  failed: null,
};

const STATS_INPUT = {
  period: { from: '2026-10-01', to: '2026-10-31' },
  entries: [
    {
      id: 'e1', date: '2026-10-18', start: '08:30', end: '10:00',
      title: '读懂一篇论文', kind: 'explore', done: true,
      ai: { used: true },
      completion: { before: 90, actual: 60, usedAI: true },
    },
    {
      id: 'e2', date: '2026-10-02', start: '21:00', end: '22:00',
      title: '静驻', kind: 'stillness', state: 'kept', kept: 42, use: 'restore',
    },
  ],
  relays: [RELAY_RECORD],
  usages: [{ id: 'meeting-notes', title: '整理会议纪要' }],
  prevChapter: null,
};

const CHAPTER = {
  id: '000010ab-1111-4111-8111-111111111111',
  no: 10,
  type: 'month',
  variant: 'full',
  period: { from: '2026-10-01', to: '2026-10-31' },
  generatedAt: '2026-11-01T01:00:00.000Z',
  stats: STATS,
  pages: PAGE_TYPES.map((type) => ({ type, params: {} })), // normalized page shape
  captions: { 'cover.title': '十月，你把 6 小时还给了自己' },
  wish: {
    text: '想把省下来的时间，多留一点给跑步和妈妈。',
    category: 'exercise',
    at: '2026-11-01T01:05:00.000Z',
  },
  songSeed: 1234567890,
};

// ---------------------------------------------------------------------------
// Storage keys, chapter taxonomy, kinds — SPEC §2/§6.
// ---------------------------------------------------------------------------

test('storage constants pin the SPEC §6 key, version and chapter cap', () => {
  assert.equal(STORY_STORE_KEY, 'tango-donego.story.v1');
  assert.equal(STORY_STORE_VERSION, 1);
  assert.equal(MAX_CHAPTERS, 120); // SPEC §6: 最多 120 章
});

test('chapter taxonomy: week|month|year types, full|short variants, 5-event threshold', () => {
  assert.deepEqual(CHAPTER_TYPES, ['week', 'month', 'year']); // SPEC §6 store schema
  assert.deepEqual(CHAPTER_VARIANTS, ['full', 'short']);
  assert.equal(SHORT_CHAPTER_MIN_EVENTS, 5); // SPEC §2: 本期事项少于 5 件 → 短章
});

test('kinds are the six ledger categories in canonical order', () => {
  // web/index.html KIND_ORDER + prototype page ② 六类别; soundtrack timbre keys.
  assert.deepEqual(KINDS, ['necessary', 'create', 'connect', 'explore', 'restore', 'stillness']);
});

// ---------------------------------------------------------------------------
// Page library — SPEC §2 篇幅 + §3 页面库.
// ---------------------------------------------------------------------------

test('month page library is the 10 prototype pages in order', () => {
  assert.deepEqual(PAGE_TYPES, [
    'cover', 'numbers', 'timeColors', 'specialDay', 'lessons',
    'savedTime', 'rhythm', 'panels', 'wish', 'poster',
  ]);
  assert.equal(PAGE_TYPES.length, 10);
});

test('week/short page orders match SPEC §2 (短章 trio is the pinned contract decision)', () => {
  // 周 SPEC §2: 封面 → 数字 → 时间颜色 → 本周学会 → 海报
  assert.deepEqual(WEEK_PAGE_ORDER, ['cover', 'numbers', 'timeColors', 'lessons', 'poster']);
  assert.equal(WEEK_PAGE_ORDER.length, 5);
  // 短章 SPEC §2 fixes 3 页; contracts pin cover → numbers → poster.
  assert.deepEqual(SHORT_PAGE_ORDER, ['cover', 'numbers', 'poster']);
  assert.equal(SHORT_PAGE_ORDER.length, 3);
});

test('year page types are the six SPEC §2 年度专属 pages', () => {
  assert.deepEqual(YEAR_PAGE_TYPES, [
    'yearSpectrum',     // 12 个月的时间光谱长卷
    'yearFirstLast',    // 年度第一次和最后一次
    'yearStreak',       // 年度最长连续接力
    'yearGenres',       // 年度流派变化史
    'yearKeywords',     // 年度十大关键词
    'yearWall',         // 12 张月度四格拼成的年度墙
  ]);
});

test('pageOrderFor returns canonical orders; year/full is not pinned (待 CTO)', () => {
  assert.deepEqual(pageOrderFor('month', 'full'), PAGE_TYPES);
  assert.deepEqual(pageOrderFor('month'), PAGE_TYPES); // variant defaults to full
  assert.deepEqual(pageOrderFor('week', 'full'), WEEK_PAGE_ORDER);
  assert.deepEqual(pageOrderFor('year', 'short'), SHORT_PAGE_ORDER);
  assert.deepEqual(pageOrderFor('week', 'short'), SHORT_PAGE_ORDER);
  assert.equal(pageOrderFor('year', 'full'), null); // 18 vs 16 页 SPEC gap
  assert.equal(pageOrderFor('daily', 'full'), null);
});

test('validatePages: month must be exactly the 10-page canonical order', () => {
  const pages = PAGE_TYPES.map((type) => ({ type }));
  const ok = validatePages(pages, 'month', 'full');
  assert.equal(ok.length, 10);
  assert.deepEqual(ok.map((p) => p.type), PAGE_TYPES);
  assert.equal(validatePages([...pages.slice(1), pages[0]], 'month', 'full'), null); // rotated
  assert.equal(validatePages(pages.slice(0, 9), 'month', 'full'), null); // missing page
  assert.equal(validatePages(pages, 'month', 'short'), null); // 10 pages ≠ 短章 trio
  assert.equal(validatePages(pages, 'week', 'full'), null); // week is 5 pages
});

test('validatePages: week and short orders; short beats type', () => {
  const week = WEEK_PAGE_ORDER.map((type) => ({ type }));
  assert.equal(validatePages(week, 'week', 'full').length, 5);
  assert.equal(validatePages(week.slice(0, 4), 'week', 'full'), null);
  const short = SHORT_PAGE_ORDER.map((type) => ({ type }));
  assert.equal(validatePages(short, 'month', 'short').length, 3);
  assert.equal(validatePages(short, 'year', 'short').length, 3);
});

test('validatePages: year pins cover-first, poster-last and the six year types, not the count', () => {
  const yearCore = YEAR_PAGE_TYPES.map((type) => ({ type }));
  const year = [
    { type: 'cover' }, { type: 'numbers' },
    ...yearCore,
    { type: 'panels' }, { type: 'poster' },
  ];
  assert.equal(validatePages(year, 'year', 'full').length, 10); // count not pinned, structure is
  assert.equal(validatePages([...yearCore, { type: 'cover' }, { type: 'poster' }], 'year', 'full'), null); // cover must be first
  assert.equal(validatePages([{ type: 'cover' }, ...yearCore, { type: 'numbers' }], 'year', 'full'), null); // poster must be last
  // exactly cover + six year types + poster (8 pages) is the pinned minimum
  assert.equal(validatePages([{ type: 'cover' }, ...yearCore, { type: 'poster' }], 'year', 'full').length, 8);
  assert.equal(validatePages([{ type: 'cover' }, ...yearCore.slice(0, 5), { type: 'poster' }], 'year', 'full'), null); // missing yearWall
  assert.equal(validatePages(year, 'month', 'full'), null); // year types never leak into month
});

test('validatePage whitelists per-type params and rejects unknown ones', () => {
  assert.deepEqual(validatePage({ type: 'cover' }), { type: 'cover', params: {} });
  assert.deepEqual(validatePage({ type: 'cover', params: {} }), { type: 'cover', params: {} });
  assert.deepEqual(
    validatePage({ type: 'specialDay', params: { maxTimeline: 12 } }),
    { type: 'specialDay', params: { maxTimeline: 12 } },
  );
  assert.deepEqual(
    validatePage({ type: 'lessons', params: { limit: 4 } }),
    { type: 'lessons', params: { limit: 4 } },
  );
  assert.equal(validatePage({ type: 'lessons', params: { limit: 0 } }), null);
  assert.equal(validatePage({ type: 'lessons', params: { limit: 9 } }), null);
  assert.equal(validatePage({ type: 'cover', params: { surprise: 1 } }), null); // unknown param
  assert.equal(validatePage({ type: 'hologram' }), null); // unknown page type
  const poster = validatePage({
    type: 'poster',
    params: { metricKeys: ['totals.events', 'totals.aiRelays', 'lessons.learned', 'rhythm.genre'] },
  });
  assert.deepEqual(poster.params.metricKeys.length, 4);
  assert.equal(validatePage({ type: 'poster', params: { metricKeys: ['a', 'b', 'c'] } }), null);
  assert.equal(validatePage({ type: 'poster', params: { metricKeys: ['a', 'b', 'c', 'NÖK'] } }), null);
});

// ---------------------------------------------------------------------------
// Seed & determinism — SPEC §4 种子固定 + D3 unit proof hooks.
// ---------------------------------------------------------------------------

test('songSeedFromId is deterministic, seed-normalized to uint32', () => {
  const a = songSeedFromId(CHAPTER.id);
  assert.equal(typeof a, 'number');
  assert.equal(Math.floor(a), a);
  assert.ok(a >= 0 && a <= 4294967295);
  assert.equal(songSeedFromId(CHAPTER.id), a); // same id → same seed forever
  const b = songSeedFromId('000010ab-1111-4111-8111-111111111112');
  assert.notEqual(a, b);
  assert.equal(normalizeSongSeed(a), a);
  assert.equal(normalizeSongSeed(0), 0);
  assert.equal(normalizeSongSeed(4294967295), 4294967295);
  assert.equal(normalizeSongSeed(4294967296), null);
  assert.equal(normalizeSongSeed(-1), null);
  assert.equal(normalizeSongSeed(1.5), null);
  assert.equal(normalizeSongSeed('42'), null);
});

test('createRng: same seed → same sequence; no Math.random (D3 determinism pin)', () => {
  const first = createRng(42);
  const again = createRng(42);
  const seqA = [first(), first(), first(), first(), first()];
  const seqB = [again(), again(), again(), again(), again()];
  assert.deepEqual(seqA, seqB);
  seqA.forEach((v) => assert.ok(v >= 0 && v < 1));
  const other = createRng(43);
  const seqC = [other(), other(), other(), other(), other()];
  assert.notDeepEqual(seqA, seqC);
  // a chapter-id string is hashed to the same seed every time; junk seeds are rejected
  assert.equal(createRng(-1), null);
  assert.equal(createRng(1.5), null);
  const idA = createRng(CHAPTER.id);
  const idB = createRng(CHAPTER.id);
  assert.equal(idA(), idB());
  assert.notEqual(idA(), createRng(CHAPTER.id.replace('0', '1'))());
});

// ---------------------------------------------------------------------------
// Song mapping pins — SPEC §4 + prototype reference implementation.
// ---------------------------------------------------------------------------

test('SONG constants pin the SPEC §4 structure (intro, volume cap, root)', () => {
  assert.equal(SONG.INTRO_BARS, 4);        // SPEC §4: 前奏 4 小节 pad
  assert.equal(SONG.VOLUME_MAX, 0.25);     // SPEC §4: 音量上限 0.25
  assert.equal(SONG.ROOT_MIDI, 57);        // prototype: A3
  assert.equal(SONG.OUTRO_PAGE, 'poster'); // SPEC §4: 结尾在海报页回主和弦淡出
  assert.equal(SONG.BPM_BASE, 64);
  assert.equal(SONG.BPM_SPAN, 40);
  assert.equal(SONG.MOOD_MAJOR_THRESHOLD, 0.5);
  assert.deepEqual(MODES, ['major', 'minor']);
});

test('tempoBpm = 64 + busyness × 40 (SPEC §4), invalid input rejected', () => {
  assert.equal(tempoBpm(0), 64);
  assert.equal(tempoBpm(1), 104);
  assert.equal(tempoBpm(0.62), 64 + 0.62 * 40);
  assert.equal(tempoBpm(1.001), null);
  assert.equal(tempoBpm(-0.001), null);
  assert.equal(tempoBpm(Number.NaN), null);
  assert.equal(tempoBpm('busy'), null);
});

test('modeFor: mood ≥ 0.5 major, else minor (SPEC §4); timbres per prototype KIND_TIMBRE', () => {
  assert.equal(modeFor(0.5), 'major'); // boundary is major, per SPEC ≥ 0.5
  assert.equal(modeFor(0.7), 'major');
  assert.equal(modeFor(0.49), 'minor');
  assert.equal(modeFor(0), 'minor');
  assert.equal(modeFor(1.2), null);
  assert.deepEqual(KIND_TIMBRE, {
    create: 'triangle', necessary: 'sine', connect: 'sawtooth',
    explore: 'square', restore: 'sine', stillness: 'sine',
  });
  KINDS.forEach((kind) => assert.equal(typeof timbreFor(kind), 'string'));
  assert.equal(timbreFor('nonsense'), 'sine'); // defensive fallback, never throws
});

test('scales and chord degrees match the prototype arrays (I–vi–IV–V / i–III–v–iv)', () => {
  assert.deepEqual(scaleFor('major'), [0, 2, 4, 7, 9, 12, 14, 16]);
  assert.deepEqual(scaleFor('minor'), [0, 2, 3, 7, 8, 12, 14, 15]);
  assert.deepEqual(chordDegreesFor('major'), [0, 5, 3, 4]);
  assert.deepEqual(chordDegreesFor('minor'), [0, 3, 5, 4]);
  assert.equal(scaleFor('dorian'), null);
  assert.equal(chordDegreesFor('dorian'), null);
});

test('segment structure: page i → segment i, outro on the poster page only', () => {
  assert.equal(pageSegmentIndex(0), 0);
  assert.equal(pageSegmentIndex(3), 3);
  assert.equal(pageSegmentIndex(9), 9);
  assert.equal(pageSegmentIndex(-1), null);
  assert.equal(pageSegmentIndex(1.5), null);
  assert.equal(isOutroSegment(9, 10), true);
  assert.equal(isOutroSegment(8, 10), false);
  assert.equal(isOutroSegment(-1, 10), false);
});

// ---------------------------------------------------------------------------
// Note events — the poster waveform ↔ soundtrack melody contract (SPEC §4).
// ---------------------------------------------------------------------------

test('note sequence validation and melody pitch extraction for the poster waveform', () => {
  assert.deepEqual(NOTE_VOICES, ['pad', 'lead', 'chime']);
  const notes = [
    { midi: 69, at: 0, dur: 1, voice: 'lead' },
    { midi: 45, at: 0.5, dur: 8, voice: 'pad' },
    { midi: 76, at: 2, dur: 1, voice: 'chime' },
    { midi: 72, at: 1, dur: 0.5, voice: 'lead' },
  ];
  assert.equal(validateNoteSequence(notes).length, 4);
  // 海报波形 = 主旋律音高序列: lead + chime, pad excluded, ordered by time.
  assert.deepEqual(melodyPitches(notes), [69, 72, 76]);
  assert.deepEqual(melodyPitches([]), []);
  assert.equal(validateNoteSequence([{ midi: 128, at: 0, dur: 1, voice: 'lead' }]), null);
  assert.equal(validateNoteSequence([{ midi: 69, at: 0, dur: 0, voice: 'lead' }]), null);
  assert.equal(validateNoteSequence([{ midi: 69, at: -1, dur: 1, voice: 'lead' }]), null);
  assert.equal(validateNoteSequence([{ midi: 69, at: 0, dur: 1, voice: 'bass' }]), null);
  assert.equal(melodyPitches('not a list'), null);
});

test('songInputFor assembles exactly the SPEC §4 soundtrack input', () => {
  assert.deepEqual(songInputFor(CHAPTER), {
    busyness: 0.62, mood: 0.7, dominantKind: 'create',
    weeklyCounts: [14, 22, 28, 22], graduations: [0, 1, 2, 1],
    chapterSeed: 1234567890,
  });
  assert.equal(songInputFor({ type: 'month' }), null);
  assert.equal(songInputFor(null), null);
});

// ---------------------------------------------------------------------------
// Period, stats input, ledger entries.
// ---------------------------------------------------------------------------

test('validatePeriod: ISO day strings, from ≤ to', () => {
  assert.deepEqual(validatePeriod({ from: '2026-10-01', to: '2026-10-31' }), { from: '2026-10-01', to: '2026-10-31' });
  assert.deepEqual(validatePeriod({ from: '2026-10-01', to: '2026-10-01' }), { from: '2026-10-01', to: '2026-10-01' });
  assert.equal(validatePeriod({ from: '2026-10-31', to: '2026-10-01' }), null);
  assert.equal(validatePeriod({ from: '2026-10-1', to: '2026-10-31' }), null); // not zero-padded
  assert.equal(validatePeriod({ from: '2026-13-01', to: '2026-13-31' }), null); // month 13
  assert.equal(validatePeriod({ from: '2026-10-01' }), null);
});

test('sanitizeLedgerEntry whitelists the ledger shape incl. stillness accounting', () => {
  const entry = sanitizeLedgerEntry(STATS_INPUT.entries[0]);
  assert.deepEqual(entry, {
    id: 'e1', date: '2026-10-18', start: '08:30', end: '10:00',
    title: '读懂一篇论文', kind: 'explore', done: true, ai: { used: true },
    completion: { before: 90, actual: 60, usedAI: true },
  });
  const stillness = sanitizeLedgerEntry(STATS_INPUT.entries[1]);
  assert.equal(stillness.state, 'kept');
  assert.equal(stillness.kept, 42);
  assert.equal(stillness.use, 'restore');
  assert.equal(sanitizeLedgerEntry({ ...STATS_INPUT.entries[0], kind: 'chaos' }), null);
  assert.equal(sanitizeLedgerEntry({ ...STATS_INPUT.entries[0], date: '10/18' }), null);
  assert.equal(sanitizeLedgerEntry({ ...STATS_INPUT.entries[0], start: '8:30' }), null);
  assert.equal(sanitizeLedgerEntry({ ...STATS_INPUT.entries[0], end: '24:30' }), null);
  assert.equal(sanitizeLedgerEntry({ ...STATS_INPUT.entries[0], title: '   ' }), null);
  // 24:00 is a legal ledger end time (web/index.html isHM).
  assert.ok(sanitizeLedgerEntry({ ...STATS_INPUT.entries[0], end: '24:00' }));
});

test('validateStatsInput: period + sanitized entries + relay-record relays + usages', () => {
  const input = validateStatsInput(STATS_INPUT);
  assert.deepEqual(input.period, { from: '2026-10-01', to: '2026-10-31' });
  assert.equal(input.entries.length, 2);
  assert.equal(input.entries[0].ai.used, true);
  // relays pass through the relay v2 contract sanitizer, not a story redefinition
  assert.equal(input.relays.length, 1);
  assert.equal(input.relays[0].usageId, 'paper-to-points');
  assert.equal(input.relays[0].rating, 'much');
  assert.deepEqual(input.usages, [{ id: 'meeting-notes', title: '整理会议纪要' }]);
  assert.equal(input.prevChapter, null);
  // invalid rows are dropped, never fatal; an invalid period is fatal
  const dirty = validateStatsInput({
    ...STATS_INPUT,
    entries: [...STATS_INPUT.entries, { id: 'bad', date: 'nope' }],
    relays: [...STATS_INPUT.relays, { id: 'not-a-uuid' }],
  });
  assert.equal(dirty.entries.length, 2);
  assert.equal(dirty.relays.length, 1);
  assert.equal(validateStatsInput({ ...STATS_INPUT, period: { from: 'x' } }), null);
  assert.equal(validateStatsInput(null), null);
});

// ---------------------------------------------------------------------------
// Stats output schema — SPEC §3 page data + §4 song inputs.
// ---------------------------------------------------------------------------

test('validateStats round-trips the October fixture (whitelist, no coercion)', () => {
  const stats = validateStats(STATS);
  assert.deepEqual(stats, STATS);
  // unknown keys are dropped by the whitelist, never echoed back
  assert.deepEqual(validateStats({ ...STATS, extra: 1 }), STATS);
});

test('validateStats rejects bad totals, kinds, topDay, lessons', () => {
  assert.equal(validateStats({ ...STATS, totals: { events: -1, aiRelays: 0 } }), null);
  assert.equal(validateStats({ ...STATS, totals: { events: 1.5, aiRelays: 0 } }), null);
  assert.equal(validateStats({ ...STATS, totals: { events: '86', aiRelays: 0 } }), null);
  assert.equal(validateStats({ ...STATS, kindMinutes: STATS.kindMinutes.slice(0, 5) }), null); // must be all 6
  const dupKind = STATS.kindMinutes.map((row, i) => (i === 1 ? { ...row, kind: 'create' } : row));
  assert.equal(validateStats({ ...STATS, kindMinutes: dupKind }), null); // duplicate kind
  assert.equal(validateStats({ ...STATS, kindMinutes: STATS.kindMinutes.map((row, i) => (i === 0 ? { ...row, share: 1.2 } : row)) }), null);
  assert.equal(validateStats({ ...STATS, topDay: { ...STATS.topDay, timeline: [{ time: '9:00', title: '组会', ai: false }] } }), null);
  assert.equal(validateStats({ ...STATS, topDay: { ...STATS.topDay, warmIndex: 3 } }), null); // out of timeline range
  assert.equal(validateStats({ ...STATS, lessons: { ...STATS.lessons, firstGraduation: { date: '2026-10-12', time: '23:00', app: 'DeepSeek!' } } }), null);
  // nullable blocks stay nullable (zero-data / first-chapter cases)
  assert.ok(validateStats({ ...STATS, topDay: null }));
  assert.ok(validateStats({ ...STATS, lessons: { learned: [], firstGraduation: null } }));
  assert.ok(validateStats({ ...STATS, totals: { events: 0, aiRelays: 0, prevEvents: null, delta: null } }));
});

test('validateStats rejects bad rhythm, panels, keywords, wishEcho, song', () => {
  assert.equal(validateStats({ ...STATS, rhythm: { ...STATS.rhythm, hourly: new Array(23).fill(1) } }), null);
  assert.equal(validateStats({ ...STATS, rhythm: { ...STATS.rhythm, goldenHour: 24 } }), null);
  assert.equal(validateStats({ ...STATS, rhythm: { ...STATS.rhythm, genre: { id: 'Night!', title: 'x', tagline: '' } } }), null);
  assert.equal(validateStats({ ...STATS, panels: [{ label: '第 1 周', caption: '' }] }), null); // caption required (templates always exist)
  assert.equal(validateStats({ ...STATS, panels: STATS.panels.map((p, i) => (i === 0 ? { ...p, caption: '一'.repeat(25) } : p)) }), null); // SPEC §5 ≤ 24 字
  assert.equal(validateStats({ ...STATS, keywords: [{ word: '', weight: 1 }] }), null);
  assert.equal(validateStats({ ...STATS, wishEcho: { text: 'x', reply: 'y', matched: 'yes' } }), null);
  // song block: SPEC §4 inputs live inside stats, strictly bounded
  const withSong = (song) => validateStats({ ...STATS, song });
  assert.equal(withSong({ ...STATS.song, busyness: 1.2 }), null);
  assert.equal(withSong({ ...STATS.song, mood: -0.1 }), null);
  assert.equal(withSong({ ...STATS.song, dominantKind: 'chaos' }), null);
  assert.equal(withSong({ ...STATS.song, weeklyCounts: [] }), null);
  assert.equal(withSong({ ...STATS.song, weeklyCounts: [1, 2], graduations: [0] }), null); // lengths must match
  assert.ok(withSong({ ...STATS.song, weeklyCounts: [0], graduations: [0] })); // zero-data week is legal
});

// ---------------------------------------------------------------------------
// Wish — SPEC §3 page ⑧ + §1 连载感.
// ---------------------------------------------------------------------------

test('wish categories: quantifiable 早睡/运动/学习/陪伴 vs 温柔复述 other', () => {
  assert.deepEqual(WISH_CATEGORIES, ['sleep', 'exercise', 'learning', 'company', 'other']);
  assert.equal(isQuantifiableWish('sleep'), true);
  assert.equal(isQuantifiableWish('exercise'), true);
  assert.equal(isQuantifiableWish('learning'), true);
  assert.equal(isQuantifiableWish('company'), true);
  assert.equal(isQuantifiableWish('other'), false);
  assert.equal(isQuantifiableWish('nap'), false);
});

test('validateWish: text cap truncates, category enum is strict, at is ISO', () => {
  assert.equal(WISH_TEXT_MAX, 60);
  assert.deepEqual(
    validateWish({ text: '希望下个月早点睡。', category: 'sleep', at: '2026-11-01T01:05:00.000Z' }),
    { text: '希望下个月早点睡。', category: 'sleep', at: '2026-11-01T01:05:00.000Z' },
  );
  assert.deepEqual(validateWish({ text: '想把省下来的时间，多留一点给跑步和妈妈。' }), {
    text: '想把省下来的时间，多留一点给跑步和妈妈。', category: null, at: null,
  });
  // over-cap text is truncated like relay's editable text fields, never rejected
  const long = validateWish({ text: '好'.repeat(65), category: 'other' });
  assert.equal(long.text.length, WISH_TEXT_MAX);
  assert.equal(validateWish({ text: '   ' }), null);
  assert.equal(validateWish({ text: 'x', category: 'naps' }), null);
  assert.equal(validateWish({ text: 'x', category: 'sleep', at: 'yesterday' }), null);
});

test('sanitizeCaptions: key pattern, value cap, at most 32 keys', () => {
  assert.equal(CAPTION_MAX, 60);
  assert.deepEqual(sanitizeCaptions({ 'cover.title': '十月，你把 6 小时还给了自己' }), { 'cover.title': '十月，你把 6 小时还给了自己' });
  assert.deepEqual(sanitizeCaptions({ 'panel-1': 'x', ' bad key ': 'y' }), { 'panel-1': 'x' });
  assert.deepEqual(sanitizeCaptions({ k: 'a'.repeat(80) }), { k: 'a'.repeat(CAPTION_MAX) });
  assert.deepEqual(sanitizeCaptions(null), {});
  const many = {};
  for (let i = 0; i < 40; i += 1) many['k' + i] = 'v';
  assert.equal(Object.keys(sanitizeCaptions(many)).length, 32);
});

// ---------------------------------------------------------------------------
// Chapter: validate, create, store text — SPEC §6.
// ---------------------------------------------------------------------------

test('validateChapter round-trips the fixture and drops unknown fields', () => {
  const chapter = validateChapter(CHAPTER);
  assert.deepEqual(chapter, CHAPTER);
  // unknown fields are dropped by the whitelist; invalid stats kills the chapter
  assert.deepEqual(validateChapter({ ...CHAPTER, hacker: true }), CHAPTER);
  assert.equal(validateChapter({ ...CHAPTER, stats: { ...STATS, song: { ...STATS.song, busyness: 9 } } }), null);
  assert.equal(validateChapter({ ...CHAPTER, id: 'not-a-uuid' }), null);
  assert.equal(validateChapter({ ...CHAPTER, no: 0 }), null);
  assert.equal(validateChapter({ ...CHAPTER, type: 'daily' }), null);
  assert.equal(validateChapter({ ...CHAPTER, period: { from: '2026-10-31', to: '2026-10-01' } }), null);
  assert.equal(validateChapter({ ...CHAPTER, generatedAt: 'once upon a time' }), null);
  assert.equal(validateChapter({ ...CHAPTER, songSeed: -5 }), null);
  // variant may be omitted (defaults to full); wish may be null before page ⑧ saves one
  const noVariant = validateChapter((({ variant, ...rest }) => rest)(CHAPTER));
  assert.equal(noVariant.variant, 'full');
  assert.ok(validateChapter({ ...CHAPTER, wish: null }));
  assert.ok(validateChapter({ ...CHAPTER, captions: null }));
});

test('createChapter fills id/no/time/seed deterministically and round-trips', () => {
  const chapter = createChapter(
    { type: 'week', no: 3, period: { from: '2026-10-19', to: '2026-10-25' }, stats: STATS },
    { uuid: CHAPTER.id, now: Date.parse('2026-10-25T20:00:00Z') },
  );
  assert.ok(chapter);
  assert.equal(chapter.id, CHAPTER.id);
  assert.equal(chapter.variant, 'full');
  assert.equal(chapter.generatedAt, '2026-10-25T20:00:00.000Z');
  assert.equal(chapter.songSeed, songSeedFromId(CHAPTER.id)); // deterministic, never Math.random
  assert.deepEqual(chapter.pages.map((p) => p.type), WEEK_PAGE_ORDER); // pages default to canonical order
  assert.deepEqual(chapter.captions, {});
  assert.equal(chapter.wish, null);
  assert.equal(validateChapter(chapter).id, chapter.id); // factory output validates
  // year/full has no default order (SPEC 18 vs 16 gap) and no 章号 → both fail loudly
  assert.equal(createChapter({ type: 'year', period: CHAPTER.period, stats: STATS }), null);
  assert.equal(createChapter({ type: 'month', period: CHAPTER.period, stats: STATS }), null); // missing no
  assert.equal(createChapter({ type: 'month', no: 2, period: CHAPTER.period, stats: { } }), null); // invalid stats
  const seeded = createChapter(
    { type: 'month', no: 2, period: CHAPTER.period, stats: STATS },
    { songSeed: 4294967296 },
  );
  assert.equal(seeded, null); // out-of-range explicit seed is rejected
});

test('sanitizeStoreText: empty/ok/unknown, invalid chapters dropped, newest 120 kept', () => {
  const empty = sanitizeStoreText(null);
  assert.equal(empty.status, 'empty');
  assert.deepEqual(empty.store, { v: 1, chapters: [] });
  const ok = sanitizeStoreText(JSON.stringify({ v: 1, chapters: [CHAPTER] }));
  assert.equal(ok.status, 'ok');
  assert.equal(ok.store.chapters.length, 1);
  assert.equal(ok.store.chapters[0].id, CHAPTER.id);
  const dirty = sanitizeStoreText(JSON.stringify({ v: 1, chapters: [CHAPTER, { type: 'month' }] }));
  assert.equal(dirty.status, 'ok');
  assert.equal(dirty.store.chapters.length, 1); // junk row dropped, store survives
  assert.equal(sanitizeStoreText('{oops').status, 'unknown'); // unreadable JSON
  assert.equal(sanitizeStoreText(JSON.stringify({ v: 2, chapters: [] })).status, 'unknown'); // unknown version → quarantine, never overwrite
  // 130 generated chapters → the oldest 10 are pruned, numbering survives via `no`
  const many = [];
  for (let i = 1; i <= 130; i += 1) {
    many.push(createChapter(
      { type: 'week', no: i, period: { from: '2026-01-05', to: '2026-01-11' }, stats: STATS },
      { uuid: String(i).padStart(8, '0') + '-1111-4111-8111-111111111111', now: Date.parse('2026-10-25T20:00:00Z') },
    ));
  }
  const capped = sanitizeStoreText(JSON.stringify({ v: 1, chapters: many }));
  assert.equal(capped.status, 'ok');
  assert.equal(capped.store.chapters.length, MAX_CHAPTERS);
  assert.equal(capped.store.chapters[0].no, 11);  // chapters 1–10 dropped
  assert.equal(capped.store.chapters[119].no, 130);
});
