import assert from 'node:assert/strict';
import { test } from 'node:test';

// T1 统计线：web/story/stats.js 的全部指标都是纯函数（SPEC design/story-recap/
// SPEC.md §6），输入原始数据 + 期间，输出能通过 contracts.validateStats 的
// stats。所有形状常量（六类、短章阈值、schema）一律 import contracts.js，
// 绝不在本线重定义。边界用例（SPEC §8）：跨月、跨年、零数据、只有 1 件事、
// 时区（接力记录 at 的本地日归属）。
import {
  computeStats,
  variantForEventCount,
  plannedMinutes,
  topKeywords,
} from '../../web/story/stats.js';
import {
  createChapter,
  validateStats,
  SHORT_CHAPTER_MIN_EVENTS,
} from '../../web/story/contracts.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
function E(id, date, start, end, title, kind, extra) {
  return Object.assign({ id, date, start, end, title, kind }, extra || {});
}
function R(id, at, usageId, extra) {
  return Object.assign({ id, at, event: 'relay-' + id, usageId }, extra || {});
}
var UUID = function (n) {
  return '10000000-0000-4000-8000-00000000000' + n;
};

function sepEntries() {
  return [
    E('p1', '2026-09-10', '20:00', '21:00', '晚饭', 'necessary'),
    E('p2', '2026-09-10', '22:00', '23:00', '读书', 'explore'),
    E('p3', '2026-09-20', '22:30', '24:00', '赶稿', 'create'),
  ];
}

function octEntries() {
  return [
    E('e1', '2026-10-05', '08:30', '10:00', '读懂一篇论文', 'explore', { ai: { used: true } }),
    E('e2', '2026-10-05', '10:00', '11:00', '组会', 'necessary'),
    E('e3', '2026-10-05', '19:00', '21:00', '和室友吃火锅', 'connect'),
    E('e4', '2026-10-12', '22:00', '23:00', '给妈妈打电话', 'connect', { ai: { used: true } }),
    E('e5', '2026-10-18', '08:30', '09:30', '跑实验', 'create', {
      done: true,
      ai: { used: true },
      completion: { before: 60, actual: 45, usedAI: true },
    }),
    E('e6', '2026-10-18', '10:00', '13:00', '写论文引言', 'create'),
    E('e7', '2026-10-18', '22:10', '22:40', '给妈妈打电话', 'connect'),
    E('s1', '2026-10-20', '20:00', '21:30', '省下的时间', 'stillness', { state: 'kept', kept: 90, use: 'restore' }),
    E('s2', '2026-10-22', '20:00', '21:00', '静驻', 'stillness', { state: 'partial', kept: 120 }), // kept 120 > 预留 60 → 不计
    E('s3', '2026-10-24', '20:00', '21:00', '静驻', 'stillness', { state: 'reserved' }),
    E('s4', '2026-10-26', '20:00', '20:30', '静驻', 'stillness', { state: 'kept', kept: 30 }), // 无 use → 计入 stillness
    // 历史与期间外
    E('z1', '2026-11-02', '09:00', '10:00', '十一月的事', 'create'),
    // 无效条目（kind 不合法）→ 被 contracts 清洗丢弃
    E('j1', '2026-10-05', '10:00', '11:00', '坏条目', 'bogus'),
  ];
}

function octRelays() {
  return [
    R(UUID(1), '2026-10-05T01:30:00Z', 'paper-points', { rating: 'much', graduated: true, graduatedApp: 'deepseek' }),
    R(UUID(2), '2026-10-12T14:00:00Z', 'paper-points', { rating: 'little' }),
    R(UUID(3), '2026-10-20T15:00:00Z', 'meeting-notes', { rating: 'much' }),
    R(UUID(4), '2026-08-01T00:00:00Z', 'old-usage', { rating: 'none' }), // 历史
    R(UUID(5), '2026-10-22T02:00:00Z', 'meeting-notes', { failed: 'timeout' }), // 失败 → 不算使用
    R(UUID(6), '2026-10-03T00:00:00Z', 'paper-points', { graduated: true }), // 毕业但无 app → 不进第一次毕业
    R(UUID(7), '2026-10-25T00:00:00Z', 'zz-uncataloged'), // 成功、无自评、目录外
  ];
}

function prevChapterForOct() {
  var sepStats = computeStats(
    { period: { from: '2026-09-01', to: '2026-09-30' }, entries: sepEntries(), relays: [], usages: [] },
    { utcOffsetMinutes: 480 }
  );
  assert.ok(sepStats, '九月 stats 必须可生成');
  return createChapter(
    {
      no: 9,
      type: 'month',
      period: { from: '2026-09-01', to: '2026-09-30' },
      stats: sepStats,
      wish: { text: '希望十月能早点睡', category: 'sleep', at: '2026-09-30T20:00:00+08:00' },
    },
    { uuid: '20000000-0000-4000-8000-000000000009', now: Date.parse('2026-10-01T00:00:00Z') }
  );
}

function octInput() {
  return {
    period: { from: '2026-10-01', to: '2026-10-31' },
    entries: octEntries().concat(sepEntries()),
    relays: octRelays(),
    usages: [
      { id: 'paper-points', title: '论文 → 5 个要点' },
      { id: 'meeting-notes', title: '会议 → 重点和待办' },
    ],
    prevChapter: prevChapterForOct(),
  };
}

var TZ = { utcOffsetMinutes: 480 };

function hourly(expected) {
  var out = new Array(24).fill(0);
  for (var k in expected) out[Number(k)] = expected[k];
  return out;
}

// ---------------------------------------------------------------------------
// 主夹具：整章 deepEqual（回归钉）
// ---------------------------------------------------------------------------
test('十月主夹具：全部指标一次钉死且通过 validateStats', () => {
  var stats = computeStats(octInput(), TZ);
  assert.ok(stats, 'computeStats 应返回 stats');
  assert.ok(validateStats(stats), '输出必须能过 contracts.validateStats');
  assert.deepStrictEqual(stats, {
    totals: { events: 11, aiRelays: 3, prevEvents: 3, delta: 8 },
    kindMinutes: [
      { kind: 'necessary', minutes: 60, share: 0.071429 },
      { kind: 'create', minutes: 240, share: 0.285714 },
      { kind: 'connect', minutes: 210, share: 0.25 },
      { kind: 'explore', minutes: 90, share: 0.107143 },
      { kind: 'restore', minutes: 0, share: 0 },
      { kind: 'stillness', minutes: 240, share: 0.285714 },
    ],
    topDay: {
      date: '2026-10-05',
      events: 3,
      timeline: [
        { time: '08:30', title: '读懂一篇论文', ai: true },
        { time: '10:00', title: '组会', ai: false },
        { time: '19:00', title: '和室友吃火锅', ai: false },
      ],
      warmIndex: 2,
    },
    lessons: {
      learned: [
        // r6（毕业但没写应用）也是一次成功接力 → paper-points 用了 3 次
        { usageId: 'paper-points', title: '论文 → 5 个要点', count: 3 },
        { usageId: 'meeting-notes', title: '会议 → 重点和待办', count: 1 },
        { usageId: 'zz-uncataloged', title: 'zz-uncataloged', count: 1 },
      ],
      firstGraduation: { date: '2026-10-05', time: '09:30', app: 'deepseek' },
    },
    savedTime: {
      confirmedMinutes: 120,
      allocations: [
        { use: 'restore', minutes: 90 },
        { use: 'stillness', minutes: 30 },
      ],
    },
    rhythm: { hourly: hourly({ 8: 2, 10: 2, 19: 1, 20: 4, 22: 2 }), goldenHour: 20, genre: null },
    panels: [
      { label: '第 1 周', caption: '这一周没有记录' },
      { label: '第 2 周', caption: '本周 3 件事 · 1 次接力' },
      { label: '第 3 周', caption: '本周 4 件事 · 2 次接力' },
      { label: '第 4 周', caption: '本周 3 件事' },
      { label: '第 5 周', caption: '本周 1 件事' },
    ],
    keywords: [
      { word: '论文', weight: 2 },
      { word: '跑实验', weight: 1 },
      { word: '省下', weight: 1 },
      { word: '组会', weight: 1 },
      { word: '静驻', weight: 1 },
    ],
    wishEcho: {
      text: '希望十月能早点睡',
      reply: '本期有 7 天在 12 点前收工，上一期是 1 天。',
      matched: true,
      facts: [
        { label: '12点前收工', value: '7 天' },
        { label: '上一期', value: '1 天' },
      ],
    },
    song: {
      busyness: 0, // 本期每天 0.35 件，历史有记录的日子都更忙 → 分位 0
      mood: 0.6667, // 3 条带自评的成功接力里 2 条「省了不少」
      dominantKind: 'create', // 240 分钟与 stillness 并列 → 固定顺序在前
      weeklyCounts: [0, 3, 4, 3, 1],
      graduations: [1, 1, 0, 0, 0],
    },
  });
});

test('非法输入返回 null（period/结构）', () => {
  assert.strictEqual(computeStats(null, TZ), null);
  assert.strictEqual(computeStats({}, TZ), null);
  assert.strictEqual(
    computeStats({ period: { from: '2026-10-01', to: '2026-09-01' }, entries: [], relays: [], usages: [] }, TZ),
    null
  );
});

test('prevChapter 无效时按 null 处理：prevEvents/delta/wishEcho 为空', () => {
  var input = octInput();
  input.prevChapter = { junk: true };
  var stats = computeStats(input, TZ);
  assert.ok(stats);
  assert.strictEqual(stats.totals.prevEvents, null);
  assert.strictEqual(stats.totals.delta, null);
  assert.strictEqual(stats.wishEcho, null);
});

test('纯度：同样输入两次结果一致；条目/接力乱序结果一致', () => {
  var a = computeStats(octInput(), TZ);
  var b = computeStats(octInput(), TZ);
  assert.deepStrictEqual(a, b);
  var shuffled = octInput();
  shuffled.entries = shuffled.entries.slice().reverse();
  shuffled.relays = shuffled.relays.slice().reverse();
  shuffled.usages = shuffled.usages.slice().reverse();
  assert.deepStrictEqual(computeStats(shuffled, TZ), a);
});

// ---------------------------------------------------------------------------
// totals / kindMinutes / plannedMinutes
// ---------------------------------------------------------------------------
test('plannedMinutes：completion.before 优先，回退 end−start，负值为 0', () => {
  assert.strictEqual(plannedMinutes({ start: '08:30', end: '09:30', completion: { before: 60, actual: 45 } }), 60);
  assert.strictEqual(plannedMinutes({ start: '08:30', end: '09:30' }), 60);
  assert.strictEqual(plannedMinutes({ start: '10:00', end: '09:00' }), 0);
  assert.strictEqual(plannedMinutes({ start: '23:00', end: '24:00' }), 60);
  assert.strictEqual(plannedMinutes(null), 0);
});

test('期间边界：首尾两天都计入，期间外不计', () => {
  var stats = computeStats(
    {
      period: { from: '2026-10-01', to: '2026-10-31' },
      entries: [
        E('a', '2026-10-01', '09:00', '10:00', '第一天', 'create'),
        E('b', '2026-10-31', '21:00', '22:00', '最后一天', 'create'),
        E('c', '2026-09-30', '09:00', '10:00', '前一天', 'create'),
        E('d', '2026-11-01', '09:00', '10:00', '后一天', 'create'),
      ],
      relays: [],
      usages: [],
    },
    TZ
  );
  assert.strictEqual(stats.totals.events, 2);
  assert.strictEqual(stats.kindMinutes[1].minutes, 120); // create
});

// ---------------------------------------------------------------------------
// 省时：只统计本人确认过的（红线）
// ---------------------------------------------------------------------------
test('savedTime：kept/partial 且 kept 在 0..预留时长内才计；reserved/taken/超限不计', () => {
  var stats = computeStats(
    {
      period: { from: '2026-10-01', to: '2026-10-31' },
      entries: [
        E('a', '2026-10-02', '20:00', '21:00', '静驻', 'stillness', { state: 'kept', kept: 60, use: 'restore' }),
        E('b', '2026-10-03', '20:00', '21:00', '静驻', 'stillness', { state: 'partial', kept: 30, use: 'connect' }),
        E('c', '2026-10-04', '20:00', '21:00', '静驻', 'stillness', { state: 'reserved' }), // 未确认
        E('d', '2026-10-05', '20:00', '21:00', '静驻', 'stillness', { state: 'taken' }), // 让渡
        E('e', '2026-10-06', '20:00', '21:00', '静驻', 'stillness', { state: 'kept', kept: 90, use: 'restore' }), // 超出预留
        E('f', '2026-10-07', '20:00', '21:00', '静驻', 'stillness', { state: 'kept', kept: 45, use: 'bogus-use' }), // 非法 use → 整条被契约丢弃
        E('g', '2026-10-08', '20:00', '21:00', '普通事项', 'create'), // 非静驻不参与省时
      ],
      relays: [],
      usages: [],
    },
    TZ
  );
  assert.strictEqual(stats.totals.events, 6); // f 被清洗，g 正常计数
  assert.strictEqual(stats.savedTime.confirmedMinutes, 90); // 60+30
  assert.deepStrictEqual(stats.savedTime.allocations, [
    { use: 'restore', minutes: 60 },
    { use: 'connect', minutes: 30 },
  ]); // 分钟降序
});

// ---------------------------------------------------------------------------
// 时区：接力 at 的本地日归属
// ---------------------------------------------------------------------------
test('时区：同一条接力在 +8 属于 11 月、在 UTC 属于 10 月', () => {
  function input() {
    return {
      period: { from: '2026-11-01', to: '2026-11-30' },
      entries: [E('a', '2026-11-05', '09:00', '10:00', '读书', 'explore')],
      relays: [R(UUID(1), '2026-10-31T17:30:00Z', 'nov-usage', { rating: 'much' })],
      usages: [{ id: 'nov-usage', title: '新用法' }],
    };
  }
  var plus8 = computeStats(input(), { utcOffsetMinutes: 480 });
  var utc = computeStats(input(), { utcOffsetMinutes: 0 });
  assert.ok(plus8 && utc);
  // +8: 本地 2026-11-01 01:30 → 属于本期
  assert.deepStrictEqual(
    plus8.lessons.learned,
    [{ usageId: 'nov-usage', title: '新用法', count: 1 }]
  );
  assert.strictEqual(plus8.song.mood, 1);
  // UTC: 本地 2026-10-31 17:30 → 不属于本期
  assert.deepStrictEqual(utc.lessons.learned, []);
  assert.strictEqual(utc.song.mood, 0.5); // 无自评 → 中性 0.5
});

test('默认本地化器（运行环境时区）不抛错', () => {
  var stats = computeStats(
    {
      period: { from: '2026-11-01', to: '2026-11-30' },
      entries: [E('a', '2026-11-05', '09:00', '10:00', '读书', 'explore')],
      relays: [R(UUID(1), '2026-11-05T10:00:00Z', 'nov-usage')],
      usages: [{ id: 'nov-usage', title: '新用法' }],
    }
  );
  assert.ok(stats);
  assert.ok(validateStats(stats));
});

// ---------------------------------------------------------------------------
// 跨月 / 跨年 / 年章
// ---------------------------------------------------------------------------
test('跨月期间：两侧月份都计入，周切分跨月边界', () => {
  var stats = computeStats(
    {
      period: { from: '2026-11-20', to: '2026-12-15' },
      entries: [
        E('a', '2026-11-20', '09:00', '10:00', '十一月末', 'create'),
        E('b', '2026-11-30', '09:00', '10:00', '十一月最后', 'create'),
        E('c', '2026-12-01', '09:00', '10:00', '十二月第一', 'create'),
        E('d', '2026-12-15', '09:00', '10:00', '十二月最后', 'create'),
        E('e', '2026-11-19', '09:00', '10:00', '期间外', 'create'),
      ],
      relays: [],
      usages: [],
    },
    TZ
  );
  assert.strictEqual(stats.totals.events, 4);
  // 周一锚定：2026-11-16 起锚 → 11-20 当周 = 第 1 周（11-30/12-01 落第 3 周，12-15 落第 5 周）
  assert.strictEqual(stats.song.weeklyCounts.length, 5);
  assert.deepStrictEqual(stats.song.weeklyCounts, [1, 0, 2, 0, 1]);
  assert.ok(stats.panels.length >= 4 && stats.panels.length <= 5);
  assert.ok(validateStats(stats));
});

test('跨年期间：边界两侧都计入，周锚跨年正确', () => {
  var stats = computeStats(
    {
      period: { from: '2026-12-28', to: '2027-01-04' },
      entries: [
        E('a', '2026-12-28', '09:00', '10:00', '年末', 'create'),
        E('b', '2026-12-31', '09:00', '10:00', '除夕加班', 'create'),
        E('c', '2027-01-01', '09:00', '10:00', '元旦', 'connect'),
        E('d', '2027-01-04', '09:00', '10:00', '新年第一周', 'create'),
      ],
      relays: [],
      usages: [],
    },
    TZ
  );
  assert.strictEqual(stats.totals.events, 4);
  // 2026-12-28 是周一：恰好两整周 → [12-28..01-03, 01-04..01-10]
  assert.deepStrictEqual(stats.song.weeklyCounts, [3, 1]);
  assert.ok(validateStats(stats));
});

test('年章按日历月分四格；周年书跨 13 个月时并入第 12 格', () => {
  var year = computeStats(
    {
      period: { from: '2026-01-01', to: '2026-12-31' },
      entries: [
        E('a', '2026-02-14', '09:00', '10:00', '二月的事', 'connect'),
        E('b', '2026-11-11', '09:00', '10:00', '十一月的事', 'create'),
      ],
      relays: [],
      usages: [],
    },
    TZ
  );
  assert.strictEqual(year.panels.length, 12);
  assert.strictEqual(year.panels[0].label, '1 月');
  assert.strictEqual(year.panels[11].label, '12 月');
  assert.strictEqual(year.panels[1].caption, '本月 1 件事');

  var anniversary = computeStats(
    {
      period: { from: '2026-03-17', to: '2027-03-16' },
      entries: [
        E('a', '2027-03-10', '09:00', '10:00', '第十三个月的事', 'create'),
        E('b', '2026-06-01', '09:00', '10:00', '六月的事', 'explore'),
      ],
      relays: [],
      usages: [],
    },
    TZ
  );
  assert.strictEqual(anniversary.panels.length, 12);
  assert.strictEqual(anniversary.panels[11].label, '2–3 月');
  assert.strictEqual(anniversary.panels[11].caption, '本月 1 件事');
  assert.ok(validateStats(anniversary));
});

test('周切分 53 周上限：周年书（周日开始、闰年跨度）54 桶并入第 53 周', () => {
  // 2027-02-07(周日) → 2028-02-07(周一)：周一锚定天然 54 桶，契约上限 53
  var stats = computeStats(
    {
      period: { from: '2027-02-07', to: '2028-02-07' },
      entries: [
        E('a', '2027-02-07', '09:00', '10:00', '开始', 'create'),
        E('b', '2028-02-07', '09:00', '10:00', '结束', 'create'),
      ],
      relays: [],
      usages: [],
    },
    TZ
  );
  assert.strictEqual(stats.song.weeklyCounts.length, 53);
  assert.strictEqual(stats.song.weeklyCounts[0], 1);
  assert.strictEqual(stats.song.weeklyCounts[52], 1); // 第 54 周并入第 53 周
  assert.strictEqual(stats.song.graduations.length, 53);
  assert.ok(validateStats(stats));
});

// ---------------------------------------------------------------------------
// 零数据 / 只有 1 件事 / 短章判定
// ---------------------------------------------------------------------------
test('零数据：stats 仍然有效，空块按契约取空值', () => {
  var stats = computeStats(
    { period: { from: '2026-10-01', to: '2026-10-31' }, entries: [], relays: [], usages: [] },
    TZ
  );
  assert.ok(stats);
  assert.ok(validateStats(stats));
  assert.deepStrictEqual(stats.totals, { events: 0, aiRelays: 0, prevEvents: null, delta: null });
  assert.ok(stats.kindMinutes.every(function (r) { return r.minutes === 0 && r.share === 0; }));
  assert.strictEqual(stats.topDay, null);
  assert.deepStrictEqual(stats.lessons, { learned: [], firstGraduation: null });
  assert.strictEqual(stats.savedTime.confirmedMinutes, 0);
  assert.deepStrictEqual(stats.savedTime.allocations, []);
  assert.strictEqual(stats.rhythm.goldenHour, null);
  assert.strictEqual(stats.rhythm.genre, null);
  assert.ok(stats.rhythm.hourly.every(function (c) { return c === 0; }));
  assert.ok(stats.panels.length >= 1);
  assert.strictEqual(stats.panels[0].caption, '这一周没有记录');
  assert.deepStrictEqual(stats.keywords, []);
  assert.strictEqual(stats.wishEcho, null);
  assert.strictEqual(stats.song.busyness, 0.5); // 无历史 → 中性
  assert.strictEqual(stats.song.mood, 0.5); // 无自评 → 中性
  assert.strictEqual(stats.song.dominantKind, 'necessary'); // 零数据兜底
});

test('只有 1 件事：stats 有效，topDay 单条时间线，短章判定为 short', () => {
  var stats = computeStats(
    {
      period: { from: '2026-10-01', to: '2026-10-31' },
      entries: [E('only', '2026-10-05', '21:00', '22:00', '给妈妈打电话', 'connect')],
      relays: [],
      usages: [],
    },
    TZ
  );
  assert.ok(validateStats(stats));
  assert.strictEqual(stats.totals.events, 1);
  assert.strictEqual(stats.topDay.events, 1);
  assert.strictEqual(stats.topDay.timeline.length, 1);
  assert.strictEqual(stats.topDay.warmIndex, 0); // 唯一一条就是 connect
  assert.strictEqual(variantForEventCount(1), 'short');
});

test('variantForEventCount：<5 件 short，≥5 件 full，非法 null', () => {
  assert.strictEqual(SHORT_CHAPTER_MIN_EVENTS, 5);
  assert.strictEqual(variantForEventCount(0), 'short');
  assert.strictEqual(variantForEventCount(4), 'short');
  assert.strictEqual(variantForEventCount(5), 'full');
  assert.strictEqual(variantForEventCount(999), 'full');
  assert.strictEqual(variantForEventCount(null), null);
  assert.strictEqual(variantForEventCount(1.5), null);
  assert.strictEqual(variantForEventCount(-1), null);
});

// ---------------------------------------------------------------------------
// topDay 细节
// ---------------------------------------------------------------------------
test('topDay：并列取更早的一天；时间线按开始时间排序、上限 24 条', () => {
  var entries = [];
  for (var i = 0; i < 25; i++) {
    entries.push(E('d1-' + i, '2026-10-10', '0' + (i % 10) + ':' + (i % 60 < 10 ? '0' + (i % 60) : i % 60), '23:00', '第一天' + i, 'necessary'));
  }
  entries.push(E('d2-a', '2026-10-20', '09:00', '10:00', '第二天', 'necessary'));
  entries.push(E('d2-b', '2026-10-20', '10:00', '11:00', '第二天二', 'necessary'));
  var stats = computeStats(
    { period: { from: '2026-10-01', to: '2026-10-31' }, entries: entries, relays: [], usages: [] },
    TZ
  );
  // 10-10 有 25 条、10-20 有 2 条 → 最满一天 10-10；时间线截 24 条
  assert.strictEqual(stats.topDay.date, '2026-10-10');
  assert.strictEqual(stats.topDay.events, 25);
  assert.strictEqual(stats.topDay.timeline.length, 24);
  assert.strictEqual(stats.topDay.warmIndex, null); // 无 connect/restore
});

// ---------------------------------------------------------------------------
// lessons 细节
// ---------------------------------------------------------------------------
test('lessons：历史用过的用法不算新学会；失败接力不算使用', () => {
  var stats = computeStats(
    {
      period: { from: '2026-10-01', to: '2026-10-31' },
      entries: [E('a', '2026-10-05', '09:00', '10:00', '读书', 'explore')],
      relays: [
        R(UUID(1), '2026-09-01T00:00:00Z', 'old-friend', {}), // 9 月用过 → 不算新
        R(UUID(2), '2026-10-05T00:00:00Z', 'old-friend', {}), // 本期再用 → 使用次数 +1
        R(UUID(3), '2026-10-06T00:00:00Z', 'brand-new', { failed: 'upstream' }), // 失败 → 不算
        R(UUID(4), '2026-10-07T00:00:00Z', 'brand-new', {}), // 成功 → 新学会、次数 1
        R(UUID(5), '2026-10-08T00:00:00Z', null, {}), // v1 迁移无 usageId → 跳过
      ],
      usages: [{ id: 'old-friend', title: '老用法' }, { id: 'brand-new', title: '新用法' }],
    },
    TZ
  );
  assert.deepStrictEqual(stats.lessons.learned, [
    { usageId: 'brand-new', title: '新用法', count: 1 },
  ]);
  assert.strictEqual(stats.lessons.firstGraduation, null);
});

// ---------------------------------------------------------------------------
// rhythm / busyness / mood / dominantKind
// ---------------------------------------------------------------------------
test('hourly：24:00 开始计入 23 点档；goldenHour 并列取更早', () => {
  var stats = computeStats(
    {
      period: { from: '2026-10-01', to: '2026-10-31' },
      entries: [
        E('a', '2026-10-02', '24:00', '24:00', '跨零点', 'necessary'),
        E('b', '2026-10-03', '20:00', '21:00', '晚上甲', 'create'),
        E('c', '2026-10-04', '20:00', '21:00', '晚上乙', 'create'),
        E('d', '2026-10-05', '22:00', '23:00', '夜里甲', 'create'),
        E('e', '2026-10-06', '22:00', '23:00', '夜里乙', 'create'),
      ],
      relays: [],
      usages: [],
    },
    TZ
  );
  assert.strictEqual(stats.rhythm.hourly[23], 1);
  assert.strictEqual(stats.rhythm.hourly[20], 2);
  assert.strictEqual(stats.rhythm.hourly[22], 2);
  assert.strictEqual(stats.rhythm.goldenHour, 20); // 20 与 22 并列 → 取更早
});

test('busyness：本期日均在历史逐日分布中的分位；无历史 0.5；只用期间前数据', () => {
  function build(extra) {
    var entries = [];
    // 历史：5 个有记录的日子 [1,1,2,2,3]
    [['2026-09-01', 1], ['2026-09-02', 1], ['2026-09-03', 2], ['2026-09-04', 2], ['2026-09-05', 3]].forEach(function (d) {
      for (var i = 0; i < d[1]; i++) entries.push(E('h' + d[0] + i, d[0], '09:00', '10:00', '历史', 'necessary'));
    });
    // 本期 7 天 8 件 → 日均 1.1428；历史 ≤1.1428 的日子：两个 1 → 0.4
    for (var j = 0; j < 8; j++) {
      entries.push(E('p' + j, '2026-10-0' + ((j % 7) + 1), '09:00', '10:00', '本期', 'necessary'));
    }
    (extra || []).forEach(function (e) { entries.push(e); });
    return { period: { from: '2026-10-01', to: '2026-10-07' }, entries: entries, relays: [], usages: [] };
  }
  assert.strictEqual(computeStats(build(), TZ).song.busyness, 0.4);
  // 期间之后的数据不进历史分布
  assert.strictEqual(
    computeStats(build([E('f1', '2026-12-01', '09:00', '10:00', '未来', 'necessary')]), TZ).song.busyness,
    0.4
  );
  // 无历史（首章）→ 中性
  var first = computeStats(
    {
      period: { from: '2026-10-01', to: '2026-10-07' },
      entries: [E('a', '2026-10-01', '09:00', '10:00', '唯一', 'necessary')],
      relays: [],
      usages: [],
    },
    TZ
  );
  assert.strictEqual(first.song.busyness, 0.5);
});

test('mood：分母只算带自评的成功接力', () => {
  var stats = computeStats(
    {
      period: { from: '2026-10-01', to: '2026-10-31' },
      entries: [E('a', '2026-10-05', '09:00', '10:00', '读书', 'explore')],
      relays: [
        R(UUID(1), '2026-10-05T00:00:00Z', 'u1', { rating: 'much' }),
        R(UUID(2), '2026-10-06T00:00:00Z', 'u1', { rating: 'none' }),
        R(UUID(3), '2026-10-07T00:00:00Z', 'u1', { failed: 'timeout', rating: 'much' }), // 失败 → 出局
        R(UUID(4), '2026-10-08T00:00:00Z', 'u1', {}), // 无自评 → 出局
      ],
      usages: [{ id: 'u1', title: '用法' }],
    },
    TZ
  );
  assert.strictEqual(stats.song.mood, 0.5); // 1/2
});

test('dominantKind：零计划时长按条目数；完全零数据兜底 necessary', () => {
  var zeroDur = computeStats(
    {
      period: { from: '2026-10-01', to: '2026-10-31' },
      entries: [
        E('a', '2026-10-02', '09:00', '09:00', '零时长甲', 'restore'), // 时长 0
        E('b', '2026-10-03', '09:00', '09:00', '零时长乙', 'restore'),
        E('c', '2026-10-04', '10:00', '09:00', '负时长', 'create'), // 时长 0
      ],
      relays: [],
      usages: [],
    },
    TZ
  );
  assert.strictEqual(zeroDur.song.dominantKind, 'restore'); // 全 0 分钟 → 按条目数
  var empty = computeStats(
    { period: { from: '2026-10-01', to: '2026-10-31' }, entries: [], relays: [], usages: [] },
    TZ
  );
  assert.strictEqual(empty.song.dominantKind, 'necessary');
});

// ---------------------------------------------------------------------------
// wishEcho：可量化心愿用数据回应，不可量化只温柔复述
// ---------------------------------------------------------------------------
function chapterWithWish(category, text, period) {
  var stats = computeStats(
    { period: period, entries: [], relays: [], usages: [] },
    TZ
  );
  return createChapter(
    { no: 1, type: 'month', period: period, stats: stats, wish: { text: text, category: category } },
    { uuid: '30000000-0000-4000-8000-000000000001', now: Date.parse('2026-10-01T00:00:00Z') }
  );
}

test('wishEcho：运动心愿回应恢复类时长（本期 vs 上一期）', () => {
  var input = {
    period: { from: '2026-10-01', to: '2026-10-31' },
    entries: [
      E('r1', '2026-10-05', '07:00', '08:00', '晨跑', 'restore'),
      E('r2', '2026-10-12', '07:00', '07:30', '拉伸', 'restore'),
      E('n1', '2026-10-06', '09:00', '10:00', '组会', 'necessary'),
    ],
    relays: [],
    usages: [],
    prevChapter: (function () {
      var prev = chapterWithWish('exercise', '十月想多运动', { from: '2026-09-01', to: '2026-09-30' });
      return prev;
    })(),
  };
  var stats = computeStats(input, TZ);
  assert.ok(stats.wishEcho);
  assert.strictEqual(stats.wishEcho.matched, true);
  assert.strictEqual(stats.wishEcho.text, '十月想多运动');
  assert.deepStrictEqual(stats.wishEcho.facts, [
    { label: '恢复类时间', value: '1.5 小时' },
    { label: '上一期', value: '0 小时' },
  ]);
  assert.ok(stats.wishEcho.reply.indexOf('1.5 小时') >= 0);
  assert.ok(stats.wishEcho.reply.length <= 120);
});

test('wishEcho：不可量化心愿只温柔复述，不编数据', () => {
  var input = {
    period: { from: '2026-10-01', to: '2026-10-31' },
    entries: [E('a', '2026-10-05', '09:00', '10:00', '读书', 'explore')],
    relays: [],
    usages: [],
    prevChapter: chapterWithWish('other', '想把日子过慢一点', { from: '2026-09-01', to: '2026-09-30' }),
  };
  var echo = computeStats(input, TZ).wishEcho;
  assert.strictEqual(echo.matched, false);
  assert.deepStrictEqual(echo.facts, []);
  assert.ok(echo.reply.indexOf('想把日子过慢一点') >= 0);
  assert.ok(echo.reply.length <= 120);
});

test('wishEcho：学习/陪伴心愿的事实与上一章无 wish 时不回应', () => {
  var learning = computeStats(
    {
      period: { from: '2026-10-01', to: '2026-10-31' },
      entries: [
        E('a', '2026-10-05', '09:00', '11:00', '读论文', 'explore'),
        E('b', '2026-10-06', '19:00', '20:00', '和家人吃饭', 'connect'),
      ],
      relays: [R(UUID(1), '2026-10-05T02:00:00Z', 'u1', {}), R(UUID(2), '2026-10-06T02:00:00Z', 'u2', {})],
      usages: [{ id: 'u1', title: '用法一' }, { id: 'u2', title: '用法二' }],
      prevChapter: chapterWithWish('learning', '十月想学会新用法', { from: '2026-09-01', to: '2026-09-30' }),
    },
    TZ
  ).wishEcho;
  assert.strictEqual(learning.matched, true);
  assert.deepStrictEqual(learning.facts, [
    { label: '新用法', value: '2 个' },
    { label: '探索类时间', value: '2 小时' },
  ]);

  var company = computeStats(
    {
      period: { from: '2026-10-01', to: '2026-10-31' },
      entries: [
        E('a', '2026-10-05', '09:00', '11:00', '读论文', 'explore'),
        E('b', '2026-10-06', '19:00', '20:00', '和家人吃饭', 'connect'),
      ],
      relays: [],
      usages: [],
      prevChapter: chapterWithWish('company', '十月多陪家人', { from: '2026-09-01', to: '2026-09-30' }),
    },
    TZ
  ).wishEcho;
  assert.strictEqual(company.matched, true);
  assert.deepStrictEqual(company.facts, [
    { label: '连接类时间', value: '1 小时' },
    { label: '上一期', value: '0 小时' },
  ]);

  var noWish = computeStats(
    {
      period: { from: '2026-10-01', to: '2026-10-31' },
      entries: [E('a', '2026-10-05', '09:00', '10:00', '读书', 'explore')],
      relays: [],
      usages: [],
      prevChapter: (function () {
        var stats = computeStats(
          { period: { from: '2026-09-01', to: '2026-09-30' }, entries: [], relays: [], usages: [] },
          TZ
        );
        return createChapter(
          { no: 8, type: 'month', period: { from: '2026-09-01', to: '2026-09-30' }, stats: stats },
          { uuid: '30000000-0000-4000-8000-000000000008', now: Date.parse('2026-10-01T00:00:00Z') }
        );
      })(),
    },
    TZ
  ).wishEcho;
  assert.strictEqual(noWish, null);
});

// ---------------------------------------------------------------------------
// 关键词引擎（纯函数直测）
// ---------------------------------------------------------------------------
test('topKeywords：同标题去重、长标题片段需出现≥2次、去包含重复', () => {
  var out = topKeywords(
    ['读懂一篇论文', '组会', '和室友吃火锅', '给妈妈打电话', '跑实验', '写论文引言', '省下的时间', '静驻'],
    6
  );
  assert.deepStrictEqual(out, [
    { word: '论文', weight: 2 },
    { word: '跑实验', weight: 1 },
    { word: '省下', weight: 1 },
    { word: '组会', weight: 1 },
    { word: '静驻', weight: 1 },
  ]);
  // 同一标题重复出现只计一次
  var dup = topKeywords(['每天跑步', '每天跑步', '每天跑步'], 6);
  assert.deepStrictEqual(dup, [{ word: '每天跑步', weight: 1 }]);
  // 相互包含：保留先选出的更优候选（「电话」被「打电话」包含而淘汰）
  var contain = topKeywords(['打电话给妈妈', '打电话回家', '电话'], 1);
  assert.deepStrictEqual(contain, [{ word: '打电话', weight: 2 }]);
});

test('topKeywords：英文单词与混合标题', () => {
  var out = topKeywords(['用 gpt 改论文', 'gpt 写周报', '读 paper'], 6);
  assert.strictEqual(out[0].word, 'gpt');
  assert.strictEqual(out[0].weight, 2);
  var words = out.map(function (k) { return k.word; });
  assert.ok(words.indexOf('paper') >= 0);
  assert.ok(words.indexOf('写周报') >= 0);
  assert.ok(words.indexOf('改论文') >= 0);
});

test('topKeywords：空输入返回空；limit 夹在 1..10', () => {
  assert.deepStrictEqual(topKeywords([], 6), []);
  assert.deepStrictEqual(topKeywords(null, 6), []);
  assert.strictEqual(topKeywords(['甲乙丙', '甲乙丙'], 99).length, 1);
  assert.strictEqual(topKeywords(['甲乙丙'], 0).length, 1);
});

// ---------------------------------------------------------------------------
// 周记（span ≤ 10 天单桶）与周内章
// ---------------------------------------------------------------------------
test('周记期间：panels 单桶「本期」，weeklyCounts 单桶', () => {
  var stats = computeStats(
    {
      period: { from: '2026-10-05', to: '2026-10-11' },
      entries: [
        E('a', '2026-10-05', '09:00', '10:00', '周一的事', 'create'),
        E('b', '2026-10-07', '09:00', '10:00', '周三的事', 'create', { ai: { used: true } }),
        E('c', '2026-10-11', '09:00', '10:00', '周日的事', 'restore'),
      ],
      relays: [],
      usages: [],
    },
    TZ
  );
  assert.deepStrictEqual(stats.panels, [{ label: '本期', caption: '本期 3 件事 · 1 次接力' }]);
  assert.deepStrictEqual(stats.song.weeklyCounts, [3]);
  assert.ok(validateStats(stats));
});
