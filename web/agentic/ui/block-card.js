// M05 交付徽标 + 块卡列表（#today 日程卡列表）
// 结构照 prototype.html（唯一视觉标准）：
//   button.block[data-b]（prototype L345：sel 选中态 + border-left-color 按 kind）
//     > .t 时间（start–end，U+2013）/ .ttl 标题 + span.dot.<status>（L338-340/L347）
//     > .chips：类型 chip + 可交付度 chip.hi|chip.mid（L250-251/L348）
//               + 「需要你 N」chip.you + 状态 chip（statusText L342）
//   状态五态 prep/live/need/ready/done 对应 .dot.* （L58-64，pulse 动画在 M01 agentic.css）
// PRD §5.1：交付徽标 = 类型图标 + 可交付度 + 状态点 + "需要你 N" 角标。
// 分层：纯核（HTML 字符串纯函数，node --test 可测）+ DOM 壳 mount/update（增量逐卡打补丁，
// PRD §5.2 末教训：整块重绘会丢按钮/展开态——块集合不变时绝不重写容器）。
// 依赖：M01 web/agentic/ui/utils.js 的 esc/setHTML（五实体转义 / 内容比对跳过重写）。

// M01 utils.js 已落地为硬依赖：esc/setHTML 直引共享实现，单一来源
//（并行落地期的「动态探测 + 本地同规则兜底」已收编，组件顶层 await 随之移除）。
import { esc, setHTML } from './utils.js';

export { esc, setHTML }; // 保持既有 re-export 导入面（单测/组件页按组件模块导入）

const txt = (v) => esc(v ?? '');

/** 状态五态（prototype L58-64 .dot.prep/.live/.need/.ready/.done） */
export const STATUSES = ['prep', 'live', 'need', 'ready', 'done'];

/** 状态 → chip 文案（prototype L342 原样） */
export const STATUS_TEXT = {
  prep: '准备中', live: '进行中', need: '需要你', ready: '待验收', done: '已交付',
};

/** kind → 左边条色（prototype L256 kindColor 原样，CSS 变量 --k-*） */
export const KIND_COLOR = {
  explore: 'var(--k-explore)', create: 'var(--k-create)', connect: 'var(--k-connect)',
  restore: 'var(--k-restore)', stillness: 'var(--k-stillness)',
};

/** 左条色查询；未知/缺省 kind 回退 explore（与 .block 的 CSS 默认条色一致，绝不输出 undefined） */
export function kindColorOf(kind) {
  return KIND_COLOR[kind] ?? KIND_COLOR.explore;
}

/**
 * 「需要你 N」未决数：pending 映射（blockId → N）优先——显式 0 也压过块上的 needs
 * （spec：pending {r:0} 时 r 不出角标）；映射缺该键或无映射时回退 block.needs（PRD §3.2 +3s 行）。
 */
export function pendingCount(block, pending) {
  const id = block?.id;
  const fromMap = pending?.[id];
  if (fromMap !== undefined && fromMap !== null) return fromMap;
  return block?.needs ?? 0;
}

/** 块状态查询：status 映射（blockId → 'prep'|…）；缺省/非字符串 → ''（无状态） */
export function statusOf(block, status) {
  const s = status?.[block?.id];
  return typeof s === 'string' ? s : '';
}

/** 状态点：有状态输出 span.dot.<status>（pulse 动画由 M01 CSS 按 .dot.* 挂，rm 降级同在 CSS 层） */
export function dotHTML(status) {
  return status ? `<span class="dot ${esc(status)}"></span>` : '';
}

/** 时间行：start–end（U+2013 en dash，prototype L346） */
export function timeHTML(block) {
  return `${txt(block?.start)}–${txt(block?.end)}`;
}

/**
 * chips 行（prototype L348 顺序）：类型 chip → 可交付度 chip（feas=[档位,文案]，档位空则无类）
 * → 「需要你 N」chip.you（N>0 才出）→ 状态 chip（STATUS_TEXT 查不到不出，绝不渲染 undefined）。
 */
export function chipsHTML(block, ctx) {
  const b = block ?? {};
  const feas = Array.isArray(b.feas) ? b.feas : [];
  const feasChip = feas[1]
    ? `<span class="chip${feas[0] ? ` ${txt(feas[0])}` : ''}">${txt(feas[1])}</span>`
    : '';
  const n = pendingCount(b, ctx?.pending);
  const youChip = n > 0 ? `<span class="chip you">需要你 ${txt(n)}</span>` : '';
  const st = STATUS_TEXT[statusOf(b, ctx?.status)];
  const stChip = st ? `<span class="chip">${esc(st)}</span>` : '';
  return `<span class="chip">${txt(b.type)}</span>${feasChip}${youChip}${stChip}`;
}

/** 单卡完整 HTML（prototype L345-350）；ctx = { sel, status, pending } */
export function cardHTML(block, ctx) {
  const b = block ?? {};
  const sel = ctx?.sel === b.id ? ' sel' : '';
  return `<button type="button" class="block${sel}" data-b="${txt(b.id)}" style="border-left-color:${kindColorOf(b.kind)}">`
    + `<span class="t">${timeHTML(b)}</span>`
    + `<span class="ttl">${dotHTML(statusOf(b, ctx?.status))}${txt(b.title)}</span>`
    + `<span class="chips">${chipsHTML(b, ctx)}</span>`
    + `</button>`;
}

/** 列表：逐卡连接，null/undefined 条目过滤 */
export function listHTML(blocks, ctx) {
  return (Array.isArray(blocks) ? blocks : []).filter(Boolean).map((b) => cardHTML(b, ctx)).join('');
}

/** 块集合签名（ids 顺序）：变了才整列表重绘 */
function signature(blocks) {
  return (Array.isArray(blocks) ? blocks : []).filter(Boolean).map((b) => b.id).join('\u0000');
}

/**
 * 逐卡打补丁：只改类名/条色/子片段（setHTML 内容比对），按钮节点永不重建。
 * 返回 false = 无法补丁（容器查不到卡/缺卡/空集合），由调用方兜底整列表 setHTML。
 */
function patchCards(el, blocks, state) {
  if (typeof el?.querySelectorAll !== 'function') return false;
  const usable = blocks.filter(Boolean);
  if (usable.length === 0) return false; // 空集合交给整绘清空
  const nodes = new Map();
  for (const n of el.querySelectorAll('button.block')) nodes.set(n.dataset.b, n);
  for (const b of usable) {
    const btn = nodes.get(b.id);
    if (!btn) return false; // 卡节点缺失（宿主 DOM 被外部改动）→ 兜底整绘
    const cls = `block${state.sel === b.id ? ' sel' : ''}`;
    if (btn.className !== cls) btn.className = cls;
    if (btn.style) btn.style.borderLeftColor = kindColorOf(b.kind);
    const t = btn.querySelector('.t');
    if (t) setHTML(t, timeHTML(b));
    const ttl = btn.querySelector('.ttl');
    if (ttl) setHTML(ttl, dotHTML(statusOf(b, state.status)) + txt(b.title));
    const chips = btn.querySelector('.chips');
    if (chips) setHTML(chips, chipsHTML(b, state));
  }
  return true;
}

/**
 * DOM 壳（组件页 ?c=block-card / demo 装配）：mount(el, props) → handle。
 * props = { blocks, sel, status, pending, onSelect }；update(props) 合并语义（未传键不动旧值），
 * 链式返回 handle。增量：ids 签名不变 → 逐卡补丁（容器不整绘）；变了/补不了 → 整列表 setHTML。
 * 点击走容器级事件委托（单监听，整绘不丢回调）。
 */
export function mount(el, props) {
  const state = { blocks: [], sel: undefined, status: {}, pending: undefined, onSelect: null };
  let sig = null;

  const merge = (p) => {
    if (!p || typeof p !== 'object') return;
    if ('blocks' in p) state.blocks = Array.isArray(p.blocks) ? p.blocks : [];
    if ('sel' in p) state.sel = p.sel;
    if ('status' in p) state.status = p.status && typeof p.status === 'object' ? p.status : {};
    if ('pending' in p) state.pending = p.pending && typeof p.pending === 'object' ? p.pending : undefined;
    if ('onSelect' in p) state.onSelect = typeof p.onSelect === 'function' ? p.onSelect : null;
  };

  const apply = (p) => {
    merge(p);
    const next = signature(state.blocks);
    if (next === sig && patchCards(el, state.blocks, state)) return; // 补丁成功：容器不动
    sig = next;
    setHTML(el, listHTML(state.blocks, state));
  };

  if (typeof el?.addEventListener === 'function') {
    el.addEventListener('click', (e) => {
      const btn = e?.target?.closest?.('button.block');
      const id = btn?.dataset?.b;
      if (typeof id === 'string' && typeof state.onSelect === 'function') state.onSelect(id);
    });
  }

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
