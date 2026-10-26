// M16 「📷 拍一下」入口 + 建议卡（快→深升级）单测（RED 先行 · 实现前必红）
// 依据：plan.md M16、PRD §6.8.2 感知流水线（L485-496：快感知 qwen3.5-omni-flash 约 1.5s
//   一句话"看到了什么"即时卡 → 深感知 qwen3-vl-plus 约 6s 变化/风险/建议原地升级同一张卡；
//   ContextDelta {blockId, seen, change, risk, evidence(imageRef)}；建议卡 = 建议文本 +
//   动作按钮）、§5.2 原型实测教训（L275 整块重绘丢状态 → 增量硬约束）；
//   prototype.html（唯一视觉标准）L175-184（.capture/.capcard 120px 1fr 栅格 + 左 4px
//   --k-explore 边 / .deep 转左 --ok / img 120×90 / .lv 12px / .acts 按钮组 / ≤560px 单列
//   + img 全宽 4:3 / reduced-motion 禁动画）、L383-392（captureHTML 原文：入口行「现场感知」
//   +「做的时候随手拍一下，我按你的进度给下一步」+「📷 拍一下（示例：进度照）」；快卡
//   .lv「即时 · qwen3.5-omni-flash 1.5s · 深度分析中…」+「看到：…」；深卡 .lv「已升级 ·
//   qwen3-vl-plus 6.0s」+ change <b> +「建议：…」+ .acts 三钮）、L586-589（startCapture：
//   快卡即出、4.5s 后原地升深卡）、L625-626（data-capture→startCapture 委托 / data-capact→
//   capNote '✓ '+三消息原文）。
// 契约：web/agentic/ui/capture-card.js 具名导出
//   CAPTURE_TITLE / CAPTURE_HINT / CAPTURE_BTN / IMG_ALT_DEFAULT / SEEN_PREFIX /
//   RISK_PREFIX / SUGGEST_PREFIX / ANALYZING_NOTE / QUICK_TAG / DEEP_TAG /
//   QUICK_MODEL / QUICK_MS / DEEP_MODEL / DEEP_MS / DEFAULT_ACTIONS / ACTION_FEEDBACK /
//   SAFE_IMAGE / safeImage / normalizeActions / normalizeCard / levelLine / actionsHTML /
//   bodyHTML / imgHTML / cardInner / cardHTML / entryHTML / captureShellHTML /
//   feedbackText / CAPTURE_CSS / ensureStyles /
//   mount(el, { card, onCapture, onAction }) → { el, update(props) }
//   card = PRD §6.8.2 ContextDelta 形状 + 展示字段：
//   { phase: 'quick'|'deep', blockId, seen, change?, risk?, suggestion?,
//     evidence: { imageRef, alt? }, model, ms, actions?, messages? }
// 增量硬约束（spec「快→深同卡原地升级不重建」）：.capcard 节点跨 update 存活——
//   card 出现/消失/换照片才建/删/重建卡节点；同照片 quick↔deep 只切 .deep 类 +
//   重灌卡内文字容器（wrapper）；同内容 update 零写（内容比对跳过）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CAPTURE_TITLE, CAPTURE_HINT, CAPTURE_BTN, IMG_ALT_DEFAULT,
  SEEN_PREFIX, RISK_PREFIX, SUGGEST_PREFIX, ANALYZING_NOTE, QUICK_TAG, DEEP_TAG,
  QUICK_MODEL, QUICK_MS, DEEP_MODEL, DEEP_MS,
  DEFAULT_ACTIONS, ACTION_FEEDBACK, SAFE_IMAGE, safeImage,
  normalizeActions, normalizeCard, levelLine, actionsHTML, bodyHTML, imgHTML,
  cardInner, cardHTML, entryHTML, captureShellHTML, feedbackText,
  CAPTURE_CSS, ensureStyles, esc, setHTML, mount,
} from '../../../../web/agentic/ui/capture-card.js';

// 与 spec（tests/agentic/ui/capture-card.spec.ts）同款 fixtures —— 契约对齐
const QUICK = {
  phase: 'quick', blockId: 'b', seen: '正在按说明书组装书架，胶水和螺丝已就位。',
  evidence: { imageRef: 'assets/photo-craft.jpg' }, model: 'qwen3.5-omni-flash', ms: '1.5s',
};
const DEEP = {
  phase: 'deep', blockId: 'b',
  seen: '正在按说明书组装书架，胶水和螺丝已就位。',
  change: '隔板已上胶，但胶水溢出、没用夹具固定，可能会不平。',
  risk: '隔板不平会影响成品',
  suggestion: '用湿布擦掉多余胶水 → 直尺检查水平 → 夹子固定 15 分钟再拧螺丝。',
  evidence: { imageRef: 'assets/photo-craft.jpg' }, model: 'qwen3-vl-plus', ms: '6.0s',
};

// ---------- A. 常量（prototype 原文） ----------

test('A1 入口行三段文案 + img 默认 alt（prototype L391/L386 原文）', () => {
  assert.equal(CAPTURE_TITLE, '现场感知');
  assert.equal(CAPTURE_HINT, '做的时候随手拍一下，我按你的进度给下一步');
  assert.equal(CAPTURE_BTN, '📷 拍一下（示例：进度照）');
  assert.equal(IMG_ALT_DEFAULT, '你拍的书架进度照');
});

test('A2 .lv 两态文案 + 三前缀 + 深度分析中提示（prototype L387-388 原文）', () => {
  assert.equal(QUICK_TAG, '即时');
  assert.equal(DEEP_TAG, '已升级');
  assert.equal(ANALYZING_NOTE, '深度分析中…');
  assert.equal(SEEN_PREFIX, '看到：');
  assert.equal(RISK_PREFIX, '风险：');
  assert.equal(SUGGEST_PREFIX, '建议：');
});

test('A3 快/深默认 model+ms（PRD §6.8.2：1.5s 快路 / 6.0s 深路）', () => {
  assert.equal(QUICK_MODEL, 'qwen3.5-omni-flash');
  assert.equal(QUICK_MS, '1.5s');
  assert.equal(DEEP_MODEL, 'qwen3-vl-plus');
  assert.equal(DEEP_MS, '6.0s');
});

test('A4 DEFAULT_ACTIONS 三动作序 = spec 点击序 timer|step|note（prototype L389 原文）', () => {
  assert.deepEqual(DEFAULT_ACTIONS, [
    { act: 'timer', label: '⏱ 15 分钟后提醒我' },
    { act: 'step', label: '步骤卡跳到第 4 步' },
    { act: 'note', label: '记下来' },
  ]);
});

test('A5 ACTION_FEEDBACK 三消息原文（prototype L626）', () => {
  assert.equal(ACTION_FEEDBACK.timer, '已设 21:32 提醒：胶水初固，可以拧螺丝了');
  assert.equal(ACTION_FEEDBACK.step, '步骤卡已跳到第 4 步：拧紧隔板螺丝（先对角、再其余）');
  assert.equal(ACTION_FEEDBACK.note, '已记下：第 3 步胶水溢出，下次少涂一点');
});

// ---------- B. 白名单与归一 ----------

test('B1 SAFE_IMAGE/safeImage：相对路径白名单（M04/M07 SAFE_MEDIA 同规则）', () => {
  assert.equal(safeImage('assets/photo-craft.jpg'), 'assets/photo-craft.jpg');
  assert.equal(safeImage('a.b/C-d_e.png'), 'a.b/C-d_e.png');
  for (const bad of ['', 'http://x/a.jpg', 'https://x/a.jpg', '//x/a.jpg', '/abs/a.jpg',
    '../up/a.jpg', 'a/../b.jpg', 'a b.jpg', 'javascript:alert(1)', 'data:image/png;base64,x']) {
    assert.equal(safeImage(bad), '', `应拒绝：${bad}`);
    assert.ok(!SAFE_IMAGE.test(bad) || bad.includes('..'), `规则应不匹配：${bad}`);
  }
  assert.equal(safeImage(null), '');
  assert.equal(safeImage(123), '');
  assert.equal(safeImage({}), '');
});

test('B2 normalizeActions：合法保留 / 项级过滤 / 非数组或空 → null（回落默认）', () => {
  assert.equal(normalizeActions(null), null);
  assert.equal(normalizeActions('x'), null);
  assert.equal(normalizeActions([]), null);
  assert.deepEqual(normalizeActions([{ act: 'todo', label: '加待办' }]), [{ act: 'todo', label: '加待办' }]);
  assert.deepEqual(
    normalizeActions([{ act: 'ok', label: 'A' }, null, { act: '', label: 'B' }, { act: 'x' }, { label: 'C' }, 's', { act: ' m ', label: ' M' }]),
    [{ act: 'ok', label: 'A' }, { act: 'm', label: ' M' }],  // act 去空白，label 原样保留
  );
});

test('B3 normalizeCard：null/数组/字符串 → null', () => {
  assert.equal(normalizeCard(null), null);
  assert.equal(normalizeCard(undefined), null);
  assert.equal(normalizeCard([]), null);
  assert.equal(normalizeCard('quick'), null);
  assert.equal(normalizeCard(0), null);
});

test('B4 normalizeCard：quick 默认补全 + 字段直通（PRD §6.8.2 ContextDelta）', () => {
  const c = normalizeCard({ blockId: 'b', seen: 's', evidence: { imageRef: 'assets/a.jpg' } });
  assert.equal(c.phase, 'quick');
  assert.equal(c.blockId, 'b');
  assert.equal(c.seen, 's');
  assert.equal(c.imageRef, 'assets/a.jpg');
  assert.equal(c.imageAlt, IMG_ALT_DEFAULT);
  assert.equal(c.model, QUICK_MODEL);
  assert.equal(c.ms, QUICK_MS);
  assert.deepEqual(c.actions, DEFAULT_ACTIONS);
  assert.equal(c.messages, null);
  assert.equal(c.change, '');
  assert.equal(c.risk, '');
  assert.equal(c.suggestion, '');
});

test('B5 normalizeCard：deep 默认补全 + evidence.alt / messages / actions 覆盖 + blockId 数字转串', () => {
  const c = normalizeCard({
    phase: 'deep', blockId: 7, change: 'c', suggestion: 'g',
    evidence: { imageRef: 'assets/a.jpg', alt: '现场照' },
    actions: [{ act: 'todo', label: '加待办' }],
    messages: { todo: '已加入待办' },
  });
  assert.equal(c.phase, 'deep');
  assert.equal(c.blockId, '7');
  assert.equal(c.model, DEEP_MODEL);
  assert.equal(c.ms, DEEP_MS);
  assert.equal(c.imageAlt, '现场照');
  assert.deepEqual(c.actions, [{ act: 'todo', label: '加待办' }]);
  assert.deepEqual(c.messages, { todo: '已加入待办' });
});

test('B6 normalizeCard：phase 仅认 deep，其余一律 quick；evidence 非对象/缺 imageRef → 图剔除', () => {
  assert.equal(normalizeCard({ phase: 'DEEP' }).phase, 'quick');
  assert.equal(normalizeCard({ phase: 2 }).phase, 'quick');
  const a = normalizeCard({ evidence: 'assets/a.jpg' });
  assert.equal(a.imageRef, '');
  assert.equal(a.imageAlt, IMG_ALT_DEFAULT);
  const b = normalizeCard({ evidence: { imageRef: 'http://evil/x.jpg' } });
  assert.equal(b.imageRef, '', '白名单外整段丢弃（宁缺勿假）');
  assert.equal(normalizeCard({ blockId: null }).blockId, '');
});

test('B7 normalizeCard 幂等：已归一形态（imageRef/imageAlt 顶层）再入不丢字段', () => {
  const once = normalizeCard(QUICK);
  const twice = normalizeCard(once);
  assert.equal(twice.imageRef, once.imageRef);
  assert.equal(twice.imageAlt, once.imageAlt);
  assert.equal(twice.phase, once.phase);
  assert.equal(cardHTML(twice), cardHTML(once), '壳/纯核双归一路径同串');
});

// ---------- C. 纯核 HTML ----------

test('C1 levelLine：快/深两态精确串（prototype L387-388 原文）', () => {
  assert.equal(levelLine(normalizeCard(QUICK)), '即时 · qwen3.5-omni-flash 1.5s · 深度分析中…');
  assert.equal(levelLine(normalizeCard(DEEP)), '已升级 · qwen3-vl-plus 6.0s');
});

test('C2 levelLine：model/ms 经 esc（五实体）', () => {
  const c = normalizeCard({ phase: 'quick', model: '<b>&"', ms: '1<2' });
  assert.equal(levelLine(c), '即时 · &lt;b&gt;&amp;&quot; 1&lt;2 · 深度分析中…');
});

test('C3 bodyHTML quick = 「看到：seen」一句话（prototype L388）', () => {
  assert.equal(bodyHTML(normalizeCard(QUICK)), '<b>看到：正在按说明书组装书架，胶水和螺丝已就位。</b>');
});

test('C4 bodyHTML deep = change + 风险行 + 建议（margin-top:4px 原文）+ 三动作组', () => {
  assert.equal(
    bodyHTML(normalizeCard(DEEP)),
    '<b>隔板已上胶，但胶水溢出、没用夹具固定，可能会不平。</b>'
    + '<div class="small">风险：隔板不平会影响成品</div>'
    + '<div class="small" style="margin-top:4px">建议：用湿布擦掉多余胶水 → 直尺检查水平 → 夹子固定 15 分钟再拧螺丝。</div>'
    + '<div class="acts">'
    + '<button class="btn" data-capact="timer">⏱ 15 分钟后提醒我</button>'
    + '<button class="btn" data-capact="step">步骤卡跳到第 4 步</button>'
    + '<button class="btn" data-capact="note">记下来</button>'
    + '</div>',
  );
});

test('C5 bodyHTML deep 无 risk → 无风险行；自定义 actions 直通', () => {
  const h = bodyHTML(normalizeCard({ phase: 'deep', change: 'c', suggestion: 's', actions: [{ act: 'todo', label: '加待办' }] }));
  assert.ok(!h.includes('风险'), 'risk 缺省不渲染空行');
  assert.ok(h.includes('data-capact="todo">加待办</button>'));
});

test('C6 actionsHTML：空数组 → 空组；act/label 均经 esc', () => {
  assert.equal(actionsHTML([]), '');
  const h = actionsHTML([{ act: 'a"><x', label: '<img src=x onerror=1>' }]);
  assert.equal(h, '<button class="btn" data-capact="a&quot;&gt;&lt;x">&lt;img src=x onerror=1&gt;</button>');
});

test('C7 imgHTML：白名单内 img + alt；无/unsafe imageRef → 空串（宁缺勿假）', () => {
  assert.equal(imgHTML(normalizeCard(QUICK)), '<img src="assets/photo-craft.jpg" alt="你拍的书架进度照">');
  assert.equal(imgHTML(normalizeCard({ evidence: { imageRef: 'javascript:x' } })), '');
  assert.equal(imgHTML(normalizeCard({})), '');
  assert.equal(imgHTML(normalizeCard({ evidence: { imageRef: 'assets/a.jpg', alt: 'A&B"' } })),
    '<img src="assets/a.jpg" alt="A&amp;B&quot;">');
});

test('C8 cardInner = .lv 行 + body；cardHTML 外壳 aria-live=polite + deep 类切换（prototype L386-389）', () => {
  const q = normalizeCard(QUICK);
  assert.equal(cardInner(q), '<div class="lv">即时 · qwen3.5-omni-flash 1.5s · 深度分析中…</div><b>看到：正在按说明书组装书架，胶水和螺丝已就位。</b>');
  assert.equal(
    cardHTML(q),
    '<div class="capcard" aria-live="polite" role="status">'
    + '<img src="assets/photo-craft.jpg" alt="你拍的书架进度照">'
    + '<div><div class="lv">即时 · qwen3.5-omni-flash 1.5s · 深度分析中…</div><b>看到：正在按说明书组装书架，胶水和螺丝已就位。</b></div>'
    + '</div>',
  );
  const d = normalizeCard(DEEP);
  assert.ok(cardHTML(d).startsWith('<div class="capcard deep" aria-live="polite" role="status">'));
  assert.ok(cardHTML(d).includes('data-capact="timer"'));
});

test('C9 cardHTML 无图深卡：卡仍在、无 img 节点（unsafe/缺 imageRef 不炸）', () => {
  const h = cardHTML(normalizeCard({ phase: 'deep', change: 'c', suggestion: 's' }));
  assert.ok(h.startsWith('<div class="capcard deep"'));
  assert.ok(!h.includes('<img'));
});

test('C10 entryHTML：标题 + 说明 + spacer + 📷 按钮 data-capture（prototype L391）', () => {
  assert.equal(
    entryHTML(),
    '<div class="caprow"><b>现场感知</b>'
    + '<span class="small muted">做的时候随手拍一下，我按你的进度给下一步</span>'
    + '<span class="spacer"></span>'
    + '<button class="btn" data-capture="1">📷 拍一下（示例：进度照）</button></div>',
  );
});

test('C11 captureShellHTML：.capture 壳 = 入口行 + .cap-slot + .cap-note；card null → 槽空', () => {
  const bare = captureShellHTML(null);
  assert.ok(bare.startsWith('<div class="capture">'));
  assert.ok(bare.includes(entryHTML()));
  assert.ok(bare.includes('<div class="cap-slot"></div>'));
  assert.ok(bare.endsWith('<p class="small muted cap-note"></p></div>'));
  assert.ok(!bare.includes('capcard'));
  const withCard = captureShellHTML(QUICK);
  assert.ok(withCard.includes('<div class="capcard" aria-live="polite" role="status">'));
});

test('C12 captureShellHTML 收原始 card 对象（归一在内部完成）', () => {
  assert.equal(captureShellHTML(undefined), captureShellHTML(null));
  assert.ok(captureShellHTML({ phase: 'deep', change: 'c', suggestion: 's' }).includes('capcard deep'));
});

test('C13 feedbackText：✓ + 三默认消息；messages 覆盖；未知 act 兜底（prototype L626）', () => {
  assert.equal(feedbackText('timer', null), '✓ 已设 21:32 提醒：胶水初固，可以拧螺丝了');
  assert.equal(feedbackText('note', { note: '已记下：少涂胶' }), '✓ 已记下：少涂胶');
  assert.ok(feedbackText('todo', { x: 1 }).startsWith('✓ '));
});

test('C14 CAPTURE_CSS：prototype L176-184 原文要点 + 升级动画 + rm 禁动画 + focus-visible', () => {
  assert.ok(CAPTURE_CSS.includes('.capcard { display: grid; grid-template-columns: 120px 1fr; gap: 12px;'));
  assert.ok(CAPTURE_CSS.includes('border-left: 4px solid var(--k-explore'));
  assert.ok(CAPTURE_CSS.includes('.capcard.deep { border-left-color: var(--ok'));
  assert.ok(CAPTURE_CSS.includes('.capcard img { width: 120px; height: 90px; object-fit: cover;'));
  assert.ok(CAPTURE_CSS.includes('.capcard .lv { font-size: 12px;'));
  assert.ok(CAPTURE_CSS.includes('.capcard .acts { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 6px; }'));
  assert.ok(/@media \(max-width: 560px\)/.test(CAPTURE_CSS));
  assert.ok(CAPTURE_CSS.includes('.capcard { grid-template-columns: 1fr; }'));
  assert.ok(CAPTURE_CSS.includes('aspect-ratio: 4/3'));
  assert.ok(/@keyframes capup/.test(CAPTURE_CSS), '升级动画 keyframes');
  assert.ok(/@media \(prefers-reduced-motion: reduce\)/.test(CAPTURE_CSS));
  assert.ok(/animation: none !important/.test(CAPTURE_CSS), 'rm 直接切换：禁动画');
  assert.ok(CAPTURE_CSS.includes(':focus-visible'));
});

test('C15 ensureStyles：幂等注入；无 DOM 环境安全 false', () => {
  assert.equal(ensureStyles(null), false);
  assert.equal(ensureStyles(undefined), false);
  const styles = [];
  const doc = {
    querySelector: (sel) => (styles.length && sel === 'style[data-agentic-capture]' ? {} : null),
    createElement: () => ({ setAttribute() {}, textContent: '' }),
    head: { appendChild: (st) => styles.push(st) },
  };
  assert.equal(ensureStyles(doc), true);
  assert.equal(styles.length, 1);
  assert.equal(ensureStyles(doc), false, '已注入即幂等跳过');
  assert.equal(styles.length, 1);
});

test('C16 esc/setHTML 兜底：五实体 + 内容比对跳过重写（M01 未落地本地兜底）', () => {
  assert.equal(esc('<b class="x">&"\''), '&lt;b class=&quot;x&quot;&gt;&amp;&quot;&#39;');
  const el = { _h: undefined, _v: '', n: 0 };
  Object.defineProperty(el, 'innerHTML', {
    get() { return this._v; },
    set(v) { this.n += 1; this._v = v; },
  });
  assert.equal(setHTML(el, '<i>a</i>'), true);
  assert.equal(el.n, 1);
  assert.equal(setHTML(el, '<i>a</i>'), false, '同内容跳过');
  assert.equal(el.n, 1);
  assert.equal(setHTML(null, 'x'), false);
});

// ---------- D. 壳：mount / update（fake-DOM 桩，白盒同 M10/M12/M14 模式） ----------

function mkCardStub(html) {
  const inner = /<div>([\s\S]*)<\/div><\/div>$/.exec(html)?.[1] ?? '';
  const card = {
    className: /class="capcard deep"/.test(html) ? 'capcard deep' : 'capcard',
    style: { animation: '', transition: '' },
    toggles: [],
    wrapper: {
      _v: inner, writes: 0,
      get innerHTML() { return this._v; },
      set innerHTML(v) { this.writes += 1; this._v = v; },
    },
    querySelector(sel) { return sel === 'div' ? this.wrapper : null; },
  };
  card.classList = {
    toggle(c, force) {
      const parts = card.className.split(/\s+/).filter(Boolean);
      const has = parts.includes(c);
      const on = force === undefined ? !has : !!force;
      const i = parts.indexOf(c);
      if (on && i < 0) parts.push(c);
      if (!on && i >= 0) parts.splice(i, 1);
      card.className = parts.join(' ');
      card.toggles.push([c, force, on]);
      return on;
    },
    contains: (c) => card.className.split(/\s+/).includes(c),
  };
  return card;
}

function mkSlotStub() {
  const slot = {
    _v: '', writes: 0, card: null,
    get innerHTML() { return this._v; },
    set innerHTML(v) {
      this.writes += 1; this._v = v;
      this.card = /class="capcard/.test(v) ? mkCardStub(v) : null;
    },
    querySelector(sel) { return sel === '.capcard' ? this.card : null; },
  };
  return slot;
}

function mkMq(matches) {
  return {
    matches, _f: null,
    addEventListener(t, f) { this._f = f; },
    removeEventListener() { this._f = null; },
    fire() { if (this._f) this._f(); },
  };
}

function stubHost(opts = {}) {
  const mq = opts.mq ?? null;
  const doc = {
    _styles: [],
    querySelector() { return null; },
    createElement: () => ({ setAttribute() {}, textContent: '' }),
    head: { appendChild: (st) => doc._styles.push(st) },
    defaultView: mq ? { matchMedia: () => mq } : (opts.win ?? {}),
  };
  const host = {
    _v: '', writes: 0, listeners: {}, slot: null, note: null, ownerDocument: doc,
    get innerHTML() { return this._v; },
    set innerHTML(v) {
      this.writes += 1; this._v = v;
      this.slot = mkSlotStub();
      const cm = /<div class="cap-slot">([\s\S]*?)<\/div><p/.exec(v);
      if (cm) this.slot.innerHTML = cm[1];
      this.note = { textContent: '' };
    },
    querySelector(sel) {
      if (sel === '.cap-slot') return this.slot;
      if (sel === '.cap-note') return this.note;
      if (sel === '.capcard') return this.slot ? this.slot.card : null;
      return null;
    },
    addEventListener(t, f) { (this.listeners[t] ??= []).push(f); },
    contains: () => true,
  };
  return { host, doc };
}

const ALL_BTN = 'button[data-capture], button[data-capact]';
function clickBtn(host, stub) {
  const ev = { target: { closest: (sel) => (sel === ALL_BTN ? stub : null) } };
  (host.listeners.click ?? []).forEach((fn) => fn(ev));
}

test('D1 mount card=null：一次整写壳，入口行在、槽空；handle 契约 + 链式', () => {
  const { host } = stubHost();
  const h = mount(host, { card: null, onCapture() {}, onAction() {} });
  assert.equal(host.writes, 1, '壳只首绘写一次');
  assert.ok(host.innerHTML.includes('<b>现场感知</b>'));
  assert.ok(host.innerHTML.includes('📷 拍一下（示例：进度照）'));
  assert.equal(host.slot.card, null, 'card null → 无卡');
  assert.equal(h.el, host);
  assert.equal(h.update({}), h, 'update 链式返回 handle');
});

test('D2 mount QUICK：槽 = 纯核 cardHTML 精确串（壳/纯核一致）', () => {
  const { host } = stubHost();
  mount(host, { card: QUICK });
  assert.equal(host.slot.innerHTML, cardHTML(normalizeCard(QUICK)));
  assert.ok(host.slot.card.wrapper.innerHTML.includes('即时 · qwen3.5-omni-flash 1.5s · 深度分析中…'));
});

test('D3 📷 点击 → onCapture 恰一次；非按钮/无 data → 零回调', () => {
  const { host } = stubHost();
  const calls = [];
  mount(host, { card: null, onCapture: () => calls.push(['capture']) });
  clickBtn(host, { dataset: { capture: '1' } });
  clickBtn(host, { dataset: {} });
  clickBtn(host, { dataset: { other: '1' } });
  assert.deepEqual(calls, [['capture']]);
});

test('D4 深卡三动作点击 → onAction timer|step|note 序 + capNote ✓ 消息（prototype L626）', () => {
  const { host } = stubHost();
  const calls = [];
  mount(host, { card: DEEP, onAction: (a) => calls.push(a) });
  for (const act of ['timer', 'step', 'note']) clickBtn(host, { dataset: { capact: act } });
  assert.deepEqual(calls, ['timer', 'step', 'note']);
  assert.equal(host.note.textContent, '✓ 已记下：第 3 步胶水溢出，下次少涂一点', '末次动作消息');
});

test('D5 messages 覆盖反馈；无 onAction 回调仍写 capNote；无 card 点击动作不炸', () => {
  const { host } = stubHost();
  mount(host, { card: { ...DEEP, messages: { note: '已记下：少涂胶' } } });
  clickBtn(host, { dataset: { capact: 'note' } });
  assert.equal(host.note.textContent, '✓ 已记下：少涂胶');
  const { host: h2 } = stubHost();
  mount(h2, { card: null });
  clickBtn(h2, { dataset: { capact: 'timer' } });
  assert.equal(h2.note.textContent, '✓ 已设 21:32 提醒：胶水初固，可以拧螺丝了', '默认消息兜底');
});

test('D6 同内容 update：卡节点不重建 + wrapper 零写 + 类零拨（data-marker 存活语义）', () => {
  const { host } = stubHost();
  const h = mount(host, { card: QUICK });
  const card = host.slot.card;
  host.slot.writes = 0; card.wrapper.writes = 0; card.toggles.length = 0;
  h.update({ card: JSON.parse(JSON.stringify(QUICK)) });
  assert.equal(host.slot.writes, 0, '槽不重写');
  assert.equal(card.wrapper.writes, 0, '同内容跳过（内容比对）');
  assert.equal(card.toggles.length, 0, '类不变不拨');
  assert.equal(host.slot.card, card, '同一卡节点对象（未重建）');
  assert.equal(card.className, 'capcard');
});

test('D7 quick→deep 同卡原地升级：节点保活 + deep 类 + wrapper 重灌一次（DAG M16）', () => {
  const { host } = stubHost();
  const h = mount(host, { card: QUICK });
  const card = host.slot.card;
  h.update({ card: DEEP });
  assert.equal(host.slot.card, card, '升级不重建卡节点');
  assert.equal(card.className, 'capcard deep');
  assert.deepEqual(card.toggles.at(-1), ['deep', true, true]);
  assert.equal(card.wrapper.writes, 1, '卡内文字容器只重灌一次');
  assert.equal(card.wrapper.innerHTML, cardInner(normalizeCard(DEEP)), '与纯核一致');
  assert.ok(card.wrapper.innerHTML.includes('data-capact="timer"'));
});

test('D8 deep→quick 回退：同节点去 deep 类 + 回退内容', () => {
  const { host } = stubHost();
  const h = mount(host, { card: DEEP });
  const card = host.slot.card;
  h.update({ card: QUICK });
  assert.equal(host.slot.card, card);
  assert.equal(card.className, 'capcard');
  assert.ok(!card.wrapper.innerHTML.includes('data-capact'), '动作组随深态消失');
});

test('D9 null→有卡→null：出现建卡、消失清槽', () => {
  const { host } = stubHost();
  const h = mount(host, { card: null });
  h.update({ card: QUICK });
  assert.ok(host.slot.card, 'null→有：建卡');
  h.update({ card: DEEP });
  const card = host.slot.card;
  h.update({ card: null });
  assert.equal(host.slot.card, null, '有→null：清槽');
  assert.equal(host.slot.innerHTML, '');
  h.update({ card: DEEP });
  assert.notEqual(host.slot.card, card, '重出现 = 新卡节点');
});

test('D10 换照片（imageRef 变）→ 槽重建成新卡；同照片改文案不重建', () => {
  const { host } = stubHost();
  const h = mount(host, { card: QUICK });
  const card = host.slot.card;
  h.update({ card: { ...DEEP, evidence: { imageRef: 'assets/photo-whiteboard.jpg' } } });
  assert.notEqual(host.slot.card, card, '换照片重建卡');
  assert.ok(host.slot.innerHTML.includes('assets/photo-whiteboard.jpg'));
  h.update({ card: { ...DEEP, suggestion: '换个建议' } });
  const card2 = host.slot.card;
  h.update({ card: { ...DEEP } });
  assert.equal(host.slot.card, card2, '同照片只补文案，不重建');
});

test('D11 回调可经 update 替换；未传键不动旧值（合并语义）', () => {
  const { host } = stubHost();
  const a = []; const b = [];
  const h = mount(host, { card: null, onCapture: () => a.push(1) });
  clickBtn(host, { dataset: { capture: '1' } });
  h.update({ onCapture: () => b.push(1) });
  clickBtn(host, { dataset: { capture: '1' } });
  assert.deepEqual(a, [1]);
  assert.deepEqual(b, [1]);
  h.update({});
  clickBtn(host, { dataset: { capture: '1' } });
  assert.deepEqual(b, [1, 1], 'onCapture 保留');
});

test('D12 宿主容错：mount(null)/裸宿主不抛、update 不抛', () => {
  let h;
  assert.doesNotThrow(() => { h = mount(null, { card: QUICK }); });
  assert.doesNotThrow(() => { h.update({ card: DEEP }); });
  const bare = { innerHTML: '', addEventListener() {} };
  assert.doesNotThrow(() => mount(bare, { card: QUICK }));
});

test('D13 rm（reduced-motion）：挂即内联禁动画；change 事件即时开/关（直接切换）', () => {
  const mq = mkMq(true);
  const { host } = stubHost({ mq });
  const h = mount(host, { card: DEEP });
  assert.equal(host.slot.card.style.animation, 'none', 'rm：内联禁动画');
  assert.equal(host.slot.card.style.transition, 'none');
  h.update({ card: QUICK });
  assert.equal(host.slot.card.style.animation, 'none', '换态后仍禁');
  mq.matches = false;
  mq.fire();
  assert.equal(host.slot.card.style.animation, '', '离开 rm：清内联（CSS 接管）');
  mq.matches = true;
  mq.fire();
  assert.equal(host.slot.card.style.animation, 'none', '再入 rm：即时再禁');
});

test('D14 非 rm：卡内联动画留空（CSS capup 生效路径）', () => {
  const mq = mkMq(false);
  const { host } = stubHost({ mq });
  mount(host, { card: DEEP });
  assert.equal(host.slot.card.style.animation, '');
});

test('D15 无 matchMedia 环境不抛且不设内联', () => {
  const { host } = stubHost({ win: {} });
  const h = mount(host, { card: DEEP });
  assert.equal(host.slot.card.style.animation, '');
  h.update({ card: QUICK });
  assert.equal(host.slot.card.style.animation, '');
});

test('D16 无 classList 节点兜底：className 直写换态（exotic 节点不炸）', () => {
  const { host } = stubHost();
  const h = mount(host, { card: QUICK });
  delete host.slot.card.classList; // 模拟无 classList 的节点
  h.update({ card: DEEP });
  assert.equal(host.slot.card.className, 'capcard deep');
  assert.ok(host.slot.card.wrapper.innerHTML.includes('已升级 · '), '文字容器照常重灌');
  h.update({ card: QUICK });
  assert.equal(host.slot.card.className, 'capcard');
});
