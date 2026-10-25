import assert from 'node:assert/strict';
import { test } from 'node:test';

// T7 海报书架线 — 书架部分的定向单测。
// SPEC design/story-recap/SPEC.md §2: 书架在「我的用法」里，按时间排列所有
// 章节（封面缩略图），可以重看、重播、导出海报；§8 每指标有 unit。
// 封面视觉基准 = 原型 p0 的 book 卡（品牌橙 #E95432→#B8401F、书脊、书签纹）。

import { createChapter, YEAR_PAGE_TYPES } from '../../web/story/contracts.js';
import {
  SHELF_ACTIONS, chapterTypeLabel, COVER_THEMES,
  sortChapters, chaptersFromStore, shelfModel,
} from '../../web/story/shelf.js';

// ---------------------------------------------------------------------------
// Fixtures — 十月章数字沿用契约测试；另造周记/年书/短章做排序与覆盖。
// ---------------------------------------------------------------------------
const BASE_STATS = {
  totals: { events: 86, aiRelays: 23, prevEvents: 77, delta: 9 },
  kindMinutes: [
    { kind: 'create', minutes: 4464, share: 0.31 },
    { kind: 'necessary', minutes: 3168, share: 0.22 },
    { kind: 'connect', minutes: 2592, share: 0.18 },
    { kind: 'explore', minutes: 1872, share: 0.13 },
    { kind: 'restore', minutes: 1584, share: 0.11 },
    { kind: 'stillness', minutes: 720, share: 0.05 },
  ],
  topDay: null,
  lessons: { learned: [], firstGraduation: null },
  savedTime: { confirmedMinutes: 360, allocations: [] },
  rhythm: {
    hourly: Array.from({ length: 24 }, () => 1),
    goldenHour: null,
    genre: { id: 'night-creator', title: '深夜创作派', tagline: '灯熄了，你的想法才刚开始。' },
  },
  panels: [{ label: '第 1 周', caption: '开学第一周，论文还没头绪' }],
  keywords: [{ word: '论文', weight: 9 }],
  wishEcho: null,
  song: {
    busyness: 0.62, mood: 0.7, dominantKind: 'create',
    weeklyCounts: [14, 22, 28, 22], graduations: [0, 1, 2, 1],
  },
};

// year/full 无默认页序（契约决定），年书章节必须显式给 pages。
const YEAR_PAGES = [{ type: 'cover' }]
  .concat(YEAR_PAGE_TYPES.map((t) => ({ type: t })))
  .concat([{ type: 'poster' }]);

function chapter(no, type, from, to, extra) {
  const fields = Object.assign({
    no, type, period: { from, to }, stats: BASE_STATS,
  }, extra || {});
  if (type === 'year' && fields.pages == null) fields.pages = YEAR_PAGES;
  return createChapter(fields, {
    uuid: `00000000-0000-4000-8000-${String(no).padStart(12, '0')}`,
    now: Date.parse('2026-11-01T01:00:00Z'),
    songSeed: 42,
  });
}

const OCTOBER = chapter(10, 'month', '2026-10-01', '2026-10-31');
const WEEK_LATE = chapter(11, 'week', '2026-10-19', '2026-10-25');
const YEAR_2025 = chapter(3, 'year', '2025-01-01', '2025-12-31');
const WEEK_EARLY = chapter(9, 'week', '2026-09-14', '2026-09-20');
const SHORT_NOV = chapter(12, 'month', '2026-11-01', '2026-11-30', { variant: 'short' });

// ---------------------------------------------------------------------------
// 类型与主题。
// ---------------------------------------------------------------------------
test('chapterTypeLabel: SPEC §2 命名 周记/月章/年书；未知类型 → null', () => {
  assert.equal(chapterTypeLabel('week'), '周记');
  assert.equal(chapterTypeLabel('month'), '月章');
  assert.equal(chapterTypeLabel('year'), '年书');
  assert.equal(chapterTypeLabel('daily'), null);
  assert.equal(chapterTypeLabel(null), null);
});

test('COVER_THEMES: three types, #rrggbb pairs, month = prototype book orange', () => {
  assert.deepEqual(Object.keys(COVER_THEMES).sort(), ['month', 'week', 'year']);
  const hex = /^#[0-9a-f]{6}$/i;
  for (const t of Object.keys(COVER_THEMES)) {
    assert.match(COVER_THEMES[t].from, hex);
    assert.match(COVER_THEMES[t].to, hex);
    assert.match(COVER_THEMES[t].ink, hex);
  }
  assert.equal(COVER_THEMES.month.from.toUpperCase(), '#E95432');
  assert.equal(COVER_THEMES.month.to.toUpperCase(), '#B8401F');
});

// ---------------------------------------------------------------------------
// 排序 — SPEC §2 按时间排列；契约注释「书架按时间排列保新」→ 新章在前。
// ---------------------------------------------------------------------------
test('sortChapters: newest period.from first; tie-break by no desc, then id', () => {
  const sorted = sortChapters([YEAR_2025, WEEK_EARLY, OCTOBER, WEEK_LATE]);
  assert.deepEqual(sorted.map((c) => c.no), [11, 10, 9, 3]);
  const tieA = chapter(5, 'week', '2026-10-19', '2026-10-25');
  const tieB = chapter(6, 'week', '2026-10-19', '2026-10-25');
  assert.deepEqual(sortChapters([tieA, tieB]).map((c) => c.no), [6, 5]);
});

test('sortChapters: drops invalid entries, does not mutate input', () => {
  const input = [OCTOBER, { no: 1 }, null, WEEK_LATE];
  const sorted = sortChapters(input);
  assert.deepEqual(sorted.map((c) => c.no), [11, 10]);
  assert.equal(input.length, 4);
  assert.notEqual(sorted, input);
  assert.deepEqual(sortChapters([]), []);
  assert.deepEqual(sortChapters('nope'), []);
});

// ---------------------------------------------------------------------------
// 存储读取 — contracts.sanitizeStoreText 的书架视图。
// ---------------------------------------------------------------------------
test('chaptersFromStore: sorts valid chapters, prunes nothing here, garbage → unknown', () => {
  const text = JSON.stringify({ v: 1, chapters: [WEEK_EARLY, OCTOBER] });
  const res = chaptersFromStore(text);
  assert.equal(res.status, 'ok');
  assert.deepEqual(res.chapters.map((c) => c.no), [10, 9]);
  assert.equal(chaptersFromStore('not json').status, 'unknown');
  assert.deepEqual(chaptersFromStore('not json').chapters, []);
  assert.equal(chaptersFromStore(null).status, 'empty');
  assert.deepEqual(chaptersFromStore(null).chapters, []);
});

// ---------------------------------------------------------------------------
// 书架模型 — 封面缩略图 = 章号/类型/标题/期间/统计行 + 主题色。
// ---------------------------------------------------------------------------
test('shelfModel: cover items in prototype shape, newest first', () => {
  const model = shelfModel([YEAR_2025, OCTOBER, WEEK_LATE]);
  assert.equal(model.empty, false);
  assert.equal(model.count, 3);
  const [first, second, third] = model.items;
  assert.equal(first.no, 11);
  assert.equal(first.typeLabel, '周记');
  assert.equal(first.isShort, false);
  assert.equal(first.periodRange, '2026.10.19 — 10.25');
  assert.equal(first.statsLine, '86 件事 · 23 次 AI 接力');
  assert.equal(first.theme.from.toUpperCase(), '#E8B04B');
  // 封面标题用第二人称（原型 p0「十月，你把 6 小时还给了自己」）
  assert.equal(second.title, '十月，你把 6 小时还给了自己');
  assert.equal(second.typeLabel, '月章');
  assert.equal(third.no, 3);
  assert.equal(third.typeLabel, '年书');
  assert.equal(third.title, '2025 年，你把 6 小时还给了自己');
});

test('shelfModel: short variant is flagged and labelled; title override by id wins', () => {
  const model = shelfModel([SHORT_NOV, OCTOBER]);
  const short = model.items[0];
  assert.equal(short.isShort, true);
  assert.equal(short.typeLabel, '月章 · 短章');
  const edited = shelfModel([OCTOBER], { titles: { [OCTOBER.id]: '我改过的十月' } });
  assert.equal(edited.items[0].title, '我改过的十月');
});

test('shelfModel: empty shelf is a model, not an error; invalid entries dropped', () => {
  const model = shelfModel([]);
  assert.equal(model.empty, true);
  assert.deepEqual(model.items, []);
  assert.equal(model.count, 0);
  const dirty = shelfModel([{ no: 1 }, OCTOBER]);
  assert.equal(dirty.count, 1);
  assert.equal(dirty.items[0].no, 10);
});

test('shelfModel carries the validated chapter for actions (重看/重播/导出海报)', () => {
  const model = shelfModel([OCTOBER]);
  assert.equal(model.items[0].chapter.id, OCTOBER.id);
  assert.equal(model.items[0].chapter.no, 10);
});

test('SHELF_ACTIONS pins the three SPEC §2 shelf actions', () => {
  assert.deepEqual(SHELF_ACTIONS, ['open', 'replay', 'export']);
});
