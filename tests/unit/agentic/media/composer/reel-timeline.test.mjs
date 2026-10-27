// W11 composer · 时间轴先行单测（RED 契约）。
// 依据：DAG 组2(1)(4)：由 storyboard（at/actor/text）+ 旁白字幕时间戳（tts 契约
// [{text,startSec,endSec}]）合成镜头序列 [{start,duration,track,kind:分镜配图|样张翻页|字幕}]；
// 每个元素输出 data-start/data-duration/data-track 属性（HyperFrames 兼容，
// BUILD-PLAN W11.2 原文）；durationSec 来自旁白音频总时长；Ken Burns 标记类；
// 镜头边界不重叠不漏秒、字幕轨道与画面轨道分离、空旁白/单镜头边界用例。
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildTimeline, dataAttrs } from '../../../../../scripts/agentic/composer/timeline.mjs';

const SUBS = [
  { text: '第一句。', startSec: 0, endSec: 2 },
  { text: '第二句。', startSec: 2, endSec: 5 },
  { text: '第三句。', startSec: 5, endSec: 7 },
];
const STORY = [
  { at: '13:30', actor: 'researcher', text: '检索与筛选来源' },
  { at: '14:50', actor: 'writer', text: '合成报告' },
  { at: '15:00', actor: 'deliver', text: '交付' },
];

test('with matching narration the shot boundaries follow subtitle starts and cover the full audio', () => {
  const tl = buildTimeline({ storyboard: STORY, subtitles: SUBS, durationSec: 10 });
  const shots = tl.tracks.visual;
  assert.equal(shots.length, 3);
  assert.deepEqual(shots.map(s => [s.start, s.start + s.duration]), [[0, 2], [2, 5], [5, 10]], '首镜从 0 起，末镜收到旁白总时长（尾部静音归末镜）');
  assert.equal(shots.every(s => s.kind === 'shot' || s.kind === 'sample'), true);
  assert.ok(shots[0].at === '13:30' && shots[0].actor === 'researcher' && shots[0].text === '检索与筛选来源', '分镜字段原样保留');
});

test('visual shots tile [0, durationSec) with no overlap and no gap, in every mode', () => {
  const cases = [
    { storyboard: STORY, subtitles: SUBS, durationSec: 10 },
    { storyboard: STORY, subtitles: SUBS.slice(0, 2), durationSec: 10 },   // 数目不匹配 → 均分
    { storyboard: STORY, subtitles: [], durationSec: 9 },                  // 空旁白 → 均分
    { storyboard: [STORY[0]], subtitles: [{ text: '仅一句。', startSec: 0, endSec: 9 }], durationSec: 9 }, // 单镜头
  ];
  for (const c of cases) {
    const tl = buildTimeline(c);
    const shots = tl.tracks.visual;
    assert.equal(shots[0].start, 0);
    for (let i = 1; i < shots.length; i += 1) {
      assert.equal(shots[i].start, shots[i - 1].start + shots[i - 1].duration, '首尾相接：不重叠不漏秒');
    }
    const last = shots[shots.length - 1];
    assert.ok(Math.abs(last.start + last.duration - c.durationSec) < 1e-9, '末镜恰好收在 durationSec');
  }
});

test('a single storyboard entry covers the whole duration', () => {
  const tl = buildTimeline({ storyboard: [STORY[0]], subtitles: [], durationSec: 40 });
  assert.equal(tl.tracks.visual.length, 1);
  assert.equal(tl.tracks.visual[0].start, 0);
  assert.equal(tl.tracks.visual[0].duration, 40);
});

test('subtitles become a separate caption track; visual and caption never share a track', () => {
  const tl = buildTimeline({ storyboard: STORY, subtitles: SUBS, durationSec: 10 });
  const caps = tl.tracks.caption;
  assert.equal(caps.length, 3);
  for (let i = 0; i < caps.length; i += 1) {
    assert.equal(caps[i].kind, 'caption');
    assert.equal(caps[i].track, 'caption');
    assert.equal(caps[i].start, SUBS[i].startSec);
    assert.ok(Math.abs(caps[i].duration - (SUBS[i].endSec - SUBS[i].startSec)) < 1e-9);
    assert.equal(caps[i].text, SUBS[i].text);
  }
  assert.ok(tl.tracks.visual.every(s => s.track === 'visual'), '画面轨道与字幕轨道分离');
  // 聚合 elements 按时间排序，且每元素轨道归属明确
  const starts = tl.elements.map(e => e.start);
  assert.deepEqual(starts, [...starts].sort((a, b) => a - b));
});

test('storyboard entries referencing a sample become sample-flip shots; image shots carry the Ken Burns marker', () => {
  const tl = buildTimeline({
    storyboard: [
      { at: '13:30', actor: 'researcher', text: '检索', image: '/api/media/x.png' },
      { at: '14:00', actor: 'deliver', text: '翻到样张', kind: 'sample', sampleId: 's1' },
    ],
    subtitles: [
      { text: 'a', startSec: 0, endSec: 3 },
      { text: 'b', startSec: 3, endSec: 6 },
    ],
    durationSec: 6,
  });
  const [withImage, flip] = tl.tracks.visual;
  assert.equal(withImage.kind, 'shot');
  assert.equal(withImage.kb, true, '配图镜头标记 Ken Burns');
  assert.equal(flip.kind, 'sample');
  assert.equal(flip.sampleId, 's1');
  assert.notEqual(flip.kb, true, '无图样张翻页不做 Ken Burns');
});

test('empty storyboard and empty narration produce an empty (but well-formed) timeline', () => {
  const tl = buildTimeline({ storyboard: [], subtitles: [], durationSec: 0 });
  assert.deepEqual(tl.tracks.visual, []);
  assert.deepEqual(tl.tracks.caption, []);
  assert.equal(tl.durationSec, 0);
});

test('dataAttrs emits the three HyperFrames-compatible attributes with clean numbers', () => {
  const tl = buildTimeline({ storyboard: STORY, subtitles: SUBS, durationSec: 10 });
  const attrs = dataAttrs(tl.tracks.visual[1]);
  assert.match(attrs, /data-start="2"/);
  assert.match(attrs, /data-duration="3"/);
  assert.match(attrs, /data-track="visual"/);
  const frac = dataAttrs({ start: 2.5, duration: 7.25, track: 'caption' });
  assert.match(frac, /data-start="2\.5"/);
  assert.match(frac, /data-duration="7\.25"/);
  assert.match(frac, /data-track="caption"/);
  // 属性可被播放器端逆向解析
  const parsed = Object.fromEntries([...frac.matchAll(/data-([\w-]+)="([^"]*)"/g)].map(m => [m[1], m[2]]));
  assert.equal(Number(parsed.start), 2.5);
  assert.equal(Number(parsed.duration), 7.25);
  assert.equal(parsed.track, 'caption');
});
