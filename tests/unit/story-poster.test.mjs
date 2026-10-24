import assert from 'node:assert/strict';
import { test } from 'node:test';

// T7 海报书架线 — poster 部分的定向单测。
// SPEC design/story-recap/SPEC.md §3 ⑨（海报：标题、4 个数字、流派、时间之歌
// 波形、二维码；导出 1080×1920 PNG）、§4（海报波形 = 主旋律音高序列）、
// §8（导出 PNG 尺寸准确、中文字体无缺字、导出前等 document.fonts.ready）。
// 原型 design/story-recap/prototype.html p9 是视觉基准；数字故意沿用
// story-contracts.test.mjs 的十月章 fixture。

import {
  PAGE_TYPES, CAPTION_MAX, createChapter, melodyPitches,
} from '../../web/story/contracts.js';
import {
  POSTER_SIZE, DEFAULT_METRIC_KEYS,
  periodLabel, formatPeriodRange,
  metricKeysFor, resolveMetric, posterTitle,
  waveformBars, qrMatrix, qrCodewords,
  wrapTitleLines, fitText,
  posterLayout, posterModel, posterFilename,
} from '../../web/story/poster.js';

// ---------------------------------------------------------------------------
// Fixtures — 十月章（数字与原型/契约测试一致）。
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
};

function october(overrides) {
  const fields = Object.assign({
    no: 10, type: 'month',
    period: { from: '2026-10-01', to: '2026-10-31' },
    stats: STATS,
  }, overrides || {});
  return createChapter(fields, {
    uuid: '00000000-0000-4000-8000-00000000000a',
    now: Date.parse('2026-11-01T01:00:00Z'),
    songSeed: 123456789,
  });
}

// ---------------------------------------------------------------------------
// 尺寸与常量 — SPEC §8: 导出的 PNG 尺寸准确。
// ---------------------------------------------------------------------------
test('POSTER_SIZE is exactly 1080×1920 (SPEC §3 ⑨ / §8)', () => {
  assert.deepEqual(POSTER_SIZE, { width: 1080, height: 1920 });
});

test('DEFAULT_METRIC_KEYS has exactly 4 keys matching the prototype p9 grid', () => {
  assert.equal(DEFAULT_METRIC_KEYS.length, 4);
  assert.equal(DEFAULT_METRIC_KEYS[0], 'totals.events');
  assert.equal(DEFAULT_METRIC_KEYS[1], 'totals.aiRelays');
  assert.equal(DEFAULT_METRIC_KEYS[2], 'lessons.learned');
  assert.equal(DEFAULT_METRIC_KEYS[3], 'rhythm.genre');
});

// ---------------------------------------------------------------------------
// 期间文案 — 原型 p0「2026.10.01 — 10.31」、p9 标题里的「十月」。
// ---------------------------------------------------------------------------
test('periodLabel: month → 十月, year → 2026 年, week → M.D–M.D', () => {
  assert.equal(periodLabel({ from: '2026-10-01', to: '2026-10-31' }, 'month'), '十月');
  assert.equal(periodLabel({ from: '2025-11-30', to: '2025-12-06' }, 'month'), '十一月');
  assert.equal(periodLabel({ from: '2025-12-01', to: '2025-12-31' }, 'month'), '十二月');
  assert.equal(periodLabel({ from: '2026-01-01', to: '2026-12-31' }, 'year'), '2026 年');
  assert.equal(periodLabel({ from: '2026-10-19', to: '2026-10-25' }, 'week'), '10.19–10.25');
  assert.equal(periodLabel({ from: '2026-11-30', to: '2026-12-06' }, 'week'), '11.30–12.06');
});

test('periodLabel rejects invalid input instead of guessing', () => {
  assert.equal(periodLabel({ from: '2026-10-01', to: '2026-10-31' }, 'daily'), null);
  assert.equal(periodLabel({ from: '2026-10-31', to: '2026-10-01' }, 'month'), null);
  assert.equal(periodLabel(null, 'month'), null);
});

test('formatPeriodRange: same year omits the second year, cross-year keeps both', () => {
  assert.equal(formatPeriodRange({ from: '2026-10-01', to: '2026-10-31' }), '2026.10.01 — 10.31');
  assert.equal(formatPeriodRange({ from: '2025-12-28', to: '2026-01-04' }), '2025.12.28 — 2026.01.04');
  assert.equal(formatPeriodRange({ from: '2026-10-19', to: '2026-10-19' }), '2026.10.19');
  assert.equal(formatPeriodRange({ from: 'bad', to: '2026-10-31' }), null);
});

// ---------------------------------------------------------------------------
// 指标解析 — SPEC §3 ⑨ 4 个数字；口径卡与数据一一对应（红线 4）。
// ---------------------------------------------------------------------------
test('resolveMetric maps the prototype four from October stats', () => {
  assert.deepEqual(resolveMetric('totals.events', STATS), { value: '86', label: '件事' });
  assert.deepEqual(resolveMetric('totals.aiRelays', STATS), { value: '23', label: '次 AI 接力' });
  assert.deepEqual(resolveMetric('lessons.learned', STATS), { value: '2', label: '个新用法' });
  assert.deepEqual(resolveMetric('rhythm.genre', STATS), { value: '深夜创作派', label: '时间流派' });
});

test('resolveMetric: confirmed saved time only, fractional hours kept honest', () => {
  assert.deepEqual(resolveMetric('savedTime.confirmed', STATS), { value: '6', label: '小时 · 已确认省下' });
  const ninety = JSON.parse(JSON.stringify(STATS));
  ninety.savedTime.confirmedMinutes = 90;
  assert.deepEqual(resolveMetric('savedTime.confirmed', ninety), { value: '1.5', label: '小时 · 已确认省下' });
});

test('resolveMetric: genre missing → placeholder, unknown key → null', () => {
  const noGenre = JSON.parse(JSON.stringify(STATS));
  noGenre.rhythm.genre = null;
  assert.deepEqual(resolveMetric('rhythm.genre', noGenre), { value: '—', label: '时间流派' });
  assert.equal(resolveMetric('totals.nonsense', STATS), null);
  assert.equal(resolveMetric('totals.events', null), null);
});

test('metricKeysFor: poster page params win, otherwise defaults, invalid chapter → null', () => {
  assert.deepEqual(metricKeysFor(october()), DEFAULT_METRIC_KEYS.slice());
  const custom = october({
    pages: PAGE_TYPES.map((t) => (t === 'poster'
      ? { type: 'poster', params: { metricKeys: ['totals.events', 'totals.aiRelays', 'savedTime.confirmed', 'rhythm.genre'] } }
      : { type: t })),
  });
  assert.deepEqual(metricKeysFor(custom), [
    'totals.events', 'totals.aiRelays', 'savedTime.confirmed', 'rhythm.genre',
  ]);
  assert.equal(metricKeysFor({ no: 1 }), null);
});

// ---------------------------------------------------------------------------
// 标题 — 原型 p0「十月，你把 6 小时还给了自己」/ p9 第一人称；不鸡汤（红线 4）。
// ---------------------------------------------------------------------------
test('posterTitle: first person for the poster, second person for the shelf cover', () => {
  assert.equal(posterTitle(october()), '十月，我把 6 小时还给了自己');
  assert.equal(posterTitle(october(), { person: 'second' }), '十月，你把 6 小时还给了自己');
});

test('posterTitle: no confirmed saved time → factual events line; zero events → label only', () => {
  const zero = JSON.parse(JSON.stringify(STATS));
  zero.savedTime.confirmedMinutes = 0;
  const chapter = october({ stats: zero });
  assert.equal(posterTitle(chapter), '十月，我记下了 86 件事');
  assert.equal(posterTitle(chapter, { person: 'second' }), '十月，你记下了 86 件事');
  zero.totals.events = 0;
  assert.equal(posterTitle(october({ stats: zero })), '十月');
});

test('posterTitle: override wins, trimmed, capped at CAPTION_MAX; invalid chapter → null', () => {
  assert.equal(posterTitle(october(), { override: '  我改过的标题  ' }), '我改过的标题');
  const long = 'x'.repeat(CAPTION_MAX + 10);
  assert.equal(posterTitle(october(), { override: long }).length, CAPTION_MAX);
  assert.equal(posterTitle(october(), { override: '   ' }), '十月，我把 6 小时还给了自己');
  assert.equal(posterTitle(null), null);
});

// ---------------------------------------------------------------------------
// 时间之歌波形 — SPEC §4: 海报波形 = 主旋律音高序列（melodyPitches：lead+chime）。
// ---------------------------------------------------------------------------
test('waveformBars: exact count, values in [0,1], deterministic', () => {
  const bars = waveformBars([57, 60, 64, 67, 71], { count: 12 });
  assert.equal(bars.length, 12);
  for (const v of bars) assert.ok(v >= 0 && v <= 1);
  assert.deepEqual(waveformBars([57, 60, 64, 67, 71], { count: 12 }), bars);
});

test('waveformBars: contour follows pitch — ascending input normalizes 0→1', () => {
  const bars = waveformBars([55, 57, 59, 61, 63, 65], { count: 6 });
  assert.equal(bars[0], 0);
  assert.equal(bars[bars.length - 1], 1);
  for (let i = 1; i < bars.length; i += 1) assert.ok(bars[i] >= bars[i - 1]);
});

test('waveformBars: transposition invariant, monotone flat, empty → flat, bad count → null', () => {
  const a = waveformBars([57, 62, 64, 69, 61], { count: 20 });
  const b = waveformBars([69, 74, 76, 81, 73], { count: 20 }); // +12 everywhere
  // 数学上精确相等；线性插值的浮点误差 ≤ 1e-9
  assert.equal(a.length, b.length);
  for (let i = 0; i < a.length; i += 1) assert.ok(Math.abs(a[i] - b[i]) < 1e-9);
  assert.deepEqual(waveformBars([60, 60, 60], { count: 9 }), new Array(9).fill(0.5));
  assert.deepEqual(waveformBars([60], { count: 5 }), new Array(5).fill(0.5));
  const flat = waveformBars([], { count: 8 });
  assert.equal(flat.length, 8);
  for (const v of flat) assert.ok(v > 0 && v < 1);
  assert.deepEqual(waveformBars(null, { count: 4 }), waveformBars([], { count: 4 }));
  assert.equal(waveformBars([1, 2], { count: 0 }), null);
  assert.equal(waveformBars([1, 2], { count: 1 }), null);
  assert.equal(waveformBars([1, 'x'], { count: 4 }), null);
  assert.equal(waveformBars(42, { count: 4 }), null);
});

test('waveformBars consumes melodyPitches: pad excluded, lead+chime kept', () => {
  const notes = [
    { midi: 45, at: 0.0, dur: 1, voice: 'pad' },
    { midi: 69, at: 0.0, dur: 0.5, voice: 'lead' },
    { midi: 64, at: 0.5, dur: 0.5, voice: 'lead' },
    { midi: 88, at: 0.75, dur: 0.2, voice: 'chime' },
  ];
  const pitches = melodyPitches(notes);
  assert.deepEqual(pitches, [69, 64, 88]);
  const bars = waveformBars(pitches, { count: 10 });
  assert.equal(bars.length, 10);
  // chime 88 is the max → the bar nearest its position reaches 1
  assert.equal(Math.max(...bars), 1);
});

// ---------------------------------------------------------------------------
// QR — SPEC §3 ⑨ 海报二维码。字节模式、EC 级 M、版本 1–5、结构 + 代数验证。
// ---------------------------------------------------------------------------
const FINDER = [
  [1, 1, 1, 1, 1, 1, 1],
  [1, 0, 0, 0, 0, 0, 1],
  [1, 0, 1, 1, 1, 0, 1],
  [1, 0, 1, 1, 1, 0, 1],
  [1, 0, 1, 1, 1, 0, 1],
  [1, 0, 0, 0, 0, 0, 1],
  [1, 1, 1, 1, 1, 1, 1],
];

function checkFinder(m, r, c) {
  for (let i = 0; i < 7; i += 1) {
    for (let j = 0; j < 7; j += 1) assert.equal(m[r + i][c + j], FINDER[i][j], `finder at ${r},${c} cell ${i},${j}`);
  }
}

test('qrMatrix: structure — finder/timing/dark module, size per version', () => {
  const qr = qrMatrix('https://donego.app'); // 18 bytes → version 2 (M)
  assert.equal(qr.size, 25);
  checkFinder(qr.rows, 0, 0);
  checkFinder(qr.rows, 0, qr.size - 7);
  checkFinder(qr.rows, qr.size - 7, 0);
  // timing pattern: row 6 / col 6 alternate starting dark at (6,6)
  for (let c = 8; c < qr.size - 8; c += 1) assert.equal(qr.rows[6][c], c % 2 === 0 ? 1 : 0);
  for (let r = 8; r < qr.size - 8; r += 1) assert.equal(qr.rows[r][6], r % 2 === 0 ? 1 : 0);
  // dark module (4v+9, 8)
  assert.equal(qr.rows[4 * 2 + 9][8], 1);
  // v2 alignment at (18,18) — 5×5 ring pattern, and nowhere else
  const al = [[1, 1, 1, 1, 1], [1, 0, 0, 0, 1], [1, 0, 1, 0, 1], [1, 0, 0, 0, 1], [1, 1, 1, 1, 1]];
  for (let i = 0; i < 5; i += 1) {
    for (let j = 0; j < 5; j += 1) assert.equal(qr.rows[16 + i][16 + j], al[i][j]);
  }
});

test('qrMatrix: deterministic, payload-sensitive, UTF-8 bytes, overflow → null', () => {
  const a = qrMatrix('https://donego.app');
  assert.deepEqual(qrMatrix('https://donego.app'), a);
  assert.notDeepEqual(qrMatrix('https://donego.app/x'), a);
  const zh = qrMatrix('探戈'); // 6 UTF-8 bytes → fits v1 (14-byte capacity)
  assert.equal(zh.size, 21);
  assert.equal(qrMatrix('x'.repeat(200)), null); // v5-M payload cap ~84 bytes
  assert.equal(qrMatrix(''), null);
  assert.equal(qrMatrix(null), null);
});

// 独立 GF(256) 算术（peasant multiply，与实现的 log/exp 表不同路径）。
function gfMul(a, b) {
  let p = 0;
  for (; b; b >>= 1) {
    if (b & 1) p ^= a;
    a <<= 1;
    if (a & 0x100) a ^= 0x11d;
  }
  return p & 0xff;
}
function gfPow(n) { // α^n
  let v = 1;
  for (let i = 0; i < n; i += 1) v = gfMul(v, 2);
  return v;
}

test('qrCodewords: RS remainder divisible by generator (independent GF math)', () => {
  // 手工推导的生成多项式常数（GF(256)/0x11d， peasant 乘法独立验证）：
  //   gen2 = (x+1)(x+α) = x²+3x+2；gen3 = gen2·(x+α²) = x³+7x²+14x+8
  const g2 = [1, 3, 2];
  const g3 = [1, 7, 14, 8];
  const one = qrCodewords('abcdefghij'); // 10 bytes → v1-M: 16 data cw, 10 ec cw
  assert.equal(one.version, 1);
  assert.equal(one.data.length, 16);
  assert.equal(one.ec.length, 10);
  const two = qrCodewords('https://donego.app'); // → v2-M: 28 data cw, 16 ec cw
  assert.equal(two.version, 2);
  assert.equal(two.data.length, 28);
  assert.equal(two.ec.length, 16);

  for (const { data, ec } of [one, two]) {
    const t = ec.length;
    // 多项式 = data·x^t ⊕ ec；被生成多项式整除 ⇔ 余式为 0
    let poly = data.concat(new Array(t).fill(0)).concat([]);
    for (let i = 0; i < t; i += 1) poly[data.length + i] ^= ec[i];
    const gen = generatorOf(t); // 由测试侧独立构造
    // 多项式除法（GF 内）
    for (let i = 0; i + gen.length <= poly.length; i += 1) {
      const c = poly[i];
      if (c === 0) continue;
      for (let j = 0; j < gen.length; j += 1) poly[i + j] ^= gfMul(gen[j], c);
    }
    for (const v of poly.slice(data.length)) assert.equal(v, 0, 'RS remainder must be zero');
  }

  function generatorOf(t) {
    let g = [1];
    for (let n = 0; n < t; n += 1) {
      const a = gfPow(n);
      const next = new Array(g.length + 1).fill(0);
      for (let i = 0; i < g.length; i += 1) {
        next[i] ^= g[i];          // ×x（系数保持位置，数组加长）
        next[i + 1] ^= gfMul(a, g[i]); // + α^n·g（低一位）
      }
      g = next;
    }
    if (t === 2) assert.deepEqual(g, g2);
    if (t === 3) assert.deepEqual(g, g3);
    return g;
  }
});

// ---------------------------------------------------------------------------
// 纯排版助手 — canvas 前的换行/缩字（node 可测）。
// ---------------------------------------------------------------------------
test('wrapTitleLines: CJK per-char wrap, explicit newlines, maxLines with ellipsis', () => {
  const measure = (text) => text.length * 100; // 每字 100px
  // 原型标题「我把 6 小时」两侧都有空格；行尾空白要去掉
  assert.deepEqual(wrapTitleLines('十月，我把 6 小时还给了自己', measure, 800, 3), [
    '十月，我把 6',
    '小时还给了自己',
  ]);
  assert.deepEqual(wrapTitleLines('一二三\n四五六七', measure, 800, 3), ['一二三', '四五六七']);
  // 超过 maxLines → 末行省略号收尾，不丢整行
  const lines = wrapTitleLines('一二三四五六七八九十', measure, 200, 2);
  assert.equal(lines.length, 2);
  assert.ok(lines[1].endsWith('…'));
  assert.deepEqual(wrapTitleLines('', measure, 800, 3), []);
});

test('fitText: shrinks font before truncating', () => {
  const measure = (text, size) => text.length * size; // 每字 = 字号宽
  const fit = fitText('深夜创作派', 88, measure, 399, 44);
  assert.ok(fit.size <= 88 && fit.size >= 44);
  assert.ok(measure(fit.text, fit.size) <= 399 + 1e-6);
  assert.equal(fit.text, '深夜创作派');
  const clipped = fitText('二十四个字的流派标题二十四个字的流派标题', 88, measure, 200, 60);
  assert.ok(clipped.text.endsWith('…'));
  assert.ok(measure(clipped.text, clipped.size) <= 200 + 1e-6);
});

// ---------------------------------------------------------------------------
// 布局（纯几何）与模型 — SPEC §8: PNG 尺寸准确；所有块不越界、不重叠。
// ---------------------------------------------------------------------------
test('posterLayout: boxes inside 1080×1920, ordered, non-overlapping', () => {
  const L = posterLayout({ titleLines: 3 });
  assert.equal(L.canvas.width, 1080);
  assert.equal(L.canvas.height, 1920);
  const boxes = [L.eyebrow, L.card, L.metrics, L.song, L.qr, L.footer];
  for (const b of boxes) {
    assert.ok(b.x >= 0 && b.y >= 0, 'no negative origin');
    assert.ok(b.x + b.w <= 1080 && b.y + b.h <= 1920, `box ${JSON.stringify(b)} inside canvas`);
  }
  assert.ok(L.eyebrow.y + L.eyebrow.h <= L.card.y, 'eyebrow above card');
  assert.ok(L.card.y + L.card.h >= L.metrics.y + L.metrics.h, 'metrics inside card');
  assert.ok(L.metrics.y + L.metrics.h <= L.song.y, 'metrics above song');
  assert.ok(L.song.y + L.song.h <= L.card.y + L.card.h, 'song inside card');
  assert.ok(L.card.y + L.card.h <= L.qr.y, 'card above qr');
  assert.ok(L.qr.y + L.qr.h <= L.footer.y, 'qr above footer');
  // 指标格是 2×2 等分
  assert.equal(L.metrics.cols, 2);
  assert.equal(L.metrics.rows, 2);
  assert.ok(Math.abs(L.metrics.cellW * 2 + L.metrics.gap - (L.card.w - L.card.pad * 2)) < 1e-6);
  // 波形条宽度算得下卡片内宽
  const innerW = L.card.w - L.card.pad * 2;
  assert.ok(L.song.barCount * L.song.barW + (L.song.barCount - 1) * L.song.barGap <= innerW + 1e-6);
});

test('posterLayout adapts to fewer title lines and stays valid', () => {
  const L = posterLayout({ titleLines: 1 });
  assert.ok(L.qr.y + L.qr.h <= L.footer.y);
  assert.ok(L.card.h < posterLayout({ titleLines: 3 }).card.h);
});

test('posterModel: October chapter → prototype-shaped model, deterministic', () => {
  const chapter = october();
  const model = posterModel(chapter, { qr: 'https://donego.app' });
  assert.equal(model.chapterNo, 10);
  assert.equal(model.eyebrow, '探戈 Done&Go · 第 10 章');
  assert.equal(model.typeLabel, '月章');
  assert.equal(model.periodLabel, '十月');
  assert.equal(model.periodRange, '2026.10.01 — 10.31');
  assert.equal(model.title, '十月，我把 6 小时还给了自己');
  assert.equal(model.metrics.length, 4);
  assert.equal(model.metrics[0].value, '86');
  assert.equal(model.metrics[3].value, '深夜创作派');
  assert.equal(model.songLabel, '♪ 十月 · 时间之歌（由我的数据生成）');
  assert.ok(model.waveform.length >= 8);
  assert.equal(model.qr.text, 'https://donego.app');
  assert.equal(model.qr.matrix.size, 25);
  assert.ok(model.footer.includes('2026.10.01 — 10.31'));
  assert.deepEqual(posterModel(chapter, { qr: 'https://donego.app' }), model);
  assert.equal(posterModel(null), null);
});

test('posterModel: notes/pitches feed the waveform; unknown metric degrades to placeholder', () => {
  const notes = [
    { midi: 69, at: 0, dur: 1, voice: 'lead' },
    { midi: 76, at: 1, dur: 1, voice: 'chime' },
    { midi: 45, at: 0, dur: 2, voice: 'pad' },
  ];
  const m1 = posterModel(october(), { notes, waveformCount: 12 });
  assert.equal(m1.waveform.length, 12);
  const m2 = posterModel(october(), { pitches: [69, 76], waveformCount: 12 });
  assert.deepEqual(m1.waveform, m2.waveform);
  const bad = october({
    pages: PAGE_TYPES.map((t) => (t === 'poster'
      ? { type: 'poster', params: { metricKeys: ['totals.events', 'no.such.key', 'rhythm.genre', 'totals.aiRelays'] } }
      : { type: t })),
  });
  const model = posterModel(bad, {});
  assert.equal(model.metrics[1].value, '—');
  assert.equal(model.qr, null); // node 无 location → 不编造域名
});

test('posterFilename: stable, ascii-safe', () => {
  assert.equal(posterFilename(october()), 'donego-ch10-2026-10-01.png');
});
