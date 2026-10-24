// web/story/player.js — 时光故事书播放器（T4 线）。
//
// SPEC design/story-recap/SPEC.md §3（页内交互：轻点右侧下一页/左侧上一页、
// 长按暂停、顶部进度条每页 6–8 秒自动前进且可关闭、右上角静音、底部
// 「轻点继续」、任何页面长按数字弹出口径卡=数据源/计算方式/样本数）、
// §1.5（封面轻点「翻开」才开始——同一手势内启动音频，满足移动端 Safari
// 自动播放限制）、§4（换页只 setSegment 音乐连续不重启；prefers-reduced-
// motion 不影响音乐；一键静音并记住）、§8（390/1280 两档；桌面居中手机
// 比例卡片+背景模糊）。视觉标准 = design/story-recap/prototype.html
// （.bars/.chrome/.mute/.inner/.k/.foot/.hold 类名沿用原型，样式全部在
// web/story/story.css 的 .st-play 作用域；token 对齐 relay-v2 SPEC §3）。
//
// 分层（与 web/relay/shell.js 同约定，`node --test` 可直接导入）：
//   1. 纯逻辑：classifyTap / segmentState / fillPercent / shouldAutoAdvance /
//      keyboardAction / loadUiPrefs / saveUiPrefs / prefersReducedMotion /
//      pageStatusText / metricCardModel —— 无 DOM 触点。
//   2. 纯渲染：renderProgress / renderChrome / renderMetricCard —— 返回
//      HTML 字符串（转义一律过 esc()）。
//   3. createStoryPlayer(options)：DI 挂载器（doc/win/storage/clock/audio/
//      renderPage/getDefinition 全部可注入），返回
//      {open,next,prev,goTo,pause,resume,togglePause,setMuted,
//       setAutoAdvance,destroy,state}。
//
// 与其它故事线的接缝（不越界、不重定义契约）：
// - 章节/统计/种子一律 import './contracts.js'（本线绝不自定键名）；
//   音频启动输入 = contracts.songInputFor(chapter)。
// - soundtrack.js（另线）经 options.audio 适配器接入：
//   {start(input), setSegment(i), setMuted(b), stop()} —— 全部可选、
//   typeof 防御；换页只调 setSegment（SPEC §4 不重启），destroy 才 stop。
// - pages/*.js（另线）经 options.renderPage(page, index, ctx) 注入，返回
//   该页 HTML（建议含原型 .inner 骨架）；缺省时回退页型名占位。
//   页面交互元素用 button/a/input 等原生标签即自动豁免翻页点按；
//   可长按出卡的数字加 data-metric="<metricKey>"。
//   底部「轻点继续 ›」由 chrome 统一提供（.st-hint）——页面不要再发一份，
//   页面 .foot 只放左侧口径/来源说明。
// - definitions.js（另线）经 options.getDefinition(metricKey) 注入：
//   {label, source, method, sample}；无口径时卡片明说「暂无口径说明」，
//   绝不编数字（求真红线）。
// - 每页背景渐变在 story.css 的 .st-play[data-page-type=X] --page-bg
//   （桌面背景模糊需要；年度页型无原型，中性深色兜底，视觉定稿归 pages 线）。
//
// 叙事红线：文案不鸡汤、不夸大、不做他人类比；JC 拒用的修辞一律不进文案。

import { validateChapter, songInputFor } from './contracts.js';

// ---------------------------------------------------------------------------
// 常量（SPEC §3/§4 的数字钉死；单测锁定）
// ---------------------------------------------------------------------------
export var STORY_UI_KEY = 'tango-donego.story-ui.v1'; // 静音/自动前进偏好，独立于章节存储
export var STORY_UI_VERSION = 1;
export var DWELL_RANGE = [6000, 8000];   // SPEC §3: 每页 6–8 秒
export var AUTO_DWELL_MS = 7000;         // 区间中值
export var LONG_PRESS_MS = 500;          // 长按阈值（Apple HIG 惯例）
export var TAP_SLOP_PX = 10;             // 位移超过该值视为滑动（滚动），不是点按
export var TICK_MS = 100;                // 进度填充节拍

// 原型浅色页（p3 最特别的一天 / p7 四格）：文字与进度条要换深色
export var LIGHT_PAGES = ['specialDay', 'panels'];

// 读屏页名（SPEC §2/§3 表；叙事红线用词审查通过）
export var PAGE_TYPE_LABELS = {
  cover: '封面',
  numbers: '开篇数字',
  timeColors: '时间的颜色',
  specialDay: '最特别的一天',
  lessons: '学会的用法',
  savedTime: '省下的时间去了哪',
  rhythm: '节律与流派',
  panels: '四格与关键词',
  wish: '写给下一章',
  poster: '海报',
  yearSpectrum: '十二个月的时间光谱',
  yearFirstLast: '年度第一次和最后一次',
  yearStreak: '年度最长连续接力',
  yearGenres: '年度流派变化史',
  yearKeywords: '年度十大关键词',
  yearWall: '年度墙',
};

var INTERACTIVE_SELECTOR = 'button, a, input, textarea, select, [contenteditable], [data-metric], [data-st-interactive]';

// ---------------------------------------------------------------------------
// 纯逻辑
// ---------------------------------------------------------------------------
export function classifyTap(x, width) {
  if (typeof x !== 'number' || !Number.isFinite(x)) return null;
  if (typeof width !== 'number' || !Number.isFinite(width) || width <= 0) return null;
  return x < width / 2 ? 'prev' : 'next';
}

export function segmentState(index, current) {
  if (index < current) return 'done';
  if (index === current) return 'current';
  return 'todo';
}

export function fillPercent(elapsedMs, dwellMs) {
  if (typeof elapsedMs !== 'number' || !Number.isFinite(elapsedMs) || elapsedMs < 0) return 0;
  if (typeof dwellMs !== 'number' || !Number.isFinite(dwellMs) || dwellMs <= 0) return 0;
  var p = elapsedMs / dwellMs;
  return p < 0 ? 0 : p > 1 ? 1 : p;
}

export function resolveDwellMs(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return AUTO_DWELL_MS;
  var v = Math.round(value);
  if (v < DWELL_RANGE[0]) return DWELL_RANGE[0];
  if (v > DWELL_RANGE[1]) return DWELL_RANGE[1];
  return v;
}

// 自动前进的五道闸：翻开、未暂停、非末页、开关开启、无输入聚焦。
export function shouldAutoAdvance(state) {
  if (!state || !state.opened) return false;
  if (state.paused) return false;
  if (!state.autoAdvance) return false;
  if (state.interactive) return false;
  if (state.pageIndex >= state.pageCount - 1) return false;
  return true;
}

export function keyboardAction(key) {
  if (key === 'ArrowLeft') return 'prev';
  if (key === 'ArrowRight') return 'next';
  if (key === ' ') return 'toggle-pause';
  return null;
}

export function loadUiPrefs(storage) {
  var defaults = { muted: false, autoAdvance: true };
  if (!storage || typeof storage.getItem !== 'function') return defaults;
  var raw = null;
  try { raw = storage.getItem(STORY_UI_KEY); } catch (e) { return defaults; }
  if (raw == null || String(raw).trim() === '') return defaults;
  var parsed;
  try { parsed = JSON.parse(String(raw)); } catch (e) { return defaults; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return defaults;
  return {
    muted: parsed.muted === true,
    autoAdvance: parsed.autoAdvance !== false,
  };
}

export function saveUiPrefs(storage, prefs) {
  if (!storage || typeof storage.setItem !== 'function') return;
  var p = prefs || {};
  var payload = JSON.stringify({
    v: STORY_UI_VERSION,
    muted: p.muted === true,
    autoAdvance: p.autoAdvance !== false,
  });
  try { storage.setItem(STORY_UI_KEY, payload); } catch (e) { /* 私隐模式等：静默，不阻塞播放 */ }
}

export function prefersReducedMotion(win) {
  if (!win || typeof win.matchMedia !== 'function') return false;
  try {
    var mq = win.matchMedia('(prefers-reduced-motion: reduce)');
    return !!(mq && mq.matches);
  } catch (e) { return false; }
}

export function pageStatusText(chapter, pageIndex) {
  if (!chapter || !Array.isArray(chapter.pages)) return '';
  if (typeof pageIndex !== 'number' || pageIndex < 0 || pageIndex >= chapter.pages.length) return '';
  var type = chapter.pages[pageIndex] && chapter.pages[pageIndex].type;
  var label = PAGE_TYPE_LABELS[type] || type || '';
  return '第 ' + (pageIndex + 1) + ' 页，共 ' + chapter.pages.length + ' 页：' + label;
}

export function muteButtonLabel(muted) {
  return muted ? '开启音乐' : '静音';
}

export function autoAdvanceButtonLabel(on) {
  return on ? '关闭自动前进' : '开启自动前进';
}

export function esc(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// 口径卡模型：三要素 = 数据源 / 计算方式 / 样本数（SPEC §3 用词）。
// 无口径 → available:false，渲染层明说「暂无口径说明」，绝不编数字。
export function metricCardModel(definition) {
  if (!definition || typeof definition !== 'object') return { available: false, rows: [] };
  var sample = definition.sample;
  var sampleText = typeof sample === 'number' && Number.isFinite(sample)
    ? String(sample)
    : (sample == null ? '' : String(sample));
  return {
    available: true,
    rows: [
      { k: '指标', v: String(definition.label == null ? '' : definition.label) },
      { k: '数据源', v: String(definition.source == null ? '' : definition.source) },
      { k: '计算方式', v: String(definition.method == null ? '' : definition.method) },
      { k: '样本数', v: sampleText },
    ],
  };
}

// ---------------------------------------------------------------------------
// 纯渲染（HTML 字符串；原型类名 + st- 前缀补充件）
// ---------------------------------------------------------------------------
export function renderProgress(pageIndex, pageCount, fill) {
  var segs = [];
  for (var i = 0; i < pageCount; i += 1) {
    var st = segmentState(i, pageIndex);
    if (st === 'done') segs.push('<i class="d" aria-hidden="true"></i>');
    else if (st === 'current') {
      var pct = Math.round(fillPercent(fill, 1) * 100);
      segs.push('<i class="c" style="--fill:' + pct + '%" aria-hidden="true"></i>');
    } else segs.push('<i aria-hidden="true"></i>');
  }
  return '<div class="bars" role="group" aria-label="阅读进度">' + segs.join('') + '</div>';
}

// 顶栏：左 = 章节页标（pages/封面文案自定），右 = 自动前进开关 + 静音。
export function renderChrome(ctx) {
  var c = ctx || {};
  var muted = c.muted === true;
  var auto = c.autoAdvance !== false;
  return '<div class="chrome">'
    + '<span class="st-label">' + esc(c.label || '') + '</span>'
    + '<span class="st-tools">'
    + '<button type="button" class="auto" data-st-auto="1" aria-pressed="' + (auto ? 'true' : 'false') + '"'
    + ' aria-label="' + esc(autoAdvanceButtonLabel(auto)) + '" title="' + esc(autoAdvanceButtonLabel(auto)) + '">≫</button>'
    + '<button type="button" class="mute" data-st-mute="1" aria-pressed="' + (muted ? 'true' : 'false') + '"'
    + ' aria-label="' + esc(muteButtonLabel(muted)) + '" title="' + esc(muteButtonLabel(muted)) + '">♪</button>'
    + '</span>'
    + '<div class="st-live" aria-live="polite" aria-atomic="true"></div>'
    + '</div>';
}

export function renderMetricCard(definition) {
  var model = metricCardModel(definition);
  var inner;
  if (!model.available) {
    inner = '<p class="st-metric-empty">暂无口径说明</p>';
  } else {
    inner = '<dl class="st-metric-rows">'
      + model.rows.map(function (row) {
        return '<div><dt>' + esc(row.k) + '</dt><dd>' + esc(row.v) + '</dd></div>';
      }).join('')
      + '</dl>';
  }
  return '<div class="st-metric" role="dialog" aria-label="口径说明">'
    + '<button type="button" class="st-metric-close" data-st-close-metric="1" aria-label="关闭口径卡">关闭</button>'
    + inner
    + '</div>';
}

// 顶栏左标：封面「探戈 · 时光故事书」（原型 p0），内容页「2026.10 · 第 N 页」（原型 p1）。
function chromeLabel(chapter, pageIndex) {
  if (pageIndex === 0) return '探戈 · 时光故事书';
  var ym = chapter.period.from.slice(0, 7).replace('-', '.');
  return ym + ' · 第 ' + pageIndex + ' 页'; // 封面不计页码（原型从内容页起 1）
}

// 回退页（renderPage 缺省 / pages 线未挂）：页型名占位，不装数据。
function renderFallbackPage(page) {
  return '<div class="inner"><span class="k">' + esc(PAGE_TYPE_LABELS[page.type] || page.type) + '</span></div>';
}

// ---------------------------------------------------------------------------
// createStoryPlayer — DI 挂载器
// ---------------------------------------------------------------------------
export function createStoryPlayer(options) {
  var o = options || {};
  var doc = o.doc || (typeof document !== 'undefined' ? document : null);
  var win = o.win || (typeof window !== 'undefined' ? window : null);
  if (!doc || typeof doc.createElement !== 'function') return null;
  var chapter = validateChapter(o.chapter || null);
  if (!chapter) return null;
  var mount = o.mount || null;
  if (!mount) return null;

  var clock = o.clock || {
    now: function () { return Date.now(); },
    setInterval: function (fn, ms) { return setInterval(fn, ms); },
    clearInterval: function (id) { clearInterval(id); },
  };
  var storage = o.storage || (win && win.localStorage) || null;
  var audio = o.audio || {};
  var getDefinition = typeof o.getDefinition === 'function' ? o.getDefinition : function () { return null; };
  var renderPage = typeof o.renderPage === 'function' ? o.renderPage : renderFallbackPage;
  var dwell = resolveDwellMs(o.dwellMs);

  var prefs = loadUiPrefs(storage);
  var state = {
    opened: false,
    pageIndex: 0,
    pageCount: chapter.pages.length,
    paused: false,
    muted: prefs.muted,
    autoAdvance: prefs.autoAdvance,
    interactive: false,
    reducedMotion: prefersReducedMotion(win),
    metricKey: null,
    destroyed: false,
  };
  var elapsed = 0;
  var lastT = 0;

  // --- DOM 组装（可变部件全部 createElement 保留引用；innerHTML 只用于叶子） ---
  var root = doc.createElement('div');
  root.className = 'st-play';
  var backdrop = doc.createElement('div');
  backdrop.className = 'st-backdrop';
  backdrop.setAttribute('aria-hidden', 'true');
  var card = doc.createElement('div');
  card.className = 'st-card';
  root.appendChild(backdrop);
  root.appendChild(card);

  var barsEl = doc.createElement('div');
  barsEl.className = 'bars';
  barsEl.setAttribute('role', 'group');
  barsEl.setAttribute('aria-label', '阅读进度');
  var segEls = [];
  for (var i = 0; i < state.pageCount; i += 1) {
    var seg = doc.createElement('i');
    segEls.push(seg);
    barsEl.appendChild(seg);
  }
  var barsMounted = false;

  var chromeEl = doc.createElement('div');
  var stage = doc.createElement('div');
  stage.className = 'st-stage';
  var hint = doc.createElement('div');
  hint.className = 'st-hint';
  hint.setAttribute('aria-hidden', 'true');
  hint.textContent = '轻点继续 ›';
  var pill = doc.createElement('div');
  pill.className = 'st-paused-pill';
  pill.setAttribute('role', 'status');
  pill.textContent = '已暂停 · 轻点继续';
  var metricCard = doc.createElement('div');
  metricCard.className = 'st-metric-host';
  metricCard.setAttribute('hidden', '');
  card.appendChild(chromeEl);
  card.appendChild(stage);
  card.appendChild(hint);
  card.appendChild(pill);
  card.appendChild(metricCard);
  if (mount.appendChild) mount.appendChild(root);

  var liveEl = null;
  function ensureLive() {
    if (liveEl && liveEl.parentNode === chromeEl) return liveEl;
    liveEl = doc.createElement('div');
    liveEl.className = 'st-live';
    liveEl.setAttribute('aria-live', 'polite');
    liveEl.setAttribute('aria-atomic', 'true');
    chromeEl.appendChild(liveEl);
    return liveEl;
  }

  function announce(text) {
    var node = ensureLive();
    node.textContent = text; // 读屏播报（SPEC §8 无障碍）
  }

  function renderChromeNow() {
    chromeEl.innerHTML = renderChrome({
      pageIndex: state.pageIndex,
      pageCount: state.pageCount,
      muted: state.muted,
      autoAdvance: state.autoAdvance,
      label: chromeLabel(chapter, state.pageIndex),
    });
    ensureLive();
  }

  function updateBars() {
    if (state.pageIndex <= 0) { // 封面不显示进度条（原型 p0；翻回封面重新盖上）
      if (barsMounted && barsEl.setAttribute) barsEl.setAttribute('hidden', '');
      fillSeg = null;
      return;
    }
    if (!barsMounted && card.appendChild) { card.appendChild(barsEl); barsMounted = true; }
    if (barsEl.removeAttribute) barsEl.removeAttribute('hidden');
    for (var i = 0; i < segEls.length; i += 1) {
      var st = segmentState(i, state.pageIndex);
      segEls[i].classList.toggle('d', st === 'done');
      segEls[i].classList.toggle('c', st === 'current');
    }
    fillSeg = segEls[state.pageIndex] || null;
    if (fillSeg && fillSeg.style && typeof fillSeg.style.setProperty === 'function') {
      fillSeg.style.setProperty('--fill', '0%');
    }
  }
  var fillSeg = null;

  function pageTheme(type) {
    return LIGHT_PAGES.indexOf(type) >= 0 ? 'light' : 'dark';
  }

  function renderPageNow() {
    var page = chapter.pages[state.pageIndex];
    root.setAttribute('data-page-type', page.type);
    root.setAttribute('data-page-theme', pageTheme(page.type));
    var html = '';
    try {
      html = renderPage(page, state.pageIndex, {
        chapter: chapter,
        captions: chapter.captions,
        reducedMotion: state.reducedMotion,
      }) || '';
    } catch (e) { html = ''; }
    if (!html) html = renderFallbackPage(page);
    stage.innerHTML = '<div class="st-page">' + html + '</div>';
    updateBars();
  }

  function updateChromeBits() {
    if (hint.setAttribute) {
      if (state.opened && state.pageIndex > 0 && state.pageIndex < state.pageCount - 1) hint.removeAttribute('hidden');
      else hint.setAttribute('hidden', '');
    }
    if (pill.setAttribute) {
      if (state.paused) pill.removeAttribute('hidden');
      else pill.setAttribute('hidden', '');
    }
    if (card.classList) card.classList.toggle('st-paused', state.paused);
    renderChromeNow();
  }

  function audioCall(name, args) {
    var fn = audio && audio[name];
    if (typeof fn !== 'function') return;
    try { fn.apply(audio, args); } catch (e) { /* 音频故障不阻塞阅读 */ }
  }

  function syncMuteToAudio() {
    audioCall('setMuted', [state.muted]);
  }

  // --- 翻页（音频只 setSegment：换页音乐连续不重启，SPEC §4） ---
  function goTo(index) {
    if (state.destroyed) return;
    var clamped = Math.max(0, Math.min(state.pageCount - 1, Math.floor(index)));
    if (clamped === state.pageIndex) return;
    closeMetric(); // 口径卡不跨页存留（口径属于它解释的那一页）
    state.pageIndex = clamped;
    elapsed = 0;
    renderPageNow();
    updateChromeBits();
    if (state.opened) audioCall('setSegment', [clamped]);
    announce(pageStatusText(chapter, clamped) + (state.paused ? '，已暂停' : ''));
  }

  function next() { goTo(state.pageIndex + 1); }
  function prev() { goTo(state.pageIndex - 1); }

  function open() {
    if (state.destroyed || state.opened) return;
    state.opened = true;
    elapsed = 0;
    // 「翻开」= 用户手势：在此启动音频（移动端自动播放限制，SPEC §4）。
    // start() 本身就从前奏（第 0 段）开始；换页才需要 setSegment。
    audioCall('start', [songInputFor(chapter)]);
    syncMuteToAudio();
    updateChromeBits();
    announce('已翻开。' + pageStatusText(chapter, 0) + '。左右轻点或方向键翻页，长按暂停');
  }

  function pause() {
    if (state.destroyed || state.paused) return;
    state.paused = true;
    updateChromeBits();
    announce(pageStatusText(chapter, state.pageIndex) + '，已暂停');
  }

  function resume() {
    if (state.destroyed || !state.paused) return;
    state.paused = false;
    elapsed = 0;
    updateChromeBits();
    announce(pageStatusText(chapter, state.pageIndex) + '，已继续');
  }

  function togglePause() { if (state.paused) resume(); else pause(); }

  function setMuted(muted) {
    state.muted = muted === true;
    saveUiPrefs(storage, { muted: state.muted, autoAdvance: state.autoAdvance });
    syncMuteToAudio();
    renderChromeNow();
    announce(state.muted ? '已静音' : '已开启音乐');
  }

  function setAutoAdvance(on) {
    state.autoAdvance = on !== false;
    elapsed = 0;
    saveUiPrefs(storage, { muted: state.muted, autoAdvance: state.autoAdvance });
    renderChromeNow();
    announce(state.autoAdvance ? '已开启自动前进' : '已关闭自动前进');
  }

  // --- 口径卡 ---
  function openMetric(key) {
    state.metricKey = key;
    var def = null;
    try { def = getDefinition(key); } catch (e) { def = null; }
    metricCard.innerHTML = renderMetricCard(def);
    metricCard.removeAttribute('hidden');
    announce('口径说明：' + key);
  }

  function closeMetric() {
    if (state.metricKey == null) return;
    state.metricKey = null;
    metricCard.setAttribute('hidden', '');
    metricCard.innerHTML = '';
  }

  // --- 自动前进节拍（DI clock，可测） ---
  function tick() {
    var nowT = clock.now();
    var dt = lastT ? nowT - lastT : 0;
    lastT = nowT;
    if (dt > 0 && shouldAutoAdvance(state)) {
      elapsed += dt;
      if (elapsed >= dwell) {
        elapsed = 0;
        next();
        return;
      }
    }
    if (fillSeg && fillSeg.style && typeof fillSeg.style.setProperty === 'function' && state.pageIndex > 0) {
      fillSeg.style.setProperty('--fill', Math.round(fillPercent(elapsed, dwell) * 100) + '%');
    }
  }

  // --- 手势：点按左右翻页 / 长按暂停 / 长按 [data-metric] 出口径卡 ---
  var pointer = null; // {x, y, t, moved}
  function onPointerDown(event) {
    if (state.destroyed) return;
    pointer = {
      x: typeof event.clientX === 'number' ? event.clientX : 0,
      y: typeof event.clientY === 'number' ? event.clientY : 0,
      t: clock.now(),
      moved: false,
    };
  }
  function onPointerMove(event) {
    if (!pointer || pointer.moved) return;
    var dx = (typeof event.clientX === 'number' ? event.clientX : pointer.x) - pointer.x;
    var dy = (typeof event.clientY === 'number' ? event.clientY : pointer.y) - pointer.y;
    if (Math.abs(dx) > TAP_SLOP_PX || Math.abs(dy) > TAP_SLOP_PX) pointer.moved = true;
  }
  function onPointerUp(event) {
    if (!pointer || state.destroyed) { pointer = null; return; }
    var held = clock.now() - pointer.t;
    var moved = pointer.moved;
    pointer = null;
    if (moved) return;
    if (state.metricKey != null) { closeMetric(); return; } // 口径卡开着：点按只关卡，不穿透导航
    var target = event && event.target;
    if (!target || typeof target.closest !== 'function') return;
    var metricNode = target.closest('[data-metric]');
    if (held >= LONG_PRESS_MS) {
      if (metricNode) { openMetric(metricNode.getAttribute('data-metric')); } // 口径卡优先于暂停
      else togglePause();
      return;
    }
    if (metricNode || target.closest(INTERACTIVE_SELECTOR)) return; // 页面交互元素不翻页
    if (!state.opened) return; // 封面必须先「翻开」（SPEC §1.5）
    var width = (win && win.innerWidth) || 390;
    var act = classifyTap(event.clientX, width);
    if (act === 'next') next();
    else if (act === 'prev') prev();
  }
  function onPointerCancel() { pointer = null; }

  // --- 顶栏/卡片内委托点击（真实按钮；翻页不在这里，避免与 pointerup 双触发） ---
  function onRootClick(event) {
    if (state.destroyed) return;
    var target = event && event.target;
    if (!target || typeof target.closest !== 'function') return;
    if (target.closest('[data-st-open]')) { open(); return; }
    if (target.closest('[data-st-mute]')) { setMuted(!state.muted); return; }
    if (target.closest('[data-st-auto]')) { setAutoAdvance(!state.autoAdvance); return; }
    if (target.closest('[data-st-close-metric]')) { closeMetric(); return; }
  }

  // --- 键盘：← → 空格（SPEC D5）；Esc 关口径卡；输入框聚焦不劫持 ---
  function onKeydown(event) {
    if (state.destroyed) return;
    var e = event || {};
    // 口径卡开着：Esc / 方向键 / 空格都只关卡，不穿透翻页
    if (state.metricKey != null) {
      if (e.key === 'Escape' || keyboardAction(e.key)) closeMetric();
      return;
    }
    var target = e.target;
    if (target && typeof target.closest === 'function'
      && target.closest('input, textarea, select, [contenteditable]')) return;
    if (e.key === 'Escape') { closeMetric(); return; }
    var act = keyboardAction(e.key);
    if (!act) return;
    if (!state.opened) return;
    if (e.preventDefault) e.preventDefault();
    if (act === 'prev') prev();
    else if (act === 'next') next();
    else togglePause();
  }

  // --- 心愿页输入框聚焦：暂停自动前进，失焦恢复 ---
  function onFocusIn(event) {
    var target = event && event.target;
    if (!target || typeof target.closest !== 'function') return;
    state.interactive = !!target.closest('input, textarea, select, [contenteditable], [data-st-interactive]');
  }
  function onFocusOut() { state.interactive = false; }

  // --- 组装事件 ---
  stage.addEventListener('pointerdown', onPointerDown);
  stage.addEventListener('pointermove', onPointerMove);
  stage.addEventListener('pointerup', onPointerUp);
  stage.addEventListener('pointercancel', onPointerCancel);
  stage.addEventListener('focusin', onFocusIn);
  stage.addEventListener('focusout', onFocusOut);
  root.addEventListener('click', onRootClick);
  if (doc.addEventListener) doc.addEventListener('keydown', onKeydown);

  if (state.reducedMotion) root.setAttribute('data-reduced-motion', '1');
  var mq = null;
  if (win && typeof win.matchMedia === 'function') {
    try {
      mq = win.matchMedia('(prefers-reduced-motion: reduce)');
      if (mq && typeof mq.addEventListener === 'function') {
        mq.addEventListener('change', onMqChange);
      }
    } catch (e) { mq = null; }
  }
  function onMqChange(changeEvent) {
    state.reducedMotion = prefersReducedMotion(win);
    if (state.reducedMotion) root.setAttribute('data-reduced-motion', '1');
    else root.removeAttribute('data-reduced-motion');
  }

  renderPageNow();
  updateChromeBits();
  announce(pageStatusText(chapter, 0));
  var timerId = clock.setInterval(tick, TICK_MS);
  lastT = clock.now();

  function destroy() {
    if (state.destroyed) return;
    state.destroyed = true;
    try { clock.clearInterval(timerId); } catch (e) { /* 已清 */ }
    stage.removeEventListener('pointerdown', onPointerDown);
    stage.removeEventListener('pointermove', onPointerMove);
    stage.removeEventListener('pointerup', onPointerUp);
    stage.removeEventListener('pointercancel', onPointerCancel);
    stage.removeEventListener('focusin', onFocusIn);
    stage.removeEventListener('focusout', onFocusOut);
    root.removeEventListener('click', onRootClick);
    if (doc.removeEventListener) doc.removeEventListener('keydown', onKeydown);
    if (mq && typeof mq.removeEventListener === 'function') {
      try { mq.removeEventListener('change', onMqChange); } catch (e) { /* 忽略 */ }
    }
    if (state.opened) audioCall('stop', []);
    if (root.remove && typeof root.remove === 'function') root.remove();
    else if (root.parentNode && root.parentNode.removeChild) root.parentNode.removeChild(root);
  }

  var api = {
    open: open,
    next: next,
    prev: prev,
    goTo: goTo,
    pause: pause,
    resume: resume,
    togglePause: togglePause,
    setMuted: setMuted,
    setAutoAdvance: setAutoAdvance,
    destroy: destroy,
    state: function () {
      return {
        opened: state.opened,
        pageIndex: state.pageIndex,
        pageCount: state.pageCount,
        paused: state.paused,
        muted: state.muted,
        autoAdvance: state.autoAdvance,
        interactive: state.interactive,
        reducedMotion: state.reducedMotion,
        metricKey: state.metricKey,
        destroyed: state.destroyed,
      };
    },
    // 挂载引用（lab/tests/浏览器调试用；不构成公共契约）：
    // _live/_fillSeg 为 getter —— 渲染后才存在，避免暴露过期引用。
    _root: root,
    _stage: stage,
    _metricCard: metricCard,
  };
  Object.defineProperties(api, {
    _live: { get: function () { return liveEl; } },
    _fillSeg: { get: function () { return fillSeg; } },
    _bars: { get: function () { return barsEl; } },
  });
  return api;
}
