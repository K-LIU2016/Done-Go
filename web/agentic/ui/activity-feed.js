// M12 · 活动流（可展开「为什么」）—— cost 行 + 倒序 feed + details 原生展开（纯核 + DOM 壳）
// 依据：PRD §5.4（L291 故事层：块抽屉"进行中"= 按时间排列的活动流，每条可展开看依据
//   与产出片段；顶部是该块的 agent 树与花费表）+ §10.6（L810-812：条目必须能回答
//   「做了什么、为什么、产出在哪」，不能回答的不展示；模型调用汇总为次数，免费显示
//   "免费"）+ §5.2 末「原型实测教训」（L275：整块重绘会让展开的"为什么"被收起——
//   本组件增量硬约束来源）；
//   prototype.html（唯一视觉标准）L117-124（.feed max-height 360 滚动 / .it 三列
//   48px 24px 1fr / .it.new → animation: rise / time tabular-nums / details summary /
//   .why 12px / @keyframes rise / .cost 三段 flex）、L185（reduced-motion 禁动画）、
//   L342（statusText）+L475（cost 三 span：agent：… / 模型调用 N 次 · 免费 / 状态，
//   缺省 无 / 等待开始）、L471-477（renderLive：未签约空态文案原文 / items
//   slice().reverse() 倒序、i===0 加 new / why 用 details>summary + .why「为什么：…」/

//   空列表「还没开始。」）。
// 契约（tests/agentic/ui/activity-feed.spec.ts 组件页 + unit/activity-feed.test.mjs 纯核/壳桩）：
//   mount(el, { signed, cost, items }) → handle{ el, update(props) }
//   signed=false → 只出空态文案（prototype L474 原文）；
//   cost = { agents, calls, status }（缺省兜底：无 / 0 / 等待开始）；
//   items = { t, icon, text, why? }[]（按时间正序给入，渲染最新在前）。
// 增量硬约束（spec「追加不重排旧行 + data-marker 保留」）：壳（.cost + .feed）只在签约
//   首绘写一次；此后 update 只 ①setHTML 打 .cost 子区（内容比对）②对已知行做内容补丁
//   （why/icon 变才写该行 innerHTML）③新条目一批 insertAdjacentHTML('afterbegin') 前插、
//   旧行节点/顺序/属性/展开态全保留 ④.items 收缩时 remove 对应行。条目身份键 = t+\u0001+text
//   （why 只是内容：why 变 = 补丁同一条行，不新增行不重排）。.new（rise 入场）只挂最新
//   一条，追加时从原最新条摘下；reduced-motion 下 media query 压掉动画。
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
/** 五实体转义（M01 XSS 基线）：外部字符串入 HTML/属性必经 */
export const esc = escShared ?? ((s) => String(s).replace(/[&<>"']/g, (c) => ESC_MAP[c]));
/** 内容没变就不重写 DOM（prototype L328：增量更新基石） */
export const setHTML = setHTMLShared ?? ((el, html) => {
  if (!el || el._h === html) return false;
  el._h = html;
  el.innerHTML = html;
  return true;
});

// ---------- 常量（prototype L474/L476/L475/L342 原文）与状态归一 ----------

export const FEED_EMPTY_TEXT = '签约后，这里会实时显示每个 agent 在做什么、为什么、产出在哪。';
export const FEED_IDLE_TEXT = '还没开始。';
export const COST_AGENTS_NONE = '无';
export const COST_STATUS_IDLE = '等待开始';

/** cost 归一：{ agents, calls, status }（calls 归非负整数；缺省兜底 无/0/等待开始）；非对象一律 null */
export function normalizeCost(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const n = Number(v.calls);
  return {
    agents: typeof v.agents === 'string' && v.agents.trim() ? v.agents.trim() : COST_AGENTS_NONE,
    calls: Number.isFinite(n) && n > 0 ? Math.floor(n) : 0,
    status: typeof v.status === 'string' && v.status.trim() ? v.status.trim() : COST_STATUS_IDLE,
  };
}

/** 条目归一：{ t, icon, text, why }（t/text 必填非空、四字段 trim、why 缺省空串）；无效条目 null（PRD §10.6 不展示） */
export function normalizeItem(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const t = typeof v.t === 'string' ? v.t.trim() : '';
  const text = typeof v.text === 'string' ? v.text.trim() : '';
  if (!t || !text) return null;
  return {
    t,
    icon: typeof v.icon === 'string' ? v.icon.trim() : '',
    text,
    why: typeof v.why === 'string' ? v.why.trim() : '',
  };
}

/** 条目列表归一：数组过滤无效项保持给定顺序（按时间正序）；非数组一律 [] */
export function normalizeItems(v) {
  if (!Array.isArray(v)) return [];
  const out = [];
  for (const it of v) {
    const n = normalizeItem(it);
    if (n) out.push(n);
  }
  return out;
}

/** 条目身份键：t+\u0001+text。why/icon 不参与——why 变是对同一行节点补丁，不是新行 */
export function itemKey(item) {
  return `${item.t}\u0001${item.text}`;
}

// ---------- 纯核：结构 HTML（prototype L475-476 原文结构） ----------

/** cost 行内层（宿主 .cost 容器的子树，供增量打补丁）：三 span 原文 */
export function costInner(cost) {
  const c = normalizeCost(cost);
  if (!c) return '';
  return `<span>agent：${esc(c.agents)}</span>`
    + `<span>模型调用 ${c.calls} 次 · 免费</span>`
    + `<span>${esc(c.status)}</span>`;
}

/** 行内层：time + icon + 正文格；有 why 用 details 原生展开（prototype L476 原文，summary=正文） */
export function itemInner(item) {
  const cell = item.why
    ? `<details><summary>${esc(item.text)}</summary><div class="why">为什么：${esc(item.why)}</div></details>`
    : esc(item.text);
  return `<time>${esc(item.t)}</time><span>${esc(item.icon)}</span><div>${cell}</div>`;
}

/** 整行：.it[.new] + data-k 身份键（补丁/删除/测试 marker 的锚点） */
export function rowHTML(item, isNew = false) {
  const cls = isNew ? 'it new' : 'it';
  return `<div class="${cls}" data-k="${esc(itemKey(item))}">${itemInner(item)}</div>`;
}

/** 一批行（按时间正序给入）→ 最新在前的拼接 HTML，.new 只给第一条（prototype L476 反序 + i===0） */
export function feedRowsHTML(items) {
  const list = normalizeItems(items);
  return list.slice().reverse().map((it, i) => rowHTML(it, i === 0)).join('');
}

/** 签约壳：.cost + .feed 两子区（mount 首绘一次，此后只打子区/行级补丁） */
export function liveShellHTML() {
  return '<div class="cost"></div><div class="feed"></div>';
}

/** 未签约空态（prototype L474 原文） */
export function unsignedHTML() {
  return `<p class="muted">${esc(FEED_EMPTY_TEXT)}</p>`;
}

/** 签约但还没有条目（prototype L476 空列表分支原文） */
export function idleHTML() {
  return `<p class="small muted">${esc(FEED_IDLE_TEXT)}</p>`;
}

// ---------- 样式（prototype L117-124 原文 + token 兜底；M01 agentic.css 落地后共存无害） ----------

export const ACTIVITY_CSS = `
.feed { display: grid; gap: 8px; max-height: 360px; overflow: auto; padding-right: 4px; }
.feed .it { display: grid; grid-template-columns: 48px 24px 1fr; gap: 6px; font-size: 13px; }
.feed .it.new { animation: rise .25s ease-out; }
.feed .it time { color: var(--text-2, #5C6B61); font-variant-numeric: tabular-nums; }
.feed .it details summary { cursor: pointer; }
.feed .it .why { color: var(--text-2, #5C6B61); font-size: 12px; margin-top: 2px; }
@keyframes rise { from { opacity: 0; transform: translateY(6px); } }
.cost { display: flex; gap: 14px; font-size: 13px; color: var(--text-2, #5C6B61); margin: 6px 0 10px; flex-wrap: wrap; }
@media (prefers-reduced-motion: reduce) { .feed .it, .feed .it *, .cost, .cost * { animation: none !important; transition: none !important; } }
`;

/** 幂等注入样式；无 DOM 环境（node 纯核）安全返回 false（M06/M07/M10 同款） */
export function ensureStyles(doc) {
  if (!doc || typeof doc.createElement !== 'function') return false;
  if (doc.querySelector('style[data-agentic-activity]')) return false;
  const st = doc.createElement('style');
  st.setAttribute('data-agentic-activity', '');
  st.textContent = ACTIVITY_CSS;
  const head = doc.head || doc.documentElement;
  if (!head || typeof head.appendChild !== 'function') return false;
  head.appendChild(st);
  return true;
}

// ---------- DOM 壳：mount / update ----------

/**
 * 壳（组件页 ?c=activity-feed / demo 装配）：mount(el, props) → handle。
 * props = { signed, cost, items }；update(props) 合并语义（未传键不动旧值），链式返回 handle。
 * 增量：签约首绘壳一次（.cost+.feed）；此后 update 只动 .cost 子区与行级内容——
 *   新条目 insertAdjacentHTML('afterbegin') 前插（旧行节点/顺序/展开态全保留，spec
 *   data-marker 契约），已知行 why/icon 变才补丁该行 innerHTML，items 收缩才 remove；
 *   .new（rise 入场）只挂最新一条并在追加时转移；details/summary 原生展开零 JS。
 * el=null / 宿主缺 querySelector·insertAdjacentHTML：安全降级不抛（M10 同款容忍）。
 */
export function mount(el, props) {
  const state = {
    signed: false, cost: null, items: [],
    rows: null,        // Map<key, rowEl>：已渲染行（null = 未签约首绘过）
    inner: new Map(),  // Map<key, innerHTML>：行内容缓存（内容比对，未变零写）
    newestKey: null,   // 当前 .new 所在行
    idle: false,       // .feed 是否处于「还没开始。」态
  };

  const zone = (sel) => (typeof el?.querySelector === 'function' ? el.querySelector(sel) : null);

  const merge = (p) => {
    if (!p || typeof p !== 'object') return;
    if ('signed' in p) state.signed = !!p.signed;
    if ('cost' in p) state.cost = normalizeCost(p.cost);
    if ('items' in p) state.items = normalizeItems(p.items);
  };

  const paintCost = () => {
    const z = zone('.cost');
    if (z) setHTML(z, costInner(state.cost));
  };

  /** 从 DOM 重控行句柄（prepend 后一次性；dataset/getAttribute 双路取 data-k） */
  const syncRows = () => {
    const z = zone('.feed');
    if (!z || typeof z.querySelectorAll !== 'function') return;
    for (const r of z.querySelectorAll('.it')) {
      const k = r?.dataset?.k ?? (typeof r?.getAttribute === 'function' ? r.getAttribute('data-k') : null);
      if (typeof k === 'string' && k) state.rows.set(k, r);
    }
  };

  /** 一批（按时间正序的）新条目整体前插；.new 给批内最新（=全局最新，正序给入约定） */
  const prepend = (batch) => {
    const z = zone('.feed');
    if (!z || typeof z.insertAdjacentHTML !== 'function') return;
    if (state.idle) {
      setHTML(z, '');
      state.idle = false;
    }
    z.insertAdjacentHTML('afterbegin', feedRowsHTML(batch));
    for (const it of batch) state.inner.set(itemKey(it), itemInner(it));
    state.newestKey = itemKey(batch[batch.length - 1]);
    syncRows();
  };

  const apply = (p) => {
    merge(p);
    if (!state.signed) {
      setHTML(el, unsignedHTML());
      state.rows = null;
      state.inner.clear();
      state.newestKey = null;
      state.idle = false;
      return;
    }
    if (!state.rows) { // 签约首绘：壳一次 + cost 一次 + 全量行一批
      setHTML(el, liveShellHTML());
      state.rows = new Map();
      state.idle = false;
      paintCost();
      if (state.items.length) prepend(state.items);
      else {
        const z = zone('.feed');
        if (z) {
          setHTML(z, idleHTML());
          state.idle = true;
        }
      }
      return;
    }
    // 增量 diff：删 → 补 → 增
    paintCost();
    const want = new Set(state.items.map(itemKey));
    for (const [k, r] of [...state.rows]) {
      if (!want.has(k)) {
        r?.remove?.();
        state.rows.delete(k);
        state.inner.delete(k);
        if (k === state.newestKey) state.newestKey = null;
      }
    }
    for (const it of state.items) {
      const k = itemKey(it);
      const r = state.rows.get(k);
      if (!r) continue;
      const html = itemInner(it);
      if (state.inner.get(k) !== html) {
        setHTML(r, html);
        state.inner.set(k, html);
      }
    }
    const fresh = state.items.filter((it) => !state.rows.has(itemKey(it)));
    if (fresh.length) {
      const prev = state.newestKey ? state.rows.get(state.newestKey) : null;
      if (prev) prev.className = 'it'; // .new 只留最新（prototype L476 i===0 语义）
      prepend(fresh);
    } else if (state.items.length === 0 && state.rows.size === 0) {
      const z = zone('.feed');
      if (z) {
        setHTML(z, idleHTML());
        state.idle = true;
      }
    }
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
