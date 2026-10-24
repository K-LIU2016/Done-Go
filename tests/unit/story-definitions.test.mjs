import assert from 'node:assert/strict';
import { test } from 'node:test';

// T1 统计线：web/story/definitions.js 是每个指标的口径卡文本（SPEC §1.3 求真：
// 每个数字都可以长按查看口径和数据来源——数据源、计算方式、样本数）。
// 口径卡与数据一一对应（红线）：definitions 的键必须恰好覆盖 stats 的全部
// 块与 song 子字段，不多不少；文本里不得出现「留白」。
import { METRIC_DEFINITIONS, definitionFor, definitionKeys } from '../../web/story/definitions.js';
import { computeStats } from '../../web/story/stats.js';

// 键语法对齐 contracts.js 内部的 METRIC_KEY_RE（未导出；此处仅校验用，不重定义数据）
var METRIC_KEY_RE = /^[a-zA-Z][a-zA-Z0-9.]{0,39}$/;

var EXPECTED_KEYS = [
  'totals',
  'totals.events',
  'totals.aiRelays',
  'totals.prevEvents',
  'totals.delta',
  'kindMinutes',
  'topDay',
  'topDay.warmIndex',
  'lessons',
  'lessons.firstGraduation',
  'savedTime',
  'savedTime.allocations',
  'rhythm',
  'rhythm.hourly',
  'rhythm.goldenHour',
  'rhythm.genre',
  'panels',
  'keywords',
  'wishEcho',
  'song',
  'song.busyness',
  'song.mood',
  'song.dominantKind',
  'song.weeklyCounts',
  'song.graduations',
  'variant',
];

test('口径卡与数据一一对应：键集合恰好等于 stats 块 + song 子字段 + variant', () => {
  assert.deepEqual(definitionKeys().sort(), EXPECTED_KEYS.slice().sort());
});

test('每个口径四要素齐全：标题/数据源/计算方式/样本数', () => {
  for (var key of definitionKeys()) {
    var d = definitionFor(key);
    assert.ok(d, key);
    assert.equal(typeof d.title, 'string');
    assert.ok(d.title.length >= 1 && d.title.length <= 16, key + ' title 长度 1..16: ' + d.title);
    assert.equal(typeof d.source, 'string');
    assert.ok(d.source.length >= 4, key + ' source 非空');
    assert.equal(typeof d.method, 'string');
    assert.ok(d.method.length >= 8, key + ' method 非空');
    assert.equal(typeof d.samples, 'string');
    assert.ok(d.samples.length >= 2, key + ' samples 非空');
    // 键名可作 poster metricKeys（同 contracts 键语法）
    assert.ok(METRIC_KEY_RE.test(key), key);
  }
});

test('未知键返回 null；METRIC_DEFINITIONS 与 definitionFor 一致', () => {
  assert.strictEqual(definitionFor('nope'), null);
  assert.strictEqual(definitionFor('totals.nope'), null);
  for (var key of definitionKeys()) {
    assert.deepEqual(METRIC_DEFINITIONS[key], definitionFor(key), key);
  }
});

test('文案红线：不出现「留白」，不出现与他人比较/夸大句式', () => {
  for (var key of definitionKeys()) {
    var d = definitionFor(key);
    var all = d.title + d.source + d.method + d.samples;
    assert.ok(all.indexOf('留白') < 0, key + ' 不得出现「留白」');
    assert.ok(all.indexOf('%的人') < 0 && all.indexOf('击败') < 0, key + ' 不得出现与他人比较');
  }
});

test('省时口径必须写明只统计本人确认过的', () => {
  var d = definitionFor('savedTime');
  assert.ok(d.method.indexOf('本人确认') >= 0, 'savedTime.method 必须含「本人确认」');
  assert.ok(d.method.indexOf('kept') >= 0 || d.method.indexOf('确认') >= 0);
});

test('与真实 stats 对齐：computed stats 的每个顶层块与 song 子字段都有口径', () => {
  var stats = computeStats(
    {
      period: { from: '2026-10-01', to: '2026-10-31' },
      entries: [
        { id: 'e1', date: '2026-10-05', start: '09:00', end: '10:00', title: '读书', kind: 'explore' },
        { id: 's1', date: '2026-10-06', start: '20:00', end: '21:00', title: '静驻', kind: 'stillness', state: 'kept', kept: 60 },
      ],
      relays: [],
      usages: [],
    },
    { utcOffsetMinutes: 480 }
  );
  assert.ok(stats);
  for (var block of Object.keys(stats)) assert.ok(definitionFor(block), '块缺少口径: ' + block);
  for (var sub of Object.keys(stats.song)) assert.ok(definitionFor('song.' + sub), 'song 子字段缺少口径: song.' + sub);
});

test('流派口径如实说明：同频算法未落地，本章为空，不自行变通', () => {
  var d = definitionFor('rhythm.genre');
  assert.ok(d.method.indexOf('同频') >= 0);
  assert.ok(d.method.indexOf('暂') >= 0 || d.method.indexOf('待') >= 0);
});

test('短章口径写明阈值与「不硬凑」', () => {
  var d = definitionFor('variant');
  assert.ok(d.method.indexOf('5') >= 0);
  assert.ok(d.method.indexOf('不硬凑') >= 0 || d.method.indexOf('短章') >= 0);
});
