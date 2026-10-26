// M06 · 块抽屉壳 —— 五标签 + 阶段条 + 移动底部抽屉（纯核 + DOM 壳）
// 依据：PRD §5.8（移动端：块抽屉为底部抽屉）、§5.2 末（增量更新：整块重绘会冲掉
//   执行中按钮/展开的为什么/旁白字幕）、prototype.html（唯一视觉/交互标准）：
//   L199  nav.stepper ① 说 / ② 看 · 预演 / ③ 定 · 签约 / ④ 交 · 执行与验收
//   L210-218 .tabs 五标签（预演/边界/进行中/交付物/追踪）+ #tab-* 五 section
//   L331-337 renderStepper：i===cur→on，i<cur→done，否则 ''
//   L532-536 showTab：按钮 .on + section .hidden 切换
// 契约（tests/agentic/ui/drawer.spec.ts 组件页 + unit/drawer.test.mjs 纯核/壳桩）：
//   mount(el, { blockId, stage, tab, sections, onClose }) → handle
//   handle.update(props) 增量：切 blockId 只改 data-block 属性，绝不重写 tab 面板 DOM；
//   handle.showTab(name) / close() / destroy()；sections 为各标签的 HTML 字符串
//   （由各渲染器产出，内容属受控白名单，本壳不做二次转义）。
// 键盘可达：tablist 方向键 ←→ 循环 + Home/End（roving tabindex，选中即聚焦）；
//   Esc（document 级）→ onClose()，≤720px 底部抽屉（上滑把手，见 DRAWER_CSS）。

// M01 utils.js 已落地为硬依赖：esc/setHTML 直引共享实现，单一来源
//（并行落地期的「动态探测 + 本地同规则兜底」已收编，组件顶层 await 随之移除）。
import { esc, setHTML } from './utils.js';

export { esc, setHTML }; // 保持既有 re-export 导入面（单测/组件页按组件模块导入）

// ---------- 常量（prototype L199 / L211-218 原文） ----------
export const STAGE_ORDER = ['say', 'see', 'sign', 'run'];
export const STAGE_LABELS = {
  say: '① 说',
  see: '② 看 · 预演',
  sign: '③ 定 · 签约',
  run: '④ 交 · 执行与验收',
};
export const TAB_ORDER = ['preview', 'bound', 'live', 'art', 'trace'];
export const TAB_LABELS = { preview: '预演', bound: '边界', live: '进行中', art: '交付物', trace: '追踪' };

// ---------- 纯核：状态归约 ----------
/** 阶段条状态类：当前 on、之前 done、之后 ''（prototype renderStepper L331-337） */
export function stepClass(s, stage) {
  const i = STAGE_ORDER.indexOf(s);
  const cur = STAGE_ORDER.indexOf(stage);
  return i === cur ? 'on' : i < cur ? 'done' : '';
}

export function clampStage(v) {
  return STAGE_ORDER.includes(v) ? v : 'say';
}

export function normalizeTab(v) {
  return TAB_ORDER.includes(v) ? v : 'preview';
}

/** tablist 方向键导航：wrap-around（末尾向右回首个，首个向左回末尾） */
export function nextTab(cur, delta) {
  const len = TAB_ORDER.length;
  const i = TAB_ORDER.indexOf(normalizeTab(cur));
  const d = ((Number(delta) || 0) % len + len) % len;
  return TAB_ORDER[(i + d) % len];
}

function normalize(props) {
  const p = props || {};
  const sections = {};
  if (p.sections && typeof p.sections === 'object') {
    for (const n of TAB_ORDER) {
      const v = p.sections[n];
      if (typeof v === 'string') sections[n] = v;
    }
  }
  return {
    blockId: p.blockId == null ? '' : String(p.blockId),
    stage: clampStage(p.stage),
    tab: normalizeTab(p.tab),
    sections,
  };
}

// ---------- 纯核：HTML 构建 ----------
export function stepperHTML(stage) {
  const cur = clampStage(stage);
  return `<nav class="stepper" aria-label="阶段">${STAGE_ORDER.map((s) =>
    `<span data-s="${s}" class="${stepClass(s, cur)}">${esc(STAGE_LABELS[s])}</span>`).join('')}</nav>`;
}

export function tabsHTML(active) {
  const a = normalizeTab(active);
  return `<div class="tabs" role="tablist" aria-label="块面板">${TAB_ORDER.map((n) => {
    const on = n === a;
    return `<button type="button" role="tab" id="tabbtn-${n}" data-tab="${n}" aria-controls="tab-${n}" aria-selected="${on}" tabindex="${on ? 0 : -1}" class="${on ? 'on' : ''}">${esc(TAB_LABELS[n])}</button>`;
  }).join('')}</div>`;
}

/** 整壳 HTML：面板为空容器，内容由 mount/update 走 setHTML 增量灌入（切块不重建的根基） */
export function drawerHTML(props) {
  const p = normalize(props);
  const secs = TAB_ORDER.map((n) =>
    `<section id="tab-${n}" data-tab="${n}" role="tabpanel" aria-labelledby="tabbtn-${n}" class="${n === p.tab ? '' : 'hidden'}"></section>`).join('');
  return `<div class="ag-drawer" data-block="${esc(p.blockId)}">
  <button type="button" class="grip" aria-label="收起抽屉"></button>
  ${stepperHTML(p.stage)}
  ${tabsHTML(p.tab)}
  ${secs}
</div>`;
}

// ---------- 纯核：增量更新计划 ----------
/** diffDrawer(prev, next) → { blockId?, stage?, tab?, sections:{name:html 仅变更项} }；prev=null 视为全量 */
export function diffDrawer(prev, next) {
  const p = prev || { blockId: undefined, stage: undefined, tab: undefined, sections: {} };
  const out = { blockId: undefined, stage: undefined, tab: undefined, sections: {} };
  if (p.blockId !== next.blockId) out.blockId = next.blockId;
  if (p.stage !== next.stage) out.stage = next.stage;
  if (p.tab !== next.tab) out.tab = next.tab;
  for (const n of TAB_ORDER) {
    if (p.sections[n] !== next.sections[n]) out.sections[n] = next.sections[n];
  }
  return out;
}

// ---------- 纯核：样式（注入一次；Kira 变量带兜底值，agentic.css 落地后自动吃 token） ----------
export const DRAWER_CSS = `
.ag-drawer{display:flex;flex-direction:column;min-width:0}
.ag-drawer .grip{display:none}
.ag-drawer .stepper{display:flex;gap:6px;margin:0 0 14px;flex-wrap:wrap}
.ag-drawer .stepper span{padding:6px 14px;border-radius:999px;border:1px solid var(--line,rgba(34,48,42,.14));color:var(--text-2,#5C6B61);font-size:14px}
.ag-drawer .stepper span.on{background:var(--deep,#2E4636);border-color:var(--deep,#2E4636);color:var(--spring,#EEF0BE)}
.ag-drawer .stepper span.done{color:var(--ok,#3F7A55);border-color:var(--ok,#3F7A55)}
.ag-drawer .tabs{display:flex;gap:4px;border-bottom:1px solid var(--line,rgba(34,48,42,.14));margin:-4px 0 14px;overflow-x:auto}
.ag-drawer .tabs button{border:0;background:none;padding:10px 12px;color:var(--text-2,#5C6B61);border-bottom:2px solid transparent;white-space:nowrap;cursor:pointer;font:inherit}
.ag-drawer .tabs button.on{color:var(--text,#22302A);border-bottom-color:var(--accent,#3E5A47)}
.ag-drawer .tabs button:focus-visible{outline:2px solid var(--accent,#3E5A47);outline-offset:-2px}
.ag-drawer .grip:focus-visible,.ag-drawer .stepper span:focus-visible{outline:2px solid var(--accent,#3E5A47)}
.ag-drawer section[role=tabpanel]{min-height:120px}
.ag-drawer .hidden{display:none !important}
@media (max-width: 720px){
  .ag-drawer{position:fixed;left:0;right:0;bottom:0;z-index:60;max-height:68vh;overflow:auto;background:var(--surface,#FFFFFF);border-radius:16px 16px 0 0;box-shadow:0 -12px 40px rgba(34,48,42,.18);padding:0 16px 16px}
  .ag-drawer .grip{display:block;width:44px;height:4px;border-radius:2px;background:var(--line,rgba(34,48,42,.25));margin:8px auto 4px;padding:0;border:0;cursor:grab}
}
@media (prefers-reduced-motion: reduce){
  .ag-drawer *,.ag-drawer *::before,.ag-drawer *::after{animation:none !important;transition:none !important}
}
`;

/** 幂等注入样式；无 DOM 环境（node 纯核）安全返回 false */
export function ensureStyles(doc) {
  if (!doc || typeof doc.createElement !== 'function') return false;
  if (doc.querySelector('style[data-agentic-drawer]')) return false;
  const st = doc.createElement('style');
  st.setAttribute('data-agentic-drawer', '');
  st.textContent = DRAWER_CSS;
  const head = doc.head || doc.documentElement;
  if (!head || typeof head.appendChild !== 'function') return false;
  head.appendChild(st);
  return true;
}

// ---------- DOM 壳：mount / update / showTab ----------
export function mount(el, props = {}) {
  const doc = (el && el.ownerDocument) || (typeof document !== 'undefined' ? document : null);
  ensureStyles(doc);
  const p = normalize(props);
  setHTML(el, drawerHTML(p));

  const root = el.querySelector('.ag-drawer');
  const spans = [...root.querySelectorAll('.stepper span')];
  const btns = [...root.querySelectorAll('.tabs button')];
  const tabsEl = root.querySelector('.tabs');
  const grip = root.querySelector('.grip');
  const secEl = {};
  for (const n of TAB_ORDER) secEl[n] = root.querySelector(`#tab-${n}`);

  const state = { blockId: p.blockId, stage: p.stage, tab: p.tab, sections: { ...p.sections }, onClose: typeof props.onClose === 'function' ? props.onClose : null };

  function syncStepper() {
    for (const sp of spans) sp.className = stepClass(sp.dataset.s, state.stage);
  }
  function syncTabs() {
    for (const b of btns) {
      const on = b.dataset.tab === state.tab;
      b.setAttribute('aria-selected', String(on));
      b.setAttribute('tabindex', on ? '0' : '-1');
      b.classList.toggle('on', on);
    }
    for (const n of TAB_ORDER) secEl[n].classList.toggle('hidden', n !== state.tab);
  }
  function select(name, focus = false) {
    state.tab = normalizeTab(name);
    syncTabs();
    if (focus) {
      const b = btns.find((x) => x.dataset.tab === state.tab);
      if (b && typeof b.focus === 'function') b.focus();
    }
  }
  function close() {
    if (state.onClose) state.onClose();
  }
  function update(next = {}) {
    const merged = normalize({ blockId: state.blockId, stage: state.stage, tab: state.tab, sections: state.sections, ...next });
    const patch = diffDrawer({ ...state }, merged);
    if (patch.blockId !== undefined) {
      state.blockId = patch.blockId;
      root.setAttribute('data-block', patch.blockId); // 切块只动属性，不碰任何面板 DOM
    }
    if (patch.stage !== undefined) {
      state.stage = patch.stage;
      syncStepper();
    }
    if (patch.tab !== undefined) select(patch.tab);
    for (const n of TAB_ORDER) {
      if (patch.sections[n] !== undefined) {
        state.sections[n] = patch.sections[n];
        setHTML(secEl[n], patch.sections[n]);
      }
    }
    if (typeof next.onClose === 'function') state.onClose = next.onClose;
  }
  function onTabsKey(ev) {
    const k = ev && ev.key;
    if (k === 'ArrowRight') select(nextTab(state.tab, 1), true);
    else if (k === 'ArrowLeft') select(nextTab(state.tab, -1), true);
    else if (k === 'Home') select(TAB_ORDER[0], true);
    else if (k === 'End') select(TAB_ORDER[TAB_ORDER.length - 1], true);
  }
  function onDocKey(ev) {
    if (!ev || ev.key !== 'Escape' || ev.defaultPrevented) return;
    if (typeof ev.preventDefault === 'function') ev.preventDefault();
    close();
  }
  function destroy() {
    if (doc) doc.removeEventListener('keydown', onDocKey);
  }

  for (const b of btns) b.addEventListener('click', () => select(b.dataset.tab));
  grip.addEventListener('click', close);
  tabsEl.addEventListener('keydown', onTabsKey);
  if (doc) doc.addEventListener('keydown', onDocKey);

  syncStepper();
  syncTabs();
  for (const n of TAB_ORDER) setHTML(secEl[n], state.sections[n] ?? '');

  return { el: root, update, showTab: (name) => select(name), close, destroy };
}
