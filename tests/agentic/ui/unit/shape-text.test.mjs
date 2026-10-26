// M03 shape 渲染器 A（文本结构类）纯核单测（RED 先行 · 实现前必红）
// 依据：plan.md M03、PRD §10.3 blocks[] 与「未知类型降级为纯文本」、prototype L396-404。
// 契约：
//   web/agentic/ui/shape/registry.js  导出 registerShape(type, fn) / renderShape(block) → html
//   web/agentic/ui/shape/text-shapes.js 导出 textShapes = { outline, facts, caveat, table, cards }（纯函数 block → html）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerShape, renderShape } from '../../../../web/agentic/ui/shape/registry.js';
import { textShapes } from '../../../../web/agentic/ui/shape/text-shapes.js';

const { outline, facts, caveat, table, cards } = textShapes;

const OUTLINE_BASE = {
  type: 'outline',
  items: [
    { h: '政策与标准', q: '各国对 AI 教育提出了什么要求？' },
    { h: '市场与产品', q: '主要 AI 教育产品与商业模式' },
  ],
};
const OUTLINE_PATCHED = {
  type: 'outline',
  items: [
    { h: '政策与标准', q: '2024–2026 国家与地方对中小学 AI 教育提出了什么要求？', d: 'chg' },
    { h: '课堂实践', q: '初中阶段常见的 AI 教学活动形态与课时安排？', d: 'add' },
    { h: '海外案例', q: '美国、芬兰的 AI 课程框架', d: 'del' },
  ],
};

test('M03 textShapes 导出五个渲染器', () => {
  for (const fn of [outline, facts, caveat, table, cards]) assert.equal(typeof fn, 'function');
});

test('M03 outline：ol.outline + li 内 b 标题与 .q 问题（prototype L396）', () => {
  const html = outline(OUTLINE_BASE);
  assert.ok(html.includes('<ol class="outline">'), '应为 ol.outline');
  assert.ok(html.includes('<b>政策与标准</b>'));
  assert.ok(html.includes('class="q"'));
  assert.ok(html.includes('各国对 AI 教育提出了什么要求？'));
  assert.equal((html.match(/<li/g) || []).length, 2);
});

test('M03 outline 差异类：add/del/chg 落在 li class（prototype L265-269/L396）', () => {
  const html = outline(OUTLINE_PATCHED);
  assert.ok(/<li class="chg">/.test(html), '政策与标准 → chg');
  assert.ok(/<li class="add">/.test(html), '课堂实践 → add');
  assert.ok(/<li class="del">/.test(html), '海外案例 → del');
});

test('M03 outline 转义：h/q 中的 HTML 一律 esc（M01 XSS 基线）', () => {
  const html = outline({ type: 'outline', items: [{ h: '<script>x</script>', q: '<img src=x>' }] });
  assert.ok(!html.includes('<script>'));
  assert.ok(!html.includes('<img'));
  assert.ok(html.includes('&lt;script&gt;'));
});

const FACTS = {
  type: 'facts',
  items: [
    { k: '来源范围', v: '公开网页、论文、媒体（国内外）' },
    { k: '预计篇幅', v: '约 3000 字 · 7–12 个引用' },
  ],
};

test('M03 facts：dl.kv + dt/dd 对（prototype L398）', () => {
  const html = facts(FACTS);
  assert.ok(html.includes('<dl class="kv">'));
  assert.ok(html.includes('<dt>来源范围</dt>'));
  assert.ok(html.includes('<dd>公开网页、论文、媒体（国内外）</dd>'));
  assert.equal((html.match(/<dt>/g) || []).length, 2);
});

test('M03 facts 转义：k/v 均走 esc', () => {
  const html = facts({ type: 'facts', items: [{ k: 'a<b', v: '"c"&d' }] });
  assert.ok(html.includes('a&lt;b'));
  assert.ok(html.includes('&quot;c&quot;&amp;d'));
});

test('M03 caveat：p.caveat + ⚠ 前缀（prototype L404）', () => {
  const html = caveat({ type: 'caveat', text: '无法访问付费数据库，改用公开来源' });
  assert.ok(html.includes('class="caveat"'));
  assert.ok(html.includes('⚠'));
  assert.ok(html.includes('无法访问付费数据库'));
});

test('M03 caveat 转义', () => {
  const html = caveat({ type: 'caveat', text: '<b>不是粗体</b>' });
  assert.ok(!html.includes('<b>不是粗体'));
  assert.ok(html.includes('&lt;b&gt;'));
});

const TABLE = {
  type: 'table',
  head: ['课时', '目标', '活动', '评估'],
  rows: [
    ['1', '认识生成式 AI：能做什么、不能做什么', '人机对比小实验', '课堂小测'],
    ['2', '用 AI 备课：提示词与核对', '现场改写一份教案', '教案互评'],
  ],
};

test('M03 table：table.units + thead 表头 + 行数一致（prototype L79-80/L397）', () => {
  const html = table(TABLE);
  assert.ok(html.includes('<table class="units">'));
  assert.ok(html.includes('<th>课时</th>'));
  assert.equal((html.match(/<tr>/g) || []).length, 2);
  assert.ok(html.includes('现场改写一份教案'));
});

test('M03 table 转义：单元格内容 esc', () => {
  const html = table({ type: 'table', head: ['a'], rows: [['<svg onload=alert(1)>']] });
  assert.ok(!html.includes('<svg'));
  assert.ok(html.includes('&lt;svg'));
});

const CARDS = {
  type: 'cards',
  title: '活动卡',
  items: [
    { title: '15 分钟改教案', body: '每组拿一份真实七年级物理教案，用 AI 生成 3 个导入问题' },
    { title: '活动卡展示', body: '对照课标逐条核对，删掉不准确的' },
  ],
};

test('M03 cards：条目标题与正文都渲染且转义', () => {
  const html = cards(CARDS);
  assert.ok(html.includes('15 分钟改教案'));
  assert.ok(html.includes('对照课标逐条核对'));
  const evil = cards({ type: 'cards', items: [{ title: '<i>x</i>', body: '<script>y</script>' }] });
  assert.ok(!evil.includes('<script>'));
  assert.ok(!evil.includes('<i>x</i>'));
});

test('M03 registry：registerShape 注册后 renderShape 分发到对应渲染器', () => {
  let called = null;
  registerShape('__t_fake', (block) => { called = block; return '<p>fake</p>'; });
  const out = renderShape({ type: '__t_fake', marker: 42 });
  assert.equal(out, '<p>fake</p>');
  assert.equal(called.marker, 42);
});

test('M03 registry：内置类型可渲染（fixtures 形状直通）', () => {
  for (const blk of [OUTLINE_BASE, FACTS, TABLE]) {
    const html = renderShape(blk);
    assert.equal(typeof html, 'string');
    assert.ok(html.length > 0, `${blk.type} 不应渲染为空`);
  }
});

test('M03 registry：未知类型降级为纯文本（PRD §10.3 末行）', () => {
  const html = renderShape({ type: 'hologram', text: '未来组件 <b>危险</b>' });
  assert.ok(!html.includes('<b>危险'), '未知类型不得透传 HTML');
  assert.ok(html.includes('未来组件'));
  assert.ok(html.includes('&lt;b&gt;危险&lt;/b&gt;'));
});
