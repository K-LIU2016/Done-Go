// M13 验收页 + 追踪层 纯核/壳桩单测（RED 先行 · 实现前必红）
// 依据：BUILD-PLAN §2.3 TDD / §3 W5 小节（增量更新 + 键盘可达 + aria-live）；
//   PRD §5.6 验收与合入（L308-313：成品 + 证据区 + 版本；接受计入时间收益 /
//   要求修改（自然语言意见 → 新一轮 Run，保留旧版本）/ 拒绝（原因可选））、
//   §10.5 trace 的 span 约定（OTel GenAI 对齐：invoke_agent / execute_tool / chat /
//   donego.need / merge artifact）；
//   prototype.html（唯一视觉标准）L128-132（.artifact/.evidence/.gain/.trace 样式）、
//   L477-488（renderArt：未就绪文案 / h3+small+evidence / 已接受 gain /
//   接受(primary)·要求修改·拒绝 三操作）、L490-505（renderTrace：追踪层说明 + 等宽 pre）。
// 契约：web/agentic/ui/acceptance.js 具名导出
//   NOT_READY_TEXT / GAIN_HEAD / GAIN_TAIL / ACCEPT_TEXT / REVISE_TEXT / REJECT_TEXT /
//   REVISE_PLACEHOLDER / normalizeArtifact / gainTextOf / artifactInner / actionsHTML /
//   gainHTML / reviseFormHTML / verdictInner / reviseInner / ACCEPT_CSS / ensureStyles /
//   mount(el, { ready, artifact, accepted, gainText, onAccept, onRevise, onReject })
//   → { el, update(props) }（链式，合并语义）；
//   回调（tests/agentic/ui/acceptance.spec.ts 契约）：接受 → onAccept({ opinion: '' })、
//   要求修改（意见输入）→ onRevise({ opinion })、拒绝 → onReject()。
//   web/agentic/ui/trace-view.js 具名导出
//   TRACE_NOTE / SPAN_KINDS / normalizeTraceText / traceLines / spanKindOf / lineHTML /
//   traceInner / traceViewHTML / TRACE_CSS / ensureStyles /
//   mount(el, { traceText }) → { el, update(props) }。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as acc from '../../../../web/agentic/ui/acceptance.js';
import * as trace from '../../../../web/agentic/ui/trace-view.js';

const {
  NOT_READY_TEXT, GAIN_HEAD, GAIN_TAIL, ACCEPT_TEXT, REVISE_TEXT, REJECT_TEXT, REVISE_PLACEHOLDER,
  normalizeArtifact, gainTextOf, artifactInner, actionsHTML, gainHTML, reviseFormHTML,
  verdictInner, reviseInner, ACCEPT_CSS, ensureStyles, mount,
} = acc;
const {
  TRACE_NOTE, SPAN_KINDS, normalizeTraceText, traceLines, spanKindOf, lineHTML,
  traceInner, traceViewHTML, TRACE_CSS, ensureStyles: ensureTraceStyles, mount: traceMount,
} = trace;

const ARTIFACT = {
  title: '国内 K12 的 AI 教育：政策、课堂与教师准备度 · v1',
  meta: '3120 字 · 5 节 · 9 个引用',
  evidence: '证据：引用核验 9/9 通过（1 处数据曾不符，已修正并复核）',
};
const TRACE_TEXT = [
  'invoke_agent block  mission=m_r  13:30–14:58',
  '├─ invoke_agent researcher#1  order=wo_1',
  '│  ├─ execute_tool web.search  ✓ 11 results',
  '│  └─ chat deepseek-v4.1-flash-fast',
  '├─ donego.need n1  受众确认  waited 4m',
  '└─ merge artifact a_r v1  → ready',
].join('\n');

// ---------- A. acceptance 常量（prototype 原文） ----------

test('M13 常量：未就绪文案 / gain 首尾 / 三按钮 / 意见占位 = prototype L481/L487-488 原文', () => {
  assert.equal(NOT_READY_TEXT, '交付物完成后在这里验收：成品 + 证据 + 版本。只有你接受的交付，才计入「为你腾出的时间」。');
  assert.equal(GAIN_HEAD, '✓ 已接受 · 计入为你腾出的时间');
  assert.equal(GAIN_TAIL, '（按你过去同类任务实测）');
  assert.equal(ACCEPT_TEXT, '接受');
  assert.equal(REVISE_TEXT, '要求修改');
  assert.equal(REJECT_TEXT, '拒绝');
  assert.ok(REVISE_PLACEHOLDER.includes('保留'), '意见占位须传达「保留旧版本」语义（PRD §5.6）');
});

// ---------- B. acceptance 归一 ----------

test('M13 normalizeArtifact：{title,meta,evidence} 三字段归一；非对象一律空三栏；多余键忽略', () => {
  assert.deepEqual(normalizeArtifact(ARTIFACT), ARTIFACT);
  assert.deepEqual(normalizeArtifact({ title: '  t  ', meta: '', evidence: ' e ' }), { title: 't', meta: '', evidence: 'e' });
  assert.deepEqual(normalizeArtifact(undefined), { title: '', meta: '', evidence: '' });
  assert.deepEqual(normalizeArtifact(null), { title: '', meta: '', evidence: '' });
  assert.deepEqual(normalizeArtifact('r'), { title: '', meta: '', evidence: '' });
  assert.deepEqual(normalizeArtifact([1]), { title: '', meta: '', evidence: '' });
  assert.deepEqual(normalizeArtifact({ title: 42, meta: {}, evidence: true }), { title: '', meta: '', evidence: '' }, '非字符串字段丢弃');
  assert.deepEqual(normalizeArtifact({ title: 't', extra: 'drop' }), { title: 't', meta: '', evidence: '' });
});

test('M13 gainTextOf：非空串 trim 收下；空/缺省/非串归 \'\'（宁缺勿假，不编收益）', () => {
  assert.equal(gainTextOf('约 45 分钟'), '约 45 分钟');
  assert.equal(gainTextOf('  约 70 分钟  '), '约 70 分钟');
  assert.equal(gainTextOf(''), '');
  assert.equal(gainTextOf('   '), '');
  assert.equal(gainTextOf(undefined), '');
  assert.equal(gainTextOf(null), '');
  assert.equal(gainTextOf(45), '');
});

// ---------- C. acceptance 纯核：artifactInner ----------

test('M13 artifactInner 就绪：h3 标题 + p.small 规模 + .evidence 证据区（prototype L482-483 / PRD §5.6）', () => {
  const html = artifactInner({ ready: true, artifact: ARTIFACT });
  assert.ok(html.startsWith('<h3>'));
  assert.ok(html.includes(`<h3>${ARTIFACT.title}</h3>`));
  assert.ok(html.includes(`<p class="small">${ARTIFACT.meta}</p>`));
  assert.ok(html.includes(`<div class="evidence">${ARTIFACT.evidence}</div>`));
  assert.ok(html.indexOf('<h3>') < html.indexOf('<p class="small">'));
  assert.ok(html.indexOf('<p class="small">') < html.indexOf('<div class="evidence">'), '顺序：标题→规模→证据');
});

test('M13 artifactInner 未就绪：prototype L481 原文案（muted 段）', () => {
  assert.equal(artifactInner({ ready: false }), `<p class="muted">${NOT_READY_TEXT}</p>`);
  assert.equal(artifactInner({}), `<p class="muted">${NOT_READY_TEXT}</p>`, '缺省视为未就绪');
});

test('M13 artifactInner 宁缺勿假：空字段省略对应节点，不渲染空段/undefined', () => {
  const html = artifactInner({ ready: true, artifact: { title: '', meta: '', evidence: '' } });
  assert.equal(html, '');
  const onlyTitle = artifactInner({ ready: true, artifact: { title: 't' } });
  assert.equal(onlyTitle, '<h3>t</h3>');
  assert.ok(!html.includes('undefined'));
});

test('M13 artifactInner 转义：标题/规模/证据必经 esc（M01 XSS 基线）', () => {
  const html = artifactInner({
    ready: true,
    artifact: { title: '<img src=x onerror=1>', meta: 'a<b', evidence: '"e"&\'<i>\'' },
  });
  assert.ok(!html.includes('<img'), '注入串不得透传');
  assert.ok(html.includes('<h3>&lt;img src=x onerror=1&gt;</h3>'));
  assert.ok(html.includes('a&lt;b'));
  assert.ok(html.includes('&quot;e&quot;&amp;&#39;&lt;i&gt;&#39;'));
});

// ---------- D. acceptance 纯核：actionsHTML / gainHTML / reviseFormHTML ----------

test('M13 actionsHTML：接受(primary)/要求修改/拒绝(danger) 三按钮，type=button + data 钩（prototype L488）', () => {
  assert.equal(actionsHTML(),
    '<button type="button" class="btn primary" data-acc="1">接受</button>'
    + '<button type="button" class="btn" data-rev="1">要求修改</button>'
    + '<button type="button" class="btn danger" data-rej="1">拒绝</button>');
});

test('M13 gainHTML：✓ 已接受 · 计入为你腾出的时间 <gain>（按你过去同类任务实测）+ aria-live 播报（prototype L487）', () => {
  assert.equal(gainHTML({ gainText: '约 45 分钟' }),
    `<p class="gain" role="status" aria-live="polite">${GAIN_HEAD} 约 45 分钟${GAIN_TAIL}</p>`);
  assert.equal(gainHTML({}), `<p class="gain" role="status" aria-live="polite">${GAIN_HEAD}${GAIN_TAIL}</p>`, '缺省收益不编数字');
  assert.ok(gainHTML({ gainText: '"x"&1' }).includes('&quot;x&quot;&amp;1'), '收益文本转义');
});

test('M13 reviseFormHTML：意见 textarea（aria-label+占位含「保留」）+ data-confirm-revise / data-cancel-revise（spec 钩）', () => {
  const html = reviseFormHTML();
  assert.ok(html.includes('<textarea'), '意见输入为 textarea（自然语言意见，PRD §5.6）');
  assert.ok(/aria-label="[^"]*"/.test(html));
  assert.ok(html.includes(escHelper(REVISE_PLACEHOLDER)), '占位原文（转义后）');
  assert.ok(html.includes('data-confirm-revise="1"'));
  assert.ok(html.includes('data-cancel-revise="1"'));
  assert.equal([...html.matchAll(/<button/g)].length, 2);
  assert.ok(!html.includes('<button type="submit"'), '一律 type=button（不走原生表单提交）');
});

test('M13 verdictInner / reviseInner：未就绪空；已接受=收益；默认=三操作；意见表单仅 revising 且就绪未接受时在', () => {
  assert.equal(verdictInner({ ready: false, accepted: true }), '', '未就绪无裁决区');
  assert.equal(verdictInner({ ready: true, accepted: true, gainText: 'g' }), gainHTML({ gainText: 'g' }));
  assert.equal(verdictInner({ ready: true, accepted: false }), actionsHTML());
  assert.equal(reviseInner({ revising: true, ready: true, accepted: false }), reviseFormHTML());
  assert.equal(reviseInner({ revising: true, ready: false, accepted: false }), '');
  assert.equal(reviseInner({ revising: true, ready: true, accepted: true }), '');
  assert.equal(reviseInner({ revising: false, ready: true, accepted: false }), '');
});

function escHelper(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

// ---------- E. acceptanceHTML / ACCEPT_CSS / ensureStyles ----------

test('M13 acceptanceHTML：壳 = .artifact + .acts + .revise 三子区（mount 只写一次的骨架）', () => {
  const html = acc.acceptanceHTML({ ready: true, artifact: ARTIFACT, accepted: false, gainText: 'g' });
  assert.ok(html.includes('<div class="artifact" data-artifact="1">'));
  assert.ok(html.includes('<div class="acts" data-acts="1">'));
  assert.ok(html.includes('<div class="revise" data-revise="1">'));
  assert.ok(html.indexOf('data-artifact') < html.indexOf('data-acts'));
  assert.ok(html.indexOf('data-acts') < html.indexOf('data-revise'));
  assert.ok(html.includes('data-acc="1"'), '初始内容带三操作');
});

test('M13 ACCEPT_CSS：.artifact 网格 / .evidence 纸底 / .gain ok 色 / .acts flex 换行 / 意见输入 / 焦点 / reduced-motion（prototype L128-131）', () => {
  assert.ok(/\.artifact\s*{[^}]*display:\s*grid/.test(ACCEPT_CSS) && /gap:\s*10px/.test(ACCEPT_CSS));
  assert.ok(/\.evidence\s*{[^}]*background:\s*var\(--paper/.test(ACCEPT_CSS));
  assert.ok(/\.gain\s*{[^}]*color:\s*var\(--ok/.test(ACCEPT_CSS));
  assert.ok(/\.acts\s*{[^}]*flex-wrap:\s*wrap/.test(ACCEPT_CSS));
  assert.ok(/\.acts \.btn\.primary[^{]*{[^}]*var\(--accent/.test(ACCEPT_CSS), 'primary 主色');
  assert.ok(/\.acts \.btn\.danger\s*{[^}]*var\(--bad/.test(ACCEPT_CSS));
  assert.ok(/\.revise textarea\s*{/.test(ACCEPT_CSS));
  assert.ok(/:focus-visible/.test(ACCEPT_CSS), '键盘焦点可见');
  assert.ok(/\.revise:empty\s*{[^}]*display:\s*none/.test(ACCEPT_CSS));
  assert.ok(ACCEPT_CSS.includes('prefers-reduced-motion'), 'reduced-motion 降级');
});

test('M13 ensureStyles：幂等注入；无 doc 安全 false（M06/M07/M11 同款桩）', () => {
  const mkDoc = (tag) => {
    const doc = { _styles: [] };
    doc.querySelector = (sel) => (sel === `style[${tag}]` ? doc._styles[0] ?? null : null);
    doc.createElement = () => ({ _attrs: {}, textContent: '', setAttribute(k, v) { this._attrs[k] = String(v); } });
    doc.head = { appendChild: (n) => doc._styles.push(n) };
    return doc;
  };
  const doc = mkDoc('data-agentic-accept');
  assert.equal(ensureStyles(doc), true);
  assert.equal(doc._styles.length, 1);
  assert.ok(doc._styles[0].textContent.includes('.artifact'));
  assert.equal(ensureStyles(doc), false, '已注入不再重复');
  assert.equal(ensureStyles(null), false);
});

// ---------- F. acceptance DOM 壳（mount/update 增量 + 点击委托 + 意见流） ----------

function stubZone() {
  return { _h: undefined, _v: '', writes: 0, input: '', get innerHTML() { return this._v; }, set innerHTML(v) { this.writes += 1; this._v = v; } };
}

/** 宿主桩：innerHTML 写入即模拟浏览器重解析三子区（构造不计写）；.revise 区带意见输入值 */
function stubAccHost() {
  const artifact = stubZone();
  const acts = stubZone();
  const revise = stubZone();
  const host = {
    _h: undefined, _v: '', writes: 0, listeners: {},
    get innerHTML() { return this._v; },
    set innerHTML(v) {
      this.writes += 1; this._v = v;
      const a = v.match(/<div class="artifact"[^>]*>([\s\S]*?)<\/div>\s*<div class="acts"/);
      artifact._h = a ? a[1] : undefined; artifact._v = a ? a[1] : '';
      const c = v.match(/<div class="acts"[^>]*>([\s\S]*?)<\/div>\s*<div class="revise"/);
      acts._h = c ? c[1] : undefined; acts._v = c ? c[1] : '';
      const r = v.match(/<div class="revise"[^>]*>([\s\S]*?)<\/div>\s*$/);
      revise._h = r ? r[1] : undefined; revise._v = r ? r[1] : '';
    },
    querySelector(sel) {
      if (sel === '.artifact' || sel === '[data-artifact]') return artifact;
      if (sel === '.acts' || sel === '[data-acts]') return acts;
      if (sel === '.revise' || sel === '[data-revise]') return revise;
      return null;
    },
    addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); },
    fire(type, target) { for (const fn of this.listeners[type] ?? []) fn({ target }); },
  };
  revise.querySelector = (sel) => (sel.includes('textarea') || sel.includes('text') ? { get value() { return revise.input; }, set value(v) { revise.input = v; } } : null);
  return { host, artifact, acts, revise };
}

function stubTarget(dataset) {
  return {
    dataset,
    closest(sel) {
      const key = sel.replace(/^\[data-/, '').replace(/\]$/, '').replace(/-([a-z])/g, (m, c) => c.toUpperCase());
      return key in this.dataset ? this : null;
    },
  };
}

test('M13 mount 就绪：壳只写一次；三子区零额外写；handle 形状；按钮在 .acts 区', () => {
  const { host, artifact, acts, revise } = stubAccHost();
  const handle = mount(host, { ready: true, artifact: ARTIFACT, accepted: false, gainText: '约 45 分钟' });
  assert.equal(host.writes, 1, '壳首绘一次');
  assert.equal(artifact.writes, 0, 'artifact 子区内容未变不重写');
  assert.equal(acts.writes, 0, 'acts 子区内容未变不重写');
  assert.equal(revise.writes, 0, 'revise 子区空内容不重写');
  assert.ok(acts.innerHTML.includes('data-acc="1"'));
  assert.equal(handle.el, host);
  assert.equal(typeof handle.update, 'function');
});

test('M13 mount 未就绪：占位文案在 artifact 区（spec：#host 含「交付物完成后」）；update({ready,…}) 只打子区不重写壳', () => {
  const { host, artifact, acts, revise } = stubAccHost();
  const handle = mount(host, { ready: false });
  assert.ok(artifact.innerHTML.includes('交付物完成后'));
  assert.equal(acts.innerHTML, '');
  assert.equal(revise.innerHTML, '');
  handle.update({ ready: true, artifact: ARTIFACT, accepted: false });
  assert.equal(host.writes, 1, '壳不重写');
  assert.equal(artifact.writes, 1, 'artifact 区打补丁');
  assert.equal(acts.writes, 1, 'acts 区从空到三操作');
  assert.ok(artifact.innerHTML.includes(ARTIFACT.title));
  assert.ok(acts.innerHTML.includes('要求修改'));
});

test('M13 update({accepted,gainText})：只重写 .acts 区为 gain；artifact/revise 不动（增量约束）', () => {
  const { host, artifact, acts, revise } = stubAccHost();
  const handle = mount(host, { ready: true, artifact: ARTIFACT, accepted: false, gainText: '约 45 分钟' });
  handle.update({ accepted: true });
  assert.equal(host.writes, 1);
  assert.equal(artifact.writes, 0);
  assert.equal(revise.writes, 0);
  assert.equal(acts.writes, 1);
  assert.ok(acts.innerHTML.includes('✓ 已接受'));
  assert.ok(acts.innerHTML.includes('约 45 分钟'));
  handle.update({ accepted: true, gainText: '约 45 分钟' });
  assert.equal(acts.writes, 1, '同态同参内容比对跳过');
  handle.update({ accepted: false });
  assert.equal(acts.writes, 2, '退回未接受态重绘三操作');
  assert.ok(acts.innerHTML.includes('data-acc="1"'));
});

test('M13 update({artifact})：只重写 artifact 区；acts/revise 零写（证据区换内容）', () => {
  const { host, artifact, acts, revise } = stubAccHost();
  const handle = mount(host, { ready: true, artifact: ARTIFACT, accepted: false });
  handle.update({ artifact: { ...ARTIFACT, evidence: '证据：DoD 6/6 通过' } });
  assert.equal(artifact.writes, 1);
  assert.ok(artifact.innerHTML.includes('DoD 6/6 通过'));
  assert.ok(!artifact.innerHTML.includes('引用核验'), '旧证据替换');
  assert.equal(acts.writes, 0);
  assert.equal(revise.writes, 0);
  assert.equal(host.writes, 1, '壳恒一次');
});

test('M13 接受：onAccept({opinion:\'\'}) 恰此载荷（spec deepEqual 契约）', () => {
  const { host } = stubAccHost();
  const calls = [];
  mount(host, { ready: true, artifact: ARTIFACT, onAccept: (p) => calls.push(['accept', p]) });
  host.fire('click', stubTarget({ acc: '1' }));
  assert.deepEqual(calls, [['accept', { opinion: '' }]]);
});

test('M13 要求修改流：出意见输入 → 带意见 onRevise({opinion}) → 表单关闭（PRD §5.6 意见→新一轮 Run）', () => {
  const { host, revise, acts } = stubAccHost();
  const calls = [];
  mount(host, { ready: true, artifact: ARTIFACT, onRevise: (p) => calls.push(['revise', p]) });
  host.fire('click', stubTarget({ rev: '1' }));
  assert.equal(revise.writes, 1, '意见区展开一次');
  assert.ok(revise.innerHTML.includes('data-confirm-revise'));
  assert.equal(acts.writes, 0, '三操作不动');
  revise.input = '第 4 节再短一点';
  host.fire('click', stubTarget({ confirmRevise: '1' }));
  assert.deepEqual(calls, [['revise', { opinion: '第 4 节再短一点' }]], '恰 {opinion} 载荷（spec deepEqual）');
  assert.equal(revise.innerHTML, '', '提交后表单关闭');
});

test('M13 意见规整：trim；空/纯空白意见忽略不回调且表单保留', () => {
  const { host, revise } = stubAccHost();
  const calls = [];
  mount(host, { ready: true, artifact: ARTIFACT, onRevise: (p) => calls.push(['revise', p]) });
  host.fire('click', stubTarget({ rev: '1' }));
  revise.input = '  第 4 节再短一点  ';
  host.fire('click', stubTarget({ confirmRevise: '1' }));
  assert.deepEqual(calls, [['revise', { opinion: '第 4 节再短一点' }]], '意见 trim');
  host.fire('click', stubTarget({ rev: '1' }));
  revise.input = '';
  host.fire('click', stubTarget({ confirmRevise: '1' }));
  revise.input = '   ';
  host.fire('click', stubTarget({ confirmRevise: '1' }));
  assert.equal(calls.length, 1, '空意见零回调');
  assert.ok(revise.innerHTML.includes('data-confirm-revise'), '表单保留等待输入');
});

test('M13 取消意见：data-cancel-revise 关表单零回调；拒绝：onReject() 无参', () => {
  const { host, revise } = stubAccHost();
  const calls = [];
  mount(host, {
    ready: true, artifact: ARTIFACT,
    onRevise: (p) => calls.push(['revise', p]), onReject: () => calls.push(['reject']),
  });
  host.fire('click', stubTarget({ rev: '1' }));
  revise.input = 'x';
  host.fire('click', stubTarget({ cancelRevise: '1' }));
  assert.deepEqual(calls, []);
  assert.equal(revise.innerHTML, '', '取消即收起');
  host.fire('click', stubTarget({ rej: '1' }));
  assert.deepEqual(calls, [['reject']], 'onReject 无参（spec 契约）');
});

test('M13 点击委托边界：单监听；档外/无 closest/null target 不回调不抛', () => {
  const { host } = stubAccHost();
  const calls = [];
  mount(host, { ready: true, artifact: ARTIFACT, onAccept: () => calls.push(['a']), onReject: () => calls.push(['r']) });
  assert.equal((host.listeners.click ?? []).length, 1, '容器级单监听');
  host.fire('click', stubTarget({ tab: 'live' }));
  host.fire('click', { closest: () => null });
  host.fire('click', {});
  host.fire('click', null);
  assert.deepEqual(calls, []);
});

test('M13 update 合并语义：未传键不动旧值；空/非法 props 链式；回调非函数/后注入', () => {
  const { host, acts } = stubAccHost();
  const calls = [];
  const handle = mount(host, { ready: true, artifact: ARTIFACT, accepted: true, gainText: '约 45 分钟', onAccept: '不是函数' });
  const ret = handle.update({}).update(undefined).update(null);
  assert.equal(typeof ret.update, 'function');
  assert.equal(acts.writes, 0, '无键变化零重写');
  assert.ok(acts.innerHTML.includes('约 45 分钟'), 'accepted/gainText 保留');
  handle.update({ artifact: 'bogus' }); // 非对象 artifact 归一空三栏，不抛
  assert.ok(acts.innerHTML.includes('约 45 分钟'), 'artifact 换血不影响裁决区');
  handle.update({ onAccept: () => calls.push(['a']) });
  host.fire('click', stubTarget({ acc: '1' }));
  assert.deepEqual(calls, [['a']], '后注入回调生效');
  const silent = stubAccHost();
  mount(silent.host, { ready: true, artifact: ARTIFACT });
  silent.host.fire('click', stubTarget({ acc: '1' }));
  silent.host.fire('click', stubTarget({ rev: '1' }));
  silent.host.fire('click', stubTarget({ rej: '1' }));
  assert.ok(true, '未给回调不抛');
});

test('M13 宿主缺 addEventListener/querySelector 或 el=null：mount 不抛、链式可用', () => {
  const bare = stubZone();
  const handle = mount(bare, { ready: true, artifact: ARTIFACT, accepted: false });
  assert.equal(bare.writes, 1, '无委托仅渲染');
  handle.update({ accepted: true }); // 无 querySelector：子区打补丁安全跳过
  assert.equal(bare.writes, 1, '壳不重写（setHTML 内容比对）');
  const nullHandle = mount(null, { ready: true, artifact: ARTIFACT, accepted: true, gainText: 'g' });
  assert.equal(typeof nullHandle.update, 'function');
  nullHandle.update({ gainText: 'g2' }); // 不抛即过
});

// ---------- G. trace-view 常量与归一 ----------

test('M13 TRACE_NOTE = prototype L491 原文（给 JC / 开发者 · OTel GenAI 对齐声明）', () => {
  assert.equal(TRACE_NOTE, '追踪层（给 JC / 开发者）：span 命名对齐 OpenTelemetry GenAI；正文不进 span，按需展开。');
});

test('M13 SPAN_KINDS：覆盖 PRD §10.5 五类 OTel GenAI span 名', () => {
  assert.deepEqual(SPAN_KINDS, {
    'invoke_agent': 'agent',
    'execute_tool': 'tool',
    'chat': 'chat',
    'donego.need': 'need',
    'merge': 'merge',
  });
});

test('M13 normalizeTraceText：字符串原样收下（含首尾空白/空串）；非串归 \'\'', () => {
  assert.equal(normalizeTraceText(TRACE_TEXT), TRACE_TEXT);
  assert.equal(normalizeTraceText('  a\nb '), '  a\nb ');
  assert.equal(normalizeTraceText(''), '');
  assert.equal(normalizeTraceText(undefined), '');
  assert.equal(normalizeTraceText(null), '');
  assert.equal(normalizeTraceText(42), '');
});

test('M13 traceLines：按 \\n 切行；spanKindOf：树前缀后取 span 名（OTel GenAI）', () => {
  assert.deepEqual(traceLines('a\nb\nc'), ['a', 'b', 'c']);
  assert.deepEqual(traceLines(''), ['']);
  assert.equal(spanKindOf('invoke_agent block  mission=m_r'), 'agent');
  assert.equal(spanKindOf('├─ invoke_agent researcher#1  order=wo_1'), 'agent');
  assert.equal(spanKindOf('│  ├─ execute_tool web.search  ✓ 11 results'), 'tool');
  assert.equal(spanKindOf('│  └─ chat deepseek-v4.1-flash-fast'), 'chat');
  assert.equal(spanKindOf('├─ donego.need n1  受众确认  waited 4m'), 'need');
  assert.equal(spanKindOf('└─ merge artifact a_r v1  → ready'), 'merge');
  assert.equal(spanKindOf('随便一行'), '', '未知行不贴 kind');
  assert.equal(spanKindOf(''), '');
  assert.equal(spanKindOf(null), '');
});

// ---------- H. trace-view 纯核：lineHTML / traceInner / traceViewHTML ----------

test('M13 lineHTML：span.ln + data-ln 行号 + kind 类；正文整行 esc（正文不进 span 命名，按需展开）', () => {
  assert.equal(lineHTML('├─ invoke_agent researcher#1', 1), '<span class="ln k-agent" data-ln="1">├─ invoke_agent researcher#1</span>');
  assert.equal(lineHTML('随便一行', 0), '<span class="ln" data-ln="0">随便一行</span>');
  assert.ok(lineHTML('<img src=x>', 2).includes('&lt;img src=x&gt;'), '注入转义');
});

test('M13 traceInner：行 span 以 \\n 连接，剥标签后与原文逐字节相等（纯文本可复制，spec textContent 契约）', () => {
  const html = traceInner(TRACE_TEXT);
  assert.equal(html.replace(/<[^>]+>/g, ''), TRACE_TEXT, 'textContent === traceText');
  for (const needle of ['invoke_agent block', 'execute_tool web.search', 'chat ', 'donego.need n1', 'merge artifact']) {
    assert.ok(html.includes(needle), needle);
  }
  assert.equal((html.match(/<span class="ln/g) ?? []).length, 6, '一行一 span');
  assert.equal(traceInner(''), '<span class="ln" data-ln="0"></span>', '空文本安全');
});

test('M13 traceViewHTML：说明段 + .trace 容器（prototype L491-492 结构）', () => {
  const html = traceViewHTML({ traceText: TRACE_TEXT });
  assert.ok(html.includes(`<p class="small muted trace-note">${TRACE_NOTE}</p>`));
  assert.ok(html.includes('<div class="trace" data-trace="1">'));
  assert.ok(html.indexOf('trace-note') < html.indexOf('class="trace"'), '说明在前');
});

test('M13 TRACE_CSS：等宽 ui-monospace + white-space:pre + overflow-x:auto + token 兜底 + reduced-motion（prototype L132）', () => {
  assert.ok(/\.trace\s*{[^}]*ui-monospace/.test(TRACE_CSS));
  assert.ok(/\.trace\s*{[^}]*white-space:\s*pre/.test(TRACE_CSS));
  assert.ok(/\.trace\s*{[^}]*overflow-x:\s*auto/.test(TRACE_CSS));
  assert.ok(/\.trace\s*{[^}]*var\(--paper/.test(TRACE_CSS));
  assert.ok(TRACE_CSS.includes('prefers-reduced-motion'));
});

test('M13 trace ensureStyles：幂等注入（data-agentic-trace）；无 doc 安全 false', () => {
  const mkDoc = (tag) => {
    const doc = { _styles: [] };
    doc.querySelector = (sel) => (sel === `style[${tag}]` ? doc._styles[0] ?? null : null);
    doc.createElement = () => ({ _attrs: {}, textContent: '', setAttribute(k, v) { this._attrs[k] = String(v); } });
    doc.head = { appendChild: (n) => doc._styles.push(n) };
    return doc;
  };
  const doc = mkDoc('data-agentic-trace');
  assert.equal(ensureTraceStyles(doc), true);
  assert.ok(doc._styles[0].textContent.includes('.trace'));
  assert.equal(ensureTraceStyles(doc), false);
  assert.equal(ensureTraceStyles(null), false);
});

// ---------- I. trace-view DOM 壳 ----------

function stubTraceHost() {
  const traceZone = stubZone();
  const host = {
    _h: undefined, _v: '', writes: 0, listeners: {},
    get innerHTML() { return this._v; },
    set innerHTML(v) {
      this.writes += 1; this._v = v;
      const m = v.match(/<div class="trace"[^>]*>([\s\S]*)<\/div>\s*$/);
      traceZone._h = m ? m[1] : undefined; traceZone._v = m ? m[1] : '';
    },
    querySelector(sel) {
      if (sel === '.trace' || sel === '[data-trace]') return traceZone;
      return null;
    },
    addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); },
  };
  return { host, traceZone };
}

test('M13 trace mount：壳只写一次；.trace 子区零额外写；update 换文本只打 .trace 区', () => {
  const { host, traceZone } = stubTraceHost();
  const handle = traceMount(host, { traceText: TRACE_TEXT });
  assert.equal(host.writes, 1, '壳首绘一次');
  assert.equal(traceZone.writes, 0, '内容未变零写');
  assert.ok(traceZone.innerHTML.includes('invoke_agent block'));
  assert.equal(handle.el, host);
  handle.update({ traceText: '└─ merge artifact a_x v2  → ready' });
  assert.equal(host.writes, 1, '壳不重写');
  assert.equal(traceZone.writes, 1, '只打 .trace 子区');
  assert.ok(traceZone.innerHTML.includes('a_x v2'));
  handle.update({ traceText: '└─ merge artifact a_x v2  → ready' });
  assert.equal(traceZone.writes, 1, '同内容比对跳过');
  handle.update(undefined).update({});
  assert.equal(traceZone.writes, 1, '空/非法 props 容忍且链式');
  const bare = stubZone();
  traceMount(bare, { traceText: TRACE_TEXT });
  assert.equal(bare.writes, 1);
  const nullHandle = traceMount(null, { traceText: TRACE_TEXT });
  nullHandle.update({ traceText: 'x' }); // 不抛即过
});
