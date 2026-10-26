// M10 讨论框 + 差异高亮 单测（RED 先行 · 实现前必红）
// 依据：plan.md M10、PRD §5.2（L271：对着预演说话/打字 → 结构化补丁 → 只重渲染受影响层 →
//   差异高亮 新增绿/删除删除线/变更黄，L0 ≤3 秒）+ §5.2 末「原型实测教训」（整块重绘冲掉
//   输入/焦点）；prototype.html（唯一视觉标准）L96-98（.discuss/.row/input 样式）、
//   L409-412（结构：small 提示 + .chips 例句 + .row 输入行 + #patchNote[aria-live]）、
//   L452-459（applySay：空文本 return；已按「…」更新：+ .add/.del/.chg）、
//   L629（#sayBtn → value.trim()）、L648（Enter on #sayInput）。
// 契约：web/agentic/ui/discuss.js 具名导出
//   DISCUSS_HEADING / SAY_PLACEHOLDER / SAY_LABEL / normalizeExamples / normalizeNote /
//   markSummary / patchNoteHTML / chipsInner / chipsHTML / rowHTML / discussHTML /
//   DISCUSS_CSS / ensureStyles / mount(el, { examples, note, onSay }) → { el, update(props), say(text) }
//   note = { utterance, summary }；summary 按「新增/删除/变更」前缀分段包 .add/.del/.chg。
// 增量硬约束（spec「更新 patchNote 后输入框不丢焦点」的 node 等价）：壳（提示行/.chips/.row/
//   #patchNote）只在 mount 写一次；update 仅打 .chips/.patch-note 两子区（setHTML 内容比对），
//   输入行节点永不重建 → 焦点与输入值跨 update 存活；提交不清空输入框（spec 双提交契约）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DISCUSS_HEADING, SAY_PLACEHOLDER, SAY_LABEL,
  normalizeExamples, normalizeNote, markSummary, patchNoteHTML,
  chipsInner, chipsHTML, rowHTML, discussHTML,
  DISCUSS_CSS, ensureStyles, mount,
} from '../../../../web/agentic/ui/discuss.js';

const EXAMPLES = ['研究只看国内 K12', '课程是给初中老师的 4 课时工作坊'];
const NOTE = {
  utterance: '研究只看国内 K12',
  summary: '新增 课堂实践 / 教师准备度；删除 海外案例；变更 来源范围仅国内（2.4 秒）',
};

// ---------- A. 纯核：常量与归一 ----------

test('M10 常量：提示行/占位符/按钮文案照 prototype L409/L411 原文', () => {
  assert.equal(DISCUSS_HEADING, '对着预演说说你的想法（试试下面的例子）');
  assert.equal(SAY_PLACEHOLDER, '比如：别读我的邮箱 / 篇幅短一点');
  assert.equal(SAY_LABEL, '改');
});

test('M10 normalizeExamples：字符串数组原样；非数组归空；非字符串/空白项过滤', () => {
  assert.deepEqual(normalizeExamples(EXAMPLES), EXAMPLES);
  assert.deepEqual(normalizeExamples([]), []);
  assert.deepEqual(normalizeExamples(undefined), []);
  assert.deepEqual(normalizeExamples(null), []);
  assert.deepEqual(normalizeExamples('研究只看国内 K12'), [], '字符串不是数组');
  assert.deepEqual(normalizeExamples({ 0: 'x', length: 1 }), [], '类数组不收');
  assert.deepEqual(
    normalizeExamples(['ok', 42, null, { s: 'x' }, '   ', '', '再见']),
    ['ok', '再见'],
    '只留非空字符串',
  );
});

test('M10 normalizeNote：对象取两字段；null/缺省/标量一律 null；字段缺省空串', () => {
  assert.deepEqual(normalizeNote(NOTE), NOTE);
  assert.deepEqual(normalizeNote({ utterance: 'x' }), { utterance: 'x', summary: '' });
  assert.deepEqual(normalizeNote({ summary: '新增 A' }), { utterance: '', summary: '新增 A' });
  assert.equal(normalizeNote(null), null);
  assert.equal(normalizeNote(undefined), null);
  assert.equal(normalizeNote('新增 A'), null, '字符串不是 note');
  assert.equal(normalizeNote([]), null, '数组不是 note');
  assert.equal(normalizeNote(42), null);
});

// ---------- B. 纯核：差异高亮 markSummary / patchNoteHTML ----------

test('M10 markSummary：新增/删除/变更 前缀分段 → .add/.del/.chg（prototype L458）', () => {
  const html = markSummary(NOTE.summary);
  assert.ok(html.includes('<span class="add">新增</span> 课堂实践 / 教师准备度'), '新增段');
  assert.ok(html.includes('<span class="del">删除</span> 海外案例'), '删除段');
  assert.ok(html.includes('<span class="chg">变更</span> 来源范围仅国内（2.4 秒）'), '变更段');
  assert.ok(html.includes('；'), '段间保留中文分号');
});

test('M10 markSummary：无关键字段原样转义不包 span；关键字在中间/孤立关键字', () => {
  assert.equal(markSummary('课程改为 4 课时工作坊'), '课程改为 4 课时工作坊', '纯文本');
  assert.equal(markSummary('已含新增在中间'), '已含新增在中间', '非前缀不包 span');
  assert.equal(markSummary(''), '', '空串');
  assert.equal(markSummary(undefined), '', '缺省空串');
  assert.equal(markSummary('新增'), '<span class="add">新增</span>', '孤立关键字无尾随空格');
  assert.equal(markSummary('删除 '), '<span class="del">删除</span>', '仅空白尾段');
  const mixed = markSummary('新增 A；课程改为 4 课时；变更 B');
  assert.ok(mixed.includes('<span class="add">新增</span> A'));
  assert.ok(mixed.includes('；课程改为 4 课时；'), '中段无关键字保持纯文本');
  assert.ok(mixed.includes('<span class="chg">变更</span> B'));
});

test('M10 markSummary：分段内容经 esc（XSS 基线）；ASCII 分号同样分段', () => {
  const html = markSummary('新增 <script>x</script>；删除 <img src=x onerror=1>');
  assert.ok(!html.includes('<script>'), '标签必须被破坏');
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(!html.includes('<img'), 'img 不得存活');
  assert.ok(html.includes('<span class="del">删除</span> &lt;img src=x onerror=1&gt;'));
  const semi = markSummary('新增 A;删除 B');
  assert.ok(semi.includes('<span class="add">新增</span> A；') && semi.includes('<span class="del">删除</span> B'), 'ASCII 分号切段，段间统一回prototype 全角；');
});

test('M10 patchNoteHTML：null→空串；完整 → 已按「…」更新：+ 分段高亮（prototype L458）', () => {
  assert.equal(patchNoteHTML(null), '');
  assert.equal(patchNoteHTML(undefined), '');
  const html = patchNoteHTML(NOTE);
  assert.ok(html.startsWith('已按「研究只看国内 K12」更新：'), '前缀原文');
  assert.ok(html.includes('<span class="add">新增</span>'), '含 .add');
  assert.ok(html.includes('<span class="del">删除</span>'), '含 .del');
  assert.ok(html.includes('<span class="chg">变更</span>'), '含 .chg');
});

test('M10 patchNoteHTML：utterance 转义（spec XSS 契约）；空 summary 只出前缀不带尾冒号', () => {
  const html = patchNoteHTML({ utterance: '<img src=x onerror=1>', summary: '新增 A' });
  assert.ok(!html.includes('<img'), 'img 不得存活');
  assert.ok(html.includes('已按「&lt;img src=x onerror=1&gt;」更新'));
  assert.equal(patchNoteHTML({ utterance: 'x', summary: '' }), '已按「x」更新', '空摘要无尾冒号');
});

// ---------- C. 纯核：结构 chips/row/壳 ----------

test('M10 chipsInner/chipsHTML：button.chip[data-say] 双 esc；空例句出空容器', () => {
  const inner = chipsInner(EXAMPLES);
  assert.equal(inner,
    '<button type="button" class="chip" data-say="研究只看国内 K12">研究只看国内 K12</button>'
    + '<button type="button" class="chip" data-say="课程是给初中老师的 4 课时工作坊">课程是给初中老师的 4 课时工作坊</button>');
  assert.equal(chipsHTML(EXAMPLES), `<div class="chips">${inner}</div>`, '.chips 容器（prototype L410）');
  assert.equal(chipsInner([]), '');
  assert.equal(chipsInner(undefined), '');
});

test('M10 chips 转义：例句含引号/尖括号不得透传（M01 XSS 基线）', () => {
  const html = chipsInner(['"><script>alert(1)</script>']);
  assert.ok(!html.includes('"><script>'), '不得透传原始注入串');
  assert.ok(html.includes('data-say="&quot;&gt;&lt;script&gt;'));
  assert.ok(!html.includes('<script>alert'), '正文侧同样破坏');
});

test('M10 rowHTML：#sayInput(placeholder+aria-label) + #sayBtn 改（prototype L411 原文）', () => {
  const html = rowHTML();
  assert.ok(html.startsWith('<div class="row">'), '.row 容器');
  assert.ok(html.includes('<input id="sayInput" placeholder="比如：别读我的邮箱 / 篇幅短一点" aria-label="讨论">'));
  assert.ok(html.includes('<button type="button" class="btn" id="sayBtn" data-saybtn="1">改</button>'));
});

test('M10 discussHTML：.discuss > 提示行 + .chips + .row + #patchNote[aria-live=polite]（L409-412）', () => {
  const html = discussHTML({ examples: EXAMPLES, note: NOTE });
  assert.ok(html.startsWith('<div class="discuss">') && html.endsWith('</div>'));
  assert.ok(html.includes(`<p class="small muted">${DISCUSS_HEADING}</p>`), '提示行原文');
  assert.ok(html.includes('<div class="chips">'));
  assert.ok(html.includes('id="sayInput"') && html.includes('id="sayBtn"'));
  assert.ok(html.includes('<p class="small patch-note" id="patchNote" aria-live="polite" role="status">'), '播报容器');
  assert.ok(html.includes('已按「研究只看国内 K12」更新：'), 'note 内联首绘');
  assert.equal(discussHTML(), discussHTML({}), '缺省 props 安全');
  assert.ok(discussHTML().includes('<div class="chips"></div>'), '缺省空 chips');
  assert.ok(discussHTML().includes('aria-live="polite"'), '无 note 也保留播报容器');
});

test('M10 DISCUSS_CSS：.discuss/.row/input（L96-98）+ .chips/.chip（L53-54）+ add/del/chg（L83-85）+ reduced-motion', () => {
  assert.ok(DISCUSS_CSS.includes('.discuss {'), '容器布局（prototype L96）');
  assert.ok(DISCUSS_CSS.includes('.discuss .row'), '输入行（L97）');
  assert.ok(DISCUSS_CSS.includes('.discuss input'), '输入样式（L98）');
  assert.ok(DISCUSS_CSS.includes('.chips'), 'chips 布局（L53）');
  assert.ok(DISCUSS_CSS.includes('.discuss .chip'), 'chip 样式（L54）');
  assert.ok(/\.patch-note \.add\s*{[^}]*--add/.test(DISCUSS_CSS), 'add 用 --add token');
  assert.ok(/\.patch-note \.del\s*{[^}]*line-through/.test(DISCUSS_CSS), 'del 删除线（L84）');
  assert.ok(/\.patch-note \.chg\s*{[^}]*--chg/.test(DISCUSS_CSS), 'chg 用 --chg token');
  assert.ok(DISCUSS_CSS.includes('prefers-reduced-motion'), 'reduced-motion 降级');
});

test('M10 ensureStyles：幂等注入 + 无 DOM 环境安全（M06/M07 同款桩）', () => {
  const mkDoc = (tag) => {
    const doc = { _styles: [] };
    doc.querySelector = (sel) => (sel === `style[${tag}]` ? doc._styles[0] ?? null : null);
    doc.createElement = () => ({ _attrs: {}, textContent: '', setAttribute(k, v) { this._attrs[k] = String(v); } });
    doc.head = { appendChild: (n) => doc._styles.push(n) };
    return doc;
  };
  const doc = mkDoc('data-agentic-discuss');
  assert.equal(ensureStyles(doc), true);
  assert.equal(doc._styles.length, 1);
  assert.ok(doc._styles[0].textContent.includes('.discuss'));
  assert.equal(ensureStyles(doc), false, '已注入不再重复');
  assert.equal(ensureStyles(null), false);
});

// ---------- D. 壳：mount/update（fake-DOM 桩，白盒同 M06/M07 模式） ----------

function stubZone() {
  return { _h: undefined, _v: '', writes: 0, get innerHTML() { return this._v; }, set innerHTML(v) { this.writes += 1; this._v = v; } };
}

/** 宿主桩：innerHTML 写入即模拟浏览器重解析（.chips/.patch-note 子树按内容重建，构造不计写） */
function stubDiscussHost() {
  const chips = stubZone();
  const note = stubZone();
  const input = { id: 'sayInput', value: '' };
  const host = {
    _h: undefined, _v: '', writes: 0, listeners: {},
    get innerHTML() { return this._v; },
    set innerHTML(v) {
      this.writes += 1; this._v = v;
      const c = v.match(/<div class="chips">([\s\S]*?)<\/div>/);
      chips._h = c ? c[1] : undefined; chips._v = c ? c[1] : ''; // 浏览器解析 = _h 已同步
      const n = v.match(/<p class="small patch-note"[^>]*>([\s\S]*?)<\/p>/);
      note._h = n ? n[1] : undefined; note._v = n ? n[1] : '';
    },
    querySelector(sel) {
      if (sel === '.chips') return chips;
      if (sel === '.patch-note') return note;
      if (sel === 'input') return input;
      return null;
    },
    addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); },
    fire(type, ev) { for (const fn of this.listeners[type] ?? []) fn(ev); },
  };
  return { host, chips, note, input };
}

function stubChip(say) {
  return { dataset: { say }, closest(sel) { return sel === '[data-say]' ? this : null; } };
}
const stubBtn = { dataset: {}, closest(sel) { return sel === '[data-saybtn]' ? this : null; } };

function mountCalls(host, props = {}) {
  const calls = [];
  const handle = mount(host, { onSay: (t) => calls.push(['say', t]), ...props });
  return { handle, calls };
}

test('M10 mount：壳只写一次；两子区零额外写（setHTML 内容比对）；handle 形状', () => {
  const { host, chips, note } = stubDiscussHost();
  const { handle } = mountCalls(host, { examples: EXAMPLES });
  assert.equal(host.writes, 1, '壳首绘一次');
  assert.equal(chips.writes, 0, 'chips 子区内容未变不重写');
  assert.equal(note.writes, 0, 'patchNote 子区内容未变不重写');
  assert.ok(host.innerHTML.includes('data-say="研究只看国内 K12"'));
  assert.equal(handle.el, host);
  assert.equal(typeof handle.update, 'function');
  assert.equal(typeof handle.say, 'function');
});

test('M10 update({note})：只打 patchNote 子区，壳零重写 = 输入行不重建不丢焦点（spec 焦点断言等价）', () => {
  const { host, chips, note, input } = stubDiscussHost();
  const { handle } = mountCalls(host, { examples: EXAMPLES });
  const inputNode = input;
  handle.update({ note: NOTE });
  assert.equal(host.writes, 1, '壳不重写（#sayInput 节点身份保留）');
  assert.equal(host.querySelector('input'), inputNode, '输入节点引用不变');
  assert.equal(chips.writes, 0, 'chips 子区不动');
  assert.equal(note.writes, 1, 'patchNote 子区写入一次');
  assert.ok(note.innerHTML.includes('已按「研究只看国内 K12」更新：'));
  assert.ok(note.innerHTML.includes('<span class="add">新增</span>'));
});

test('M10 update({examples})：只打 chips 子区；note 子区与壳不动', () => {
  const { host, chips, note } = stubDiscussHost();
  const { handle } = mountCalls(host, { examples: EXAMPLES });
  handle.update({ examples: ['幻灯片换成深色'] });
  assert.equal(host.writes, 1, '壳不重写');
  assert.equal(chips.writes, 1, 'chips 子区写入一次');
  assert.ok(chips.innerHTML.includes('幻灯片换成深色'));
  assert.ok(!chips.innerHTML.includes('研究只看国内 K12'), '旧例句替换');
  assert.equal(note.writes, 0, 'patchNote 子区不动');
});

test('M10 同内容 update 零写；note 显式 null 清空；examples 缺省不覆盖旧值', () => {
  const { host, chips, note } = stubDiscussHost();
  const { handle } = mountCalls(host, { examples: EXAMPLES, note: NOTE });
  const ret = handle.update({}).update(undefined);
  assert.equal(typeof ret.update, 'function', '链式返回 handle');
  assert.equal(host.writes, 1);
  assert.equal(chips.writes, 0);
  assert.equal(note.writes, 0, '同内容不重写');
  handle.update({ note: null });
  assert.equal(note.writes, 1, '显式 null 清空播报区');
  assert.equal(note.innerHTML, '');
  handle.update({}); // examples 未传 → 保留
  assert.ok(chips.innerHTML.includes('研究只看国内 K12'), '例句不丢');
  handle.update({ examples: 'bogus' });
  assert.ok(chips.innerHTML.includes('<div') === false && chips.innerHTML === '', '非法 examples 归空');
});

test('M10 例句 chip 点击 → onSay(data-say)；容器级单监听；档外点击不回调不抛', () => {
  const { host } = stubDiscussHost();
  const { calls } = mountCalls(host, { examples: EXAMPLES });
  host.fire('click', { target: stubChip('研究只看国内 K12') });
  host.fire('click', { target: stubChip('课程是给初中老师的 4 课时工作坊') });
  assert.deepEqual(calls, [['say', '研究只看国内 K12'], ['say', '课程是给初中老师的 4 课时工作坊']]);
  assert.equal((host.listeners.click ?? []).length, 1, '容器级单监听');
  host.fire('click', { target: { closest: () => null } });
  host.fire('click', {});
  assert.deepEqual(calls, [['say', '研究只看国内 K12'], ['say', '课程是给初中老师的 4 课时工作坊']], '档外不回调');
});

test('M10 「改」按钮 → onSay(input.value.trim())（prototype L629）；提交不清输入框（spec 双提交契约）', () => {
  const { host, input } = stubDiscussHost();
  const { calls } = mountCalls(host, { examples: EXAMPLES });
  input.value = '  别读我的邮箱  ';
  host.fire('click', { target: stubBtn });
  assert.deepEqual(calls, [['say', '别读我的邮箱']], 'trim 后提交');
  assert.equal(input.value, '  别读我的邮箱  ', '提交不清空输入框');
});

test('M10 Enter on #sayInput → onSay（prototype L648）；其他键/其他目标忽略', () => {
  const { host, input } = stubDiscussHost();
  const { calls } = mountCalls(host, { examples: EXAMPLES });
  input.value = '篇幅短一点';
  host.fire('keydown', { key: 'Enter', target: input });
  assert.deepEqual(calls, [['say', '篇幅短一点']]);
  host.fire('keydown', { key: 'a', target: input });
  host.fire('keydown', { key: 'Enter', target: { id: 'other', value: 'x' } });
  assert.deepEqual(calls, [['say', '篇幅短一点']], '仅 sayInput 的 Enter 生效');
});

test('M10 空输入（含纯空白）忽略：Enter/按钮/chip 三路径都不触发 onSay（DAG M10）', () => {
  const { host, input } = stubDiscussHost();
  const { calls } = mountCalls(host, { examples: EXAMPLES });
  input.value = '   ';
  host.fire('keydown', { key: 'Enter', target: input });
  host.fire('click', { target: stubBtn });
  host.fire('click', { target: stubChip('   ') });
  host.fire('click', { target: stubChip('') });
  assert.deepEqual(calls, []);
});

test('M10 onSay 未给/非函数：点击与键入不抛（归一 null）', () => {
  const { host, input } = stubDiscussHost();
  const handle = mount(host, { examples: EXAMPLES });
  host.fire('click', { target: stubChip('x') });
  input.value = 'y';
  host.fire('keydown', { key: 'Enter', target: input });
  handle.update({ onSay: '不是函数' });
  host.fire('click', { target: stubBtn });
});

test('M10 handle.say 编程入口：trim 提交 + 空忽略 + 返回真假', () => {
  const { host } = stubDiscussHost();
  const { handle, calls } = mountCalls(host, { examples: EXAMPLES });
  assert.equal(handle.say('  研究只看国内 K12 '), true);
  assert.equal(handle.say('   '), false);
  assert.equal(handle.say(null), false);
  assert.deepEqual(calls, [['say', '研究只看国内 K12']]);
});

test('M10 宿主缺 addEventListener/querySelector 或 el=null：mount 不抛、链式可用', () => {
  const bare = { _h: undefined, _v: '', writes: 0, get innerHTML() { return this._v; }, set innerHTML(v) { this.writes += 1; this._v = v; } };
  const handle = mount(bare, { examples: EXAMPLES, note: NOTE });
  assert.equal(bare.writes, 1, '壳仍首绘');
  handle.update({ note: NOTE }); // 无 querySelector：子区打补丁安全跳过
  assert.equal(bare.writes, 1, '壳不重写');
  const headless = mount(null, {});
  assert.equal(typeof headless.update, 'function');
  headless.update({ examples: EXAMPLES }); // 不抛
});
