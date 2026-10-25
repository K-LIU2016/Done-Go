import assert from 'node:assert/strict';
import { test } from 'node:test';

// T2 叙事线定向单测 — web/story/narrative.js（SPEC design/story-recap/SPEC.md §5 + §3 页面库）。
// 覆盖：每页 3–5 模板与条件选择、心愿回应规则、中文关键词提取（词典+双字切分，零依赖）、
// AI 润色（stub 可测，输入只有统计数字）、文案红线（不鸡汤、不夸大、不出现「留白」）。
// 一切形状以 web/story/contracts.js 为准（红线：一律 import contracts，不本地重定义）。

import {
  KIND_NAMES, KIND_COLOR_WORDS, NARRATIVE_PAGE_TYPES, POLISH_KEYS, POLISH_TEXT_MAX,
  templatesFor, selectTemplates, captionsFor, lintCopy,
  buildPanels, classifyWish, echoWish, extractKeywords,
  buildPolishFacts, buildPolishRequest, applyPolishResult, polishCaptions, polishPanels,
  formatMinutes, formatHour,
} from '../../web/story/narrative.js';
import { validateStats, sanitizeCaptions } from '../../web/story/contracts.js';

// ---------------------------------------------------------------------------
// Fixtures — 数字对齐十月原型章（同 tests/unit/story-contracts.test.mjs）。
// ---------------------------------------------------------------------------

function fullStats(overrides) {
  const stats = {
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
  if (overrides) deepOverride(stats, overrides);
  return stats;
}

function deepOverride(target, overrides) {
  for (const key of Object.keys(overrides)) {
    const value = overrides[key];
    if (value && typeof value === 'object' && !Array.isArray(value)
        && target[key] && typeof target[key] === 'object' && !Array.isArray(target[key])) {
      deepOverride(target[key], value);
    } else if (value !== undefined) {
      target[key] = value;
    } else {
      delete target[key];
    }
  }
}

const META = { type: 'month', variant: 'full', no: 10, period: { from: '2026-10-01', to: '2026-10-31' } };

function zeroStats() {
  return {
    totals: { events: 0, aiRelays: 0, prevEvents: null, delta: null },
    kindMinutes: [
      { kind: 'necessary', minutes: 0, share: 0 },
      { kind: 'create', minutes: 0, share: 0 },
      { kind: 'connect', minutes: 0, share: 0 },
      { kind: 'explore', minutes: 0, share: 0 },
      { kind: 'restore', minutes: 0, share: 0 },
      { kind: 'stillness', minutes: 0, share: 0 },
    ],
    topDay: null,
    lessons: { learned: [], firstGraduation: null },
    savedTime: { confirmedMinutes: 0, allocations: [] },
    rhythm: { hourly: Array.from({ length: 24 }, () => 0), goldenHour: null, genre: null },
    panels: [{ label: '第 1 周', caption: '还没有事项的一周' }],
    keywords: [],
    wishEcho: null,
    song: {
      busyness: 0, mood: 0, dominantKind: 'necessary',
      weeklyCounts: [0], graduations: [0],
    },
  };
}

// ---------------------------------------------------------------------------
// A. 模板注册表 — 每页 3–5 个模板，条件选择（SPEC §5 规则模板优先）。
// ---------------------------------------------------------------------------

test('A1 每个页型 3–5 个模板，id 唯一，末位为无条件兜底', () => {
  assert.ok(Array.isArray(NARRATIVE_PAGE_TYPES) && NARRATIVE_PAGE_TYPES.length === 10);
  for (const page of NARRATIVE_PAGE_TYPES) {
    const entries = templatesFor(page);
    assert.ok(entries.length >= 3 && entries.length <= 5, `${page} 模板数 ${entries.length} 不在 3–5`);
    const ids = entries.map((e) => e.id);
    ids.forEach((id) => assert.equal(typeof id, 'string', `${page} 模板 id 必须是字符串`));
    assert.equal(new Set(ids).size, ids.length, `${page} 模板 id 重复`);
    assert.equal(entries[entries.length - 1].when, null, `${page} 末位模板必须是无条件兜底`);
  }
});

test('A2 cover 与 poster 的选择条件一致（封面↔海报同源）', () => {
  const stats = fullStats();
  const sel = selectTemplates(stats, META);
  assert.equal(sel.cover, 'saved-return');
  assert.equal(sel.poster, 'saved-return');
});

// ---------------------------------------------------------------------------
// B. 条件选择 — 同一页不同数据选不同模板（SPEC §5「比上月多/少/持平」「第一次」）。
// ---------------------------------------------------------------------------

test('B1 cover 五分支：省时→毕业→主色→量多→平实', () => {
  assert.equal(selectTemplates(fullStats(), META).cover, 'saved-return');
  assert.equal(selectTemplates(fullStats({ savedTime: { confirmedMinutes: 0, allocations: [] } }), META).cover, 'first-graduation');
  const dominantKinds = fullStats().kindMinutes.map((r) => (r.kind === 'create' ? { ...r, share: 0.55 } : { ...r, share: r.share * 0.9 }));
  const noGrad = { learned: fullStats().lessons.learned, firstGraduation: null };
  assert.equal(selectTemplates(fullStats({ savedTime: { confirmedMinutes: 0, allocations: [] }, lessons: noGrad, kindMinutes: dominantKinds }), META).cover, 'dominant-color');
  assert.equal(selectTemplates(fullStats({ savedTime: { confirmedMinutes: 0, allocations: [] }, lessons: noGrad }), META).cover, 'many-events');
  const quiet = fullStats({
    totals: { events: 3, aiRelays: 1, prevEvents: 5, delta: -2 },
    savedTime: { confirmedMinutes: 0, allocations: [] },
    lessons: noGrad,
  });
  assert.equal(selectTemplates(quiet, META).cover, 'plain-count');
});

test('B2 numbers 分支：无 AI > 首章 > 多/少/持平', () => {
  assert.equal(selectTemplates(fullStats(), META).numbers, 'more');
  assert.equal(selectTemplates(fullStats({ totals: { events: 70, aiRelays: 23, prevEvents: 77, delta: -7 } }), META).numbers, 'fewer');
  assert.equal(selectTemplates(fullStats({ totals: { events: 77, aiRelays: 23, prevEvents: 77, delta: 0 } }), META).numbers, 'flat');
  assert.equal(selectTemplates(fullStats({ totals: { events: 40, aiRelays: 10, prevEvents: null, delta: null } }), META).numbers, 'first');
  assert.equal(selectTemplates(fullStats({ totals: { events: 86, aiRelays: 0, prevEvents: 77, delta: 9 } }), META).numbers, 'no-ai');
});

test('B3 timeColors 分支：主导色/双色/平均/位次/零数据', () => {
  assert.equal(selectTemplates(fullStats(), META).timeColors, 'two-tone');
  assert.equal(selectTemplates(fullStats({ kindMinutes: fullStats().kindMinutes.map((r) => (r.kind === 'create' ? { ...r, share: 0.55 } : r)) }), META).timeColors, 'dominant-color');
  assert.equal(selectTemplates(zeroStats(), META).timeColors, 'no-color');
  const balanced = fullStats({ kindMinutes: fullStats().kindMinutes.map((r, i) => ({ ...r, share: [0.2, 0.18, 0.17, 0.16, 0.15, 0.14][i] })) });
  assert.equal(selectTemplates(balanced, META).timeColors, 'balanced');
  const ranked = fullStats({ kindMinutes: fullStats().kindMinutes.map((r, i) => ({ ...r, share: [0.35, 0.15, 0.14, 0.13, 0.12, 0.11][i] })) });
  assert.equal(selectTemplates(ranked, META).timeColors, 'ranked');
});

test('B4 specialDay 分支：无数据/温暖/跨天/最满/平实', () => {
  assert.equal(selectTemplates(zeroStats(), META).specialDay, 'no-day');
  assert.equal(selectTemplates(fullStats(), META).specialDay, 'warm');
  const longDay = fullStats({ topDay: { date: '2026-10-18', events: 9, timeline: [
    { time: '08:00', title: '读懂一篇论文', ai: true },
    { time: '23:00', title: '组会', ai: false },
  ], warmIndex: null } });
  assert.equal(selectTemplates(longDay, META).specialDay, 'span-day');
  const busy = fullStats({ topDay: { date: '2026-10-18', events: 9, timeline: [
    { time: '10:00', title: '组会', ai: false },
    { time: '11:00', title: '跑实验', ai: false },
  ], warmIndex: null } });
  assert.equal(selectTemplates(busy, META).specialDay, 'busiest-day');
  const plain = fullStats({ topDay: { date: '2026-10-18', events: 3, timeline: [
    { time: '10:00', title: '组会', ai: false },
  ], warmIndex: null } });
  assert.equal(selectTemplates(plain, META).specialDay, 'plain-day');
});

test('B5 lessons 分支：毕业/最常用/在手里/没有', () => {
  assert.equal(selectTemplates(fullStats(), META).lessons, 'first-graduation');
  const noGrad = fullStats({ lessons: { learned: fullStats().lessons.learned, firstGraduation: null } });
  assert.equal(selectTemplates(noGrad, META).lessons, 'top-usage');
  assert.equal(selectTemplates(fullStats({ lessons: { learned: [{ usageId: 'idea-plan', title: '想法 → 分步计划', count: 1 }], firstGraduation: null } }), META).lessons, 'in-hand');
  assert.equal(selectTemplates(fullStats({ lessons: { learned: [], firstGraduation: null } }), META).lessons, 'none-yet');
});

test('B6 savedTime 分支：去向/分钟/未写去向/没有', () => {
  assert.equal(selectTemplates(fullStats(), META).savedTime, 'given-away');
  assert.equal(selectTemplates(fullStats({ savedTime: { confirmedMinutes: 45, allocations: [{ use: 'restore', minutes: 45 }] } }), META).savedTime, 'small-minutes');
  assert.equal(selectTemplates(fullStats({ savedTime: { confirmedMinutes: 360, allocations: [] } }), META).savedTime, 'unallocated');
  assert.equal(selectTemplates(fullStats({ savedTime: { confirmedMinutes: 0, allocations: [] } }), META).savedTime, 'none-confirmed');
});

test('B7 rhythm 分支：黄金时段/清晨/零数据', () => {
  assert.equal(selectTemplates(fullStats(), META).rhythm, 'golden');
  assert.equal(selectTemplates(fullStats({ rhythm: { hourly: fullStats().rhythm.hourly, goldenHour: 6, genre: fullStats().rhythm.genre } }), META).rhythm, 'early-golden');
  assert.equal(selectTemplates(zeroStats(), META).rhythm, 'no-clock');
});

// ---------------------------------------------------------------------------
// C. captionsFor — 全章文案、确定性、契约兼容、边界与红线矩阵。
// ---------------------------------------------------------------------------

test('C1 十月原型 fixture：关键锚点逐字对齐原型文案', () => {
  const captions = captionsFor(fullStats(), META);
  // 键名与页面槽位一一对应（pages/* 的 captionDefaults）：numbers→count.lead、
  // timeColors→spectrum.title、specialDay→day.warm、lessons→learned.first、
  // savedTime→freed.lead；kicker 为固定文案键。
  for (const key of ['cover.title', 'numbers.kicker', 'count.lead',
    'specialDay.kicker', 'day.warm', 'lessons.kicker', 'learned.first',
    'savedTime.kicker', 'freed.lead', 'rhythm.title', 'wish.prompt', 'poster.kicker', 'poster.title']) {
    assert.equal(typeof captions[key], 'string', `缺 ${key}`);
    assert.ok(captions[key].length > 0, `${key} 为空`);
  }
  if (captions['spectrum.title']) assert.ok(captions['spectrum.title'].length > 0);
  assert.equal(captions['cover.title'], '十月，你把 6 小时还给了自己');
  assert.equal(captions['poster.title'], '十月，我把 6 小时还给了自己');
  assert.equal(captions['rhythm.title'], '晚上 10 点，是你的黄金时间');
  assert.equal(captions['spectrum.title'], '金色的创造，夹着橘色的相聚');
  assert.ok(captions['count.lead'].includes('多了 9 件'), captions['count.lead']);
  assert.ok(captions['day.warm'].includes('「给妈妈打电话」'), captions['day.warm']);
  assert.ok(captions['learned.first'].includes('10 月 12 日'), captions['learned.first']);
  assert.ok(captions['learned.first'].includes('deepseek'), captions['learned.first']);
});

test('C2 确定性：同一 stats 两次生成完全一致', () => {
  const a = captionsFor(fullStats(), META);
  const b = captionsFor(fullStats(), META);
  assert.deepEqual(a, b);
});

test('C3 契约兼容：captions 过 sanitizeCaptions 原样存活', () => {
  const captions = captionsFor(fullStats(), META);
  const sanitized = sanitizeCaptions(captions);
  assert.deepEqual(sanitized, captions);
});

test('C4 零数据：每页都有诚实文案，不硬编（SPEC §1 求真）', () => {
  const captions = captionsFor(zeroStats(), META);
  const keys = Object.keys(captions);
  assert.ok(keys.length >= 10, '零数据也要有全套页文案');
  for (const key of keys) {
    assert.ok(captions[key].length > 0, `${key} 为空`);
    const lint = lintCopy(captions[key]);
    assert.ok(lint.ok, `${key} 红线: ${lint.reasons.join(',')}`);
  }
  assert.ok(captions['freed.lead'].includes('还没有'), captions['freed.lead']);
});

test('C5 短章文案用 SPEC §2 的原句', () => {
  const captions = captionsFor(fullStats(), { ...META, variant: 'short' });
  assert.equal(captions['cover.title'], '这个月记得不多，下一章一起写满一点');
});

test('C6 周记的页头随 type 变化', () => {
  const captions = captionsFor(fullStats(), { ...META, type: 'week', period: { from: '2026-10-19', to: '2026-10-25' } });
  assert.equal(captions['numbers.kicker'], '这一周，你记下了');
});

test('C7 红线矩阵：所有 fixture 的所有文案不鸡汤、不夸大、不出现「留白」', () => {
  const matrix = [
    ['full', fullStats(), META],
    ['zero', zeroStats(), META],
    ['minimal', fullStats({ totals: { events: 1, aiRelays: 1, prevEvents: null, delta: null },
      lessons: { learned: [{ usageId: 'idea-plan', title: '想法 → 分步计划', count: 1 }], firstGraduation: null },
      savedTime: { confirmedMinutes: 0, allocations: [] },
      topDay: { date: '2026-10-02', events: 1, timeline: [{ time: '21:00', title: '写周报', ai: true }], warmIndex: 0 },
      rhythm: { hourly: Array.from({ length: 24 }, () => 0), goldenHour: 21, genre: null },
      song: { busyness: 0.1, mood: 0.5, dominantKind: 'create', weeklyCounts: [1], graduations: [0] } }), META],
    ['fewer', fullStats({ totals: { events: 70, aiRelays: 20, prevEvents: 77, delta: -7 } }), META],
    ['flat', fullStats({ totals: { events: 77, aiRelays: 20, prevEvents: 77, delta: 0 } }), META],
    ['no-ai', fullStats({ totals: { events: 86, aiRelays: 0, prevEvents: 77, delta: 9 } }), META],
    ['no-prev', fullStats({ totals: { events: 40, aiRelays: 10, prevEvents: null, delta: null } }), META],
    ['short', fullStats(), { ...META, variant: 'short' }],
    ['week', fullStats(), { ...META, type: 'week', period: { from: '2026-10-19', to: '2026-10-25' } }],
  ];
  for (const [name, stats, meta] of matrix) {
    const captions = captionsFor(stats, meta);
    for (const key of Object.keys(captions)) {
      assert.ok(!captions[key].includes('留白'), `${name}.${key} 出现「留白」`);
      const lint = lintCopy(captions[key]);
      assert.ok(lint.ok, `${name}.${key} 红线: ${lint.reasons.join(',')} → ${captions[key]}`);
    }
  }
});

test('C8 meta.pages 指定页序；未知页型（年书专属）安全跳过', () => {
  const captions = captionsFor(fullStats(), { ...META, pages: ['cover', 'yearStreak', 'poster'] });
  const keys = Object.keys(captions);
  assert.ok(keys.some((k) => k.startsWith('cover.')));
  assert.ok(keys.some((k) => k.startsWith('poster.')));
  assert.ok(!keys.some((k) => k.startsWith('yearStreak')));
  assert.ok(!keys.some((k) => k.startsWith('numbers.')));
});

test('C9 stats 为 null 时返回空对象，不抛错', () => {
  assert.deepEqual(captionsFor(null, META), {});
});

// ---------------------------------------------------------------------------
// D. 文案红线 lintCopy（SPEC §5 禁止项 + JC 指定避词）。
// ---------------------------------------------------------------------------

test('D1 「留白」直接拒绝', () => {
  const lint = lintCopy('十月有很好的留白');
  assert.equal(lint.ok, false);
  assert.ok(lint.reasons.includes('forbidden-word'));
});

test('D2 与他人比较（比 90% 的人）拒绝', () => {
  const lint = lintCopy('你比 90% 的人更专注');
  assert.equal(lint.ok, false);
  assert.ok(lint.reasons.includes('peer-comparison'));
});

test('D3 鸡汤说教拒绝', () => {
  const lint = lintCopy('未来可期，请相信相信的力量');
  assert.equal(lint.ok, false);
  assert.ok(lint.reasons.includes('chicken-soup'));
});

test('D4 夸大用词拒绝', () => {
  const lint = lintCopy('AI 帮你省下了无数时间');
  assert.equal(lint.ok, false);
  assert.ok(lint.reasons.includes('exaggeration'));
});

test('D5 事实陈述放行', () => {
  assert.deepEqual(lintCopy('十月，你把 6 小时还给了自己'), { ok: true, reasons: [] });
  assert.equal(lintCopy('其中 23 件交给了 AI 接力。比上一章多了 9 件。').ok, true);
});

test('D6 非字符串/空串拒绝', () => {
  assert.equal(lintCopy(null).ok, false);
  assert.equal(lintCopy('   ').ok, false);
});

// ---------------------------------------------------------------------------
// E. 数字与时段中文格式化。
// ---------------------------------------------------------------------------

test('E1 formatMinutes', () => {
  assert.equal(formatMinutes(42), '42 分钟');
  assert.equal(formatMinutes(60), '60 分钟');
  assert.equal(formatMinutes(89), '89 分钟');
  assert.equal(formatMinutes(90), '1.5 小时');
  assert.equal(formatMinutes(360), '6 小时');
  assert.equal(formatMinutes(100), '1.7 小时');
});

test('E2 formatHour 24 小时全表', () => {
  assert.equal(formatHour(0), '凌晨 12 点');
  assert.equal(formatHour(3), '凌晨 3 点');
  assert.equal(formatHour(6), '早上 6 点');
  assert.equal(formatHour(9), '上午 9 点');
  assert.equal(formatHour(12), '中午 12 点');
  assert.equal(formatHour(14), '下午 2 点');
  assert.equal(formatHour(18), '傍晚 6 点');
  assert.equal(formatHour(21), '晚上 9 点');
  assert.equal(formatHour(22), '晚上 10 点');
  assert.equal(formatHour(23), '深夜 11 点');
});

// ---------------------------------------------------------------------------
// F. 中文关键词提取 — 词典 + 双字切分，零依赖（SPEC §3 ⑦ 关键词来自标题分词）。
// ---------------------------------------------------------------------------

const PROTOTYPE_TITLES = ['读懂一篇论文', '组会', '整理组会纪要', '跑实验', '给导师回邮件', '和室友吃火锅', '给妈妈打电话'];

test('F1 原型标题：词典命中、去停用词、频次排序', () => {
  const words = extractKeywords(PROTOTYPE_TITLES);
  assert.equal(words.length, 6);
  assert.equal(words[0].word, '组会');
  assert.equal(words[0].weight, 2);
  assert.ok(words.some((w) => w.word === '论文'));
  assert.ok(words.some((w) => w.word === '实验'));
  for (const w of words) assert.ok(w.word.length >= 2, `单词 ${w.word} 少于 2 字`);
  for (const w of words) assert.ok(w.weight > 0);
});

test('F2 词典外走双字切分，虚词与操作动词剔除', () => {
  const words = extractKeywords(['仓库盘点和货架整理']);
  const names = words.map((w) => w.word);
  assert.ok(names.includes('仓库'), names.join(','));
  assert.ok(names.includes('盘点'), names.join(','));
  assert.ok(names.includes('货架'), names.join(','));
  assert.ok(!names.includes('整理'), '操作动词应剔除');
  assert.ok(!names.includes('和货'), '虚词不应进入切分');
});

test('F3 拉丁词保留原样', () => {
  const words = extractKeywords(['升级 PPT 模板']);
  const names = words.map((w) => w.word);
  assert.ok(names.includes('PPT'), names.join(','));
  assert.ok(names.includes('模板'), names.join(','));
});

test('F4 空输入/纯停用词/纯数字 → 空数组', () => {
  assert.deepEqual(extractKeywords([]), []);
  assert.deepEqual(extractKeywords(['的', '了', '和']), []);
  assert.deepEqual(extractKeywords(['123', '45.6']), []);
});

test('F5 topN 与频次降序', () => {
  const words = extractKeywords(['跑步', '跑步', '跑步', '读书', '读书', '冥想', '画画', '通勤'], { topN: 3 });
  assert.deepEqual(words.map((w) => w.word), ['跑步', '读书', '冥想']);
  assert.deepEqual(words.map((w) => w.weight), [3, 2, 1]);
});

test('F6 频次并列按首现顺序稳定', () => {
  const words = extractKeywords(['读书', '跑步'], { topN: 2 });
  assert.deepEqual(words.map((w) => w.word), ['读书', '跑步']);
});

test('F7 超长词（>16 字符）丢弃，保证契约 word ≤ 16', () => {
  const words = extractKeywords(['abcdefghijklmnopqrstuvwxyz 的一天']);
  assert.ok(!words.some((w) => w.word.length > 16));
});

test('F8 产物可直接进 validateStats 的 keywords 槽', () => {
  const stats = fullStats({ keywords: extractKeywords(PROTOTYPE_TITLES) });
  assert.ok(validateStats(stats));
});

// ---------------------------------------------------------------------------
// G. 心愿回应规则（SPEC §3 ⑧：可量化给数据，不可量化温柔复述）。
// ---------------------------------------------------------------------------

test('G1 classifyWish 关键词典命中', () => {
  assert.equal(classifyWish('希望十月能早点睡'), 'sleep');
  assert.equal(classifyWish('多留一点给跑步和妈妈'), 'exercise');
  assert.equal(classifyWish('把论文读明白一点'), 'learning');
  assert.equal(classifyWish('想多陪陪家人'), 'company');
  assert.equal(classifyWish('想去看一次海'), 'other');
  assert.equal(classifyWish(''), 'other');
  assert.equal(classifyWish(null), 'other');
});

test('G2 没有上一章心愿 → null', () => {
  assert.equal(echoWish(null, []), null);
});

test('G3 可量化心愿 + 有数据：matched 且 reply 带事实', () => {
  const facts = [
    { label: '12 点前收尾', value: '11 天' },
    { label: '比上一章多', value: '6 天' },
  ];
  const echo = echoWish({ text: '希望十月能早点睡', category: 'sleep', at: null }, facts, META);
  assert.equal(echo.matched, true);
  assert.ok(echo.reply.includes('11 天'), echo.reply);
  assert.ok(echo.reply.includes('6 天'), echo.reply);
  assert.ok(echo.reply.includes('这个月'), echo.reply);
  assert.deepEqual(echo.facts, facts);
  assert.equal(echo.text, '希望十月能早点睡');
});

test('G4 可量化心愿 + 无数据：诚实说不足', () => {
  const echo = echoWish({ text: '希望十月能早点睡', category: 'sleep', at: null }, [], META);
  assert.equal(echo.matched, false);
  assert.ok(echo.reply.includes('不足以'), echo.reply);
  assert.ok(lintCopy(echo.reply).ok);
});

test('G5 不可量化心愿：温柔复述，不造数字', () => {
  const echo = echoWish({ text: '想去看一次海', category: 'other', at: null }, [], META);
  assert.equal(echo.matched, false);
  assert.ok(echo.reply.includes('想去看一次海'), echo.reply);
  assert.ok(!/\d/.test(echo.reply), `复述不应出现数字: ${echo.reply}`);
  assert.ok(lintCopy(echo.reply).ok);
});

test('G6 category 缺省时从文本推导', () => {
  const echo = echoWish({ text: '希望早点睡', category: null, at: null }, [{ label: '12 点前收尾', value: '11 天' }], META);
  assert.equal(echo.matched, true);
});

test('G7 facts 截到 4 条，label/value 超限先修剪（对齐契约 12/24）', () => {
  const facts = Array.from({ length: 6 }, (_, i) => ({ label: `abcdefghijklmno${i}`, value: `vwxyz012345678901234567890${i}` }));
  const echo = echoWish({ text: '希望早点睡', category: 'sleep', at: null }, facts, META);
  assert.equal(echo.facts.length, 4);
  for (const f of echo.facts) {
    assert.ok(f.label.length <= 12);
    assert.ok(f.value.length <= 24);
  }
});

test('G8 长度红线：wish 60 字时 reply 仍 ≤ 120', () => {
  const long = '早'.repeat(60);
  const echo = echoWish({ text: long, category: 'other', at: null }, [], META);
  assert.equal(echo.text.length, 60);
  assert.ok(echo.reply.length <= 120, `reply ${echo.reply.length}`);
});

test('G9 产物可直接进 validateStats 的 wishEcho 槽', () => {
  const echo = echoWish({ text: '希望十月能早点睡', category: 'sleep', at: null },
    [{ label: '12 点前收尾', value: '11 天' }], META);
  const stats = fullStats({ wishEcho: echo });
  assert.ok(validateStats(stats));
});

// ---------------------------------------------------------------------------
// H. 四格 buildPanels — 输入只有每周数字（SPEC §5：不输入事项原文）。
// ---------------------------------------------------------------------------

test('H1 原型周数据：最忙/最缓/毕业/件数 四类旁白', () => {
  const panels = buildPanels([14, 22, 28, 22], [0, 1, 2, 1]);
  assert.equal(panels.length, 4);
  assert.deepEqual(panels.map((p) => p.label), ['第 1 周', '第 2 周', '第 3 周', '第 4 周']);
  assert.equal(panels[0].caption, '节奏最缓的一周：14 件事');
  assert.equal(panels[2].caption, '最忙的一周：28 件事');
  for (const p of panels) {
    assert.ok(p.caption.length <= 24, `${p.label} ${p.caption.length} 字超限`);
    assert.ok(lintCopy(p.caption).ok, p.caption);
  }
  assert.ok(new Set(panels.map((p) => p.caption)).size >= 3, '四格旁白应有区分度');
});

test('H2 单周不比较、不越界', () => {
  assert.deepEqual(buildPanels([7], [1]), [{ label: '第 1 周', caption: '有一次毕业的一周' }]);
  assert.deepEqual(buildPanels([7], [0]), [{ label: '第 1 周', caption: '7 件事的一周' }]);
});

test('H3 各周持平时不称最忙/最缓', () => {
  const panels = buildPanels([5, 5, 5], [0, 0, 0]);
  for (const p of panels) {
    assert.ok(!p.caption.includes('最忙'));
    assert.ok(!p.caption.includes('最缓'));
  }
});

test('H4 产物可直接进 validateStats 的 panels 槽', () => {
  const stats = fullStats({ panels: buildPanels([14, 22, 28, 22], [0, 1, 2, 1]) });
  assert.ok(validateStats(stats));
});

test('H5 空周数组防御性返回空', () => {
  assert.deepEqual(buildPanels([], []), []);
});

// ---------------------------------------------------------------------------
// I. AI 润色 — 经 lab 服务端代理、stub 可测、输入只有统计数字（SPEC §5 / D4）。
// ---------------------------------------------------------------------------

test('I1 POLISH_KEYS 契约键形 + ≤24 字红线', () => {
  assert.ok(POLISH_KEYS.length >= 6);
  for (const key of POLISH_KEYS) assert.match(key, /^[-_.a-zA-Z0-9]{1,40}$/);
  assert.equal(POLISH_TEXT_MAX, 24);
});

test('I2 buildPolishFacts 只含统计数字，不含事项原文与用法标题', () => {
  const facts = buildPolishFacts(fullStats(), META);
  const json = JSON.stringify(facts);
  for (const secret of ['读懂一篇论文', '给妈妈打电话', '论文 → 5 个要点']) {
    assert.ok(!json.includes(secret), `facts 泄露原文: ${secret}`);
  }
  assert.ok(json.includes('86'));
  assert.ok(json.includes('goldenHour'));
  assert.ok(json.includes('create'));
});

test('I3 buildPolishRequest：mode story、items 属地、正文无原文', () => {
  const captions = captionsFor(fullStats(), META);
  const panels = buildPanels([14, 22, 28, 22], [0, 1, 2, 1]);
  const request = buildPolishRequest(captions, panels, fullStats(), META);
  assert.equal(request.mode, 'story');
  const keys = request.items.map((i) => i.key);
  assert.ok(keys.includes('cover.title'));
  assert.ok(keys.includes('panels.0'));
  const json = JSON.stringify(request);
  for (const secret of ['读懂一篇论文', '给妈妈打电话', '论文 → 5 个要点']) {
    assert.ok(!json.includes(secret), `请求泄露原文: ${secret}`);
  }
  assert.ok(json.includes('23'), '请求应含统计数字');
});

test('I4 applyPolishResult：采纳合法、拒绝超长与红线、忽略未请求键', () => {
  const captions = captionsFor(fullStats(), META);
  const result = {
    items: [
      { key: 'cover.title', text: '十月，把时间握在手里' },
      { key: 'rhythm.title', text: '晚十点是你的黄金时间晚十点是你的黄金时间晚十点是你的黄金时间' },
      { key: 'timeColors.title', text: '十月有很好的留白' },
      { key: 'numbers.lead', text: '不该被采纳的键' },
      { key: 'lessons.title', text: '   ' },
    ],
  };
  const out = applyPolishResult(captions, result);
  assert.equal(out['cover.title'], '十月，把时间握在手里');
  assert.equal(out['rhythm.title'], captions['rhythm.title'], '超长回退模板');
  assert.equal(out['timeColors.title'], captions['timeColors.title'], '红线词回退模板');
  assert.equal(out['numbers.lead'], captions['numbers.lead'], '未请求键忽略');
  assert.equal(out['lessons.title'], captions['lessons.title'], '空串忽略');
});

test('I5 polishCaptions stub 成功：仅替换命中键，POST + JSON 头', async () => {
  const captions = captionsFor(fullStats(), META);
  const calls = [];
  const transport = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 200, json: async () => ({ items: [{ key: 'cover.title', text: '十月，把时间握在手里' }] }) };
  };
  const out = await polishCaptions(captions, fullStats(), META, { transport, endpoint: '/api/story-polish' });
  assert.equal(out['cover.title'], '十月，把时间握在手里');
  assert.equal(out['numbers.lead'], captions['numbers.lead']);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/story-polish');
  assert.equal(calls[0].init.method, 'POST');
  assert.ok(String(calls[0].init.headers['content-type']).includes('application/json'));
});

test('I6 transport 抛错 → 全量回退模板', async () => {
  const captions = captionsFor(fullStats(), META);
  const transport = async () => { throw new Error('network down'); };
  const out = await polishCaptions(captions, fullStats(), META, { transport, endpoint: '/api/story-polish' });
  assert.deepEqual(out, captions);
});

test('I7 无 endpoint 不发请求（不触网）', async () => {
  const captions = captionsFor(fullStats(), META);
  let called = 0;
  const transport = async () => { called += 1; return { ok: true, status: 200, json: async () => ({ items: [] }) }; };
  const out = await polishCaptions(captions, fullStats(), META, { transport });
  assert.equal(called, 0);
  assert.deepEqual(out, captions);
});

test('I8 非 200 / JSON 解析失败 → 回退模板', async () => {
  const captions = captionsFor(fullStats(), META);
  const badStatus = await polishCaptions(captions, fullStats(), META, {
    transport: async () => ({ ok: false, status: 500, json: async () => ({}) }),
    endpoint: '/api/story-polish',
  });
  assert.deepEqual(badStatus, captions);
  const badJson = await polishCaptions(captions, fullStats(), META, {
    transport: async () => ({ ok: true, status: 200, json: async () => { throw new Error('bad json'); } }),
    endpoint: '/api/story-polish',
  });
  assert.deepEqual(badJson, captions);
});

test('I9 polishPanels：成功替换且契约仍过；超长回退', async () => {
  const panels = buildPanels([14, 22, 28, 22], [0, 1, 2, 1]);
  const ok = await polishPanels(panels, fullStats(), META, {
    transport: async () => ({ ok: true, status: 200, json: async () => ({ items: [{ key: 'panels.0', text: '开局的一周，14 件事' }] }) }),
    endpoint: '/api/story-polish',
  });
  assert.equal(ok[0].caption, '开局的一周，14 件事');
  assert.equal(ok[1].caption, panels[1].caption);
  assert.ok(validateStats(fullStats({ panels: ok })));
  const longText = '这一周真的非常非常非常非常非常非常非常非常忙碌呀呀呀呀';
  const overlong = await polishPanels(panels, fullStats(), META, {
    transport: async () => ({ ok: true, status: 200, json: async () => ({ items: [{ key: 'panels.0', text: longText }] }) }),
    endpoint: '/api/story-polish',
  });
  assert.equal(overlong[0].caption, panels[0].caption);
});

test('I10 无 opts 调用安全返回模板（默认不触网）', async () => {
  const captions = captionsFor(fullStats(), META);
  const out = await polishCaptions(captions, fullStats(), META);
  assert.deepEqual(out, captions);
});

// ---------------------------------------------------------------------------
// J. 组装级联：narrative 产物拼成完整 stats 后整体过契约。
// ---------------------------------------------------------------------------

test('J1 组装级联：panels+keywords+wishEcho 全部来自本线产物，validateStats 通过', () => {
  const stats = fullStats({
    panels: buildPanels([14, 22, 28, 22], [0, 1, 2, 1]),
    keywords: extractKeywords(PROTOTYPE_TITLES),
    wishEcho: echoWish({ text: '希望十月能早点睡', category: 'sleep', at: null },
      [{ label: '12 点前收尾', value: '11 天' }, { label: '比上一章多', value: '6 天' }], META),
  });
  assert.ok(validateStats(stats));
});
