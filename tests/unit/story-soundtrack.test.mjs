import assert from 'node:assert/strict';
import { test } from 'node:test';

// T3 作曲线: web/story/soundtrack.js — SPEC design/story-recap/SPEC.md §4.
// 参考实现 = design/story-recap/prototype.html 顶部的数据作曲演示
// (Math.random 在工程化版本里换成 contracts.createRng 的种子化 PRNG).
//
// node 侧只测纯映射/纯规划层 (SPEC §4 映射 + 种子确定性 + 结构分段 +
// note 序列契约). Web Audio 渲染层 (OfflineAudioContext 能量/长度、iOS
// 手势出声) 是浏览器内检查, defer 到窗口屏障后 — 见 deferred 清单.
//
// 所有常量口径一律来自 web/story/contracts.js (commit fa41b18), 本文件
// 不自定义任何映射: tempo=64+busyness×40, mood≥0.5 大调, KIND_TIMBRE,
// INTRO_BARS=4, VOLUME_MAX=0.25, ROOT_MIDI=57, NOTE_VOICES.

import {
  SONG, KIND_TIMBRE, MODES,
  tempoBpm, modeFor, scaleFor, chordDegreesFor, timbreFor,
  createRng, songSeedFromId, validateNoteSequence, melodyPitches,
} from '../../web/story/contracts.js';
import {
  SOUNDTRACK, SOUNDTRACK_MUTE_KEY,
  normalizeSongInput, resolveSongParams, planSong, createSoundtrack,
} from '../../web/story/soundtrack.js';

// ---------------------------------------------------------------------------
// Fixtures — 数字对准原型十月份章 (prototype.html line 303)。
// ---------------------------------------------------------------------------

const OCTOBER = {
  busyness: 0.62,
  mood: 0.7,
  dominantKind: 'create',
  weeklyCounts: [14, 22, 28, 22],
  graduations: [1, 0, 2, 1],        // 与 weeklyCounts 对齐: 第 i 周毕业次数
  chapterSeed: songSeedFromId('story-2026-10'),
};

function clone(x) { return JSON.parse(JSON.stringify(x)); }

// ---------------------------------------------------------------------------
// normalizeSongInput — SPEC §4 输入形状 (contracts.songInputFor 的镜像规则).
// ---------------------------------------------------------------------------

test('normalizeSongInput: 合法输入原样规范化并克隆数组', () => {
  const n = normalizeSongInput(OCTOBER);
  assert.ok(n);
  assert.equal(n.busyness, 0.62);
  assert.equal(n.mood, 0.7);
  assert.equal(n.dominantKind, 'create');
  assert.deepEqual(n.weeklyCounts, [14, 22, 28, 22]);
  assert.deepEqual(n.graduations, [1, 0, 2, 1]);
  assert.equal(typeof n.chapterSeed, 'number');
  // 克隆: 改原数组不影响规范化结果
  const src = clone(OCTOBER);
  const out = normalizeSongInput(src);
  src.weeklyCounts.push(99);
  assert.equal(out.weeklyCounts.length, 4);
});

test('normalizeSongInput: 字符串种子按 contracts.songSeedFromId 哈希', () => {
  const n = normalizeSongInput({ ...OCTOBER, chapterSeed: 'story-2026-10' });
  assert.ok(n);
  assert.equal(n.chapterSeed, songSeedFromId('story-2026-10'));
});

test('normalizeSongInput: 非法输入一律 null, 绝不抛错', () => {
  const bad = [
    null, undefined, 42, 'x',
    { ...OCTOBER, busyness: 1.5 },          // busyness 越界
    { ...OCTOBER, busyness: -0.1 },
    { ...OCTOBER, busyness: 'busy' },
    { ...OCTOBER, mood: 2 },                // mood 越界
    { ...OCTOBER, dominantKind: 'party' },  // 不在 KINDS
    { ...OCTOBER, weeklyCounts: [] },       // 空周数组
    { ...OCTOBER, weeklyCounts: [1, 'x'] },
    { ...OCTOBER, graduations: [1, 0, 2] }, // 与 weeklyCounts 不对齐
    { ...OCTOBER, graduations: [1, 0, 2, 1.5] },
    { ...OCTOBER, chapterSeed: null },      // 种子缺失/非法
    { ...OCTOBER, chapterSeed: -1 },
    { ...OCTOBER, chapterSeed: 1.5 },
  ];
  for (const v of bad) assert.equal(normalizeSongInput(v), null, JSON.stringify(v));
});

// ---------------------------------------------------------------------------
// resolveSongParams — SPEC §4 映射: busyness→速度, mood→调式, kind→音色.
// ---------------------------------------------------------------------------

test('映射: 速度 = 64 + busyness × 40 bpm (含边界)', () => {
  assert.equal(resolveSongParams({ ...OCTOBER, busyness: 0 }).bpm, 64);
  assert.equal(resolveSongParams({ ...OCTOBER, busyness: 1 }).bpm, 104);
  const p = resolveSongParams(OCTOBER);
  assert.equal(p.bpm, tempoBpm(0.62));   // 88.8, 与 contracts 一致
  assert.equal(p.beat, 60 / p.bpm);
});

test('映射: mood ≥ 0.5 大调 I–vi–IV–V, 否则小调 i–III–v–iv (含 0.5 边界)', () => {
  const major = resolveSongParams({ ...OCTOBER, mood: 0.7 });
  const edge = resolveSongParams({ ...OCTOBER, mood: 0.5 });
  const minor = resolveSongParams({ ...OCTOBER, mood: 0.3 });
  assert.equal(major.mode, 'major');
  assert.equal(edge.mode, 'major');                       // ≥ 0.5
  assert.equal(minor.mode, 'minor');
  assert.deepEqual(major.degrees, [0, 5, 3, 4]);          // I–vi–IV–V
  assert.deepEqual(minor.degrees, [0, 3, 5, 4]);          // i–III–v–iv
  assert.deepEqual(major.scale, scaleFor('major'));
  assert.deepEqual(minor.scale, scaleFor('minor'));
  assert.ok(MODES.includes(major.mode) && MODES.includes(minor.mode));
});

test('映射: 主旋律音色按 dominantKind, 基础波形与 contracts.KIND_TIMBRE 锁定', () => {
  for (const kind of Object.keys(KIND_TIMBRE)) {
    const p = resolveSongParams({ ...OCTOBER, dominantKind: kind });
    assert.equal(p.leadWave, timbreFor(kind), kind);
    assert.equal(p.leadWave, KIND_TIMBRE[kind], kind);
  }
  // SPEC §4: connect = 柔和 saw 加低通 → 滤波更低 + 音量更轻
  const connect = resolveSongParams({ ...OCTOBER, dominantKind: 'connect' });
  const create = resolveSongParams({ ...OCTOBER, dominantKind: 'create' });
  assert.equal(connect.leadWave, 'sawtooth');
  assert.ok(connect.leadFilterHz < create.leadFilterHz, 'connect 低通更柔');
  assert.ok(connect.leadGain < create.leadGain, 'connect 音量更轻');
  // SPEC §4: restore/stillness = sine 加长混响
  for (const kind of ['restore', 'stillness']) {
    const p = resolveSongParams({ ...OCTOBER, dominantKind: kind });
    assert.equal(p.leadWave, 'sine', kind);
    assert.equal(p.leadReverbLong, true, `${kind} 加长混响`);
  }
  assert.equal(create.leadReverbLong, false);
});

test('映射: 音量上限 0.25 (SPEC §4), 封面淡入 2.5 秒 (SPEC §3 ⓪)', () => {
  const p = resolveSongParams(OCTOBER);
  assert.ok(p.masterGain > 0 && p.masterGain <= SONG.VOLUME_MAX);
  assert.equal(SOUNDTRACK.FADE_IN_SECONDS, 2.5);
});

test('resolveSongParams: 非法输入返回 null', () => {
  assert.equal(resolveSongParams({ ...OCTOBER, busyness: 9 }), null);
  assert.equal(resolveSongParams(null), null);
  assert.equal(resolveSongParams('x'), null);
});

// ---------------------------------------------------------------------------
// planSong — 种子确定性 (SPEC §4 种子固定 / §8 验收).
// ---------------------------------------------------------------------------

test('种子确定: 同一输入两次 planSong 的音符序列完全一致 (deepEqual)', () => {
  const a = planSong(OCTOBER, 10);
  const b = planSong(clone(OCTOBER), 10);
  assert.deepEqual(a.notes, b.notes);
  assert.deepEqual(a.segments, b.segments);
  assert.deepEqual(a.params, b.params);
});

test('种子确定: 换种子 → 旋律不同; 同种子字符串/数值两种写法结果一致', () => {
  const base = planSong(OCTOBER, 10);
  const other = planSong({ ...OCTOBER, chapterSeed: songSeedFromId('story-2026-11') }, 10);
  assert.notDeepEqual(melodyPitches(base.notes), melodyPitches(other.notes));
  // 字符串种子与预先哈希的数值种子必须给出同一首歌
  const byStr = planSong({ ...OCTOBER, chapterSeed: 'story-2026-10' }, 10);
  assert.deepEqual(byStr.notes, base.notes);
});

test('planSong: 音符序列通过 contracts.validateNoteSequence, 主旋律序列非空', () => {
  const plan = planSong(OCTOBER, 10);
  assert.ok(validateNoteSequence(plan.notes), 'note 形状 {midi,at,dur,voice} 全部合法');
  const pitches = melodyPitches(plan.notes);
  assert.ok(pitches.length >= 20, `主旋律 (lead+chime) 有足够事件: ${pitches.length}`);
  // at 升序
  for (let i = 1; i < plan.notes.length; i += 1) {
    assert.ok(plan.notes[i - 1].at <= plan.notes[i].at, '按时间排序');
  }
});

// ---------------------------------------------------------------------------
// planSong — 结构分段 (SPEC §4: 前奏 4 小节 pad / 主体随页面推进 / 海报页收束).
// ---------------------------------------------------------------------------

test('结构: 月章 10 页 = 10 段, 段号=页号, 时间连续不重叠', () => {
  const plan = planSong(OCTOBER, 10);
  assert.equal(plan.segments.length, 10);
  let t = 0;
  for (let i = 0; i < plan.segments.length; i += 1) {
    const s = plan.segments[i];
    assert.equal(s.index, i);
    assert.equal(s.startAt, t, `段 ${i} 起点连续`);
    assert.ok(s.endAt > s.startAt);
    assert.equal(s.endAt, t + s.barCount * 4 * plan.params.beat);
    t = s.endAt;
  }
  assert.equal(plan.duration, t);
});

test('结构: 段 0 = 前奏, 4 小节纯 pad (INTRO_BARS), 无旋律无钟琴', () => {
  const plan = planSong(OCTOBER, 10);
  const intro = plan.segments[0];
  assert.equal(intro.kind, 'intro');
  assert.equal(intro.barCount, SONG.INTRO_BARS);
  assert.ok(intro.notes.length >= 4 * 3, '每小节至少 3 个 pad 声部');
  for (const n of intro.notes) assert.equal(n.voice, 'pad');
});

test('结构: 主体段 (1..8) 有主旋律, 旋律音全部落在调式音阶内', () => {
  const plan = planSong(OCTOBER, 10);
  const scaleSet = new Set(plan.params.scale.map((iv) => SONG.ROOT_MIDI + 12 + iv));
  for (let i = 1; i <= 8; i += 1) {
    const seg = plan.segments[i];
    assert.equal(seg.kind, 'body');
    const lead = seg.notes.filter((n) => n.voice === 'lead');
    assert.ok(lead.length >= 1, `段 ${i} 有旋律`);
    for (const n of lead) assert.ok(scaleSet.has(n.midi), `midi ${n.midi} 在音阶内`);
  }
});

test('结构: 末段 = 海报页收束 — pad 回主和弦, 旋律终止在主音, 淡出覆盖到曲终', () => {
  const plan = planSong(OCTOBER, 10);
  const outro = plan.segments[9];
  assert.equal(outro.kind, 'outro');
  // pad = 主和弦 (degree 0): ROOT-12 + scale[0] + [0,4,7] = {45,49,52}
  const pads = outro.notes.filter((n) => n.voice === 'pad').map((n) => n.midi).sort((a, b) => a - b);
  assert.deepEqual(pads, [45, 49, 52]);
  // 全曲最后一个 lead 音 = 主音 (ROOT+12+scale[0] = 69)
  const leads = plan.notes.filter((n) => n.voice === 'lead');
  const lastLead = leads[leads.length - 1];
  assert.equal(lastLead.midi, SONG.ROOT_MIDI + 12);
  // 淡出: 从末段起点淡到 0, 结束点 = 全曲长度
  assert.equal(plan.fadeOut.startAt, outro.startAt);
  assert.ok(plan.fadeOut.duration > 0);
  assert.ok(Math.abs(plan.fadeOut.startAt + plan.fadeOut.duration - plan.duration) < 1e-9);
});

test('结构: 短章 3 页 / 单页章不崩, pageCount 非法返回 null', () => {
  const short = planSong(OCTOBER, 3);
  assert.equal(short.segments.length, 3);
  assert.equal(short.segments[0].kind, 'intro');
  assert.equal(short.segments[2].kind, 'outro');
  const single = planSong(OCTOBER, 1);
  assert.equal(single.segments.length, 1);
  assert.equal(single.segments[0].kind, 'outro');   // 唯一一页即海报
  for (const bad of [0, -1, 2.5, '10', null]) {
    assert.equal(planSong(OCTOBER, bad), null, `pageCount=${JSON.stringify(bad)}`);
  }
  assert.equal(planSong({ ...OCTOBER, mood: 2 }, 10), null);
});

// ---------------------------------------------------------------------------
// 旋律起伏跟随 weeklyCounts (SPEC §4: 忙的那周音更高、更密).
// ---------------------------------------------------------------------------

test('轮廓: 更忙的周 → 旋律音更高且更密 (固定种子确定性断言)', () => {
  const input = {
    ...OCTOBER,
    weeklyCounts: [10, 40],       // 第 2 周是第 1 周的 4 倍忙
    graduations: [0, 0],
  };
  const plan = planSong(input, 4);
  const quiet = plan.segments[1];   // 段 1 → 周 0 (10 件事)
  const busy = plan.segments[2];    // 段 2 → 周 1 (40 件事)
  const avg = (seg) => {
    const lead = seg.notes.filter((n) => n.voice === 'lead');
    assert.ok(lead.length >= 1);
    return lead.reduce((s, n) => s + n.midi, 0) / lead.length;
  };
  assert.ok(avg(busy) > avg(quiet), '忙周平均音高更高');
  const quietMax = Math.max(...quiet.notes.filter((n) => n.voice === 'lead').map((n) => n.midi));
  const busyMin = Math.min(...busy.notes.filter((n) => n.voice === 'lead').map((n) => n.midi));
  assert.ok(busyMin > quietMax, '忙周音区整体上移 (区间不相交)');
  assert.ok(
    busy.notes.filter((n) => n.voice === 'lead').length
      >= quiet.notes.filter((n) => n.voice === 'lead').length,
    '忙周音符更密',
  );
});

// ---------------------------------------------------------------------------
// 毕业钟琴 (SPEC §4: 每次毕业在当周加一个钟琴音, 与配乐同调).
// ---------------------------------------------------------------------------

test('钟琴: 第 i 周毕业数 → 映射到该周的每个段的 chime 数, 封顶 CHIME_MAX_PER_SEGMENT', () => {
  const two = planSong({ ...OCTOBER, graduations: [0, 2, 0, 0] }, 10);
  // 段 s (1..8) → 周 (s-1)%4: 周 1 = 段 2 和段 6 (原型 bar%len 循环语义)
  for (let i = 0; i < 10; i += 1) {
    const chimes = two.segments[i].notes.filter((n) => n.voice === 'chime');
    const expected = i === 2 || i === 6 ? 2 : 0;
    assert.equal(chimes.length, expected, `段 ${i}`);
  }
  const many = planSong({ ...OCTOBER, graduations: [0, 20, 0, 0] }, 10);
  for (const i of [2, 6]) {
    assert.equal(
      many.segments[i].notes.filter((n) => n.voice === 'chime').length,
      SOUNDTRACK.CHIME_MAX_PER_SEGMENT,
      `段 ${i}`,
    );
  }
});

test('钟琴: 音高在 root+24 起的调式音阶内 (与配乐同调)', () => {
  const plan = planSong(OCTOBER, 10);
  const scaleSet = new Set(plan.params.scale.map((iv) => SONG.ROOT_MIDI + 24 + iv));
  const chimes = plan.notes.filter((n) => n.voice === 'chime');
  assert.ok(chimes.length >= 1);
  for (const n of chimes) assert.ok(scaleSet.has(n.midi), `midi ${n.midi} 同调`);
});

// ---------------------------------------------------------------------------
// createSoundtrack — 会话外壳. node 无 Web Audio: 优雅降级 + 静音记忆.
// 渲染层 (真实 AudioContext 调度/OfflineAudioContext 能量检查) defer 浏览器.
// ---------------------------------------------------------------------------

test('会话: node 无 Web Audio 时 start() 优雅失败, 不抛错', () => {
  const s = createSoundtrack({ input: OCTOBER, pageCount: 10, storage: fakeStorage() });
  assert.ok(s.plan);
  const r = s.start(0);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'no-web-audio');
  // 幂等/安全
  s.setPage(3); s.unlock(); s.stop(); s.stop();
});

test('静音: setMuted 写入存储并记住, 下一个会话读回 (SPEC §4 一键静音并记住)', () => {
  const storage = fakeStorage();
  const a = createSoundtrack({ input: OCTOBER, pageCount: 10, storage });
  assert.equal(a.isMuted(), false);
  a.setMuted(true);
  assert.equal(a.isMuted(), true);
  assert.equal(storage.getItem(SOUNDTRACK_MUTE_KEY), '1');
  const b = createSoundtrack({ input: OCTOBER, pageCount: 10, storage });
  assert.equal(b.isMuted(), true, '新会话记住静音选择');
  b.setMuted(false);
  assert.equal(storage.getItem(SOUNDTRACK_MUTE_KEY), '0');
});

test('静音: 存储不可用 (Safari 隐私模式) 时静音仍可切换, 不抛错', () => {
  const throwing = {
    getItem() { throw new Error('denied'); },
    setItem() { throw new Error('denied'); },
  };
  const s = createSoundtrack({ input: OCTOBER, pageCount: 10, storage: throwing });
  assert.equal(s.isMuted(), false);
  s.setMuted(true);
  assert.equal(s.isMuted(), true);
});

test('会话: 非法输入 → plan 为 null, start() 给出 bad-input', () => {
  const s = createSoundtrack({ input: { busyness: 9 }, pageCount: 10, storage: fakeStorage() });
  assert.equal(s.plan, null);
  assert.equal(s.start(0).reason, 'bad-input');
});

function fakeStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
}
