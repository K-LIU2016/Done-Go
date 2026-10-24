// web/story/pages/year-streak.js — 年书 年度最长连续接力
// (SPEC §2 年度专属；page type 'yearStreak'；contracts YEAR_PAGE_TYPES)。
//
// 口径（求真红线）：「连续接力」= 连续 days 天，每天至少 1 次 AI 接力
// （事项 ai.used）。数据来自拟扩展形状 stats.year.streak（year-common.js
// 头注，待 CTO 裁决），并带真值守卫（天数=日期差+1、总次数≥天数）。
// 契约未扩展前：有接力 → 事实性「没连成串」（用契约 totals.aiRelays 真值）；
// 零接力 → 「每件事都是你自己做完的」（与月章 ① 同句式，事实不鸡汤）。
// 绝不编造天数。
//
// 视觉：大数字（原型 .num 96px Avenir，0→N 1.2s easeOutCubic 滚动，月章 ①
// 同语言）+ 起止区间 + 累计次数 + 连续日点串（渲染保护 DOTS_MAX=31，超出
// 省略号）；底色沿用原型 p4 的奖章金径向渐变（接力/毕业的金属语言）。
// reduceMotion：数字直接落定、点串不逐个点亮。
// Caption key: yearStreak.title。

import { esc, sanitizeStreak, mdLabel, periodYear } from './year-common.js';

export var PAGE_TYPE = 'yearStreak';
export var METRICS = ['totals.aiRelays'];
export var ROLL_MS = 1200;   // 与月章 ① COUNT_ROLL_MS 同值
export var DOTS_MAX = 31;

// easeOutCubic 数字滚动：t∈[0,1] → round(target×(1-(1-t)³))。纯函数。
export function rollValue(t, target) {
  var x = typeof t === 'number' && Number.isFinite(t) ? Math.min(1, Math.max(0, t)) : 0;
  var n = typeof target === 'number' && Number.isFinite(target) && target > 0 ? target : 0;
  return Math.round(n * (1 - Math.pow(1 - x, 3)));
}

function readInt(value, max) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return 0;
  return Math.min(Math.floor(value), max);
}

export function captionDefaults(model) {
  if (!model) return {};
  return { 'yearStreak.title': model.title };
}

export function pageModel(chapter, params) {
  if (!chapter || !chapter.stats || !chapter.period) return null;
  var stats = chapter.stats;
  var streak = sanitizeStreak(stats.year && stats.year.streak);
  var totals = stats.totals || {};
  var relaysTotal = readInt(totals.aiRelays, 1e7);
  var eventsTotal = readInt(totals.events, 1e7);
  var mode = streak ? 'streak' : relaysTotal > 0 ? 'scattered' : 'solo';
  var title = mode === 'streak'
    ? streak.days + ' 天，每天都有接力'
    : mode === 'scattered'
      ? '这一年，接力没有连成串'
      : '这一年，每件事都是你自己做完的';
  return {
    year: periodYear(chapter),
    mode: mode,
    streak: streak,
    relaysTotal: relaysTotal,
    eventsTotal: eventsTotal,
    dots: streak ? Math.min(streak.days, DOTS_MAX) : 0,
    overflow: !!streak && streak.days > DOTS_MAX,
    title: title,
  };
}

function dotsHtml(model) {
  var out = '';
  for (var i = 0; i < model.dots; i += 1) {
    out += '<i class="st-yst-dot" style="animation-delay:' + (i * 40) + 'ms"></i>';
  }
  if (model.overflow) out += '<span class="st-yst-more">…</span>';
  return out;
}

export function pageView(model, captions) {
  if (!model) return '';
  var cap = captions || {};
  var title = String(cap['yearStreak.title'] != null ? cap['yearStreak.title'] : model.title);
  var head = '<span class="st-k">' + esc(model.year) + ' 年，最长的一段</span>' +
    '<h1 class="st-big st-yst-title">' + esc(title) + '</h1>';
  var foot = '<div class="st-foot"><span>接力 = 交给 AI 的事项 · 长按看口径</span><span>›</span></div>';
  if (model.mode === 'streak') {
    var s = model.streak;
    return '<div class="st-page st-yst"><div class="st-yst-inner">' + head +
      '<div class="st-yst-hero">' +
      '<span class="st-num" data-metric="year.streak.days" data-st-roll="' + s.days + '">' +
      s.days + '<small>天</small></span>' +
      '<p class="st-yst-range">' + esc(mdLabel(s.from)) + ' — ' + esc(mdLabel(s.to)) +
      ' · 累计 ' + s.relays + ' 次 AI 接力</p></div>' +
      '<div class="st-yst-dots" aria-hidden="true">' + dotsHtml(model) + '</div>' +
      foot + '</div></div>';
  }
  if (model.mode === 'scattered') {
    return '<div class="st-page st-yst"><div class="st-yst-inner">' + head +
      '<div class="st-yst-box" data-metric="totals.aiRelays">这一年有 ' + model.relaysTotal +
      ' 次接力，只是没有连着两天以上。</div>' + foot + '</div></div>';
  }
  return '<div class="st-page st-yst"><div class="st-yst-inner">' + head +
    '<div class="st-yst-box">' + model.eventsTotal + ' 件事，都没有交给 AI。</div>' +
    foot + '</div></div>';
}

export var PAGE_CSS = [
  '.st-page.st-yst{background:radial-gradient(100% 70% at 50% 0%,#5A3E1E 0%,#2A1F14 70%);color:#fff}',
  '.st-yst-inner{position:absolute;inset:72px 26px 40px;display:flex;flex-direction:column}',
  '.st-k{font-size:12.5px;letter-spacing:2px;opacity:.75}',
  '.st-big{font-family:"Songti SC","Noto Serif SC","STSong",serif;font-weight:900;line-height:1.18;margin-top:12px}',
  '.st-yst-title{font-size:32px}',
  '.st-yst-hero{margin-top:26px;text-align:center}',
  '.st-num{font-family:"Avenir Next","Helvetica Neue",sans-serif;font-weight:700;',
  '  font-size:96px;line-height:1;letter-spacing:-2px;font-variant-numeric:tabular-nums}',
  '.st-num small{font-size:22px;font-weight:600;margin-left:4px;letter-spacing:0}',
  '.st-yst-range{font-size:14px;opacity:.9;margin-top:14px;font-variant-numeric:tabular-nums}',
  '.st-yst-dots{display:flex;flex-wrap:wrap;gap:5px;margin-top:22px;justify-content:center}',
  '.st-yst-dot{width:9px;height:9px;border-radius:50%;background:#E8B04B;',
  '  box-shadow:0 0 6px rgba(232,176,75,.5);animation:st-yst-pop 300ms ease both}',
  '@keyframes st-yst-pop{from{transform:scale(0);opacity:0}to{transform:scale(1);opacity:1}}',
  '.st-yst-more{font-size:14px;opacity:.7;align-self:center}',
  '.st-yst-box{margin-top:26px;background:rgba(232,176,75,.15);border-radius:16px;',
  '  padding:16px;font-size:14.5px;line-height:1.7}',
  '.st-foot{margin-top:auto;font-size:11.5px;opacity:.6;display:flex;justify-content:space-between}',
  '.st-yst.st-reduce .st-yst-dot{animation:none}',
].join('\n');

// 数字滚动在 mount 后执行（node 无 DOM/rAF 时安全跳过）。
export function createPage(options) {
  var opts = options || {};
  var styleEl = null;
  var rafId = null;
  return {
    type: PAGE_TYPE,
    mount: function (el) {
      if (!el) return;
      if (!styleEl) {
        styleEl = document.createElement('style');
        styleEl.setAttribute('data-st-page', PAGE_TYPE);
        styleEl.textContent = PAGE_CSS;
        document.head.appendChild(styleEl);
      }
      el.innerHTML = pageView(opts.model || null, opts.captions || null);
      var root = el.querySelector('.st-yst');
      if (root && opts.reduceMotion) root.classList.add('st-reduce');
      var numEl = el.querySelector('.st-num[data-st-roll]');
      if (!numEl || opts.reduceMotion) return;
      var win = typeof window !== 'undefined' ? window : null;
      if (!win || typeof win.requestAnimationFrame !== 'function') return;
      var target = Number(numEl.getAttribute('data-st-roll')) || 0;
      var t0 = null;
      var step = function (ts) {
        if (t0 === null) t0 = ts;
        var t = Math.min(1, (ts - t0) / ROLL_MS);
        numEl.firstChild.nodeValue = String(rollValue(t, target));
        if (t < 1) rafId = win.requestAnimationFrame(step);
      };
      rafId = win.requestAnimationFrame(step);
    },
    unmount: function () {
      if (rafId != null && typeof window !== 'undefined' && typeof window.cancelAnimationFrame === 'function') {
        window.cancelAnimationFrame(rafId);
      }
      rafId = null;
      if (styleEl && styleEl.parentNode) styleEl.parentNode.removeChild(styleEl);
      styleEl = null;
    },
  };
}

export function renderPage(page, ctx) {
  var c = ctx || {};
  var params = page && page.params ? page.params : undefined;
  return pageView(pageModel(c.chapter, params), c.captions);
}
