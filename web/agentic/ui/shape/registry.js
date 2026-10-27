// M03 shape 渲染器注册表（PRD §10.3 blocks[] → HTML 字符串纯函数）
// 契约（tests/agentic/ui/unit/shape-text.test.mjs）：
//   registerShape(type, fn)  注册某 block.type 的渲染器（后者覆盖前者）
//   renderShape(block, ctx)  按 block.type 分发；未知类型降级为纯文本（PRD §10.3 末行）
// 依赖：M01 web/agentic/ui/utils.js 的 esc/setHTML（五实体转义 / 增量重写跳过，prototype.html L328-329 模式）。

// M01 utils.js 已落地为硬依赖：esc/setHTML 直引共享实现，单一来源
//（并行落地期的「动态探测 + 本地同规则兜底」已收编，组件顶层 await 随之移除）。
import { esc, setHTML } from '../utils.js';

export { esc, setHTML }; // 保持既有 re-export 导入面（单测/组件页按组件模块导入）

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
