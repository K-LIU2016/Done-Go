// M13 · 追踪层 —— 等宽 pre span 树（OTel GenAI 命名）+ 纯文本可复制（纯核 + DOM 壳）
// 依据：PRD §10.5 trace 的 span 约定（OTel GenAI 对齐：invoke_agent（Mission/Worker）/
//   execute_tool（工具调用）/ chat（模型调用）/ donego.need（用户触点）；正文不进 span、
//   按需展开）+ prototype.html（唯一视觉标准）L132（.trace 等宽 ui-monospace + 12px +
//   纸底 + white-space:pre + overflow-x:auto）、L490-505（renderTrace：说明段 +
//   多行树：├─/│/└─ 缩进 + invoke_agent/execute_tool/chat/donego.need/merge artifact）。
// 契约（tests/agentic/ui/acceptance.spec.ts 组件页 + unit/acceptance.test.mjs 纯核/壳桩）：
//   mount(el, { traceText }) → { el, update(props) }（合并语义，链式）。
//   traceText = 多行纯文本（一行一个 span 事件，树形缩进字符原样）；组件按行包
//   <span class="ln"> 并以 \n 文本节点连接 —— textContent 与原文逐字节相等（纯文本可复制），
//   行内首 token 命中 PRD §10.5 span 名时补 k-<kind> 类（agent/tool/chat/need/merge）。
// 与原型有意差异（记录）：① prototype 为整段纯文本（L492-505）——组件改一行一 span
//   （结构化钩子，spec「span 树」契约），视觉与 textContent 等价；② k-need/k-merge 行
//   补 you/ok 色（对齐原型「用户触点=you 色 / merge→ready=ok 色」的语义用色，原型 trace
//   未着色）；③ 说明段 class 化（prototype 内联 margin，渲染等价）。
// esc/setHTML 探测 M01 web/agentic/ui/utils.js（同 acceptance/boundaries 并行落地模式），

// M01 utils.js 已落地为硬依赖：esc/setHTML 直引共享实现，单一来源
//（并行落地期的「动态探测 + 本地同规则兜底」已收编，组件顶层 await 随之移除）。
import { esc, setHTML } from './utils.js';

export { esc, setHTML }; // 保持既有 re-export 导入面（单测/组件页按组件模块导入）

// ---------- 常量与归一 ----------

/** 追踪层说明（prototype L491 原文） */
export const TRACE_NOTE = '追踪层（给 JC / 开发者）：span 命名对齐 OpenTelemetry GenAI；正文不进 span，按需展开。';

/** PRD §10.5 span 名 → kind（OTel GenAI 对齐；merge artifact 为原型树根合入事件） */
export const SPAN_KINDS = {
  'invoke_agent': 'agent',
  'execute_tool': 'tool',
  'chat': 'chat',
  'donego.need': 'need',
  'merge': 'merge',
};

/** traceText 归一：字符串原样收下（树形缩进/空白有义，不 trim）；非串归 ''（宁缺勿假） */
export function normalizeTraceText(v) {
  return typeof v === 'string' ? v : '';
}

/** 按行切分（空文本 → ['']，渲染为单个空 span，安全） */
export function traceLines(text) {
  return normalizeTraceText(text).split('\n');
}

/** 行首 token（剥树形前缀 ├─/│/└─/空白后）→ SPAN_KINDS；未知行 '' */
export function spanKindOf(line) {
  if (typeof line !== 'string') return '';
  const m = line.match(/^[\s│├└─]*([A-Za-z_][\w.]*)/);
  return m ? SPAN_KINDS[m[1]] ?? '' : '';
}

// ---------- 纯核：HTML 构建 ----------

/** 单行 span：class ln[ k-<kind>] + data-ln 行号；正文整行 esc（正文不进 span 命名） */
export function lineHTML(line, i) {
  const kind = spanKindOf(line);
  return `<span class="ln${kind ? ` k-${kind}` : ''}" data-ln="${i}">${esc(line)}</span>`;
}

/** .trace 内层：行 span 以 \n 连接（textContent === 原文，纯文本可复制） */
export function traceInner(text) {
  return traceLines(text).map((line, i) => lineHTML(line, i)).join('\n');
}

/** 整壳：说明段 + .trace 容器（prototype L491-492 结构） */
export function traceViewHTML(props = {}) {
  return `<p class="small muted trace-note">${esc(TRACE_NOTE)}</p>`
    + `<div class="trace" data-trace="1">${traceInner(props?.traceText)}</div>`;
}

// ---------- 样式（prototype L132 原文 + token 兜底 + kind 语义色 + reduced-motion） ----------

export const TRACE_CSS = `
.trace-note { margin: 0 0 8px; font-size: 13px; color: var(--text-2, #5C6B61); }
.trace { font-family: ui-monospace, Menlo, monospace; font-size: 12px; background: var(--paper, #FCFBF6); border: 1px solid var(--line, rgba(34,48,42,.14)); border-radius: 10px; padding: 10px; white-space: pre; overflow-x: auto; }
.trace .ln.k-need { color: var(--you, #E95432); }
.trace .ln.k-merge { color: var(--ok, #3F7A55); }
@media (prefers-reduced-motion: reduce) { .trace, .trace * { transition: none !important; animation: none !important; } }
`;

/** 幂等注入样式；无 DOM 环境（node 纯核）安全返回 false（M06/M07/M11 同款） */
export function ensureStyles(doc) {
  if (!doc || typeof doc.createElement !== 'function') return false;
  if (doc.querySelector('style[data-agentic-trace]')) return false;
  const st = doc.createElement('style');
  st.setAttribute('data-agentic-trace', '');
  st.textContent = TRACE_CSS;
  const head = doc.head || doc.documentElement;
  if (!head || typeof head.appendChild !== 'function') return false;
  head.appendChild(st);
  return true;
}

// ---------- DOM 壳：mount / update ----------

/**
 * 壳（组件页 ?c=trace-view / demo 装配）：mount(el, props) → handle。
 * props = { traceText }。增量：壳（说明段 + .trace 容器）只在 mount 写一次；
 *   update 仅 setHTML 打 .trace 子区（内容比对，未变零写）——执行期 trace 追加
 *   只换子区内容，说明段与容器节点保活（PRD §5.2 末教训）。无交互（只读层，
 *   复制走原生文本选择：white-space:pre + textContent 保真）。
 */
export function mount(el, props) {
  const state = { traceText: '' };
  let shellDone = false;

  const merge = (p) => {
    if (!p || typeof p !== 'object') return;
    if ('traceText' in p) state.traceText = normalizeTraceText(p.traceText);
  };

  const zone = (sel) => (typeof el?.querySelector === 'function' ? el.querySelector(sel) : null);

  const renderZones = () => {
    const traceZone = zone('.trace');
    if (traceZone) setHTML(traceZone, traceInner(state.traceText));
  };

  const apply = (p) => {
    merge(p);
    if (!shellDone) {
      setHTML(el, traceViewHTML(state));
      shellDone = true;
    }
    renderZones();
  };

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
