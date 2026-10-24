import assert from 'node:assert/strict';
import { test } from 'node:test';

// S1·特征提取 line: web/social/features-client.js computes the PRD §3.1
// weekly features from LOCAL data only (schedule entries, relay v2 records)
// and hands the aggregation to the upload whitelist in
// web/social/contracts.js. Hard gates proven here:
//
// - D2 隐私红线：事项标题、材料/事件原话、AI 结果、具体时间（HH:MM 与
//   完整日期、记录时间戳）绝不出现在 features、上传 payload 或请求体
//   字符串里 —— 用诱饵字符串 + 深度遍历双向证明（字符串白名单 + 键白名单）。
// - 白名单是拒绝制不是剥离制：往 features 里塞 FORBIDDEN_UPLOAD_FIELDS
//   的任何字段，featuresUploadPayload/featuresUploadBody 一律返回 null。
// - 聚合口径写死并可解释：kindMix=时长加权（沿用 index.html mix()）、
//   rhythm=开始时段条数占比、freedTo 只算「空出来的时间」（from 关联的
//   静驻预留），freedMinutesConfirmed 只算本人确认的 kept 分钟。

import {
  FEATURES_UPLOAD_FIELDS, FORBIDDEN_UPLOAD_FIELDS, FEATURES_USAGES_MAX,
  KIND_MIX_KEYS, RHYTHM_KEYS, FREED_TO_KEYS, RATINGS, isIsoWeek,
} from '../../web/social/contracts.js';
import {
  isoWeekOfDate, weekDates, rhythmBandOf, freedToBucket,
  computeWeeklyFeatures, featuresUploadPayload, featuresUploadBody,
} from '../../web/social/features-client.js';

const WEEK = '2026-W43'; // Mon 2026-10-19 .. Sun 2026-10-25

// ---------------------------------------------------------------------------
// fixtures — 本地原始数据形状（web/index.html 条目 + web/relay/contracts.js 记录）。
// SECRET 诱饵：任何聚合输出里出现即失败。
// ---------------------------------------------------------------------------
function task(id, date, start, end, kind, title) {
  return { id, date, title, start, end, prio: 3, kind, done: false };
}
// 记录的 at 必须用「本地时间构造 → toISOString」生成，任何时区的测试机往返一致。
function rec(day, minute, usageId, extra) {
  const at = new Date(2026, 9, day, 21, minute).toISOString();
  return Object.assign({
    id: 'rec-' + day + '-' + minute, at,
    event: 'SECRET-事件原话-' + day + '-' + minute,
    usageId, result: 'SECRET-AI结果-' + day + '-' + minute,
    rating: null, graduated: false, graduatedApp: null, failed: null,
  }, extra || {});
}

const ENTRIES = [
  task('entry:a', '2026-10-19', '08:30', '09:30', 'necessary', 'SECRET-标题-组会纪要'),
  task('entry:b', '2026-10-19', '22:00', '23:00', 'create', 'SECRET-标题-论文引言'),
  task('entry:c', '2026-10-20', '10:00', '12:00', 'explore', 'SECRET-标题-读文献'),
  { id: 'entry:f1', date: '2026-10-21', title: '陪家人吃饭', kind: 'stillness', start: '18:00', end: '19:00', prio: 3, state: 'kept', kept: 45, use: 'connect', note: 'SECRET-备注', intent: 'SECRET-意图', from: 'entry:a' },
  { id: 'entry:f2', date: '2026-10-22', title: '午睡', kind: 'stillness', start: '13:00', end: '14:00', prio: 3, state: 'partial', kept: 30, use: 'restore', from: 'entry:b' },
  { id: 'entry:f3', date: '2026-10-23', title: '晨跑', kind: 'stillness', start: '07:00', end: '08:00', prio: 3, state: 'reserved', kept: 0, use: 'restore', from: 'entry:c' },
  { id: 'entry:f4', date: '2026-10-24', title: '被占用SECRET', kind: 'stillness', start: '09:00', end: '10:00', prio: 3, state: 'taken', kept: 0, use: null, from: 'entry:a' },
  // 上周（W42 周日）与坏数据一律不进聚合；id 与 entry:a 重复 → 去重保首个。
  task('entry:x', '2026-10-18', '09:00', '10:00', 'necessary', 'SECRET-标题-上周'),
  task('entry:a', '2026-10-19', '08:30', '09:30', 'necessary', 'SECRET-标题-重复'),
  { id: 'entry:bad', date: '2026-10-21', title: '坏数据', start: '10:00', end: '11:00', prio: 3, kind: 'party', done: false },
];

const RECORDS = [
  rec(19, 5, 'meeting-notes', { rating: 'much' }),
  rec(20, 6, 'paper-5points', { graduated: true }),
  rec(21, 7, 'meeting-notes', { rating: 'little' }), // 用法去重
  rec(22, 8, null),                                  // v1 迁移记录：无用法 id
  rec(23, 9, 'failed-usage', { failed: 'timeout', rating: 'none' }), // 失败接力
  rec(17, 10, 'last-week-usage', { graduated: true }), // 上周
];

function computeFixture() {
  return computeWeeklyFeatures({ entries: ENTRIES, records: RECORDS }, { week: WEEK });
}

function closeTo(a, b, eps) { return Math.abs(a - b) <= (eps || 1e-9); }

// ---------------------------------------------------------------------------
// ISO 周数学（纯函数，UTC 字符串运算，任何时区结果一致）。
// ---------------------------------------------------------------------------
test('isoWeekOfDate：跨年边界与常规周', () => {
  assert.equal(isoWeekOfDate('2026-10-19'), '2026-W43');
  assert.equal(isoWeekOfDate('2026-10-25'), '2026-W43');
  assert.equal(isoWeekOfDate('2026-01-01'), '2026-W01'); // 周四
  assert.equal(isoWeekOfDate('2025-12-29'), '2026-W01'); // 周一，属 2026 第 1 周
  assert.equal(isoWeekOfDate('2026-12-28'), '2026-W53'); // 2026 有 53 周
  assert.equal(isoWeekOfDate('2027-01-01'), '2026-W53'); // 周五，仍属上年末周
  assert.equal(isoWeekOfDate('2024-12-29'), '2024-W52'); // 周日，2024 共 52 周
  assert.equal(isoWeekOfDate('2024-01-01'), '2024-W01'); // 周一
});

test('isoWeekOfDate：非法输入返回 null', () => {
  for (const bad of ['2026-13-01', '2026-02-30', '2026-2-3', 'not-a-date', '', null, 42]) {
    assert.equal(isoWeekOfDate(bad), null, 'input: ' + bad);
  }
});

test('weekDates：周一起步、周日收尾、不存在周返回 null', () => {
  const dates = weekDates('2026-W43');
  assert.equal(dates.length, 7);
  assert.equal(dates[0], '2026-10-19');
  assert.equal(dates[6], '2026-10-25');
  assert.deepEqual(weekDates('2026-W53'), [
    '2026-12-28', '2026-12-29', '2026-12-30', '2026-12-31', '2027-01-01', '2027-01-02', '2027-01-03',
  ]);
  assert.equal(weekDates('2025-W53'), null); // 2025 只有 52 周
  assert.equal(weekDates('2026-W54'), null); // 越界周号
  assert.equal(weekDates('bad'), null);
});

// ---------------------------------------------------------------------------
// rhythm 时段带（PRD §3.3「晚上 10 点后」→ night 从 22:00 起）。
// ---------------------------------------------------------------------------
test('rhythmBandOf：边界值落在正确时段', () => {
  const cases = [
    ['04:59', 'night'], ['00:00', 'night'], ['23:30', 'night'], ['24:00', 'night'],
    ['05:00', 'dawn'], ['07:59', 'dawn'],
    ['08:00', 'morning'], ['11:59', 'morning'],
    ['12:00', 'afternoon'], ['17:59', 'afternoon'],
    ['18:00', 'evening'], ['21:59', 'evening'],
    ['22:00', 'night'],
  ];
  for (const [hm, band] of cases) assert.equal(rhythmBandOf(hm), band, hm);
  assert.equal(rhythmBandOf(''), null);
  assert.equal(rhythmBandOf('25:00'), null);
  assert.equal(rhythmBandOf('7:00'), null);
  assert.equal(rhythmBandOf(null), null);
});

// ---------------------------------------------------------------------------
// freedTo 归桶：关键词优先于本地 use 枚举，兜底 other。
// ---------------------------------------------------------------------------
test('freedToBucket：关键词分类与枚举兜底', () => {
  assert.equal(freedToBucket('陪家人吃饭', 'connect'), 'family');
  assert.equal(freedToBucket('打电话给妈妈', null), 'family');
  assert.equal(freedToBucket('晨跑', 'restore'), 'exercise'); // 关键词压过 restore→rest
  assert.equal(freedToBucket('打篮球', null), 'exercise');
  assert.equal(freedToBucket('读懂论文', 'explore'), 'study');
  assert.equal(freedToBucket('学英语', null), 'study');
  assert.equal(freedToBucket('午睡', null), 'rest');
  assert.equal(freedToBucket('冥想', 'stillness'), 'rest');
  assert.equal(freedToBucket('画画', 'create'), 'hobby');
  assert.equal(freedToBucket('看电影', null), 'hobby');
  assert.equal(freedToBucket('写周报', 'necessary'), 'other'); // 工作类去向 → other
  assert.equal(freedToBucket('', null), 'other');
  assert.equal(freedToBucket(null, 'connect'), 'family');   // 枚举兜底
  assert.equal(freedToBucket(null, 'restore'), 'rest');
  assert.equal(freedToBucket(null, 'explore'), 'study');
  assert.equal(freedToBucket(null, 'create'), 'hobby');
  assert.equal(freedToBucket(null, 'necessary'), 'other');
  assert.equal(freedToBucket(null, 'stillness'), 'rest');
  assert.equal(freedToBucket(null, '神秘用途'), 'other');
});

// ---------------------------------------------------------------------------
// 核心聚合：每周 features 的每个数字都有口径。
// ---------------------------------------------------------------------------
test('computeWeeklyFeatures：聚合值精确（时长加权 kindMix / 条数 rhythm / 去重 usages）', () => {
  const result = computeFixture();
  assert.equal(result.ok, true);
  const f = result.features;
  assert.equal(f.week, WEEK);

  // kindMix（分钟）：a 60 necessary + b 60 create + c 120 explore
  // + f1 kept45 connect + f2 kept30 restore（沿用 index.html mix() 口径，
  // reserved/taken 静驻不计、无 from 的日常静驻没有 kept 也不计）→ 共 315。
  const T = 315;
  assert.ok(closeTo(f.kindMix.necessary, 60 / T));
  assert.ok(closeTo(f.kindMix.create, 60 / T));
  assert.ok(closeTo(f.kindMix.explore, 120 / T));
  assert.ok(closeTo(f.kindMix.connect, 45 / T));
  assert.ok(closeTo(f.kindMix.restore, 30 / T));
  assert.ok(closeTo(f.kindMix.stillness, 0));

  // rhythm（条数）：morning 3（a、c、f4）、night 1（b）、evening 1（f1）、
  // afternoon 1（f2）、dawn 1（f3）→ 共 7（重复 id 与坏条目不计）。
  assert.ok(closeTo(f.rhythm.morning, 3 / 7));
  assert.ok(closeTo(f.rhythm.night, 1 / 7));
  assert.ok(closeTo(f.rhythm.evening, 1 / 7));
  assert.ok(closeTo(f.rhythm.afternoon, 1 / 7));
  assert.ok(closeTo(f.rhythm.dawn, 1 / 7));

  // usages：去重、保序、失败接力与上周不算、v1 迁移的 null 不算。
  assert.deepEqual(f.usages, ['meeting-notes', 'paper-5points']);

  // relays：只数成功（failed == null）的本周记录 = 4；毕业 = 1。
  assert.equal(f.relays, 4);
  assert.equal(f.graduations, 1);

  // rating：只数成功记录上的自评。
  assert.deepEqual(f.rating, { much: 1, little: 1, none: 0 });

  // freedTo：f1 kept45 family + f3 reserved60 exercise + f2 kept30 rest → 135。
  const F = 135;
  assert.ok(closeTo(f.freedTo.family, 45 / F));
  assert.ok(closeTo(f.freedTo.exercise, 60 / F));
  assert.ok(closeTo(f.freedTo.rest, 30 / F));
  assert.ok(closeTo(f.freedTo.study, 0));
  assert.ok(closeTo(f.freedTo.hobby, 0));
  assert.ok(closeTo(f.freedTo.other, 0));

  // freedMinutesConfirmed：只算 kept/partial 确认分钟（45+30）。
  assert.equal(f.freedMinutesConfirmed, 75);

  // 占比总和恰为 1（合同容差 1e-6，这里更严）。
  for (const map of [f.kindMix, f.rhythm, f.freedTo]) {
    const sum = Object.keys(map).reduce((s, k) => s + map[k], 0);
    assert.ok(Math.abs(sum - 1) < 1e-9, 'sum=' + sum);
  }
});

test('computeWeeklyFeatures：freedTo 只认「空出来的时间」（from 关联静驻）', () => {
  const noFreed = ENTRIES.filter((e) => !e.from); // 去掉 f1..f4
  const result = computeWeeklyFeatures({ entries: noFreed, records: RECORDS }, { week: WEEK });
  assert.equal(result.ok, false);
  assert.deepEqual(result.missing, ['freedTo']);
  assert.equal(featuresUploadPayload(result), null);
});

test('computeWeeklyFeatures：空周明确拒绝，不造任何假占比', () => {
  const empty = computeWeeklyFeatures({ entries: [], records: [] }, { week: WEEK });
  assert.equal(empty.ok, false);
  assert.equal(empty.reason, 'insufficient-data');
  assert.ok(empty.missing.includes('kindMix'));
  assert.ok(empty.missing.includes('rhythm'));
  assert.ok(empty.missing.includes('freedTo'));

  const otherWeek = computeWeeklyFeatures({ entries: ENTRIES, records: RECORDS }, { week: '2026-W42' });
  assert.equal(otherWeek.ok, false);

  const noEntries = computeWeeklyFeatures({ entries: [], records: RECORDS }, { week: WEEK });
  assert.equal(noEntries.ok, false);
  assert.ok(noEntries.missing.includes('kindMix'));
  assert.equal(featuresUploadPayload(noEntries), null);
  assert.equal(featuresUploadBody(noEntries), null);
});

test('computeWeeklyFeatures：等分占比残差修正后总和恰为 1', () => {
  const quarters = [
    task('t1', '2026-10-19', '09:00', '10:00', 'necessary', 'SECRET-A'),
    task('t2', '2026-10-20', '09:00', '10:00', 'create', 'SECRET-B'),
    task('t3', '2026-10-21', '09:00', '10:00', 'explore', 'SECRET-C'),
    { id: 't4', date: '2026-10-22', title: '散步', kind: 'stillness', start: '07:00', end: '08:00', prio: 3, state: 'kept', kept: 60, use: 'restore', from: 't1' },
  ];
  const result = computeWeeklyFeatures({ entries: quarters, records: [] }, { week: WEEK });
  assert.equal(result.ok, true);
  for (const k of ['necessary', 'create', 'explore', 'restore']) {
    assert.ok(closeTo(result.features.kindMix[k], 0.25), k);
  }
  assert.ok(closeTo(result.features.freedTo.exercise, 1)); // 散步 → exercise
  assert.equal(result.features.freedMinutesConfirmed, 60);
});

test('computeWeeklyFeatures：usages 封顶 FEATURES_USAGES_MAX', () => {
  const many = [];
  for (let i = 0; i < FEATURES_USAGES_MAX + 5; i += 1) {
    many.push(rec(19 + Math.floor(i / 60), i % 60, 'u' + String(i).padStart(3, '0')));
  }
  const entries = [
    task('m1', '2026-10-19', '09:00', '10:00', 'necessary', 'SECRET-M'),
    { id: 'm2', date: '2026-10-20', title: '跑步', kind: 'stillness', start: '07:00', end: '08:00', prio: 3, state: 'kept', kept: 60, use: 'restore', from: 'm1' },
  ];
  const result = computeWeeklyFeatures({ entries, records: many }, { week: WEEK });
  assert.equal(result.ok, true);
  assert.equal(result.features.usages.length, FEATURES_USAGES_MAX);
  assert.equal(result.features.relays, many.length);
});

test('computeWeeklyFeatures：同样输入两次结果逐字段一致', () => {
  assert.deepEqual(computeFixture(), computeFixture());
});

// ---------------------------------------------------------------------------
// 上传构造：白名单拒绝制 + 自校验。
// ---------------------------------------------------------------------------
test('featuresUploadPayload：输出能过合同校验，键恰好是 9 个白名单字段', () => {
  const result = computeFixture();
  const payload = featuresUploadPayload(result);
  assert.ok(payload);
  assert.deepEqual(Object.keys(payload).sort(), [...FEATURES_UPLOAD_FIELDS].sort());
  // 裸 features 对象同样接受（服务线/存档线方便）。
  assert.deepEqual(featuresUploadPayload(result.features), payload);
  const body = featuresUploadBody(result);
  assert.equal(typeof body, 'string');
  assert.deepEqual(JSON.parse(body), payload);
});

test('featuresUploadPayload：塞入任何禁止字段一律 null（拒绝而非剥离）', () => {
  const features = computeFixture().features;
  for (const field of FORBIDDEN_UPLOAD_FIELDS) {
    const tampered = Object.assign({}, features);
    tampered[field] = 'x';
    assert.equal(featuresUploadPayload({ ok: true, features: tampered }), null, 'field: ' + field);
    assert.equal(featuresUploadBody({ ok: true, features: tampered }), null, 'field: ' + field);
  }
  // 缺字段同样拒绝。
  const noRating = Object.assign({}, features);
  delete noRating.rating;
  assert.equal(featuresUploadPayload({ ok: true, features: noRating }), null);
});

// ---------------------------------------------------------------------------
// D2 隐私硬门槛：诱饵扫描 + 深度字符串白名单 + 深度键白名单。
// ---------------------------------------------------------------------------
const SECRETS = [
  'SECRET-标题-组会纪要', 'SECRET-标题-论文引言', 'SECRET-标题-读文献',
  'SECRET-标题-上周', 'SECRET-标题-重复', '被占用SECRET',
  'SECRET-事件原话-', 'SECRET-AI结果-', 'SECRET-备注', 'SECRET-意图',
  'SECRET-A', 'SECRET-B', 'SECRET-C', 'SECRET-M',
];

function deepStrings(value, out) {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach((v) => deepStrings(v, out));
  else if (value && typeof value === 'object') Object.values(value).forEach((v) => deepStrings(v, out));
  return out;
}

function deepKeys(value, out) {
  if (Array.isArray(value)) value.forEach((v) => deepKeys(v, out));
  else if (value && typeof value === 'object') {
    Object.keys(value).forEach((k) => { out.push(k); deepKeys(value[k], out); });
  }
  return out;
}

test('D2：标题/材料/事件原话/AI结果绝不出现在 features、payload 或请求体', () => {
  const result = computeFixture();
  const dumps = [
    ['features', JSON.stringify(result.features)],
    ['payload', JSON.stringify(featuresUploadPayload(result))],
    ['body', featuresUploadBody(result)],
    ['整个结果对象', JSON.stringify(result)],
  ];
  for (const [name, dump] of dumps) {
    for (const secret of SECRETS) assert.ok(!dump.includes(secret), name + ' 泄漏: ' + secret);
  }
});

test('D2：具体时间不出现在任何输出 —— 无 HH:MM、无完整日期、无记录时间戳', () => {
  const result = computeFixture();
  const atStamps = RECORDS.map((r) => r.at);
  const dumps = [JSON.stringify(result), JSON.stringify(result.features),
    featuresUploadBody(result)];
  for (const dump of dumps) {
    assert.ok(!/\d{2}:\d{2}/.test(dump), '出现 HH:MM 时间: ' + dump);
    for (const date of weekDates(WEEK)) assert.ok(!dump.includes(date), '出现完整日期: ' + date);
    for (const stamp of atStamps) assert.ok(!dump.includes(stamp), '出现记录时间戳');
    assert.ok(!dump.includes('2026-10-18'), '出现周外日期');
  }
});

test('D2：payload 里的字符串只可能是周号或用法 id（无任何自由文本）', () => {
  const payload = featuresUploadPayload(computeFixture());
  const allowed = new Set([WEEK, ...payload.usages]);
  for (const s of deepStrings(payload, [])) assert.ok(allowed.has(s), '未预期字符串: ' + s);
});

test('D2：payload 任意深度的键都在白名单内，禁止字段名零出现', () => {
  const payload = featuresUploadPayload(computeFixture());
  const keys = deepKeys(payload, []);
  assert.deepEqual(Object.keys(payload).sort(), [...FEATURES_UPLOAD_FIELDS].sort());
  for (const key of keys) assert.ok(!FORBIDDEN_UPLOAD_FIELDS.includes(key), '禁止键: ' + key);
  // 嵌套占比表的键与合同枚举一致。
  assert.deepEqual(Object.keys(payload.kindMix).sort(), [...KIND_MIX_KEYS].sort());
  assert.deepEqual(Object.keys(payload.rhythm).sort(), [...RHYTHM_KEYS].sort());
  assert.deepEqual(Object.keys(payload.freedTo).sort(), [...FREED_TO_KEYS].sort());
  assert.deepEqual(Object.keys(payload.rating).sort(), [...RATINGS].sort());
});

test('周号本身合法且合同可校验', () => {
  assert.ok(isIsoWeek(WEEK));
  const payload = featuresUploadPayload(computeFixture());
  assert.ok(isIsoWeek(payload.week));
  assert.equal(payload.week, WEEK);
});
