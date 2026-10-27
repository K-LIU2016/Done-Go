// M01 ui-utils 纯核单测（RED 先行 · 实现前必红）
// 依据：BUILD-PLAN §3 W5.1/§2.3 TDD；plan.md M01；prototype.html L244-247（T/HM/pct）、
// L328（setHTML 内容比对跳过重写——增量更新基石）、L329（esc 转义）。
// 契约：web/agentic/ui/utils.js 具名导出 esc / setHTML / T / HM / pct / on。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as utils from '../../../../web/agentic/ui/utils.js';

const { esc, setHTML, T, HM, pct, on } = utils;

test('M01 utils 导出六个具名工具', () => {
  for (const fn of [esc, setHTML, T, HM, pct, on]) assert.equal(typeof fn, 'function', '应为函数导出');
});

test('M01 esc 转义五实体 & < > " \'（prototype L329 扩展版）', () => {
  assert.equal(esc('&<>"\''), '&amp;&lt;&gt;&quot;&#39;');
  assert.equal(esc('政策与标准'), '政策与标准');
  assert.equal(esc(0), '0'); // 非字符串先 String()
  assert.equal(esc(null), 'null');
});

test('M01 esc 不做二次转义以外的任何改写', () => {
  const evil = '<img src=x onerror="alert(1)">';
  const out = esc(evil);
  assert.ok(!out.includes('<img'), '标签必须被破坏');
  assert.equal(out, '&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
});

// 最小 DOM 桩：setHTML 只允许触碰 el._h 与 el.innerHTML（prototype L328 语义）
function stubEl() {
  return {
    _h: undefined,
    _html: '',
    writes: 0,
    get innerHTML() { return this._html; },
    set innerHTML(v) { this.writes += 1; this._html = v; },
  };
}

test('M01 setHTML 首写：记录 _h、写 innerHTML、返回 true', () => {
  const el = stubEl();
  assert.equal(setHTML(el, '<p>a</p>'), true);
  assert.equal(el._h, '<p>a</p>');
  assert.equal(el.writes, 1);
});

test('M01 setHTML 内容未变：不写 innerHTML、返回 false（增量更新基石，prototype L328）', () => {
  const el = stubEl();
  setHTML(el, '<p>同一份 HTML</p>');
  assert.equal(setHTML(el, '<p>同一份 HTML</p>'), false);
  assert.equal(el.writes, 1, '字节级相同不得触发重写');
});

test('M01 setHTML 内容变化：重写并返回 true', () => {
  const el = stubEl();
  setHTML(el, '<p>v1</p>');
  assert.equal(setHTML(el, '<p>v2</p>'), true);
  assert.equal(el.innerHTML, '<p>v2</p>');
  assert.equal(el.writes, 2);
});

test('M01 T/HM：HH:MM ↔ 当日分钟数（prototype L244-245）', () => {
  assert.equal(T('13:00'), 780);
  assert.equal(T('00:00'), 0);
  assert.equal(T('23:59'), 1439);
  assert.equal(HM(780), '13:00');
  assert.equal(HM(0), '00:00');
  assert.equal(HM(1439), '23:59');
  assert.equal(HM(T('09:05')), '09:05'); // 往返一致
});

test('M01 pct：分钟 → 区间百分比字符串（prototype L247，两位小数+%）', () => {
  assert.equal(pct(780, 780, 1140), '0.00%');
  assert.equal(pct(1140, 780, 1140), '100.00%');
  assert.equal(pct(960, 780, 1140), '50.00%');
  assert.ok(/^\d+\.\d{2}%$/.test(pct(900, 780, 1140)), '格式固定两位小数');
});

test('M01 on：事件委托只命中 closest(selector) 的目标（DAG M01 事件委托）', () => {
  const registered = [];
  const el = { listeners: {}, addEventListener(type, fn) { this.listeners[type] = fn; registered.push(type); } };
  const hits = [];
  on(el, 'click', 'button.chip', (e, t) => hits.push([e.id, t.dataset.say]));
  assert.deepEqual(registered, ['click']);
  const handler = el.listeners.click;
  // 命中：target 的 closest 返回 chip 按钮
  const chip = { dataset: { say: '研究只看国内 K12' } };
  handler({ id: 'e1', target: { closest: (sel) => (sel === 'button.chip' ? chip : null) } });
  assert.deepEqual(hits, [['e1', '研究只看国内 K12']]);
  // 未命中：closest 返回 null 不触发
  handler({ id: 'e2', target: { closest: () => null } });
  assert.equal(hits.length, 1, '不匹配时不回调');
});
