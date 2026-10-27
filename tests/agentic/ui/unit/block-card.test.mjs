// M05 交付徽标 + 块卡列表 单测（RED 先行 · 实现前必红）
// 依据：plan.md M05、PRD §5.1（#today 日程卡 = 交付徽标：类型图标 + 可交付度 + 状态点、"需要你 N" 角标）、
//       PRD §3.2 +3s 行（卡片上出现"可交付度"徽标和"需要你 2 项"）、prototype.html L249-256（数据/kindColor）、
//       L58-64（.dot 五态 + pulse）、L338-351（statusDot/statusText/renderBlocks/pendingFor）。
// 契约：web/agentic/ui/block-card.js 具名导出
//   STATUS_TEXT / STATUSES / KIND_COLOR / kindColorOf / pendingCount / statusOf /
//   dotHTML / timeHTML / chipsHTML / cardHTML / listHTML / mount(el, props) → { el, update(props) }
//   props：{ blocks, sel, status: {id→状态}, pending: {id→未决数}, onSelect(id) }
// DOM 壳增量约束（PRD §5.2 末教训）：块集合不变时只逐卡打补丁，容器不整绘（按钮节点保留）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  STATUS_TEXT, STATUSES, KIND_COLOR, kindColorOf, pendingCount, statusOf,
  dotHTML, timeHTML, chipsHTML, cardHTML, listHTML, mount,
} from '../../../../web/agentic/ui/block-card.js';

// 黄金场景 5 块（prototype L249-255 原样，与 M02 fixtures 同源）
const BLOCKS = [
  { id: 'r', start: '14:00', end: '15:00', title: 'AI 教育的深度研究', kind: 'explore', type: '研究报告', feas: ['hi', '可交付度 高'], needs: 1 },
  { id: 'c', start: '15:00', end: '17:00', title: '课程设计', kind: 'create', type: '课程方案', feas: ['mid', '可交付度 中 · 缺学员与课时'], needs: 2 },
  { id: 'f', start: '19:00', end: '21:00', title: '和小王吃饭', kind: 'connect', type: '现实 · 会面', feas: ['hi', '简报 + 路线 + 行后记录'], needs: 0 },
  { id: 'b', start: '21:00', end: '21:50', title: '做木质小书架', kind: 'restore', type: '现实 · 动手', feas: ['hi', '效果图 + 步骤 + 现场感知'], needs: 0 },
  { id: 's', start: '22:00', end: '23:00', title: '自己的时间', kind: 'stillness', type: '零打扰', feas: ['', 'agent 不介入'], needs: 0 },
];
const byId = Object.fromEntries(BLOCKS.map((b) => [b.id, b]));

test('M05 STATUS_TEXT/STATUSES：五态文案（prototype L342/L58-64）', () => {
  assert.deepEqual(STATUSES, ['prep', 'live', 'need', 'ready', 'done']);
  assert.deepEqual(STATUS_TEXT, {
    prep: '准备中', live: '进行中', need: '需要你', ready: '待验收', done: '已交付',
  });
});

test('M05 KIND_COLOR：五 kind 左条色 --k-* + 未知 kind 回退 explore（prototype L256）', () => {
  assert.deepEqual(KIND_COLOR, {
    explore: 'var(--k-explore)', create: 'var(--k-create)', connect: 'var(--k-connect)',
    restore: 'var(--k-restore)', stillness: 'var(--k-stillness)',
  });
  for (const b of BLOCKS) assert.equal(kindColorOf(b.kind), KIND_COLOR[b.kind]);
  assert.equal(kindColorOf('nonsense'), KIND_COLOR.explore, '未知 kind 应回退 --k-explore（CSS 默认条色）');
  assert.equal(kindColorOf(undefined), KIND_COLOR.explore);
});

test('M05 cardHTML：button.block[data-b] + .t（en dash 时间）+ .ttl + .chips（prototype L345-349）', () => {
  const html = cardHTML(byId.r, {});
  assert.ok(html.startsWith('<button type="button" class="block" data-b="r"'));
  assert.ok(html.includes('style="border-left-color:var(--k-explore)"'));
  assert.ok(html.includes('<span class="t">14:00–15:00</span>'), '时间为 start–end（U+2013）');
  assert.ok(html.includes('<span class="ttl">AI 教育的深度研究</span>'), '无状态时不输出点');
  assert.ok(html.includes('<span class="chips"><span class="chip">研究报告</span>'));
});

test('M05 类型 chip 第一枚 + 可交付度 chip hi/mid/无档（prototype L250-251/L348）', () => {
  const r = chipsHTML(byId.r, {});
  assert.ok(r.startsWith('<span class="chip">研究报告</span>'), '第一枚 chip 是类型');
  assert.ok(r.includes('<span class="chip hi">可交付度 高</span>'));
  const c = chipsHTML(byId.c, {});
  assert.ok(c.includes('<span class="chip mid">可交付度 中 · 缺学员与课时</span>'));
  const s = chipsHTML(byId.s, {}); // feas[0]=''：有文案但不带 hi/mid 档位类
  assert.ok(s.includes('<span class="chip">agent 不介入</span>'));
  assert.ok(!s.includes('chip hi') && !s.includes('chip mid'));
  assert.ok(!chipsHTML({ id: 'x', type: 'T' }, {}).includes('chip hi'), '缺 feas 不输出档位 chip');
});

test('M05 「需要你 N」：pending map 优先（显式 0 压过 needs）、无 map 回退 block.needs（PRD §3.2 +3s 行）', () => {
  assert.equal(pendingCount(byId.r, undefined), 1, '无 pending map → 回退 needs');
  assert.equal(pendingCount(byId.r, {}), 1, 'map 无该键 → 回退 needs');
  assert.equal(pendingCount(byId.r, { r: 0 }), 0, '显式 0 必须压过 needs（spec：r 不出现角标）');
  assert.equal(pendingCount(byId.r, { r: null }), 1, '显式 null 视为未提供 → 回退 needs');
  assert.equal(pendingCount(byId.c, { c: 2 }), 2);
  assert.equal(pendingCount({ id: 'x' }, { x: 3 }), 3, '块无 needs 字段也能从 map 取');
  assert.equal(pendingCount({ id: 'x' }, undefined), 0);
  assert.ok(chipsHTML(byId.c, { pending: { c: 2 } }).includes('<span class="chip you">需要你 2</span>'));
  assert.ok(!chipsHTML(byId.r, { pending: { r: 0 } }).includes('chip you'), 'N=0 不出角标');
  assert.ok(!chipsHTML({ id: 'x', type: 'T', feas: 'hi' }, {}).includes('chip hi'), 'feas 非数组不出档位 chip');
});

test('M05 dotHTML：五态各一类 + 空态无点（prototype L338-340/L58-64）', () => {
  for (const s of STATUSES) assert.equal(dotHTML(s), `<span class="dot ${s}"></span>`);
  assert.equal(dotHTML(''), '');
  assert.equal(dotHTML(undefined), '');
});

test('M05 状态 chip：statusOf 查表 + 未知状态不出 chip（prototype L342/L348）', () => {
  assert.equal(statusOf(byId.r, { r: 'live' }), 'live');
  assert.equal(statusOf(byId.r, {}), '');
  assert.equal(statusOf(byId.r, undefined), '');
  assert.equal(statusOf(byId.r, { r: 3 }), '', '非字符串状态视为无状态');
  for (const [st, txt] of Object.entries(STATUS_TEXT)) {
    assert.ok(chipsHTML(byId.r, { status: { r: st } }).includes(`<span class="chip">${txt}</span>`), st);
  }
  const weird = chipsHTML(byId.r, { status: { r: 'weird' }, pending: { r: 0 } });
  assert.ok(!weird.includes('undefined'), '未知状态不得渲染 undefined 文案');
  assert.equal((weird.match(/<span class="chip/g) || []).length, 2, '未知状态 chip 数与无状态一致（类型+可交付度）');
  const plain = chipsHTML(byId.r, { pending: { r: 0 } });
  assert.equal(weird, plain, '未知状态不得增删任何 chip');
  assert.ok(cardHTML(byId.r, { status: { r: 'need' } }).includes('<span class="dot need"></span>'), '点与 chip 同源取 status');
});

test('M05 选中态 .sel 与非选中互斥（prototype L345）', () => {
  assert.ok(cardHTML(byId.r, { sel: 'r' }).includes('class="block sel"'));
  assert.ok(cardHTML(byId.c, { sel: 'r' }).includes('class="block"'));
});

test('M05 转义：title/type/feas/时间一律 esc，不透传 HTML（M01 XSS 基线）', () => {
  const evil = { id: 'x', start: '10:00', end: '11:00', title: '<script>t</script>', kind: 'explore', type: '<img src=x>', feas: ['hi', 'a&b<c>"d"'] };
  const html = cardHTML(evil, {});
  assert.ok(!html.includes('<script>'));
  assert.ok(!html.includes('<img src=x>'));
  assert.ok(!html.includes('a&b<c>'));
  assert.ok(html.includes('&lt;script&gt;t&lt;/script&gt;'));
  assert.ok(html.includes('&lt;img src=x&gt;'));
  assert.ok(html.includes('a&amp;b&lt;c&gt;&quot;d&quot;'));
});

test('M05 listHTML：5 块顺序连接 + null 条目过滤 + timeHTML 缺省容忍', () => {
  const html = listHTML(BLOCKS, {});
  assert.equal((html.match(/<button /g) || []).length, 5);
  const ids = [...html.matchAll(/data-b="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(ids, ['r', 'c', 'f', 'b', 's']);
  assert.equal((listHTML([null, byId.f, undefined], {}).match(/<button /g) || []).length, 1);
  assert.equal(timeHTML({}), '–', '缺 start/end 输出空串 + 连接符，不出现 undefined');
});

// ---------- DOM 壳（mount/update）· DOM 桩同 M01 utils.test / M04 stubEl 模式 ----------

function stubSpan() {
  return { _h: undefined, _v: '', get innerHTML() { return this._v; }, set innerHTML(v) { this._v = v; } };
}
function stubCard(id) {
  const subs = { '.t': stubSpan(), '.ttl': stubSpan(), '.chips': stubSpan() };
  return {
    dataset: { b: id }, className: 'block', style: {},
    marker: `keep-${id}`,
    subs,
    querySelector(sel) { return subs[sel] ?? null; },
    closest(sel) { return sel === 'button.block' ? this : null; },
  };
}
function stubHost(cards = []) {
  return {
    _h: undefined, _v: '', writes: 0, cards,
    listeners: {},
    get innerHTML() { return this._v; },
    set innerHTML(v) { this.writes += 1; this._v = v; },
    querySelectorAll(sel) { return sel === 'button.block' ? this.cards : []; },
    addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); },
    fire(type, target) { for (const fn of this.listeners[type] ?? []) fn({ target }); },
  };
}

test('M05 mount：首渲染整列表写入容器一次', () => {
  const host = stubHost();
  const handle = mount(host, { blocks: BLOCKS, sel: 'r' });
  assert.equal(host.writes, 1);
  assert.equal((host.innerHTML.match(/<button /g) || []).length, 5);
  assert.ok(handle && typeof handle.update === 'function');
  assert.equal(handle.el, host);
});

test('M05 update 增量：同块改 sel/status 只逐卡打补丁，容器不整绘（PRD §5.2 末教训）', () => {
  const host = stubHost();
  const handle = mount(host, { blocks: BLOCKS, sel: 'r' });
  host.cards = BLOCKS.map((b) => stubCard(b.id)); // 模拟浏览器解析出的按钮节点
  const before = host.cards.map((c) => c.marker);
  host.writes = 0;
  handle.update({ sel: 'c', status: { r: 'live' }, pending: { c: 2 } });
  assert.equal(host.writes, 0, '块集合未变：容器 innerHTML 不得重写');
  assert.equal(host.cards[1].className, 'block sel', 'c 卡补成选中态');
  assert.equal(host.cards[0].className, 'block', 'r 卡去掉选中态');
  assert.ok(host.cards[0].subs['.ttl'].innerHTML.includes('<span class="dot live"></span>'), 'r 卡标题内补状态点');
  assert.ok(host.cards[0].subs['.ttl'].innerHTML.includes('AI 教育的深度研究'));
  assert.ok(host.cards[1].subs['.chips'].innerHTML.includes('chip you'), 'c 卡 chips 补「需要你」角标');
  assert.deepEqual(host.cards.map((c) => c.marker), before, '按钮节点身份保留（自定义属性不丢）');
  assert.equal(host.cards[0].subs['.t'].innerHTML, '14:00–15:00');
});

test('M05 update 换块集合（重排/增删/清空）→ 全量重绘', () => {
  const host = stubHost();
  const handle = mount(host, { blocks: BLOCKS });
  host.cards = BLOCKS.map((b) => stubCard(b.id));
  host.writes = 0;
  handle.update({ blocks: [byId.c, byId.r] }); // 重排 = 新集合
  assert.equal(host.writes, 1, 'ids 签名变了必须整列表 setHTML');
  const ids = [...host.innerHTML.matchAll(/data-b="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(ids, ['c', 'r']);
  host.writes = 0;
  handle.update({ blocks: BLOCKS, sel: 's' });
  assert.equal(host.writes, 1);
  assert.ok(host.innerHTML.includes('class="block sel" data-b="s"'));
  handle.update({ blocks: [] }); // 清空
  assert.equal(host.innerHTML, '');
  handle.update({ blocks: undefined, status: null, pending: null }); // 非法值按空/缺省归一，不抛
  assert.equal(host.innerHTML, '');
});

test('M05 patch 兜底：容器查询不到卡节点时回退全量 setHTML；裸卡缺子节点只跳过不炸', () => {
  const host = stubHost();
  const handle = mount(host, { blocks: BLOCKS });
  delete host.querySelectorAll; // 极端宿主：无查询能力
  host.writes = 0;
  handle.update({ sel: 'r' });
  assert.equal(host.writes, 1, '缺节点兜底整绘，不得静默丢更新');
  assert.ok(host.innerHTML.includes('class="block sel" data-b="r"'));

  // 裸卡（外部改动后缺 .t/.ttl/.chips 子节点）：补丁只改类名/条色，缺的子片段跳过、不抛
  const bare = stubHost();
  const h2 = mount(bare, { blocks: [byId.r] });
  bare.cards = [{ dataset: { b: 'r' }, className: 'block', style: {}, querySelector: () => null }];
  bare.writes = 0;
  h2.update({ sel: 'r' });
  assert.equal(bare.writes, 0, '裸卡仍算补丁成功（容器不整绘）');
  assert.equal(bare.cards[0].className, 'block sel');
});

test('M05 点击委托：点卡回调 onSelect(id)，容器级单监听', () => {
  const host = stubHost();
  const calls = [];
  mount(host, { blocks: BLOCKS, onSelect: (id) => calls.push(id) });
  host.cards = BLOCKS.map((b) => stubCard(b.id));
  host.fire('click', host.cards[1]);
  host.fire('click', host.cards[4]);
  assert.deepEqual(calls, ['c', 's']);
  assert.equal((host.listeners.click ?? []).length, 1, '监听只挂一次（多次 update 不叠加）');
  host.fire('click', { closest: () => null }); // 点到卡外：不回调不抛
  host.fire('click', {}); // target 无 closest：容忍
  assert.deepEqual(calls, ['c', 's']);
  const silent = stubHost(); // 未给 onSelect：点击不得抛
  mount(silent, { blocks: BLOCKS });
  silent.fire('click', stubCard('r'));
  const headless = stubHost(); // 宿主无 addEventListener：mount 不得抛
  delete headless.addEventListener;
  mount(headless, { blocks: BLOCKS });
  assert.equal(headless.writes, 1);
});

test('M05 update 容忍空 props 且链式；状态/pending 缺省不覆盖旧值', () => {
  const host = stubHost();
  const handle = mount(host, { blocks: BLOCKS, sel: 'r', status: { r: 'live' } });
  host.cards = BLOCKS.map((b) => stubCard(b.id));
  const ret = handle.update({}).update(undefined);
  assert.equal(typeof ret.update, 'function', '链式返回 handle');
  assert.ok(host.cards[0].subs['.ttl'].innerHTML.includes('dot live'), '未传 status 不得清掉旧状态');
  handle.update({ sel: 'c' });
  assert.equal(host.cards[1].className, 'block sel');
  assert.ok(host.cards[0].subs['.ttl'].innerHTML.includes('dot live'), '只改 sel 不动其它卡内容');
  handle.update({ onSelect: '不是函数' }); // 非函数回调归一为 null，不抛
  host.fire('click', host.cards[1]);
});
