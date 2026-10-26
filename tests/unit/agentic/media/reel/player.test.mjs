// W11 reel-player · web/agentic/reel/player.js 先行单测（RED 契约，node 侧纯函数）。
// 依据：DAG 组3：(1) 解析 data-start/data-duration/data-track 构建时间轴模型（解析为纯
// 函数，node 单测）；(4) 字幕 aria-live 逐句、旁白 <audio> currentTime 为时间轴主时钟；
// (5) prefers-reduced-motion 降级分步静态；(6) node 单测覆盖解析/同步换算/降级判定/状态机。
// 前提契约：player.js 顶层不得触碰 DOM（可在 node 导入）；浏览器胶水归组 4 冒烟验证。
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  parseTimeline,
  activeAt,
  progressAt,
  formatTime,
  shouldReduceMotion,
  playerState,
  INITIAL_PLAYER_STATE,
} from '../../../../../web/agentic/reel/player.js';

const el = attrs => {
  const map = {};
  for (const [k, v] of Object.entries(attrs)) map['data-' + k] = String(v);
  return { getAttribute: name => (name in map ? map[name] : null) };
};

const SHOTS = [
  el({ start: 0, duration: 3, track: 'visual', kind: 'shot' }),
  el({ start: 3, duration: 2.5, track: 'visual', kind: 'sample' }),
  el({ start: 5.5, duration: 4.5, track: 'visual', kind: 'shot' }),
];
const CAPS = [
  el({ start: 0, duration: 3, track: 'caption', kind: 'caption' }),
  el({ start: 3.2, duration: 2, track: 'caption', kind: 'caption' }),
];

test('parseTimeline builds the timeline model from data attributes (sorted, typed, tracked)', () => {
  const tl = parseTimeline([...CAPS, ...SHOTS]);
  assert.equal(tl.durationSec, 10, '总时长 = max(start+duration)');
  assert.equal(tl.tracks.visual.length, 3);
  assert.equal(tl.tracks.caption.length, 2);
  for (const v of tl.tracks.visual) {
    assert.equal(typeof v.start, 'number');
    assert.equal(typeof v.duration, 'number');
    assert.equal(v.track, 'visual');
  }
  assert.deepEqual(tl.tracks.visual.map(s => s.start), [0, 3, 5.5], '按开始时间排序');
});

test('parseTimeline tolerates junk elements by ignoring them', () => {
  const junk = [el({}), el({ start: 'x', duration: 'y', track: 'visual' })];
  const tl = parseTimeline(junk);
  assert.deepEqual(tl.tracks.visual, []);
  assert.equal(tl.durationSec, 0);
});

test('activeAt returns the visible shot and every live caption at time t (主时钟同步换算)', () => {
  const tl = parseTimeline([...SHOTS, ...CAPS]);
  const mid = activeAt(tl, 4);
  assert.equal(mid.visual.start, 3, '4s 落在第二镜');
  assert.deepEqual(mid.captions.map(c => c.start), [3.2]);

  const boundary = activeAt(tl, 3);
  assert.equal(boundary.visual.start, 3, 't=3 恰好切到第二镜（start 处已激活）');

  const before = activeAt(tl, -0.5);
  assert.equal(before.visual, null);

  const after = activeAt(tl, 10.5);
  assert.equal(after.visual, null, '播放完毕后无激活镜头');
  assert.deepEqual(after.captions, []);
});

test('progressAt clamps to [0,1] and tracks the audio clock', () => {
  const tl = parseTimeline([...SHOTS, ...CAPS]);
  assert.equal(progressAt(tl, 0), 0);
  assert.equal(progressAt(tl, 5), 0.5);
  assert.equal(progressAt(tl, 10), 1);
  assert.equal(progressAt(tl, -3), 0);
  assert.equal(progressAt(tl, 99), 1);
});

test('formatTime renders M:SS time labels for the caption bar', () => {
  assert.equal(formatTime(0), '0:00');
  assert.equal(formatTime(7.4), '0:07');
  assert.equal(formatTime(65), '1:05');
  assert.equal(formatTime(600.9), '10:00');
});

test('shouldReduceMotion honours the media query (降级判定)', () => {
  assert.equal(shouldReduceMotion({ matches: true }), true);
  assert.equal(shouldReduceMotion({ matches: false }), false);
  assert.equal(shouldReduceMotion(undefined), false, '无 matchMedia 环境默认不降级');
});

test('playerState follows the prototype interactions: pause/resume/replay/close/Esc', () => {
  // prototype.html:621-648：暂停按钮切换 暂停/继续；末尾变重播；Esc/关闭收起
  let s = INITIAL_PLAYER_STATE ?? 'idle';
  s = playerState(s, 'play');
  assert.equal(s, 'playing');
  assert.equal(playerState(s, 'pause'), 'paused');
  assert.equal(playerState('paused', 'resume'), 'playing');
  assert.equal(playerState('playing', 'end'), 'ended');
  assert.equal(playerState('ended', 'replay'), 'playing', '末尾的重播按钮');
  assert.equal(playerState('ended', 'pause'), 'playing', 'prototype：末尾按暂停即重播');
  assert.equal(playerState('playing', 'close'), 'closed');
  assert.equal(playerState('paused', 'close'), 'closed');
  assert.equal(playerState('ended', 'close'), 'closed');
  assert.equal(playerState('idle', 'close'), 'closed');
  assert.equal(playerState('closed', 'play'), 'closed', '关闭是终态');
  assert.equal(playerState('idle', 'unknown-event'), 'idle', '未知事件不动状态');
});
