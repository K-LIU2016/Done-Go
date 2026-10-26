// M14 「需要你」收件箱单测（RED 先行 · 实现前必红）
// 依据：plan.md M14、PRD §5.5（L296-306 收件箱类型表：决定/数据/授权/到场/验收，
//   每条交互 = 单选等选项组；规则「每条都有截止时刻和超时默认行为」）、§5.1（L227
//   全局顶栏铃铛）、§4 Need 对象（L174：带截止和默认处理 → 进收件箱；L190 状态机
//   need: open → answered | defaulted(超时按默认)）、§6.8.2 引用（L757 收件箱弹出非阻塞）；
//   prototype.html（唯一视觉标准）L37-38（.bell 相对定位 + b 徽标 20px 圆角 you 色）、
//   L125-128（.inbox fixed right16 top72 宽 min(380,…) max-height 70vh / .need 左侧
//   4px you 色边 + 12px meta + acts 按钮组）、L135（.hidden display none）、L185
//   （reduced-motion 禁动画）、L195（铃铛按钮 aria-label=需要你 + b#bellN 计数）、
//   L236-239（面板 aside.card.inbox aria-label=需要你 + 关闭按钮 + #needs 空态文案）、
//   L515-523（renderNeeds：open=未 done 计数、徽标 0 隐藏、倒序渲染、meta=所属块 ·
//   截止 · 超时：默认、done → opacity.55 + 「已处理：…」、未 done → acts 按钮组
//   data-ans/data-v）、L607（超时默认 done='超时 · '+def）、L640（作答 data-ans →
//   done='你选了「v」'）、L643-644（铃铛开合 / 关闭按钮）。
// 契约：web/agentic/ui/inbox.js 具名导出
//   INBOX_TITLE / INBOX_EMPTY_TEXT / TIMEOUT_PREFIX / DONE_OPACITY /
//   normalizeNeed / normalizeNeeds / normalizeBlocks / normalizeCount / blockTitle /
//   pendingCount / isTimedOut / metaLine / actionsHTML / needCardInner / needCardHTML /
//   inboxShellHTML / bellShellHTML / emptyHTML / INBOX_CSS / ensureStyles /
//   mount(el, { needs, blocks, onAnswer, onClose }) → { el, update(props) } /
//   mountBell(el, { count, onToggle }) → { el, update({count}) }
//   need: { id, title, body, opts, due, def, b, done }（done 非空 = 已处理；
//   '超时 · ' 前缀 = 超时默认态）；渲染序 = 给定数组倒序（最新在前，prototype L518）。
// 增量硬约束（PRD §5.2 末 L275 原型实测教训）：面板壳（.inbox 头部 + .needs 容器）只
//   首绘写一次；此后 update 只做 ①need 内容补丁（同 id 同节点，done 态变化只改该卡
//   innerHTML + opacity）②新 need 按 DOM 位插入（anchor.insertAdjacentHTML beforebegin
//   / 容器 beforeend，不重排既有卡）③needs 收缩才 remove；空态 ↔ 列表切换只写容器。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  INBOX_TITLE, INBOX_EMPTY_TEXT, TIMEOUT_PREFIX, DONE_OPACITY,
  normalizeNeed, normalizeNeeds, normalizeBlocks, normalizeCount, blockTitle,
  pendingCount, isTimedOut, metaLine, actionsHTML, needCardInner, needCardHTML,
  inboxShellHTML, bellShellHTML, emptyHTML,
  INBOX_CSS, ensureStyles, mount, mountBell,
} from '../../../../web/agentic/ui/inbox.js';

const BLOCKS = [
  { id: 'r', title: 'AI 教育的深度研究' },
  { id: 'c', title: '课程设计' },
  { id: 'f', title: '和小王吃饭' },
];
const NEEDS = [
  { id: 'n1', title: '确认研究受众', body: '我按"国内 K12 · 初中教师"来写，对吗？', opts: ['对', '改成高中'], due: '14:00', def: '按"对"继续', b: 'r', done: '' },
  { id: 'n2', title: '大纲方向', body: 'A：每课时 1 个动手活动（偏实操）；B：前 2 课时讲概念、后 2 课时做项目（偏系统）', opts: ['A', 'B'], due: '15:45', def: '按 A 继续', b: 'c', done: '' },
  { id: 'n3', title: '该出发了', body: '18:20 出发，19:00 到。上次借的书别忘了。', opts: ['知道了', '晚 10 分钟'], due: '18:25', def: '不再提醒', b: 'f', done: '' },
];

// ---------- A. 纯核：常量与归一 ----------

test('M14 常量：标题/空态文案/超时前缀/降透明值照 prototype 原文', () => {
  assert.equal(INBOX_TITLE, '需要你'); // L195/L236-237
  assert.equal(INBOX_EMPTY_TEXT, '现在没有需要你处理的事。'); // L238/L522
  assert.equal(TIMEOUT_PREFIX, '超时 · '); // L607 n.done = '超时 · ' + n.def
  assert.equal(DONE_OPACITY, '.55'); // L519 style="opacity:.55"
});

test('M14 normalizeNeed：七字段全收（opts 逐项 trim）；null/缺 id/缺 title 无效', () => {
  assert.deepEqual(normalizeNeed(NEEDS[0]), NEEDS[0]);
  assert.equal(normalizeNeed(null), null);
  assert.equal(normalizeNeed(undefined), null);
  assert.equal(normalizeNeed('n1'), null, '字符串不是 need');
  assert.equal(normalizeNeed(42), null);
  assert.equal(normalizeNeed([]), null, '数组不是 need');
  assert.equal(normalizeNeed({ title: '确认受众' }), null, '缺 id');
  assert.equal(normalizeNeed({ id: 'n1' }), null, '缺 title');
  assert.equal(normalizeNeed({ id: '  ', title: 'x' }), null, '空白 id 无效');
  assert.equal(normalizeNeed({ id: 'n1', title: '  ' }), null, '空白 title 无效');
});

test('M14 normalizeNeed：缺省兜底（body/due/def/b/done → 空串、opts → []）+ 全字段 trim', () => {
  assert.deepEqual(
    normalizeNeed({ id: ' n1 ', title: ' 确认研究受众 ', body: ' 对吗？ ', opts: [' 对 ', 3, '改成高中'], due: ' 14:00 ', def: ' 按"对"继续 ', b: ' r ', done: ' ' }),
    { id: 'n1', title: '确认研究受众', body: '对吗？', opts: ['对', '改成高中'], due: '14:00', def: '按"对"继续', b: 'r', done: '' },
    'trim + 非字符串选项剔除 + 空白 done 归空（= 未处理）',
  );
  assert.deepEqual(normalizeNeed({ id: 'n1', title: '确认受众' }), { id: 'n1', title: '确认受众', body: '', opts: [], due: '', def: '', b: '', done: '' });
  assert.equal(normalizeNeed({ id: 'n1', title: 'x', done: 7 }).done, '', '非字符串 done 归空');
  assert.deepEqual(normalizeNeed({ id: 'n1', title: 'x', opts: '对' }).opts, [], '非数组 opts 归空');
});

test('M14 normalizeNeeds：数组过滤无效项保持给定顺序（时间正序给入约定）；非数组归空', () => {
  assert.deepEqual(normalizeNeeds(NEEDS), NEEDS);
  assert.deepEqual(normalizeNeeds([NEEDS[0], null, { id: 'x' }, 'n2', NEEDS[2]]), [NEEDS[0], NEEDS[2]], '无效项剔除');
  assert.deepEqual(normalizeNeeds([]), []);
  assert.deepEqual(normalizeNeeds(undefined), []);
  assert.deepEqual(normalizeNeeds(null), []);
  assert.deepEqual(normalizeNeeds({ 0: NEEDS[0], length: 1 }), [], '类数组不收');
});

test('M14 normalizeBlocks：只收 {id,title} 两字段（trim、均非空）；非数组归空', () => {
  assert.deepEqual(normalizeBlocks(BLOCKS), BLOCKS);
  assert.deepEqual(normalizeBlocks([{ id: ' r ', title: ' 研究 ' }, { id: 'x' }, null, { title: '无 id' }, 7]), [{ id: 'r', title: '研究' }]);
  assert.deepEqual(normalizeBlocks(undefined), []);
  assert.deepEqual(normalizeBlocks('blocks'), []);
});

test('M14 normalizeCount：归非负整数（铃铛徽标用）；非法一律 0', () => {
  assert.equal(normalizeCount(2), 2);
  assert.equal(normalizeCount(0), 0);
  assert.equal(normalizeCount('3'), 3);
  assert.equal(normalizeCount(-1), 0);
  assert.equal(normalizeCount(2.9), 2);
  assert.equal(normalizeCount('x'), 0);
  assert.equal(normalizeCount(null), 0);
  assert.equal(normalizeCount(undefined), 0);
});

test('M14 blockTitle：查所属块标题（prototype L520）；未知块/空参兜底空串不炸', () => {
  assert.equal(blockTitle(BLOCKS, 'r'), 'AI 教育的深度研究');
  assert.equal(blockTitle(BLOCKS, 'zzz'), '', '原型 find 不到会炸；组件兜底空串');
  assert.equal(blockTitle(BLOCKS, ''), '');
  assert.equal(blockTitle([], 'r'), '');
  assert.equal(blockTitle(null, 'r'), '');
  assert.equal(blockTitle(undefined, 'r'), '');
});

test('M14 pendingCount：未 done 计数（prototype L516 filter(!n.done)）；已处理/超时不算', () => {
  assert.equal(pendingCount(NEEDS), 3);
  assert.equal(pendingCount([{ ...NEEDS[0], done: '你选了「对」' }, NEEDS[1]]), 1);
  assert.equal(pendingCount([{ ...NEEDS[0], done: '超时 · 按"对"继续' }]), 0, '超时默认态不是未决');
  assert.equal(pendingCount([]), 0);
  assert.equal(pendingCount(undefined), 0);
  assert.equal(pendingCount(null), 0);
  assert.equal(pendingCount('n1'), 0);
});

test('M14 isTimedOut：done 以「超时 · 」开头 = 超时默认态（prototype L607）', () => {
  assert.equal(isTimedOut({ ...NEEDS[1], done: '超时 · 按 A 继续' }), true);
  assert.equal(isTimedOut({ ...NEEDS[0], done: '你选了「对」' }), false);
  assert.equal(isTimedOut({ ...NEEDS[0], done: '' }), false);
  assert.equal(isTimedOut({ ...NEEDS[0], done: '超时' }), false, '无间隔点不符 L607 原文');
});

// ---------- B. 纯核：结构 HTML（prototype L518-522 原文结构） ----------

test('M14 metaLine：所属块 · 截止 时刻 · 超时：默认（prototype L520 原文格式）', () => {
  assert.equal(metaLine(NEEDS[0], BLOCKS), 'AI 教育的深度研究 · 截止 14:00 · 超时：按"对"继续');
  assert.equal(metaLine(NEEDS[2], BLOCKS), '和小王吃饭 · 截止 18:25 · 超时：不再提醒');
});

test('M14 metaLine：未知所属块去首段；缺截止/缺默认只出有值的段（归一兜底）', () => {
  assert.equal(metaLine(NEEDS[0], []), '截止 14:00 · 超时：按"对"继续', '无块名不出「 · 」开头');
  assert.equal(metaLine({ id: 'n', title: 't', body: '', opts: [], due: '14:00', def: '', b: 'r', done: '' }, BLOCKS), 'AI 教育的深度研究 · 截止 14:00');
  assert.equal(metaLine({ id: 'n', title: 't', body: '', opts: [], due: '', def: '按 A 继续', b: 'r', done: '' }, BLOCKS), 'AI 教育的深度研究 · 超时：按 A 继续');
});

test('M14 actionsHTML：选项按钮组 data-ans=needId data-v=选项（prototype L521）', () => {
  assert.equal(
    actionsHTML(NEEDS[0]),
    '<div class="acts">'
    + '<button class="btn" type="button" data-ans="n1" data-v="对">对</button>'
    + '<button class="btn" type="button" data-ans="n1" data-v="改成高中">改成高中</button>'
    + '</div>',
  );
  assert.equal(actionsHTML(null), '');
  assert.equal(actionsHTML({ id: 'x' }), '', '无效 need 归空');
  assert.equal(actionsHTML({ ...NEEDS[0], done: '你选了「对」' }), '', '已处理不出按钮（L521 done 分支无 acts）'); // 壳层同款约束，纯核先行给出
});

test('M14 needCardInner：未处理 = 标题/正文/meta + acts（prototype L519-521 原文结构）', () => {
  const html = needCardInner(NEEDS[0], BLOCKS);
  assert.ok(html.startsWith('<b>确认研究受众</b><div>我按"国内 K12 · 初中教师"来写，对吗？</div>'), '标题 b + 正文 div（L519）');
  assert.ok(html.includes('<div class="meta">AI 教育的深度研究 · 截止 14:00 · 超时：按"对"继续</div>'), 'meta 行（L520）');
  assert.ok(html.includes('data-ans="n1"') && html.includes('data-v="对"'), 'acts 按钮组（L521）');
  assert.equal(needCardInner(null, BLOCKS), '');
});

test('M14 needCardInner：已处理 = 无 acts +「已处理：…」meta（prototype L521 done 分支）', () => {
  const html = needCardInner({ ...NEEDS[0], done: '你选了「对」' }, BLOCKS);
  assert.ok(!html.includes('data-ans'), '已处理无作答按钮');
  assert.ok(html.includes('<div class="meta">已处理：你选了「对」</div>'), '已处理行（L521 原文）');
  const timedOut = needCardInner({ ...NEEDS[1], done: '超时 · 按 A 继续' }, BLOCKS);
  assert.ok(timedOut.includes('<div class="meta">已处理：超时 · 按 A 继续</div>'), '超时默认态同一路径（L607 前缀）');
});

test('M14 needCardInner 转义：title/body/opts/done 五路 esc（M01 XSS 基线）', () => {
  const evil = { id: 'n"1', title: '<script>t</script>', body: '<img src=x onerror=1>', opts: ['<b>对</b>'], due: '14:00', def: '按"<i>x</i>"继续', b: 'r', done: '你选了「<u>对</u>」' };
  const html = needCardInner(evil, [{ id: 'r', title: '<em>块</em>' }]);
  assert.ok(!html.includes('<script>'), 'script 破坏');
  assert.ok(!html.includes('<img '), 'img 破坏');
  assert.ok(!html.includes('<b>对</b>') && !html.includes('<u>对</u>') && !html.includes('<em>块</em>'), '注入标签不得存活');
  assert.ok(html.includes('&lt;script&gt;t&lt;/script&gt;'));
  assert.ok(html.includes('data-v="&lt;b&gt;对&lt;/b&gt;"'), '选项值属性转义');
});

test('M14 needCardHTML：.need + data-need 身份键；done 才带 opacity:.55（prototype L519）', () => {
  const open = needCardHTML(NEEDS[0], BLOCKS);
  assert.ok(open.startsWith('<div class="need" data-need="n1">'), '未处理无内联 opacity');
  assert.ok(!open.includes('opacity'));
  const done = needCardHTML({ ...NEEDS[0], done: '你选了「对」' }, BLOCKS);
  assert.ok(done.startsWith('<div class="need" data-need="n1" style="opacity:.55">'), '已处理降透明（L519 原文值）');
  assert.equal(needCardHTML(null, BLOCKS), '');
  const evil = needCardHTML({ ...NEEDS[0], id: '"><script>alert(1)</script>' }, BLOCKS);
  assert.ok(!evil.includes('"><script>'), 'data-need 属性注入破坏');
});

test('M14 壳三件：inboxShellHTML（.inbox aria-label + 关闭钮 + .needs 容器）/ bellShellHTML / emptyHTML 原文', () => {
  const shell = inboxShellHTML();
  assert.ok(shell.startsWith('<div class="card inbox" aria-label="需要你">'), '面板根（prototype L236 aside.card.inbox aria-label）');
  assert.ok(shell.includes('<h2>需要你</h2>'), '标题（L237）');
  assert.ok(shell.includes('data-inbox-close') && shell.includes('关闭</button>'), '关闭按钮（L237 #inboxClose 对应物）');
  assert.ok(shell.includes('<div class="needs" aria-live="polite">'), 'needs 容器 + aria-live（BUILD-PLAN W5.3：aria-live 用在状态）');
  assert.ok(bellShellHTML().startsWith('<button class="btn bell" type="button" aria-label="需要你">'), '铃铛（L195 原文结构）');
  assert.ok(bellShellHTML().includes('<b class="hidden">0</b>'), '计数徽标初始隐藏');
  assert.equal(emptyHTML(), '<p class="small muted inbox-empty">现在没有需要你处理的事。</p>', '空态（L238/L522 原文）');
});

// ---------- C. 纯核：CSS（prototype L37-38/L125-128 原文 + a11y 硬要求） ----------

test('M14 INBOX_CSS：.inbox 定位/.need 左 you 边/.meta/.acts/.bell b 徽标原文', () => {
  assert.ok(INBOX_CSS.includes('.inbox{') || INBOX_CSS.includes('.inbox {'), '面板容器');
  assert.ok(INBOX_CSS.includes('position:fixed') && INBOX_CSS.includes('right:16px') && INBOX_CSS.includes('top:72px'), 'L125 fixed 定位');
  assert.ok(INBOX_CSS.includes('width:min(380px,calc(100vw - 32px))'), 'L125 宽度');
  assert.ok(INBOX_CSS.includes('max-height:70vh') && INBOX_CSS.includes('overflow:auto'), 'L125 滚动上限');
  assert.ok(/\.need\s*{[^}]*border-left:4px solid var\(--you,#E95432\)/.test(INBOX_CSS), 'L126 左 you 色边（兜底值）');
  assert.ok(/\.need\s*{[^}]*border-radius:12px/.test(INBOX_CSS) && /padding:10px 12px/.test(INBOX_CSS), 'L126 圆角内边距');
  assert.ok(/\.need \.meta\s*{[^}]*font-size:12px/.test(INBOX_CSS), 'L127 meta 12px');
  assert.ok(/\.need \.acts\s*{[^}]*display:flex[^}]*flex-wrap:wrap/.test(INBOX_CSS), 'L128 acts 换行按钮组');
  assert.ok(/\.bell b\s*{[^}]*min-width:20px[^}]*border-radius:10px[^}]*background:var\(--you,#E95432\)/.test(INBOX_CSS), 'L38 徽标 20px you 色');
  assert.ok(/\.bell b\.hidden\s*{[^}]*display:\s*none/.test(INBOX_CSS), '徽标 0 隐藏（L135/L517）');
});

test('M14 INBOX_CSS：focus-visible 焦点可见 + reduced-motion 禁动画（BUILD-PLAN W5.3 硬性要求）', () => {
  assert.ok(/focus-visible\s*{[^}]*outline:2px solid var\(--you,#E95432\)/.test(INBOX_CSS), '焦点可见');
  assert.ok(INBOX_CSS.includes('prefers-reduced-motion'));
  assert.ok(/@media \(prefers-reduced-motion: reduce\)[\s\S]*?animation:\s*none/.test(INBOX_CSS), '动画禁用（prototype L185）');
});

test('M14 ensureStyles：幂等注入 + 无 DOM 环境安全（M06/M07/M10/M12 同款桩）', () => {
  const mkDoc = (tag) => {
    const doc = { _styles: [] };
    doc.querySelector = (sel) => (sel === `style[${tag}]` ? doc._styles[0] ?? null : null);
    doc.createElement = () => ({ _attrs: {}, textContent: '', setAttribute(k, v) { this._attrs[k] = String(v); } });
    doc.head = { appendChild: (n) => doc._styles.push(n) };
    return doc;
  };
  const doc = mkDoc('data-agentic-inbox');
  assert.equal(ensureStyles(doc), true);
  assert.equal(doc._styles.length, 1);
  assert.ok(doc._styles[0].textContent.includes('.need'));
  assert.equal(ensureStyles(doc), false, '已注入不再重复');
  assert.equal(ensureStyles(null), false);
});

// ---------- D. 壳：mount / update（fake-DOM 桩，白盒同 M10/M12 模式） ----------

/** classList 桩 */
function mkClassList(initial = '') {
  const set = new Set(initial.split(/\s+/).filter(Boolean));
  return {
    add: (...cs) => cs.forEach((c) => set.add(c)),
    remove: (...cs) => cs.forEach((c) => set.delete(c)),
    toggle(c, force) { const on = force === undefined ? !set.has(c) : !!force; if (on) set.add(c); else set.delete(c); return on; },
    contains: (c) => set.has(c),
    _join: () => [...set].join(' '),
  };
}

const UNESC = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" };
const unesc = (s) => String(s).replace(/&(amp|lt|gt|quot|#39);/g, (m) => UNESC[m]);

/** 从一批卡 HTML 解析卡桩（<div 深度配平切卡；data-need 反解 esc） */
function parseNeedCards(html, list) {
  const cards = [];
  const open = /<div class="need" data-need="([^"]*)"( style="opacity:[^"]*")?>/g;
  let m;
  while ((m = open.exec(html))) {
    const tag = /<div\b|<\/div>/g;
    tag.lastIndex = open.lastIndex;
    let depth = 1; let end = html.length; let t;
    while ((t = tag.exec(html))) {
      if (t[0] === '</div>') { depth -= 1; if (depth === 0) { end = t.index; break; } } else depth += 1;
    }
    cards.push(mkCardEl(unesc(m[1]), /opacity:(\.\d+)/.exec(m[2] ?? '')?.[1] ?? '', html.slice(open.lastIndex, end), list));
    open.lastIndex = end + '</div>'.length;
  }
  return cards;
}

/** 卡桩：dataset.need / style.opacity / className / innerHTML 写计数 / remove / beforebegin 插入 */
function mkCardEl(needId, opacity, inner, list) {
  return {
    dataset: { need: needId },
    className: 'need',
    style: { opacity },
    _v: inner, writes: 0, removed: false,
    get innerHTML() { return this._v; },
    set innerHTML(v) { this.writes += 1; this._v = v; },
    remove() { this.removed = true; const i = list.rows.indexOf(this); if (i >= 0) list.rows.splice(i, 1); },
    insertAdjacentHTML(pos, html) {
      if (pos === 'beforebegin') list.rows.splice(list.rows.indexOf(this), 0, ...parseNeedCards(html, list));
    },
  };
}

/** 宿主桩：innerHTML 写即模拟浏览器重解析（.inbox/.needs 重建、卡清空） */
function stubInboxHost() {
  const doc = { _keys: [], addEventListener(t, f) { this._keys.push([t, f]); }, removeEventListener() {}, fire(ev) { this._keys.forEach(([, f]) => f(ev)); } };
  const list = {
    _v: '', writes: 0, rows: [],
    get innerHTML() { return this._v; },
    set innerHTML(v) { this.writes += 1; this._v = v; this.rows = []; },
    insertAdjacentHTML(pos, html) { if (pos === 'beforeend') this.rows.push(...parseNeedCards(html, this)); },
    querySelectorAll(sel) { return sel === '.need' ? this.rows.slice() : []; },
  };
  const panel = { querySelector(sel) { return sel === '.needs' ? list : null; } };
  const host = {
    _h: undefined, _v: '', writes: 0, listeners: {}, ownerDocument: doc,
    get innerHTML() { return this._v; },
    set innerHTML(v) {
      this.writes += 1; this._v = v;
      list.rows = []; list._v = ''; list.writes = 0; list._h = undefined; // 壳重写 = 容器重建（浏览器语义）
    },
    querySelector(sel) { return sel === '.inbox' ? panel : null; },
    addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); },
  };
  return { host, panel, list, doc };
}

/** 模拟点击：target.closest 按选择器回查（事件委托路径） */
function clickOn(host, closestSel, stub) {
  const ev = { target: { closest: (sel) => (sel === closestSel ? stub : null) } };
  (host.listeners.click ?? []).forEach((fn) => fn(ev));
}

test('M14 mount：壳只写一次；needs 空 → 容器出空态文案（prototype L238/L522）', () => {
  const { host, list } = stubInboxHost();
  mount(host, { needs: [], blocks: BLOCKS });
  assert.equal(host.writes, 1, '壳一次（增量基石）');
  assert.ok(host.innerHTML.includes('class="card inbox" aria-label="需要你"'));
  assert.equal(list.writes, 1, '空态一次');
  assert.equal(list.innerHTML, '<p class="small muted inbox-empty">现在没有需要你处理的事。</p>');
  assert.equal(list.rows.length, 0);
});

test('M14 mount：needs 倒序渲染（最新在前，prototype L518 slice().reverse()）', () => {
  const { host, list } = stubInboxHost();
  const handle = mount(host, { needs: NEEDS, blocks: BLOCKS });
  assert.equal(host.writes, 1);
  assert.equal(list.innerHTML, '', '空态被清');
  assert.deepEqual(list.rows.map((c) => c.dataset.need), ['n3', 'n2', 'n1'], '给定正序 → 渲染最新在前');
  assert.equal(handle.el, host);
  assert.equal(typeof handle.update, 'function');
});

test('M14 mount：need 卡内容 = 纯核 needCardInner 原文（meta 含所属块/截止/超时默认）', () => {
  const { host, list } = stubInboxHost();
  mount(host, { needs: [NEEDS[0]], blocks: BLOCKS });
  assert.equal(list.rows.length, 1);
  assert.equal(list.rows[0].innerHTML, needCardInner(NEEDS[0], BLOCKS), '壳渲染与纯核一致');
  assert.ok(list.rows[0].innerHTML.includes('AI 教育的深度研究 · 截止 14:00 · 超时：按"对"继续'), 'meta 三段（L520）');
});

test('M14 作答：点选项按钮 → onAnswer(needId, value)（prototype L640 data-ans/data-v）', () => {
  const { host } = stubInboxHost();
  const calls = [];
  mount(host, { needs: NEEDS, blocks: BLOCKS, onAnswer: (id, v) => calls.push([id, v]) });
  clickOn(host, 'button[data-ans]', { dataset: { ans: 'n1', v: '对' } });
  assert.deepEqual(calls, [['n1', '对']]);
  clickOn(host, 'button[data-ans]', { dataset: { ans: 'n3', v: '晚 10 分钟' } });
  assert.deepEqual(calls, [['n1', '对'], ['n3', '晚 10 分钟']]);
});

test('M14 关闭：关闭按钮 click 与 Esc 都 → onClose（prototype L644 + 键盘可达）', () => {
  const { host, doc } = stubInboxHost();
  const calls = [];
  mount(host, { needs: NEEDS, blocks: BLOCKS, onClose: () => calls.push('close') });
  clickOn(host, '[data-inbox-close]', { dataset: {} });
  doc.fire({ key: 'Escape', preventDefault() { this.prevented = true; } });
  doc.fire({ key: 'Enter' }); // 其他键不触发
  assert.deepEqual(calls, ['close', 'close']);
});

test('M14 Esc：defaultPrevented 的 Esc 不重复触发（drawer 同款护栏）', () => {
  const { host, doc } = stubInboxHost();
  const calls = [];
  mount(host, { needs: [], blocks: BLOCKS, onClose: () => calls.push('close') });
  doc.fire({ key: 'Escape', defaultPrevented: true });
  doc.fire({}); // 空事件安全
  assert.deepEqual(calls, []);
});

test('M14 增量：新 need 到达 → 前插不重排（最新在前），旧卡节点/内容零写', () => {
  const { host, list } = stubInboxHost();
  const handle = mount(host, { needs: [NEEDS[0], NEEDS[1]], blocks: BLOCKS }); // 渲染 [n2, n1]
  const n2Card = list.rows[0]; const n1Card = list.rows[1];
  n2Card.marker = 'keep-n2'; n1Card.marker = 'keep-n1';
  handle.update({ needs: [...NEEDS] }); // 追加 n3（时间正序给入）
  assert.equal(host.writes, 1, '壳未重写');
  assert.deepEqual(list.rows.map((c) => c.dataset.need), ['n3', 'n2', 'n1'], 'n3 插到最前');
  assert.equal(list.rows[1], n2Card); assert.equal(list.rows[2], n1Card);
  assert.equal(list.rows[1].marker, 'keep-n2'); assert.equal(list.rows[2].marker, 'keep-n1');
  assert.equal(n2Card.writes, 0, '旧卡内容零写');
  assert.equal(n1Card.writes, 0);
});

test('M14 增量：作答后 done 态 → 同卡补丁（已处理行 + 无按钮 + opacity .55），节点不变', () => {
  const { host, list } = stubInboxHost();
  const handle = mount(host, { needs: NEEDS, blocks: BLOCKS });
  const card = list.rows[2]; // n1（最旧在末位）
  card.marker = 'same-node';
  handle.update({ needs: [{ ...NEEDS[0], done: '你选了「对」' }, NEEDS[1], NEEDS[2]] });
  assert.equal(list.rows[2], card, '节点身份不变（不重建）');
  assert.equal(card.writes, 1, '只补丁一次');
  assert.ok(card.innerHTML.includes('已处理：你选了「对」'));
  assert.ok(!card.innerHTML.includes('data-ans'), '作答按钮消失');
  assert.equal(card.style.opacity, '.55', '降透明（prototype L519）');
});

test('M14 增量：超时默认态（done=超时 · 默认，prototype L607）同卡补丁', () => {
  const { host, list } = stubInboxHost();
  const handle = mount(host, { needs: [NEEDS[1]], blocks: BLOCKS });
  const card = list.rows[0];
  handle.update({ needs: [{ ...NEEDS[1], done: '超时 · 按 A 继续' }] });
  assert.equal(list.rows[0], card);
  assert.ok(card.innerHTML.includes('已处理：超时 · 按 A 继续'));
  assert.equal(card.style.opacity, '.55');
});

test('M14 增量：done → 重新打开（done 清空）→ 按钮回归 + opacity 复位', () => {
  const { host, list } = stubInboxHost();
  const handle = mount(host, { needs: [{ ...NEEDS[0], done: '你选了「对」' }], blocks: BLOCKS });
  const card = list.rows[0];
  assert.equal(card.style.opacity, '.55');
  handle.update({ needs: [NEEDS[0]] });
  assert.equal(list.rows[0], card);
  assert.ok(card.innerHTML.includes('data-ans="n1"'), 'acts 回归');
  assert.equal(card.style.opacity, '', '透明度复位');
});

test('M14 增量：blocks 变化（所属块标题改）→ 只补丁 meta 所在卡', () => {
  const { host, list } = stubInboxHost();
  const handle = mount(host, { needs: NEEDS, blocks: BLOCKS });
  const before = list.rows.map((c) => c.writes);
  handle.update({ blocks: [{ id: 'r', title: 'AI 教育研究（v2）' }, ...BLOCKS.slice(1)] });
  assert.equal(list.rows[2].writes, before[2] + 1, 'n1（块 r）补丁一次');
  assert.ok(list.rows[2].innerHTML.includes('AI 教育研究（v2） · 截止 14:00'));
  assert.equal(list.rows[0].writes, before[0], 'n3（块 f）内容未变零写');
  assert.equal(list.rows[1].writes, before[1], 'n2（块 c）内容未变零写');
});

test('M14 增量：needs 收缩 → 对应卡 remove，其余卡 DOM 原序不动', () => {
  const { host, list } = stubInboxHost();
  const handle = mount(host, { needs: NEEDS, blocks: BLOCKS });
  const gone = list.rows[1]; // n2
  const keep = list.rows[2]; // n1
  handle.update({ needs: [NEEDS[0], NEEDS[2]] });
  assert.ok(gone.removed, 'n2 卡被 remove');
  assert.deepEqual(list.rows.map((c) => c.dataset.need), ['n3', 'n1']);
  assert.equal(list.rows[1], keep, '未涉及卡节点不变');
});

test('M14 增量：列表 → 空态 → 再来 needs（容器文案切换，prototype L522 分支）', () => {
  const { host, list } = stubInboxHost();
  const handle = mount(host, { needs: NEEDS, blocks: BLOCKS });
  handle.update({ needs: [] });
  assert.equal(list.rows.length, 0);
  assert.ok(list.innerHTML.includes('现在没有需要你处理的事'));
  handle.update({ needs: [NEEDS[1]] });
  assert.equal(list.rows.length, 1);
  assert.equal(list.innerHTML, '', '空态文案被清');
  handle.update({ needs: [] });
  assert.ok(list.innerHTML.includes('现在没有需要你处理的事'), '回空态');
});

test('M14 同 id 重复：取最新版本（倒序首个），不重复建卡', () => {
  const { host, list } = stubInboxHost();
  const handle = mount(host, { needs: [NEEDS[0], { ...NEEDS[0], done: '你选了「对」' }], blocks: BLOCKS });
  assert.deepEqual(list.rows.map((c) => c.dataset.need), ['n1'], '同 id 一张卡');
  assert.ok(list.rows[0].innerHTML.includes('已处理：你选了「对」'), '取数组靠后（更新）版本');
  handle.update({ needs: [NEEDS[0], NEEDS[0]] });
  assert.equal(list.rows.length, 1);
});

test('M14 update 合并语义：未传键不动旧值；onAnswer/onClose 可后续替换；链式返回', () => {
  const { host, list } = stubInboxHost();
  const calls1 = []; const calls2 = [];
  const handle = mount(host, { needs: [NEEDS[0]], blocks: BLOCKS, onAnswer: (...a) => calls1.push(a) });
  handle.update({}); // 同内容零写
  assert.equal(list.rows[0].writes, 0);
  handle.update(undefined);
  assert.equal(list.rows.length, 1, 'needs 保留');
  clickOn(host, 'button[data-ans]', { dataset: { ans: 'n1', v: '对' } });
  assert.deepEqual(calls1, [['n1', '对']]);
  const ret = handle.update({ onAnswer: (...a) => calls2.push(a) });
  assert.equal(typeof ret.update, 'function', '链式返回 handle');
  clickOn(host, 'button[data-ans]', { dataset: { ans: 'n1', v: '改成高中' } });
  assert.deepEqual(calls1, [['n1', '对']], '旧回调不再触发');
  assert.deepEqual(calls2, [['n1', '改成高中']], '新回调生效');
});

test('M14 宿主缺 querySelector/insertAdjacentHTML 或 el=null：mount/update 不抛', () => {
  const bare = { _h: undefined, _v: '', writes: 0, get innerHTML() { return this._v; }, set innerHTML(v) { this.writes += 1; this._v = v; } };
  const handle = mount(bare, { needs: NEEDS, blocks: BLOCKS });
  assert.equal(bare.writes, 1, '壳仍首绘');
  handle.update({ needs: [] }); // 无容器：安全跳过
  assert.equal(bare.writes, 1, '壳不重写');
  const headless = mount(null, {});
  assert.equal(typeof headless.update, 'function');
  headless.update({ needs: NEEDS }); // 不抛
});

// ---------- E. 壳：mountBell（顶栏铃铛 + 未决计数徽标，prototype L195/L517） ----------

/** 铃铛宿主桩：innerHTML 写即重解析出按钮 + 徽标 */
function stubBellHost() {
  const fresh = () => {
    const badge = { className: 'hidden', classList: mkClassList('hidden'), _t: '0', get textContent() { return this._t; }, set textContent(v) { this._t = String(v); } };
    const btn = {
      className: 'btn bell', classList: mkClassList('btn bell'), dataset: {},
      querySelector(sel) { return sel === 'b' ? badge : null; },
    };
    return { btn, badge };
  };
  let dom = fresh();
  const host = {
    _h: undefined, _v: '', writes: 0, listeners: {},
    get innerHTML() { return this._v; },
    set innerHTML(v) { this.writes += 1; this._v = v; dom = fresh(); }, // 重解析
    querySelector(sel) { return sel === 'button' ? dom.btn : null; },
    addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); },
  };
  return { host, get dom() { return dom; } };
}

test('M14 mountBell：按钮 + 徽标一次写；count>0 显数、count=0 隐藏（prototype L517）', () => {
  const { host, dom } = stubBellHost();
  const calls = [];
  const handle = mountBell(host, { count: 2, onToggle: () => calls.push('toggle') });
  assert.equal(host.writes, 1, '铃铛壳只写一次');
  assert.ok(host.innerHTML.startsWith('<button class="btn bell" type="button" aria-label="需要你">需要你<b'));
  assert.equal(dom.badge.textContent, '2');
  assert.equal(dom.badge.classList.contains('hidden'), false);
  assert.equal(handle.el, host);
  handle.update({ count: 0 });
  assert.equal(host.writes, 1, '增量：不重写按钮');
  assert.equal(dom.badge.classList.contains('hidden'), true, '0 隐藏徽标（L517 toggle hidden）');
  handle.update({ count: 5 });
  assert.equal(dom.badge.textContent, '5');
  assert.equal(dom.badge.classList.contains('hidden'), false);
});

test('M14 mountBell：初始 count=0 → 徽标隐藏；count 缺省归 0', () => {
  const s1 = stubBellHost();
  mountBell(s1.host, { count: 0 });
  assert.equal(s1.dom.badge.classList.contains('hidden'), true);
  const s2 = stubBellHost();
  mountBell(s2.host, {});
  assert.equal(s2.dom.badge.classList.contains('hidden'), true, '缺省 0 隐藏');
  assert.equal(s2.dom.badge.textContent, '0');
});

test('M14 mountBell：点击按钮 → onToggle；update 不误触发', () => {
  const { host } = stubBellHost();
  const calls = [];
  mountBell(host, { count: 1, onToggle: () => calls.push('toggle') });
  const ev = { target: { closest: (sel) => (sel === 'button' ? {} : null) } };
  (host.listeners.click ?? []).forEach((fn) => fn(ev));
  assert.deepEqual(calls, ['toggle']);
  const handle = mountBell(stubBellHost().host, { count: 1, onToggle: () => calls.push('x2') });
  handle.update({ count: 3 });
  assert.deepEqual(calls, ['toggle'], 'update 零触发');
});

test('M14 mountBell：无 onToggle / el=null / 裸宿主安全；count 归一走 normalizeCount', () => {
  const h1 = mountBell(stubBellHost().host, { count: 1 }); // 无回调
  assert.equal(typeof h1.update, 'function');
  const h2 = mountBell(null, { count: 2 });
  assert.equal(typeof h2.update, 'function');
  h2.update({ count: 0 }); // 不抛
  const bare = { _h: undefined, _v: '', writes: 0, get innerHTML() { return this._v; }, set innerHTML(v) { this.writes += 1; this._v = v; } };
  const h3 = mountBell(bare, { count: 7 }); // 无 querySelector：壳已写，徽标同步安全跳过
  assert.equal(bare.writes, 1);
  h3.update({ count: '4' });
  assert.equal(bare.writes, 1, '不重写');
});
