// M15 · 交付台泳道（Day Board）—— 块泳道 + seg 六色 + 时间窗虚线框 + nowline + 刻度 + toolbar（纯核 + DOM 壳）
// 依据：PRD §5.4（L294 交付台：纵轴今天的日程块（泳道）、横轴时间；每条泳道显示该块 agent 的
//   步骤条、用户触点、交付时刻；当前时刻竖线；全局「全部暂停」按钮常驻）、§5.8（L324 交付台
//   在 50 个块内保持 60fps；L325 移动端交付台改为纵向时间线）、§5.2 末（L275 原型实测教训：
//   执行中界面必须增量更新——整块重绘会让正在点击的按钮失效）、§1.2 P4（一键停）、
//   §1.2 P3（可观测即可信）；
//   prototype.html（唯一视觉/交互标准）：
//   L107-116 .board/.lanes(grid gap8)/.lane(120px 1fr 两栏)/.track(34px paper 圆角10 溢出
//            隐藏)/.seg(色类 r/w/v/u/d/g + title 提示 + ellipsis)/.nowline(you 色 2px 竖线)/
//            .axis(120px 1fr，刻度行 flex space-between tabular-nums)
//   L58-64    .dot prep/live/need/ready/donv 五状态点 + pulse 缩放动画（rm 降级）
//   L133      .toolbar flex wrap
//   L222-231  交付台卡：toolbar(h2 交付台 + spacer + simState 文案 + 速度 ×1 按钮 +
//            .danger 全部暂停[disabled]) + .axis 七刻度 13:00–19:00 + #lanes
//   L244-247  T/HM/DAY0=780/DAY1=1140/pct=窗口百分比 toFixed(2)
//   L507-513  renderLanes：每块一 .lane（.name=statusDot+标题 + .track）；时间窗虚线框
//            left/width=窗口百分比、border-left/right 1px dashed、起点 ≥ 19:00 不画、
//            窗口夹 [DAY0,DAY1]；seg left/width=calc(百分比差)；nowline left=
//            pct(min(DAY1,max(DAY0,sim)))，running||signed 才显示
//   L528-530  pauseAll.disabled=!running、paused 文案「继续」、simState 文案
//   L638-639  全部暂停开合 / 速度 ×1↔×4
// 契约（tests/agentic/ui/board.spec.ts 组件页 + unit/board.test.mjs 纯核/壳桩）：
//   mount(el, { blocks, segs, now, running, paused, signed, speed, simState,
//               onPauseAll, onSpeed }) → handle{ el, update(props) }
//   block = { id, start, end, title, status? }（HH:MM 时间窗；status ∈ 五状态点）；
//   segs = { b, s, e, c, text }[]（b=所属块 id；c ∈ r/w/v/u/d/g）；now = 当日分钟数
//   （number 或 'HH:MM'；840 = 14:00）；speed 缺省 1（×1/×4）；simState 缺省
//   「签约后开始执行」；signed（已签约未开跑）也显示 nowline（prototype L511）。
// 增量硬约束（DAG M15「update 只挪 seg/nowline 样式不重建行」，50 块 60fps）：
//   壳（toolbar + .axis + .lanes 容器）首绘只写一次；此后 update——blocks/segs 签名
//   不变时只改 nowline 内联 left/display 与 toolbar 文案/disabled（compare-first 零写），
//   绝不重建 .lane 行；签名变（块/段增删改）才重写 .lanes 容器（toolbar/axis 节点不动）。
// a11y（BUILD-PLAN W5.3 硬性要求）：按钮原生可聚焦 + :focus-visible 焦点可见；
//   nowline/win/状态点 aria-hidden（纯装饰，时刻由宿主时钟播报）；pulse 类动画
//   prefers-reduced-motion 降级为无动画。
// 移动端（PRD §5.8「交付台改为纵向时间线」）：≤560px 泳道与刻度行降级单列——
//   块名在上、时间轨在下，泳道自上而下堆叠成纵向时间线。
// 与原型的有意差异（均记录在案）：
//   1) 多实例组件去 id（#simState/#speedBtn/#pauseAll/#lanes → 类/数据属性 + 容器级事件委托）；
//   2) toolbar h2 的内联 font-size:18px 移入样式表；simState 用 .simState 类承载；
//   3) nowline 不满足 running||signed 时以内联 display:none 占位（而非移除节点）——
//      保证恢复显示时节点身份不变（增量纪律）；
//   4) 状态点/虚线框/nowline 加 aria-hidden="true"（装饰元素）；
//   5) 新增 @media(max-width:560px) 纵向降级（原型未含，PRD §5.8 要求）。
// esc/setHTML 探测 M01 web/agentic/ui/utils.js（同 M03-M14 并行落地模式），未落地本地兜底。
let escShared = null;
let setHTMLShared = null;
try {
  const utils = await import('./utils.js');
  if (typeof utils.esc === 'function') escShared = utils.esc;
  if (typeof utils.setHTML === 'function') setHTMLShared = utils.setHTML;
} catch {
  // utils.js 不存在（M01 未落地）：本地兜底，规则与 prototype L328-329 一致
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

// ---------- 常量（prototype 原文）与归一 ----------

export const BOARD_TITLE = '交付台'; // L224
export const PAUSE_LABEL = '全部暂停'; // L227
export const RESUME_LABEL = '继续'; // L529 paused 分支
export const SPEED_PREFIX = '速度 ×'; // L226/L639
export const DEFAULT_SIM_STATE = '签约后开始执行'; // L225 原文
export const DAY0_MIN = 13 * 60; // L246 DAY0 = T('13:00') = 780
export const DAY1_MIN = 19 * 60; // L246 DAY1 = T('19:00') = 1140
export const AXIS_TICKS = ['13:00', '14:00', '15:00', '16:00', '17:00', '18:00', '19:00']; // L229 七刻度
export const SEG_CLASSES = ['r', 'w', 'v', 'u', 'd', 'g']; // L113 六色类原文序
export const DOT_STATUSES = ['prep', 'live', 'need', 'ready', 'done']; // L59-63 五状态点

const SEG_SET = new Set(SEG_CLASSES);
const DOT_SET = new Set(DOT_STATUSES);

const HM_RE = /^([01]?\d|2[0-3]):([0-5]\d)$/;
/** 'HH:MM' → 当日分钟数；非法返回 NaN（prototype L244 T） */
export function parseHM(t) {
  if (typeof t !== 'string') return NaN;
  const m = HM_RE.exec(t.trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : NaN;
}

/** 夹进当日窗口 [DAY0,DAY1]（prototype L511 min/max） */
export function clampToDay(t) {
  return Math.min(DAY1_MIN, Math.max(DAY0_MIN, t));
}

/** 窗口内百分比串 toFixed(2)（prototype L247 pct 原文） */
export function pctStr(t) {
  return (((t - DAY0_MIN) / (DAY1_MIN - DAY0_MIN)) * 100).toFixed(2) + '%';
}

/** nowline 横向位：now 夹窗后取百分比；非法 now 归窗起点（渲染兜底，不炸） */
export function nowPctStr(now) {
  const t = Number.isFinite(now) ? now : DAY0_MIN;
  return pctStr(clampToDay(t));
}

const str = (x) => (typeof x === 'string' ? x.trim() : '');

/** blocks 归一：{ id, start, end, title, status? }——四必填（start/end 合法 HH:MM），status 白名单外归空串；无效项剔除 */
export function normalizeBlocks(v) {
  if (!Array.isArray(v)) return [];
  const out = [];
  for (const b of v) {
    if (!b || typeof b !== 'object') continue;
    const id = str(b.id);
    const title = str(b.title);
    const start = str(b.start);
    const end = str(b.end);
    if (!id || !title) continue;
    const s = parseHM(start);
    const e = parseHM(end);
    if (Number.isNaN(s) || Number.isNaN(e)) continue;
    const st = str(b.status);
    const status = DOT_SET.has(st) ? st : '';
    out.push({ id, title, start, end, status });
  }
  return out;
}

/** segs 归一：{ b, s, e, c, text }——b 非空、s/e 合法且 e>s、c ∈ 六色类；text 缺省空串；无效项剔除 */
export function normalizeSegs(v) {
  if (!Array.isArray(v)) return [];
  const out = [];
  for (const g of v) {
    if (!g || typeof g !== 'object') continue;
    const b = str(g.b);
    const c = str(g.c);
    if (!b || !SEG_SET.has(c)) continue;
    const s = parseHM(str(g.s));
    const e = parseHM(str(g.e));
    if (Number.isNaN(s) || Number.isNaN(e) || e <= s) continue;
    out.push({ b, s: str(g.s), e: str(g.e), c, text: str(g.text) });
  }
  return out;
}

/** speed 归一：正有限数（×1/×4）；非法/缺省 1 */
export function normalizeSpeed(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

/** simState 归一：非空串 trim；缺省「签约后开始执行」（prototype L225） */
export function normalizeSimState(v) {
  const s = str(v);
  return s || DEFAULT_SIM_STATE;
}

/** now 归一：number 直收；'HH:MM' 串转分钟；非法 NaN（渲染层兜底窗起点） */
export function normalizeNow(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : NaN;
  return parseHM(str(v));
}

/** 按块 id 过滤 segs 保序（prototype L509 feed.filter(f.b===b.id && f.seg)） */
export function segsFor(segs, blockId) {
  return normalizeSegs(segs).filter((g) => g.b === blockId);
}

// ---------- 纯核：结构 HTML（prototype L222-231/L507-513 原文结构） ----------

/** 状态点：五白名单原样；空/非白名单不出（prototype L338-341） */
export function statusDotHTML(status) {
  return DOT_SET.has(status) ? `<span class="dot ${status}" aria-hidden="true"></span>` : '';
}

/** seg 条：left/width=calc 百分比 + title 提示 + 文本（prototype L509 原文；无效 → 空） */
export function segHTML(seg) {
  const g = normalizeSegs([seg])[0];
  if (!g) return '';
  return `<div class="seg ${g.c}" style="left:${pctStr(parseHM(g.s))};width:calc(${pctStr(parseHM(g.e))} - ${pctStr(parseHM(g.s))})" title="${esc(g.text)}">${esc(g.text)}</div>`;
}

/** 块时间窗虚线框：窗口夹 [DAY0,DAY1]；起点 ≥ DAY1 / 退化窗口不画（prototype L510-511） */
export function winHTML(block) {
  const b = normalizeBlocks([block])[0];
  if (!b) return '';
  const s = parseHM(b.start);
  const e = parseHM(b.end);
  if (s >= DAY1_MIN || e <= s) return '';
  const l = Math.max(DAY0_MIN, s);
  const r = Math.min(DAY1_MIN, e);
  return `<div class="win" aria-hidden="true" style="left:${pctStr(l)};width:calc(${pctStr(r)} - ${pctStr(l)})"></div>`;
}

/** 当前时刻竖线：left=nowPctStr；不显示时内联 display:none（prototype L114/L511） */
export function nowlineHTML(now, showNow) {
  return `<div class="nowline" aria-hidden="true" style="left:${nowPctStr(now)}${showNow ? '' : ';display:none'}"></div>`;
}

/** 单泳道：.lane[data-lane] + .name(状态点+标题) + .track(虚线框 + segs + nowline)（prototype L511） */
export function laneHTML(block, segs, now, showNow) {
  const b = normalizeBlocks([block])[0];
  if (!b) return '';
  return `<div class="lane" data-lane="${esc(b.id)}">`
    + `<span class="name">${statusDotHTML(b.status)}${esc(b.title)}</span>`
    + `<div class="track">${winHTML(b)}${segsFor(segs, b.id).map((g) => segHTML(g)).join('')}${nowlineHTML(now, showNow)}</div></div>`;
}

/** 泳道群：每块一行保序、每轨一条 nowline（prototype L508-512） */
export function lanesHTML(blocks, segs, now, showNow) {
  return normalizeBlocks(blocks).map((b) => laneHTML(b, segs, now, showNow)).join('');
}

/** 时间轴刻度行：七刻度原文（prototype L229） */
export function axisHTML() {
  return `<div class="axis"><div></div><div>${AXIS_TICKS.map((t) => `<span>${esc(t)}</span>`).join('')}</div></div>`;
}

const speedLabel = (speed) => `${SPEED_PREFIX}${normalizeSpeed(speed)}`;

/** toolbar：h2 + spacer + simState 文案 + 速度按钮 + 全部暂停（未运行 disabled；暂停态「继续」）（prototype L223-228/L528-529） */
export function toolbarHTML(props = {}) {
  const p = props && typeof props === 'object' ? props : {};
  const running = !!p.running;
  const paused = !!p.paused;
  return `<div class="toolbar"><h2>${esc(BOARD_TITLE)}</h2><span class="spacer"></span>`
    + `<span class="small muted simState" data-sim-state>${esc(normalizeSimState(p.simState))}</span>`
    + `<button class="btn" type="button" data-board-speed>${esc(speedLabel(p.speed))}</button>`
    + `<button class="btn danger" type="button" data-board-pause${running ? '' : ' disabled'}>${esc(paused ? RESUME_LABEL : PAUSE_LABEL)}</button></div>`;
}

/** 整壳：toolbar → axis → lanes 三段（prototype L222-231 卡结构；宿主补 .board 类） */
export function boardHTML(props = {}) {
  const p = props && typeof props === 'object' ? props : {};
  const showNow = !!(p.running || p.signed);
  return toolbarHTML(p)
    + axisHTML()
    + `<div class="lanes">${lanesHTML(p.blocks, p.segs, normalizeNow(p.now), showNow)}</div>`;
}

// ---------- 样式（prototype L58-64/L107-116/L133 原文 + token 兜底 + a11y + 移动降级；M01 agentic.css 落地后共存无害） ----------

export const BOARD_CSS = `
.board{margin-top:16px}
.board .toolbar{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:10px}
.board .toolbar h2{font-size:18px;font-family:var(--font-serif,"Noto Serif SC","Songti SC","STSong",serif);font-weight:400;margin:0}
.board .spacer{flex:1}
.board .simState{font-size:13px;color:var(--text-2,#5C6B61)}
.board .btn{border:1px solid var(--line,rgba(34,48,42,.14));background:var(--surface,#FFFFFF);border-radius:999px;padding:8px 16px;min-height:40px;cursor:pointer;font:inherit;color:inherit}
.board .btn.danger{color:var(--bad,#A53B25)}
.board .btn[disabled]{opacity:.5;cursor:default}
.board .btn:focus-visible{outline:2px solid var(--you,#E95432);outline-offset:2px}
.axis{display:grid;grid-template-columns:120px 1fr;gap:8px;font-size:11px;color:var(--text-2,#5C6B61)}
.axis div:last-child{display:flex;justify-content:space-between;font-variant-numeric:tabular-nums}
.board .lanes{display:grid;gap:8px;position:relative}
.lane{display:grid;grid-template-columns:120px 1fr;gap:8px;align-items:center}
.lane .name{font-size:13px}
.lane .track{position:relative;height:34px;background:var(--paper,#FCFBF6);border:1px solid var(--line,rgba(34,48,42,.14));border-radius:10px;overflow:hidden}
.lane .track .win{position:absolute;top:0;bottom:0;border-left:1px dashed var(--line,rgba(34,48,42,.14));border-right:1px dashed var(--line,rgba(34,48,42,.14))}
.seg{position:absolute;top:5px;height:22px;border-radius:6px;font-size:11px;color:#fff;padding:2px 6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;opacity:.92}
.seg.r{background:var(--k-explore,#4D7699)}
.seg.w{background:var(--k-create,#B07A36)}
.seg.v{background:var(--k-restore,#4F8570)}
.seg.u{background:var(--you,#E95432)}
.seg.d{background:var(--deep,#2E4636)}
.seg.g{background:var(--k-connect,#B05A4D)}
.nowline{position:absolute;top:-6px;bottom:-6px;width:2px;background:var(--you,#E95432);pointer-events:none}
.board .dot{width:9px;height:9px;border-radius:50%;display:inline-block;background:var(--line,rgba(34,48,42,.14));margin-right:6px;vertical-align:middle}
.board .dot.prep{background:var(--k-explore,#4D7699);animation:agentic-board-pulse 1.2s infinite}
.board .dot.live{background:var(--k-create,#B07A36);animation:agentic-board-pulse .8s infinite}
.board .dot.need{background:var(--you,#E95432);animation:agentic-board-pulse .6s infinite}
.board .dot.ready{background:var(--ok,#3F7A55)}
.board .dot.done{background:var(--deep,#2E4636)}
@keyframes agentic-board-pulse{50%{transform:scale(1.4);opacity:.55}}
@media (max-width:560px){.lane{grid-template-columns:1fr;gap:4px}.lane .name{font-size:14px}.axis{grid-template-columns:1fr}}
@media (prefers-reduced-motion: reduce){.board *,.board *::before,.board *::after{animation:none !important;transition:none !important}}
`;

/** 幂等注入样式；无 DOM 环境（node 纯核）安全返回 false（M06-M14 同款） */
export function ensureStyles(doc) {
  if (!doc || typeof doc.createElement !== 'function') return false;
  if (doc.querySelector('style[data-agentic-board]')) return false;
  const st = doc.createElement('style');
  st.setAttribute('data-agentic-board', '');
  st.textContent = BOARD_CSS;
  const head = doc.head || doc.documentElement;
  if (!head || typeof head.appendChild !== 'function') return false;
  head.appendChild(st);
  return true;
}

// ---------- DOM 壳：mount ----------

const lanesSignature = (blocks, segs) => JSON.stringify([normalizeBlocks(blocks), normalizeSegs(segs)]);

/**
 * DOM 壳（组件页 ?c=board / demo 装配）：mount(el, props) → handle。
 * props = { blocks, segs, now, running, paused, signed, speed, simState, onPauseAll, onSpeed }；
 *   update(props) 合并语义（未传键不动旧值，回调仅函数可替换），链式返回 handle。
 * 增量：壳（toolbar+axis+.lanes 容器）首绘一次；此后 update——签名不变只改 nowline
 *   内联 left/display 与 toolbar 文案/disabled（compare-first 零写）；签名变才重写
 *   .lanes 容器（toolbar/axis 节点身份不动）。
 * 事件：el 上委托 click——[data-board-pause] → onPauseAll()（prototype L638）、
 *   [data-board-speed] → onSpeed()（L639；速度档位由宿主切换后经 props 回流）。
 * el=null / 宿主缺 querySelector：安全降级不抛（M10-M14 同款容忍）。
 */
export function mount(el, props = {}) {
  const doc = (el && el.ownerDocument) || (typeof document !== 'undefined' ? document : null);
  ensureStyles(doc);

  const state = {
    blocks: [], segs: [], now: NaN,
    running: false, paused: false, signed: false,
    speed: 1, simState: DEFAULT_SIM_STATE,
    onPauseAll: null, onSpeed: null,
  };
  let lanesSig = null;
  let builtOnce = false;

  if (el && el.classList && typeof el.classList.add === 'function') el.classList.add('board');

  const zone = (sel) => (typeof el?.querySelector === 'function' ? el.querySelector(sel) : null);
  const lanesZone = () => zone('.lanes');
  const showNow = () => !!(state.running || state.signed); // prototype L511

  const merge = (p) => {
    if (!p || typeof p !== 'object') return;
    if ('blocks' in p) state.blocks = normalizeBlocks(p.blocks);
    if ('segs' in p) state.segs = normalizeSegs(p.segs);
    if ('now' in p) state.now = normalizeNow(p.now);
    if ('running' in p) state.running = !!p.running;
    if ('paused' in p) state.paused = !!p.paused;
    if ('signed' in p) state.signed = !!p.signed;
    if ('speed' in p) state.speed = normalizeSpeed(p.speed);
    if ('simState' in p) state.simState = normalizeSimState(p.simState);
    if (typeof p.onPauseAll === 'function') state.onPauseAll = p.onPauseAll;
    if (typeof p.onSpeed === 'function') state.onSpeed = p.onSpeed;
  };

  /** nowline 只挪内联 left/display（同节点；compare-first） */
  function syncNowlines() {
    const lanes = lanesZone();
    if (!lanes || typeof lanes.querySelectorAll !== 'function') return;
    const left = nowPctStr(state.now);
    const display = showNow() ? '' : 'none';
    for (const nl of lanes.querySelectorAll('.nowline')) {
      if (!nl?.style) continue;
      if (nl.style.left !== left) nl.style.left = left;
      if (nl.style.display !== display) nl.style.display = display;
    }
  }

  /** toolbar 只动文案/disabled（compare-first 零写；prototype L528-530） */
  function syncToolbar() {
    const sim = zone('[data-sim-state]');
    if (sim && sim.textContent !== state.simState) sim.textContent = state.simState;
    const speed = zone('[data-board-speed]');
    const sLabel = speedLabel(state.speed);
    if (speed && speed.textContent !== sLabel) speed.textContent = sLabel;
    const pause = zone('[data-board-pause]');
    if (pause) {
      const dis = !state.running;
      if (pause.disabled !== dis) pause.disabled = dis;
      const pLabel = state.paused ? RESUME_LABEL : PAUSE_LABEL;
      if (pause.textContent !== pLabel) pause.textContent = pLabel;
    }
  }

  function apply(p) {
    merge(p);
    if (!builtOnce) { // 首绘：壳一次
      setHTML(el, boardHTML(state));
      builtOnce = true;
      lanesSig = lanesSignature(state.blocks, state.segs);
      return;
    }
    const sig = lanesSignature(state.blocks, state.segs);
    if (sig !== lanesSig) { // 块/段增删改才重写泳道容器（toolbar/axis 节点不动）
      const lanes = lanesZone();
      if (lanes) setHTML(lanes, lanesHTML(state.blocks, state.segs, state.now, showNow()));
      lanesSig = sig;
    } else {
      syncNowlines();
    }
    syncToolbar();
  }

  if (typeof el?.addEventListener === 'function') {
    el.addEventListener('click', (ev) => {
      const t = ev?.target;
      if (!t || typeof t.closest !== 'function') return;
      if (t.closest('[data-board-pause]')) {
        if (state.onPauseAll) state.onPauseAll(); // 全部暂停/继续（prototype L638）
        return;
      }
      if (t.closest('[data-board-speed]') && state.onSpeed) state.onSpeed(); // 速度 ×1↔×4（L639）
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
