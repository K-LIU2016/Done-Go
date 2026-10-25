// web/voice/voice-sheet.js — VI·V4意图视图：语音底部弹层容器。
// 唯一标准 design/voice-intent/SPEC.md §3：
//   voice-sheet.js：底部弹层容器，含手势下拉关闭、焦点管理、桌面端居中弹窗。
// 视觉 token 沿用 relay-v2 SPEC §3 + voice SPEC §4（原型 :root 原样，见 VOICE_TOKENS）。
//
// 结构：纯逻辑（状态机 / 手势判定 / 焦点循环 / token 表）无 DOM、可在 Node 单测；
// DOM 装配集中在 createVoiceSheet()，且模块顶层不触碰 document/matchMedia，
// 因此 Node（voice-gateway / 测试）可直接 import 本文件。
//
// 浏览器用法：
//   import { createVoiceSheet } from './voice-sheet.js';
//   const sheet = createVoiceSheet({ label: '语音输入', onDismiss(reason) {} });
//   sheet.open(contentElement);   // 打开并挂内容；焦点自动进入弹层并被陷阱圈住
//   sheet.close('drag');          // 收起并还原焦点，随后回调 onDismiss(reason)

// —— 视觉 token（SPEC §4 + relay-v2 §3；key 即 CSS 变量名，value 为兜底值）——
// 样式一律写 var(--x, fallback)，页面定义了同名变量时自动沿用全局主题。
export const VOICE_TOKENS = Object.freeze({
  // relay-v2 §3 基础 token
  '--bg': '#FAF8F3', '--surface': '#FFFFFF', '--sunk': '#F3F0E8',
  '--ink': '#252722', '--ink2': '#64665D', '--ink3': '#8E9086', '--line': '#E4E2D8',
  '--brand': '#E95432', '--brand-soft': '#FDECE6',
  '--forest': '#335D4B', '--forest-soft': '#E7F0EA',
  '--gold': '#E8B04B', '--gold-soft': '#FBF1DC', '--warn': '#B7791F',
  '--r-lg': '20px', '--r-md': '14px',
  '--shadow': '0 1px 2px rgba(37,39,34,.05),0 8px 24px rgba(37,39,34,.06)',
  '--font': '"PingFang SC","Hiragino Sans GB","Noto Sans SC",system-ui,sans-serif',
  // voice SPEC §4 转录 token
  '--vt-size': '22px', '--vt-line': '1.62', '--vt-track': '.3px',
  '--vt-weight-final': '500', '--vt-weight-partial': '400',
  '--vt-final': '#252722', '--vt-partial': '#A3A59B', '--vt-caret': '#E95432',
  // voice SPEC §4 优先级色（p1 最优先 … p5 不急）
  '--p1': '#C2412D', '--p1-bg': '#FCE8E3',
  '--p2': '#C7701F', '--p2-bg': '#FDF0E1',
  '--p3': '#5E6158', '--p3-bg': '#EFEEE8',
  '--p4': '#4C7A93', '--p4-bg': '#E6EFF4',
  '--p5': '#3E7B5B', '--p5-bg': '#E5F1EA',
});

// var(--name, fallback) 构造器：样式里唯一的 token 引入方式。
export const token = (name) => `var(${name},${VOICE_TOKENS[name]})`;

// —— 弹层状态机（纯函数；phase: closed→opening→open→closing→closed）——
export const SHEET_PHASES = Object.freeze(['closed', 'opening', 'open', 'closing']);

export function createSheetState() {
  return { phase: 'closed', drag: null };
}

const ok = (state) => ({ ok: true, state });
const no = (state, reason) => ({ ok: false, reason, state });

export function openSheet(state) {
  return state.phase === 'closed' ? ok({ ...state, phase: 'opening' }) : no(state, `cannot open from ${state.phase}`);
}

export function finishOpening(state) {
  return state.phase === 'opening' ? ok({ ...state, phase: 'open' }) : no(state, `not opening (${state.phase})`);
}

export function beginClose(state) {
  return state.phase === 'open' ? ok({ ...state, phase: 'closing' }) : no(state, `cannot close from ${state.phase}`);
}

export function finishClose(state) {
  return state.phase === 'closing' ? ok({ ...state, phase: 'closed' }) : no(state, `not closing (${state.phase})`);
}

// —— 下拉手势（SPEC §3：手势下拉关闭）——
// 判定阈值（px / px每毫秒）：位移超过面板高度 28%，或快速下甩（≥0.55px/ms 且位移 ≥48px）都关闭；
// 高度未知（拖拽时未传入）时用绝对兜底阈值。数字定稿供实现与测试共用。
export const DRAG_CLOSE_RATIO = 0.28;
export const DRAG_V_CLOSE_PXMS = 0.55;
export const DRAG_MIN_TRANSLATE = 48;
export const DRAG_FALLBACK_TRANSLATE = 160;

// 只允许向下位移（负值 clamp 到 0，向上拖不动面板）。
export function clampTranslateY(v) {
  return Math.max(0, Number(v) || 0);
}

export function dragDecision({ translateY, velocityY, height } = {}) {
  const dy = clampTranslateY(translateY);
  const vy = Number(velocityY) || 0;
  const h = Number(height) || 0;
  const byDistance = h > 0 ? dy >= h * DRAG_CLOSE_RATIO - 1e-9 : dy >= DRAG_FALLBACK_TRANSLATE;
  const byFling = vy >= DRAG_V_CLOSE_PXMS && dy >= DRAG_MIN_TRANSLATE;
  return byDistance || byFling ? 'close' : 'settle';
}

// 拖拽序列：beginDrag(仅 open 态) → moveDrag(位移/速度) → endDrag(清除拖拽并给出 close|settle)。
export function beginDrag(state, y, height = 0) {
  if (state.phase !== 'open') return no(state, 'drag requires open phase');
  return ok({
    ...state,
    drag: { startY: y, lastY: y, lastT: 0, translateY: 0, velocityY: 0, height: Number(height) || 0 },
  });
}

export function moveDrag(state, y, t) {
  if (!state.drag) return no(state, 'no active drag');
  const d = state.drag;
  const dt = Number(t) - d.lastT;
  const velocityY = dt > 0 ? (y - d.lastY) / dt : d.velocityY;
  return ok({
    ...state,
    drag: { ...d, lastY: y, lastT: Number(t), translateY: clampTranslateY(y - d.startY), velocityY },
  });
}

export function endDrag(state) {
  if (!state.drag) return no(state, 'no active drag');
  const d = state.drag;
  const decision = dragDecision({ translateY: d.translateY, velocityY: d.velocityY, height: d.height });
  return { ok: true, state: { ...state, drag: null }, decision };
}

// —— 焦点循环（SPEC §3：焦点管理——陷阱 + 还原）——
// 原生可聚焦元素（排除 disabled/hidden/负 tabindex）。
export const FOCUSABLE_SELECTOR = [
  'a[href]:not([disabled]):not([hidden])',
  'button:not([disabled]):not([hidden])',
  'input:not([disabled]):not([hidden]):not([type="hidden"])',
  'select:not([disabled]):not([hidden])',
  'textarea:not([disabled]):not([hidden])',
  '[tabindex]:not([tabindex^="-"]):not([disabled]):not([hidden])',
].join(',');

// Tab 循环序号：wrap 前后向；无当前焦点（-1）时前向到第一个、后向到最后一个；空集合 → -1。
export function nextTabIndex(current, count, backward = false) {
  if (!Number.isInteger(count) || count <= 0) return -1;
  if (count === 1) return 0;
  const cur = Number.isInteger(current) ? current : -1;
  if (cur < 0) return backward ? count - 1 : 0;
  return (cur + (backward ? -1 : 1) + count) % count;
}

// —— DOM 装配 ——
export function prefersReducedMotion(win) {
  return typeof win?.matchMedia === 'function' && win.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

const SHEET_STYLE_ID = 'voice-sheet-styles';

export function ensureVoiceSheetStyles(doc = globalThis.document) {
  if (!doc || doc.getElementById(SHEET_STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = SHEET_STYLE_ID;
  style.textContent = `
.vs-root{position:fixed;inset:0;z-index:80;font-family:${token('--font')};display:none}
.vs-root.vs-on{display:block}
.vs-scrim{position:absolute;inset:0;background:rgba(37,39,34,.38);opacity:0;transition:opacity .26s ease;border:0;padding:0}
.vs-root.vs-open .vs-scrim{opacity:1}
.vs-panel{position:absolute;left:0;right:0;bottom:0;background:${token('--surface')};border-radius:28px 28px 0 0;
  box-shadow:0 -10px 40px rgba(0,0,0,.12);padding:10px 22px 26px;display:flex;flex-direction:column;
  max-height:min(92dvh,760px);transform:translateY(100%);transition:transform .3s cubic-bezier(.2,.8,.2,1)}
.vs-root.vs-open .vs-panel{transform:none}
.vs-grip{padding:6px 0 10px;cursor:grab;touch-action:none;min-height:32px;display:flex;justify-content:center;align-items:center}
.vs-grip::before{content:"";display:block;width:40px;height:5px;border-radius:3px;background:${token('--line')}}
.vs-grip.vs-grabbing{cursor:grabbing}
.vs-body{overflow:auto;overscroll-behavior:contain;min-height:0;display:flex;flex-direction:column;flex:1}
.vs-panel.vs-dragging{transition:none!important}
/* 桌面端：居中弹窗（SPEC §3） */
.vs-root[data-variant="modal"] .vs-panel{left:50%;right:auto;top:50%;bottom:auto;width:min(560px,calc(100vw - 48px));
  max-height:min(86dvh,760px);border-radius:${token('--r-lg')};box-shadow:${token('--shadow')};
  transform:translate(-50%,-46%) scale(.97);transition:transform .22s cubic-bezier(.2,.8,.2,1),opacity .22s ease;opacity:0}
.vs-root[data-variant="modal"].vs-open .vs-panel{transform:translate(-50%,-50%) scale(1);opacity:1}
.vs-root[data-variant="modal"] .vs-grip{display:none}
@media (prefers-reduced-motion:reduce){
  .vs-panel,.vs-scrim{transition:none!important}
  .vs-panel *{animation:none!important}
}`;
  doc.head.appendChild(style);
}

/**
 * 创建弹层容器（bottom sheet；≥ desktopQuery 时居中弹窗）。
 * opts: { label='语音输入', onDismiss(reason), onOpen(), dismissOnScrim=true,
 *         desktopQuery='(min-width:900px)', gesture=true }
 * 返回控制器：{ element, scrim, panel, open(content)->Promise, close(reason), isOpen, destroy }
 * 焦点管理：打开时记录 document.activeElement 并把焦点移入弹层；Tab 在弹层内循环（陷阱）；
 * 关闭（scrim 点击 / Escape / 下拉 / 编程调用）后焦点还原到打开前的元素。
 */
export function createVoiceSheet(opts = {}) {
  if (typeof document === 'undefined') {
    throw new TypeError('createVoiceSheet requires a DOM document');
  }
  const { label = '语音输入', onDismiss, onOpen, dismissOnScrim = true, desktopQuery = '(min-width: 900px)', gesture = true } = opts;
  ensureVoiceSheetStyles(document);

  const root = document.createElement('div');
  root.className = 'vs-root';
  const scrim = document.createElement('button');
  scrim.type = 'button';
  scrim.className = 'vs-scrim';
  scrim.setAttribute('aria-label', '关闭');
  const panel = document.createElement('div');
  panel.className = 'vs-panel';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'true');
  panel.setAttribute('aria-label', label);
  panel.tabIndex = -1;
  const grip = document.createElement('div');
  grip.className = 'vs-grip';
  const body = document.createElement('div');
  body.className = 'vs-body';
  panel.append(grip, body);
  root.append(scrim, panel);
  document.body.appendChild(root);

  let machine = createSheetState();
  let prevFocus = null;
  let prevOverflow = '';
  let dismissReason = null;
  const reduced = () => prefersReducedMotion(window);
  const mq = window.matchMedia(desktopQuery);
  const applyVariant = () => { root.dataset.variant = mq.matches ? 'modal' : 'sheet'; };
  applyVariant();
  mq.addEventListener?.('change', applyVariant);

  const visibleFocusables = () =>
    Array.from(panel.querySelectorAll(FOCUSABLE_SELECTOR)).filter((el) => {
      const rects = el.getClientRects();
      if (rects.length === 0) return false;
      const cs = getComputedStyle(el);
      return cs.visibility !== 'hidden' && cs.display !== 'none';
    });

  const onKeydown = (e) => {
    if (machine.phase !== 'open' && machine.phase !== 'opening') return;
    if (e.key === 'Escape') {
      e.preventDefault();
      close('escape');
      return;
    }
    if (e.key === 'Tab') {
      const focusables = visibleFocusables();
      if (focusables.length === 0) {
        e.preventDefault();
        panel.focus();
        return;
      }
      const current = focusables.indexOf(document.activeElement);
      const next = nextTabIndex(current, focusables.length, e.shiftKey);
      e.preventDefault();
      focusables[next].focus();
    }
  };

  const focusIn = () => {
    const first = visibleFocusables()[0];
    (first || panel).focus({ preventScroll: true });
  };

  const lockScroll = () => {
    prevOverflow = document.documentElement.style.overflow;
    document.documentElement.style.overflow = 'hidden';
  };
  const unlockScroll = () => {
    document.documentElement.style.overflow = prevOverflow;
  };

  const afterTransition = (node, propertyName, fn) => {
    if (reduced()) {
      fn();
      return;
    }
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      node.removeEventListener('transitionend', onEnd);
      fn();
    };
    const onEnd = (e) => {
      if (e.target === node && e.propertyName === propertyName) finish();
    };
    node.addEventListener('transitionend', onEnd);
    setTimeout(finish, 450); // 兜底：transitionend 丢失（标签页切走等）
  };

  function open(content) {
    if (machine.phase !== 'closed') return Promise.resolve(false);
    if (content) {
      body.replaceChildren();
      body.appendChild(content);
    }
    prevFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dismissReason = null;
    machine = openSheet(machine).state;
    lockScroll();
    document.addEventListener('keydown', onKeydown, true);
    root.classList.add('vs-on');
    requestAnimationFrame(() => {
      root.classList.add('vs-open');
      afterTransition(panel, 'transform', () => {
        machine = finishOpening(machine).state;
        focusIn();
        onOpen?.();
      });
    });
    return Promise.resolve(true);
  }

  function close(reason = 'programmatic') {
    if (machine.phase !== 'open' && machine.phase !== 'opening') return;
    dismissReason = reason;
    const finish = () => {
      machine = finishClose(machine).state;
      document.removeEventListener('keydown', onKeydown, true);
      root.classList.remove('vs-open');
      unlockScroll();
      // 焦点还原（SPEC §3 焦点管理）：打开前焦点还在文档里就还回去。
      if (prevFocus && document.contains(prevFocus)) prevFocus.focus({ preventScroll: true });
      prevFocus = null;
      onDismiss?.(dismissReason);
    };
    machine = beginClose(machine).state;
    afterTransition(panel, 'transform', () => {
      root.classList.remove('vs-on');
      finish();
    });
  }

  scrim.addEventListener('click', () => {
    if (dismissOnScrim) close('scrim');
  });

  // —— 下拉关闭手势（grab 区；桌面 modal 不启用）——
  if (gesture) {
    let dragging = null;
    grip.addEventListener('pointerdown', (e) => {
      if (root.dataset.variant === 'modal' || machine.phase !== 'open') return;
      dragging = e.pointerId;
      grip.setPointerCapture(e.pointerId);
      grip.classList.add('vs-grabbing');
      panel.classList.add('vs-dragging');
      const r = beginDrag(machine, e.clientY, panel.offsetHeight);
      if (r.ok) machine = r.state;
      e.preventDefault();
    });
    grip.addEventListener('pointermove', (e) => {
      if (dragging !== e.pointerId || !machine.drag) return;
      const r = moveDrag(machine, e.clientY, e.timeStamp);
      if (r.ok) {
        machine = r.state;
        panel.style.transform = `translateY(${machine.drag.translateY}px)`;
      }
    });
    const release = (e) => {
      if (dragging !== e.pointerId) return;
      dragging = null;
      grip.classList.remove('vs-grabbing');
      if (!machine.drag) return;
      const r = endDrag(machine);
      machine = r.state;
      if (r.decision === 'close') {
        panel.style.transform = 'translateY(100%)';
        panel.classList.remove('vs-dragging');
        close('drag');
      } else {
        panel.style.transform = '';
        panel.classList.remove('vs-dragging');
      }
    };
    grip.addEventListener('pointerup', release);
    grip.addEventListener('pointercancel', release);
  }

  function destroy() {
    document.removeEventListener('keydown', onKeydown, true);
    mq.removeEventListener?.('change', applyVariant);
    if (machine.phase !== 'closed') {
      machine = createSheetState();
      unlockScroll();
    }
    root.remove();
  }

  return {
    element: root,
    scrim,
    panel,
    open,
    close,
    get isOpen() {
      return machine.phase === 'open' || machine.phase === 'opening';
    },
    destroy,
  };
}
