// M11 · 边界卡与签约 —— 四栏边界 + 签约/撤回 + 打扰策略脚注（纯核 + DOM 壳）
// 依据：PRD §5.3 签约（L279-282：一屏完成 边界卡 + 打扰策略 + 主按钮「就这么办」；
//   按钮签的就是服务端规范化 contractHash，界面与执行器读同一载荷）+ §8.1 Contract
//   （L603 wont 至少包含系统默认禁止项；L836 MissionPatch 校验「不得放宽系统禁止项」
//   → SYS_WONT 恒显示、不可被合同覆盖）+ §5.8 移动端 ≤720px 四栏→2×2；
//   prototype.html（唯一视觉标准）L99-104（.bound 四栏 grid + @720px 1fr 1fr +
//   section/h3/ul/.sys + .sign + .hash 等宽）、L305（SYS_WONT 原文）、L461-469（renderBound：
//   col 四 section、sys li 追加在合同 wont 之后、未签约 primary「就这么办（签约 N 个块）」
//   + 小字、已签约 chip.hi + 「合同 hash」 + danger 撤回、打扰策略脚注）。
// 契约（tests/agentic/ui/boundaries.spec.ts 组件页 + unit/boundaries.test.mjs 纯核/壳桩）：
//   mount(el, { boundary, sysWont, signed, hash, blockCount, interruptNote, onSign, onRevoke })
//   → { el, update(props) }（合并语义：未传键不动旧值，链式返回 handle）。
//   boundary = { will, wont, needs, budget } 字符串数组；signed 翻转 → onSign()/onRevoke()
//   由宿主接线（本组件只回调不持约）。键盘可达：签约/撤回均为原生 <button type="button">
//   （Enter/Space 原生触发 click）；.sign chip 带 aria-live=polite 播报已签约态。
// 增量（BUILD-PLAN W5 硬性要求 / PRD §5.2 末教训）：壳（.bound/.sign/脚注三容器）只在
//   mount 写一次；update 仅 setHTML 三个子区（内容比对），boundary 变化不碰 .sign、
//   签约态变化不碰 .bound——各栏与按钮节点跨 update 保活。
// esc/setHTML 探测 M01 web/agentic/ui/utils.js（同 registry/tiers/block-card/discuss 并行
//   落地模式），未落地本地兜底（规则与 prototype L328-329 一致：五实体 + 内容比对跳过）。
let escShared = null;
let setHTMLShared = null;
try {
  const utils = await import('./utils.js');
  if (typeof utils.esc === 'function') escShared = utils.esc;
  if (typeof utils.setHTML === 'function') setHTMLShared = utils.setHTML;
} catch {
  // utils.js 不存在（M01 未落地）：本地兜底
}

const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
/** 五实体转义（M01 XSS 基线）：外部字符串入 HTML 必经 */
export const esc = escShared ?? ((s) => String(s).replace(/[&<>"']/g, (c) => ESC_MAP[c]));
/** 内容没变就不重写 DOM（prototype L328：增量更新基石） */
export const setHTML = setHTMLShared ?? ((el, html) => {
  if (!el || el._h === html) return false;
  el._h = html;
  el.innerHTML = html;
  return true;
});

// ---------- 常量（prototype L305/L467/L468 原文）与状态归一 ----------

/** 系统默认禁止项：合同不可覆盖（PRD §8.1/§11.3），空/非法 sysWont 一律回退到它 */
export const DEFAULT_SYS_WONT = '系统禁止：付款下单 · 以你名义发送（除非逐次确认）· 读取凭据 · 删除文件';
/** 打扰策略脚注（prototype L468 原文；PRD §5.3 签约屏要素之一） */
export const DEFAULT_INTERRUPT_NOTE = '打扰策略：只在需要你时打扰 · 22:00 起的“自己的时间”零打扰';
/** 未签约小字：签的对象是合同 hash 本身（prototype L467 / PRD §5.3 L280） */
export const SIGN_NOTE = '签的是这份合同本身；之后任何改动都会让你重新确认';

/** 条目归一：只留非空字符串项；非数组一律 []（宁缺勿假，不渲染 [object Object]） */
export function normalizeItems(v) {
  // 契约容忍（M21）：W0 preview.boundary.budget 是整段串（PRD §10.3），单串收为单元素数组
  if (typeof v === 'string') return v.trim().length > 0 ? [v.trim()] : [];
  if (!Array.isArray(v)) return [];
  return v.filter((s) => typeof s === 'string' && s.trim().length > 0);
}

/** boundary 归一：{ will, wont, needs, budget } 四栏各经 normalizeItems；非对象 → 空四栏 */
export function normalizeBoundary(v) {
  const src = v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  return {
    will: normalizeItems(src.will),
    wont: normalizeItems(src.wont),
    needs: normalizeItems(src.needs),
    budget: normalizeItems(src.budget),
  };
}

/** 系统禁止项查询：非空字符串收下（trim 后判空）；空/缺省/非串回 DEFAULT_SYS_WONT（不可移除） */
export function sysWontOf(v) {
  return typeof v === 'string' && v.trim().length > 0 ? v : DEFAULT_SYS_WONT;
}

/** hash 归一：非空串 trim；其余 ''（缺 hash 不渲染该段，宁缺勿假） */
export function hashOf(v) {
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : '';
}

/** 签约块数：数字/数字串 → 非负整数（截尾、负归 0）；非法一律 0 */
export function blockCountOf(v) {
  const n = typeof v === 'number' ? v
    : typeof v === 'string' && v.trim().length > 0 ? Number(v) : NaN;
  if (!Number.isFinite(n) || n < 1) return 0;
  return Math.trunc(n);
}

/** 脚注归一：非空字符串收下；缺省/非串回默认脚注 */
export function interruptNoteOf(v) {
  return typeof v === 'string' && v.trim().length > 0 ? v : DEFAULT_INTERRUPT_NOTE;
}

// ---------- 纯核：HTML 构建 ----------

const txt = (v) => esc(v ?? '');

/** 单栏（prototype renderBound col L463 原文）：section>h3+ul；extra 追加在条目后（sys 专用） */
function colHTML(title, items, extra = '') {
  return `<section><h3>${esc(title)}</h3><ul>${items.map((x) => `<li>${txt(x)}</li>`).join('')}${extra}</ul></section>`;
}

/** 四栏内层（update 打 .bound 子区用）：sys li 恒追加在「我不会做」栏末尾，合同 wont 为空也在 */
export function boundInner(props = {}) {
  const b = normalizeBoundary(props.boundary);
  return colHTML('我会做', b.will)
    + colHTML('我不会做', b.wont, `<li class="sys">${esc(sysWontOf(props.sysWont))}</li>`)
    + colHTML('需要你', b.needs)
    + colHTML('花费与上限', b.budget);
}

/** 四栏容器（prototype L464 + L99 布局） */
export function boundHTML(props = {}) {
  return `<div class="bound">${boundInner(props)}</div>`;
}

/**
 * 签约区内层（update 打 .sign 子区用；prototype L466-467 原文）：
 *   未签约——primary「就这么办（签约 N 个块）」+ 小字（签的是合同 hash 本身）；
 *   已签约——chip.hi（aria-live 播报）+ 等宽「合同 hash」（缺 hash 省略该段）+ danger 撤回。
 */
export function signInner(props = {}) {
  if (props.signed) {
    const hash = hashOf(props.hash);
    return '<span class="chip hi" role="status" aria-live="polite">已签约</span>'
      + (hash ? `<span class="hash">合同 ${txt(hash)}</span>` : '')
      + '<button type="button" class="btn danger" data-revoke="1">撤回</button>';
  }
  const n = blockCountOf(props.blockCount);
  return `<button type="button" class="btn primary" data-sign="1">就这么办（签约 ${n} 个块）</button>`
    + `<span class="small muted">${esc(SIGN_NOTE)}</span>`;
}

/** 整壳：mount 首绘一次（此后只打 .bound/.sign/[data-note] 三子区补丁） */
export function boundariesHTML(props = {}) {
  return boundHTML(props)
    + `<div class="sign">${signInner(props)}</div>`
    + `<p class="small muted bound-note" data-note="1">${esc(interruptNoteOf(props.interruptNote))}</p>`;
}

// ---------- 样式（prototype L99-104 原文 + token 兜底 + 焦点/reduced-motion；M01 agentic.css 落地后共存无害） ----------

export const BOUND_CSS = `
.bound { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; }
@media (max-width: 720px) { .bound { grid-template-columns: 1fr 1fr; } }
.bound section { border: 1px solid var(--line, rgba(34,48,42,.14)); border-radius: 12px; padding: 10px 12px; background: var(--paper, #FCFBF6); }
.bound h3 { font-size: 15px; margin-bottom: 6px; }
.bound ul { margin: 0; padding-left: 1.1em; font-size: 13px; display: grid; gap: 4px; }
.bound .sys { color: var(--text-2, #5C6B61); }
.sign { display: flex; gap: 10px; align-items: center; margin-top: 14px; flex-wrap: wrap; }
.sign .btn { border: 1px solid var(--line, rgba(34,48,42,.14)); background: var(--surface, #FFFFFF); border-radius: 999px; padding: 8px 16px; min-height: 40px; font: inherit; cursor: pointer; }
.sign .btn.primary { background: var(--accent, #2F6B4F); border-color: var(--accent, #2F6B4F); color: var(--surface, #FFFFFF); }
.sign .btn.danger { color: var(--bad, #A53B25); background: var(--surface, #FFFFFF); }
.sign button:focus-visible { outline: 2px solid var(--accent, #2F6B4F); outline-offset: 2px; }
.sign .chip { font-size: 12px; border-radius: 999px; padding: 2px 9px; background: var(--paper, #FCFBF6); border: 1px solid var(--line, rgba(34,48,42,.14)); color: var(--text-2, #5C6B61); }
.sign .chip.hi { color: var(--ok, #3F7A55); border-color: var(--ok, #3F7A55); }
.hash { font-family: ui-monospace, Menlo, monospace; font-size: 12px; color: var(--text-2, #5C6B61); }
.sign .small, .bound-note { font-size: 13px; color: var(--text-2, #5C6B61); }
.bound-note { margin-top: 10px; }
@media (prefers-reduced-motion: reduce) { .bound, .bound *, .sign, .sign * { transition: none !important; animation: none !important; } }
`;

/** 幂等注入样式；无 DOM 环境（node 纯核）安全返回 false（M06/M07 同款） */
export function ensureStyles(doc) {
  if (!doc || typeof doc.createElement !== 'function') return false;
  if (doc.querySelector('style[data-agentic-bound]')) return false;
  const st = doc.createElement('style');
  st.setAttribute('data-agentic-bound', '');
  st.textContent = BOUND_CSS;
  const head = doc.head || doc.documentElement;
  if (!head || typeof head.appendChild !== 'function') return false;
  head.appendChild(st);
  return true;
}

// ---------- DOM 壳：mount / update ----------

/**
 * 壳（组件页 ?c=boundaries / demo 装配）：mount(el, props) → handle。
 * props = { boundary, sysWont, signed, hash, blockCount, interruptNote, onSign, onRevoke }。
 * 增量：壳只写一次；update 只 setHTML 三子区——.bound（boundary/sysWont）、.sign
 *   （signed/hash/blockCount）、[data-note]（interruptNote），内容未变零写；
 *   两栏与按钮节点跨 update 保活（PRD §5.2 末教训）。
 * 事件：容器级委托单监听——click [data-sign] → onSign()、[data-revoke] → onRevoke()
 *   （prototype L620-624 signBtn/revoke 同源语义）；按钮原生键盘可达（Enter/Space→click）。
 */
export function mount(el, props) {
  const state = {
    boundary: undefined, sysWont: undefined, signed: false,
    hash: '', blockCount: 0, interruptNote: undefined, onSign: null, onRevoke: null,
  };
  let shellDone = false;

  const merge = (p) => {
    if (!p || typeof p !== 'object') return;
    if ('boundary' in p) state.boundary = normalizeBoundary(p.boundary);
    if ('sysWont' in p) state.sysWont = sysWontOf(p.sysWont);
    if ('signed' in p) state.signed = Boolean(p.signed);
    if ('hash' in p) state.hash = hashOf(p.hash);
    if ('blockCount' in p) state.blockCount = blockCountOf(p.blockCount);
    if ('interruptNote' in p) state.interruptNote = interruptNoteOf(p.interruptNote);
    if ('onSign' in p) state.onSign = typeof p.onSign === 'function' ? p.onSign : null;
    if ('onRevoke' in p) state.onRevoke = typeof p.onRevoke === 'function' ? p.onRevoke : null;
  };

  const zone = (sel) => (typeof el?.querySelector === 'function' ? el.querySelector(sel) : null);

  const apply = (p) => {
    merge(p);
    if (!shellDone) {
      setHTML(el, boundariesHTML(state));
      shellDone = true;
    }
    const boundZone = zone('.bound');
    if (boundZone) setHTML(boundZone, boundInner(state));
    const signZone = zone('.sign');
    if (signZone) setHTML(signZone, signInner(state));
    const noteZone = zone('[data-note]');
    if (noteZone) setHTML(noteZone, esc(interruptNoteOf(state.interruptNote)));
  };

  if (typeof el?.addEventListener === 'function') {
    el.addEventListener('click', (e) => {
      const t = e?.target;
      const sign = t?.closest?.('[data-sign]');
      if (sign) {
        if (typeof state.onSign === 'function') state.onSign();
        return;
      }
      const revoke = t?.closest?.('[data-revoke]');
      if (revoke && typeof state.onRevoke === 'function') state.onRevoke();
    });
  }

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
