// W11 composer · 模板分支补测（配合 compose-sample/html 两份契约测试补齐防御分支）。
// 覆盖：字段缺失/空列表/null 配图的自然降级、降级卡的 steps/lines 通道、
// nums 脏项过滤、picDiv 无 url、sample 极简形态。全部为纯函数调用，零 IO。
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { composeSample } from '../../../../../scripts/agentic/composer/compose-sample.mjs';
import { picDiv, scopeClass } from '../../../../../scripts/agentic/composer/html.mjs';

const strip = html => html.replace(/<[^>]+>/g, ' ');

test('slide degrades gracefully: no tag, empty bullets, pending image', () => {
  const html = composeSample({ id: 'x', layout: 'slide-title-bullets-image', page: 'p', text: { title: '只有标题' } }, null);
  assert.ok(html.includes('<h4>只有标题</h4>'));
  assert.ok(!html.includes('<span class="tag"'));
  assert.ok(!html.includes('<ul>'));
  assert.ok(!html.includes('class="pic"'), '无图不渲染空 pic 位');

  const emptyList = composeSample({ id: 'x', layout: 'slide-title-bullets-image', page: 'p', text: { title: 'T', bullets: [] } }, null);
  assert.ok(!emptyList.includes('<ul>'), '空 bullets 不渲染 <ul>');
});

test('slide bullets filter out null/empty entries without empty <li>', () => {
  const html = composeSample({ id: 'x', layout: 'slide-title-bullets-image', page: 'p', text: { title: 'T', bullets: ['一', null, '', undefined, '二'] } }, null);
  assert.equal((html.match(/<li>/g) || []).length, 2);
  assert.ok(html.includes('<li>一</li><li>二</li>'));
});

test('report cover: subtitle/nums optional; dirty nums entries are dropped', () => {
  const bare = composeSample({ id: 'x', layout: 'report-cover', page: 'p', text: { title: '裸封面' } }, null);
  assert.ok(bare.includes('<b>裸封面</b>'));
  assert.ok(!bare.includes('small muted') && !bare.includes('nums') && !bare.includes('class="pic"'));

  const dirty = composeSample({
    id: 'x', layout: 'report-cover', page: 'p',
    text: { title: 'T', subtitle: 'S', nums: [{ n: 5, label: '节' }, { label: '无数字' }, null, '杂物'] },
  }, { url: '/api/media/c.png' });
  assert.ok(dirty.includes('<div class="nums"><span><i>5</i>节</span></div>'), '只保留有 n 的条目');
  assert.ok(dirty.includes('<span class="small muted">S</span>'));
});

test('activity card keeps its own shell (slide act) and steps as ordered list', () => {
  const html = composeSample({ id: 'x', layout: 'activity-card', page: 'p', text: { title: '活动', steps: ['一', '二'] } }, { url: '/a.png' });
  assert.ok(html.includes('<div class="slide act">'));
  assert.ok(html.includes('<ol class="steps"><li>一</li><li>二</li></ol>'));
  assert.ok(html.includes(`url('/a.png')`));

  const bare = composeSample({ id: 'x', layout: 'activity-card', page: 'p', text: { title: '活动' } }, null);
  assert.ok(!bare.includes('<span class="tag"') && !bare.includes('<ol') && !bare.includes('class="pic"'));
});

test('product card keeps its own shell (cover prod); subtitle optional; text still code-typeset', () => {
  const html = composeSample({ id: 'x', layout: 'product-card', page: 'p', text: { title: '书架', subtitle: '三层' } }, { url: '/p.png' });
  assert.ok(html.includes('<div class="cover prod">'));
  assert.ok(html.includes('<b>书架</b>') && html.includes('<span class="small muted">三层</span>'));

  const bare = composeSample({ id: 'x', layout: 'product-card', page: 'p', text: { title: '书架' } }, null);
  assert.ok(!bare.includes('small muted') && !bare.includes('class="pic"'));
});

test('route card ignores an image argument entirely (无图位形态)', () => {
  const html = composeSample({ id: 'x', layout: 'route-card', page: 'p', text: { title: 'R', lines: ['a', 'b'] } }, { url: '/r.png' });
  assert.ok(html.includes('<div class="route"><b>R</b><div class="line">a</div><div class="line">b</div></div>'));
  assert.ok(!html.includes('class="pic"') && !html.includes('/r.png'));

  const empty = composeSample({ id: 'x', layout: 'route-card', page: 'p', text: { title: 'R', lines: [] } }, null);
  assert.ok(empty.includes('<div class="route"><b>R</b></div>'));
});

test('fallback card also funnels steps/lines, and survives a title-less sample', () => {
  const steps = composeSample({ id: 'x', layout: 'nope', page: 'p', text: { steps: ['s1'], lines: ['l1'], bullets: ['b1'] } }, null);
  const t = strip(steps);
  for (const s of ['s1', 'l1', 'b1']) assert.ok(t.includes(s));
  assert.ok(!steps.includes('class="slide"') && !steps.includes('class="cover"') && !steps.includes('class="route"'));

  const noTitle = composeSample({ id: 'x', layout: 'nope', page: 'p', text: { bullets: ['只此一条'] } }, null);
  assert.ok(noTitle.includes('<li>只此一条</li>') && !noTitle.includes('<b>'));
});

test('composeSample survives a minimal sample: no layout/page/watermark/text at all', () => {
  const html = composeSample({ id: 'x' }, null);
  assert.ok(html.includes('data-layout="unknown"'));
  assert.ok(html.includes('<span class="wm">示意</span>'), '水印默认仍是 示意');
  assert.ok(html.includes('<figcaption></figcaption>'));
  assert.ok(!html.includes('undefined'), '缺字段不得渲染出 undefined');
});

test('route card tolerates non-array lines and drops falsy entries', () => {
  const nonArray = composeSample({ id: 'x', layout: 'route-card', page: 'p', text: { title: 'R', lines: '不是数组' } }, null);
  assert.ok(nonArray.includes('<div class="route"><b>R</b></div>'), '非数组 lines 按无行程处理');

  const dirty = composeSample({ id: 'x', layout: 'route-card', page: 'p', text: { title: 'R', lines: ['一', null, '', undefined, '二'] } }, null);
  assert.equal((dirty.match(/<div class="line">/g) || []).length, 2);
});

test('picDiv: no url or non-object image yields empty string (不造空占位)', () => {
  assert.equal(picDiv(null), '');
  assert.equal(picDiv({}), '');
  assert.equal(picDiv({ url: '' }), '');
  assert.equal(picDiv('/api/media/a.png'), '');
});

test('scopeClass accepts digits/dash/underscore after the first letter', () => {
  assert.equal(scopeClass('dg', 'wm2_x-y'), 'dg-wm2_x-y');
});
