// M03 shape 渲染器注册表（PRD §10.3 blocks[] → HTML 字符串纯函数）
// 契约（tests/agentic/ui/unit/shape-text.test.mjs）：
//   registerShape(type, fn)  注册某 block.type 的渲染器（后者覆盖前者）
//   renderShape(block, ctx)  按 block.type 分发；未知类型降级为纯文本（PRD §10.3 末行）
// 依赖：M01 web/agentic/ui/utils.js 的 esc/setHTML（五实体转义 / 增量重写跳过，
// prototype.html L328-329 模式）。M01 与本模块并行开发：utils.js 尚未落地时用
// 本地同规则兜底，落地后自动改走共享实现（下方动态 import 探测，只探测一次）。
let escShared = null;
let setHTMLShared = null;
try {
  const utils = await import('../utils.js');
  if (typeof utils.esc === 'function') escShared = utils.esc;
  if (typeof utils.setHTML === 'function') setHTMLShared = utils.setHTML;
} catch {
  // utils.js 不存在（M01 未落地）：走本地兜底，规则与 prototype L329 + 五实体一致
}

const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
/** 五实体转义：& < > " '（M01 XSS 基线，所有外部字符串必经） */
export const esc = escShared ?? ((s) => String(s).replace(/[&<>"']/g, (c) => ESC_MAP[c]));

/** 内容没变就不重写 DOM（prototype L328：增量更新基石，保住按钮/展开态/字幕） */
export const setHTML = setHTMLShared ?? ((el, html) => {
  if (el._h === html) return false;
  el._h = html;
  el.innerHTML = html;
  return true;
});

const shapes = new Map();

/** 注册渲染器：fn(block, ctx) → html 字符串（纯函数，无 DOM 访问） */
export function registerShape(type, fn) {
  shapes.set(type, fn);
}

/** 查询已注册渲染器（测试/装配用） */
export function getShape(type) {
  return shapes.get(type);
}

/** 分发渲染；未知类型降级为纯文本（PRD §10.3「未知类型降级为纯文本」） */
export function renderShape(block, ctx) {
  const fn = block ? shapes.get(block.type) : null;
  if (typeof fn === 'function') return fn(block, ctx);
  return unknownShape(block);
}

/** 未知类型：有 text 用 text，否则回退 JSON 投影；一律 esc，绝不透传 HTML */
function unknownShape(block) {
  const raw = block && typeof block.text === 'string' ? block.text : safeJson(block);
  return `<div class="shape-unknown"><p>${esc(raw)}</p></div>`;
}

function safeJson(block) {
  try {
    return JSON.stringify(block, null, 2) ?? '';
  } catch {
    return '';
  }
}
