// M07 · 场景片异步卡 —— L3「真」档的持续态面板（off 不渲染 / queued·generating 进度条 / ready 16:9 video）
// 依据：PRD §5.2.1 L3 真（2–5 分钟异步、后台生成好了再提示、绝不阻塞签约）+ D-9（默认关）+
//   §10.3 scene 字段（status: off|queued|generating|ready，默认 off）+ P1 诚实原则（生成画面标「示意」）；
//   prototype.html（唯一视觉标准）L146（.wm 角标）、L159-164（.scenebox/.bar/.bar i 过渡）、
//   L378-382（sceneHTML 两态原文）、L583-584（进度条 0→100% 推进语义）。
// 契约（tests/agentic/ui/tiers.spec.ts 组件页 + unit/tiers.test.mjs 纯核/壳桩）：
//   mount(el, { scene, progress, title, caption, model }) → { el, update, setProgress }
//   scene 收 PRD §10.3 字符串/对象两形态（对象 update 为字段级合并）；aria-live=polite 播报状态变化；
//   增量硬约束（spec）：.scenebox 节点跨 update 存活——off→有 整卡建/删，忙↔ready 只重灌卡内子树，
//   同态只补标题/说明/进度条宽度（<i> 节点不换，宽度恒为百分比）；setProgress(pct) 0–100 夹取直推不重绘。
// 媒体白名单 SAFE_MEDIA（同 M04 SAFE_SRC 规则）：url/poster 只放行相对路径，协议/绝对路径/../
//   一律整段丢弃——宁缺勿假（无 url 的 ready 降级为纯角标 frame，不渲染空 video）。
import { esc, setHTML, normalizeScene } from './tiers.js';

// ---------- 常量与归一 ----------

/** 相对路径白名单（M04 SAFE_SRC 同款）：禁协议/绝对路径/空白；配合 .. 检查禁父目录 */
export const SAFE_MEDIA = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

/** 白名单外的媒体值整段丢弃（XSS/越权基线）；非字符串一律 '' */
export function safeMedia(v) {
  if (typeof v !== 'string' || !SAFE_MEDIA.test(v) || v.includes('..')) return '';
  return v;
}

/** 进度百分比：0–100 夹取取整，非数归 0（prototype L583 pctv 从 0 起步） */
export function barWidth(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(100, Math.max(0, Math.trunc(n))) : 0;
}

const txt = (v) => esc(v ?? '');

/** 默认模型与文案（prototype L380-382 原文；model/title/caption 均可由数据覆盖） */
export const DEFAULT_MODEL = 'happyhorse-1.1';
export const DEFAULT_TITLE = '场景片（示意）';
export const DEFAULT_CAPTION = '1080p 5 秒 · 生成用时 116s · 只是氛围参考，不是交付物';
const GEN_NOTE = '实测约 2 分钟（原型演示加速）· 不影响签约，好了会提示你';
const QUEUE_NOTE = '任务已提交，排队中 · 不影响签约，好了会提示你';

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

/** 原始 scene（字符串/对象）+ 壳级覆盖 → 统一视图（url/poster/model/title/caption/progress） */
function viewOf(raw, overrides) {
  const o = isObj(raw) ? raw : {};
  const ov = overrides || {};
  return {
    status: normalizeScene(raw),
    url: o.url,
    poster: o.poster,
    model: ov.model ?? o.model,
    title: ov.title ?? o.title,
    caption: ov.caption ?? o.caption,
    progress: ov.progress ?? o.progress,
  };
}

// ---------- 纯核：HTML 构建 ----------

/** 忙态（queued/generating）卡内子树：状态标题 + 不阻塞说明 + 进度条（prototype L380） */
export function busyInner(status, v) {
  const title = status === 'queued' ? '场景片排队中' : '场景片生成中';
  const note = status === 'queued' ? QUEUE_NOTE : GEN_NOTE;
  const model = txt(v.model ?? DEFAULT_MODEL);
  return `<b>${title}</b><span class="small muted">${model} · ${note}</span>`
    + `<div class="bar"><i style="width:${barWidth(v.progress)}%"></i></div>`;
}

/** ready 态卡内子树：16:9 frame + video（白名单内）+「示意 · AI 生成」角标 + 规格行（prototype L381-382） */
export function readyInner(v) {
  const url = safeMedia(v.url);
  const poster = safeMedia(v.poster);
  const video = url
    ? `<video src="${txt(url)}"${poster ? ` poster="${txt(poster)}"` : ''} controls muted playsinline loop>`
    : '';
  return `<b>${txt(v.title ?? DEFAULT_TITLE)}</b>`
    + `<div class="frame" style="aspect-ratio:16/9">${video}<span class="wm">示意 · AI 生成</span></div>`
    + `<span class="small muted">${txt(v.caption ?? DEFAULT_CAPTION)}</span>`;
}

/**
 * 整卡 HTML：off → ''（D-9 不渲染）；其余态 aria-live=polite + role=status 容器
 * （DAG M07 状态播报；.scenebox 节点由壳负责跨 update 保活）。
 */
export function sceneHTML(scene) {
  const v = viewOf(scene);
  if (v.status === 'off') return '';
  const inner = v.status === 'ready' ? readyInner(v) : busyInner(v.status, v);
  return `<div class="scenebox" aria-live="polite" role="status">${inner}</div>`;
}

// ---------- 样式（prototype L159-164/L146 原文 + token 兜底 + reduced-motion 降级） ----------

export const SCENE_CSS = `
.scenebox { margin-top: 14px; border: 1px dashed var(--line, rgba(34,48,42,.14)); border-radius: 12px; padding: 12px; display: grid; gap: 8px; }
.scenebox .bar { height: 6px; border-radius: 3px; background: var(--line, rgba(34,48,42,.14)); overflow: hidden; }
.scenebox .bar i { display: block; height: 100%; width: 0; background: var(--you, #E95432); transition: width .3s linear; }
.scenebox .frame { position: relative; border-radius: 12px; overflow: hidden; border: 1px solid var(--line, rgba(34,48,42,.14)); background: #fff; }
.scenebox .frame video { width: 100%; height: 100%; object-fit: cover; display: block; }
.scenebox .wm { position: absolute; right: 8px; bottom: 6px; font-size: 11px; color: #fff; background: rgba(0,0,0,.38); border-radius: 6px; padding: 1px 6px; letter-spacing: .1em; }
.scenebox .small { font-size: 12px; color: var(--text-2, #5C6B61); }
@media (prefers-reduced-motion: reduce) { .scenebox .bar i { transition: none; } }
`;

/** 幂等注入样式；无 DOM 环境（node 纯核）安全返回 false（M06 ensureStyles 同款） */
export function ensureStyles(doc) {
  if (!doc || typeof doc.createElement !== 'function') return false;
  if (doc.querySelector('style[data-agentic-scene]')) return false;
  const st = doc.createElement('style');
  st.setAttribute('data-agentic-scene', '');
  st.textContent = SCENE_CSS;
  const head = doc.head || doc.documentElement;
  if (!head || typeof head.appendChild !== 'function') return false;
  head.appendChild(st);
  return true;
}

// ---------- DOM 壳：mount / update / setProgress ----------

/**
 * 壳（组件页 ?c=scene-card / demo 装配）：
 *   off → 清空宿主（D-9 默认无卡）；非 off → 确保 .scenebox 存在（aria-live 容器跨 update 保活）。
 *   体态切换（忙↔ready）只 setHTML 卡内子树（节点本体不重建，spec data-marker 断言）；
 *   忙态同态只补 b/.small 文案 + <i> 宽度（进度节点不换）；ready 同键零写。
 *   update(props) 合并语义（未传键不动旧值；scene 对象为字段级合并）；setProgress 直推条宽。
 */
export function mount(el, props) {
  const state = { scene: undefined, progress: undefined, title: undefined, caption: undefined, model: undefined };
  let lastKey = null;

  const query = (node, sel) => (typeof node?.querySelector === 'function' ? node.querySelector(sel) : null);

  const view = () => viewOf(state.scene, {
    title: state.title, caption: state.caption, model: state.model, progress: state.progress,
  });

  const keyOf = (v) => [v.status, safeMedia(v.url), safeMedia(v.poster), v.title ?? '', v.caption ?? '', v.model ?? ''].join('\u0000');

  const merge = (p) => {
    if (!p || typeof p !== 'object') return;
    if ('scene' in p) {
      state.scene = isObj(p.scene)
        ? { ...(isObj(state.scene) ? state.scene : {}), ...p.scene } // 字段级合并：改 status 不丢 url
        : p.scene;
    }
    if ('progress' in p) state.progress = p.progress;
    if ('title' in p) state.title = p.title;
    if ('caption' in p) state.caption = p.caption;
    if ('model' in p) state.model = p.model;
  };

  const apply = (p) => {
    merge(p);
    const v = view();
    if (v.status === 'off') {
      setHTML(el, '');
      lastKey = null;
      return;
    }
    let box = query(el, '.scenebox');
    if (!box) {
      setHTML(el, sceneHTML(v));
      lastKey = keyOf(v);
      return;
    }
    const wantBusy = v.status === 'queued' || v.status === 'generating';
    const hasBar = !!query(box, '.bar');
    const hasFrame = !!query(box, '.frame');
    if ((wantBusy && !hasBar) || (!wantBusy && !hasFrame)) {
      setHTML(box, v.status === 'ready' ? readyInner(v) : busyInner(v.status, v)); // 体态切换：卡内重灌，节点保活
      lastKey = keyOf(v);
      return;
    }
    if (wantBusy) {
      const b = query(box, 'b');
      if (b) setHTML(b, v.status === 'queued' ? '场景片排队中' : '场景片生成中');
      const note = query(box, '.small');
      if (note) setHTML(note, `${txt(v.model ?? DEFAULT_MODEL)} · ${v.status === 'queued' ? QUEUE_NOTE : GEN_NOTE}`);
      const barI = query(box, '.bar i');
      if (barI && barI.style) barI.style.width = `${barWidth(v.progress)}%`; // <i> 不换，宽度恒为百分比
    } else if (keyOf(v) !== lastKey) {
      setHTML(box, readyInner(v));
      lastKey = keyOf(v);
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
    /** 直推进度条（demo 复刻 prototype L583-584 的 0→100% 推进）：夹取 0–100；无进度条可推返回 false */
    setProgress(pct) {
      const n = Number(pct);
      if (!Number.isFinite(n)) return false;
      const v = Math.min(100, Math.max(0, Math.trunc(n)));
      const barI = query(el, '.scenebox .bar i') ?? query(query(el, '.scenebox'), '.bar i');
      if (!barI || !barI.style) return false;
      state.progress = v;
      barI.style.width = `${v}%`;
      return true;
    },
  };
  return handle;
}
