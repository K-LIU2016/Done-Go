// web/voice/transcript-view.js — Done-Go 语音 → 意图 → 日程 · V3 转写视图（增量渲染）
// 唯一标准：design/voice-intent/SPEC.md
//   §3 transcript-view.js：只增量渲染；已确认的前缀保持稳定，只更新尾部的灰字；
//        新字逐字浮现；final 到来时该句由灰转黑（settle 动画 320ms）；光标闪烁；
//        不允许整段闪烁重排；尊重 prefers-reduced-motion
//   §4 视觉 token（--vt-* / --p1..--p5，同名 CSS 变量定义在 web/voice/voice.css）
//   原型：design/voice-intent/prototype.html ①屏 —— .tx > .f(.just) + .p > .ch + .caret
// 契约：消费 web/voice/contracts.js（commit 77a59d5）的转录状态
//   （initTranscriptState / applyServerMessage 的产物 {segments:[{seg,text,final}], done, error}），
//   不重复实现 WS 协议或 seg 合并语义。
//
// 结构（类名供 web/voice/lab.html 等复用，样式全部在 voice.css）：
//   <p class="vt-transcript [vt-motion-off] [vt-done] [vt-error]">
//     <span class="vt-final [vt-just]" data-seg="0">已确认黑字…</span>   ← 原型 .f / .f.just
//     <span class="vt-partial" data-seg="2">                            ← 原型 .p
//       <span class="vt-ch [vt-in]">晚</span>…                           ← 原型 .ch（vt-in=逐字浮现）
//     </span>
//     <span class="vt-caret" aria-hidden="true"></span>                  ← 原型 .caret（闪烁 + 尾字呼吸）
//   </p>
// 渲染器只用 createElement/appendChild/insertBefore/removeChild/classList/textContent/dataset，
// 便于 Node 假 DOM 单测（tests/unit/voice-transcript-view.test.mjs 断言前缀节点同一性）。

import { transcriptView } from './contracts.js';

// —— 动画类名（prefers-reduced-motion 时不加；voice.css 另有 @media 与 .vt-motion-off 兜底）——
export const MOTION_CLASSES = Object.freeze({
  charIn: 'vt-in', // 新字逐字浮现（原型 rise .18s ease-out）
  settle: 'vt-just', // final 灰转黑（原型 settle .32s ease-out）
  motionOff: 'vt-motion-off', // reduced-motion 降级标记
});

// prefers-reduced-motion 探测：无 window / matchMedia 抛错的环境一律 false（样式层还有媒体查询兜底）。
export function prefersReducedMotion(win) {
  const w = win ?? (typeof window === 'undefined' ? null : window);
  try {
    if (w && typeof w.matchMedia === 'function') {
      return !!w.matchMedia('(prefers-reduced-motion: reduce)').matches;
    }
  } catch {
    /* 探测失败按未降级处理 */
  }
  return false;
}

// —— 字符级公共前缀 diff（按 Unicode 码位比较，代理对不被拆开）——
// prev → next 的最小改动：保留前 keep 个已有节点、追加 add、移除尾部 remove 个节点。
export function diffChars(prev, next) {
  const p = Array.from(prev ?? '');
  const n = Array.from(next ?? '');
  let keep = 0;
  const max = Math.min(p.length, n.length);
  while (keep < max && p[keep] === n[keep]) keep++;
  return { keep, add: n.slice(keep).join(''), remove: p.length - keep };
}

// —— 渲染计划（纯函数）：对比上一帧 / 下一帧 segments，产出最小 DOM 操作集 ——
// prev/next 均为契约 segments（[{seg, text, final}]，seg 升序）：
//   untouched    已确认且文本未变 → 节点必须原样保留（不重建、不改类名、不改文本）＝「前缀稳定」
//   reviseFinal  重复 final 但文本变化 → 原节点原位改文本（契约「幂等替换」，不重建整树）
//   finalize     本帧由灰转定稿 → 新建 .vt-final + settle 动画类
//   createFinal  新出现且已定稿 → 新建 .vt-final + settle 动画类
//   partialOps   未定稿句的字符级增量（keep/add/remove；create=本帧新建灰字组）
//   drop         上一帧有、本帧没有的 seg（契约下不应出现；防御性移除）
//   stablePrefix 从头起无需任何 DOM 操作的已确认句数（增量渲染核心指标）
export function planTranscript(prevSegs, nextSegs) {
  const prev = Array.isArray(prevSegs) ? prevSegs : [];
  const next = Array.isArray(nextSegs) ? nextSegs : [];
  const prevBySeg = new Map(prev.map((s) => [s.seg, s]));
  const nextBySeg = new Map(next.map((s) => [s.seg, s]));
  const untouched = [];
  const reviseFinal = [];
  const finalize = [];
  const createFinal = [];
  const partialOps = [];
  const drop = [];
  for (const s of next) {
    const p = prevBySeg.get(s.seg);
    if (s.final) {
      if (!p) createFinal.push({ seg: s.seg, text: s.text });
      else if (p.final) (p.text === s.text ? untouched : reviseFinal).push({ seg: s.seg, text: s.text });
      else finalize.push({ seg: s.seg, text: s.text });
    } else {
      const prevText = p && !p.final ? p.text : '';
      const d = diffChars(prevText, s.text);
      partialOps.push({ seg: s.seg, text: s.text, keep: d.keep, add: d.add, remove: d.remove, create: !p });
    }
  }
  for (const s of prev) if (!nextBySeg.has(s.seg)) drop.push(s.seg);
  let stablePrefix = 0;
  for (const s of next) {
    const p = prevBySeg.get(s.seg);
    if (s.final && p && p.final && p.text === s.text) stablePrefix++;
    else break;
  }
  return { untouched, reviseFinal, finalize, createFinal, partialOps, drop, stablePrefix };
}

// —— DOM 渲染器 ——
// createTranscriptView({doc, reducedMotion, className}) → { el, update(state), reset(), text() }
//   el          根节点 <p class="vt-transcript">（原型 .tx），由调用方挂载
//   update(st)  消费契约转录状态；已确认前缀节点绝不重建（同一对象跨帧保持，见单测）
//   reset()     清空全部句子与终态类，光标复位，可复用
//   text()      当前全部文本（黑 + 灰拼接），直接走 contracts.transcriptView
export function createTranscriptView({ doc, reducedMotion, className } = {}) {
  const d = doc ?? (typeof document === 'undefined' ? null : document);
  if (!d || typeof d.createElement !== 'function') {
    throw new Error('createTranscriptView: 需要 DOM Document（传 doc 参数或在浏览器环境使用）');
  }
  const noMotion = reducedMotion ?? prefersReducedMotion();

  const root = d.createElement('p');
  root.className = 'vt-transcript' + (className ? ' ' + className : '');
  if (noMotion) root.classList.add(MOTION_CLASSES.motionOff);

  const caret = d.createElement('span');
  caret.className = 'vt-caret';
  caret.ariaHidden = 'true';
  root.appendChild(caret); // 光标恒为最后一个子节点（会话结束才移除）

  let segs = []; // 上一帧契约 segments 快照（{seg,text,final} 拷贝）
  const els = new Map(); // seg → 该句根节点（.vt-final / .vt-partial）
  const chars = new Map(); // seg → [.vt-ch 节点]（仅灰字句）
  let order = []; // 已渲染 seg 升序，决定插入位置

  function place(el, seg) {
    // 按 seg 升序插到「第一个更大 seg 的节点」之前；没有更大的则插到光标前（即末尾）。
    let ref = null;
    if (caret.parentNode === root) ref = caret;
    for (const s of order) {
      if (s > seg) {
        const e = els.get(s);
        if (e) { ref = e; break; }
      }
    }
    if (ref) root.insertBefore(el, ref);
    else root.appendChild(el);
    order.push(seg);
    order.sort((a, b) => a - b);
    els.set(seg, el);
  }
  function dropSeg(seg) {
    const el = els.get(seg);
    if (el) el.remove();
    els.delete(seg);
    chars.delete(seg);
    order = order.filter((s) => s !== seg);
  }
  function makeFinal(seg, text) {
    const el = d.createElement('span');
    el.className = 'vt-final';
    el.dataset.seg = String(seg);
    el.textContent = text;
    if (!noMotion) el.classList.add(MOTION_CLASSES.settle); // 灰转黑 settle（原型 .f.just）
    return el;
  }

  return {
    el: root,
    update(state) {
      if (!state || !Array.isArray(state.segments)) {
        throw new Error('update: 期望契约转录状态 {segments:[{seg,text,final}…], done, error}');
      }
      const plan = planTranscript(segs, state.segments);

      for (const seg of plan.drop) dropSeg(seg);

      for (const f of plan.reviseFinal) {
        // 幂等替换：原节点原位改文本（前缀之外的定稿句被更正，仍不重建整树）
        const el = els.get(f.seg);
        if (el) el.textContent = f.text;
      }

      for (const f of plan.finalize) dropSeg(f.seg); // 灰字组让位（含防御性清理）
      for (const f of [...plan.finalize, ...plan.createFinal]) {
        place(makeFinal(f.seg, f.text), f.seg);
      }

      for (const op of plan.partialOps) {
        let group = els.get(op.seg);
        if (!op.create && (!group || !group.classList.contains('vt-partial'))) {
          dropSeg(op.seg); // 防御：上一帧不是灰字组（契约下不应发生）→ 重建灰字组
          group = null;
        }
        if (!group) {
          group = d.createElement('span');
          group.className = 'vt-partial';
          group.dataset.seg = String(op.seg);
          place(group, op.seg);
          chars.set(op.seg, []);
        }
        const nodes = chars.get(op.seg) || [];
        let remove = op.remove;
        while (remove > 0 && nodes.length > 0) { // 在线改口：只回退尾部多余字符
          nodes.pop().remove();
          remove--;
        }
        for (const ch of Array.from(op.add)) { // 逐字浮现：只为新字建节点（旧字节点绝不重建）
          const c = d.createElement('span');
          c.className = 'vt-ch';
          c.textContent = ch;
          if (!noMotion) c.classList.add(MOTION_CLASSES.charIn);
          group.appendChild(c);
          nodes.push(c);
        }
        chars.set(op.seg, nodes);
      }

      if (state.done) {
        root.classList.add('vt-done');
        if (caret.parentNode === root) root.removeChild(caret); // 说完：光标退场
      }
      if (state.error) {
        root.classList.add('vt-error');
        root.dataset.error = String(state.error);
      }

      segs = state.segments.map((s) => ({ seg: s.seg, text: s.text, final: s.final }));
    },
    reset() {
      for (const seg of [...order]) dropSeg(seg);
      root.classList.remove('vt-done', 'vt-error');
      delete root.dataset.error;
      segs = [];
      if (caret.parentNode !== root) root.appendChild(caret);
    },
    text() {
      const view = transcriptView({ segments: segs, done: false, error: null });
      return view.finalText + view.partialText;
    },
  };
}
