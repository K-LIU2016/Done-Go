// M07 · 预演四档进度 —— 形 ✓ / 样 ✓ / 动 ▶ / 真 三态 chips（纯核 + DOM 壳）
// 依据：PRD §5.2.1 四档生成式预演（L0 形骨架 ≤2s / L1 样样张 ≤8s / L2 动预演片 ≤10s 首帧 /
//   L3 真场景片 2–5 分钟异步，绝不阻塞签约）+ D-9（L3 默认关，用户点「生成场景片」才跑）+
//   §10.3 scene 字段（status: off|queued|generating|ready，默认 off）；
//   prototype.html（唯一视觉标准）L137-140（.tiers/.tier/.ok/.go 样式）、
//   L373-377（tiersHTML 四档 + 真三态原文）、L623-624（data-reel→openReel / data-scene→startScene 委托）。
// 契约（tests/agentic/ui/tiers.spec.ts 组件页 + unit/tiers.test.mjs 纯核/壳桩）：
//   mount(el, { blockId, scene, canScene, secs, onReel, onScene }) → handle
//   handle.update(props) 合并语义（未传键不动旧值），链式返回 handle。
//   scene 收 PRD §10.3 字符串/对象两形态；「动 ▶」点击 → onReel()（M09/M11 预演片入口）；
//   「真 · 生成场景片」点击 → onScene(blockId)（宿主负责起异步任务并驱动 scene-card 进度）。
// 增量：setHTML 内容比对（prototype L328 语义）——四档状态串未变零重写；chips 无内部交互态，
//   状态变化整行重写不丢焦点（与 prototype renderAll 同款；持续态节点保活在 scene-card 侧）。
// esc/setHTML 探测 M01 web/agentic/ui/utils.js（同 registry.js/block-card.js 并行落地模式），未落地本地兜底。
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

// ---------- 常量与状态归一 ----------

/** PRD §10.3 scene.status 四态（顺序即 D-9 默认 off） */
export const SCENE_STATES = ['off', 'queued', 'generating', 'ready'];

/** scene 归一：字符串或 {status} 对象 → 四态；非法/缺省一律 off（D-9：默认关，宁缺勿假） */
export function normalizeScene(v) {
  let s = v;
  if (v && typeof v === 'object' && !Array.isArray(v)) s = v.status;
  if (typeof s !== 'string') return 'off';
  if (s === 'gen') return 'generating'; // prototype L375 内部态别名
  return SCENE_STATES.includes(s) ? s : 'off';
}

/** 该块是否可生成场景片：黄金场景仅 c（prototype L373/375 id === 'c'）；canScene 显式覆盖可开 D2/R1/R3 */
export function canSceneOf(blockId) {
  return blockId === 'c';
}

/** L1 样张耗时文案：c 块 qwen-image-2.0 带字 7.4s，其余 z-image-turbo 3.9s（prototype L376 原文） */
export function sampleSecOf(blockId) {
  return blockId === 'c' ? '7.4s' : '3.9s';
}

// ---------- 纯核：HTML 构建 ----------

const txt = (v) => esc(v ?? '');

/**
 * 「真」档三态 + 不需要（prototype L375 原文）：
 *   可生成块——off→button.tier.go（D-9 生成入口）/ queued·generating→span 生成中…（非按钮防重复触发）
 *   / ready→span.tier.ok ✓；不可生成块一律「真 · 不需要」。
 * canScene 未传（undefined/null）走 canSceneOf 自动判定，显式真假值覆盖（D2/R1/R3 任务开、用户关）。
 */
export function realTierHTML({ blockId, scene, canScene } = {}) {
  const enabled = canScene === undefined || canScene === null ? canSceneOf(blockId) : Boolean(canScene);
  if (!enabled) return '<span class="tier">真 · 不需要</span>';
  const st = normalizeScene(scene);
  if (st === 'ready') return '<span class="tier ok">真 ✓ 场景片</span>';
  if (st === 'queued' || st === 'generating') return '<span class="tier" aria-busy="true">真 · 生成中…</span>';
  return `<button type="button" class="tier go" data-scene="${txt(blockId)}">真 · 生成场景片（约 2 分钟）</button>`;
}

/**
 * 四档 chips 行（prototype L376 原文）：形 ✓ 1.6s / 样 ✓ {7.4s|3.9s} / 动 ▶ 预演片 42s（data-reel）+ 真档。
 * secs = { shape, sample, reel } 可覆盖耗时文案（真实计时/fixtures 注入；缺省照 prototype）。
 */
export function tiersHTML(props = {}) {
  const { blockId, scene, canScene, secs } = props;
  const s = secs && typeof secs === 'object' ? secs : {};
  const shapeSec = txt(s.shape ?? '1.6s');
  const sampleSec = txt(s.sample ?? sampleSecOf(blockId));
  const reelSec = txt(s.reel ?? '42s');
  return '<div class="tiers">'
    + `<span class="tier ok">形 ✓ ${shapeSec}</span>`
    + `<span class="tier ok">样 ✓ ${sampleSec}</span>`
    + `<button type="button" class="tier go" data-reel="1">动 ▶ 预演片 ${reelSec}</button>`
    + realTierHTML({ blockId, scene, canScene })
    + '</div>';
}

// ---------- 样式（prototype L137-140 原文 + token 兜底；M01 agentic.css 落地后同规则共存无害） ----------

export const TIER_CSS = `
.tiers { display: flex; gap: 6px; flex-wrap: wrap; margin: 2px 0 12px; }
.tier { font-size: 12px; border-radius: 999px; padding: 3px 10px; border: 1px solid var(--line, rgba(34,48,42,.14)); color: var(--text-2, #5C6B61); background: var(--surface, #fff); }
.tier.ok { color: var(--ok, #3F7A55); border-color: var(--ok, #3F7A55); }
.tier.go { color: var(--you, #E95432); border-color: var(--you, #E95432); cursor: pointer; }
`;

/** 幂等注入样式；无 DOM 环境（node 纯核）安全返回 false（M06 ensureStyles 同款） */
export function ensureStyles(doc) {
  if (!doc || typeof doc.createElement !== 'function') return false;
  if (doc.querySelector('style[data-agentic-tiers]')) return false;
  const st = doc.createElement('style');
  st.setAttribute('data-agentic-tiers', '');
  st.textContent = TIER_CSS;
  const head = doc.head || doc.documentElement;
  if (!head || typeof head.appendChild !== 'function') return false;
  head.appendChild(st);
  return true;
}

// ---------- DOM 壳：mount / update ----------

/**
 * 壳（组件页 ?c=tiers / demo 装配）：mount(el, props) → handle。
 * props = { blockId, scene, canScene, secs, onReel, onScene }；update(props) 合并语义。
 * 渲染走 setHTML(el, tiersHTML(state))——状态串未变零写；chips 无输入/焦点态，切档整行重写安全
 * （持续态的节点保活由 scene-card 负责，M07 spec 只对 .scenebox 有增量硬约束）。
 * 点击容器级事件委托（单监听，整绘不丢回调；prototype L623-624 同款 data-reel/data-scene 分派）。
 */
export function mount(el, props) {
  const state = {
    blockId: undefined, scene: undefined, canScene: undefined,
    secs: undefined, onReel: null, onScene: null,
  };

  const merge = (p) => {
    if (!p || typeof p !== 'object') return;
    if ('blockId' in p) state.blockId = p.blockId;
    if ('scene' in p) state.scene = p.scene; // 归一推迟到渲染（字符串/对象两形态）
    if ('canScene' in p) state.canScene = p.canScene;
    if ('secs' in p) state.secs = p.secs && typeof p.secs === 'object' ? p.secs : undefined;
    if ('onReel' in p) state.onReel = typeof p.onReel === 'function' ? p.onReel : null;
    if ('onScene' in p) state.onScene = typeof p.onScene === 'function' ? p.onScene : null;
  };

  const apply = (p) => {
    merge(p);
    setHTML(el, tiersHTML(state));
  };

  if (typeof el?.addEventListener === 'function') {
    el.addEventListener('click', (e) => {
      const t = e?.target;
      const reel = t?.closest?.('[data-reel]');
      if (reel) {
        if (typeof state.onReel === 'function') state.onReel();
        return;
      }
      const sceneBtn = t?.closest?.('[data-scene]');
      if (sceneBtn && typeof state.onScene === 'function') state.onScene(sceneBtn.dataset?.scene);
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
