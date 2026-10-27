// M11 边界卡与签约 纯核/壳桩单测（RED 先行 · 实现前必红）
// 依据：BUILD-PLAN §2.3 TDD / §3 W5 小节（增量更新 + 键盘可达 + aria-live）；plan.md M11；
//   PRD §5.3 签约（L279-282：一屏完成 边界卡+打扰策略+主按钮「就这么办」；按钮签的就是
//   contractHash）、§8.1 Contract（L603 wont 至少包含系统默认禁止项；L836 补丁不得放宽
//   系统禁止项 → SYS_WONT 不可被合同覆盖）、§5.8 移动端四栏→2×2；
//   prototype.html（唯一视觉标准）L99-104（.bound 四栏 + @720px 1fr 1fr + .sys/.sign/.hash）、
//   L305（SYS_WONT 原文）、L461-469（renderBound：四 section + sys li 追加在 wont 栏末尾 +
//   已签约 chip.hi/hash/danger 撤回 + 未签约 primary「就这么办（签约 N 个块）」+ 小字说明 +
//   打扰策略脚注）。
// 契约：web/agentic/ui/boundaries.js 具名导出
//   DEFAULT_SYS_WONT / DEFAULT_INTERRUPT_NOTE / SIGN_NOTE / normalizeItems / normalizeBoundary /
//   sysWontOf / hashOf / blockCountOf / interruptNoteOf / boundInner / boundHTML / signInner /
//   BOUND_CSS / ensureStyles / mount(el, { boundary, sysWont, signed, hash, blockCount,
//   interruptNote, onSign, onRevoke }) → { el, update(props) }（链式，合并语义）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as mod from '../../../../web/agentic/ui/boundaries.js';

const {
  DEFAULT_SYS_WONT, DEFAULT_INTERRUPT_NOTE, SIGN_NOTE,
  normalizeItems, normalizeBoundary, sysWontOf, hashOf, blockCountOf, interruptNoteOf,
  boundInner, boundHTML, signInner, BOUND_CSS, ensureStyles, mount,
} = mod;

const BOUNDARY = {
  will: ['检索公开网页与论文', '写约 3000 字研究报告'],
  wont: ['不发给任何人', '不访问你的邮箱与聊天'],
  needs: ['14:00 前确认目标受众（30 秒）'],
  budget: ['约 40 次模型调用', '全部免费模型 / 本地模型'],
};
const SYS_WONT = '系统禁止：付款下单 · 以你名义发送（除非逐次确认）· 读取凭据 · 删除文件';

// ---------- A. 常量与归一 ----------

test('M11 常量：SYS_WONT/打扰策略脚注/签约小字 = prototype L305/L468/L467 原文', () => {
  assert.equal(DEFAULT_SYS_WONT, SYS_WONT);
  assert.equal(DEFAULT_INTERRUPT_NOTE, '打扰策略：只在需要你时打扰 · 22:00 起的“自己的时间”零打扰');
  assert.equal(SIGN_NOTE, '签的是这份合同本身；之后任何改动都会让你重新确认');
});

test('M11 normalizeItems：只留非空字符串项；非数组一律 []，单串收为单元素（M21 契约容忍：W0 boundary.budget 为整段串）', () => {
  assert.deepEqual(normalizeItems(['a', '', '  ', 'b']), ['a', 'b']);
  assert.deepEqual(normalizeItems([]), []);
  assert.deepEqual(normalizeItems(undefined), []);
  assert.deepEqual(normalizeItems(null), []);
  assert.deepEqual(normalizeItems('x'), ['x'], '单串 → 单元素数组（契约 budget 串）');
  assert.deepEqual(normalizeItems('  '), [], '空白串丢弃');
  assert.deepEqual(normalizeItems({ 0: 'x', length: 1 }), []);
  assert.deepEqual(normalizeItems(['ok', 42, null, { s: 1 }, ['nested']]), ['ok'], '非字符串项丢弃');
});

test('M11 normalizeBoundary：四栏各归一；非对象/数组一律空四栏；多余键忽略', () => {
  assert.deepEqual(normalizeBoundary(BOUNDARY), BOUNDARY);
  assert.deepEqual(normalizeBoundary({}), { will: [], wont: [], needs: [], budget: [] });
  assert.deepEqual(normalizeBoundary(undefined), { will: [], wont: [], needs: [], budget: [] });
  assert.deepEqual(normalizeBoundary(null), { will: [], wont: [], needs: [], budget: [] });
  assert.deepEqual(normalizeBoundary('r'), { will: [], wont: [], needs: [], budget: [] });
  assert.deepEqual(normalizeBoundary([1, 2]), { will: [], wont: [], needs: [], budget: [] });
  assert.deepEqual(
    normalizeBoundary({ will: ['ok'], extra: 'drop' }),
    { will: ['ok'], wont: [], needs: [], budget: [] },
  );
});

test('M11 sysWontOf：非空字符串收下（trim 后判空）；空白/缺省/非串一律回默认（PRD §8.1 系统项永在）', () => {
  assert.equal(sysWontOf('合同附加禁止'), '合同附加禁止');
  assert.equal(sysWontOf('  '), DEFAULT_SYS_WONT);
  assert.equal(sysWontOf(''), DEFAULT_SYS_WONT);
  assert.equal(sysWontOf(undefined), DEFAULT_SYS_WONT);
  assert.equal(sysWontOf(null), DEFAULT_SYS_WONT);
  assert.equal(sysWontOf(42), DEFAULT_SYS_WONT);
});

test('M11 hashOf：非空串 trim 收下；其余空串（缺 hash 不渲染，宁缺勿假）', () => {
  assert.equal(hashOf('sha256:a1b2c3'), 'sha256:a1b2c3');
  assert.equal(hashOf('  sha256:x  '), 'sha256:x');
  assert.equal(hashOf(''), '');
  assert.equal(hashOf('   '), '');
  assert.equal(hashOf(undefined), '');
  assert.equal(hashOf(null), '');
  assert.equal(hashOf(123), '');
});

test('M11 blockCountOf：数字/数字串 → 非负整数；非法一律 0', () => {
  assert.equal(blockCountOf(4), 4);
  assert.equal(blockCountOf('4'), 4);
  assert.equal(blockCountOf(' 3 '), 3);
  assert.equal(blockCountOf(4.9), 4, '截尾');
  assert.equal(blockCountOf(0), 0);
  assert.equal(blockCountOf(-2), 0, '负数归 0');
  assert.equal(blockCountOf(undefined), 0);
  assert.equal(blockCountOf(null), 0);
  assert.equal(blockCountOf(''), 0);
  assert.equal(blockCountOf('abc'), 0);
  assert.equal(blockCountOf(NaN), 0);
});

test('M11 interruptNoteOf：非空串收下；缺省/非串回默认脚注', () => {
  assert.equal(interruptNoteOf('打扰策略：全程静默'), '打扰策略：全程静默');
  assert.equal(interruptNoteOf(undefined), DEFAULT_INTERRUPT_NOTE);
  assert.equal(interruptNoteOf(''), DEFAULT_INTERRUPT_NOTE);
  assert.equal(interruptNoteOf(42), DEFAULT_INTERRUPT_NOTE);
});

// ---------- B. 纯核：boundHTML（四栏 + SYS_WONT） ----------

test('M11 boundHTML：四 section 顺序与 h3 原文（prototype L464-465）', () => {
  const html = boundHTML({ boundary: BOUNDARY, sysWont: SYS_WONT });
  assert.ok(html.startsWith('<div class="bound">'));
  assert.ok(html.endsWith('</div>'));
  const heads = [...html.matchAll(/<h3>([^<]*)<\/h3>/g)].map((m) => m[1]);
  assert.deepEqual(heads, ['我会做', '我不会做', '需要你', '花费与上限']);
  assert.equal([...html.matchAll(/<section>/g)].length, 4, '恰好四栏');
  assert.ok(html.includes('<li>检索公开网页与论文</li>'));
  assert.ok(html.includes('<li>约 40 次模型调用</li>'));
});

test('M11 boundHTML：SYS_WONT 恒为「我不会做」栏末尾的 li.sys，合同 wont 为空也在（PRD §8.1）', () => {
  const html = boundHTML({ boundary: BOUNDARY, sysWont: SYS_WONT });
  assert.ok(html.includes('<li>不访问你的邮箱与聊天</li><li class="sys">' + SYS_WONT + '</li>'), 'sys 追加在全部合同 wont 之后');
  const empty = boundHTML({ boundary: { ...BOUNDARY, wont: [] }, sysWont: SYS_WONT });
  const second = empty.split('<section>')[2];
  assert.ok(second.includes(`<li class="sys">${SYS_WONT}</li>`), 'wont 空仍显示系统禁止项');
  assert.ok(second.includes('<ul><li class="sys">'), '系统项是 wont 栏唯一项时的位置');
});

test('M11 boundHTML：缺省 props 安全（空四栏 + 默认系统项）', () => {
  const html = boundHTML();
  assert.ok(html.includes('<li class="sys">' + DEFAULT_SYS_WONT + '</li>'));
  assert.ok(!html.includes('<li>undefined</li>'));
});

test('M11 boundHTML 转义：条目与 sysWont 必经 esc（M01 XSS 基线）', () => {
  const html = boundHTML({
    boundary: { ...BOUNDARY, will: ['<script>alert(1)</script>'] },
    sysWont: '<b>系统禁止</b>',
  });
  assert.ok(!html.includes('<script>'), '原文注入串不得透传');
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(html.includes('&lt;b&gt;系统禁止&lt;/b&gt;'));
});

test('M11 boundInner：等于 boundHTML 内层（壳打补丁用内容）', () => {
  const props = { boundary: BOUNDARY, sysWont: SYS_WONT };
  const outer = boundHTML(props);
  assert.equal(boundInner(props), outer.slice('<div class="bound">'.length, -'</div>'.length));
});

// ---------- C. 纯核：signInner（签约按钮 / 已签约态） ----------

test('M11 signInner 未签约：primary 按钮 type=button + 块数文案 + 小字说明（prototype L467）', () => {
  const html = signInner({ signed: false, hash: '', blockCount: 4 });
  assert.equal(html,
    '<button type="button" class="btn primary" data-sign="1">就这么办（签约 4 个块）</button>'
    + `<span class="small muted">${SIGN_NOTE}</span>`);
  assert.ok(!html.includes('chip'), '无已签约 chip');
  assert.ok(!html.includes('hash'), '无 hash');
  assert.ok(signInner({ blockCount: 1 }).includes('签约 1 个块'), '块数随 props');
  assert.ok(signInner({}).includes('签约 0 个块'), '缺省块数 0');
});

test('M11 signInner 已签约：chip.hi 带 aria-live 播报 + 等宽 hash「合同 …」+ danger 撤回（prototype L466）', () => {
  const html = signInner({ signed: true, hash: 'sha256:a1b2c3d4e5f6…', blockCount: 4 });
  assert.equal(html,
    '<span class="chip hi" role="status" aria-live="polite">已签约</span>'
    + '<span class="hash">合同 sha256:a1b2c3d4e5f6…</span>'
    + '<button type="button" class="btn danger" data-revoke="1">撤回</button>');
  assert.ok(!html.includes('data-sign'), '已签约无签约按钮');
});

test('M11 signInner 已签约无 hash：省略 hash 段（宁缺勿假），chip/撤回仍在', () => {
  const html = signInner({ signed: true, hash: '' });
  assert.ok(html.includes('已签约') && html.includes('data-revoke="1"'));
  assert.ok(!html.includes('class="hash"'), '无 hash 不渲染空段');
  assert.ok(!html.includes('undefined'));
});

test('M11 signInner 转义：hash 必经 esc', () => {
  const html = signInner({ signed: true, hash: 'sha256:"onerror=1' });
  assert.ok(!html.includes('"onerror'), '引号不得原样落属性外文本');
  assert.ok(html.includes('sha256:&quot;onerror=1'));
});

// ---------- D. BOUND_CSS / ensureStyles ----------

test('M11 BOUND_CSS：四栏 + @720px 2×2 + .sys/.hash 等宽 + reduced-motion（prototype L99-104）', () => {
  assert.ok(BOUND_CSS.includes('grid-template-columns: repeat(4, 1fr)'), '桌面四栏');
  assert.ok(BOUND_CSS.includes('@media (max-width: 720px)'));
  assert.ok(/1fr 1fr/.test(BOUND_CSS), '≤720px 两列 2×2');
  assert.ok(BOUND_CSS.includes('.bound .sys'), '系统项弱化色');
  assert.ok(/\.hash[^}]*ui-monospace/.test(BOUND_CSS), 'hash 等宽字体');
  assert.ok(BOUND_CSS.includes('prefers-reduced-motion'), 'reduced-motion 降级');
  assert.ok(/\.sign button:focus-visible/.test(BOUND_CSS), '键盘焦点可见');
});

test('M11 ensureStyles：幂等注入；无 doc 安全 false（M06/M07 同款桩）', () => {
  const mkDoc = (tag) => {
    const doc = { _styles: [] };
    doc.querySelector = (sel) => (sel === `style[${tag}]` ? doc._styles[0] ?? null : null);
    doc.createElement = () => ({ _attrs: {}, textContent: '', setAttribute(k, v) { this._attrs[k] = String(v); } });
    doc.head = { appendChild: (n) => doc._styles.push(n) };
    return doc;
  };
  const doc = mkDoc('data-agentic-bound');
  assert.equal(ensureStyles(doc), true);
  assert.equal(doc._styles.length, 1);
  assert.ok(doc._styles[0].textContent.includes('.bound'));
  assert.equal(ensureStyles(doc), false, '已注入不再重复');
  assert.equal(ensureStyles(null), false);
});

// ---------- E. DOM 壳（mount/update 增量 + 点击委托） ----------

function stubZone() {
  return { _h: undefined, _v: '', writes: 0, get innerHTML() { return this._v; }, set innerHTML(v) { this.writes += 1; this._v = v; } };
}

/** 宿主桩：innerHTML 写入即模拟浏览器重解析（.bound/.sign/脚注子树按内容重建，构造不计写） */
function stubBoundHost() {
  const bound = stubZone();
  const sign = stubZone();
  const note = stubZone();
  const host = {
    _h: undefined, _v: '', writes: 0, listeners: {},
    get innerHTML() { return this._v; },
    set innerHTML(v) {
      this.writes += 1; this._v = v;
      const b = v.match(/<div class="bound">([\s\S]*)<\/div>\s*<div class="sign">/);
      bound._h = b ? b[1] : undefined; bound._v = b ? b[1] : '';
      const s = v.match(/<div class="sign">([\s\S]*?)<\/div>/);
      sign._h = s ? s[1] : undefined; sign._v = s ? s[1] : '';
      const n = v.match(/<p class="small muted bound-note"[^>]*>([\s\S]*?)<\/p>/);
      note._h = n ? n[1] : undefined; note._v = n ? n[1] : '';
    },
    querySelector(sel) {
      if (sel === '.bound') return bound;
      if (sel === '.sign') return sign;
      if (sel === '[data-note]') return note;
      return null;
    },
    addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); },
    fire(type, target) { for (const fn of this.listeners[type] ?? []) fn({ target }); },
  };
  return { host, bound, sign, note };
}

function stubTarget(dataset) {
  return {
    dataset,
    closest(sel) {
      if (sel === '[data-sign]' && 'sign' in this.dataset) return this;
      if (sel === '[data-revoke]' && 'revoke' in this.dataset) return this;
      return null;
    },
  };
}

test('M11 mount：壳只写一次；三子区零额外写；handle 形状', () => {
  const { host, bound, sign, note } = stubBoundHost();
  const handle = mount(host, { boundary: BOUNDARY, sysWont: SYS_WONT, signed: false, hash: '', blockCount: 4 });
  assert.equal(host.writes, 1, '壳首绘一次');
  assert.equal(bound.writes, 0, 'bound 子区内容未变不重写');
  assert.equal(sign.writes, 0, 'sign 子区内容未变不重写');
  assert.equal(note.writes, 0, '脚注子区内容未变不重写');
  assert.ok(host.innerHTML.includes('就这么办（签约 4 个块）'));
  assert.ok(host.innerHTML.includes('打扰策略'), '脚注在壳内（spec：#host 含 打扰策略）');
  assert.equal(handle.el, host);
  assert.equal(typeof handle.update, 'function');
});

test('M11 update({signed,hash})：只重写 .sign 子区，壳与 .bound 不动（增量约束）', () => {
  const { host, bound, sign, note } = stubBoundHost();
  const handle = mount(host, { boundary: BOUNDARY, sysWont: SYS_WONT, blockCount: 4 });
  handle.update({ signed: true, hash: 'sha256:abc…' });
  assert.equal(host.writes, 1, '壳不重写');
  assert.equal(bound.writes, 0, 'bound 子区不动');
  assert.equal(sign.writes, 1, 'sign 子区写入一次');
  assert.equal(note.writes, 0, '脚注子区不动');
  assert.ok(sign.innerHTML.includes('已签约'));
  assert.ok(sign.innerHTML.includes('合同 sha256:abc…'));
  handle.update({ signed: true, hash: 'sha256:abc…' });
  assert.equal(sign.writes, 1, '同态同参内容比对跳过');
  handle.update({ signed: false });
  assert.equal(sign.writes, 2, '撤回回未签约态');
  assert.ok(sign.innerHTML.includes('data-sign="1"'));
});

test('M11 update({boundary,blockCount})：各只重写对应子区；脚注文案可覆盖', () => {
  const { host, bound, sign, note } = stubBoundHost();
  const handle = mount(host, { boundary: BOUNDARY, sysWont: SYS_WONT, blockCount: 4 });
  handle.update({ boundary: { ...BOUNDARY, budget: ['约 60 次模型调用'] } });
  assert.equal(bound.writes, 1);
  assert.ok(bound.innerHTML.includes('约 60 次模型调用'));
  assert.ok(!bound.innerHTML.includes('约 40 次'), '旧花费条目替换');
  assert.ok(bound.innerHTML.includes(SYS_WONT), '换合同系统项仍在');
  assert.equal(sign.writes, 0);
  handle.update({ blockCount: 2 });
  assert.equal(sign.writes, 1);
  assert.ok(sign.innerHTML.includes('签约 2 个块'));
  assert.equal(bound.writes, 1, 'bound 不受块数影响');
  handle.update({ interruptNote: '打扰策略：全程静默，交付时叫我' });
  assert.equal(note.writes, 1);
  assert.ok(note.innerHTML.includes('全程静默'));
  assert.equal(host.writes, 1, '壳恒一次');
});

test('M11 update 合并语义：未传键不动旧值；空/非法 props 容忍且链式', () => {
  const { host, sign } = stubBoundHost();
  const handle = mount(host, { boundary: BOUNDARY, sysWont: SYS_WONT, signed: true, hash: 'sha256:x' });
  const ret = handle.update({}).update(undefined).update(null);
  assert.equal(typeof ret.update, 'function', '链式返回 handle');
  assert.equal(sign.writes, 0, '无键变化零重写');
  assert.ok(sign.innerHTML.includes('sha256:x'), 'signed/hash 保留');
  handle.update({ boundary: 'bogus' }); // 非对象 boundary 归一空四栏，不抛
  assert.ok(host.innerHTML.includes('我会做'));
});

test('M11 点击委托：签约 → onSign()；撤回 → onRevoke()；单监听；档外点击不回调不抛', () => {
  const { host } = stubBoundHost();
  const calls = [];
  mount(host, {
    boundary: BOUNDARY, sysWont: SYS_WONT, blockCount: 4,
    onSign: () => calls.push(['sign']), onRevoke: () => calls.push(['revoke']),
  });
  host.fire('click', stubTarget({ sign: '1' }));
  assert.deepEqual(calls, [['sign']], 'onSign 无参（spec 只记事件）');
  host.fire('click', stubTarget({ revoke: '1' }));
  assert.deepEqual(calls, [['sign'], ['revoke']]);
  assert.equal((host.listeners.click ?? []).length, 1, '容器级单监听');
  host.fire('click', { closest: () => null });
  host.fire('click', {});
  host.fire('click', null);
  assert.deepEqual(calls, [['sign'], ['revoke']], '档外不误触');
});

test('M11 回调归一：非函数/未给不抛；update 换回调即生效', () => {
  const { host } = stubBoundHost();
  const calls = [];
  const handle = mount(host, { boundary: BOUNDARY, blockCount: 1, onSign: '不是函数' });
  host.fire('click', stubTarget({ sign: '1' }), );
  assert.deepEqual(calls, []);
  handle.update({ onSign: () => calls.push(['sign']) });
  host.fire('click', stubTarget({ sign: '1' }));
  assert.deepEqual(calls, [['sign']], '后注入回调生效');
  const silent = stubBoundHost();
  mount(silent.host, { boundary: BOUNDARY });
  silent.host.fire('click', stubTarget({ sign: '1' }));
  silent.host.fire('click', stubTarget({ revoke: '1' }), );
});

test('M11 宿主缺 addEventListener/querySelector 或 el=null：mount 不抛、链式可用', () => {
  const bare = stubZone();
  const handle = mount(bare, { boundary: BOUNDARY, blockCount: 4 });
  assert.equal(bare.writes, 1, '无委托仅渲染');
  handle.update({ signed: true }); // 无 querySelector：子区打补丁安全跳过
  assert.equal(bare.writes, 1, '壳不重写（setHTML 内容比对）');
  const nullHandle = mount(null, { boundary: BOUNDARY, signed: true, hash: 'sha256:x' });
  assert.equal(typeof nullHandle.update, 'function');
  nullHandle.update({ blockCount: 9 }); // 不抛即过
});
