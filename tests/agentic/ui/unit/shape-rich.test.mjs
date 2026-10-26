// M04 shape 渲染器 B（富媒体/清单类）纯核单测（RED 先行 · 实现前必红）
// 依据：plan.md M04、PRD §10.3 组件目录、prototype L147-161（slide/route 结构）、L83-85（diff 类）。
// 契约：web/agentic/ui/shape/rich-shapes.js 导出
//   richShapes = { checklist, timeline, slides, diffSummary, mapRoute, personCard, sample }（纯函数 block → html）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { richShapes } from '../../../../web/agentic/ui/shape/rich-shapes.js';
import { renderShape } from '../../../../web/agentic/ui/shape/registry.js';

const { checklist, timeline, slides, diffSummary, mapRoute, personCard, sample } = richShapes;

test('M04 richShapes 导出七个渲染器', () => {
  for (const fn of [checklist, timeline, slides, diffSummary, mapRoute, personCard, sample]) {
    assert.equal(typeof fn, 'function');
  }
});

// ---- checklist ----
test('M04 checklist：完成态可区分（PRD §10.3 checklist / plan M04「含完成态」）', () => {
  const html = checklist({
    type: 'checklist',
    items: [
      { text: '带上：上次借的书', done: true },
      { text: '确认学员画像', done: false },
    ],
  });
  assert.ok(html.includes('带上：上次借的书'));
  assert.ok(html.includes('确认学员画像'));
  const doneHtml = checklist({ type: 'checklist', items: [{ text: 'a', done: true }] });
  const todoHtml = checklist({ type: 'checklist', items: [{ text: 'a', done: false }] });
  assert.notEqual(doneHtml, todoHtml, 'done 与未 done 的 HTML 必须可区分');
});

test('M04 checklist 转义', () => {
  const html = checklist({ type: 'checklist', items: [{ text: '<script>s</script>' }] });
  assert.ok(!html.includes('<script>'));
});

// ---- timeline ----
test('M04 timeline：时刻 + 事件点 + you 触点标记（prototype 分镜事件形状）', () => {
  const html = timeline({
    type: 'timeline',
    items: [
      { at: '13:30', text: '研究员先找资料' },
      { at: '13:55', text: '你确认受众', you: true },
      { at: '14:52', text: '研究交付' },
    ],
  });
  assert.ok(html.includes('13:30'));
  assert.ok(html.includes('研究员先找资料'));
  assert.ok(html.includes('你确认受众'));
  assert.ok(/you/.test(html), 'you 触点需有可样式化标记');
});

// ---- slides ----
test('M04 slides：.slide 双栏结构（tag/title/bullets，prototype L147-151）', () => {
  const html = slides({
    type: 'slides',
    pages: [
      { tag: 'AI 进课堂 · 第 2 课时', title: '用 AI 备课：提示词与核对', bullets: ['用 AI 生成导入问题', '对照课标逐条核对'] },
    ],
  });
  assert.ok(html.includes('class="slide"'));
  assert.ok(html.includes('class="txt"'));
  assert.ok(html.includes('用 AI 备课：提示词与核对'));
  assert.ok(html.includes('<li>对照课标逐条核对</li>'));
});

test('M04 slides 转义：标题与要点 esc', () => {
  const html = slides({ type: 'slides', pages: [{ tag: 't', title: '<x>', bullets: ['<y>'] }] });
  assert.ok(!html.includes('<x>'));
  assert.ok(html.includes('&lt;y&gt;'));
});

// ---- diffSummary ----
test('M04 diffSummary：新增绿/删除线/变更黄（.add/.del/.chg，prototype L83-85 + PRD §5.2 讨论）', () => {
  const html = diffSummary({
    type: 'diffSummary',
    added: ['课堂实践', '教师准备度', '落地建议'],
    removed: ['海外案例'],
    changed: ['来源范围仅国内'],
    reason: '你说只看国内 K12',
  });
  assert.ok(/class="add"/.test(html));
  assert.ok(/class="del"/.test(html));
  assert.ok(/class="chg"/.test(html));
  assert.ok(html.includes('课堂实践'));
  assert.ok(html.includes('海外案例'));
  assert.ok(html.includes('你说只看国内 K12'));
});

test('M04 diffSummary 转义', () => {
  const html = diffSummary({ type: 'diffSummary', added: ['<b>a</b>'], removed: [], changed: [] });
  assert.ok(!html.includes('<b>a</b>'));
  assert.ok(html.includes('&lt;b&gt;'));
});

// ---- mapRoute ----
test('M04 mapRoute：.route 路线卡结构（.line 条目，prototype L159-161）', () => {
  const html = mapRoute({
    type: 'mapRoute',
    title: '18:25 出发 · 地铁 32 分钟',
    lines: ['家 → 2 号线 → 静安寺站 3 口', '步行 6 分钟到「小南国」', '带上：上次借的书'],
  });
  assert.ok(html.includes('class="route"'));
  assert.ok(html.includes('18:25 出发 · 地铁 32 分钟'));
  assert.equal((html.match(/class="line"/g) || []).length, 3);
});

test('M04 mapRoute 转义', () => {
  const html = mapRoute({ type: 'mapRoute', title: 't', lines: ['<img src=x>'] });
  assert.ok(!html.includes('<img'));
});

// ---- personCard ----
test('M04 personCard：姓名/关系/要点（R1 会面对方背景摘要，PRD §5.2.2）', () => {
  const html = personCard({
    type: 'personCard',
    name: '小王',
    role: '朋友 · 上周说在找新工作',
    notes: ['想聊 Argus 的合作'],
  });
  assert.ok(html.includes('小王'));
  assert.ok(html.includes('朋友 · 上周说在找新工作'));
  assert.ok(html.includes('想聊 Argus 的合作'));
});

test('M04 personCard 转义', () => {
  const html = personCard({ type: 'personCard', name: '<b>小王</b>', role: '', notes: [] });
  assert.ok(!html.includes('<b>小王</b>'));
});

// ---- sample（Markdown 子集白名单）----
test('M04 sample：Markdown 子集——段落/**粗体**/无序列表（plan M04 白名单）', () => {
  const html = sample({
    type: 'sample',
    text: '第 2 课时活动卡（样张）：**15 分钟改教案** —— 每组一份教案。\n- 用 AI 生成 3 个导入问题\n- 对照课标逐条核对',
  });
  assert.ok(html.includes('<b>15 分钟改教案</b>'), '**x** → <b>x</b>');
  assert.ok(html.includes('<li>用 AI 生成 3 个导入问题</li>'));
  assert.ok(html.includes('第 2 课时活动卡（样张）：'));
});

test('M04 sample：白名单外标签一律转义/剥离（script/img/onerror 不得存活）', () => {
  const html = sample({
    type: 'sample',
    text: '<script>alert(1)</script><img src=x onerror=alert(2)>**安全**',
  });
  assert.ok(!/<script/i.test(html));
  assert.ok(!/<img/i.test(html));
  assert.ok(!/onerror/i.test(html.replace(/onerror=alert\(2\)/, '')), 'onerror 属性不得以可执行形式存在');
  assert.ok(html.includes('<b>安全</b>'));
});

test('M04 sample：原生 <b> 白名单标签允许保留（prototype L288 的样张文本含 <b>）', () => {
  const html = sample({ type: 'sample', text: '活动卡：<b>15 分钟改教案</b>——现场完成' });
  assert.ok(html.includes('<b>15 分钟改教案</b>'));
});

// ---- registry 集成 ----
test('M04 registry：六个富类型都能经 renderShape 出非空 HTML', () => {
  const blocks = [
    { type: 'checklist', items: [{ text: 'a', done: false }] },
    { type: 'timeline', items: [{ at: '13:30', text: 'x' }] },
    { type: 'slides', pages: [{ tag: 't', title: 'T', bullets: ['b'] }] },
    { type: 'diffSummary', added: ['a'], removed: [], changed: [] },
    { type: 'mapRoute', title: 'T', lines: ['l'] },
    { type: 'personCard', name: '小王', role: '', notes: [] },
  ];
  for (const blk of blocks) {
    const html = renderShape(blk);
    assert.equal(typeof html, 'string');
    assert.ok(html.length > 0, `${blk.type} 不应渲染为空`);
  }
});
