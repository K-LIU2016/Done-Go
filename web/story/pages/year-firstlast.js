// web/story/pages/year-firstlast.js — 年书 年度第一次和最后一次
// (SPEC §2 年度专属；page type 'yearFirstLast'；contracts YEAR_PAGE_TYPES)。
//
// 视觉：两张「时刻卡」（月章 ③ specialDay 的时间线语言：类别色点、时刻
// tabular-nums、✦ AI 同行金标）分列上下，中间一条竖向渐变连线与天数；
// 底色沿用原型 p1 的开篇数字夜蓝径向渐变——「开篇与收尾」的语气。
// 中段数字 = 首末两天间隔（daysBetween 真值）与契约 totals.events（全年
// 事项数，真值），挂 data-metric="totals.events" 口径。
//
// 数据：首末两件事来自拟扩展形状 stats.year.first/last（year-common.js 头注，
// 待 CTO 裁决）；契约未扩展前渲染事实性空态。只有一头时只渲染那一头，
// 不编造另一头。
//
// 动效：上卡自上滑入、下卡自下滑入、中段淡入（错峰）；reduce → 直接终态。
// Caption key: yearFirstLast.title。

import {
  KIND_COLORS, KIND_LABELS, esc, sanitizeFirstLast, daysBetween, mdLabel, periodYear,
} from './year-common.js';

export var PAGE_TYPE = 'yearFirstLast';
export var METRICS = ['totals.events'];

function cardHtml(moment, side) {
  var c = KIND_COLORS[moment.kind] || { base: '#888888' };
  var ai = moment.ai
    ? '<em class="st-yfl-ai">✦ AI 同行</em>'
    : '';
  return '<div class="st-yfl-card st-yfl-' + side + '">' +
    '<span class="st-yfl-when">' + esc(mdLabel(moment.date)) + ' ' + esc(moment.time) + '</span>' +
    '<b class="st-yfl-what">' + esc(moment.title) + '</b>' +
    '<span class="st-yfl-meta"><i class="st-yfl-dot" style="background:' + c.base + '"></i>' +
    esc(KIND_LABELS[moment.kind] || '') + ai + '</span></div>';
}

function titleFor(mode, first, last) {
  if (mode === 'both') return '从 ' + mdLabel(first.date) + '，到 ' + mdLabel(last.date);
  if (mode === 'first') return '这一年，从 ' + mdLabel(first.date) + ' 开始';
  if (mode === 'last') return '这一年，到 ' + mdLabel(last.date) + ' 收尾';
  return '这一年的开篇与收尾还没有数据';
}

export function captionDefaults(model) {
  if (!model) return {};
  return { 'yearFirstLast.title': model.title };
}

export function pageModel(chapter, params) {
  if (!chapter || !chapter.stats || !chapter.period) return null;
  var stats = chapter.stats;
  var first = sanitizeFirstLast(stats.year && stats.year.first);
  var last = sanitizeFirstLast(stats.year && stats.year.last);
  var totals = stats.totals || {};
  var events = typeof totals.events === 'number' && Number.isFinite(totals.events)
    && totals.events >= 0 ? Math.floor(totals.events) : 0;
  var mode = first && last ? 'both' : first ? 'first' : last ? 'last' : 'none';
  var spanDays = mode === 'both' ? daysBetween(first.date, last.date) : null;
  if (spanDays != null && spanDays < 0) spanDays = null;
  return {
    year: periodYear(chapter),
    first: first,
    last: last,
    mode: mode,
    spanDays: spanDays,
    events: events,
    title: titleFor(mode, first, last),
  };
}

export function pageView(model, captions) {
  if (!model) return '';
  var cap = captions || {};
  var title = String(cap['yearFirstLast.title'] != null ? cap['yearFirstLast.title'] : model.title);
  var head = '<span class="st-k">' + esc(model.year) + ' 年</span>' +
    '<h1 class="st-big st-yfl-title">' + esc(title) + '</h1>';
  var foot = '<div class="st-foot"><span>来自这一年的记录 · 长按看口径</span><span>轻点继续 ›</span></div>';
  if (model.mode === 'none') {
    return '<div class="st-page st-yfl">' + '<div class="st-yfl-inner">' + head +
      '<div class="st-yfl-empty">第一件事和最后一件事，会在这里照面。</div>' + foot + '</div></div>';
  }
  var body = '';
  if (model.mode === 'both' || model.mode === 'first') body += cardHtml(model.first, 'first');
  if (model.mode === 'both') {
    body += '<div class="st-yfl-line" aria-hidden="true"></div>' +
      '<div class="st-yfl-mid" data-metric="totals.events">' +
      '<span class="st-num">' + model.spanDays + '<small>天</small></span>' +
      '<p>之间，你记下了 ' + model.events + ' 件事</p></div>' +
      '<div class="st-yfl-line" aria-hidden="true"></div>';
  } else {
    body += '<div class="st-yfl-line st-yfl-fill" aria-hidden="true"></div>' +
      '<div class="st-yfl-mid" data-metric="totals.events">' +
      '<p>这一年，你记下了 ' + model.events + ' 件事</p></div>' +
      '<div class="st-yfl-line st-yfl-fill" aria-hidden="true"></div>';
  }
  if (model.mode === 'both' || model.mode === 'last') body += cardHtml(model.last, 'last');
  return '<div class="st-page st-yfl"><div class="st-yfl-inner">' + head + body + foot + '</div></div>';
}

export var PAGE_CSS = [
  '.st-page.st-yfl{background:radial-gradient(120% 80% at 20% 0%,#3A5A8C 0%,#1D2D4B 60%,#141E33 100%);color:#fff}',
  '.st-yfl-inner{position:absolute;inset:72px 26px 40px;display:flex;flex-direction:column}',
  '.st-k{font-size:12.5px;letter-spacing:2px;opacity:.75}',
  '.st-big{font-family:"Songti SC","Noto Serif SC","STSong",serif;font-weight:900;line-height:1.18;margin-top:12px}',
  '.st-yfl-title{font-size:30px}',
  '.st-yfl-card{background:rgba(255,255,255,.07);border-radius:18px;padding:16px}',
  '.st-yfl-first{animation:st-yfl-down 420ms cubic-bezier(.22,.61,.36,1) both}',
  '.st-yfl-last{animation:st-yfl-up 420ms cubic-bezier(.22,.61,.36,1) 400ms both}',
  '@keyframes st-yfl-down{from{transform:translateY(-16px);opacity:0}to{transform:none;opacity:1}}',
  '@keyframes st-yfl-up{from{transform:translateY(16px);opacity:0}to{transform:none;opacity:1}}',
  '.st-yfl-when{font-size:12.5px;opacity:.8;letter-spacing:1px;font-variant-numeric:tabular-nums}',
  '.st-yfl-what{display:block;font-family:"Songti SC","Noto Serif SC","STSong",serif;',
  '  font-size:20px;line-height:1.4;margin-top:8px;font-weight:700}',
  '.st-yfl-meta{display:flex;align-items:center;gap:6px;font-size:12px;opacity:.85;margin-top:10px}',
  '.st-yfl-dot{width:10px;height:10px;border-radius:50%;display:inline-block}',
  '.st-yfl-ai{font-style:normal;color:#FFB27A;margin-left:6px}',
  '.st-yfl-line{flex:1;width:2px;min-height:20px;margin:0 auto;border-radius:1px;',
  '  background:linear-gradient(180deg,rgba(255,255,255,.55),rgba(255,255,255,.15))}',
  '.st-yfl-mid{text-align:center;margin:12px 0;animation:st-yfl-fade 480ms ease 200ms both}',
  '@keyframes st-yfl-fade{from{opacity:0}to{opacity:1}}',
  '.st-num{font-family:"Avenir Next","Helvetica Neue",sans-serif;font-weight:700;',
  '  font-size:56px;line-height:1;letter-spacing:-1px}',
  '.st-num small{font-size:18px;font-weight:600;margin-left:4px;letter-spacing:0}',
  '.st-yfl-mid p{font-size:14px;opacity:.9;margin-top:8px}',
  '.st-yfl-empty{margin-top:22px;border-radius:18px;background:rgba(255,255,255,.06);',
  '  padding:18px;font-size:14px;line-height:1.7;opacity:.85}',
  '.st-foot{margin-top:auto;font-size:11.5px;opacity:.6;display:flex;justify-content:space-between}',
  '.st-yfl.st-reduce .st-yfl-first,.st-yfl.st-reduce .st-yfl-last,.st-yfl.st-reduce .st-yfl-mid{animation:none}',
].join('\n');

export function createPage(options) {
  var opts = options || {};
  var styleEl = null;
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
      var root = el.querySelector('.st-yfl');
      if (root && opts.reduceMotion) root.classList.add('st-reduce');
    },
    unmount: function () {
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
