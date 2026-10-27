// W11 composer · 补充边界单测：把 compose-reel/timeline 的防御分支拉进覆盖（≥80% 门禁）。
// 用例对应实现里的兜底路径：未知 sampleId 的样张翻页、无 at/actor 的纯文字分镜、
// 非法字幕 cue 过滤、durationSec 缺省回退字幕最晚 endSec、带配图的样张翻页、超 60s 时长。
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { composeReel } from '../../../../../scripts/agentic/composer/compose-reel.mjs';
import { buildTimeline } from '../../../../../scripts/agentic/composer/timeline.mjs';

const BASE = {
  missionId: 'm_e',
  version: 2,
  samples: [
    { id: 's9', layout: 'slide-title-bullets-image', page: '样张', text: { title: '带图样张', bullets: [] }, image: { url: '/media/pic.png' }, watermark: '示意' },
  ],
  narrationAudio: null,
};

test('sample flip with an unknown sampleId degrades to code-typeset text, never throws', () => {
  const html = composeReel({
    ...BASE,
    storyboard: [{ at: '15:00', actor: 'deliver', text: '翻页兜底', kind: 'sample', sampleId: 'missing' }],
    subtitles: [{ text: '一句。', startSec: 0, endSec: 2 }],
    durationSec: 2,
  });
  assert.ok(html.includes('data-sample-id="missing"'), '仍可定位到声明的 sampleId');
  assert.ok(html.includes('翻页兜底'), '样张缺失时文字仍由代码排版兜底');
  assert.ok(html.includes('class="plain"'), '兜底走纯排版卡');
});

test('sample flip passes the sample image through to composeSample', () => {
  const html = composeReel({
    ...BASE,
    storyboard: [{ at: '15:00', actor: 'deliver', text: '翻页', kind: 'sample', sampleId: 's9' }],
    subtitles: [{ text: '一句。', startSec: 0, endSec: 2 }],
    durationSec: 2,
  });
  assert.ok(html.includes('带图样张'), '样张文字进镜头');
  assert.ok(html.includes('/media/pic.png'), '样张配图经模板落为背景');
});

test('plain shots: at·actor label renders when present and is omitted when empty', () => {
  const html = composeReel({
    ...BASE,
    storyboard: [
      { at: '13:30', actor: 'researcher', text: '带标签' },
      { text: '光杆分镜' },
    ],
    subtitles: [
      { text: '一', startSec: 0, endSec: 1 },
      { text: '二', startSec: 1, endSec: 2 },
    ],
    durationSec: 2,
  });
  assert.ok(html.includes('<small>13:30 · researcher</small>'), 'at · actor 标签');
  const bare = html.slice(html.indexOf('光杆分镜') - 80, html.indexOf('光杆分镜'));
  assert.ok(!bare.includes('<small>'), '无 at/actor 时不渲染空标签');
  assert.ok(!/<img/.test(html), '无配图分镜不出 <img>');
});

test('image shot carries the storyboard text as alt text', () => {
  const html = composeReel({
    ...BASE,
    storyboard: [{ at: '13:30', actor: 'researcher', text: '检索', image: '/media/x.png' }],
    subtitles: [{ text: '一', startSec: 0, endSec: 1 }],
    durationSec: 1,
  });
  assert.match(html, /<img src="\/media\/x\.png" alt="检索">/);
});

test('invalid subtitle cues are dropped from the caption track', () => {
  const tl = buildTimeline({
    storyboard: [{ at: '13:30', actor: 'a', text: 't' }],
    subtitles: [
      { text: 'ok', startSec: 0, endSec: 2 },
      { text: '倒序', startSec: 5, endSec: 3 },
      { text: 'NaN', startSec: Number.NaN, endSec: 1 },
    ],
    durationSec: 4,
  });
  assert.deepEqual(tl.tracks.caption.map(c => c.text), ['ok'], '倒序/NaN cue 不进字幕轨道');
});

test('durationSec falls back to the latest subtitle endSec when omitted', () => {
  const tl = buildTimeline({
    storyboard: [{ at: '13:30', actor: 'a', text: 't' }],
    subtitles: [{ text: '一句。', startSec: 0, endSec: 7 }],
  });
  assert.equal(tl.durationSec, 7);
  assert.equal(tl.tracks.visual[0].duration, 7);
  const html = composeReel({
    ...BASE,
    storyboard: [{ at: '13:30', actor: 'a', text: 't' }],
    subtitles: [{ text: '一句。', startSec: 0, endSec: 7 }],
  });
  const data = JSON.parse(html.match(/<script type="application\/json"[^>]*>([\s\S]*?)<\/script>/)[1]);
  assert.equal(data.durationSec, 7);
});

test('reels past a minute format their caption clock as m:ss', () => {
  const html = composeReel({
    ...BASE,
    storyboard: [{ at: '13:30', actor: 'a', text: '长镜' }],
    subtitles: [{ text: '后段。', startSec: 63, endSec: 65 }],
    durationSec: 65,
  });
  assert.ok(html.includes('<small>1:03</small>'), '63s → 1:03');
  assert.ok(html.includes('共 1:05'), '总时长 65s → 1:05');
});

test('null preview and junk sample entries render a well-formed empty reel', () => {
  for (const preview of [null, { samples: [null, { page: '无 id' }], storyboard: [], subtitles: [], durationSec: 0 }]) {
    const html = composeReel(preview);
    assert.match(html, /^<!doctype html>/i);
    assert.ok(html.includes('</html>'));
    const data = JSON.parse(html.match(/<script type="application\/json"[^>]*>([\s\S]*?)<\/script>/)[1]);
    assert.equal(data.missionId, null, '缺省元数据落 null 而非 undefined');
    assert.equal(data.version, null);
  }
});

test('timeline tolerates a non-array storyboard/subtitles instead of throwing', () => {
  const tl = buildTimeline({ storyboard: null, subtitles: undefined });
  assert.deepEqual(tl.tracks.visual, []);
  assert.deepEqual(tl.tracks.caption, []);
  assert.equal(tl.durationSec, 0);
});
