// W11 reel-player · 浏览器内预演片播放器（BUILD-PLAN §3 W11.3、PRD §5.2.1 L2「HTML 合成直接播放，
// 不需要渲染」）。消费 composer 契约（scripts/agentic/composer/timeline.mjs 的 dataAttrs、
// compose-reel.mjs 的数据岛）：每个镜头/字幕带 HyperFrames 兼容 data-start/data-duration/data-track
// （+data-kind/data-sample-id），<script type="application/json" id="reel-data"> 内联同一份时间轴；
// 本文件按这些 data 属性接管 DOM。视觉与交互逐条对照 prototype.html：165-185（16:9 stage、
// .prog 3px 进度条、.shot 交叉过渡 .6s、kb 7s ease-out scale 1.09、.cap 字幕条、示意水印）
// 与 :621-648（暂停/继续/重播/关闭/Esc 交互）。
// 工程约束（PRD §5.2 末「执行中界面必须增量更新」）：进度条宽度、字幕可见性、按钮文案全部按
// diff 改，绝不整块重写 DOM。旁白 <audio> 的 currentTime 是时间轴主时钟（原型 speechSynthesis
// 换正式音频，PRD §5.2.3）；无音频时退回注入时钟的虚拟时间。prefers-reduced-motion 时关全部
// 动画/过渡，降级为分步静态（每镜头一帧 + 上一步/下一步手动步进，PRD §5.2.3「静态分步」）。
// 本文件顶层不触碰 DOM（node 可直接导入做纯函数单测）；浏览器胶水集中在 createReelPlayer，
// raf/now/audio/matchMedia/document 全部可注入，node 单测用 fake DOM 驱动。

// ---------- 纯函数（node 单测覆盖：解析/同步换算/降级判定/状态机） ----------

/** 状态机初值：挂载后未开播。 */
export const INITIAL_PLAYER_STATE = 'idle';

/**
 * 播放器状态机（prototype.html:621-648 交互逐一对照）：
 * idle --play--> playing；playing --pause--> paused；paused --resume--> playing；
 * playing --end--> ended；ended --replay--> playing；
 * ended --pause--> playing（prototype:623 末尾按「暂停」即重播）；
 * 任何非终态 --close--> closed；closed 是终态；未知事件不动状态。
 */
const TRANSITIONS = {
  idle: { play: 'playing', close: 'closed' },
  playing: { play: 'playing', resume: 'playing', pause: 'paused', end: 'ended', close: 'closed' },
  paused: { play: 'playing', resume: 'playing', pause: 'paused', rewind: 'paused', close: 'closed' },
  ended: { play: 'playing', replay: 'playing', pause: 'playing', rewind: 'paused', close: 'closed' },
  closed: {},
};

/** 纯状态转移：playerState(state, event) → 下一状态。未知状态按初值处理，未知事件原样返回。 */
export function playerState(state, event) {
  const from = TRANSITIONS[state] ? state : INITIAL_PLAYER_STATE;
  const next = TRANSITIONS[from][event];
  return next ?? from;
}

/** data-* 数值守卫：有限且 ≥0 才可用（composer 契约损坏时丢弃该元素，不让 NaN 进时间轴）。 */
const okSec = v => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
};

const TRACKS = ['visual', 'caption'];

/** 通用单元素解析：get(name) → string|null（DOM 的 getAttribute 与数据岛的字段读取共用此路径）。 */
function parseOne(get, node) {
  const start = okSec(get('data-start'));
  const duration = okSec(get('data-duration'));
  const track = get('data-track');
  if (start === null || duration === null || !TRACKS.includes(track)) return null;
  const el = { start, duration, track, kind: get('data-kind') ?? track };
  const sampleId = get('data-sample-id');
  if (sampleId !== null) el.sampleId = sampleId;
  if (node !== undefined) el.node = node;
  return el;
}

/**
 * parseTimeline(elements) → {durationSec, tracks:{visual,caption}}。
 * elements 为带 getAttribute 的类 DOM 节点（composer 输出的 .shot/.cap，NodeList 或数组皆可）：
 * 按 data-start/data-duration/data-track 解析进对应轨道、按 start 升序；缺属性/非法数值/未知
 * 轨道的元素直接丢弃。durationSec = 全部合法元素的最大 start+duration（铺满 [0,durationSec)）。
 */
export function parseTimeline(elements) {
  const list = elements == null ? [] : Array.from(elements);
  const tracks = { visual: [], caption: [] };
  for (const node of list) {
    if (!node || typeof node.getAttribute !== 'function') continue;
    const el = parseOne(name => node.getAttribute(name), node);
    if (el) tracks[el.track].push(el);
  }
  return finalizeTimeline(tracks, 0);
}

/**
 * timelineFromIsland(data)：解析 composeReel 内联的数据岛
 * ({durationSec, elements:[{start,duration,track,kind,sampleId}]}) → 同 parseTimeline 形状
 * （元素无 node，供 DOM 缺 data 属性时兜底取时长/字幕）。durationSec 取 max(数据岛声明, 元素推得)。
 */
export function timelineFromIsland(data) {
  const raw = Array.isArray(data?.elements) ? data.elements : [];
  const tracks = { visual: [], caption: [] };
  for (const e of raw) {
    const get = name => {
      // data-start → start、data-sample-id → sampleId
      const key = name.slice(5).replace(/-(\w)/g, (_, c) => c.toUpperCase());
      const v = e?.[key];
      return v === undefined || v === null ? null : String(v);
    };
    const el = parseOne(get);
    if (el) tracks[el.track].push(el);
  }
  return finalizeTimeline(tracks, okSec(data?.durationSec) ?? 0);
}

/** 轨道排序 + 总时长（元素铺满宽度与数据岛声明值取大者）。 */
function finalizeTimeline(tracks, minDuration) {
  for (const key of TRACKS) tracks[key].sort((a, b) => a.start - b.start);
  let durationSec = minDuration;
  for (const key of TRACKS) for (const el of tracks[key]) durationSec = Math.max(durationSec, el.start + el.duration);
  return { durationSec, tracks };
}

/**
 * activeAt(tl, t) → {visual: 镜头|null, captions: [字幕]}。同步换算：把主时钟时间 t 映射到
 * 时间轴位置。区间半开 [start, start+duration)：边界时刻 t=下一镜 start 时已切镜；
 * t < 0 或 t ≥ durationSec 时无激活镜头（播放完毕后画面归黑，末帧保持由胶水层负责）。
 */
export function activeAt(tl, t) {
  const tracks = tl && tl.tracks ? tl.tracks : { visual: [], caption: [] };
  const live = list => list.filter(el => el.start <= t && t < el.start + el.duration);
  return { visual: live(tracks.visual).pop() ?? null, captions: live(tracks.caption) };
}

/** progressAt(tl, t) → [0,1]：顶部 3px 进度条的比例，夹取到闭区间。 */
export function progressAt(tl, t) {
  const d = tl?.durationSec ?? 0;
  if (!(d > 0)) return 0;
  const p = t / d;
  return p < 0 ? 0 : p > 1 ? 1 : p;
}

/** formatTime(sec) → 'M:SS'（字幕条/控制条时间标签，prototype .cap <small> 的 0:07 形态）。 */
export function formatTime(sec) {
  const total = Math.max(0, Math.floor(Number(sec) || 0));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/** shouldReduceMotion(mql)：降级判定。matchMedia 不可用（无障碍环境未知）时默认不降级。 */
export function shouldReduceMotion(mql) {
  return Boolean(mql && mql.matches === true);
}

/** scrubTime(fraction, durationSec)：拖动 scrub 的换算——指针横向比例 → 时间轴秒，夹取 [0,1]。 */
export function scrubTime(fraction, durationSec) {
  const f = Number(fraction);
  const d = Number(durationSec);
  if (!Number.isFinite(f) || !Number.isFinite(d) || d <= 0) return 0;
  const c = f < 0 ? 0 : f > 1 ? 1 : f;
  return c * d;
}

// ---------- 浏览器胶水（Web Animations 驱动；依赖全部可注入） ----------

/** prototype.html:172 @keyframes kb 原样搬进 Web Animations 关键帧。 */
const KB_FRAMES = [
  { transform: 'scale(1) translate(0, 0)' },
  { transform: 'scale(1.09) translate(-2%, -1%)' },
];
const KB_MS = 7000;   // prototype:171 animation: kb 7s ease-out forwards
const FADE_MS = 600;  // prototype:168 transition: opacity .6s → WAAPI 等效交叉过渡

/** 播放按钮文案随状态切换（prototype:558 暂停 → :623 继续/重播）。 */
const TOGGLE_LABELS = { idle: '▶ 播放', playing: '暂停', paused: '继续', ended: '重播' };

/**
 * createReelPlayer(root, opts?) → 播放器实例。root 为 .reel 根（composeReel 输出或宿主容器），
 * 结构约定：.stage 舞台、.prog 进度条、[data-track] 镜头/字幕、audio 旁白、#reel-data 数据岛；
 * 缺失的部分由播放器自建（进度条、控制条）。opts：{ audio, document, matchMedia, raf, now,
 * autoplay=false, controls='auto', onClose }。所有 DOM 更新增量进行（见 apply）。
 */
export function createReelPlayer(root, opts = {}) {
  if (!root) throw new Error('REEL_ROOT_REQUIRED');
  const doc = opts.document ?? (typeof document !== 'undefined' ? document : null);
  if (!doc) throw new Error('REEL_DOCUMENT_REQUIRED');
  const raf = opts.raf ?? (typeof requestAnimationFrame === 'function' ? requestAnimationFrame : null);
  const now = opts.now ?? (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
  const matchMedia = opts.matchMedia ?? (typeof window !== 'undefined' ? window.matchMedia : null);
  const reduced = shouldReduceMotion(matchMedia && matchMedia('(prefers-reduced-motion: reduce)'));

  const stage = root.querySelector('.stage') ?? root;
  let prog = root.querySelector('.prog');
  const audio = opts.audio !== undefined ? opts.audio : root.querySelector('audio');
  const timeline = mergeTimelines(root, audio);

  let state = INITIAL_PLAYER_STATE;
  const listeners = [];
  const fadeAnims = new Map(); // node → [Animation]
  const kbAnims = new Map();   // img → Animation
  let lastVisual = null;
  let lastCapKey = null;
  let lastWidthStr = null;
  let lastTimeStr = null;
  let lastBtnLabel = null;
  let anchor = 0;      // 虚拟时钟锚点（暂停/seek 时的当前秒）
  let wall = 0;        // 起播墙钟（ms）
  let rafId = null;
  let destroyed = false;

  // -- 时间轴：DOM data 属性优先（带节点可显示），数据岛兜底（时长与字幕文本） --
  function mergeTimelines(rootEl, audioEl) {
    const domTl = parseTimeline(rootEl.querySelectorAll('[data-track]'));
    const island = readIsland(rootEl);
    const islandTl = timelineFromIsland(island);
    const capDuration = Number.isFinite(audioEl?.duration) && audioEl.duration > 0 ? audioEl.duration : 0;
    return {
      durationSec: Math.max(domTl.durationSec, islandTl.durationSec, capDuration),
      tracks: {
        visual: domTl.tracks.visual.length ? domTl.tracks.visual : islandTl.tracks.visual,
        caption: domTl.tracks.caption.length ? domTl.tracks.caption : islandTl.tracks.caption,
      },
    };
  }
  function readIsland(rootEl) {
    const node = rootEl.querySelector('#reel-data') ?? rootEl.querySelector('script[type="application/json"]');
    if (!node || typeof node.textContent !== 'string' || !node.textContent.trim()) return null;
    try { return JSON.parse(node.textContent); } catch { return null; }
  }

  // -- 缺失骨架自建：进度条与控制条（composeReel 已带 .prog；宿主精简标记时补齐） --
  if (!prog) { prog = doc.createElement('div'); prog.className = 'prog'; stage.appendChild(prog); }
  const boundButtons = new WeakSet();
  function bindAct(btn, act) {
    if (!btn || boundButtons.has(btn)) return;
    boundButtons.add(btn);
    btn.addEventListener('click', () => onAct(act));
  }
  const ctl = ensureControls();

  function ensureControls() {
    const existing = root.querySelector('[data-reel-ctl]') ?? root.querySelector('.ctl');
    if (existing && opts.controls !== 'force') return existing;
    if (!existing && opts.controls === 'none') return doc.createElement('div'); // 纯 API 驱动：无控制条
    existing?.remove?.(); // controls:'force' 重建
    const bar = doc.createElement('div');
    bar.className = 'ctl';
    bar.setAttribute('data-reel-ctl', '');
    const mk = (label, act) => {
      const b = doc.createElement('button');
      b.className = 'btn';
      b.setAttribute('type', 'button');
      b.setAttribute('data-reel-act', act);
      b.textContent = label;
      bindAct(b, act);
      bar.appendChild(b);
      return b;
    };
    if (reduced) { mk('◀ 上一步', 'prev'); mk('下一步 ▶', 'next'); }
    else mk(TOGGLE_LABELS.idle, 'toggle');
    mk('关闭', 'close');
    const small = doc.createElement('small');
    small.className = 'reel-time';
    bar.appendChild(small);
    (stage.parentElement ?? root).appendChild(bar);
    return bar;
  }
  const toggleBtn = ctl.querySelector('[data-reel-act="toggle"]') ?? ctl.querySelector('#reelPause');
  const closeBtn = ctl.querySelector('[data-reel-act="close"]') ?? ctl.querySelector('#reelClose');
  const prevBtn = ctl.querySelector('[data-reel-act="prev"]');
  const nextBtn = ctl.querySelector('[data-reel-act="next"]');
  let timeEl = ctl.querySelector('.reel-time');
  bindAct(toggleBtn, 'toggle'); // 宿主自带控制条（prototype 的 #reelPause/#reelClose）同样接管
  bindAct(closeBtn, 'close');
  bindAct(prevBtn, 'prev');
  bindAct(nextBtn, 'next');

  function onAct(act) {
    if (act === 'toggle') toggle();
    else if (act === 'close') close();
    else if (act === 'prev') step(-1);
    else if (act === 'next') step(1);
  }

  // -- 主时钟：有旁白音频用 audio.currentTime（PRD §5.2.3 旁白逐句驱动切镜），否则虚拟时钟 --
  function virtualTime() { return state === 'playing' ? anchor + (now() - wall) / 1000 : anchor; }
  function time() {
    if (audio) return Math.max(0, Number(audio.currentTime) || 0);
    return Math.min(virtualTime(), timeline.durationSec);
  }

  function dispatch(event) {
    const next = playerState(state, event);
    if (next === state) return false;
    state = next;
    for (const cb of listeners.slice()) { try { cb(state); } catch { /* 订阅者异常不拦播放 */ } }
    return true;
  }

  // -- 增量渲染（PRD §5.2 工程约束：只改真变了的节点） --
  function apply(t, { immediate = false } = {}) {
    const p = progressAt(timeline, t);
    const width = (p * 100).toFixed(2) + '%';
    if (prog && width !== lastWidthStr) { prog.style.width = width; lastWidthStr = width; }
    const ts = `${formatTime(t)} / ${formatTime(timeline.durationSec)}`;
    if (timeEl && ts !== lastTimeStr) { timeEl.textContent = ts; lastTimeStr = ts; }

    const act = activeAt(timeline, t);
    if (act.visual !== lastVisual) {
      crossfade(lastVisual, act.visual, immediate);
      kenBurns(act.visual, t);
      // 降级模式下不依赖宿主 CSS：非激活镜头显式归零（diff 后才写）
      if (reduced) {
        for (const v of timeline.tracks.visual) {
          if (v.node && v !== act.visual && v.node.style.opacity !== '0') v.node.style.opacity = '0';
        }
      }
      lastVisual = act.visual;
    } else if (immediate) {
      syncKenBurns(act.visual, t);
    }

    const capKey = act.captions.map(c => c.start).join(',');
    if (capKey !== lastCapKey) {
      const live = new Set(act.captions);
      for (const c of timeline.tracks.caption) {
        if (!c.node || !c.node.style) continue;
        const hidden = c.node.style.display === 'none';
        if ((live.has(c) ? !hidden : hidden)) continue; // 可见性没变的不碰 DOM
        c.node.style.display = live.has(c) ? '' : 'none';
      }
      lastCapKey = capKey;
    }
  }

  function crossfade(prev, next, immediate) {
    if (prev && prev.node) fade(prev.node, false, immediate);
    if (next && next.node) fade(next.node, true, immediate);
  }
  function fade(node, show, immediate) {
    for (const a of fadeAnims.get(node) ?? []) a.cancel?.();
    fadeAnims.delete(node);
    if (reduced || typeof node.animate !== 'function') { node.style.opacity = show ? '1' : '0'; return; }
    // 交叉过渡用 Web Animations（fill forwards 持久保持，cancel 后回落 CSS 基线 opacity:0）
    const frames = immediate
      ? [{ opacity: show ? 1 : 0 }]
      : [{ opacity: show ? 0 : 1 }, { opacity: show ? 1 : 0 }];
    fadeAnims.set(node, [node.animate(frames, { duration: immediate ? 0 : FADE_MS, fill: 'forwards' })]);
  }
  /** Ken Burns（prototype:171 kb 7s ease-out forwards）：进镜即起，seek 进镜中段则对齐相位。 */
  function kenBurns(el, t) {
    const img = el?.node && typeof el.node.querySelector === 'function' ? el.node.querySelector('img') : null;
    if (img) { const old = kbAnims.get(img); old?.cancel?.(); kbAnims.delete(img); }
    if (!el || !img || reduced || typeof img.animate !== 'function') return;
    kbAnims.set(img, img.animate(KB_FRAMES, { duration: KB_MS, easing: 'ease-out', fill: 'forwards' }));
    syncKenBurns(el, t);
  }
  function syncKenBurns(el, t) {
    if (!el) return;
    const img = el.node && typeof el.node.querySelector === 'function' ? el.node.querySelector('img') : null;
    const a = img ? kbAnims.get(img) : null;
    if (a) a.currentTime = Math.min(Math.max(0, (t - el.start) * 1000), KB_MS);
  }

  // -- 帧循环：播放中逐帧 apply；虚拟时钟播到头即收尾（音频模式由 ended 事件收尾） --
  function frame() {
    rafId = null;
    if (destroyed || state !== 'playing') return;
    apply(time());
    if (!audio && time() >= timeline.durationSec - 1e-9) { finish(); return; }
    schedule();
  }
  function schedule() { if (rafId === null && raf) rafId = raf(frame); }

  function startPlayback() {
    if (destroyed || state === 'closed') return;
    if (reduced) { apply(Math.min(time(), timeline.durationSec), { immediate: true }); updateButtons(); return; }
    if (state === 'ended' || (state === 'idle' && time() >= timeline.durationSec && timeline.durationSec > 0)) seek(0, { immediate: true });
    dispatch('play');
    wall = now();
    if (audio) {
      const p = typeof audio.play === 'function' ? audio.play() : null;
      // 自动播放策略拒绝（无手势打开自包含页）：诚实地回到暂停，等用户按「继续」
      if (p && typeof p.catch === 'function') p.catch(() => pause());
    }
    for (const a of kbAnims.values()) a.play?.();
    if (!audio && timeline.durationSec <= 0) { finish(); return; }
    apply(time());
    schedule();
    updateButtons();
  }
  function pause() {
    if (destroyed || state === 'closed') return;
    if (state === 'ended') { startPlayback(); return; } // prototype:623 末尾按「暂停」即重播
    if (state === 'playing') {
      const t = time();
      dispatch('pause');
      anchor = t;
      if (audio) audio.pause?.();
      for (const a of kbAnims.values()) a.pause?.();
    }
    updateButtons();
  }
  function resume() { if (state === 'paused') startPlayback(); else updateButtons(); }
  function replay() { if (destroyed) return; seek(0, { immediate: true }); startPlayback(); }
  function toggle() {
    if (state === 'playing') pause();
    else if (state === 'ended') replay();
    else startPlayback();
  }
  function finish() {
    if (state !== 'playing') return;
    const d = timeline.durationSec;
    anchor = d;
    wall = now();
    dispatch('end');
    // 末帧保持可见（prototype:565 播完停在最末镜头），进度条走到 100%
    apply(Math.max(0, d - 1e-3), { immediate: false });
    if (prog && lastWidthStr !== '100%') { prog.style.width = '100%'; lastWidthStr = '100%'; }
    updateButtons();
  }
  function seek(sec, { immediate = true } = {}) {
    if (destroyed) return;
    const t = Math.min(Math.max(0, Number(sec) || 0), timeline.durationSec);
    if (state === 'ended' && t < timeline.durationSec) dispatch('rewind'); // 从末尾往回拖 → 可继续
    if (audio) { try { audio.currentTime = t; } catch { /* 个别浏览器 seek 未就绪会抛 */ } }
    else { anchor = t; wall = now(); }
    apply(t, { immediate });
    updateButtons();
  }

  /** reduced-motion 分步静态：步进到上一/下一镜头边界（每镜头一帧，不自动推进；末镜后不再前进）。 */
  function step(dir) {
    const shots = timeline.tracks.visual;
    if (!shots.length) return;
    const t = time();
    let idx = shots.findIndex(s => s.start <= t && t < s.start + s.duration);
    if (dir > 0) {
      if (idx === shots.length - 1) return; // 已在末镜：分步静态的终点就是最后一帧
      if (idx < 0) { if (t >= timeline.durationSec) return; idx = -1; }
      const next = idx + 1 < shots.length ? shots[idx + 1].start : timeline.durationSec;
      seek(Math.min(next, timeline.durationSec), { immediate: true });
    } else {
      seek(idx <= 0 ? 0 : shots[idx - 1].start, { immediate: true });
    }
  }

  function updateButtons() {
    if (!toggleBtn || reduced) return;
    const label = TOGGLE_LABELS[state] ?? '';
    if (label && label !== lastBtnLabel) { toggleBtn.textContent = label; lastBtnLabel = label; }
  }

  // -- 交互：Esc 关闭（prototype:648）、舞台拖动 scrub（pointer 换算时间轴位置） --
  function onKey(e) { if (e && e.key === 'Escape' && state !== 'closed') close(); }
  doc.addEventListener('keydown', onKey);

  let scrubbing = false;
  let scrubWasPlaying = false;
  function frac(e) {
    const rect = typeof stage.getBoundingClientRect === 'function' ? stage.getBoundingClientRect() : null;
    const w = rect && rect.width > 0 ? rect.width : 1;
    const left = rect ? rect.left : 0;
    return ((Number(e.clientX) || 0) - left) / w;
  }
  function onDown(e) {
    if (state === 'closed' || reduced) return;
    e.preventDefault?.();
    stage.setPointerCapture?.(e.pointerId);
    scrubbing = true;
    scrubWasPlaying = state === 'playing';
    if (scrubWasPlaying) pause();
    seek(scrubTime(frac(e), timeline.durationSec), { immediate: true });
  }
  function onMove(e) {
    if (!scrubbing || state === 'closed' || reduced) return;
    seek(scrubTime(frac(e), timeline.durationSec), { immediate: true });
  }
  function onUp(e) {
    if (state === 'closed') return;
    stage.releasePointerCapture?.(e.pointerId);
    if (scrubbing && scrubWasPlaying && state === 'paused') startPlayback();
    scrubbing = false;
    scrubWasPlaying = false;
  }
  stage.addEventListener('pointerdown', onDown);
  stage.addEventListener('pointermove', onMove);
  stage.addEventListener('pointerup', onUp);
  stage.addEventListener('pointercancel', onUp);
  if (audio && typeof audio.addEventListener === 'function') audio.addEventListener('ended', finish);

  /** close()：收时钟、拆监听、按宿注意愿移除节点（默认整块移除，prototype:579）。 */
  function close() {
    if (state === 'closed' || destroyed) return;
    dispatch('close');
    if (audio) audio.pause?.();
    destroy();
    if (typeof opts.onClose === 'function') opts.onClose(root);
    else root.remove?.();
  }
  function destroy() {
    destroyed = true;
    doc.removeEventListener?.('keydown', onKey);
    stage.removeEventListener?.('pointerdown', onDown);
    stage.removeEventListener?.('pointermove', onMove);
    stage.removeEventListener?.('pointerup', onUp);
    stage.removeEventListener?.('pointercancel', onUp);
    if (audio && typeof audio.removeEventListener === 'function') audio.removeEventListener?.('ended', finish);
    rafId = null;
    for (const arr of fadeAnims.values()) for (const a of arr) a.cancel?.();
    for (const a of kbAnims.values()) a.cancel?.();
    fadeAnims.clear(); kbAnims.clear();
    listeners.length = 0;
  }

  // -- 挂载：先静态落首帧（字幕可见性立即收敛，composeReel 自包含页的多条 .cap 不再叠加）--
  seek(0, { immediate: true });
  updateButtons();
  if (!reduced && opts.autoplay === true) startPlayback();

  return {
    get state() { return state; },
    get timeline() { return timeline; },
    get reduced() { return reduced; },
    time,
    play: startPlayback,
    pause,
    resume,
    replay,
    toggle,
    seek,
    next: () => step(1),
    prev: () => step(-1),
    close,
    destroy,
    onstate(cb) { if (typeof cb === 'function') listeners.push(cb); },
  };
}

/**
 * 浏览器自动挂载：模块加载后绑定页面上第一个未绑定的 .reel（composeReel 自包含页直接可用；
 * 宿主想自己控制时给 .reel 加 data-reel-manual 或改用 createReelPlayer）。node 导入时无
 * document，整段跳过——顶层零 DOM 触碰是单测契约。
 */
if (typeof document !== 'undefined' && typeof window !== 'undefined') {
  try {
    const root = document.querySelector('.reel:not([data-reel-manual]):not([data-reel-bound])');
    if (root) {
      root.setAttribute('data-reel-bound', '');
      createReelPlayer(root, { autoplay: true });
    }
  } catch { /* 宿主页结构不符时不炸页面 */ }
}
