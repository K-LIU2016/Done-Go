import assert from 'node:assert/strict';
import { test } from 'node:test';

// T8 调度存储线（store）— SPEC §6 章节存储 tango-donego.story.v1：
//   账号作用域链（注入 > TangoAccountStorage > localStorage 裸键，与 relay v2
//   的 D9 约定一致）、隔离区（unknown 绝不覆盖，原文先搬 .quarantine）、
//   最多 120 章保新淘汰（章号不重排）、可编辑文案/心愿的局部更新、事务式
//   提交（写盘失败回滚内存）。storage 注入，node --test 全程无 DOM。

import { createStoryStore, pickStorage, storyQuarantineKey } from '../../web/story/store.js';
import {
  STORY_STORE_KEY, STORY_STORE_VERSION, MAX_CHAPTERS, createChapter, validateChapter,
} from '../../web/story/contracts.js';

const QKEY = storyQuarantineKey(STORY_STORE_KEY);

// 与 tests/unit/story-contracts.test.mjs 同源的合法 stats 夹具（十月原型章）。
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

function stats() { return JSON.parse(JSON.stringify(STATS)); }
function fields(no, from, to, type) {
  return { no, type: type || 'week', period: { from, to }, stats: stats() };
}
function ymdPlus(ymd, days) {
  return new Date(Date.parse(ymd + 'T00:00:00Z') + days * 86400000).toISOString().slice(0, 10);
}

// 造「可直接落盘的完整章节」：fields 只是生成方输入，盘上的章节必须过
// validateChapter（id/generatedAt/pages/songSeed 齐全）— 用契约自己的
// createChapter 生成，夹具不手工拼形状。
function uuidFor(n) {
  const h = (n.toString(16) + '0000000').slice(0, 8);
  const t = (n.toString(16) + '00000000000').slice(0, 12);
  return h + '-0000-4000-8000-' + t;
}
function chapterOnDisk(no, from, to, type) {
  return createChapter(fields(no, from, to, type), { uuid: uuidFor(no), now: Date.parse('2026-11-01T09:00:00Z') });
}

function fakeStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
    dump: () => map,
  };
}

// ---------------------------------------------------------------------------
// 初始化与读取
// ---------------------------------------------------------------------------

test('storyQuarantineKey：隔离区副作用键 = <key>.quarantine', () => {
  assert.equal(QKEY, 'tango-donego.story.v1.quarantine');
});

test('空存储：status=empty，惰性初始化（零写入）', () => {
  const s = fakeStorage();
  const store = createStoryStore({ storage: s });
  assert.equal(store.status, 'empty');
  assert.equal(store.blocked, false);
  assert.equal(store.count(), 0);
  assert.deepEqual(store.chapters(), []);
  assert.equal(store.get('any'), null);
  assert.equal(s.dump().has(STORY_STORE_KEY), false);
});

test('读取：盘上合法载荷 → status=ok，章节按 period.from 升序（书架序）', () => {
  const s = fakeStorage();
  const a = chapterOnDisk(1, '2026-10-19', '2026-10-25');
  const b = chapterOnDisk(2, '2026-11-02', '2026-11-08');
  const c = chapterOnDisk(3, '2026-09-01', '2026-09-30', 'month');
  s.setItem(STORY_STORE_KEY, JSON.stringify({ v: STORY_STORE_VERSION, chapters: [b, a, c] })); // 乱序
  const store = createStoryStore({ storage: s });
  assert.equal(store.status, 'ok');
  assert.deepEqual(store.chapters().map((x) => x.period.from), ['2026-09-01', '2026-10-19', '2026-11-02']);
});

test('读取：非法章节被契约丢弃，合法的保留（读操作零写入）', () => {
  const s = fakeStorage();
  const raw = JSON.stringify({
    v: STORY_STORE_VERSION,
    chapters: [chapterOnDisk(1, '2026-10-19', '2026-10-25'), { id: 'junk' }],
  });
  s.setItem(STORY_STORE_KEY, raw);
  const store = createStoryStore({ storage: s });
  assert.equal(store.status, 'ok');
  assert.equal(store.count(), 1);
  assert.equal(s.dump().get(STORY_STORE_KEY), raw); // 读不改写盘上原文
});

// ---------------------------------------------------------------------------
// 新增与淘汰
// ---------------------------------------------------------------------------

test('addChapter：落盘 v1 载荷可读回，盘上内容过契约校验', () => {
  const s = fakeStorage();
  const store = createStoryStore({ storage: s });
  const chapter = store.addChapter(fields(1, '2026-10-19', '2026-10-25'), {
    uuid: '11111111-1111-4111-8111-111111111111',
  });
  assert.equal(chapter.id, '11111111-1111-4111-8111-111111111111');
  assert.equal(chapter.no, 1);
  assert.equal(store.count(), 1);
  const raw = JSON.parse(s.dump().get(STORY_STORE_KEY));
  assert.equal(raw.v, STORY_STORE_VERSION);
  assert.equal(raw.chapters.length, 1);
  assert.ok(validateChapter(raw.chapters[0]));
  assert.equal(store.get(chapter.id).period.to, '2026-10-25');
});

test('addChapter：非法字段返回 null 且零写入', () => {
  const s = fakeStorage();
  const store = createStoryStore({ storage: s });
  assert.equal(store.addChapter({ period: { from: '2026-10-19', to: '2026-10-25' }, stats: stats() }), null); // 缺 no/type
  assert.equal(store.addChapter(fields(0, '2026-10-19', '2026-10-25')), null); // no < 1
  assert.equal(store.addChapter(fields(1, '2026-10-25', '2026-10-19')), null); // from > to
  assert.equal(store.count(), 0);
  assert.equal(s.dump().has(STORY_STORE_KEY), false);
});

test('addChapter：同 type+period 幂等去重；同 period 不同 type 是两章', () => {
  const s = fakeStorage();
  const store = createStoryStore({ storage: s });
  assert.ok(store.addChapter(fields(1, '2026-10-19', '2026-10-25')));
  assert.equal(store.addChapter(fields(2, '2026-10-19', '2026-10-25')), null); // 重复
  assert.equal(store.count(), 1);
  assert.ok(store.addChapter(fields(2, '2026-10-19', '2026-10-25', 'month')));
  assert.equal(store.count(), 2);
});

test('淘汰策略：超过 120 章保最新 120，最老被修剪，章号不重排', () => {
  const s = fakeStorage();
  const store = createStoryStore({ storage: s });
  const N = MAX_CHAPTERS + 5;
  for (let i = 0; i < N; i += 1) {
    const from = ymdPlus('2020-01-06', i * 7); // 连续的周
    const chapter = store.addChapter(fields(i + 1, from, ymdPlus(from, 6)));
    assert.ok(chapter, 'chapter ' + (i + 1) + ' 应写入成功');
  }
  assert.equal(store.count(), MAX_CHAPTERS);
  const nos = store.chapters().map((c) => c.no);
  assert.equal(nos[0], 6); // 前 5 章被淘汰
  assert.equal(nos[1], 7);
  assert.equal(nos[nos.length - 1], N);
  const raw = JSON.parse(s.dump().get(STORY_STORE_KEY));
  assert.equal(raw.chapters.length, MAX_CHAPTERS); // 盘上同样 120
  assert.deepEqual(raw.chapters.map((c) => c.no).slice(0, 3), [6, 7, 8]); // no 保持原值
});

// ---------------------------------------------------------------------------
// 局部更新（SPEC §5 用户可编辑文案；SPEC §3 ⑧ 心愿存进章节）
// ---------------------------------------------------------------------------

test('updateCaptions：合并保存用户编辑；空串删键；非法键被契约清洗；坏 id 拒绝', () => {
  const s = fakeStorage();
  const store = createStoryStore({ storage: s });
  const c = store.addChapter(fields(1, '2026-10-01', '2026-10-31', 'month'));
  assert.equal(store.updateCaptions(c.id, { 'cover.title': '我的十月', 'p1.title': '八十六件事' }), true);
  assert.equal(store.get(c.id).captions['cover.title'], '我的十月');
  assert.equal(store.updateCaptions(c.id, { 'cover.title': '' }), true); // 空串 = 删除
  assert.equal(store.get(c.id).captions['cover.title'], undefined);
  assert.equal(store.get(c.id).captions['p1.title'], '八十六件事');
  assert.equal(store.updateCaptions('no-such-id', { x: 'y' }), false);
  assert.equal(store.updateCaptions(c.id, { 'bad key!': 'z' }), true); // 非法键静默丢弃，提交不失败
  assert.equal(store.get(c.id).captions['bad key!'], undefined);
});

test('setWish：校验+落章，at 缺省自动盖章；非法心愿/坏 id 拒绝', () => {
  const s = fakeStorage();
  const store = createStoryStore({ storage: s, now: Date.parse('2026-10-31T12:00:00Z') });
  const c = store.addChapter(fields(1, '2026-10-01', '2026-10-31', 'month'));
  assert.equal(store.setWish(c.id, { text: '希望十一月早点睡。', category: 'sleep' }), true);
  const wish = store.get(c.id).wish;
  assert.equal(wish.text, '希望十一月早点睡。');
  assert.equal(wish.category, 'sleep');
  assert.equal(wish.at, '2026-10-31T12:00:00.000Z'); // options.now 盖章
  assert.equal(store.setWish(c.id, { text: '   ' }), false); // 空文本
  assert.equal(store.setWish(c.id, { text: '好', category: 'nope' }), false); // 未知类别
  assert.equal(store.setWish('no-such-id', { text: '好' }), false);
});

// ---------------------------------------------------------------------------
// 隔离区（SPEC §6：未知版本绝不覆盖 — 原文零丢失）
// ---------------------------------------------------------------------------

test('隔离区：坏 JSON 原文先搬 .quarantine，主键才允许重开新库', () => {
  const s = fakeStorage();
  const poison = 'not json at all';
  s.setItem(STORY_STORE_KEY, poison);
  const store = createStoryStore({ storage: s });
  assert.equal(store.status, 'quarantined');
  assert.equal(store.quarantined, true);
  assert.equal(s.dump().get(QKEY), poison); // 原文零丢失
  assert.equal(store.count(), 0);
  const fresh = store.addChapter(fields(1, '2026-10-19', '2026-10-25'));
  assert.ok(fresh); // 隔离后新库可写
  assert.equal(JSON.parse(s.dump().get(STORY_STORE_KEY)).chapters.length, 1);
});

test('隔离区：不认识的版本号（合法 JSON）同样进隔离区', () => {
  const s = fakeStorage();
  s.setItem(STORY_STORE_KEY, JSON.stringify({ v: 2, chapters: [] }));
  const store = createStoryStore({ storage: s });
  assert.equal(store.status, 'quarantined');
  assert.equal(JSON.parse(s.dump().get(QKEY)).v, 2);
});

test('隔离区写失败 → blocked：主键原文不动，一切持久化被拒', () => {
  const s = fakeStorage();
  const poison = '{"v":99}';
  s.setItem(STORY_STORE_KEY, poison);
  const guarded = {
    getItem: (k) => (k === STORY_STORE_KEY ? poison : null),
    setItem: (k, v) => { if (k === QKEY) throw new Error('quota'); s.setItem(k, v); },
    removeItem: (k) => { s.removeItem(k); },
  };
  const store = createStoryStore({ storage: guarded });
  assert.equal(store.status, 'blocked');
  assert.equal(store.blocked, true);
  assert.equal(store.quarantineFailed, true);
  assert.equal(s.dump().get(STORY_STORE_KEY), poison); // 原文未被动过
  assert.equal(store.addChapter(fields(1, '2026-10-19', '2026-10-25')), null);
  assert.equal(store.updateCaptions('x', {}), false);
  assert.equal(store.setWish('x', { text: 'a' }), false);
  assert.equal(store.clear(), false);
});

// ---------------------------------------------------------------------------
// 不可用存储与事务式提交
// ---------------------------------------------------------------------------

test('无可用存储（localStorage 禁用/缺 root）→ blocked', () => {
  const store = createStoryStore({ storage: null, root: {} });
  assert.equal(store.status, 'blocked');
  assert.equal(store.addChapter(fields(1, '2026-10-19', '2026-10-25')), null);
});

test('读主键抛错 → blocked（不写入任何东西）', () => {
  const throwing = {
    getItem: () => { throw new Error('denied'); },
    setItem: () => { throw new Error('denied'); },
    removeItem: () => {},
  };
  const store = createStoryStore({ storage: throwing });
  assert.equal(store.status, 'blocked');
  assert.equal(store.blocked, true);
});

test('写盘失败回滚内存（事务式提交）', () => {
  const failing = {
    map: new Map(),
    getItem(k) { return this.map.has(k) ? this.map.get(k) : null; },
    setItem() { throw new Error('quota'); },
    removeItem(k) { this.map.delete(k); },
  };
  const store = createStoryStore({ storage: failing });
  assert.equal(store.status, 'empty');
  assert.equal(store.addChapter(fields(1, '2026-10-19', '2026-10-25')), null);
  assert.equal(store.count(), 0); // 内存也回滚
});

// ---------------------------------------------------------------------------
// 账号作用域链（与 relay v2 D9 约定一致）
// ---------------------------------------------------------------------------

test('pickStorage：显式注入 > TangoAccountStorage（账号作用域）> localStorage（访客裸键）', () => {
  const injected = fakeStorage();
  assert.equal(pickStorage({ storage: injected }), injected);
  const account = fakeStorage();
  const local = fakeStorage();
  const root = { TangoAccountStorage: account, localStorage: local };
  assert.equal(pickStorage({ root }), account);
  assert.equal(pickStorage({ root: { localStorage: local } }), local);
  assert.equal(pickStorage({ root: {} }), null);
});

test('完整链路：默认经 root 走 TangoAccountStorage，访客才落裸键', () => {
  const account = fakeStorage();
  const local = fakeStorage();
  const store = createStoryStore({ root: { TangoAccountStorage: account, localStorage: local } });
  assert.ok(store.addChapter(fields(1, '2026-10-19', '2026-10-25')));
  assert.equal(account.dump().has(STORY_STORE_KEY), true);
  assert.equal(local.dump().has(STORY_STORE_KEY), false);
});

// ---------------------------------------------------------------------------
// clear / 导出 / 副本语义
// ---------------------------------------------------------------------------

test('clear()：写入空库（键保留，防旧数据复活），并清隔离区副本', () => {
  const s = fakeStorage();
  s.setItem(STORY_STORE_KEY, '{"v":99,"chapters":[]}'); // 先触发隔离区
  const store = createStoryStore({ storage: s });
  assert.equal(store.status, 'quarantined');
  assert.equal(s.dump().has(QKEY), true);
  assert.equal(store.clear(), true);
  assert.deepEqual(JSON.parse(s.dump().get(STORY_STORE_KEY)), { v: STORY_STORE_VERSION, chapters: [] });
  assert.equal(s.dump().has(QKEY), false);
});

test('exportText / readQuarantined', () => {
  const s = fakeStorage();
  const store = createStoryStore({ storage: s });
  assert.equal(store.readQuarantined(), null);
  assert.ok(store.addChapter(fields(1, '2026-10-19', '2026-10-25')));
  const exported = JSON.parse(store.exportText());
  assert.equal(exported.v, STORY_STORE_VERSION);
  assert.equal(exported.chapters.length, 1);
  s.setItem(STORY_STORE_KEY, '{"v":99}');
  const store2 = createStoryStore({ storage: s });
  assert.equal(store2.readQuarantined(), '{"v":99}');
});

test('chapters() 返回副本：外层改动不影响库', () => {
  const s = fakeStorage();
  const store = createStoryStore({ storage: s });
  assert.ok(store.addChapter(fields(1, '2026-10-19', '2026-10-25')));
  const list = store.chapters();
  list.pop();
  list.push('junk');
  assert.equal(store.count(), 1);
  assert.equal(store.chapters()[0].no, 1);
});
