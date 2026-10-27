// M08 样张画廊 单测（RED 先行 · 实现前必红）
// 依据：plan.md M08、PRD §5.2.1（示意标注"所有生成画面右下角标示意"；文字不交给生图——
//   代码排版 vs 整页生成并列展示）、prototype.html L141-161（.gallery/.samp/.frame 4:3/.wm/
//   .slide/.cover/.route 结构）+ L354-372（samplesFor/sampleHTML 四模板）、
//   plan.md §1.7（图片 URL 只允许 ui/assets/ 相对路径白名单）。
// 契约：web/agentic/ui/gallery.js 具名导出
//   WATERMARK / assetURL / coverHTML / slideHTML / imgHTML / routeHTML /
//   frameHTML / frameInner / capHTML / sampleHTML / figuresHTML / galleryHTML /
//   mount(el, { samples }) → { el, update(props) }
//   props：{ samples: [{ kind, cap, src?, …模板字段 }] }；kind ∈ cover/slide/img/route。
// 增量约束（PRD §5.2 末教训 + DAG M08「update 换样张不整绘」）：
//   同内容 update 零重写；同数量换内容只逐 figure 打补丁（figure 节点不重建）；变数量才整绘。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  WATERMARK, assetURL, coverHTML, slideHTML, imgHTML, routeHTML,
  frameHTML, frameInner, capHTML, sampleHTML, figuresHTML, galleryHTML, mount,
} from '../../../../web/agentic/ui/gallery.js';

// 黄金场景样张（prototype L354-364 同源；c 块 slide+img 并列 = 代码排版 vs 整页生成对照）
const SAMPLES = [
  { kind: 'cover', cap: '报告封面与首页 · 代码排版 + 配图（z-image-turbo 3.9s）' },
  { kind: 'slide', cap: '第 2 课时首页 · <b>文字由代码排版</b>，配图 z-image-turbo 3.9s（零错字、可编辑）' },
  { kind: 'img', src: 'assets/slide-qwen.jpg', cap: '整页由 qwen-image-2.0 生成 7.4s · 图中中文也能写对，但不可编辑' },
  { kind: 'route', cap: '行前简报卡 · 路线与出发时刻（高德）' },
];

// ---------- 纯核：统一结构与「示意」水印 ----------

test('M08 sampleHTML：figure.samp > .frame(模板+span.wm) + figcaption（prototype L371-372）', () => {
  for (const sm of SAMPLES) {
    const html = sampleHTML(sm);
    assert.ok(html.startsWith('<figure class="samp"><div class="frame">'), 'figure>frame 开头');
    assert.ok(html.includes(`<span class="wm">${WATERMARK}</span>`), '水印在 frame 内');
    assert.ok(html.indexOf('<span class="wm">') < html.indexOf('</div><figcaption>'), '水印在 frame 闭合前（模板之后）');
    assert.ok(html.endsWith(`</div><figcaption>${capHTML(sm)}</figcaption></figure>`), 'figcaption 收尾');
  }
  assert.equal(WATERMARK, '示意', 'PRD §5.2.1：所有生成画面右下角标"示意"');
});

test('M08 figuresHTML/galleryHTML：逐样张连接、null 过滤、外层 .gallery 包裹（prototype L405）', () => {
  assert.equal((figuresHTML(SAMPLES).match(/<figure /g) || []).length, 4);
  assert.equal(figuresHTML([null, SAMPLES[3], undefined]).trim(), sampleHTML(SAMPLES[3]), 'null/undefined 条目过滤');
  assert.equal(figuresHTML([]), '');
  assert.equal(figuresHTML(undefined), '', '非数组容忍为空');
  const g = galleryHTML(SAMPLES);
  assert.ok(g.startsWith('<div class="gallery">') && g.endsWith('</div>'), 'galleryHTML 带 .gallery 容器');
  assert.equal((g.match(/<figure /g) || []).length, 4);
});

test('M08 capHTML：esc 五实体 + 仅放行 <b> 白名单（prototype L368 cap 含 <b>；M04 sample 同款规则）', () => {
  assert.equal(capHTML({ cap: '纯文本' }), '纯文本');
  assert.equal(capHTML({ cap: 'a<b>b</b>c' }), 'a<b>b</b>c', '<b> 白名单放行');
  assert.equal(capHTML({ cap: '<script>x</script>' }), '&lt;script&gt;x&lt;/script&gt;', 'script 全转义');
  assert.equal(capHTML({ cap: '<i>i</i>' }), '&lt;i&gt;i&lt;/i&gt;', '白名单外标签保持转义');
  assert.equal(capHTML({ cap: '<b onmouseover=alert(1)>x</b>' }), '&lt;b onmouseover=alert(1)&gt;x&lt;/b&gt;', '带属性的 b 不放行');
  assert.equal(capHTML({}), '', '缺 cap 输出空串不炸');
});

// ---------- 纯核：ui/assets/ 图片白名单 ----------

test('M08 assetURL：裸文件名补 assets/ 前缀、已带前缀原样（prototype ASSET=L353）', () => {
  assert.equal(assetURL('slide-qwen.jpg'), 'assets/slide-qwen.jpg');
  assert.equal(assetURL('assets/slide-qwen.jpg'), 'assets/slide-qwen.jpg');
  assert.equal(assetURL('sub/dir/x.png'), 'assets/sub/dir/x.png', 'assets/ 内嵌套子目录放行');
});

test('M08 assetURL：协议/绝对路径/../data: 一律拒绝（plan §1.7 XSS 基线）', () => {
  for (const bad of [
    'http://evil/x.jpg', 'https://evil/x.jpg', '//evil/x.jpg', '/abs/x.jpg',
    '../secret.jpg', 'assets/../config.json', 'a/../b.jpg',
    'data:image/png;base64,AAAA', 'javascript:alert(1)', 'assets/', '', undefined, null, 42,
  ]) {
    assert.equal(assetURL(bad), '', `必须拒绝：${String(bad)}`);
  }
});

// ---------- 纯核：四模板 ----------

test('M08 cover：.cover > .pic + .meta（b 标题 + small muted 副题 + .nums 数字行）（prototype L153-157/L370）', () => {
  const html = coverHTML({});
  assert.ok(html.includes('<div class="cover">'));
  assert.ok(html.includes('<div class="pic" style="background-image:url(\'assets/illus-lesson.jpg\')"></div>'), '默认配图带 assets/ 前缀');
  assert.ok(html.includes('<b>AI 教育现状与趋势</b>'), '缺省用 prototype 黄金标题');
  assert.ok(html.includes('<span class="small muted">研究报告 · 约 3000 字</span>'));
  const nums = html.match(/<div class="nums">(.*?)<\/div>/)[1];
  assert.equal((nums.match(/<span>/g) || []).length, 3, '三组数字');
  assert.ok(nums.includes('<i>5</i>节') && nums.includes('<i>7–12</i>引用') && nums.includes('<i>100%</i>结论挂来源'));
});

test('M08 cover 自定义字段覆盖缺省；nums 兼容 {v,label} 与数组两项', () => {
  const html = coverHTML({ title: 'T<b>1</b>', sub: 'S', nums: [['9', '页'], { v: '3–5', label: '图' }] });
  assert.ok(html.includes('<b>T&lt;b&gt;1&lt;/b&gt;</b>'), '标题 esc，不吃 HTML');
  assert.ok(html.includes('<span class="small muted">S</span>'));
  assert.ok(html.includes('<i>9</i>页') && html.includes('<i>3–5</i>图'));
  assert.ok(!html.includes('AI 教育现状与趋势'));
});

test('M08 cover 非法配图 src：不放行即不输出 .pic（不写非法 URL 进 style）', () => {
  const html = coverHTML({ pic: 'http://evil/x.jpg' });
  assert.ok(!html.includes('background-image'), '拒绝的 URL 绝不进 style');
  assert.ok(html.includes('<div class="cover"><div class="meta">'), '结构仍完整（pic 缺省省略）');
});

test('M08 slide：.slide 双栏 .txt(.tag+h4+ul) + .pic（prototype L147-152/L369）', () => {
  const html = slideHTML({});
  assert.ok(html.startsWith('<div class="slide"><div class="txt">'));
  assert.ok(html.includes('<span class="tag">AI 进课堂 · 第 2 课时</span>'));
  assert.ok(html.includes('<h4>用 AI 备课：提示词与核对</h4>'));
  const ul = html.match(/<ul>(.*?)<\/ul>/)[1];
  assert.equal((ul.match(/<li>/g) || []).length, 3, '缺省三条要点');
  assert.ok(ul.includes('<li>让 AI 生成 3 个导入问题</li>'));
  assert.ok(html.includes('<div class="pic" style="background-image:url(\'assets/illus-lesson.jpg\')"></div>'));
});

test('M08 slide 自定义 tag/title/bullets/src 覆盖 + 要点 esc', () => {
  const html = slideHTML({ tag: 'T1', title: '标题<x>', bullets: ['a&b', 'c'], pic: 'assets/p.png' });
  assert.ok(html.includes('<span class="tag">T1</span>'));
  assert.ok(html.includes('<h4>标题&lt;x&gt;</h4>'));
  assert.ok(html.includes('<li>a&amp;b</li>'), '要点 esc');
  assert.ok(html.includes("url('assets/p.png')"));
  assert.ok(!html.includes('用 AI 备课'));
});

test('M08 img：<img src=白名单路径 alt="">；非法 src 不输出 img（prototype L367）', () => {
  assert.equal(imgHTML({ src: 'assets/slide-qwen.jpg' }), '<img src="assets/slide-qwen.jpg" alt="">');
  assert.equal(imgHTML({ src: 'bookshelf-done.jpg' }), '<img src="assets/bookshelf-done.jpg" alt="">', '裸名补前缀');
  assert.equal(imgHTML({ src: 'http://e/x.jpg' }), '');
  assert.equal(imgHTML({ src: 'assets/' }), '');
  assert.equal(imgHTML({}), '', '缺 src 不渲染空 img');
});

test('M08 route：.route > b 标题 + .line 条目，缺省四条（prototype L159-161/L370）', () => {
  const html = routeHTML({});
  assert.ok(html.startsWith('<div class="route">'));
  assert.ok(html.includes('<b>18:25 出发 · 地铁 32 分钟</b>'));
  assert.equal((html.match(/<div class="line">/g) || []).length, 4);
  assert.ok(html.includes('<div class="line">家 → 2 号线 → 静安寺站 3 口</div>'));
});

test('M08 route 自定义 title/lines 覆盖 + esc', () => {
  const html = routeHTML({ title: '晨跑', lines: ['A → B', '<b>x</b>'] });
  assert.ok(html.includes('<b>晨跑</b>'));
  assert.equal((html.match(/<div class="line">/g) || []).length, 2);
  assert.ok(html.includes('<div class="line">&lt;b&gt;x&lt;/b&gt;</div>'), 'line 内容 esc');
});

test('M08 未知 kind：不炸、不渲染未知模板，frame 仅剩水印（降级占位）', () => {
  const html = sampleHTML({ kind: 'hologram', cap: 'X' });
  assert.ok(html.includes('<figure class="samp">'));
  assert.ok(html.includes(`<span class="wm">${WATERMARK}</span>`), '水印仍在');
  assert.ok(html.endsWith('</div><figcaption>X</figcaption></figure>'));
  assert.equal((html.match(/<div class="/g) || []).length, 1, '除 .frame 外无模板容器');
});

test('M08 frameHTML/frameInner：壳与内核分离（patch 复用同一内核）', () => {
  const outer = frameHTML(SAMPLES[3]);
  assert.ok(outer.startsWith('<div class="frame">') && outer.endsWith('</div>'));
  assert.ok(outer.includes(routeHTML(SAMPLES[3])));
  assert.ok(outer.includes(`<span class="wm">${WATERMARK}</span>`));
  assert.equal(frameInner(SAMPLES[3]), routeHTML(SAMPLES[3]) + `<span class="wm">${WATERMARK}</span>`);
});

// ---------- DOM 壳（mount/update）· DOM 桩同 M05 stubEl 模式 ----------

function stubNode(tag, cls) {
  return {
    tag, className: cls || '', _h: undefined, _v: '', children: {},
    get innerHTML() { return this._v; },
    set innerHTML(v) { this._v = v; },
    setAttribute(k, v) { this[k] = v; },
    getAttribute(k) { return this[k]; },
    querySelector(sel) { return this.children[sel] ?? null; },
  };
}
function stubFigure() {
  const fig = stubNode('figure', 'samp');
  fig.children['.frame'] = stubNode('div', 'frame');
  fig.children['figcaption'] = stubNode('figcaption', '');
  return fig;
}
function stubHost(figs = []) {
  return {
    _h: undefined, _v: '', writes: 0, figs, classes: new Set(),
    listeners: {},
    get innerHTML() { return this._v; },
    set innerHTML(v) { this.writes += 1; this._v = v; },
    get classList() {
      const s = this.classes;
      return { add(c) { s.add(c); } };
    },
    querySelectorAll(sel) { return sel === 'figure.samp' ? this.figs : []; },
  };
}

test('M08 mount：首渲染整写一次 + 宿主加 .gallery 类 + handle 契约', () => {
  const host = stubHost();
  const handle = mount(host, { samples: SAMPLES });
  assert.equal(host.writes, 1);
  assert.equal((host.innerHTML.match(/<figure /g) || []).length, 4);
  assert.ok(host.classes.has('gallery'), '宿主补 .gallery 类（prototype L405 容器语义）');
  assert.equal(handle.el, host);
  assert.equal(typeof handle.update, 'function');
});

test('M08 update 同内容：零重写（figure 节点身份保留，DAG M08 增量约束）', () => {
  const host = stubHost();
  const handle = mount(host, { samples: SAMPLES });
  host.figs = SAMPLES.map(() => stubFigure()); // 模拟浏览器解析出的节点
  host.figs[0].setAttribute('data-marker', 'keep');
  host.writes = 0;
  handle.update({ samples: JSON.parse(JSON.stringify(SAMPLES)) });
  assert.equal(host.writes, 0, '同集合不得重写容器');
  assert.equal(host.figs[0].getAttribute('data-marker'), 'keep');
  assert.equal(host.figs.length, 4);
});

test('M08 update 同数量换内容：只逐 figure 打补丁，节点不重建（换样张不整绘）', () => {
  const host = stubHost();
  const handle = mount(host, { samples: [SAMPLES[0], SAMPLES[1]] });
  host.figs = [stubFigure(), stubFigure()];
  host.figs[0].setAttribute('data-marker', 'keep-0');
  host.figs[1].setAttribute('data-marker', 'keep-1');
  host.writes = 0;
  handle.update({ samples: [{ kind: 'route', cap: '新 A' }, { kind: 'img', src: 'assets/b.jpg', cap: '新 B' }] });
  assert.equal(host.writes, 0, '数量未变：容器 innerHTML 不得重写');
  assert.equal(host.figs[0].getAttribute('data-marker'), 'keep-0', 'figure 节点身份保留');
  assert.equal(host.figs[1].getAttribute('data-marker'), 'keep-1');
  assert.ok(host.figs[0].children['.frame'].innerHTML.includes('<div class="route">'), '第 1 格换 route 模板');
  assert.equal(host.figs[0].children['figcaption'].innerHTML, '新 A');
  assert.ok(host.figs[1].children['.frame'].innerHTML.includes('<img src="assets/b.jpg"'), '第 2 格换 img 模板');
  assert.ok(host.figs[1].children['.frame'].innerHTML.includes('<span class="wm">示意</span>'), '补丁后水印仍在');
});

test('M08 update 变数量：全量重绘换卡（4→1 清晰换卡）', () => {
  const host = stubHost();
  const handle = mount(host, { samples: SAMPLES });
  host.figs = SAMPLES.map(() => stubFigure());
  host.writes = 0;
  handle.update({ samples: [{ kind: 'route', cap: '新路线卡' }] });
  assert.equal(host.writes, 1, '数量变了必须整绘');
  assert.equal((host.innerHTML.match(/<figure /g) || []).length, 1);
  assert.ok(host.innerHTML.includes('<figcaption>新路线卡</figcaption>'));
  handle.update({ samples: [] }); // 清空
  assert.equal(host.innerHTML, '');
});

test('M08 update 容错：空 props 不动旧值、非法 samples 归空、宿主无查询能力兜底整绘', () => {
  const host = stubHost();
  const handle = mount(host, { samples: [SAMPLES[0]] });
  host.figs = [stubFigure()];
  const ret = handle.update({}).update(undefined);
  assert.equal(typeof ret.update, 'function', '链式返回 handle');
  assert.equal(host.writes, 1, '空 props 零额外写入（仅首渲染）');
  handle.update({ samples: 'not-array' });
  assert.equal(host.innerHTML, '', '非数组按空归一');
  handle.update({ samples: [SAMPLES[2]] });
  host.figs = [];
  host.writes = 0;
  handle.update({ samples: [{ kind: 'img', src: 'a.jpg', cap: 'Z' }] }); // figs 数量不匹配 → 兜底
  assert.equal(host.writes, 1);
  assert.ok(host.innerHTML.includes('assets/a.jpg'));
  const noQuery = { _h: undefined, _v: '', writes: 0, get innerHTML() { return this._v; }, set innerHTML(v) { this.writes += 1; this._v = v; } };
  const h2 = mount(noQuery, { samples: [SAMPLES[0]] }); // 无 querySelectorAll/classList：mount 不得抛
  assert.equal(noQuery.writes, 1);
  h2.update({ samples: [SAMPLES[3]] });
  assert.equal(noQuery.writes, 2);
});

test('M08 补丁路径裸 figure（缺 .frame/figcaption 子节点）：回退整绘不静默丢更新', () => {
  const host = stubHost();
  const handle = mount(host, { samples: [SAMPLES[0], SAMPLES[1]] });
  host.figs = [stubNode('figure', 'samp'), stubFigure()]; // 第 1 格被子节点剥掉
  host.writes = 0;
  handle.update({ samples: [{ kind: 'route', cap: 'A' }, { kind: 'route', cap: 'B' }] });
  assert.equal(host.writes, 1, '补不了必须整绘兜底');
  assert.ok(host.innerHTML.includes('<figcaption>B</figcaption>'));
});

test('M08 mount 容错：null 条目过滤后渲染、mount(el) 缺 props 不炸', () => {
  const host = stubHost();
  mount(host, { samples: [null, SAMPLES[3], undefined] });
  assert.equal((host.innerHTML.match(/<figure /g) || []).length, 1);
  const host2 = stubHost();
  mount(host2);
  assert.equal(host2.innerHTML, '');
});
