// W11 composer · composeSample 先行单测（RED 契约，快照先行）。
// 依据：BUILD-PLAN §3 W11.2 + DAG 组1c：composeSample(sample, image)→自有模板 HTML 片段，
// 五种 layout（幻灯片/报告首页/活动卡/成品效果图卡/路线卡，PRD §5.2.2 + §10.3 samples）；
// 文字全部由代码排版；未知 layout 降级纯文本卡；「示意」水印在 .frame 内叠加
// <span class="wm">示意</span>（prototype.html:146,371），绝不改写缓存原图。
// 快照的类名与结构对照 prototype.html:354-373（.samp/.frame/.slide/.cover/.route）。
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { composeSample } from '../../../../../scripts/agentic/composer/compose-sample.mjs';

const norm = html => html.replace(/\s+/g, ' ').replace(/>\s+</g, '><').trim();

// PRD §10.3 的 s1 样例（幻灯片）
const SLIDE = {
  id: 's1',
  layout: 'slide-title-bullets-image',
  page: '第 2 课时 · 首页',
  text: {
    tag: 'AI 进课堂 · 第 2 课时',
    title: 'AI 进课堂 · 第 2 课时：用 AI 备课',
    bullets: ['用 AI 生成导入问题', '对照课标逐条核对', '说出 AI 帮了哪、错在哪'],
  },
  watermark: '示意',
};
const SLIDE_IMAGE = { url: '/api/media/abc.png', prompt: '老师在教室用平板备课，清新鼠尾草绿，扁平插画，无文字', model: 'z-image-turbo' };

test('snapshot: slide layout renders the PRD s1 sample exactly (prototype .slide structure)', () => {
  const html = composeSample(SLIDE, SLIDE_IMAGE);
  assert.equal(norm(html), norm(`
    <figure class="samp" data-layout="slide-title-bullets-image">
      <div class="frame">
        <div class="slide">
          <div class="txt">
            <span class="tag">AI 进课堂 · 第 2 课时</span>
            <h4>AI 进课堂 · 第 2 课时：用 AI 备课</h4>
            <ul><li>用 AI 生成导入问题</li><li>对照课标逐条核对</li><li>说出 AI 帮了哪、错在哪</li></ul>
          </div>
          <div class="pic" style="background-image:url('/api/media/abc.png')"></div>
        </div>
        <span class="wm">示意</span>
      </div>
      <figcaption>第 2 课时 · 首页</figcaption>
    </figure>`));
});

test('snapshot: report cover renders title/subtitle/numbers code-typeset (prototype .cover structure)', () => {
  const sample = {
    id: 's2',
    layout: 'report-cover',
    page: '报告 · 封面',
    text: {
      title: '国内 K12 的 AI 教育现状',
      subtitle: '研究报告 · 约 3000 字',
      nums: [{ n: '5', label: '节' }, { n: '7–12', label: '引用' }],
    },
    watermark: '示意',
  };
  const html = composeSample(sample, { url: '/api/media/cover.png', model: 'z-image-turbo' });
  assert.equal(norm(html), norm(`
    <figure class="samp" data-layout="report-cover">
      <div class="frame">
        <div class="cover">
          <div class="pic" style="background-image:url('/api/media/cover.png')"></div>
          <div class="meta">
            <b>国内 K12 的 AI 教育现状</b>
            <span class="small muted">研究报告 · 约 3000 字</span>
            <div class="nums"><span><i>5</i>节</span><span><i>7–12</i>引用</span></div>
          </div>
        </div>
        <span class="wm">示意</span>
      </div>
      <figcaption>报告 · 封面</figcaption>
    </figure>`));
});

const LAYOUTS = [
  { layout: 'slide-title-bullets-image', sample: SLIDE, image: SLIDE_IMAGE },
  { layout: 'report-cover', sample: { id: 's2', layout: 'report-cover', page: '封面', text: { title: 'T', subtitle: 'S', nums: [{ n: '5', label: '节' }] } }, image: { url: '/api/media/c.png' } },
  { layout: 'activity-card', sample: { id: 's3', layout: 'activity-card', page: '活动卡', text: { title: '课时活动：AI 备课演练', steps: ['分组生成导入问题', '对照课标核对', '一分钟复盘'] } }, image: { url: '/api/media/a.png' } },
  { layout: 'product-card', sample: { id: 's4', layout: 'product-card', page: '成品效果图', text: { title: '三层书架 · 成品示意' } }, image: { url: '/api/media/p.png' } },
  { layout: 'route-card', sample: { id: 's5', layout: 'route-card', page: '路线卡', text: { title: '18:25 出发 · 地铁 32 分钟', lines: ['家 → 2 号线 → 静安寺站 3 口', '步行 6 分钟到「小南国」', '带上：上次借的书'] } }, image: null },
];

test('all five layouts render a code-typeset sample with the 示意 watermark inside .frame', () => {
  for (const { layout, sample, image } of LAYOUTS) {
    const html = composeSample(sample, image);
    assert.ok(typeof html === 'string' && html.length > 0, layout + ' 必须产出 HTML 片段');
    assert.ok(html.includes(`data-layout="${layout}"`), layout + ' 根节点带 data-layout');
    assert.ok(html.includes('<div class="frame">'), layout + ' 必须有 .frame');
    const frame = html.slice(html.indexOf('<div class="frame">'), html.indexOf('</figure>'));
    assert.ok(frame.includes('<span class="wm">示意</span>'), layout + ' 水印必须在 .frame 内');
  }
});

test('every input text appears in the output verbatim (样张文字与输入一致)', () => {
  const html = composeSample(SLIDE, SLIDE_IMAGE);
  const text = html.replace(/<[^>]+>/g, ' ');
  for (const s of [SLIDE.text.tag, SLIDE.text.title, ...SLIDE.text.bullets, SLIDE.page]) {
    assert.ok(text.includes(s), '输出必须包含输入文本：' + s);
  }
  // 文字没有被二次转义或改写
  assert.ok(!text.includes('&lt;'), '可见文本不得残留转义实体');

  const route = LAYOUTS[4];
  const routeHtml = composeSample(route.sample, route.image).replace(/<[^>]+>/g, ' ');
  for (const s of [route.sample.text.title, ...route.sample.text.lines]) {
    assert.ok(routeHtml.includes(s));
  }
});

test('the cached image is referenced as-is; the watermark is never baked into the image', () => {
  const html = composeSample(SLIDE, SLIDE_IMAGE);
  assert.ok(html.includes("url('/api/media/abc.png')"), '配图 URL 原样引用');
  // 配图只做背景/插图位，不承载文字：模板文字节点之外没有把文字写进图里的通道
  assert.equal(html.match(/<img/g), null);
});

test('unknown layouts degrade to a plain text card instead of throwing', () => {
  const html = composeSample({ id: 'sx', layout: 'hologram-3000', page: '未知', text: { title: '幻灯片换成深色', bullets: ['第一点'] } }, null);
  assert.ok(html.includes('幻灯片换成深色'));
  assert.ok(html.includes('第一点'));
  assert.ok(html.includes('<span class="wm">示意</span>'), '降级卡仍须带示意水印');
  for (const cls of ['class="slide"', 'class="cover"', 'class="route"']) {
    assert.ok(!html.includes(cls), '降级卡不得套用已知模板');
  }
});

test('malicious text is escaped everywhere it lands (安全门禁：HTML 模板转义)', () => {
  const evil = { ...SLIDE, text: { tag: '<img src=x onerror=alert(1)>', title: '<script>alert("x")</script>', bullets: ['<b>加粗</b>注入'] } };
  const html = composeSample(evil, SLIDE_IMAGE);
  assert.ok(!html.includes('<img src=x'), '标题注入的 <img> 不得原样出现');
  assert.ok(!html.includes('<script>'), '<script> 不得原样出现');
  assert.ok(html.includes('&lt;script&gt;'), '必须以转义形式呈现输入');
  assert.ok(html.includes('&lt;b&gt;加粗&lt;/b&gt;注入'), 'bullet 转义保留内容');

  const evilAttr = composeSample(SLIDE, { url: '/api/media/x".png' });
  assert.ok(!evilAttr.includes('x".png'), '属性里的引号必须转义');
  assert.ok(evilAttr.includes('x&quot;.png'));
});

test('image may still be pending (null) — text card renders without a picture', () => {
  const html = composeSample(SLIDE, null);
  assert.ok(html.includes(SLIDE.text.title));
  assert.ok(!html.includes('undefined'), '缺图不得渲染出 undefined');
  assert.ok(!html.includes('null'));
});
