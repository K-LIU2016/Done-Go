// M16 · 「📷 拍一下」入口 + 建议卡（快→深升级）—— 纯核 + DOM 壳
// 依据：PRD §6.8.2 感知流水线（快慢双路，L485-496）：快感知 qwen3.5-omni-flash 约 1.5s
//   一句话"看到了什么"即时卡 → 深感知 qwen3-vl-plus 约 6s 变化/风险/建议 → **原地升级同一张卡**；
//   ContextDelta = {blockId, seen, change, risk, evidence(imageRef)}（L491）——本组件 props 的
//   card 即此形状 + 展示字段（phase/model/ms/suggestion/actions/messages）；§5.2 末原型实测
//   教训（L275 整块重绘丢状态）→ 增量硬约束；prototype.html（唯一视觉标准）L175-184
//   （.capture/.capcard 样式：120px 1fr 栅格、左 4px --k-explore 边、.deep 转左 --ok、
//   img 120×90、.lv 12px、.acts 按钮组、≤560px 单列 + img 全宽 4:3、reduced-motion 禁动画）、
//   L383-392（captureHTML 原文：入口行/快卡/深卡三段）、L586-589（startCapture：快卡即出、
//   4.5s 后原地升深卡）、L625-626（data-capture/data-capact 事件委托 + capNote '✓ '+消息原文）。
// 契约（tests/agentic/ui/capture-card.spec.ts 组件页 + unit/capture-card.test.mjs 纯核/壳桩）：
//   mount(el, { card, onCapture, onAction }) → { el, update(props) }，update 合并语义（未传键不动旧值）；
//   card = null/缺省 → 仅入口行；📷 点击 → onCapture()（宿主负责起快卡）；
//   深卡动作点击 → onAction('timer'|'step'|'note') + .cap-note 写 '✓ '+消息（prototype L626 原文，
//   card.messages[act] 可覆盖，未知 act 兜底「已处理：<act>」）。
// 增量硬约束（spec「快→深同卡原地升级不重建」）：.capcard 节点跨 update 存活——
//   壳（.capture 入口行 + .cap-slot + .cap-note）只首绘写一次；card 出现/消失/换照片
//   （imageRef 变）才建/清/重建卡节点；同照片 quick↔deep 只拨 .deep 类 + 重灌卡内文字容器；
//   同内容 update 零写（内容比对跳过）。升级动画 = CSS .deep 一次 capup 光晕；
//   rm（prefers-reduced-motion）= 组件级 CSS 禁动画 + matchMedia 内联直禁（挂后切换即时生效，
//   即「直接切换」）。
// 图片白名单 SAFE_IMAGE（M04 SAFE_SRC / M07 SAFE_MEDIA 同规则）：evidence.imageRef 只放行
//   相对路径，协议/绝对路径/../ 一律整段丢弃——宁缺勿假（无图卡仍在，不渲染空 img）。
// 与原型有意差异（原型胜出项之外，逐条记录）：① 入口行 inline style 收进 .caprow 类（声明逐条
//   相同）；② .capcard 补 role=status（M07 scene-card 同款，播报语义）；③ 反馈节点用
//   .cap-note 类而非 id=capNote（多实例安全，spec 联合选择器 #capNote,.cap-note 兼容）；
//   ④ 新增 capup 升级光晕动画 + rm 双路禁用（plan M16「升级动画/rm 直接切换」要求，原型全局
//   rm 规则同向）；⑤ 反馈消息可由 card.messages 覆盖、动作组可由 card.actions 覆盖
//   （PRD §6.8.2 建议卡动作按钮集 记下来/加待办/调整计划/设提醒/交给 agent 做 的数据化）。
// esc/setHTML 探测 M01 web/agentic/ui/utils.js（同 tiers.js/block-card.js 并行落地模式），未落地本地兜底。
let escShared = null;
let setHTMLShared = null;
try {
  const utils = await import('./utils.js');
  if (typeof utils.esc === 'function') escShared = utils.esc;
  if (typeof utils.setHTML === 'function') setHTMLShared = utils.setHTML;
} catch {
  // utils.js 不存在（M01 未落地）：本地兜底，规则与 prototype L328-329 一致（五实体 + 内容比对跳过）
}

const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
/** 五实体转义（M01 XSS 基线）：外部字符串入 HTML/属性必经 */
export const esc = escShared ?? ((s) => String(s).replace(/[&<>"']/g, (c) => ESC_MAP[c]));
/** 内容没变就不重写 DOM（prototype L328：增量更新基石） */
export const setHTML = setHTMLShared ?? ((el, html) => {
  if (!el || el._h === html) return false;
  el._h = html;
  el.innerHTML = html;
  return true;
});

const txt = (v) => esc(v ?? '');

// ---------- 常量与归一（prototype 原文） ----------

export const CAPTURE_TITLE = '现场感知';
export const CAPTURE_HINT = '做的时候随手拍一下，我按你的进度给下一步';
export const CAPTURE_BTN = '📷 拍一下（示例：进度照）';
export const IMG_ALT_DEFAULT = '你拍的书架进度照';

export const SEEN_PREFIX = '看到：';
export const RISK_PREFIX = '风险：';
export const SUGGEST_PREFIX = '建议：';
export const ANALYZING_NOTE = '深度分析中…';
export const QUICK_TAG = '即时';
export const DEEP_TAG = '已升级';

/** PRD §6.8.2：快路 1.5s / 深路 6.0s 默认档（prototype L387-388 原文，card 可覆盖） */
export const QUICK_MODEL = 'qwen3.5-omni-flash';
export const QUICK_MS = '1.5s';
export const DEEP_MODEL = 'qwen3-vl-plus';
export const DEEP_MS = '6.0s';

/** 深卡动作组默认三动作（prototype L389 原文；点击序 = spec 断言序 timer|step|note） */
export const DEFAULT_ACTIONS = [
  { act: 'timer', label: '⏱ 15 分钟后提醒我' },
  { act: 'step', label: '步骤卡跳到第 4 步' },
  { act: 'note', label: '记下来' },
];

/** 动作点击后的 capNote 反馈消息（prototype L626 原文；card.messages[act] 可覆盖） */
export const ACTION_FEEDBACK = {
  timer: '已设 21:32 提醒：胶水初固，可以拧螺丝了',
  step: '步骤卡已跳到第 4 步：拧紧隔板螺丝（先对角、再其余）',
  note: '已记下：第 3 步胶水溢出，下次少涂一点',
};

/** 相对路径白名单（M04 SAFE_SRC / M07 SAFE_MEDIA 同款）：禁协议/绝对路径/空白/../ */
export const SAFE_IMAGE = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

/** 白名单外的图片值整段丢弃（XSS/越权基线）；非字符串一律 ''（宁缺勿假） */
export function safeImage(v) {
  if (typeof v !== 'string' || !SAFE_IMAGE.test(v) || v.includes('..')) return '';
  return v;
}

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

/** 自定义动作组：仅收 {act,label} 均为非空字符串的项（act 去空白，label 原样）；空/非数组 → null（回落默认） */
export function normalizeActions(list) {
  if (!Array.isArray(list)) return null;
  const out = [];
  for (const it of list) {
    if (!isObj(it)) continue;
    if (typeof it.act !== 'string' || !it.act.trim()) continue;
    if (typeof it.label !== 'string' || !it.label.trim()) continue;
    out.push({ act: it.act.trim(), label: it.label });
  }
  return out.length ? out : null;
}

/**
 * PRD §6.8.2 ContextDelta 归一：{ blockId, seen, change, risk, evidence(imageRef) } +
 *   展示字段（phase/model/ms/suggestion/actions/messages/alt）。非对象一律 null（无卡态）。
 *   phase 仅认 'deep'，其余归 quick；imageRef 过 SAFE_IMAGE 白名单。
 *   幂等：已归一形态（imageRef/imageAlt 在顶层）再入不丢字段（evidence 优先）。
 */
export function normalizeCard(card) {
  if (!isObj(card)) return null;
  const phase = card.phase === 'deep' ? 'deep' : 'quick';
  const ev = isObj(card.evidence) ? card.evidence : {};
  return {
    phase,
    blockId: typeof card.blockId === 'string' || typeof card.blockId === 'number' ? String(card.blockId) : '',
    seen: card.seen ?? '',
    change: card.change ?? '',
    risk: card.risk ?? '',
    suggestion: card.suggestion ?? '',
    imageRef: safeImage(ev.imageRef ?? card.imageRef),
    imageAlt: ev.alt ?? card.imageAlt ?? IMG_ALT_DEFAULT,
    model: card.model ?? (phase === 'deep' ? DEEP_MODEL : QUICK_MODEL),
    ms: card.ms ?? (phase === 'deep' ? DEEP_MS : QUICK_MS),
    actions: normalizeActions(card.actions) ?? DEFAULT_ACTIONS,
    messages: isObj(card.messages) ? card.messages : null,
  };
}

// ---------- 纯核：HTML 构建 ----------

/** .lv 行：快卡「即时 · model ms · 深度分析中…」/ 深卡「已升级 · model ms」（prototype L387-388） */
export function levelLine(c) {
  return c.phase === 'deep'
    ? `${DEEP_TAG} · ${txt(c.model)} ${txt(c.ms)}`
    : `${QUICK_TAG} · ${txt(c.model)} ${txt(c.ms)} · ${ANALYZING_NOTE}`;
}

/** 动作组按钮（data-capact 委托键 = onAction 载荷；act/label 均经 esc） */
export function actionsHTML(actions) {
  return (actions || []).map((a) => `<button class="btn" data-capact="${txt(a.act)}">${txt(a.label)}</button>`).join('');
}

/** 卡体：快卡 = 「看到：seen」一句话；深卡 = change + 风险行（有则渲染）+ 建议（margin-top:4px 原文）+ 动作组 */
export function bodyHTML(c) {
  if (c.phase !== 'deep') return `<b>${SEEN_PREFIX}${txt(c.seen)}</b>`;
  return `<b>${txt(c.change)}</b>`
    + (c.risk ? `<div class="small">${RISK_PREFIX}${txt(c.risk)}</div>` : '')
    + `<div class="small" style="margin-top:4px">${SUGGEST_PREFIX}${txt(c.suggestion)}</div>`
    + `<div class="acts">${actionsHTML(c.actions)}</div>`;
}

/** 缩略图：白名单内渲染 img（alt 默认「你拍的书架进度照」）；无/unsafe → 空串不渲染 */
export function imgHTML(c) {
  return c.imageRef ? `<img src="${txt(c.imageRef)}" alt="${txt(c.imageAlt)}">` : '';
}

/** 卡内文字容器（.lv + 卡体）——壳增量路径只重灌此段 */
export function cardInner(c) {
  return `<div class="lv">${levelLine(c)}</div>${bodyHTML(c)}`;
}

/** 整卡：aria-live=polite + role=status（升级可播报，DAG M16）；deep 态挂 .deep 类（左 --ok 边） */
export function cardHTML(c) {
  return `<div class="capcard${c.phase === 'deep' ? ' deep' : ''}" aria-live="polite" role="status">${imgHTML(c)}<div>${cardInner(c)}</div></div>`;
}

/** 入口行：标题「现场感知」+ 说明 + spacer + 「📷 拍一下（示例：进度照）」（prototype L391） */
export function entryHTML() {
  return `<div class="caprow"><b>${CAPTURE_TITLE}</b><span class="small muted">${CAPTURE_HINT}</span><span class="spacer"></span><button class="btn" data-capture="1">${CAPTURE_BTN}</button></div>`;
}

/** 壳：入口行 + .cap-slot（卡槽，壳增量路径唯一可写区）+ .cap-note（动作反馈） */
export function captureShellHTML(card) {
  const c = normalizeCard(card);
  return `<div class="capture">${entryHTML()}<div class="cap-slot">${c ? cardHTML(c) : ''}</div><p class="small muted cap-note"></p></div>`;
}

/** 动作反馈文案：'✓ ' + card.messages[act] ?? ACTION_FEEDBACK[act] ?? 兜底（prototype L626） */
export function feedbackText(act, messages) {
  const m = isObj(messages) ? messages : {};
  return `✓ ${m[act] ?? ACTION_FEEDBACK[act] ?? `已处理：${act}`}`;
}

// ---------- 样式（prototype L175-184 原文 + token 兜底 + capup 升级动画 + rm 降级） ----------

export const CAPTURE_CSS = `
.capture { margin-top: 14px; display: grid; gap: 10px; }
.capture .caprow { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.capture .spacer { flex: 1; }
.capture .btn { border: 1px solid var(--line, rgba(34,48,42,.14)); background: var(--surface, #FFFFFF); border-radius: 999px; padding: 8px 16px; min-height: 40px; }
.capture .small { font-size: 13px; }
.capture .muted { color: var(--text-2, #5C6B61); }
.capture .capcard { display: grid; grid-template-columns: 120px 1fr; gap: 12px; border: 1px solid var(--line, rgba(34,48,42,.14)); border-left: 4px solid var(--k-explore, #4D7699); border-radius: 12px; padding: 10px; background: var(--paper, #FCFBF6); }
.capture .capcard.deep { border-left-color: var(--ok, #3F7A55); animation: capup .45s ease; }
.capture .capcard img { width: 120px; height: 90px; object-fit: cover; border-radius: 8px; }
.capture .capcard .lv { font-size: 12px; color: var(--text-2, #5C6B61); }
.capture .capcard .acts { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 6px; }
@keyframes capup { from { box-shadow: 0 0 0 6px rgba(63,122,85,.28); } to { box-shadow: 0 0 0 6px rgba(63,122,85,0); } }
@media (max-width: 560px) { .capture .capcard { grid-template-columns: 1fr; } .capture .capcard img { width: 100%; height: auto; aspect-ratio: 4/3; } }
@media (prefers-reduced-motion: reduce) { .capture .capcard, .capture .capcard *, .capture .btn { animation: none !important; transition: none !important; } }
.capture .btn:focus-visible { outline: 2px solid var(--you, #E95432); outline-offset: 2px; }
`;

/** 幂等注入样式；无 DOM 环境（node 纯核）安全返回 false（M06/M07 ensureStyles 同款） */
export function ensureStyles(doc) {
  if (!doc || typeof doc.createElement !== 'function') return false;
  if (doc.querySelector('style[data-agentic-capture]')) return false;
  const st = doc.createElement('style');
  st.setAttribute('data-agentic-capture', '');
  st.textContent = CAPTURE_CSS;
  const head = doc.head || doc.documentElement;
  if (!head || typeof head.appendChild !== 'function') return false;
  head.appendChild(st);
  return true;
}

// ---------- DOM 壳：mount / update ----------

const RM_QUERY = '(prefers-reduced-motion: reduce)';

/**
 * 壳（组件页 ?c=capture-card / demo 装配）：
 *   首绘一次整写壳（入口行 + 槽 + 反馈行）；此后 update 只做
 *   ①quick↔deep：同卡拨 .deep 类 + 重灌卡内文字容器（卡节点/img/入口行保活——同卡原地升级）
 *   ②换照片：槽重建新卡（新照片 = 新卡）；③card 出现/消失：建卡/清槽；
 *   ④同内容：内容比对零写。📷/动作按钮均为容器级委托（el 监听一次，节点重建不丢）。
 *   rm：matchMedia 内联直禁动画（挂后切换即时生效，即「直接切换」），CSS media 兜底。
 */
export function mount(el, props) {
  const state = { card: undefined, onCapture: null, onAction: null, lastInner: null, lastImg: null, mq: null };

  const query = (node, sel) => (typeof node?.querySelector === 'function' ? node.querySelector(sel) : null);
  const cardElOf = () => query(query(el, '.cap-slot'), '.capcard');

  const rmOn = () => !!(state.mq && state.mq.matches);
  const motionApply = (node) => {
    if (!node || !node.style) return false;
    const v = rmOn() ? 'none' : '';
    node.style.animation = v;
    node.style.transition = v;
    return true;
  };

  const win = (el && el.ownerDocument && el.ownerDocument.defaultView)
    || (typeof window !== 'undefined' ? window : null);
  if (win && typeof win.matchMedia === 'function') {
    state.mq = win.matchMedia(RM_QUERY);
    const onChange = () => motionApply(cardElOf());
    if (typeof state.mq.addEventListener === 'function') state.mq.addEventListener('change', onChange);
    else if (typeof state.mq.addListener === 'function') state.mq.addListener(onChange); // 旧 Safari
  }

  const merge = (p) => {
    if (!p || typeof p !== 'object') return;
    if ('card' in p) state.card = p.card;
    if (typeof p.onCapture === 'function') state.onCapture = p.onCapture;
    if (typeof p.onAction === 'function') state.onAction = p.onAction;
  };

  const imgKey = (c) => `${c.imageRef}\u0000${c.imageAlt}`;

  const apply = (p) => {
    merge(p);
    const c = normalizeCard(state.card);
    const slot = query(el, '.cap-slot');
    if (!slot) { // 首绘（或宿主被外部清空）：整写壳（传原始 card，壳内自行归一）
      setHTML(el, captureShellHTML(state.card));
      state.lastInner = c ? cardInner(c) : '';
      state.lastImg = c ? imgKey(c) : null;
      motionApply(cardElOf());
      return;
    }
    if (!c) { // 无卡：清槽（壳/入口行不动）
      if (query(slot, '.capcard')) setHTML(slot, '');
      state.lastInner = '';
      state.lastImg = null;
      return;
    }
    const wantKey = imgKey(c);
    const cardNode = query(slot, '.capcard');
    if (!cardNode || state.lastImg === null || state.lastImg !== wantKey) {
      // 建卡 / 换照片重建（新照片 = 新卡）
      setHTML(slot, cardHTML(c));
      state.lastInner = cardInner(c);
      state.lastImg = wantKey;
      motionApply(query(slot, '.capcard'));
      return;
    }
    // 同照片：原地换态——拨 .deep 类 + 重灌卡内文字容器（卡节点保活）
    const wantDeep = c.phase === 'deep';
    if (cardNode.classList && typeof cardNode.classList.toggle === 'function') {
      const has = typeof cardNode.classList.contains === 'function' ? cardNode.classList.contains('deep') : wantDeep;
      if (has !== wantDeep) cardNode.classList.toggle('deep', wantDeep);
    } else {
      const cls = `capcard${wantDeep ? ' deep' : ''}`;
      if (cardNode.className !== cls) cardNode.className = cls;
    }
    const inner = cardInner(c);
    if (inner !== state.lastInner) {
      const wrap = query(cardNode, 'div');
      if (wrap) setHTML(wrap, inner);
      state.lastInner = inner;
    }
    motionApply(cardNode);
  };

  const onClick = (ev) => {
    const t = ev?.target?.closest?.('button[data-capture], button[data-capact]');
    if (!t) return;
    if (typeof el.contains === 'function' && !el.contains(t)) return;
    if (t.dataset && t.dataset.capture) { // 📷 拍一下 → 宿主起快卡（prototype L625 startCapture）
      if (state.onCapture) state.onCapture();
      return;
    }
    const act = t.dataset ? t.dataset.capact : '';
    if (act) { // 深卡动作 → onAction + .cap-note 反馈（prototype L626）
      if (state.onAction) state.onAction(act);
      const note = query(el, '.cap-note');
      if (note) note.textContent = feedbackText(act, normalizeCard(state.card)?.messages ?? null);
    }
  };
  if (el && typeof el.addEventListener === 'function') el.addEventListener('click', onClick);

  const doc = (el && el.ownerDocument) || (typeof document !== 'undefined' ? document : null);
  ensureStyles(doc);

  apply(props);
  const handle = {
    el,
    update(p) {
      apply(p);
      return handle;
    },
  };
  return handle;
}
