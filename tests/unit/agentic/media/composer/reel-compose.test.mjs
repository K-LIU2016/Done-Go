// W11 composer · composeReel 先行单测（RED 契约）。
// 依据：DAG 组2(2)：composeReel(preview)→自包含 HTML（内联引用 web/agentic/reel 样式与
// 数据；分镜/样张翻页/Ken Burns/字幕四类轨道）；视觉规格照 prototype.html:165-185：
// 16:9 stage、交叉过渡 .6s、kb 动画 7s ease-out scale 1.09、字幕条 aria-live。
// PRD §10.3：reel.composition 是自有模板渲染的 HTML，agent 只提供数据不提供 HTML。
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { composeReel } from '../../../../../scripts/agentic/composer/compose-reel.mjs';

const PREVIEW = {
  missionId: 'm_123',
  version: 4,
  samples: [
    { id: 's1', layout: 'slide-title-bullets-image', page: '第 2 课时 · 首页', text: { title: '用 AI 备课', bullets: ['生成导入问题'] }, watermark: '示意' },
  ],
  storyboard: [
    { at: '13:30', actor: 'researcher', text: '检索与筛选来源', image: '/media/x.png' },
    { at: '15:00', actor: 'deliver', text: '课程设计交付', kind: 'sample', sampleId: 's1' },
  ],
  subtitles: [
    { text: '下午一点半，我先去找资料。', startSec: 0, endSec: 3 },
    { text: '五点你会拿到课程方案。', startSec: 3, endSec: 6 },
  ],
  durationSec: 6,
  narrationAudio: '/previews/m_123/v4/narration.wav',
};

test('composeReel returns one self-contained HTML document with inlined style and data', () => {
  const html = composeReel(PREVIEW);
  assert.match(html, /^<!doctype html>/i);
  assert.ok(html.includes('</html>'));
  assert.ok(!/<script\s+src=/.test(html), '不得外链脚本');
  assert.ok(!/<link\s+rel="stylesheet"/.test(html), '不得外链样式');
  assert.ok(html.includes('<style'), '样式必须内联');
  assert.ok(html.includes('type="application/json"'), '时间轴数据必须以数据岛内联');
});

test('the stage matches the prototype spec: 16:9, progress bar, polite captions, 示意 watermark', () => {
  const html = composeReel(PREVIEW);
  assert.ok(html.includes('class="stage"'));
  assert.match(html, /aspect-ratio:\s*16\s*\/\s*9/);
  assert.ok(html.includes('class="prog"'), '顶部 3px 进度条');
  assert.ok(html.includes('aria-live="polite"'), '字幕条 aria-live=polite');
  assert.ok(html.includes('<span class="wm">示意</span>'), '画面右下角示意水印');
});

test('every timeline element is rendered with HyperFrames data attributes', () => {
  const html = composeReel(PREVIEW);
  const visual = (html.match(/data-track="visual"/g) ?? []).length;
  const caption = (html.match(/data-track="caption"/g) ?? []).length;
  assert.equal(visual, PREVIEW.storyboard.length, '分镜/样张翻页都带画面轨道属性');
  assert.equal(caption, PREVIEW.subtitles.length, '字幕逐条带字幕轨道属性');
  for (const m of html.matchAll(/data-start="([^"]*)"/g)) assert.ok(!Number.isNaN(Number(m[1])));
});

test('Ken Burns and cross-fade follow the prototype numbers (7s ease-out scale 1.09, opacity .6s)', () => {
  const html = composeReel(PREVIEW);
  assert.ok(html.includes('@keyframes kb'));
  assert.ok(html.includes('scale(1.09)'));
  assert.match(html, /7s/);
  assert.match(html, /ease-out/);
  assert.match(html, /opacity[^;]*\.6s/, '镜头交叉过渡 .6s');
});

test('sample flips reuse the composed sample markup inside the reel', () => {
  const html = composeReel(PREVIEW);
  assert.ok(html.includes('data-sample-id="s1"'), '样张翻页镜头必须能定位到 sampleId');
  assert.ok(html.includes('用 AI 备课'), '样张文字进时间轴');
});

test('the narration audio is wired in as the timeline master clock when present', () => {
  const withAudio = composeReel(PREVIEW);
  assert.match(withAudio, /<audio[^>]*\/previews\/m_123\/v4\/narration\.wav/);
  const withoutAudio = composeReel({ ...PREVIEW, narrationAudio: null });
  assert.ok(!/<audio/.test(withoutAudio), '无旁白时不渲染 audio 元素');
});

test('narration text is escaped everywhere, including inside the JSON data island', () => {
  const hostile = {
    ...PREVIEW,
    subtitles: [
      { text: '</script><script>alert("x")</script>', startSec: 0, endSec: 3 },
    ],
    storyboard: [PREVIEW.storyboard[0]],
    durationSec: 3,
  };
  const html = composeReel(hostile);
  assert.ok(!html.includes('<script>alert'), '字幕文本不得逃出转义');
  const island = html.match(/<script type="application\/json"[^>]*>([\s\S]*?)<\/script>/);
  assert.ok(island, '数据岛必须存在');
  const data = JSON.parse(island[1]);  // 数据岛内 < 必须转义，否则整段 HTML 被截断
  assert.equal(data.durationSec, 3);
});

test('the embedded data island carries the timeline the player needs', () => {
  const html = composeReel(PREVIEW);
  const island = html.match(/<script type="application\/json"[^>]*>([\s\S]*?)<\/script>/);
  const data = JSON.parse(island[1]);
  assert.equal(data.durationSec, 6);
  assert.ok(Array.isArray(data.elements ?? data.timeline), '数据岛包含时间轴元素');
});

test('a minimal preview without subtitles or samples still renders (吃下 W0 fixtures 的前提)', () => {
  const html = composeReel({ missionId: 'm', version: 1, samples: [], storyboard: [], subtitles: [], durationSec: 0 });
  assert.match(html, /^<!doctype html>/i);
  assert.ok(html.includes('</html>'));
});
