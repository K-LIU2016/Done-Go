// M06 块抽屉壳（五标签 + 阶段条 + 移动底部抽屉）单测（RED 先行 · 实现前必红）
// 依据：plan.md M06、PRD §5.8（移动端：块抽屉为底部抽屉）、prototype.html
//   L199（nav.stepper ①说②看③定④交）、L210-218（.tabs[role=tablist] 五标签 + #tab-* 五 section）、
//   L331-337（renderStepper：i===cur→on，i<cur→done，否则 ''）、L532-536（showTab：.on + .hidden 切换）。
// 契约：web/agentic/ui/drawer.js
//   纯核：STAGE_ORDER/TAB_ORDER/DRAWER_CSS + stepClass/normalizeTab/clampStage/nextTab/
//         stepperHTML/tabsHTML/drawerHTML/diffDrawer/ensureStyles（node 可测，无真 DOM）
//   壳：mount(el, { blockId, stage, tab, sections, onClose }) → handle{ update(props), showTab(name), close(), destroy() }
//       增量约束：update 切块（blockId 变）不重写任何 tab 面板 DOM（DAG M06）。
// 壳的 DOM 行为用本文件 fake-DOM 桩驱动（同 M04 stubEl 模式的扩展，jsdom-free）；
// 真浏览器行为（role/aria/焦点/≤720px 底部抽屉贴底）由 tests/agentic/ui/drawer.spec.ts 组件页测。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  STAGE_ORDER, TAB_ORDER, TAB_LABELS, STAGE_LABELS, DRAWER_CSS,
  stepClass, clampStage, normalizeTab, nextTab,
  stepperHTML, tabsHTML, drawerHTML, diffDrawer, ensureStyles, mount,
} from '../../../../web/agentic/ui/drawer.js';

// ---------- 纯核：常量 ----------

test('M06 常量：四阶段 say/see/sign/run + 五标签 preview/bound/live/art/trace（prototype L199/L211-218）', () => {
  assert.deepEqual(STAGE_ORDER, ['say', 'see', 'sign', 'run']);
  assert.deepEqual(TAB_ORDER, ['preview', 'bound', 'live', 'art', 'trace']);
  assert.equal(TAB_LABELS.preview, '预演');
  assert.equal(TAB_LABELS.bound, '边界');
  assert.equal(TAB_LABELS.live, '进行中');
  assert.equal(TAB_LABELS.art, '交付物');
  assert.equal(TAB_LABELS.trace, '追踪');
  assert.equal(STAGE_LABELS.say, '① 说');
  assert.equal(STAGE_LABELS.sign, '③ 定 · 签约');
});

test('M06 DRAWER_CSS：含 ≤720px 底部抽屉（position:fixed 贴底）、.hidden、reduced-motion 降级', () => {
  assert.ok(DRAWER_CSS.includes('@media (max-width: 720px)'), '必须有 720px 移动断点');
  assert.ok(/position:\s*fixed/.test(DRAWER_CSS), '移动端抽屉需 fixed 贴底');
  assert.ok(/bottom:\s*0/.test(DRAWER_CSS));
  assert.ok(/max-height:\s*6[0-9]vh/.test(DRAWER_CSS), 'max-height ≤ 69vh 保证抽屉顶部 y > 30% 视口高');
  assert.ok(/\.hidden\s*{[^}]*display:\s*none/.test(DRAWER_CSS), '需自带 .hidden 兜底（agentic.css 未落地时）');
  assert.ok(DRAWER_CSS.includes('prefers-reduced-motion'), 'reduced-motion 全局降级');
});

// ---------- 纯核：状态归约 ----------

test('M06 stepClass：当前 on、之前 done、之后空串（prototype L331-337 renderStepper 语义）', () => {
  assert.equal(stepClass('say', 'say'), 'on');
  assert.equal(stepClass('see', 'say'), '');
  assert.equal(stepClass('see', 'sign'), 'done');
  assert.equal(stepClass('sign', 'sign'), 'on');
  assert.equal(stepClass('run', 'sign'), '');
  assert.equal(stepClass('sign', 'run'), 'done');
  assert.equal(stepClass('run', 'run'), 'on');
});

test('M06 clampStage / normalizeTab：非法值兜底（say / preview）', () => {
  assert.equal(clampStage('see'), 'see');
  assert.equal(clampStage('_run'), 'say');
  assert.equal(clampStage(undefined), 'say');
  assert.equal(normalizeTab('trace'), 'trace');
  assert.equal(normalizeTab('nope'), 'preview');
  assert.equal(normalizeTab(null), 'preview');
});

test('M06 nextTab：左右循环导航（tablist 方向键，wrap-around）', () => {
  assert.equal(nextTab('preview', 1), 'bound');
  assert.equal(nextTab('live', 1), 'art');
  assert.equal(nextTab('trace', 1), 'preview', '末尾向右回到首个');
  assert.equal(nextTab('preview', -1), 'trace', '首个向左回到末尾');
  assert.equal(nextTab('live', -1), 'bound');
  assert.equal(nextTab('preview', 5), 'preview', '整圈回原地');
  assert.equal(nextTab('weird', 1), 'bound', '非法入口先归一');
});

// ---------- 纯核：HTML 构建 ----------

test('M06 stepperHTML：nav.stepper[data-s×4]，当前 on / 已过 done（prototype L199）', () => {
  const html = stepperHTML('sign');
  assert.ok(html.includes('<nav class="stepper"'));
  assert.ok(html.includes('aria-label="阶段"'));
  assert.ok(html.includes('data-s="say"'));
  assert.ok(html.includes('data-s="run"'));
  assert.ok(html.includes('④ 交 · 执行与验收'));
  assert.ok(html.includes('<span data-s="see" class="done">'));
  assert.ok(html.includes('<span data-s="sign" class="on">'));
  assert.ok(html.includes('<span data-s="run" class="">'));
});

test('M06 tabsHTML：role=tablist 五 role=tab，aria-selected/tabindex 联动 aria-controls（spec 契约）', () => {
  const html = tabsHTML('preview');
  assert.ok(html.includes('role="tablist"'));
  assert.equal((html.match(/role="tab"/g) || []).length, 5);
  assert.ok(html.includes('data-tab="preview" aria-controls="tab-preview" aria-selected="true" tabindex="0"'));
  assert.ok(html.includes('data-tab="bound" aria-controls="tab-bound" aria-selected="false" tabindex="-1"'));
  assert.ok(html.includes('id="tabbtn-trace"'));
  assert.ok(html.includes('>预演</button>'));
});

test('M06 drawerHTML：根 .ag-drawer[data-block] + 五 #tab-* 空面板容器，未选标签带 hidden（prototype L210-218）', () => {
  const html = drawerHTML({ blockId: 'r', stage: 'see' });
  assert.ok(html.includes('<div class="ag-drawer" data-block="r">'));
  assert.ok(html.includes('id="tab-preview"'));
  assert.ok(html.includes('data-tab="trace"'));
  assert.ok(/id="tab-preview"[^>]*class=""/.test(html), '当前标签不 hidden');
  assert.ok(/id="tab-bound"[^>]*class="hidden"/.test(html), '非当前标签 hidden');
  assert.ok(/<section id="tab-preview"[^>]*><\/section>/.test(html), '面板为空容器：内容由 mount/update 走 setHTML 增量灌入');
  assert.ok(html.includes('class="grip"'), '移动端上滑把手（≤720px 显示）');
});

test('M06 drawerHTML：blockId 属性转义（XSS 基线）', () => {
  const html = drawerHTML({ blockId: '"><img src=x onerror=alert(1)>' });
  assert.ok(!html.includes('<img src=x'), '属性注入不得存活');
  assert.ok(html.includes('&quot;'), '引号需转义');
});

test('M06 drawerHTML：缺省 props 不抛错（边界收敛）', () => {
  assert.equal(typeof drawerHTML(), 'string');
  assert.equal(typeof drawerHTML(null), 'string');
  assert.ok(drawerHTML({}).includes('data-tab="preview"'));
});

// ---------- 纯核：diffDrawer（增量更新计划） ----------

test('M06 diffDrawer：null→next 全量；同 props 全空（增量基石）', () => {
  const next = { blockId: 'r', stage: 'sign', tab: 'preview', sections: { preview: 'a', trace: 'b' } };
  const full = diffDrawer(null, next);
  assert.equal(full.blockId, 'r');
  assert.equal(full.stage, 'sign');
  assert.equal(full.tab, 'preview');
  assert.deepEqual(full.sections, { preview: 'a', trace: 'b' });
  const same = diffDrawer(next, { ...next, sections: { ...next.sections } });
  assert.equal(same.blockId, undefined);
  assert.equal(same.stage, undefined);
  assert.equal(same.tab, undefined);
  assert.deepEqual(same.sections, {});
});

test('M06 diffDrawer：切块只报 blockId，不报任何 section（切块不重建面板 DOM 的纯核保证）', () => {
  const prev = { blockId: 'r', stage: 'see', tab: 'preview', sections: { preview: 'p', bound: 'b' } };
  const patch = diffDrawer(prev, { ...prev, blockId: 'c' });
  assert.deepEqual(patch, { blockId: 'c', stage: undefined, tab: undefined, sections: {} });
});

test('M06 diffDrawer：只变更的 section 进 patch；非字符串 section 忽略', () => {
  const prev = { blockId: 'r', stage: 'see', tab: 'preview', sections: { preview: 'p', bound: 'b' } };
  const patch = diffDrawer(prev, { ...prev, sections: { preview: 'p2', bound: 'b', nope: 1 } });
  assert.deepEqual(patch.sections, { preview: 'p2' });
});

// ---------- 纯核：ensureStyles ----------

test('M06 ensureStyles：注入一次，二次跳过（幂等）', () => {
  const mkDoc = () => {
    const doc = { _styles: [], _ls: {} };
    doc.querySelector = (sel) => (sel === 'style[data-agentic-drawer]' ? doc._styles[0] ?? null : null);
    doc.createElement = () => ({ _attrs: {}, textContent: '', setAttribute(k, v) { this._attrs[k] = String(v); } });
    doc.head = { appendChild: (n) => doc._styles.push(n) };
    return doc;
  };
  const doc = mkDoc();
  assert.equal(ensureStyles(doc), true);
  assert.equal(doc._styles.length, 1);
  assert.ok(doc._styles[0].textContent.includes('.ag-drawer'));
  assert.equal(ensureStyles(doc), false, '已注入不再重复');
  assert.equal(ensureStyles(null), false, '无 doc 安全返回');
});

// ---------- 壳：mount/update/showTab（fake-DOM 桩，白盒同 M04 stubEl 模式扩展） ----------

function fakeNode(tag, data = {}) {
  const cls = new Set();
  const node = {
    tagName: tag, dataset: { ...data }, _attrs: {}, _html: '', writes: 0, _ls: {}, _q: {},
    get innerHTML() { return this._html; },
    set innerHTML(v) { this.writes += 1; this._html = v; },
    get className() { return [...cls].join(' '); },
    set className(v) { cls.clear(); String(v).split(/\s+/).filter(Boolean).forEach((c) => cls.add(c)); },
    classList: {
      toggle(c, f) { const on = f === undefined ? !cls.has(c) : !!f; if (on) cls.add(c); else cls.delete(c); return on; },
      add: (...a) => a.forEach((c) => cls.add(c)),
      remove: (...a) => a.forEach((c) => cls.delete(c)),
      contains: (c) => cls.has(c),
    },
    setAttribute(k, v) { this._attrs[k] = String(v); },
    getAttribute(k) { return k in this._attrs ? this._attrs[k] : null; },
    addEventListener(t, fn) { (this._ls[t] = this._ls[t] || []).push(fn); },
    removeEventListener(t, fn) { this._ls[t] = (this._ls[t] || []).filter((f) => f !== fn); },
    querySelector(sel) { return (this._q[sel] || [])[0] ?? null; },
    querySelectorAll(sel) { return this._q[sel] || []; },
    focus() { this.focused = true; },
    appendChild(n) { (this.kids = this.kids || []).push(n); },
  };
  return node;
}

function harness(props) {
  const root = fakeNode('DIV');
  const spans = STAGE_ORDER.map((s) => fakeNode('SPAN', { s }));
  const btns = TAB_ORDER.map((t) => fakeNode('BUTTON', { tab: t }));
  const tabs = fakeNode('DIV');
  const grip = fakeNode('BUTTON');
  const secs = Object.fromEntries(TAB_ORDER.map((t) => [t, fakeNode('SECTION')]));
  root._q = {
    '.stepper span': spans, '.tabs button': btns, '.tabs': [tabs], '.grip': [grip],
    ...Object.fromEntries(TAB_ORDER.map((t) => [`#tab-${t}`, [secs[t]]])),
  };
  const doc = fakeNode('#document');
  doc.querySelector = () => null;
  const host = fakeNode('DIV', {});
  host._q = { '.ag-drawer': [root] };
  host.ownerDocument = doc;
  const calls = [];
  const h = mount(host, { onClose: () => calls.push(['close']), ...props });
  return { host, root, spans, btns, tabs, grip, secs, doc, calls, h };
}

const fire = (node, type, ev) => (node._ls[type] || []).forEach((fn) => fn(ev));

test('M06 mount：一次性写出壳 HTML；阶段/标签初始态正确', () => {
  const { host, spans, btns, secs } = harness({ blockId: 'r', stage: 'sign' });
  assert.equal(host.writes, 1, 'mount 只写一次整体壳');
  assert.ok(host.innerHTML.includes('role="tablist"'));
  assert.equal(spans[1].className, 'done');
  assert.equal(spans[2].className, 'on');
  assert.equal(btns[0].getAttribute('aria-selected'), 'true');
  assert.equal(btns[0].getAttribute('tabindex'), '0');
  assert.equal(btns[1].getAttribute('tabindex'), '-1');
  assert.ok(secs.preview.classList.contains('hidden') === false);
  assert.ok(secs.bound.classList.contains('hidden') === true, '非当前 section hidden');
});

test('M06 update：切阶段只改 stepper class，面板 DOM 零重写', () => {
  const { h, spans, secs } = harness({ blockId: 'r', stage: 'sign' });
  const w0 = Object.fromEntries(TAB_ORDER.map((t) => [t, secs[t].writes])); // mount 首写计入基线
  h.update({ stage: 'run' });
  assert.equal(spans[2].className, 'done');
  assert.equal(spans[3].className, 'on');
  for (const t of TAB_ORDER) assert.equal(secs[t].writes, w0[t], `${t} 面板不得重写`);
});

test('M06 update：切块（blockId 变）不重建面板 DOM —— data-marker 等价断言（spec 契约）', () => {
  const { h, root, secs } = harness({ blockId: 'r' });
  const w0 = Object.fromEntries(TAB_ORDER.map((t) => [t, secs[t].writes])); // mount 首写计入基线
  h.update({ blockId: 'c' });
  assert.equal(root.getAttribute('data-block'), 'c');
  for (const t of TAB_ORDER) assert.equal(secs[t].writes, w0[t], '切块不重写任何 tab 面板');
});

test('M06 mount：sections 内容经 setHTML 灌入对应面板；缺省 sections 出空面板', () => {
  const withSec = harness({ blockId: 'r', sections: { preview: '<p>a</p>' } });
  assert.ok(withSec.secs.preview.innerHTML.includes('<p>a</p>'));
  assert.equal(withSec.secs.preview.writes, 1, '首灌一次');
  const bare = harness({});
  for (const t of TAB_ORDER) {
    assert.equal(bare.secs[t].innerHTML, '', `${t} 缺省为空面板`);
    assert.equal(bare.secs[t].writes, 1);
  }
});

test('M06 update：section 内容变更按面板增量写（setHTML 同内容跳过）', () => {
  const { h, secs } = harness({ blockId: 'r', sections: { preview: '<p>a</p>' } });
  assert.ok(secs.preview.innerHTML.includes('<p>a</p>'), '初始内容入面板');
  h.update({ sections: { preview: '<p>b</p>', bound: '<p>x</p>' } });
  assert.equal(secs.preview.writes, 2, 'preview 变更重写一次');
  assert.ok(secs.preview.innerHTML.includes('<p>b</p>'));
  assert.equal(secs.bound.writes, 2);
  assert.equal(secs.live.writes, 1, '未涉及面板不动（仅 mount 首写）');
  h.update({ sections: { preview: '<p>b</p>' } });
  assert.equal(secs.preview.writes, 2, '内容未变不得重写');
});

test('M06 点击标签 / showTab：aria-selected + .on + hidden 联动（prototype L532-536）', () => {
  const { h, btns, secs } = harness({ blockId: 'r' });
  fire(btns[4], 'click', {});
  assert.equal(btns[4].getAttribute('aria-selected'), 'true');
  assert.equal(btns[4].className, 'on');
  assert.equal(btns[0].getAttribute('aria-selected'), 'false');
  assert.ok(secs.trace.classList.contains('hidden') === false);
  assert.ok(secs.preview.classList.contains('hidden') === true);
  h.showTab('live');
  assert.equal(btns[2].getAttribute('aria-selected'), 'true');
  assert.ok(secs.live.classList.contains('hidden') === false);
  h.showTab('bogus');
  assert.equal(btns[0].getAttribute('aria-selected'), 'true', '非法标签名归一到 preview');
});

test('M06 tablist 键盘：←→ 循环 + Home/End，选中后聚焦（roving tabindex）', () => {
  const { tabs, btns } = harness({ blockId: 'r' });
  fire(tabs, 'keydown', { key: 'ArrowRight' });
  assert.equal(btns[1].getAttribute('aria-selected'), 'true');
  assert.equal(btns[1].focused, true, '方向键选中需聚焦');
  fire(tabs, 'keydown', { key: 'ArrowRight' });
  assert.equal(btns[2].getAttribute('aria-selected'), 'true');
  fire(tabs, 'keydown', { key: 'ArrowLeft' });
  assert.equal(btns[1].getAttribute('aria-selected'), 'true');
  fire(tabs, 'keydown', { key: 'Home' });
  assert.equal(btns[0].getAttribute('aria-selected'), 'true');
  fire(tabs, 'keydown', { key: 'End' });
  assert.equal(btns[4].getAttribute('aria-selected'), 'true');
  fire(tabs, 'keydown', { key: 'Enter' });
  assert.equal(btns[4].getAttribute('aria-selected'), 'true', '无关键不切换');
});

test('M06 Esc（document 级）→ onClose 恰一次；非 Esc 键不触发；grip 点击关闭', () => {
  const { doc, grip, calls } = harness({ blockId: 'r' });
  const ev = { key: 'Escape', defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
  fire(doc, 'keydown', ev);
  assert.deepEqual(calls, [['close']]);
  fire(doc, 'keydown', { key: 'a' });
  assert.deepEqual(calls, [['close']], '非 Esc 不触发');
  fire(grip, 'click', {});
  assert.deepEqual(calls, [['close'], ['close']], '把手点击可关闭');
});

test('M06 无 onClose 不炸；destroy 移除 document 监听', () => {
  const { h, doc, grip } = harness({ blockId: 'r', onClose: undefined });
  fire(doc, 'keydown', { key: 'Escape', defaultPrevented: false, preventDefault() {} });
  fire(grip, 'click', {});
  h.destroy();
  assert.equal((doc._ls.keydown || []).length, 0, 'destroy 后无残留监听');
});
